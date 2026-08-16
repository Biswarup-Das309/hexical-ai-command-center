/**
 * Reattachable production PTY host.
 *
 * node-pty owns an attach-client, while tmux owns the actual shell process.
 * Closing or replacing a worker's node-pty client therefore does not create a
 * new shell: a recovered worker reattaches to the same tmux server session,
 * preserving cwd, environment, shell history, background jobs, and long-lived
 * processes. This module is Linux-worker only; it is never imported by the
 * Vercel/Next.js web runtime.
 */

import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  TTYPersistentPty,
  TTYPersistentPtySpawnOptions,
  TTYPersistentSessionMetadata,
} from './tty-persistent-runtime'
import { TTYLinuxProcessTelemetryCollector, type TTYProcessTelemetrySnapshot } from './tty-process-telemetry'
import type { TTYSessionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

const DEFAULT_ROOT_NAME = 'hexical-persistent-pty'
const DEFAULT_TERMINATION_WAIT_MS = 5_000
const MAX_TERMINATION_WAIT_MS = 60_000
const MAX_ENV_ENTRIES = 128
const MAX_DIMENSION = 500
const MAX_INPUT_BYTES = 64 * 1024

export interface TTYTmuxServerInput {
  readonly tmuxSessionName: string
  readonly shell: string
  readonly shellArgs: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outputJournal: string
}

export interface TTYTmuxAttachInput {
  readonly tmuxSessionName: string
  readonly columns: number
  readonly rows: number
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outputJournal: string
}

/** Administrative operations are argv-only and never use a shell. */
export interface TTYTmuxAdapter {
  hasServer(tmuxSessionName: string): Promise<boolean>
  createServer(input: TTYTmuxServerInput): Promise<void>
  attach(input: TTYTmuxAttachInput): TTYPersistentPty
  /** Detach one node-pty tmux client without sending a hangup to the shell. */
  readonly detachClient?: (tmuxSessionName: string, clientPid: number) => Promise<boolean>
  /** Idempotently keeps tmux pane output flowing to the durable journal. */
  readonly enableOutputJournal?: (tmuxSessionName: string, outputJournal: string) => Promise<void>
  /** Returns the authoritative tmux pane PID, not the node-pty attach client. */
  readonly getPanePid?: (tmuxSessionName: string) => Promise<number | null>
  killServer(tmuxSessionName: string): Promise<void>
}

export interface TTYTmuxRuntimeOptions {
  readonly rootDir?: string
  readonly baseEnv?: Readonly<Record<string, string>>
  readonly shell?: string
  readonly shellArgs?: readonly string[]
  readonly defaultColumns?: number
  readonly defaultRows?: number
  readonly terminationWaitMs?: number
}

export interface TTYTmuxSessionHandle {
  readonly metadata: TTYPersistentSessionMetadata
  write(data: string): void
  resize(columns: number, rows: number): void
  onData(callback: (data: string) => void): () => void
  onExit(callback: (event: { readonly exitCode: number; readonly signal?: number }) => void): () => void
  /** Disconnect this worker's PTY client but keep the persistent tmux shell alive. */
  detach(): Promise<void>
  /** Permanently kill the tmux shell, its process tree, and its private workspace. */
  terminate(): Promise<void>
}

interface InternalSession {
  readonly pty: TTYPersistentPty
  readonly cwd: string
  readonly tmuxSessionName: string
  readonly outputJournal: string | null
  readonly dataListeners: Set<(data: string) => void>
  readonly exitListeners: Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>
  dataSubscription: { dispose(): void }
  exitSubscription: { dispose(): void }
  readonly exitPromise: Promise<void>
  readonly resolveExit: () => void
  metadata: TTYPersistentSessionMetadata
  detachPromise: Promise<void> | null
  terminatePromise: Promise<void> | null
}

function assertText(value: string, label: string, maxLength = 256): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || value.includes('\u0000'))
    throw new Error(`Invalid ${label}.`)
}

function size(columns: number | undefined, rows: number | undefined): { columns: number; rows: number } {
  const safeColumns = Math.floor(columns ?? 120)
  const safeRows = Math.floor(rows ?? 32)
  if (
    !Number.isSafeInteger(safeColumns) ||
    !Number.isSafeInteger(safeRows) ||
    safeColumns < 1 ||
    safeRows < 1 ||
    safeColumns > MAX_DIMENSION ||
    safeRows > MAX_DIMENSION
  )
    throw new Error('Terminal size is outside the permitted range.')
  return { columns: safeColumns, rows: safeRows }
}

