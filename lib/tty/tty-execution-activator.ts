import {
  type TTYExecutionCoordinator,
  type TTYExecutionCoordinatorFailureReason,
  type TTYExecutionCoordinatorRunOptions
} from './tty-execution-coordinator'
import type { TTYExecutionId, TTYSessionId } from './tty-types'

const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000

type ExecutionState = Awaited<ReturnType<TTYExecutionCoordinator['getState']>>

export interface TTYExecutionActivationResult {
  readonly accepted: boolean
  readonly state: ExecutionState
  readonly reason?: TTYExecutionCoordinatorFailureReason
}

export interface TTYExecutionActivationOptions {
  readonly correlationId?: string
}

export interface TTYExecutionActivatorDependencies {
  readonly coordinator: Pick<TTYExecutionCoordinator, 'getState' | 'run'>
  readonly activationTimeoutMs?: number
  readonly onFailure?: (input: { readonly executionId: TTYExecutionId; readonly sessionId: TTYSessionId; readonly reason: TTYExecutionCoordinatorFailureReason; readonly phase: 'state_read' | 'run' | 'timeout'; readonly correlationId?: string }) => void
}

function activationTimeout(value: number | undefined): number {
  const normalized = Math.floor(value ?? DEFAULT_ACTIVATION_TIMEOUT_MS)
  return Number.isSafeInteger(normalized) ? Math.max(100, Math.min(30_000, normalized)) : DEFAULT_ACTIVATION_TIMEOUT_MS
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: { readonly timedOut: false; readonly value: T } | { readonly timedOut: true }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    void operation.then(value => finish({ timedOut: false, value }), () => finish({ timedOut: true }))
  })
}

/**
 * Deduplicates same-process activation and bounds the request-visible wait.
 * The coordinator still owns every state transition, lease, process, and
 * terminal outcome; this adapter only waits for its persisted lease acceptance.
 */
export class TTYExecutionActivator {
  private readonly inFlight = new Map<TTYExecutionId, Promise<TTYExecutionActivationResult>>()
  private readonly timeoutMs: number

  constructor(private readonly dependencies: TTYExecutionActivatorDependencies) {
    this.timeoutMs = activationTimeout(dependencies.activationTimeoutMs)
  }

  activate(rawExecutionId: string, rawSessionId: string, options: TTYExecutionActivationOptions = {}): Promise<TTYExecutionActivationResult> {
    const executionId = rawExecutionId as TTYExecutionId
    const sessionId = rawSessionId as TTYSessionId
    const existing = this.inFlight.get(executionId)
    if (existing) return existing

    const activation = this.activateNew(executionId, sessionId, options)
    this.inFlight.set(executionId, activation)
    void activation.finally(() => {
      if (this.inFlight.get(executionId) === activation) this.inFlight.delete(executionId)
    })
    return activation
  }

  private async activateNew(executionId: TTYExecutionId, sessionId: TTYSessionId, activationOptions: TTYExecutionActivationOptions): Promise<TTYExecutionActivationResult> {
    const existing = await this.readState(executionId, sessionId)
    if (existing === undefined) return { accepted: false, state: null, reason: 'internal_error' }
    if (existing !== null && existing.state !== 'queued') return { accepted: true, state: existing }

    let resolveAcceptance!: (result: TTYExecutionActivationResult) => void
    let settled = false
    const acceptance = new Promise<TTYExecutionActivationResult>(resolve => { resolveAcceptance = resolve })
    const settle = (result: TTYExecutionActivationResult) => {
      if (settled) return
      settled = true
      resolveAcceptance(result)
    }
    const abortController = new AbortController()
    const options: TTYExecutionCoordinatorRunOptions = {
      onAccepted: state => settle({ accepted: true, state }),
      abortSignal: abortController.signal,
      ...(activationOptions.correlationId ? { correlationId: activationOptions.correlationId } : {})
    }
    const run = this.dependencies.coordinator.run(executionId, sessionId, options)
    void run.then(result => {
      if (result.accepted) return settle({ accepted: true, state: result.state })
      if (result.reason === 'not_queued' && result.state !== null) return settle({ accepted: true, state: result.state })
      this.failure(executionId, sessionId, result.reason, 'run', activationOptions.correlationId)
      settle({ accepted: false, state: result.state, reason: result.reason })
    }).catch(() => {
      this.failure(executionId, sessionId, 'internal_error', 'run', activationOptions.correlationId)
      settle({ accepted: false, state: null, reason: 'internal_error' })
    })

    const outcome = await withTimeout(acceptance, this.timeoutMs)
    if (!outcome.timedOut) return outcome.value
    abortController.abort()
    this.failure(executionId, sessionId, 'internal_error', 'timeout', activationOptions.correlationId)
    return { accepted: false, state: null, reason: 'internal_error' }
  }

  private async readState(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<ExecutionState | undefined> {
    const result = await withTimeout(this.dependencies.coordinator.getState(executionId), this.timeoutMs)
    if (!result.timedOut) return result.value
    this.failure(executionId, sessionId, 'internal_error', 'state_read')
    return undefined
  }

  private failure(executionId: TTYExecutionId, sessionId: TTYSessionId, reason: TTYExecutionCoordinatorFailureReason, phase: 'state_read' | 'run' | 'timeout', correlationId?: string): void {
    try {
      this.dependencies.onFailure?.({ executionId, sessionId, reason, phase, ...(correlationId ? { correlationId } : {}) })
    } catch {
      // Failure observers must not mask a failed activation result.
    }
  }
}
