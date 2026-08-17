import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTTYInputQueue } from '../lib/tty/tty-input-queue'
import { summarizeTTYLatencies } from '../lib/tty/tty-latency'
import {
  createNodePtyFactory,
  TTYPersistentRuntime,
  type TTYPersistentSessionHandle,
} from '../lib/tty/tty-persistent-runtime'
import { createTTYSessionId } from '../lib/tty/tty-types'
import { createTTYWorkerId } from '../lib/tty/tty-worker-types'

const SAMPLE_COUNT = 100
const WAIT_TIMEOUT_MS = 2_000

function environment(): Readonly<Record<string, string>> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    return {
      ComSpec: process.env.ComSpec ?? join(systemRoot, 'System32', 'cmd.exe'),
      PATH: [join(systemRoot, 'System32'), systemRoot].join(';'),
      SystemRoot: systemRoot,
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
    }
  }
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color' }
}

async function inputBenchmark(): Promise<{
  readonly singleKey: ReturnType<typeof summarizeTTYLatencies>
  readonly rapidTyping: ReturnType<typeof summarizeTTYLatencies>
  readonly paste: ReturnType<typeof summarizeTTYLatencies>
  readonly burstBatchCount: number
}> {
  const singleKey: number[] = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    let queueWait = 0
    const queue = createTTYInputQueue(async (_data, batch) => {
      queueWait = batch.queueWaitMs
    })
    await queue.enqueue('x')
    singleKey.push(queueWait)
  }

  const rapidTyping: number[] = []
  let burstBatchCount = 0
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const queue = createTTYInputQueue(async (_data, batch) => {
      rapidTyping.push(batch.queueWaitMs)
      burstBatchCount += 1
    })
    await Promise.all([...Array(10)].map(() => queue.enqueue('x')))
  }

  const paste: number[] = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    let queueWait = 0
    const queue = createTTYInputQueue(async (_data, batch) => {
      queueWait = batch.queueWaitMs
    })
    await queue.enqueue('x'.repeat(100))
    paste.push(queueWait)
  }

  return {
    singleKey: summarizeTTYLatencies(singleKey),
    rapidTyping: summarizeTTYLatencies(rapidTyping),
    paste: summarizeTTYLatencies(paste),
    burstBatchCount,
  }
}

async function ptyBenchmark(): Promise<ReturnType<typeof summarizeTTYLatencies>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'hexical-runtime-latency-'))
  const sessionId = createTTYSessionId()
  const ownerUserId = 'local-latency-benchmark'
  const workerId = createTTYWorkerId(`local-latency-${process.pid}`)
  let runtime: TTYPersistentRuntime | null = null
  let session: TTYPersistentSessionHandle | null = null
  let waiting: ((durationMs: number) => void) | null = null
  const durations: number[] = []
  try {
    const factory = await createNodePtyFactory()
    runtime = new TTYPersistentRuntime(factory, {
      rootDir,
      baseEnv: environment(),
      defaultColumns: 120,
      defaultRows: 32,
      useConpty: process.platform === 'win32' ? false : undefined,
    })
    session = await runtime.createSession({
      sessionId,
      ownerUserId,
      workerId,
      onData: () => {
        const resolve = waiting
        waiting = null
        if (resolve) resolve(performance.now())
      },
    })
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const startedAt = performance.now()
      const outputAt = new Promise<number>((resolve, reject) => {
        waiting = resolve
        setTimeout(() => {
          if (waiting === resolve) waiting = null
          reject(new Error('Timed out waiting for local PTY output.'))
        }, WAIT_TIMEOUT_MS).unref?.()
      })
      session.write('x')
      durations.push((await outputAt) - startedAt)
      session.write('\u0003')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    return summarizeTTYLatencies(durations)
  } finally {
    if (session && runtime) await runtime.terminateSession(sessionId, ownerUserId).catch(() => undefined)
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const input = await inputBenchmark()
  const pty = await ptyBenchmark()
  assert.ok(input.singleKey.p95Ms < 100, `input queue p95 exceeded the legacy 100ms floor: ${input.singleKey.p95Ms}`)
  assert.equal(input.burstBatchCount, SAMPLE_COUNT)
  console.log(
    JSON.stringify(
      {
        ok: true,
        benchmark: 'runtime-os-local',
        platform: process.platform,
        input,
        ptyWriteToFirstOutput: pty,
        note: 'These are local processing measurements; browser-to-worker network latency is measured separately in production.',
      },
      null,
      2,
    ),
  )
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 0)
  })