function environment(
  baseEnv: Readonly<Record<string, string>>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
  cwd: string,
): Readonly<Record<string, string>> {
  const result = { ...baseEnv, ...(sessionEnv ?? {}), HISTFILE: join(cwd, '.hexical_history') }
  const entries = Object.entries(result)
  if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many terminal environment entries.')
  for (const [key, value] of entries) {
    assertText(key, 'environment key')
    assertText(value, 'environment value', 16_384)
    if (key.includes('=')) throw new Error('Invalid terminal environment key.')
  }
  return Object.freeze(result)
}

function tmuxName(sessionId: TTYSessionId): string {
  const normalized = String(sessionId).replace(/-/g, '')
  if (!/^[a-f0-9]{32}$/i.test(normalized)) throw new Error('Invalid terminal session identity.')
  return `hexical_${normalized.toLowerCase()}`
}

function isWithin(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir)
  const target = resolve(candidate)
  const pathFromRoot = relative(root, target)
  return pathFromRoot.length > 0 && pathFromRoot !== '..' && !pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot)
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await chmod(path, 0o700)
  } catch {
    // The supported production worker is Linux. This keeps local Windows test
    // fixtures portable without misrepresenting Windows as a deployment target.
  }
}

export class TTYTmuxRuntime {
  readonly rootDir: string
  private readonly baseEnv: Readonly<Record<string, string>>
  private readonly shell: string
  private readonly shellArgs: readonly string[]
  private readonly defaultSize: { readonly columns: number; readonly rows: number }
  private readonly terminationWaitMs: number
  private readonly processTelemetry: TTYLinuxProcessTelemetryCollector
  private readonly sessions = new Map<TTYSessionId, InternalSession>()

  constructor(
    private readonly adapter: TTYTmuxAdapter,
    options: TTYTmuxRuntimeOptions = {},
  ) {
    this.rootDir = resolve(options.rootDir ?? join(tmpdir(), DEFAULT_ROOT_NAME))
    this.baseEnv = Object.freeze({ ...(options.baseEnv ?? {}) })
    this.shell = options.shell ?? '/bin/bash'
    assertText(this.shell, 'terminal shell', 4_096)
    this.shellArgs = Object.freeze([...(options.shellArgs ?? ['--noprofile', '--norc', '-i'])])
    this.defaultSize = size(options.defaultColumns, options.defaultRows)
    const requestedWait = Math.floor(options.terminationWaitMs ?? DEFAULT_TERMINATION_WAIT_MS)
    if (!Number.isSafeInteger(requestedWait) || requestedWait < 1 || requestedWait > MAX_TERMINATION_WAIT_MS)
      throw new Error('Invalid terminal termination timeout.')
    this.terminationWaitMs = requestedWait
    this.processTelemetry = new TTYLinuxProcessTelemetryCollector()
  }

  async createSession(input: {
    readonly sessionId: TTYSessionId
    readonly ownerUserId: string
    readonly workerId: TTYWorkerId
    readonly env?: Readonly<Record<string, string>>
    readonly columns?: number
    readonly rows?: number
    readonly startedAt?: string
    readonly onData?: (data: string) => void
    readonly onExit?: (event: { readonly exitCode: number; readonly signal?: number }) => void
  }): Promise<TTYTmuxSessionHandle> {
    return this.attach(input, true)
  }

  /** Reattach to a previously created tmux shell; never creates a replacement shell. */
  async recoverSession(input: {
    readonly sessionId: TTYSessionId
    readonly ownerUserId: string
    readonly workerId: TTYWorkerId
    readonly env?: Readonly<Record<string, string>>
    readonly columns?: number
    readonly rows?: number
    readonly startedAt?: string
    readonly onData?: (data: string) => void
    readonly onExit?: (event: { readonly exitCode: number; readonly signal?: number }) => void
  }): Promise<TTYTmuxSessionHandle | null> {
    if (!(await this.adapter.hasServer(tmuxName(input.sessionId)))) return null
    return this.attach(input, false)
  }

