import { log } from '@/lib/hexical/telemetry'

export const TTY_WORKER_POLLER_DEFAULTS = Object.freeze({
  baseIntervalMs: 1_000,
  maxIntervalMs: 15_000,
  jitterMs: 500,
  batchSize: 100,
})

export interface PendingExecutionQueue {
  listPendingExecutionIds(limit: number): Promise<readonly string[]>
}

export class InMemoryPendingExecutionQueue implements PendingExecutionQueue {
  private readonly pending = new Set<string>()

  enqueue(executionId: string): void {
    const normalized = executionId.trim()
    if (normalized.length > 0) this.pending.add(normalized)
  }

  enqueueMany(executionIds: readonly string[]): void {
    for (const executionId of executionIds) this.enqueue(executionId)
  }

  remove(executionId: string): void {
    this.pending.delete(executionId)
  }

  async listPendingExecutionIds(limit: number): Promise<readonly string[]> {
    return [...this.pending].slice(0, Math.max(0, Math.floor(limit)))
  }
}

export interface TTYWorkerPollerLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export type TTYWorkerPollerState = 'stopped' | 'starting' | 'running' | 'stopping'

export interface TTYWorkerPollerStatus {
  readonly state: TTYWorkerPollerState
  readonly running: boolean
  readonly lastPollAt: string | null
  readonly consecutiveIdlePolls: number
  /** The backoff interval before jitter is added. */
  readonly currentIntervalMs: number
  /** The last scheduled interval including randomized jitter. */
  readonly lastScheduledDelayMs: number | null
  readonly pollsPerformed: number
  readonly executionsObserved: number
  readonly lastPendingCount: number
  readonly lastError: string | null
}

