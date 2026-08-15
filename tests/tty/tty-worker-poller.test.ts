import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPendingExecutionQueue,
  TTYWorkerPoller,
  type PendingExecutionQueue,
  type TTYWorkerPollerLogger,
} from '../../lib/tty/tty-worker-poller'

type QueueResponse = readonly string[] | Error | Promise<readonly string[]>

class QueueHarness implements PendingExecutionQueue {
  calls = 0
  limits: number[] = []

  constructor(private readonly responses: QueueResponse[]) {}

  async listPendingExecutionIds(limit: number): Promise<readonly string[]> {
    this.calls += 1
    this.limits.push(limit)
    const response = this.responses[Math.min(this.calls - 1, this.responses.length - 1)] ?? []
    if (response instanceof Error) throw response
    return await response
  }
}

class RealtimeQueueHarness extends QueueHarness {
  subscribed = false

  async subscribe(
    onPendingExecutionIds: (executionIds: readonly string[]) => Promise<void> | void,
  ): Promise<() => void> {
    void onPendingExecutionIds
    this.subscribed = true
    return () => undefined
  }
}

class ManualTimer {
  private nextHandle = 1
  private readonly entries = new Map<number, { readonly callback: () => void; readonly delayMs: number }>()

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++
    this.entries.set(handle, { callback, delayMs })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.entries.delete(handle as number)
  }

  get count(): number {
    return this.entries.size
  }

  get nextDelayMs(): number | null {
    return this.entries.values().next().value?.delayMs ?? null
  }

  async fireNext(): Promise<void> {
    const first = this.entries.entries().next().value as
      | [number, { readonly callback: () => void; readonly delayMs: number }]
      | undefined
    if (first === undefined) throw new Error('No scheduled timer.')
    this.entries.delete(first[0])
    first[1].callback()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

class CaptureLogger implements TTYWorkerPollerLogger {
  readonly entries: Array<{
    readonly level: string
    readonly message: string
    readonly fields: Readonly<Record<string, unknown>> | undefined
  }> = []

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', message, fields })
  }
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', message, fields })
  }
  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'error', message, fields })
  }
}

function createPoller(
  queue: PendingExecutionQueue,
  timer: ManualTimer,
  logger: CaptureLogger,
  options: { readonly random?: () => number; readonly jitterMs?: number } = {},
): TTYWorkerPoller {
  return new TTYWorkerPoller({
    queue,
    baseIntervalMs: 1_000,
    maxIntervalMs: 15_000,
    jitterMs: options.jitterMs ?? 0,
    batchSize: 8,
    now: () => new Date('2026-08-09T00:00:00.000Z'),
    random: options.random ?? (() => 0),
    setTimeout: (callback, delayMs) => timer.setTimeout(callback, delayMs),
    clearTimeout: (handle) => timer.clearTimeout(handle),
    logger,
  })
}

test('in-memory queue adapter returns only bounded pending execution IDs', async () => {
  const queue = new InMemoryPendingExecutionQueue()
  queue.enqueueMany(['execution-a', 'execution-b', 'execution-c'])
  queue.enqueue('execution-a')

  assert.deepEqual(await queue.listPendingExecutionIds(2), ['execution-a', 'execution-b'])
  queue.remove('execution-a')
  assert.deepEqual(await queue.listPendingExecutionIds(2), ['execution-b', 'execution-c'])
})

test('performs an immediate poll and schedules the configured base interval', async () => {
  const queue = new QueueHarness([[]])
  const timer = new ManualTimer()
  const logger = new CaptureLogger()
  const poller = createPoller(queue, timer, logger)

  const status = await poller.startPolling()

  assert.equal(queue.calls, 1)
  assert.deepEqual(queue.limits, [8])
  assert.equal(status.running, true)
  assert.equal(status.pollsPerformed, 1)
  assert.equal(status.currentIntervalMs, 1_000)
  assert.equal(timer.nextDelayMs, 1_000)
  assert.ok(logger.entries.some((entry) => entry.message === 'poll_started'))
  assert.ok(
    logger.entries.some((entry) => entry.message === 'pending_execution_count' && entry.fields?.pendingCount === 0),
  )
  await poller.stopPolling()
})

test('keeps bounded reconciliation polling when realtime wake-ups are active', async () => {
  const queue = new RealtimeQueueHarness([[], []])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())

  await poller.startPolling()

  assert.equal(queue.subscribed, true)
  assert.equal(timer.nextDelayMs, 1_000)
  await timer.fireNext()
  assert.equal(queue.calls, 2)
  await poller.stopPolling()
})

test('applies exponential idle backoff and caps at fifteen seconds', async () => {
  const queue = new QueueHarness([[], [], [], [], [], []])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())
  await poller.startPolling()

  const intervals = [poller.getStatus().currentIntervalMs]
  for (let index = 0; index < 4; index += 1) {
    await timer.fireNext()
    intervals.push(poller.getStatus().currentIntervalMs)
  }

  assert.deepEqual(intervals, [1_000, 2_000, 4_000, 8_000, 15_000])
  assert.equal(timer.nextDelayMs, 15_000)
  await poller.stopPolling()
})

