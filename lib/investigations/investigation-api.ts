import { z } from 'zod'

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
const ATTACH_SCHEMA = z.object({ sessionId: z.string().uuid(), input: z.string().min(1).max(4_000), idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._~-]+$/) }).strict()

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json'
} as const

type Store = Pick<InvestigationStore, 'create' | 'list' | 'get' | 'patch' | 'delete' | 'recordBookmark' | 'recordNote' | 'attachExecution'>

export interface InvestigationApiDependencies {
  readonly authenticate: () => Promise<string | null>
  readonly getStore: () => Store
  readonly synchronize?: (ownerUserId: string, investigationId: InvestigationId) => Promise<void>
}

export interface InvestigationExecutionApiDependencies extends InvestigationApiDependencies {
  readonly admitExecution: (request: Request, sessionId: string) => Promise<Response>
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
        await dependencies.synchronize?.(user, investigationId)
        const hydration = await dependencies.getStore().get(user, investigationId, { timelineCursor, timelineLimit: parsedTimelineLimit, executionCursor, executionLimit: parsedExecutionLimit })
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
        const deleted = await dependencies.getStore().delete(user, investigationId)
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
    }
  }
}

export function createInvestigationExecutionApi(dependencies: InvestigationExecutionApiDependencies) {
  return {
    async attach(request: Request, rawId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        const investigationId = parseId(rawId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const parsed = ATTACH_SCHEMA.safeParse(await parseJsonBody(request))
        if (!parsed.success) return failure(400, 'INVALID_INPUT', 'The execution attachment payload is invalid.')
        const investigation = await dependencies.getStore().get(user, investigationId, { executionLimit: 1, timelineLimit: 1 })
        if (!investigation) return failure(404, 'NOT_FOUND', 'Investigation not found.')

        const admissionRequest = new Request(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: parsed.data.input, idempotencyKey: parsed.data.idempotencyKey })
        })
        const admitted = await dependencies.admitExecution(admissionRequest, parsed.data.sessionId)
        const admittedBody: unknown = await admitted.json().catch(() => null)
        if (admitted.status < 200 || admitted.status >= 300) return json(admittedBody ?? { ok: false, code: 'EXECUTION_NOT_ADMITTED', message: 'The execution was not admitted.' }, admitted.status)
        if (typeof admittedBody !== 'object' || admittedBody === null) return failure(502, 'INVALID_ADMISSION_RESPONSE', 'The execution admission response was invalid.')
        const body = admittedBody as { ok?: boolean; duplicate?: boolean; job?: { executionId?: string; sessionId?: string } }
        if (!body.ok || !body.job?.executionId || body.job.sessionId !== parsed.data.sessionId) return failure(502, 'INVALID_ADMISSION_RESPONSE', 'The execution admission response was invalid.')
        const attached = await dependencies.getStore().attachExecution(user, investigationId, { executionId: body.job.executionId, sessionId: parsed.data.sessionId })
        if (!attached) return failure(404, 'NOT_FOUND', 'Investigation not found.')
        return json({ ok: true, investigationId, execution: attached, job: body.job, duplicate: body.duplicate === true }, admitted.status)
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The execution could not be attached to the investigation.')
      }
    }
  }
}
