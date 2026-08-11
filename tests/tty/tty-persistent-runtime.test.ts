import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TTYPersistentRuntime,
  type TTYPersistentPty,
  type TTYPersistentPtyFactory,
} from '../../lib/tty/tty-persistent-runtime'
import type { TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

class FakePty implements TTYPersistentPty {
  readonly pid: number
  readonly writes: string[] = []
  readonly resizes: Array<{ columns: number; rows: number }> = []
  private dataListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(pid: number) {
    this.pid = pid
  }

  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback)
    return { dispose: () => this.dataListeners.delete(callback) }
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(callback)
    return { dispose: () => this.exitListeners.delete(callback) }
  }

  write(data: string): void {
    this.writes.push(data)
    for (const listener of this.dataListeners) listener(`echo:${data}`)
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows })
  }

  kill(): void {
    this.emitExit()
  }

  emitExit(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 })
  }
}

class SilentKillPty extends FakePty {
  override kill(): void {}
}

class FakeFactory implements TTYPersistentPtyFactory {
  readonly ptys: FakePty[] = []
  spawn(_file: string, _args: readonly string[], _options: unknown): TTYPersistentPty {
    const pty = new FakePty(this.ptys.length + 1)
    this.ptys.push(pty)
    return pty
  }
}

class SilentKillFactory implements TTYPersistentPtyFactory {
  readonly pty = new SilentKillPty(1)

  spawn(_file: string, _args: readonly string[], _options: unknown): TTYPersistentPty {
    return this.pty
  }
}

const sessionId = '00000000-0000-4000-8000-000000009001' as TTYSessionId
const otherSessionId = '00000000-0000-4000-8000-000000009002' as TTYSessionId
const workerId = 'worker-persistent-test' as TTYWorkerId

test('persistent runtime keeps stdin, output, resize, cwd, and environment on one PTY', async () => {
  const factory = new FakeFactory()
  const runtime = new TTYPersistentRuntime(factory, {
    rootDir: join(tmpdir(), 'hexical-persistent-test-1'),
    baseEnv: { PATH: 'safe' },
  })
  const terminal = await runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId, env: { TERM: 'xterm' } })
  const output: string[] = []
  terminal.onData((data) => output.push(data))

  terminal.write('echo persistent\n')
  terminal.resize(140, 40)

  assert.equal(factory.ptys.length, 1)
  assert.deepEqual(factory.ptys[0]?.writes, ['echo persistent\n'])
  assert.deepEqual(factory.ptys[0]?.resizes, [{ columns: 140, rows: 40 }])
  assert.equal(output[0], 'echo:echo persistent\n')
  assert.equal(terminal.metadata.columns, 140)
  assert.equal(terminal.metadata.rows, 40)
  assert.equal(terminal.metadata.state, 'active')
  assert.match(terminal.metadata.cwd, /session-/)

  const same = await runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId })
  assert.equal(same.metadata.pid, terminal.metadata.pid)
  assert.equal(runtime.getSession(sessionId, 'other-user'), null)
})

test('persistent runtime isolates multiple terminal sessions and owner-scoped lifecycle', async () => {
  const factory = new FakeFactory()
  const runtime = new TTYPersistentRuntime(factory, { rootDir: join(tmpdir(), 'hexical-persistent-test-2') })
  const first = await runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId })
  const second = await runtime.createSession({ sessionId: otherSessionId, ownerUserId: 'user-one', workerId })

  assert.equal(runtime.listSessions('user-one').length, 2)
  assert.equal(await runtime.terminateSession(sessionId, 'other-user'), false)
  assert.equal(await runtime.terminateSession(sessionId, 'user-one'), true)
  assert.equal(runtime.getSession(sessionId, 'user-one'), null)
  assert.equal(runtime.getSession(otherSessionId, 'user-one')?.metadata.pid, second.metadata.pid)
  await second.terminate()
  assert.equal(runtime.listSessions('user-one').length, 0)
  assert.equal(first.metadata.state, 'terminated')
})

test('persistent runtime removes a failed PTY workspace when spawn fails', async () => {
  const rootDir = join(tmpdir(), 'hexical-persistent-test-failure')
  const factory: TTYPersistentPtyFactory = {
    spawn: () => {
      throw new Error('native PTY unavailable')
    },
  }
  const runtime = new TTYPersistentRuntime(factory, { rootDir })

  await assert.rejects(
    runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId }),
    /native PTY unavailable/,
  )
  assert.equal(runtime.listSessions('user-one').length, 0)
})

test('persistent runtime retains an unconfirmed PTY for a later termination retry', async () => {
  const factory = new SilentKillFactory()
  const runtime = new TTYPersistentRuntime(factory, {
    rootDir: join(tmpdir(), 'hexical-persistent-test-timeout'),
    terminationWaitMs: 1,
  })
  const terminal = await runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId })

  await assert.rejects(terminal.terminate(), /termination was not confirmed/)
  assert.equal(runtime.getSession(sessionId, 'user-one')?.metadata.state, 'active')

  factory.pty.emitExit()
  await terminal.terminate()
  assert.equal(runtime.getSession(sessionId, 'user-one'), null)
})