export interface TTYWorkerPollerDependencies {
  readonly queue: PendingExecutionQueue
  /** Optional discovery hook. It receives IDs only; it never receives job payloads. */
  readonly onPendingExecutionIds?: (executionIds: readonly string[]) => Promise<unknown> | unknown
  readonly baseIntervalMs?: number
  readonly maxIntervalMs?: number
  readonly jitterMs?: number
  readonly batchSize?: number
  readonly now?: () => Date
  /** Must return a value in the inclusive range [0, 1]. */
  readonly random?: () => number
  readonly setTimeout?: (handler: () => void, delayMs: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  readonly logger?: TTYWorkerPollerLogger
}

const defaultLogger: TTYWorkerPollerLogger = {
  info: (message, fields) => log.info(message, { component: 'tty-worker-poller', ...fields }),
  warn: (message, fields) => log.warn(message, { component: 'tty-worker-poller', ...fields }),
  error: (message, fields) => log.error(message, { component: 'tty-worker-poller', ...fields }),
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Unknown queue polling failure.'
}

export class TTYWorkerPoller {
  private readonly now: () => Date
  private readonly random: () => number
  private readonly setTimer: (handler: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly logger: TTYWorkerPollerLogger
  private readonly baseIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly jitterMs: number
  private readonly batchSize: number
  private state: TTYWorkerPollerState = 'stopped'
  private active = false
  private timer: unknown = null
  private pollInFlight: Promise<void> | null = null
  private startPromise: Promise<TTYWorkerPollerStatus> | null = null
  private stopPromise: Promise<TTYWorkerPollerStatus> | null = null
  private lastPollAt: string | null = null
  private consecutiveIdlePolls = 0
  private currentIntervalMs: number
  private lastScheduledDelayMs: number | null = null
  private pollsPerformed = 0
  private executionsObserved = 0
  private lastPendingCount = 0
  private lastError: string | null = null

  constructor(private readonly dependencies: TTYWorkerPollerDependencies) {
    this.baseIntervalMs = dependencies.baseIntervalMs ?? TTY_WORKER_POLLER_DEFAULTS.baseIntervalMs
    this.maxIntervalMs = dependencies.maxIntervalMs ?? TTY_WORKER_POLLER_DEFAULTS.maxIntervalMs
    this.jitterMs = dependencies.jitterMs ?? TTY_WORKER_POLLER_DEFAULTS.jitterMs
    this.batchSize = dependencies.batchSize ?? TTY_WORKER_POLLER_DEFAULTS.batchSize
    if (
      !validPositiveInteger(this.baseIntervalMs) ||
      !validPositiveInteger(this.maxIntervalMs) ||
      this.maxIntervalMs < this.baseIntervalMs
    ) {
      throw new Error('Invalid TTY worker poller interval configuration.')
    }
    if (!validNonNegativeInteger(this.jitterMs) || !validPositiveInteger(this.batchSize)) {
      throw new Error('Invalid TTY worker poller jitter or batch configuration.')
    }
    this.now = dependencies.now ?? (() => new Date())
    this.random = dependencies.random ?? Math.random
    this.setTimer = dependencies.setTimeout ?? ((handler, delayMs) => setTimeout(handler, delayMs))
    this.clearTimer = dependencies.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.logger = dependencies.logger ?? defaultLogger
    this.currentIntervalMs = this.baseIntervalMs
  }

  /** Starts one immediate poll and resolves once that first poll is scheduled. */
  async startPolling(): Promise<TTYWorkerPollerStatus> {
    if (this.active && this.startPromise !== null) return this.startPromise
    if (this.active) return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) await this.stopPromise

    this.active = true
    this.state = 'starting'
    this.consecutiveIdlePolls = 0
    this.currentIntervalMs = this.baseIntervalMs
    this.lastScheduledDelayMs = null
    this.lastError = null
    this.logger.info('polling_started', { baseIntervalMs: this.baseIntervalMs, batchSize: this.batchSize })
    this.startPromise = this.startInternal()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async stopPolling(): Promise<TTYWorkerPollerStatus> {
    if (!this.active && this.state === 'stopped') return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) return this.stopPromise

    this.active = false
    this.state = 'stopping'
    this.clearScheduledPoll()
    this.stopPromise = this.stopInternal()
    try {
      return await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  getStatus(): TTYWorkerPollerStatus {
    return Object.freeze({
      state: this.state,
      running: this.active,
      lastPollAt: this.lastPollAt,
      consecutiveIdlePolls: this.consecutiveIdlePolls,
      currentIntervalMs: this.currentIntervalMs,
      lastScheduledDelayMs: this.lastScheduledDelayMs,
      pollsPerformed: this.pollsPerformed,
      executionsObserved: this.executionsObserved,
      lastPendingCount: this.lastPendingCount,
      lastError: this.lastError,
    })
  }

  private async startInternal(): Promise<TTYWorkerPollerStatus> {
    await this.pollOnce()
    if (this.active) {
      this.state = 'running'
      this.scheduleNextPoll()
    }
    return this.getStatus()
  }

  private async stopInternal(): Promise<TTYWorkerPollerStatus> {
    if (this.startPromise !== null) await this.startPromise.catch(() => undefined)
    if (this.pollInFlight !== null) await this.pollInFlight.catch(() => undefined)
    this.clearScheduledPoll()
    this.state = 'stopped'
    this.logger.info('polling_shutdown', {
      pollsPerformed: this.pollsPerformed,
      executionsObserved: this.executionsObserved,
    })
    return this.getStatus()
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight !== null) return this.pollInFlight
    const operation = this.performPoll()
    this.pollInFlight = operation
    try {
      await operation
    } finally {
      if (this.pollInFlight === operation) this.pollInFlight = null
    }
  }

  private async performPoll(): Promise<void> {
    const startedAtMs = this.now().getTime()
    this.logger.info('poll_started', { batchSize: this.batchSize })
    try {
      const pendingExecutionIds = await this.dependencies.queue.listPendingExecutionIds(this.batchSize)
      const pendingCount = pendingExecutionIds.length
      this.lastPendingCount = pendingCount
      this.executionsObserved += pendingCount
      this.pollsPerformed += 1
      this.lastPollAt = this.now().toISOString()
      this.lastError = null
      this.logger.info('pending_execution_count', { pendingCount })
      this.logger.info('poll_completed', { pendingCount, durationMs: Math.max(0, this.now().getTime() - startedAtMs) })
      if (pendingCount > 0) {
        this.consecutiveIdlePolls = 0
        this.currentIntervalMs = this.baseIntervalMs
      } else {
        this.consecutiveIdlePolls += 1
        this.currentIntervalMs = this.backoffInterval(this.consecutiveIdlePolls)
      }
      if (pendingCount > 0 && this.dependencies.onPendingExecutionIds) {
        try {
          await this.dependencies.onPendingExecutionIds(pendingExecutionIds)
        } catch (error) {
          this.lastError = errorMessage(error)
          this.logger.error('pending_execution_handler_error', { error: this.lastError })
        }
      }
    } catch (error) {
      this.pollsPerformed += 1
      this.lastPollAt = this.now().toISOString()
      this.lastPendingCount = 0
      this.consecutiveIdlePolls += 1
      this.currentIntervalMs = this.backoffInterval(this.consecutiveIdlePolls)
      this.lastError = errorMessage(error)
      this.logger.error('polling_error', {
        error: this.lastError,
        durationMs: Math.max(0, this.now().getTime() - startedAtMs),
      })
    }
  }

  private backoffInterval(idlePolls: number): number {
    const exponent = Math.max(0, idlePolls - 1)
    return Math.min(this.maxIntervalMs, this.baseIntervalMs * 2 ** exponent)
  }

  private scheduleNextPoll(): void {
    if (!this.active || this.timer !== null) return
    const jitter = this.jitterAmount()
    const delayMs = this.currentIntervalMs + jitter
    this.lastScheduledDelayMs = delayMs
    const fields = {
      consecutiveIdlePolls: this.consecutiveIdlePolls,
      intervalMs: this.currentIntervalMs,
      jitterMs: jitter,
      sleepingMs: delayMs,
    }
    this.logger.info(this.consecutiveIdlePolls > 0 ? 'poll_idle_backoff' : 'poll_sleeping', fields)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.runScheduledPoll()
    }, delayMs)
  }

  private async runScheduledPoll(): Promise<void> {
    if (!this.active) return
    await this.pollOnce()
    if (this.active) this.scheduleNextPoll()
  }

  private jitterAmount(): number {
    if (this.jitterMs === 0) return 0
    const randomValue = this.random()
    const normalized = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0
    return Math.min(this.jitterMs, Math.floor(normalized * (this.jitterMs + 1)))
  }

  private clearScheduledPoll(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}

export function createTTYWorkerPoller(dependencies: TTYWorkerPollerDependencies): TTYWorkerPoller {
  return new TTYWorkerPoller(dependencies)
}
