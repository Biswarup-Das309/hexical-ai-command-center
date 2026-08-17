import { z } from 'zod'
import type { Tier } from '@/lib/hexical/types'
import { denialReasonToFailure, evaluateSessionCreationPolicy, type TTYSessionCreationPolicyResult } from './tty-policy'
import { TTYSessionCapacityError, toBrowserSafeSession, type TTYSessionCreateInput } from './tty-session-store'
import type {
  InternalTTYSession,
  TTYPrincipal,
  TTYResourceLimits,
  TTYSession,
  TTYSessionId,
  TTYTerminationReason,
  TTYTerminationResult,
} from './tty-types'

const MAX_BODY_BYTES = 8_192
const EMPTY_BODY_SCHEMA = z.object({}).strict()
const SESSION_ID_SCHEMA = z.string().uuid()

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json',
} as const

export interface TTYLifecycleStore {
  createSession(input: TTYSessionCreateInput): Promise<InternalTTYSession>
  getSession(sessionId: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null>
  touchSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null>
  terminateSession(
    sessionId: TTYSessionId,
    ownerUserId: string,
    reason: TTYTerminationReason,
  ): Promise<TTYTerminationResult>
  countActiveSessionsForUser(userId: string): Promise<number>
  listSessionsForUser(userId: string): Promise<readonly InternalTTYSession[]>
}

export interface TTYLifecycleApiDependencies {
  authenticate(): Promise<string | null>
  resolveTier(userId: string): Promise<Tier>
  resolveLimits(tier: Tier): TTYResourceLimits | null
  getStore(): TTYLifecycleStore
  /** Best-effort immediate PTY teardown; the terminated session state remains authoritative if delivery retries. */
  publishTerminationControl?: (sessionId: TTYSessionId, ownerUserId: string) => Promise<void>
}

interface SuccessResponse {
  readonly ok: true
  readonly session?: TTYSession
  readonly sessions?: readonly TTYSession[]
  readonly sessionId?: TTYSessionId
  readonly terminatedAt?: string
}

interface FailureResponse {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly session?: TTYSession
}

type LifecycleResponse = SuccessResponse | FailureResponse

function json(body: LifecycleResponse, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS })
}

function failure(reason: Parameters<typeof denialReasonToFailure>[0], status: number, session?: TTYSession): Response {
  const safeFailure = denialReasonToFailure(reason)
  return json(
    {
      ok: false,
      code: safeFailure.code,
      message: safeFailure.message,
      ...(session ? { session } : {}),
    },
    status,
  )
}

function invalidRequest(): Response {
  return failure('input_rejected', 400)
}

function internalError(): Response {
  return failure('internal_error', 500)
}

function parseSessionId(rawSessionId: string): TTYSessionId | null {
  return SESSION_ID_SCHEMA.safeParse(rawSessionId).success ? (rawSessionId as TTYSessionId) : null
}

async function hasValidEmptyBody(request: Request): Promise<boolean> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_BODY_BYTES) {
      return false
    }
  }

  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return false
  if (raw.trim().length === 0) return true

  try {
    return EMPTY_BODY_SCHEMA.safeParse(JSON.parse(raw)).success
  } catch {
    return false
  }
}

async function authenticatedUserId(dependencies: TTYLifecycleApiDependencies): Promise<string | null> {
  const userId = await dependencies.authenticate()
  if (typeof userId !== 'string') return null
  const normalized = userId.trim()
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null
}

function creationFailure(result: TTYSessionCreationPolicyResult): Response | null {
  if (result.evaluation.decision === 'allow') return null
  const reason = result.evaluation.reason ?? 'internal_error'
  const status =
    reason === 'concurrency_limit_exceeded' || reason === 'session_capacity_exceeded'
      ? 429
      : reason === 'input_rejected'
      ? 400
      : 403
  return failure(reason, status)
}

async function terminalTouchFailure(
  store: TTYLifecycleStore,
  sessionId: TTYSessionId,
  ownerUserId: string,
): Promise<Response> {
  const current = await store.getSession(sessionId, ownerUserId)
  if (current === null) return failure('session_not_found', 404)
  if (current.status === 'terminated' || current.status === 'expired') {
    return failure('session_terminated', 409, toBrowserSafeSession(current))
  }
  return failure('session_not_found', 404)
}

