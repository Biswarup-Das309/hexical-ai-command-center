import { z } from 'zod'

import { log, requestCorrelationId } from '@/lib/hexical/telemetry'

import { classifyTerminalInput, denialReasonToFailure, validateRawTerminalInput } from './tty-policy'
import { toBrowserSafeJob, type TTYExecutionAdmission, type TTYQueuedJob } from './tty-execution-admission'
import { hasTTYCapability, type InternalTTYSession, type TTYSessionId } from './tty-types'
import type { Tier } from '@/lib/hexical/types'

const REQUEST_SCHEMA = z.object({
  input: z.string().min(1).max(4_000),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._~-]+$/)
}).strict()

const SESSION_ID_SCHEMA = z.string().uuid()
const MAX_BODY_BYTES = 8_192
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', 'Content-Type': 'application/json' } as const

export interface TTYExecutionAdmissionApiDependencies {
  readonly authenticate: () => Promise<string | null>
  readonly resolveTier: (userId: string) => Promise<Tier>
  readonly getSession: (sessionId: TTYSessionId, ownerUserId: string) => Promise<InternalTTYSession | null>
  readonly admission: TTYExecutionAdmission
  readonly startExecution?: (executionId: TTYQueuedJob['executionId'], sessionId: TTYSessionId, options?: { readonly correlationId?: string }) => Promise<{ readonly accepted: boolean; readonly state?: string | null; readonly reason?: string }>
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS })
}

function failure(reason: Parameters<typeof denialReasonToFailure>[0], status: number): Response {
  const safe = denialReasonToFailure(reason)
  return response({ ok: false, code: safe.code, message: safe.message }, status)
}

export function createTTYExecutionAdmissionApi(dependencies: TTYExecutionAdmissionApiDependencies) {
  return {
    async admit(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const correlationId = requestCorrelationId(request)
        const userId = (await dependencies.authenticate())?.trim()
        if (!userId) return failure('unauthenticated', 401)
        const sessionId = SESSION_ID_SCHEMA.safeParse(rawSessionId).success ? rawSessionId as TTYSessionId : null
        if (!sessionId) return failure('input_rejected', 400)
        const declaredLength = request.headers.get('content-length')
        if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return failure('input_rejected', 400)
        const rawBody = await request.text()
        if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return failure('input_rejected', 400)
        let body: unknown
        try {
          body = JSON.parse(rawBody)
        } catch {
          return failure('input_rejected', 400)
        }
        const parsed = REQUEST_SCHEMA.safeParse(body)
        if (!parsed.success) return failure('input_rejected', 400)
        const rawInput = parsed.data.input as Parameters<typeof validateRawTerminalInput>[0]
        const inputFailure = validateRawTerminalInput(rawInput)
        if (inputFailure) return failure(inputFailure, 400)

        const tier = await dependencies.resolveTier(userId)
        const session = await dependencies.getSession(sessionId, userId)
        if (!session) return failure('session_not_found', 404)
        if (session.tier !== tier || !hasTTYCapability(tier)) return failure('capability_locked', 403)
        if (session.status !== 'active' && session.status !== 'idle') return failure('session_terminated', 409)

        const kind = classifyTerminalInput(rawInput)
        if (kind === 'unsupported') return failure('unsupported_kind', 422)
        const result = await dependencies.admission.admit({ session, rawInput, kind, idempotencyKey: parsed.data.idempotencyKey })
        if (!result.admitted) {
          const status = result.reason === 'session_terminated' ? 409 : result.reason === 'authorization_required' ? 403 : result.reason === 'input_rejected' ? 400 : result.reason === 'internal_error' ? 500 : 429
          return failure(result.reason, status)
        }
        log.info('tty.execution.admitted', { executionId: result.job.executionId, sessionId: result.job.sessionId, duplicate: result.duplicate, correlationId })
        let activationPending = false
        if (dependencies.startExecution) {
          const started = await dependencies.startExecution(result.job.executionId, result.job.sessionId, { correlationId })
          if (!started.accepted) {
            // Admission is durable before activation.  A transient web-worker
            // failure must not turn a valid queued job into a false 503 or
            // force the browser to submit a duplicate execution.  The worker
            // plane can claim the queued job, while the state/reason fields
            // make the delayed activation observable.
            activationPending = true
            log.warn('tty.execution.activation_pending', {
              executionId: result.job.executionId,
              sessionId: result.job.sessionId,
              state: started.state ?? 'queued',
              reason: started.reason ?? 'activation_rejected',
              correlationId
            })
          }
        }
        return response({ ok: true, job: toBrowserSafeJob(result.job), duplicate: result.duplicate, ...(activationPending ? { activationPending: true } : {}) }, result.duplicate ? 200 : 202)
      } catch {
        return failure('internal_error', 500)
      }
    }
  }
}

export type TTYExecutionAdmissionApi = ReturnType<typeof createTTYExecutionAdmissionApi>
