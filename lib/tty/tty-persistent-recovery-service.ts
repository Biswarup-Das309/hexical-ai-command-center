import type { TTYExecutionCoordinator, TTYExecutionCoordinatorRecoveredRun } from './tty-execution-coordinator'
import type { TTYExecutionLeaseManager } from './tty-execution-lease'
import type {
  TTYPersistentExecutionHandle,
  TTYPersistentExecutionRecord,
  TTYPersistentSessionManager,
} from './tty-persistent-session-manager'
import type { TTYProcessHandle } from './tty-process-runtime'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

export interface TTYPersistentRecoveryServiceLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface TTYPersistentRecoveryServiceOptions {
  readonly scanIntervalMs?: number
  readonly setInterval?: (handler: () => void, timeoutMs: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly logger?: TTYPersistentRecoveryServiceLogger
  /** Required in production so adoption resumes authoritative execution state. */
  readonly coordinator?: Pick<TTYExecutionCoordinator, 'runRecoveredPersistent'>
  /** Required in production so an existing framed command is never dispatched twice. */
  readonly processRuntime?: {
    attachRecovered(input: {
      readonly executionId: TTYExecutionId
      readonly sessionId: TTYSessionId
      readonly workerId: TTYWorkerId
      readonly persistent: TTYPersistentExecutionHandle
    }): Promise<TTYProcessHandle>
  }
}

export interface TTYPersistentRecoveryScanResult {
  readonly scanned: number
  readonly adopted: number
  readonly attached: number
  readonly skipped: number
  readonly failed: number
}

const DEFAULT_SCAN_INTERVAL_MS = 5_000
const NOOP_LOGGER: TTYPersistentRecoveryServiceLogger = { info: () => {}, warn: () => {}, error: () => {} }

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export class TTYPersistentRecoveryService {
  private readonly scanIntervalMs: number
  private readonly setTimer: (handler: () => void, timeoutMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly logger: TTYPersistentRecoveryServiceLogger
  private readonly coordinator: TTYPersistentRecoveryServiceOptions['coordinator']
  private readonly processRuntime: TTYPersistentRecoveryServiceOptions['processRuntime']
  private timer: unknown = null
  private running = false
  private scanInFlight = false

  constructor(
    private readonly workerId: TTYWorkerId,
    private readonly sessions: Pick<TTYPersistentSessionManager, 'listActiveExecutionRecords' | 'recoverExecution'>,
    private readonly leases: Pick<TTYExecutionLeaseManager, 'adoptPersistent'>,
    options: TTYPersistentRecoveryServiceOptions = {},
  ) {
    const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS
    if (!validInterval(scanIntervalMs)) throw new Error('Invalid persistent recovery scan interval.')
    this.scanIntervalMs = scanIntervalMs
    this.setTimer = options.setInterval ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs))
    this.clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    this.logger = options.logger ?? NOOP_LOGGER
    this.coordinator = options.coordinator
    this.processRuntime = options.processRuntime
  }

  async start(): Promise<TTYPersistentRecoveryScanResult> {
    if (this.running) return this.recoverNow()
    this.running = true
    const result = await this.recoverNow()
    this.timer = this.setTimer(() => {
      void this.recoverNow()
    }, this.scanIntervalMs)
    return result
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  async recoverNow(): Promise<TTYPersistentRecoveryScanResult> {
    if (this.scanInFlight) return { scanned: 0, adopted: 0, attached: 0, skipped: 0, failed: 0 }
    this.scanInFlight = true
    const counters = { scanned: 0, adopted: 0, attached: 0, skipped: 0, failed: 0 }
    try {
      const records = await this.sessions.listActiveExecutionRecords()
      for (const record of records) {
        counters.scanned += 1
        const recovered = await this.recoverRecord(record)
        counters[recovered] += 1
      }
      this.logger.info('persistent_recovery_scan_completed', { workerId: this.workerId, ...counters })
      return Object.freeze(counters)
    } finally {
      this.scanInFlight = false
    }
  }

  private async recoverRecord(
    record: TTYPersistentExecutionRecord,
  ): Promise<'adopted' | 'attached' | 'skipped' | 'failed'> {
    if (record.workerId === this.workerId) return 'skipped'
    try {
      const adopted = await this.leases.adoptPersistent(record.executionId, record.sessionId)
      if (!adopted.adopted) {
        if (adopted.reason === 'not_expired') return 'skipped'
        this.logger.warn('persistent_recovery_adoption_skipped', {
          workerId: this.workerId,
          executionId: record.executionId,
          sessionId: record.sessionId,
          reason: adopted.reason,
        })
        return 'skipped'
      }
      if (record.state === 'completed') {
        await this.resumeCoordinator({ job: adopted.job, handle: null, record })
        return 'adopted'
      }
      const handle = await this.sessions.recoverExecution({
        executionId: record.executionId as TTYExecutionId,
        sessionId: record.sessionId as TTYSessionId,
        ownerUserId: record.ownerUserId,
      })
      if (handle === null) {
        await this.resumeCoordinator({ job: adopted.job, handle: null, record })
        return 'adopted'
      }
      if (this.coordinator && this.processRuntime) {
        const processHandle = await this.processRuntime.attachRecovered({
          executionId: record.executionId,
          sessionId: record.sessionId,
          workerId: this.workerId,
          persistent: handle,
        })
        await this.resumeCoordinator({ job: adopted.job, handle: processHandle, record })
      }
      this.logger.info('persistent_recovery_attached', {
        workerId: this.workerId,
        executionId: record.executionId,
        sessionId: record.sessionId,
      })
      return 'attached'
    } catch (error) {
      this.logger.error('persistent_recovery_failed', {
        workerId: this.workerId,
        executionId: record.executionId,
        sessionId: record.sessionId,
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      })
      return 'failed'
    }
  }

  private async resumeCoordinator(input: TTYExecutionCoordinatorRecoveredRun): Promise<void> {
    if (!this.coordinator) return
    // A recovered command may be long-running. The recovery scan establishes
    // ownership and the coordinator context synchronously, then continues the
    // stream/finalization task in the background so worker readiness is not
    // blocked on customer work.
    void this.coordinator.runRecoveredPersistent(input).then(
      (result) => {
        this.logger.info('persistent_recovery_coordinator_resumed', {
          workerId: this.workerId,
          executionId: input.record.executionId,
          sessionId: input.record.sessionId,
          accepted: result.accepted,
          state: result.state?.state ?? null,
        })
      },
      (error) => {
        this.logger.error('persistent_recovery_coordinator_failed', {
          workerId: this.workerId,
          executionId: input.record.executionId,
          sessionId: input.record.sessionId,
          errorCode: error instanceof Error ? error.name : 'unknown_error',
        })
      },
    )
  }
}
