/** Server-side authorization for browser subscriptions to one execution. */

import type { TTYExecutionStateRecord } from './tty-execution-state'
import type { InternalTTYSession, TTYExecutionId, TTYSessionId } from './tty-types'

export type TTYStreamAuthorizationFailure =
  | 'unauthenticated'
  | 'execution_not_found'
  | 'session_not_found'
  | 'session_not_active'
  | 'permission_denied'
  | 'internal_error'

export type TTYStreamAuthorizationResult =
  | {
      readonly authorized: true
      readonly userId: string
      readonly executionId: TTYExecutionId
      readonly sessionId: TTYSessionId
    }
  | { readonly authorized: false; readonly reason: TTYStreamAuthorizationFailure }

export interface TTYStreamAuthorizationDependencies {
  readonly getExecutionState: (executionId: TTYExecutionId) => Promise<TTYExecutionStateRecord | null>
  /**
   * Queued jobs may be visible for a short interval before the worker creates
   * the coordinator-owned state record. Resolve the session from that durable
   * queue record so the browser can subscribe during that interval instead of
   * treating a valid queued execution as missing.
   */
  readonly getQueuedExecutionSessionId?: (executionId: TTYExecutionId) => Promise<TTYSessionId | null>
  readonly getSession: (sessionId: TTYSessionId, userId: string) => Promise<InternalTTYSession | null>
  readonly canSubscribe?: (input: {
    readonly userId: string
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
  }) => Promise<boolean>
}

export interface TTYStreamAuthorizationRequest {
  readonly userId: string | null | undefined
  readonly executionId: TTYExecutionId
  readonly requestedSessionId?: TTYSessionId
}

export class TTYStreamAuthorizer {
  constructor(private readonly dependencies: TTYStreamAuthorizationDependencies) {}

  async authorize(request: TTYStreamAuthorizationRequest): Promise<TTYStreamAuthorizationResult> {
    const userId = request.userId?.trim()
    if (!userId) return { authorized: false, reason: 'unauthenticated' }

    let state: TTYExecutionStateRecord | null
    try {
      state = await this.dependencies.getExecutionState(request.executionId)
    } catch {
      return { authorized: false, reason: 'internal_error' }
    }
    let sessionId = state?.executionId === request.executionId ? state.sessionId : null
    if (sessionId === null && this.dependencies.getQueuedExecutionSessionId) {
      try {
        sessionId = await this.dependencies.getQueuedExecutionSessionId(request.executionId)
      } catch {
        return { authorized: false, reason: 'internal_error' }
      }
    }
    if (sessionId === null) return { authorized: false, reason: 'execution_not_found' }
    if (request.requestedSessionId !== undefined && request.requestedSessionId !== sessionId)
      return { authorized: false, reason: 'session_not_found' }

    let session: InternalTTYSession | null
    try {
      session = await this.dependencies.getSession(sessionId, userId)
    } catch {
      return { authorized: false, reason: 'internal_error' }
    }
    if (session === null || session.ownerUserId !== userId) return { authorized: false, reason: 'session_not_found' }
    if (session.status !== 'active' && session.status !== 'idle')
      return { authorized: false, reason: 'session_not_active' }

    if (this.dependencies.canSubscribe) {
      try {
        if (
          !(await this.dependencies.canSubscribe({
            userId,
            executionId: request.executionId,
            sessionId,
          }))
        )
          return { authorized: false, reason: 'permission_denied' }
      } catch {
        return { authorized: false, reason: 'internal_error' }
      }
    }

    return { authorized: true, userId, executionId: request.executionId, sessionId }
  }
}
