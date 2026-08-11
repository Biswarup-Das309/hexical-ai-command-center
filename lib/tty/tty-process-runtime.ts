/**
 * Trusted worker-side process boundary for one TTY execution.
 *
 * This module deliberately exposes argv-style execution only. It never uses
 * a shell, command interpolation, exec(), or the worker's inherited
 * environment. Each child receives a private working directory and a
 * detached process group so cancellation and recovery can address the whole
 * process tree.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

const DEFAULT_ROOT_NAME = 'hexical-tty-runtime-'
const DEFAULT_STOP_SIGNAL = 'SIGTERM'
const DEFAULT_KILL_SIGNAL = 'SIGKILL'
const MAX_ARGUMENT_LENGTH = 16_384
const MAX_ARGUMENT_COUNT = 256
const MAX_ENV_ENTRIES = 128

export interface TTYProcessSpec {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  /**
   * Resolved by the worker from the admitted job, never supplied by the
   * browser.  A persistent-session runtime needs this to prove it is
   * attaching the execution to the same owner-authorized shell.
   */
  readonly ownerUserId?: string
  readonly workerId: TTYWorkerId
  readonly file: string
  readonly args: readonly string[]
  /** Explicit environment only. Undefined means an empty environment. */
  readonly env?: Readonly<Record<string, string>>
}

export interface TTYProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: string
}

export interface TTYProcessHandle {
  readonly handleId: string
  readonly pid: number
  readonly startedAt: string
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly workerId: TTYWorkerId
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exit: Promise<TTYProcessExit>
}

export interface TTYOrphanProcess {
  readonly pid: number
  readonly cwd: string
}

export interface TTYProcessMetadata extends TTYOrphanProcess {
  readonly handleId: string
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly workerId: TTYWorkerId
  readonly startedAt: string
  /** Distinguishes legacy isolated children from the authoritative PTY path. */
  readonly transport?: 'subprocess' | 'persistent_pty'
  /** Persistent session manager already wrote these bytes to durable output. */
  readonly outputDurable?: boolean
}

export interface TTYProcessRuntimeOptions {
  readonly rootDir?: string
  readonly baseEnv?: Readonly<Record<string, string>>
  readonly killGraceMs?: number
}

interface InternalProcessHandle extends TTYProcessHandle {
  readonly child: ChildProcess
  readonly cwd: string
}

function assertSafeString(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ARGUMENT_LENGTH ||
    value.includes('\u0000')
  ) {
    throw new Error(`Invalid ${label}.`)
  }
}

function assertSafeFile(file: string): void {
  assertSafeString(file, 'process file')
  if (file.trim().length === 0) throw new Error('Invalid process file.')
}

function createHandleId(): string {
  return crypto.randomUUID()
}

function exitSignal(value: NodeJS.Signals | null | undefined): NodeJS.Signals | null {
  return value ?? null
}

function isProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && child.killed === false
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir)
  const target = resolve(candidate)
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${requirePathSeparator()}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function requirePathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

async function bestEffortPrivateDirectory(path: string): Promise<void> {
  try {
    await chmod(path, 0o700)
  } catch {
    // Windows does not provide POSIX directory modes. The directory is still
    // private by ownership and is removed during cleanup.
  }
}

export class TTYProcessRuntime {
  readonly rootDir: string
  private readonly baseEnv: Readonly<Record<string, string>>
  private readonly killGraceMs: number
  private readonly handles = new Map<string, InternalProcessHandle>()

  constructor(options: TTYProcessRuntimeOptions = {}) {
    this.rootDir = resolve(
      options.rootDir ?? join(/* turbopackIgnore: true */ tmpdir(), `${DEFAULT_ROOT_NAME}${process.pid}`),
    )
    this.baseEnv = Object.freeze({ ...(options.baseEnv ?? {}) })
    this.killGraceMs = Math.max(50, Math.floor(options.killGraceMs ?? 1_000))
  }

  async start(spec: TTYProcessSpec): Promise<TTYProcessHandle> {
    this.validateSpec(spec)
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await bestEffortPrivateDirectory(this.rootDir)

    const cwd = await mkdtemp(join(/* turbopackIgnore: true */ this.rootDir, 'execution-'))
    await bestEffortPrivateDirectory(cwd)
    const env = { ...this.baseEnv, ...(spec.env ?? {}) } as NodeJS.ProcessEnv
    const spawnOptions: SpawnOptions = {
      cwd,
      detached: true,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    }
    const child: ChildProcess = spawn(spec.file, [...spec.args], spawnOptions)

    if (!child.stdout || !child.stderr) {
      await rm(cwd, { recursive: true, force: true })
      throw new Error('TTY process streams were not created.')
    }

    const handleId = createHandleId()
    const startedAt = new Date().toISOString()
    let errorMessage: string | undefined
    let resolveExit!: (exit: TTYProcessExit) => void
    const exit = new Promise<TTYProcessExit>((resolvePromise) => {
      resolveExit = resolvePromise
    })
    let settled = false
    const settle = (result: TTYProcessExit) => {
      if (settled) return
      settled = true
      resolveExit(result)
    }

    child.once('error', (error) => {
      errorMessage = error instanceof Error ? error.message : 'Process spawn failed.'
      settle({ code: child.exitCode, signal: exitSignal(child.signalCode), error: errorMessage })
    })
    // Resolve lifecycle completion on the child exit event rather than the
    // close event. close waits for stdio handles to drain, while cancellation
    // must acknowledge that the process has stopped independently of whether a
    // caller is currently consuming both output streams.
    child.once('exit', (code, signal) => {
      settle({ code, signal: exitSignal(signal), ...(errorMessage ? { error: errorMessage } : {}) })
    })

    const handle: InternalProcessHandle = {
      handleId,
      pid: child.pid ?? -1,
      startedAt,
      executionId: spec.executionId,
      sessionId: spec.sessionId,
      workerId: spec.workerId,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      child,
      cwd,
    }
    this.handles.set(handleId, handle)
    void exit.then(() => {
      // Keep the handle until cleanup so callers can still remove its private
      // working directory after the child has closed its streams.
    })
    return handle
  }