  getSession(sessionId: TTYSessionId, ownerUserId: string): TTYTmuxSessionHandle | null {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId) return null
    return this.handleFor(internal)
  }

  /**
   * The node-pty object represents only this worker's tmux attach client.
   * Its exit is therefore not proof that the authoritative tmux shell exited.
   * The session manager uses this probe before deciding whether to detach or
   * permanently terminate the durable shell.
   */
  async hasPersistentSession(sessionId: TTYSessionId): Promise<boolean> {
    return this.adapter.hasServer(tmuxName(sessionId))
  }

  listSessions(ownerUserId: string): readonly TTYPersistentSessionMetadata[] {
    return Object.freeze(
      [...this.sessions.values()]
        .filter((session) => session.metadata.ownerUserId === ownerUserId)
        .map((session) => session.metadata),
    )
  }

  async getProcessTelemetry(sessionId: TTYSessionId, ownerUserId: string): Promise<TTYProcessTelemetrySnapshot | null> {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId || !this.adapter.getPanePid) return null
    const panePid = await this.adapter.getPanePid(internal.tmuxSessionName)
    if (panePid === null) return null
    return this.processTelemetry.sample(panePid, internal.cwd)
  }

  async detachSession(sessionId: TTYSessionId, ownerUserId: string): Promise<boolean> {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId) return false
    await this.detachInternal(internal)
    return true
  }

  async terminateSession(sessionId: TTYSessionId, ownerUserId: string): Promise<boolean> {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId) return false
    await this.terminateInternal(internal)
    return true
  }

  private async attach(
    input: {
      readonly sessionId: TTYSessionId
      readonly ownerUserId: string
      readonly workerId: TTYWorkerId
      readonly env?: Readonly<Record<string, string>>
      readonly columns?: number
      readonly rows?: number
      readonly startedAt?: string
      readonly onData?: (data: string) => void
      readonly onExit?: (event: { readonly exitCode: number; readonly signal?: number }) => void
    },
    createIfMissing: boolean,
  ): Promise<TTYTmuxSessionHandle> {
    assertText(input.sessionId, 'session id')
    assertText(input.ownerUserId, 'session owner')
    assertText(input.workerId, 'worker id')
    const existing = this.sessions.get(input.sessionId)
    if (existing) {
      if (existing.metadata.ownerUserId !== input.ownerUserId)
        throw new Error('Terminal session is not owned by caller.')
      const handle = this.handleFor(existing)
      if (input.onData) handle.onData(input.onData)
      if (input.onExit) handle.onExit(input.onExit)
      return handle
    }

    const tmuxSessionName = tmuxName(input.sessionId)
    const cwd = resolve(this.rootDir, String(input.sessionId))
    if (!isWithin(this.rootDir, cwd)) throw new Error('Terminal workspace escaped its configured root.')
    const terminalSize = size(input.columns ?? this.defaultSize.columns, input.rows ?? this.defaultSize.rows)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    await privateDirectory(cwd)
    const env = environment(this.baseEnv, input.env, cwd)
    const existed = await this.adapter.hasServer(tmuxSessionName)
    if (!existed && !createIfMissing)
      return Promise.reject(new Error('Persistent tmux shell disappeared during recovery.'))
    try {
      if (!existed) {
        await this.adapter.createServer({
          tmuxSessionName,
          shell: this.shell,
          shellArgs: this.shellArgs,
          cwd,
          env,
          outputJournal: join(cwd, '.hexical-output.log'),
        })
      }
      const outputJournal = join(cwd, '.hexical-output.log')
      if (this.adapter.enableOutputJournal) await this.adapter.enableOutputJournal(tmuxSessionName, outputJournal)
      const pty = this.adapter.attach({
        tmuxSessionName,
        columns: terminalSize.columns,
        rows: terminalSize.rows,
        cwd,
        env,
        outputJournal,
      })
      const metadata: TTYPersistentSessionMetadata = Object.freeze({
        sessionId: input.sessionId,
        ownerUserId: input.ownerUserId,
        workerId: input.workerId,
        pid: pty.pid,
        shell: this.shell,
        cwd,
        startedAt: input.startedAt ?? new Date().toISOString(),
        columns: terminalSize.columns,
        rows: terminalSize.rows,
        state: 'active',
      })
      let resolveExit!: () => void
      const exitPromise = new Promise<void>((resolveExitPromise) => {
        resolveExit = resolveExitPromise
      })
      const internal: InternalSession = {
        pty,
        cwd,
        tmuxSessionName,
        outputJournal: this.adapter.enableOutputJournal ? outputJournal : null,
        dataListeners: new Set(input.onData ? [input.onData] : []),
        exitListeners: new Set(input.onExit ? [input.onExit] : []),
        dataSubscription: { dispose: () => undefined },
        exitSubscription: { dispose: () => undefined },
        exitPromise,
        resolveExit,
        metadata,
        detachPromise: null,
        terminatePromise: null,
      }
      internal.dataSubscription = pty.onData((data) => {
        for (const listener of internal.dataListeners) listener(data)
      })
      internal.exitSubscription = pty.onExit((event) => {
        internal.metadata = Object.freeze({ ...internal.metadata, state: 'exited' })
        internal.resolveExit()
        for (const listener of internal.exitListeners) listener(event)
      })
      this.sessions.set(input.sessionId, internal)
      return this.handleFor(internal)
    } catch (error) {
      if (!existed) {
        await this.adapter.killServer(tmuxSessionName).catch(() => undefined)
        await rm(cwd, { recursive: true, force: true })
      }
      throw error
    }
  }

  private handleFor(internal: InternalSession): TTYTmuxSessionHandle {
    return {
      get metadata() {
        return internal.metadata
      },
      write: (data) => {
        if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES || data.includes('\u0000'))
          throw new Error('Terminal input rejected.')
        if (internal.metadata.state !== 'active') throw new Error('Terminal session is not active.')
        internal.pty.write(data)
      },
      resize: (columns, rows) => {
        const terminalSize = size(columns, rows)
        if (internal.metadata.state !== 'active') throw new Error('Terminal session is not active.')
        internal.pty.resize(terminalSize.columns, terminalSize.rows)
        internal.metadata = Object.freeze({ ...internal.metadata, ...terminalSize })
      },
      onData: (callback) => {
        internal.dataListeners.add(callback)
        return () => internal.dataListeners.delete(callback)
      },
      onExit: (callback) => {
        internal.exitListeners.add(callback)
        return () => internal.exitListeners.delete(callback)
      },
      ...(internal.outputJournal
        ? {
            replayOutput: async (afterOffset = 0) => {
              if (!Number.isSafeInteger(afterOffset) || afterOffset < 0) throw new Error('Invalid PTY journal offset.')
              let bytes: Buffer
              try {
                bytes = await readFile(internal.outputJournal as string)
              } catch (error) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
                if (code === 'ENOENT' && afterOffset === 0) return { data: '', nextOffset: 0 }
                throw error
              }
              if (afterOffset > bytes.byteLength) throw new Error('PTY journal was truncated before replay completed.')
              const pending = bytes.subarray(afterOffset)
              const completeBytes = completeUTF8Prefix(pending)
              return {
                data: pending.subarray(0, completeBytes).toString('utf8'),
                nextOffset: afterOffset + completeBytes,
              }
            },
          }
        : {}),
      detach: () => this.detachInternal(internal),
      terminate: () => this.terminateInternal(internal),
    }
  }

  private detachInternal(internal: InternalSession): Promise<void> {
    if (internal.detachPromise !== null) return internal.detachPromise
    let operation!: Promise<void>
    operation = (async () => {
      if (internal.metadata.state === 'active') {
        const detached = this.adapter.detachClient
          ? await this.adapter.detachClient(internal.tmuxSessionName, internal.pty.pid).catch(() => false)
          : false
        if (!detached) internal.pty.kill()
        const exited = await Promise.race([
          internal.exitPromise.then(() => true),
          new Promise<boolean>((resolveTimer) => setTimeout(() => resolveTimer(false), this.terminationWaitMs)),
        ])
        if (!exited) throw new Error('PTY detach was not confirmed; runtime remains fenced for retry.')
      }
      internal.dataSubscription.dispose()
      internal.exitSubscription.dispose()
      this.sessions.delete(internal.metadata.sessionId)
    })().finally(() => {
      if (internal.detachPromise === operation && internal.metadata.state !== 'terminated')
        internal.detachPromise = null
    })
    internal.detachPromise = operation
    return operation
  }

  private terminateInternal(internal: InternalSession): Promise<void> {
    if (internal.terminatePromise !== null) return internal.terminatePromise
    let operation!: Promise<void>
    operation = (async () => {
      await this.detachInternal(internal)
      await this.adapter.killServer(internal.tmuxSessionName)
      internal.metadata = Object.freeze({ ...internal.metadata, state: 'terminated' })
      await rm(internal.cwd, { recursive: true, force: true })
    })().finally(() => {
      if (internal.terminatePromise === operation && internal.metadata.state !== 'terminated')
        internal.terminatePromise = null
    })
    internal.terminatePromise = operation
    return operation
  }
}

