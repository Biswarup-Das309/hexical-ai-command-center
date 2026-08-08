import type { TTYWorkerAuthenticator } from './tty-worker-auth'
import type { TTYWorkerHeartbeatResult, TTYWorkerHeartbeatService } from './tty-worker-heartbeat'
import type { TTYWorkerRegistry } from './tty-worker-registry'
import type {
  TTYWorkerAuthContext,
  TTYWorkerCapability,
  TTYWorkerId,
  TTYWorkerRegistration
} from './tty-worker-types'

export const TTY_WORKER_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000

export type TTYWorkerDaemonState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface TTYWorkerDaemonStatus {
  readonly state: TTYWorkerDaemonState
  readonly workerId: TTYWorkerId
  readonly authenticated: boolean
  readonly heartbeatSequence: number
  readonly startedAt: string | null
  readonly lastHeartbeatAt: string | null
  readonly lastError: string | null
}

export interface TTYWorkerDaemonLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface TTYWorkerDaemonSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface TTYWorkerDaemonDependencies {
  readonly registry: Pick<TTYWorkerRegistry, 'registerWorker'>
  readonly authenticator: Pick<TTYWorkerAuthenticator, 'authenticateWorker'>
  readonly heartbeat: Pick<TTYWorkerHeartbeatService, 'recordHeartbeat'>
  readonly token: string
  readonly registration: TTYWorkerRegistration
  readonly requiredCapability?: TTYWorkerCapability
  readonly heartbeatIntervalMs?: number
  readonly now?: () => Date
  readonly setInterval?: (handler: () => void, timeoutMs: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly signals?: TTYWorkerDaemonSignalSource
  readonly logger?: TTYWorkerDaemonLogger
}

const defaultLogger: TTYWorkerDaemonLogger = {
  info: (event, fields) => console.info(JSON.stringify({ component: 'tty-worker-daemon', level: 'info', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ component: 'tty-worker-daemon', level: 'warn', event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ component: 'tty-worker-daemon', level: 'error', event, ...fields }))
}

function defaultSignals(): TTYWorkerDaemonSignalSource {
  return process
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Unknown worker daemon failure.'
}

function validHeartbeatInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

class TTYWorkerDaemonStartupCancelled extends Error {
  constructor() {
    super('TTY worker daemon startup was cancelled.')
    this.name = 'TTYWorkerDaemonStartupCancelled'
  }
}

export class TTYWorkerDaemon {
  private readonly workerId: TTYWorkerId
  private readonly now: () => Date
  private readonly intervalMs: number
  private readonly setTimer: (handler: () => void, timeoutMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly signals: TTYWorkerDaemonSignalSource
  private readonly logger: TTYWorkerDaemonLogger
  private state: TTYWorkerDaemonState = 'stopped'
  private authenticated = false
  private heartbeatSequence = 0
  private startedAt: string | null = null
  private lastHeartbeatAt: string | null = null
  private lastError: string | null = null
  private heartbeatTimer: unknown = null
  private heartbeatInFlight = false
  private startPromise: Promise<TTYWorkerDaemonStatus> | null = null
  private stopPromise: Promise<TTYWorkerDaemonStatus> | null = null
  private startupCancelled = false
  private readonly signalHandlers = new Map<'SIGINT' | 'SIGTERM', () => void>()

  constructor(private readonly dependencies: TTYWorkerDaemonDependencies) {
    this.workerId = dependencies.registration.workerId
    this.now = dependencies.now ?? (() => new Date())
    this.intervalMs = dependencies.heartbeatIntervalMs ?? TTY_WORKER_DAEMON_HEARTBEAT_INTERVAL_MS
    if (!validHeartbeatInterval(this.intervalMs)) throw new Error('Invalid TTY worker daemon heartbeat interval.')
    this.setTimer = dependencies.setInterval ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs))
    this.clearTimer = dependencies.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
    this.signals = dependencies.signals ?? defaultSignals()
    this.logger = dependencies.logger ?? defaultLogger
  }

