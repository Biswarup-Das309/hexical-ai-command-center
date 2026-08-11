import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TTYPersistentPty } from '../../lib/tty/tty-persistent-runtime'
import { TTYTmuxRuntime, type TTYTmuxAdapter } from '../../lib/tty/tty-tmux-runtime'
import type { TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const sessionId = '00000000-0000-4000-8000-000000009401' as TTYSessionId
const workerA = 'worker-tmux-a' as TTYWorkerId
const workerB = 'worker-tmux-b' as TTYWorkerId

class FakePty implements TTYPersistentPty {
  readonly writes: string[] = []
  readonly resizes: Array<{ columns: number; rows: number }> = []
  readonly pid: number
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

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
    for (const listener of this.dataListeners) listener(`terminal:${data}`)
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows })
  }

  kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 })
  }
}

class FakeTmuxAdapter implements TTYTmuxAdapter {
  readonly servers = new Set<string>()
  readonly createCalls: string[] = []
  readonly attachCalls: string[] = []
  readonly killCalls: string[] = []
  readonly ptys: FakePty[] = []

  async hasServer(name: string): Promise<boolean> {
    return this.servers.has(name)
  }

  async createServer(input: Parameters<TTYTmuxAdapter['createServer']>[0]): Promise<void> {
    this.createCalls.push(input.tmuxSessionName)
    this.servers.add(input.tmuxSessionName)
  }

  attach(input: Parameters<TTYTmuxAdapter['attach']>[0]): TTYPersistentPty {
    this.attachCalls.push(input.tmuxSessionName)
    const pty = new FakePty(this.ptys.length + 1)
    this.ptys.push(pty)
    return pty
  }

  async killServer(name: string): Promise<void> {
    this.killCalls.push(name)
    this.servers.delete(name)
  }
}

test('tmux runtime reattaches a second worker to the same persistent shell rather than creating a replacement', async () => {
  const adapter = new FakeTmuxAdapter()
  const rootDir = join(tmpdir(), `hexical-tmux-runtime-${Math.random().toString(16).slice(2)}`)
  const firstRuntime = new TTYTmuxRuntime(adapter, { rootDir })
  const first = await firstRuntime.createSession({ sessionId, ownerUserId: 'user-one', workerId: workerA })
  const output: string[] = []
  first.onData((data) => output.push(data))
  first.write('cd /workspace\n')
  await first.detach()

  const recoveredRuntime = new TTYTmuxRuntime(adapter, { rootDir })
  const recovered = await recoveredRuntime.recoverSession({ sessionId, ownerUserId: 'user-one', workerId: workerB })
  assert.notEqual(recovered, null)
  recovered?.write('pwd\n')

  assert.equal(adapter.createCalls.length, 1)
  assert.equal(adapter.attachCalls.length, 2)
  assert.equal(adapter.killCalls.length, 0)
  assert.deepEqual(adapter.ptys[0]?.writes, ['cd /workspace\n'])
  assert.deepEqual(adapter.ptys[1]?.writes, ['pwd\n'])
  assert.deepEqual(output, ['terminal:cd /workspace\n'])

  await recovered?.terminate()
  assert.equal(adapter.killCalls.length, 1)
})

test('tmux runtime refuses recovery when the authoritative persistent shell has disappeared', async () => {
  const adapter = new FakeTmuxAdapter()
  const runtime = new TTYTmuxRuntime(adapter, { rootDir: join(tmpdir(), 'hexical-tmux-runtime-missing') })
  const recovered = await runtime.recoverSession({ sessionId, ownerUserId: 'user-one', workerId: workerA })

  assert.equal(recovered, null)
  assert.equal(adapter.createCalls.length, 0)
  assert.equal(adapter.attachCalls.length, 0)
})

test('tmux runtime keeps private workspace and server alive on detach but removes both on termination', async () => {
  const adapter = new FakeTmuxAdapter()
  const runtime = new TTYTmuxRuntime(adapter, {
    rootDir: join(tmpdir(), `hexical-tmux-runtime-cleanup-${Math.random().toString(16).slice(2)}`),
  })
  const handle = await runtime.createSession({ sessionId, ownerUserId: 'user-one', workerId: workerA })
  const cwd = handle.metadata.cwd

  await handle.detach()
  assert.equal(adapter.servers.size, 1)
  assert.equal(runtime.getSession(sessionId, 'user-one'), null)

  const reattached = await runtime.recoverSession({ sessionId, ownerUserId: 'user-one', workerId: workerB })
  await reattached?.terminate()
  assert.equal(adapter.servers.size, 0)
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(cwd)))
})