interface SpawnResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function shellQuote(value: string): string {
  if (value.includes('\u0000')) throw new Error('Invalid tmux journal path.')
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

function completeUTF8Prefix(bytes: Buffer): number {
  let leadIndex = bytes.byteLength - 1
  let continuationCount = 0
  while (leadIndex >= 0 && ((bytes[leadIndex] as number) & 0xc0) === 0x80) {
    continuationCount += 1
    leadIndex -= 1
  }
  if (leadIndex < 0) return 0
  const lead = bytes[leadIndex] as number
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return expected > continuationCount + 1 ? leadIndex : bytes.byteLength
}

async function runTmuxCommand(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<SpawnResult> {
  const { spawn } = await import('node:child_process')
  return new Promise<SpawnResult>((resolveCommand, rejectCommand) => {
    const child = spawn('tmux', [...args], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', rejectCommand)
    child.once('close', (code) => resolveCommand({ code, stdout, stderr }))
  })
}

/**
 * Loads node-pty and tmux operations only in the isolated Linux worker image.
 * It is a hard production dependency, not a browser fallback.
 */
export async function createNodePtyTmuxAdapter(
  options: {
    readonly adminEnv?: Readonly<Record<string, string>>
  } = {},
): Promise<TTYTmuxAdapter> {
  if (process.platform === 'win32') throw new Error('The production persistent PTY worker requires Linux and tmux.')
  // Loaded only in the worker process; the web runtime never executes this path.
  const nodePty = await import('node-pty')
  const adminEnv = options.adminEnv ?? { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color' }
  return {
    async hasServer(tmuxSessionName) {
      const result = await runTmuxCommand(['has-session', '-t', tmuxSessionName], '/', adminEnv)
      return result.code === 0
    },
    async createServer(input) {
      const result = await runTmuxCommand(
        ['new-session', '-d', '-s', input.tmuxSessionName, '-c', input.cwd, '--', input.shell, ...input.shellArgs],
        input.cwd,
        input.env,
      )
      if (result.code !== 0) throw new Error(`Failed to create persistent tmux session (${result.code ?? 'unknown'}).`)
    },
    async enableOutputJournal(tmuxSessionName, outputJournal) {
      const result = await runTmuxCommand(
        ['pipe-pane', '-o', '-t', `${tmuxSessionName}:0.0`, `cat >> ${shellQuote(outputJournal)}`],
        '/',
        adminEnv,
      )
      if (result.code !== 0) throw new Error(`Failed to enable persistent PTY journal (${result.code ?? 'unknown'}).`)
    },
    async getPanePid(tmuxSessionName) {
      const result = await runTmuxCommand(
        ['display-message', '-p', '-t', `${tmuxSessionName}:0.0`, '#{pane_pid}'],
        '/',
        adminEnv,
      )
      const pid = Number(result.stdout.trim())
      return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null
    },
    attach(input) {
      const options: TTYPersistentPtySpawnOptions = {
        name: 'xterm-256color',
        cols: input.columns,
        rows: input.rows,
        cwd: input.cwd,
        env: input.env,
      }
      return nodePty.spawn('tmux', ['attach-session', '-t', input.tmuxSessionName], options)
    },
    async detachClient(tmuxSessionName, clientPid) {
      const clients = await runTmuxCommand(
        ['list-clients', '-F', '#{client_pid}\t#{client_tty}\t#{session_name}', '-t', tmuxSessionName],
        '/',
        adminEnv,
      )
      const client = clients.stdout
        .split('\n')
        .map((line) => line.trim())
        .map((line) => line.split('\t'))
        .find(([pid]) => pid === String(clientPid))
      const target = client?.[1]
      if (!target) return false
      const result = await runTmuxCommand(['detach-client', '-t', target], '/', adminEnv)
      return result.code === 0
    },
    async killServer(tmuxSessionName) {
      const result = await runTmuxCommand(['kill-session', '-t', tmuxSessionName], '/', adminEnv)
      if (result.code !== 0 && !/no server running|can't find session/i.test(result.stderr))
        throw new Error(`Failed to terminate persistent tmux session (${result.code ?? 'unknown'}).`)
    },
  }
}
