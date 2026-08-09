import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TTY_WORKER_DAEMON_HEARTBEAT_INTERVAL_MS,
  TTYWorkerDaemon,
  type TTYWorkerDaemonLogger,
  type TTYWorkerDaemonSignalSource
} from '../../lib/tty/tty-worker-daemon'
import type { TTYWorkerHeartbeatResult } from '../../lib/tty/tty-worker-heartbeat'
import { createTTYWorkerId, type TTYWorkerAuthContext, type TTYWorkerCapability, type TTYWorkerRegistration } from '../../lib/tty/tty-worker-types'

const workerId = createTTYWorkerId('daemon-test-worker')
const registration: TTYWorkerRegistration = {
  workerId,
  identity: 'daemon-test-host',
  version: '1.0.0',
  capabilities: ['claim_lease', 'renew_lease', 'execute']
}

class ManualTimer {
  callback: (() => void) | null = null
  delayMs: number | null = null
  cleared = false
  private readonly handle = {}

  setInterval(callback: () => void, delayMs: number): unknown {
    this.callback = callback
    this.delayMs = delayMs
    this.cleared = false
    return this.handle
  }

  clearInterval(handle: unknown): void {
    if (handle === this.handle) this.cleared = true
  }

  async tick(): Promise<void> {
    this.callback?.()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

class SignalHarness implements TTYWorkerDaemonSignalSource {
  private readonly listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>()

  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(signal, listeners)
  }

  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(signal)?.delete(listener)
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of this.listeners.get(signal) ?? []) listener()
  }

  count(signal: 'SIGINT' | 'SIGTERM'): number {
    return this.listeners.get(signal)?.size ?? 0
  }
}

class CaptureLogger implements TTYWorkerDaemonLogger {
  readonly entries: Array<{ readonly level: string; readonly event: string; readonly fields: Readonly<Record<string, unknown>> | undefined }> = []

  info(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'info', event, fields }) }
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'warn', event, fields }) }
  error(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'error', event, fields }) }
}

function successfulHeartbeat(sequence: number, now: string): TTYWorkerHeartbeatResult {
  return {
    recorded: true,
    heartbeat: { workerId, sequence, sentAt: now, receivedAt: now, receivedAtMs: Date.parse(now), latencyMs: 0 },
    health: { workerId, state: 'online', lastHeartbeatAt: now, heartbeatLatencyMs: 0, missedIntervals: 0, healthScore: 100, checkedAt: now }
  }
}

function createHarness(options: {
  readonly authenticate?: () => Promise<{ readonly authenticated: false; readonly reason: 'invalid_token' } | { readonly authenticated: true; readonly context: TTYWorkerAuthContext }>
  readonly heartbeat?: (sequence: number, now: string) => Promise<TTYWorkerHeartbeatResult>
  readonly recovery?: { readonly start: () => Promise<unknown>; readonly stop: () => Promise<unknown> }
} = {}) {
  const events: string[] = []
  const timer = new ManualTimer()
  const signals = new SignalHarness()
  const logger = new CaptureLogger()
  let nowMs = 1_700_000_000_000
  let heartbeatCalls = 0
  const authContext: TTYWorkerAuthContext = {
    workerId,
    capability: 'execute',
    tokenId: 'daemon-test-token-id',
    authenticatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 60_000).toISOString()
  }
  const daemon = new TTYWorkerDaemon({
    registration,
    token: 'opaque-signed-token',
    registry: {
      registerWorker: async () => {
        events.push('register')
        return { registered: true, worker: {} as never }
      }
    },
    authenticator: {
      authenticateWorker: async (_token: string, _requiredCapability?: TTYWorkerCapability) => {
        events.push('authenticate')
        return options.authenticate?.() ?? { authenticated: true, context: authContext }
      }
    },
    heartbeat: {
      recordHeartbeat: async input => {
        heartbeatCalls += 1
        events.push(`heartbeat:${input.sequence}`)
        const sentAt = new Date(nowMs).toISOString()
        return options.heartbeat?.(input.sequence, sentAt) ?? successfulHeartbeat(input.sequence, sentAt)
      }
    },
    recovery: options.recovery,
    now: () => new Date(nowMs),
    setInterval: (callback, delayMs) => timer.setInterval(callback, delayMs),
    clearInterval: handle => timer.clearInterval(handle),
    signals,
    logger
  })
  return { daemon, events, timer, signals, logger, getHeartbeatCalls: () => heartbeatCalls }
}

