import { z } from 'zod'

import { NOOP_INVESTIGATION_LOGGER, newRequestId, type InvestigationLogger } from './investigation-logger'
import { resolveCanonicalInvestigation } from './investigation-resolver'
import { raceActivationBudget } from '@/lib/tty/tty-activation-budget'
import type { InvestigationStore } from './investigation-store'
import type {
  InvestigationBookmark,
  InvestigationExecutionAttachmentInput,
  InvestigationId,
  InvestigationPatchInput,
  InvestigationRecord
} from './investigation-types'

const MAX_BODY_BYTES = 32_768
const ID_SCHEMA = z.string().uuid()
const CREATE_SCHEMA = z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(10_000).default('') }).strict()
const PATCH_SCHEMA = z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(10_000).optional(), status: z.enum(['active', 'archived']).optional() }).strict()
const TIMELINE_SCHEMA = z.union([
  z.object({ type: z.literal('note'), body: z.string().trim().min(1).max(10_000) }).strict(),
  z.object({ type: z.literal('bookmark'), executionId: z.string().uuid(), sequence: z.number().int().positive(), lineNumber: z.number().int().positive().nullable(), kind: z.enum(['output', 'error', 'state', 'finding']), label: z.string().trim().min(1).max(200), excerpt: z.string().max(2_000) }).strict()
])
const NOTE_PATCH_SCHEMA = z.object({ body: z.string().trim().min(1).max(10_000) }).strict()
const ATTACH_SCHEMA = z.object({ sessionId: z.string().uuid(), input: z.string().min(1).max(4_000), idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._~-]+$/) }).strict()

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json'
} as const

type Store = Pick<InvestigationStore, 'create' | 'list' | 'get' | 'patch' | 'delete' | 'attachSession' | 'clearSession' | 'recordBookmark' | 'recordNote' | 'updateNote' | 'deleteNote' | 'attachExecution' | 'diagnoseAbsence'>

export interface InvestigationApiDependencies {
  readonly authenticate: () => Promise<string | null>
  readonly getStore: () => Store
  readonly synchronize?: (ownerUserId: string, investigationId: InvestigationId) => Promise<void>
  readonly terminateInvestigationSession?: (sessionId: string) => Promise<void>
  readonly logger?: InvestigationLogger
}

export interface InvestigationSessionApiDependencies extends InvestigationApiDependencies {
  readonly createTTYSession: (request: Request) => Promise<Response>
  readonly getTTYSession: (request: Request, sessionId: string) => Promise<Response>
  readonly terminateTTYSession: (request: Request, sessionId: string) => Promise<Response>
}

export interface InvestigationExecutionApiDependencies extends InvestigationApiDependencies {
  /** Revalidates or creates the canonical TTY session before admission. */
  readonly ensureSession?: (request: Request, investigationId: InvestigationId) => Promise<Response>
  readonly admitExecution: (request: Request, sessionId: string) => Promise<Response>
  readonly startExecution?: (executionId: string, sessionId: string) => Promise<{ readonly accepted: boolean; readonly reason?: string }>
  /** How long attach() will wait for startExecution before degrading to a 202 activationPending response instead of blocking. Defaults to 3000ms. */
  readonly activationResponseBudgetMs?: number
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS })
}

function failure(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status)
}

function normalizeUserId(value: string | null): string | null {
  const normalized = value?.trim()
  return normalized && normalized.length <= 200 ? normalized : null
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return null
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function requireUser(dependencies: InvestigationApiDependencies): Promise<string | Response> {
  const userId = normalizeUserId(await dependencies.authenticate())
  return userId ?? failure(401, 'UNAUTHENTICATED', 'Authentication is required.')
}

function parseId(rawId: string): InvestigationId | null {
  return ID_SCHEMA.safeParse(rawId).success ? rawId as InvestigationId : null
}

function emptyBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length')
  return contentLength === null || contentLength === '0'
}

function publicRecord(record: InvestigationRecord): Omit<InvestigationRecord, 'ownerUserId'> {
  const { ownerUserId: _ownerUserId, ...safe } = record
  return safe
}

function publicHydration(hydration: Awaited<ReturnType<Store['get']>>) {
  if (!hydration) return null
  return { ...hydration, investigation: publicRecord(hydration.investigation) }
}