  async stop(handle: TTYProcessHandle): Promise<void> {
    const internal = this.requireHandle(handle)
    if (!isProcessRunning(internal.child)) return
    await this.signalProcessGroup(internal.pid, DEFAULT_STOP_SIGNAL)
  }

  async kill(handle: TTYProcessHandle): Promise<void> {
    const internal = this.requireHandle(handle)
    if (!isProcessRunning(internal.child)) return
    await this.signalProcessGroup(internal.pid, DEFAULT_KILL_SIGNAL)
  }

  async cleanup(handle: TTYProcessHandle): Promise<void> {
    const internal = this.requireHandle(handle)
    if (isProcessRunning(internal.child)) {
      await this.kill(internal)
    }
    await this.waitForExit(internal)
    await rm(internal.cwd, { recursive: true, force: true })
    this.handles.delete(internal.handleId)
  }

  getMetadata(handle: TTYProcessHandle): TTYProcessMetadata {
    const internal = this.requireHandle(handle)
    return {
      handleId: internal.handleId,
      pid: internal.pid,
      cwd: internal.cwd,
      executionId: internal.executionId,
      sessionId: internal.sessionId,
      workerId: internal.workerId,
      startedAt: internal.startedAt,
      transport: 'subprocess',
    }
  }

  async cleanupOrphan(orphan: TTYOrphanProcess): Promise<boolean> {
    if (!Number.isInteger(orphan.pid) || orphan.pid <= 0 || !isWithinRoot(this.rootDir, orphan.cwd)) return false
    if (this.isPidRunning(orphan.pid)) await this.signalProcessGroup(orphan.pid, DEFAULT_KILL_SIGNAL)
    await rm(resolve(orphan.cwd), { recursive: true, force: true })
    return true
  }

  private validateSpec(spec: TTYProcessSpec): void {
    assertSafeFile(spec.file)
    if (spec.args.length > MAX_ARGUMENT_COUNT) throw new Error('Too many process arguments.')
    for (const arg of spec.args) assertSafeString(arg, 'process argument')

    const environment = spec.env ?? {}
    const entries = Object.entries(environment)
    if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many process environment entries.')
    for (const [key, value] of entries) {
      assertSafeString(key, 'environment key')
      assertSafeString(value, 'environment value')
      if (key.includes('=') || key.trim().length === 0) throw new Error('Invalid environment key.')
    }
  }

  private requireHandle(handle: TTYProcessHandle): InternalProcessHandle {
    const internal = this.handles.get(handle.handleId)
    if (!internal || internal !== handle) throw new Error('Unknown TTY process handle.')
    return internal
  }

  private async waitForExit(handle: InternalProcessHandle): Promise<void> {
    if (!isProcessRunning(handle.child)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolvePromise) => {
      const finish = () => {
        if (timer) clearTimeout(timer)
        resolvePromise()
      }
      timer = setTimeout(finish, this.killGraceMs)
      void handle.exit.then(finish)
    })
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async signalProcessGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
    if (pid <= 0) return
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
      const taskkillOptions: SpawnOptions = {
        detached: false,
        env: { SystemRoot: systemRoot, SystemDrive: systemRoot.slice(0, 2) } as unknown as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      }
      const taskkill: ChildProcess = spawn(
        join(/* turbopackIgnore: true */ systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        taskkillOptions,
      )
      await new Promise<number | null>((resolvePromise) => {
        taskkill.once('close', (code) => resolvePromise(code))
        taskkill.once('error', () => resolvePromise(null))
      })
      if (!this.isPidRunning(pid)) return
      // A detached child can race taskkill's process-tree walk. Use the
      // platform primitive as a direct fallback if the process is still alive.
      try {
        process.kill(pid, signal)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'ESRCH') throw error
      }
      return
    }
    try {
      process.kill(-pid, signal)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'ESRCH') return
      try {
        process.kill(pid, signal)
      } catch (fallbackError) {
        const fallbackCode =
          fallbackError && typeof fallbackError === 'object' && 'code' in fallbackError ? fallbackError.code : undefined
        if (fallbackCode !== 'ESRCH') throw fallbackError
      }
    }
  }
}

export function createDefaultTTYProcessRuntime(options: TTYProcessRuntimeOptions = {}): TTYProcessRuntime {
  return new TTYProcessRuntime(options)
}