export function createTTYLifecycleApi(dependencies: TTYLifecycleApiDependencies) {
  return {
    async create(request: Request): Promise<Response> {
      try {
        const userId = await authenticatedUserId(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        if (!(await hasValidEmptyBody(request))) return invalidRequest()

        const tier = await dependencies.resolveTier(userId)
        const principal: TTYPrincipal = { userId, tier }
        const policyInput = {
          request: { requestedBy: principal },
          resolveLimits: dependencies.resolveLimits,
        }
        const capabilityCheck = evaluateSessionCreationPolicy(policyInput)
        const capabilityFailure = creationFailure(capabilityCheck)
        if (capabilityFailure !== null) return capabilityFailure

        const store = dependencies.getStore()
        const currentActiveSessionCount = await store.countActiveSessionsForUser(userId)
        const policy = evaluateSessionCreationPolicy({ ...policyInput, currentActiveSessionCount })
        const policyFailure = creationFailure(policy)
        if (policyFailure !== null) return policyFailure
        if (policy.limits === null) return internalError()

        const session = await store.createSession({ principal, limits: policy.limits })
        return json({ ok: true, session: toBrowserSafeSession(session) }, 201)
      } catch (error) {
        if (error instanceof TTYSessionCapacityError) return failure('session_capacity_exceeded', 429)
        console.error('[tty-lifecycle] create failed', error)
        return internalError()
      }
    },

    async list(request: Request): Promise<Response> {
      try {
        const userId = await authenticatedUserId(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        if (!(await hasValidEmptyBody(request))) return invalidRequest()
        const sessions = await dependencies.getStore().listSessionsForUser(userId)
        return json({ ok: true, sessions: sessions.map(toBrowserSafeSession) }, 200)
      } catch (error) {
        console.error('[tty-lifecycle] list failed', error)
        return internalError()
      }
    },

    async get(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await authenticatedUserId(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        if (!(await hasValidEmptyBody(request))) return invalidRequest()
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return invalidRequest()

        const session = await dependencies.getStore().getSession(sessionId, userId)
        if (session === null) return failure('session_not_found', 404)
        return json({ ok: true, session: toBrowserSafeSession(session) }, 200)
      } catch (error) {
        console.error('[tty-lifecycle] get failed', error)
        return internalError()
      }
    },

    async touch(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await authenticatedUserId(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        if (!(await hasValidEmptyBody(request))) return invalidRequest()
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return invalidRequest()

        const store = dependencies.getStore()
        const touched = await store.touchSession(sessionId, userId)
        if (touched === null) return terminalTouchFailure(store, sessionId, userId)
        return json({ ok: true, session: toBrowserSafeSession(touched) }, 200)
      } catch (error) {
        console.error('[tty-lifecycle] touch failed', error)
        return internalError()
      }
    },

    async terminate(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await authenticatedUserId(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        if (!(await hasValidEmptyBody(request))) return invalidRequest()
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return invalidRequest()

        const store = dependencies.getStore()
        const result = await store.terminateSession(sessionId, userId, 'user_requested')
        if (!result.acknowledged) return failure('session_not_found', 404)
        try {
          // State is committed first. If the worker stream is temporarily
          // unavailable, its heartbeat sees the terminal authoritative state
          // and fences the PTY; never leave a live shell by pretending this
          // write is a cross-system transaction.
          await dependencies.publishTerminationControl?.(sessionId, userId)
        } catch (error) {
          console.error('[tty-lifecycle] terminal control enqueue failed', error)
        }

        const session = await store.getSession(sessionId, userId)
        return json(
          {
            ok: true,
            sessionId,
            terminatedAt: result.terminatedAt,
            ...(session ? { session: toBrowserSafeSession(session) } : {}),
          },
          200,
        )
      } catch (error) {
        console.error('[tty-lifecycle] terminate failed', error)
        return internalError()
      }
    },
  }
}