export function createInvestigationApi(dependencies: InvestigationApiDependencies) {
  return {
    async create(request: Request): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const parsed = CREATE_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success) return failure(400, 'INVALID_INPUT', 'The investigation payload is invalid.')
        const investigation = await dependencies.getStore().create(user, parsed.data)
        return json({ ok: true, investigation: publicRecord(investigation) }, 201)
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The investigation could not be created.')
      }
    },

    async list(request: Request): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const url = new URL(request.url)
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null ? undefined : Number(limitRaw)
        const cursor = url.searchParams.get('cursor')
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) return failure(400, 'INVALID_PAGINATION', 'The investigation page size is invalid.')
        if (cursor !== null && !/^\d+$/.test(cursor)) return failure(400, 'INVALID_PAGINATION', 'The investigation cursor is invalid.')
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const page = await dependencies.getStore().list(user, { cursor, limit })
        return json({ ok: true, investigations: page.investigations.map(publicRecord), nextCursor: page.nextCursor }, 200)
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'Investigations could not be loaded.')
      }
    },

    async get(request: Request, rawId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const url = new URL(request.url)
        const timelineLimit = url.searchParams.get('timelineLimit')
        const executionLimit = url.searchParams.get('executionLimit')
        const timelineCursor = url.searchParams.get('timelineCursor')
        const executionCursor = url.searchParams.get('executionCursor')
        const parsedTimelineLimit = timelineLimit === null ? undefined : Number(timelineLimit)
        const parsedExecutionLimit = executionLimit === null ? undefined : Number(executionLimit)
        if (parsedTimelineLimit !== undefined && (!Number.isSafeInteger(parsedTimelineLimit) || parsedTimelineLimit < 1 || parsedTimelineLimit > 100)) return failure(400, 'INVALID_PAGINATION', 'The timeline page size is invalid.')
        if (parsedExecutionLimit !== undefined && (!Number.isSafeInteger(parsedExecutionLimit) || parsedExecutionLimit < 1 || parsedExecutionLimit > 50)) return failure(400, 'INVALID_PAGINATION', 'The execution page size is invalid.')
        if (timelineCursor !== null && !/^\d+-\d+$/.test(timelineCursor)) return failure(400, 'INVALID_PAGINATION', 'The timeline cursor is invalid.')
        if (executionCursor !== null && !/^\d+$/.test(executionCursor)) return failure(400, 'INVALID_PAGINATION', 'The execution cursor is invalid.')
        const requestId = newRequestId(request)
        const logger = dependencies.logger ?? NOOP_INVESTIGATION_LOGGER
        await dependencies.synchronize?.(user, investigationId)
        const hydration = await resolveCanonicalInvestigation(
          dependencies.getStore(),
          user,
          investigationId,
          { timelineCursor, timelineLimit: parsedTimelineLimit, executionCursor, executionLimit: parsedExecutionLimit },
          {
            onMiss: attempt => logger.warn('investigation.hydrate_miss_retry', { requestId, investigationId, userId: user, attempt }),
            onRecovered: attempt => logger.info('investigation.hydrate_recovered', { requestId, investigationId, userId: user, attempt })
          }
        )
        if (!hydration) logger.warn('investigation.hydrate_not_found', { requestId, investigationId, userId: user })
        return hydration ? json({ ok: true, ...publicHydration(hydration) }, 200) : failure(404, 'NOT_FOUND', 'Investigation not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The investigation could not be loaded.')
      }
    },

    async patch(request: Request, rawId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const parsed = PATCH_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success || Object.keys(parsed.data).length === 0) return failure(400, 'INVALID_INPUT', 'The investigation update is invalid.')
        const investigation = await dependencies.getStore().patch(user, investigationId, parsed.data as InvestigationPatchInput)
        return investigation ? json({ ok: true, investigation: publicRecord(investigation) }, 200) : failure(404, 'NOT_FOUND', 'Investigation not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The investigation could not be updated.')
      }
    },

    async delete(request: Request, rawId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const existing = await dependencies.getStore().get(user, investigationId, { timelineLimit: 1, executionLimit: 1 })
        const deleted = await dependencies.getStore().delete(user, investigationId)
        if (deleted && existing?.investigation.ttySessionId) {
          try {
            await dependencies.terminateInvestigationSession?.(existing.investigation.ttySessionId)
          } catch {
            // Deletion remains durable even when remote session cleanup is temporarily unavailable.
          }
        }
        return deleted ? json({ ok: true, investigationId, deleted: true }, 200) : failure(404, 'NOT_FOUND', 'Investigation not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The investigation could not be deleted.')
      }
    },

    async timeline(request: Request, rawId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const parsed = TIMELINE_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success) return failure(400, 'INVALID_INPUT', 'The timeline event is invalid.')
        if (parsed.data.type === 'note') {
          const event = await dependencies.getStore().recordNote(user, investigationId, parsed.data.body)
          return event ? json({ ok: true, event }, 201) : failure(404, 'NOT_FOUND', 'Investigation not found.')
        }
        const bookmark: Omit<InvestigationBookmark, 'bookmarkId' | 'createdAt'> = parsed.data
        const event = await dependencies.getStore().recordBookmark(user, investigationId, bookmark)
        return event ? json({ ok: true, event }, 201) : failure(404, 'NOT_FOUND', 'Investigation not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The timeline event could not be persisted.')
      }
    },

    async patchNote(request: Request, rawId: string, rawNoteId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const investigationId = parseId(rawId)
        const noteId = parseId(rawNoteId)
        if (!investigationId || !noteId) return failure(400, 'INVALID_NOTE_ID', 'The note identifier is invalid.')
        const parsed = NOTE_PATCH_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success) return failure(400, 'INVALID_INPUT', 'The note update is invalid.')
        const event = await dependencies.getStore().updateNote(user, investigationId, rawNoteId, parsed.data.body)
        return event ? json({ ok: true, event }, 200) : failure(404, 'NOT_FOUND', 'Note not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The note could not be updated.')
      }
    },

    async deleteNote(request: Request, rawId: string, rawNoteId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseId(rawId)
        const noteId = parseId(rawNoteId)
        if (!investigationId || !noteId) return failure(400, 'INVALID_NOTE_ID', 'The note identifier is invalid.')
        const event = await dependencies.getStore().deleteNote(user, investigationId, rawNoteId)
        return event ? json({ ok: true, event }, 200) : failure(404, 'NOT_FOUND', 'Note not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The note could not be deleted.')
      }
    }
  }
}

