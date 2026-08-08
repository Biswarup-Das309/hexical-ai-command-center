import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { TTYProcessRuntime } from '../../lib/tty/tty-process-runtime'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const executionId = '00000000-0000-4000-8000-000000000201' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000202' as TTYSessionId
const workerId = 'worker-process-test' as TTYWorkerId
let rootSequence = 0

function testRoot(name: string): string {
  rootSequence += 1
  return join(process.cwd(), `.tmp-tty-runtime-${name}-${process.pid}-${rootSequence}`)
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('runtime spawns argv without a shell, isolates cwd, and does not inherit environment', async () => {
  const runtime = new TTYProcessRuntime({ rootDir: testRoot('process') })
  const inheritedKey = `HEXICAL_TTY_INHERITED_${Date.now()}`
  const previous = process.env[inheritedKey]
  process.env[inheritedKey] = 'must-not-cross-boundary'

  try {
    const handle = await runtime.start({
      executionId,
      sessionId,
      workerId,
      file: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), inherited: process.env[process.argv[1]], argv: process.argv.slice(2) }))', inheritedKey, 'literal;not-shell-code'],
      env: {}
    })
    const [stdout, stderr, exit] = await Promise.all([readStream(handle.stdout), readStream(handle.stderr), handle.exit])
    const parsed = JSON.parse(stdout) as { cwd: string; inherited?: string; argv: string[] }

    assert.equal(exit.code, 0)
    assert.equal(stderr, '')
    assert.equal(parsed.inherited, undefined)
    assert.equal(parsed.argv[0], 'literal;not-shell-code')
    assert.notEqual(parsed.cwd, process.cwd())
    assert.equal(parsed.cwd.startsWith(runtime.rootDir), true)

    await runtime.cleanup(handle)
    assert.deepEqual(await readdir(runtime.rootDir), [])
  } finally {
    if (previous === undefined) delete process.env[inheritedKey]
    else process.env[inheritedKey] = previous
  }
})

test('runtime preserves stdout and stderr as separate streams', async () => {
  const runtime = new TTYProcessRuntime({ rootDir: testRoot('streams') })
  const handle = await runtime.start({
    executionId,
    sessionId,
    workerId,
    file: process.execPath,
    args: ['-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n')"]
  })
  const [stdout, stderr, exit] = await Promise.all([readStream(handle.stdout), readStream(handle.stderr), handle.exit])

  assert.equal(exit.code, 0)
  assert.equal(stdout, 'out\n')
  assert.equal(stderr, 'err\n')
  await runtime.cleanup(handle)
})

test('runtime stop terminates the process group and cleanup removes its private directory', async () => {
  const runtime = new TTYProcessRuntime({ rootDir: testRoot('stop'), killGraceMs: 200 })
  const handle = await runtime.start({
    executionId,
    sessionId,
    workerId,
    file: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)']
  })

  await runtime.stop(handle)
  const exit = await handle.exit
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === null || exit.code !== 0)
  await runtime.cleanup(handle)
  assert.deepEqual(await readdir(runtime.rootDir), [])
})

test('runtime rejects NUL bytes and unknown handles before any signal or cleanup operation', async () => {
  const runtime = new TTYProcessRuntime({ rootDir: testRoot('validation') })
  await assert.rejects(
    runtime.start({ executionId, sessionId, workerId, file: process.execPath, args: ['-e\u0000'] }),
    /Invalid process argument/
  )
  const fake = {
    handleId: 'not-owned',
    pid: 999_999,
    startedAt: new Date().toISOString(),
    executionId,
    sessionId,
    workerId,
    stdout: ReadableStream.prototype,
    stderr: ReadableStream.prototype,
    exit: Promise.resolve({ code: null, signal: null })
  } as never
  await assert.rejects(runtime.cleanup(fake), /Unknown TTY process handle/)
})