test('starts by registering, authenticating, and heartbeating without executing jobs', async () => {
  const harness = createHarness()
  const status = await harness.daemon.start()

  assert.equal(status.state, 'running')
  assert.equal(status.authenticated, true)
  assert.equal(status.heartbeatSequence, 1)
  assert.equal(harness.timer.delayMs, TTY_WORKER_DAEMON_HEARTBEAT_INTERVAL_MS)
  assert.deepEqual(harness.events, ['register', 'authenticate', 'heartbeat:1'])
  assert.equal(harness.signals.count('SIGINT'), 1)
  assert.equal(harness.signals.count('SIGTERM'), 1)

  await harness.timer.tick()
  assert.equal(harness.daemon.getStatus().heartbeatSequence, 2)
  assert.equal(harness.getHeartbeatCalls(), 2)
  assert.ok(harness.logger.entries.some(entry => entry.event === 'daemon_started'))

  await harness.daemon.stop()
})

test('recovery completes its restart scan before readiness and stops with the daemon', async () => {
  const lifecycle: string[] = []
  const harness = createHarness({
    recovery: {
      start: async () => { lifecycle.push('start') },
      stop: async () => { lifecycle.push('stop') }
    }
  })

  const status = await harness.daemon.start()
  assert.equal(status.state, 'running')
  assert.deepEqual(lifecycle, ['start'])
  assert.deepEqual(harness.events, ['register', 'authenticate', 'heartbeat:1'])

  await harness.daemon.stop()
  assert.deepEqual(lifecycle, ['start', 'stop'])
})

test('SIGTERM performs graceful shutdown and removes heartbeat resources', async () => {
  const harness = createHarness()
  await harness.daemon.start()

  harness.signals.emit('SIGTERM')
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.equal(harness.daemon.getStatus().state, 'stopped')
  assert.equal(harness.daemon.getStatus().authenticated, false)
  assert.equal(harness.timer.cleared, true)
  assert.equal(harness.signals.count('SIGINT'), 0)
  assert.equal(harness.signals.count('SIGTERM'), 0)
  assert.ok(harness.logger.entries.some(entry => entry.event === 'daemon_stopped' && entry.fields?.reason === 'SIGTERM'))
})

test('startup authentication failure fails closed without starting timers or signal handlers', async () => {
  const harness = createHarness({ authenticate: async () => ({ authenticated: false, reason: 'invalid_token' }) })

  await assert.rejects(harness.daemon.start(), /Worker authentication failed: invalid_token/)
  assert.equal(harness.daemon.getStatus().state, 'failed')
  assert.equal(harness.daemon.getStatus().authenticated, false)
  assert.equal(harness.getHeartbeatCalls(), 0)
  assert.equal(harness.timer.delayMs, null)
  assert.equal(harness.signals.count('SIGINT'), 0)
  assert.equal(harness.signals.count('SIGTERM'), 0)
  assert.ok(harness.logger.entries.some(entry => entry.event === 'daemon_start_failed'))
})

test('transient heartbeat failures are observable while the daemon remains available to stop cleanly', async () => {
  const harness = createHarness({
    heartbeat: async (sequence, now) => sequence === 1
      ? successfulHeartbeat(sequence, now)
      : { recorded: false, reason: 'internal_error' }
  })
  await harness.daemon.start()
  await harness.timer.tick()

  assert.equal(harness.daemon.getStatus().state, 'running')
  assert.equal(harness.daemon.getStatus().lastError, 'heartbeat_internal_error')
  assert.ok(harness.logger.entries.some(entry => entry.event === 'heartbeat_failed'))
  await harness.daemon.stop()
  assert.equal(harness.timer.cleared, true)
})

test('shutdown requested during startup cancels startup instead of resurrecting the daemon', async () => {
  const timer = new ManualTimer()
  const signals = new SignalHarness()
  const logger = new CaptureLogger()
  let releaseRegistration!: (result: { readonly registered: true; readonly worker: never }) => void
  const registrationGate = new Promise<{ readonly registered: true; readonly worker: never }>(resolve => { releaseRegistration = resolve })
  let authenticated = false
  const daemon = new TTYWorkerDaemon({
    registration,
    token: 'opaque-signed-token',
    registry: { registerWorker: async () => registrationGate },
    authenticator: {
      authenticateWorker: async () => {
        authenticated = true
        return { authenticated: true, context: { workerId, capability: 'execute', tokenId: 'token', authenticatedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString() } }
      }
    },
    heartbeat: { recordHeartbeat: async input => successfulHeartbeat(input.sequence, input.sentAt) },
    now: () => new Date(1_700_000_000_000),
    setInterval: (callback, delayMs) => timer.setInterval(callback, delayMs),
    clearInterval: handle => timer.clearInterval(handle),
    signals,
    logger
  })

  const starting = daemon.start()
  await Promise.resolve()
  const stopping = daemon.stop('manual')
  releaseRegistration({ registered: true, worker: {} as never })

  assert.equal((await starting).state, 'stopped')
  assert.equal((await stopping).state, 'stopped')
  assert.equal(authenticated, false)
  assert.equal(timer.delayMs, null)
  assert.ok(logger.entries.some(entry => entry.event === 'daemon_start_cancelled'))
})