function sessionFromResponse(body: unknown): { readonly sessionId: string; readonly status: string } | null {
  if (typeof body !== 'object' || body === null || !('session' in body)) return null
  const session = body.session
  if (typeof session !== 'object' || session === null || !('sessionId' in session) || !('status' in session)) return null
  return typeof session.sessionId === 'string' && typeof session.status === 'string' ? { sessionId: session.sessionId, status: session.status } : null
}

function emptyRequest(url: string, method: 'GET' | 'POST' | 'DELETE'): Request {
  return new Request(url, { method })
}

export function createInvestigationSessionApi(dependencies: InvestigationSessionApiDependencies) {
  return {
    async ensure(request: Request, rawId: string): Promise<Response> {
      const requestId = newRequestId(request)
      const logger = dependencies.logger ?? NOOP_INVESTIGATION_LOGGER
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const store = dependencies.getStore()

        // Canonical resolution: identical lookup + retry semantics as workspace hydration.
        // This is what closes the split-brain where the workspace GET (issued a beat
        // earlier, or after a retry) sees the investigation but a session POST racing
        // close behind a create/patch does not yet observe the write.
        const hydration = await resolveCanonicalInvestigation(
          store,
          user,
          investigationId,
          { timelineLimit: 1, executionLimit: 1 },
          {
            onMiss: attempt => logger.warn('investigation.session_resolve_miss_retry', { requestId, investigationId, userId: user, attempt }),
            onRecovered: attempt => logger.info('investigation.session_resolve_recovered', { requestId, investigationId, userId: user, attempt })
          }
        )
        if (!hydration) {
          // Categorize the 404 instead of just logging that it happened. This is what turns
          // "root cause: replica lag" from a hypothesis into something the next occurrence can
          // actually confirm or falsify: absent/owner_mismatch/deleted are innocent, expected
          // 404s; owner_matches_active_but_unresolved has no innocent explanation and means the
          // retry-bounded resolver genuinely failed to see a record that demonstrably exists,
          // is owned by this user, and is active — which would rule replica lag in (if a later
          // read succeeds) or point at a different, real bug (if it doesn't).
          const diagnosis = await store.diagnoseAbsence(investigationId, user)
          const reason = !diagnosis.present ? 'absent' : !diagnosis.ownerMatches ? 'owner_mismatch' : diagnosis.status === 'deleted' ? 'deleted' : 'owner_matches_active_but_unresolved'
          logger.warn('investigation.session_ensure_not_found', { requestId, investigationId, userId: user, reason })
          return failure(404, 'NOT_FOUND', 'Investigation not found.')
        }

        const existingSessionId = hydration.investigation.ttySessionId
        if (existingSessionId) {
          logger.info('investigation.session_ensure_existing_reference', { requestId, investigationId, userId: user, sessionId: existingSessionId })
          const existingResponse = await dependencies.getTTYSession(emptyRequest(request.url, 'GET'), existingSessionId)
          const existingBody: unknown = await existingResponse.json().catch(() => null)
          const existing = sessionFromResponse(existingBody)
          if (existingResponse.ok && existing?.status === 'active') {
            logger.info('investigation.session_ensure_reused', { requestId, investigationId, userId: user, sessionId: existing.sessionId })
            return json({ ok: true, investigation: publicRecord(hydration.investigation), sessionId: existing.sessionId, reused: true }, 200)
          }
          if (existingResponse.status >= 500) {
            logger.error('investigation.session_ensure_restore_failed', { requestId, investigationId, userId: user, sessionId: existingSessionId, status: existingResponse.status })
            return failure(503, 'SESSION_UNAVAILABLE', 'The execution session could not be restored.')
          }
          // Stale index: the investigation record still points at a TTY session that no
          // longer exists (expired, worker-recycled, or already terminated). Self-heal by
          // clearing the reference before minting a replacement, instead of surfacing a 404.
          logger.warn('investigation.session_ensure_stale_reference_repaired', { requestId, investigationId, userId: user, sessionId: existingSessionId, status: existingResponse.status })
          await store.clearSession(user, investigationId)
        }

        const createdResponse = await dependencies.createTTYSession(emptyRequest(request.url, 'POST'))
        const createdBody: unknown = await createdResponse.json().catch(() => null)
        const created = sessionFromResponse(createdBody)
        if (!createdResponse.ok || !created) {
          logger.error('investigation.session_ensure_create_failed', { requestId, investigationId, userId: user, status: createdResponse.status })
          return json(createdBody ?? { ok: false, code: 'SESSION_NOT_CREATED', message: 'The execution session could not be created.' }, createdResponse.status)
        }

        const attached = await store.attachSession(user, investigationId, created.sessionId)
        if (!attached) {
          logger.error('investigation.session_ensure_attach_lost_ownership', { requestId, investigationId, userId: user, sessionId: created.sessionId })
          await dependencies.terminateTTYSession(emptyRequest(request.url, 'DELETE'), created.sessionId).catch(() => {})
          return failure(404, 'NOT_FOUND', 'Investigation not found.')
        }
        if (attached.ttySessionId !== created.sessionId) {
          // Idempotent concurrent-create: another in-flight request won the attach race.
          // Terminate our redundant session and hand back the surviving one.
          logger.info('investigation.session_ensure_concurrent_create_deduped', { requestId, investigationId, userId: user, sessionId: attached.ttySessionId, discardedSessionId: created.sessionId })
          await dependencies.terminateTTYSession(emptyRequest(request.url, 'DELETE'), created.sessionId).catch(() => {})
          return json({ ok: true, investigation: publicRecord(attached), sessionId: attached.ttySessionId, reused: true }, 200)
        }
        logger.info('investigation.session_ensure_created', { requestId, investigationId, userId: user, sessionId: created.sessionId })
        return json({ ok: true, investigation: publicRecord(attached), sessionId: created.sessionId, reused: false }, 201)
      } catch (error) {
        logger.error('investigation.session_ensure_internal_error', { requestId, investigationId: rawId, message: error instanceof Error ? error.message : String(error) })
        return failure(500, 'INTERNAL_ERROR', 'The execution session could not be attached.')
      }
    },

    async terminate(request: Request, rawId: string): Promise<Response> {
      const requestId = newRequestId(request)
      const logger = dependencies.logger ?? NOOP_INVESTIGATION_LOGGER
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const store = dependencies.getStore()
        const hydration = await resolveCanonicalInvestigation(store, user, investigationId, { timelineLimit: 1, executionLimit: 1 })
        if (!hydration) {
          logger.warn('investigation.session_terminate_not_found', { requestId, investigationId, userId: user })
          return failure(404, 'NOT_FOUND', 'Investigation not found.')
        }
        const sessionId = hydration.investigation.ttySessionId
        if (!sessionId) return json({ ok: true, investigation: publicRecord(hydration.investigation), terminated: false }, 200)
        const terminatedResponse = await dependencies.terminateTTYSession(emptyRequest(request.url, 'DELETE'), sessionId)
        if (!terminatedResponse.ok) {
          const body: unknown = await terminatedResponse.json().catch(() => null)
          logger.error('investigation.session_terminate_failed', { requestId, investigationId, userId: user, sessionId, status: terminatedResponse.status })
          return json(body ?? { ok: false, code: 'SESSION_NOT_TERMINATED', message: 'The execution session could not be terminated.' }, terminatedResponse.status)
        }
        const investigation = await store.clearSession(user, investigationId)
        logger.info('investigation.session_terminated', { requestId, investigationId, userId: user, sessionId })
        return investigation ? json({ ok: true, investigation: publicRecord(investigation), terminated: true }, 200) : failure(404, 'NOT_FOUND', 'Investigation not found.')
      } catch (error) {
        logger.error('investigation.session_terminate_internal_error', { requestId, investigationId: rawId, message: error instanceof Error ? error.message : String(error) })
        return failure(500, 'INTERNAL_ERROR', 'The execution session could not be terminated.')
      }
    }
  }
}

