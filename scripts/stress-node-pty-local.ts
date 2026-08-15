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

const SESSION_COUNT = 3
const COMMAND_COUNT = 12
const WAIT_TIMEOUT_MS = 20_000

function minimalEnvironment(): Readonly<Record<string, string>> {
  if (process.platform !== 'win32') {
    return {
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

function commandLine(value: string): string {
  return `${value}${process.platform === 'win32' ? '\r\n' : '\n'}`
}

async function waitFor(getOutput: () => string, marker: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!getOutput().includes(marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for PTY marker: ${marker}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

interface StressSession {
  readonly index: number
  readonly sessionId: ReturnType<typeof createTTYSessionId>
  readonly session: TTYPersistentSessionHandle
  readonly getOutput: () => string
  readonly exit: Promise<number>
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'hexical-node-pty-stress-'))
  const ownerUserId = 'local-node-pty-stress'
  const workerId = createTTYWorkerId(`local-node-pty-stress-${randomUUID()}`)
  let runtime: TTYPersistentRuntime | undefined
  const sessions: StressSession[] = []
  let cancelledSession: TTYPersistentSessionHandle | undefined

  try {
    runtime = new TTYPersistentRuntime(await createNodePtyFactory(), {
      rootDir,
      baseEnv: minimalEnvironment(),
      defaultColumns: 120,
      defaultRows: 32,
      terminationWaitMs: 10_000,
      useConpty: process.platform === 'win32' ? false : undefined,
    })

    await Promise.all(
      Array.from({ length: SESSION_COUNT }, async (_, index) => {
        let output = ''
        let resolveExit!: (exitCode: number) => void
        const exit = new Promise<number>((resolve) => {
          resolveExit = resolve
        })
        const sessionId = createTTYSessionId()
        const session = await runtime!.createSession({
          sessionId,
          ownerUserId,
          workerId,
          columns: 100 + index,
          rows: 30 + index,
          onData: (data) => {
            output += data
          },
          onExit: (event) => resolveExit(event.exitCode),
        })
        session.resize(140 + index, 40 + index)
        sessions.push({ index, sessionId, session, getOutput: () => output, exit })
      }),
    )
    sessions.sort((left, right) => left.index - right.index)
    assert.equal(runtime.listSessions(ownerUserId).length, SESSION_COUNT)

    await Promise.all(
      sessions.map(async ({ index, session, getOutput }) => {
        const environmentMarker = `HEXICAL_STRESS_ENV_${index}=preserved`
        if (process.platform === 'win32') {
          session.write(commandLine(`set HEXICAL_STRESS_ENV_${index}=preserved`))
          session.write(commandLine(`echo ${environmentMarker}`))
        } else {
          session.write(commandLine(`export HEXICAL_STRESS_ENV_${index}=preserved`))
          session.write(commandLine(`printf '%s\\n' "$HEXICAL_STRESS_ENV_${index}"`))
        }
        await waitFor(getOutput, environmentMarker)
        if (process.platform === 'win32') {
          session.write(commandLine(`echo HEXICAL_STRESS_CWD_${index}=%CD%`))
        } else {
          session.write(commandLine(`printf 'HEXICAL_STRESS_CWD_${index}=%s\\n' "$PWD"`))
        }
        await waitFor(getOutput, `HEXICAL_STRESS_CWD_${index}=`)
      }),
    )

    for (const { index, session } of sessions) {
      for (let commandIndex = 0; commandIndex < COMMAND_COUNT; commandIndex += 1) {
        session.write(commandLine(`echo HEXICAL_STRESS_${index}_${commandIndex}`))
      }
    }
    await Promise.all(
      sessions.flatMap(({ index, getOutput }) =>
        Array.from({ length: COMMAND_COUNT }, (_, commandIndex) =>
          waitFor(getOutput, `HEXICAL_STRESS_${index}_${commandIndex}`),
        ),
      ),
    )

    for (const current of sessions) {
      for (const other of sessions) {
        if (current === other) continue
        assert.equal(
          current.getOutput().includes(`HEXICAL_STRESS_${other.index}_`),
          false,
          `session ${current.index} received output from session ${other.index}`,
        )
      }
    }

    await Promise.all(
      sessions.map(async ({ index, session, getOutput }) => {
        const longRunningMarker = `HEXICAL_STRESS_LONG_${index}`
        if (process.platform === 'win32') {
          session.write(commandLine(`ping -n 3 127.0.0.1 >NUL & echo ${longRunningMarker}`))
        } else {
          session.write(commandLine(`sleep 2; printf '${longRunningMarker}\\n'`))
        }
        await waitFor(getOutput, longRunningMarker)
      }),
    )

    const cancellationSessionId = createTTYSessionId()
    cancelledSession = await runtime.createSession({
      sessionId: cancellationSessionId,
      ownerUserId,
      workerId,
    })
    if (process.platform === 'win32') {
      cancelledSession.write(commandLine('ping -n 20 127.0.0.1 >NUL & echo HEXICAL_STRESS_SHOULD_NOT_COMPLETE'))
    } else {
      cancelledSession.write(commandLine('sleep 20'))
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    assert.equal(await runtime.terminateSession(cancellationSessionId, ownerUserId), true)
    cancelledSession = undefined

    const exitCodes = await Promise.all(
      sessions.map(async ({ session, exit }) => {
        session.write(commandLine('exit'))
        const exitCode = await exit
        await session.terminate()
        return exitCode
      }),
    )
    assert.deepEqual(exitCodes, [0, 0, 0])
    assert.equal(runtime.listSessions(ownerUserId).length, 0)

    console.log(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        nodePty: '1.1.0',
        sessions: SESSION_COUNT,
        burstCommandsPerSession: COMMAND_COUNT,
        longRunningCommands: SESSION_COUNT,
        cancellation: true,
        isolation: true,
        cleanup: true,
      }),
    )
  } finally {
    if (cancelledSession && runtime) await cancelledSession.terminate().catch(() => undefined)
    if (runtime) {
      await Promise.all(
        sessions.map(({ sessionId }) => runtime!.terminateSession(sessionId, ownerUserId).catch(() => false)),
      )
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
    setTimeout(() => process.exit(process.exitCode ?? 0), 0)
  })