test('resets backoff immediately when pending work is observed', async () => {
  const queue = new QueueHarness([[], [], ['execution-1']])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())
  await poller.startPolling()
  await timer.fireNext()
  await timer.fireNext()

  const status = poller.getStatus()
  assert.equal(status.lastPendingCount, 1)
  assert.equal(status.executionsObserved, 1)
  assert.equal(status.consecutiveIdlePolls, 0)
  assert.equal(status.currentIntervalMs, 1_000)
  assert.equal(timer.nextDelayMs, 1_000)
  await poller.stopPolling()
})

test('adds jitter within the configured zero-to-five-hundred millisecond bounds', async () => {
  const queue = new QueueHarness([[], ['execution-jitter-check']])
  const timer = new ManualTimer()
  const randomValues = [0, 1]
  const poller = createPoller(queue, timer, new CaptureLogger(), {
    jitterMs: 500,
    random: () => randomValues.shift() ?? 0,
  })

  await poller.startPolling()
  assert.equal(timer.nextDelayMs, 1_000)
  await timer.fireNext()
  assert.equal(timer.nextDelayMs, 1_500)
  await poller.stopPolling()
})

test('concurrent starts share one immediate poll and one scheduled loop', async () => {
  let release!: (ids: readonly string[]) => void
  const gate = new Promise<readonly string[]>((resolve) => {
    release = resolve
  })
  const queue = new QueueHarness([gate])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())

  const first = poller.startPolling()
  const second = poller.startPolling()
  assert.equal(queue.calls, 1)
  release([])
  await Promise.all([first, second])

  assert.equal(queue.calls, 1)
  assert.equal(timer.count, 1)
  await poller.stopPolling()
})

test('shutdown during an active poll waits for it and leaves no timer behind', async () => {
  let release!: (ids: readonly string[]) => void
  const gate = new Promise<readonly string[]>((resolve) => {
    release = resolve
  })
  const queue = new QueueHarness([gate])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())
  const starting = poller.startPolling()
  await Promise.resolve()

  const stopping = poller.stopPolling()
  assert.equal(poller.getStatus().running, false)
  assert.equal(poller.getStatus().state, 'stopping')
  release([])
  await Promise.all([starting, stopping])

  assert.equal(poller.getStatus().state, 'stopped')
  assert.equal(timer.count, 0)
})

test('stopPolling is idempotent and logs one shutdown', async () => {
  const queue = new QueueHarness([[]])
  const timer = new ManualTimer()
  const logger = new CaptureLogger()
  const poller = createPoller(queue, timer, logger)
  await poller.startPolling()

  const first = poller.stopPolling()
  const second = poller.stopPolling()
  await Promise.all([first, second])

  assert.equal(poller.getStatus().running, false)
  assert.equal(logger.entries.filter((entry) => entry.message === 'polling_shutdown').length, 1)
  assert.deepEqual(await poller.stopPolling(), poller.getStatus())
})

test('updates polling metrics without exposing queue payloads', async () => {
  const queue = new QueueHarness([['execution-a', 'execution-b']])
  const timer = new ManualTimer()
  const logger = new CaptureLogger()
  const poller = createPoller(queue, timer, logger)
  await poller.startPolling()

  const status = poller.getStatus()
  assert.equal(status.pollsPerformed, 1)
  assert.equal(status.executionsObserved, 2)
  assert.equal(status.lastPendingCount, 2)
  assert.equal(typeof status.lastPollAt, 'string')
  assert.equal(
    logger.entries.some((entry) => JSON.stringify(entry.fields).includes('execution-a')),
    false,
  )
  await poller.stopPolling()
})

test('polling errors back off and recover on a later poll', async () => {
  const queue = new QueueHarness([new Error('temporary queue outage'), ['execution-recovered']])
  const timer = new ManualTimer()
  const logger = new CaptureLogger()
  const poller = createPoller(queue, timer, logger)
  await poller.startPolling()

  assert.equal(poller.getStatus().lastError, 'temporary queue outage')
  assert.equal(poller.getStatus().currentIntervalMs, 1_000)
  await timer.fireNext()

  assert.equal(poller.getStatus().lastError, null)
  assert.equal(poller.getStatus().executionsObserved, 1)
  assert.ok(logger.entries.some((entry) => entry.message === 'polling_error'))
  await poller.stopPolling()
})

test('can restart after stopping and performs another immediate poll', async () => {
  const queue = new QueueHarness([[], []])
  const timer = new ManualTimer()
  const poller = createPoller(queue, timer, new CaptureLogger())
  await poller.startPolling()
  await poller.stopPolling()

  const restarted = await poller.startPolling()
  assert.equal(restarted.running, true)
  assert.equal(queue.calls, 2)
  assert.equal(restarted.pollsPerformed, 2)
  await poller.stopPolling()
})