export function createInvestigationExecutionApi(dependencies: InvestigationExecutionApiDependencies) {
  return {
    async attach(request: Request, rawId: string): Promise<Response> {
      const requestId = newRequestId(request)
      const logger = dependencies.logger ?? NOOP_INVESTIGATION_LOGGER
      const startedAt = Date.now()
      const elapsed = () => Date.now() - startedAt
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const parsed = ATTACH_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success) return failure(400, 'INVALID_INPUT', 'The execution attachment payload is invalid.')
        const investigation = await resolveCanonicalInvestigation(dependencies.getStore(), user, investigationId, { executionLimit: 1, timelineLimit: 1 })
        if (!investigation) return failure(404, 'NOT_FOUND', 'Investigation not found.')
        const resolvePhaseMs = elapsed()

        // The caller's session id is only a hint. The investigation's session
        // route is the authority and repairs stale/terminated attachments.
        let sessionId = parsed.data.sessionId
        if (dependencies.ensureSession) {
          const ensured = await dependencies.ensureSession(new Request(request.url, { method: 'POST' }), investigationId)
          const ensuredBody: unknown = await ensured.json().catch(() => null)
          if (ensured.status < 200 || ensured.status >= 300) {
            logger.warn('investigation.execution_session_ensure_failed', { requestId, investigationId, userId: user, status: ensured.status })
            return json(ensuredBody ?? { ok: false, code: 'SESSION_UNAVAILABLE', message: 'The execution session could not be attached.' }, ensured.status)
          }
          const ensuredSessionId = typeof ensuredBody === 'object' && ensuredBody !== null && 'sessionId' in ensuredBody && typeof ensuredBody.sessionId === 'string' ? ensuredBody.sessionId : null
          if (!ensuredSessionId) return failure(502, 'INVALID_SESSION_RESPONSE', 'The session response was invalid.')
          sessionId = ensuredSessionId
        }

        const createAdmissionRequest = () => new Request(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: parsed.data.input, idempotencyKey: parsed.data.idempotencyKey })
        })
        let admitted = await dependencies.admitExecution(createAdmissionRequest(), sessionId)
        let admittedBody: unknown = await admitted.json().catch(() => null)
        const admissionCode = () => typeof admittedBody === 'object' && admittedBody !== null && 'code' in admittedBody && typeof admittedBody.code === 'string' ? admittedBody.code : null
        if ((admitted.status === 404 || admitted.status === 409) && dependencies.ensureSession && (admissionCode() === 'SESSION_NOT_FOUND' || admissionCode() === 'SESSION_TERMINATED')) {
          const rebound = await dependencies.ensureSession(new Request(request.url, { method: 'POST' }), investigationId)
          const reboundBody: unknown = await rebound.json().catch(() => null)
          const reboundSessionId = rebound.status >= 200 && rebound.status < 300 && typeof reboundBody === 'object' && reboundBody !== null && 'sessionId' in reboundBody && typeof reboundBody.sessionId === 'string' ? reboundBody.sessionId : null
          if (!reboundSessionId) return json(reboundBody ?? { ok: false, code: 'SESSION_UNAVAILABLE', message: 'The execution session could not be restored.' }, rebound.status)
          sessionId = reboundSessionId
          admitted = await dependencies.admitExecution(createAdmissionRequest(), sessionId)
          admittedBody = await admitted.json().catch(() => null)
        }
        if (admitted.status < 200 || admitted.status >= 300) {
          const admitPhaseMs = elapsed()
          logger.info('investigation.execution_attach_phases', { requestId, investigationId, userId: user, resolve: resolvePhaseMs, admit: admitPhaseMs, attach: admitPhaseMs, activate: admitPhaseMs, totalMs: admitPhaseMs })
          return json(admittedBody ?? { ok: false, code: 'EXECUTION_NOT_ADMITTED', message: 'The execution was not admitted.' }, admitted.status)
        }
        if (typeof admittedBody !== 'object' || admittedBody === null) return failure(502, 'INVALID_ADMISSION_RESPONSE', 'The execution admission response was invalid.')
        const body = admittedBody as { ok?: boolean; duplicate?: boolean; job?: { executionId?: string; sessionId?: string } }
        if (!body.ok || !body.job?.executionId || body.job.sessionId !== sessionId) return failure(502, 'INVALID_ADMISSION_RESPONSE', 'The execution admission response was invalid.')
        const admitPhaseMs = elapsed()
        const attached = await dependencies.getStore().attachExecution(user, investigationId, { executionId: body.job.executionId, sessionId })
        if (!attached) return failure(404, 'NOT_FOUND', 'Investigation not found.')
        const attachPhaseMs = elapsed()

        if (dependencies.startExecution) {
          const executionId = body.job.executionId
          const budgetMs = dependencies.activationResponseBudgetMs
          const result = await raceActivationBudget(
            () => dependencies.startExecution!(executionId, sessionId),
            budgetMs,
            {
              onRequested: () => logger.info('investigation.execution_activation_requested', { requestId, investigationId, userId: user, executionId, sessionId }),
              onPending: budget => logger.info('investigation.execution_activation_pending', { requestId, investigationId, userId: user, executionId, sessionId, budgetMs: budget }),
              onSettledLate: settled => logger.info('investigation.execution_activation_settled_late', { requestId, investigationId, userId: user, executionId, sessionId, accepted: settled.accepted, reason: settled.reason }),
              onErroredLate: message => logger.error('investigation.execution_activation_errored_late', { requestId, investigationId, userId: user, executionId, sessionId, message }),
              onRejected: reason => logger.warn('investigation.execution_activation_rejected', { requestId, investigationId, userId: user, executionId, sessionId, reason }),
              onAccepted: () => logger.info('investigation.execution_activation_accepted', { requestId, investigationId, userId: user, executionId, sessionId })
            }
          )
          const activatePhaseMs = elapsed()
          if (result.kind === 'pending') {
            logger.info('investigation.execution_attach_phases', { requestId, investigationId, userId: user, resolve: resolvePhaseMs, admit: admitPhaseMs, attach: attachPhaseMs, activate: activatePhaseMs, totalMs: activatePhaseMs })
            return json({ ok: true, investigationId, execution: attached, job: body.job, duplicate: body.duplicate === true, activationPending: true }, 202)
          }
          if (result.kind === 'rejected') return failure(503, 'EXECUTION_NOT_STARTED', 'The execution could not be started.')
          logger.info('investigation.execution_attach_phases', { requestId, investigationId, userId: user, resolve: resolvePhaseMs, admit: admitPhaseMs, attach: attachPhaseMs, activate: activatePhaseMs, totalMs: activatePhaseMs })
          return json({ ok: true, investigationId, execution: attached, job: body.job, duplicate: body.duplicate === true }, admitted.status)
        }
        const activatePhaseMs = elapsed()
        logger.info('investigation.execution_attach_phases', { requestId, investigationId, userId: user, resolve: resolvePhaseMs, admit: admitPhaseMs, attach: attachPhaseMs, activate: activatePhaseMs, totalMs: activatePhaseMs })
        return json({ ok: true, investigationId, execution: attached, job: body.job, duplicate: body.duplicate === true }, admitted.status)
      } catch (error) {
        logger.error('investigation.execution_attach_internal_error', { requestId, investigationId: rawId, message: error instanceof Error ? error.message : String(error) })
        return failure(500, 'INTERNAL_ERROR', 'The execution could not be attached to the investigation.')
      }
    }
  }
}