  async start(): Promise<TTYWorkerDaemonStatus> {
    if (this.state === 'running') return this.getStatus()
    if (this.state === 'starting' && this.startPromise !== null) return this.startPromise
    if (this.state === 'stopping' && this.stopPromise !== null) await this.stopPromise

    this.state = 'starting'
    this.startupCancelled = false
    this.lastError = null
    this.startPromise = this.startInternal()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async stop(reason: 'manual' | 'SIGINT' | 'SIGTERM' = 'manual'): Promise<TTYWorkerDaemonStatus> {
    if (this.state === 'stopped') return this.getStatus()
    if (this.state === 'starting' && this.startPromise !== null) {
      this.startupCancelled = true
      await this.startPromise
      return this.getStatus()
    }
    if (this.state === 'stopping' && this.stopPromise !== null) return this.stopPromise

    this.state = 'stopping'
    this.stopPromise = this.stopInternal(reason)
    try {
      return await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  getStatus(): TTYWorkerDaemonStatus {
    return Object.freeze({
      state: this.state,
      workerId: this.workerId,
      authenticated: this.authenticated,
      heartbeatSequence: this.heartbeatSequence,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError
    })
  }

  private async startInternal(): Promise<TTYWorkerDaemonStatus> {
    this.logger.info('daemon_starting', { workerId: this.workerId, heartbeatIntervalMs: this.intervalMs })
    try {
      const registration = await this.dependencies.registry.registerWorker(this.dependencies.registration)
      this.assertStartupActive()
      if (!registration.registered) throw new Error(`Worker registration failed: ${registration.reason}`)
      this.logger.info('worker_registered', { workerId: this.workerId })

      const authentication = await this.dependencies.authenticator.authenticateWorker(this.dependencies.token, this.dependencies.requiredCapability)
      this.assertStartupActive()
      if (!authentication.authenticated) throw new Error(`Worker authentication failed: ${authentication.reason}`)
      this.authenticated = true
      this.logger.info('worker_authenticated', this.authenticationFields(authentication.context))

      const heartbeat = await this.recordHeartbeat()
      this.assertStartupActive()
      if (!heartbeat.recorded) throw new Error(`Initial worker heartbeat failed: ${heartbeat.reason}`)

      this.attachSignalHandlers()
      this.heartbeatTimer = this.setTimer(() => { void this.heartbeatTick() }, this.intervalMs)
      this.startedAt = this.now().toISOString()
      this.state = 'running'
      this.logger.info('daemon_started', { workerId: this.workerId, startedAt: this.startedAt })
      return this.getStatus()
    } catch (error) {
      this.clearHeartbeatResources()
      this.authenticated = false
      if (error instanceof TTYWorkerDaemonStartupCancelled) {
        this.state = 'stopped'
        this.lastError = null
        this.logger.info('daemon_start_cancelled', { workerId: this.workerId })
        return this.getStatus()
      }
      this.state = 'failed'
      this.lastError = errorMessage(error)
      this.logger.error('daemon_start_failed', { workerId: this.workerId, error: this.lastError })
      throw error
    }
  }

  private async stopInternal(reason: 'manual' | 'SIGINT' | 'SIGTERM'): Promise<TTYWorkerDaemonStatus> {
    this.clearHeartbeatResources()
    this.authenticated = false
    this.state = 'stopped'
    this.logger.info('daemon_stopped', { workerId: this.workerId, reason, heartbeatSequence: this.heartbeatSequence })
    return this.getStatus()
  }

  private async heartbeatTick(): Promise<void> {
    if (this.state !== 'running' || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      await this.recordHeartbeat()
    } finally {
      this.heartbeatInFlight = false
    }
  }

  private async recordHeartbeat(): Promise<TTYWorkerHeartbeatResult> {
    const sequence = this.heartbeatSequence + 1
    const result = await this.dependencies.heartbeat.recordHeartbeat({
      workerId: this.workerId,
      sequence,
      sentAt: this.now().toISOString()
    })
    if (result.recorded) {
      this.heartbeatSequence = result.heartbeat.sequence
      this.lastHeartbeatAt = result.heartbeat.receivedAt
      this.lastError = null
      this.logger.info('heartbeat_recorded', {
        workerId: this.workerId,
        sequence: result.heartbeat.sequence,
        latencyMs: result.heartbeat.latencyMs
      })
    } else {
      this.lastError = `heartbeat_${result.reason}`
      this.logger.warn('heartbeat_failed', { workerId: this.workerId, sequence, reason: result.reason })
    }
    return result
  }

  private authenticationFields(context: TTYWorkerAuthContext): Readonly<Record<string, unknown>> {
    return { workerId: this.workerId, capability: context.capability, expiresAt: context.expiresAt }
  }

  private assertStartupActive(): void {
    if (this.startupCancelled) throw new TTYWorkerDaemonStartupCancelled()
  }

  private attachSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => { void this.stop(signal) }
      this.signalHandlers.set(signal, handler)
      this.signals.on(signal, handler)
    }
  }

  private clearHeartbeatResources(): void {
    if (this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const [signal, handler] of this.signalHandlers) {
      this.signals.removeListener(signal, handler)
      this.signalHandlers.delete(signal)
    }
  }
}

export function createTTYWorkerDaemon(dependencies: TTYWorkerDaemonDependencies): TTYWorkerDaemon {
  return new TTYWorkerDaemon(dependencies)
}
