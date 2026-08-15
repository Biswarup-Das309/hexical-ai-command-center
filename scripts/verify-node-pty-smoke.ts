import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodePtyFactory,
  TTYPersistentRuntime,
  type TTYPersistentSessionHandle,
} from '../lib/tty/tty-persistent-runtime'
import { createTTYSessionId } from '../lib/tty/tty-types'
import { createTTYWorkerId } from '../lib/tty/tty-worker-types'

const TEST_MARKER = 'HEXICAL_RUNTIME_OS_TEST'
const ENV_MARKER = 'HEXICAL_RUNTIME_OS_ENV=preserved'
const LONG_RUNNING_MARKER = 'HEXICAL_RUNTIME_OS_LONG_RUNNING_DONE'
const WAIT_TIMEOUT_MS = 15_000

function minimalEnvironment(): Readonly<Record<string, string>> {
  if (process.platform !== 'win32') {
    return {
      // WSL can inject a very long Windows PATH into the Linux process. Keep
      // the smoke environment bounded and representative of the worker's
      // approved Linux executable path instead of inheriting host state.
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: 'xterm-256color',
    }
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return {
    ComSpec: process.env.ComSpec ?? join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [join(systemRoot, 'System32'), systemRoot].join(';'),
    SystemRoot: systemRoot,
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  }
}

async function waitForOutput(getOutput: () => string, marker: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!getOutput().includes(marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for PTY output marker: ${marker}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

function cwdValues(output: string): string[] {
  return [...output.matchAll(/HEXICAL_RUNTIME_OS_CWD=([^\r\n]+)/g)]
    .map((match) => stripTerminalControls(match[1]).trim())
    .filter((value) => value.length > 0 && value !== '%CD%')
}

function stripTerminalControls(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== '[') {
      result += value[index]
      continue
    }
    index += 2
    while (index < value.length) {
      const code = value.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) break
      index += 1
    }
  }
  return result
}

async function waitForTwoCwdValues(getOutput: () => string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (cwdValues(getOutput()).length < 2) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for two expanded PTY cwd values')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'hexical-node-pty-smoke-'))
  const sessionId = createTTYSessionId()
  const ownerUserId = 'local-node-pty-smoke'
  const workerId = createTTYWorkerId(`local-node-pty-smoke-${randomUUID()}`)
  let runtime: TTYPersistentRuntime | undefined
  let session: TTYPersistentSessionHandle | undefined
  let output = ''
  let exitCode: number | undefined

  try {
    const factory = await createNodePtyFactory()
    runtime = new TTYPersistentRuntime(factory, {
      rootDir,
      baseEnv: minimalEnvironment(),
      defaultColumns: 120,
      defaultRows: 32,
      terminationWaitMs: 10_000,
      useConpty: process.platform === 'win32' ? false : undefined,
    })
    session = await runtime.createSession({
      sessionId,
      ownerUserId,
      workerId,
      onData: (data) => {
        output += data
      },
      onExit: (event) => {
        exitCode = event.exitCode
      },
    })

    session.resize(140, 40)
    assert.deepEqual({ columns: session.metadata.columns, rows: session.metadata.rows }, { columns: 140, rows: 40 })

    const command = process.platform === 'win32' ? (value: string) => `${value}\r\n` : (value: string) => `${value}\n`
    const write = (value: string) => session?.write(command(value))

    if (process.platform === 'win32') {
      write('set HEXICAL_RUNTIME_OS_ENV=preserved')
      write('echo HEXICAL_RUNTIME_OS_ENV=%HEXICAL_RUNTIME_OS_ENV%')
      await waitForOutput(() => output, ENV_MARKER)
      write(`echo ${TEST_MARKER}`)
      await waitForOutput(() => output, TEST_MARKER)
      write('echo HEXICAL_RUNTIME_OS_CWD=%CD%')
      write('echo HEXICAL_RUNTIME_OS_CWD=%CD%')
      await waitForTwoCwdValues(() => output)
      write('ping -n 2 127.0.0.1 >NUL & echo HEXICAL_RUNTIME_OS_LONG_RUNNING_DONE')
    } else {
      write('export HEXICAL_RUNTIME_OS_ENV=preserved')
      write('printf "HEXICAL_RUNTIME_OS_ENV=%s\\n" "$HEXICAL_RUNTIME_OS_ENV"')
      await waitForOutput(() => output, ENV_MARKER)
      write(`printf "${TEST_MARKER}\\n"`)
      await waitForOutput(() => output, TEST_MARKER)
      write('printf "HEXICAL_RUNTIME_OS_CWD=%s\\n" "$PWD"')
      write('printf "HEXICAL_RUNTIME_OS_CWD=%s\\n" "$PWD"')
      await waitForTwoCwdValues(() => output)
      write('sleep 1; printf "HEXICAL_RUNTIME_OS_LONG_RUNNING_DONE\\n"')
    }
    await waitForOutput(() => output, LONG_RUNNING_MARKER)

    const pid = session.metadata.pid
    const cwdMatches = cwdValues(output)
    assert.ok(cwdMatches.length >= 2, 'PTY did not report cwd twice')
    assert.equal(cwdMatches[0], cwdMatches[1], 'PTY cwd changed between commands')

    const exitPromise = new Promise<number>((resolve) => {
      session?.onExit((event) => resolve(event.exitCode))
    })
    write('exit')
    exitCode = await Promise.race([
      exitPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for PTY exit')), WAIT_TIMEOUT_MS),
      ),
    ])
    await session.terminate()
    session = undefined

    assert.equal(runtime.listSessions(ownerUserId).length, 0, 'PTY session remained registered after cleanup')
    assert.equal(exitCode, 0, 'PTY shell exited unsuccessfully')
    assert.ok(output.includes(ENV_MARKER), 'environment continuity marker missing')
    assert.ok(output.includes(TEST_MARKER), 'terminal output marker missing')
    assert.ok(output.includes(LONG_RUNNING_MARKER), 'long-running command marker missing')

    console.log(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        nodePty: '1.1.0',
        sessionId,
        pid,
        resized: { columns: 140, rows: 40 },
        exitCode,
        outputBytes: Buffer.byteLength(output, 'utf8'),
        continuity: ['node-pty-spawn', 'environment', 'cwd', 'long_running', 'resize', 'exit', 'cleanup'],
      }),
    )
  } finally {
    if (session && runtime) {
      await runtime.terminateSession(sessionId, ownerUserId).catch(() => undefined)
    }
    await rm(rootDir, { recursive: true, force: true })
  }
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    // node-pty may retain a native event-loop handle briefly after a clean shell exit.
    // The smoke has already completed all assertions and cleanup before this boundary.
    setTimeout(() => process.exit(process.exitCode ?? 0), 0)
  })
