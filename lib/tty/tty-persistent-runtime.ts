/**
 * Worker-owned persistent terminal sessions.
 *
 * TTYProcessRuntime is intentionally still the boundary for short-lived,
 * allowlisted argv executions. This module is the Runtime OS boundary for a
 * long-lived shell: one PTY per terminal session, explicit stdin writes,
 * terminal resize, stable cwd/environment, and reconnect-safe metadata.
 *
 * The node-pty adapter is loaded only by the worker. Keeping the factory
 * injectable makes lifecycle and ownership invariants testable without
 * requiring a native PTY module in the Next.js/web dependency graph.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TTYSessionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

const DEFAULT_ROOT_NAME = 'hexical-tty-sessions-'
const MAX_INPUT_BYTES = 64 * 1024
const MAX_ENV_ENTRIES = 128
const MAX_DIMENSION = 500
const TERMINATION_WAIT_MS = 5_000
const MAX_TERMINATION_WAIT_MS = 60_000

export interface TTYPersistentPty {
  readonly pid: number
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { readonly exitCode: number; readonly signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(signal?: string): void
}

export interface TTYPersistentPtySpawnOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Windows-only backend override; services use WinPTY when no console is attached. */
  readonly useConpty?: boolean
}

export interface TTYPersistentPtyFactory {
  spawn(file: string, args: readonly string[], options: TTYPersistentPtySpawnOptions): TTYPersistentPty
}

export interface TTYPersistentSessionMetadata {
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly pid: number
  readonly shell: string
  readonly cwd: string
  readonly startedAt: string
  readonly columns: number
  readonly rows: number
  readonly state: 'active' | 'exited' | 'terminated'
}

export interface TTYPersistentSessionHandle {
  readonly metadata: TTYPersistentSessionMetadata
  write(data: string): void
  resize(columns: number, rows: number): void
  onData(callback: (data: string) => void): () => void
  onExit(callback: (event: { readonly exitCode: number; readonly signal?: number }) => void): () => void
  readonly replayOutput?: (afterOffset?: number) => Promise<{ readonly data: string; readonly nextOffset: number }>
  terminate(): Promise<void>
}

export interface TTYPersistentRuntimeOptions {
  readonly rootDir?: string
  readonly baseEnv?: Readonly<Record<string, string>>
  readonly shell?: string
  readonly shellArgs?: readonly string[]
  readonly defaultColumns?: number
  readonly defaultRows?: number
  /** Testable upper bound for confirmed child-process termination. */
  readonly terminationWaitMs?: number
  /** Windows-only node-pty backend override. Defaults to WinPTY for service-safe cleanup. */
  readonly useConpty?: boolean
}

interface InternalSession {
  readonly pty: TTYPersistentPty
  readonly cwd: string
  readonly dataListeners: Set<(data: string) => void>
  readonly exitListeners: Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>
  metadata: TTYPersistentSessionMetadata
  dataSubscription: { dispose(): void }
  exitSubscription: { dispose(): void }
  exitPromise: Promise<void>
  resolveExit: () => void
  terminationPromise: Promise<void> | null
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || value.includes('\u0000'))
    throw new Error(`Invalid ${label}.`)
}

function dimensions(columns: number | undefined, rows: number | undefined): { columns: number; rows: number } {
  const safeColumns = Math.floor(columns ?? 120)
  const safeRows = Math.floor(rows ?? 32)
  if (!Number.isSafeInteger(safeColumns) || !Number.isSafeInteger(safeRows)) throw new Error('Invalid terminal size.')
  if (safeColumns < 1 || safeRows < 1 || safeColumns > MAX_DIMENSION || safeRows > MAX_DIMENSION)
    throw new Error('Terminal size is outside the permitted range.')
  return { columns: safeColumns, rows: safeRows }
}

function environment(
  baseEnv: Readonly<Record<string, string>>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
) {
  const result = { ...baseEnv, ...(sessionEnv ?? {}) }
  const entries = Object.entries(result)
  if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many terminal environment entries.')
  for (const [key, value] of entries) {
    assertIdentity(key, 'environment key')
    assertIdentity(value, 'environment value')
    if (key.includes('=') || key.includes('\u0000') || value.includes('\u0000'))
      throw new Error('Invalid terminal environment.')
  }
  return Object.freeze(result)
}

function defaultShell(): string {
  return process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh'
}

export class TTYPersistentRuntime {
  readonly rootDir: string
  private readonly baseEnv: Readonly<Record<string, string>>
  private readonly shell: string
  private readonly shellArgs: readonly string[]
  private readonly defaultSize: { readonly columns: number; readonly rows: number }
  private readonly terminationWaitMs: number
  private readonly useConpty: boolean | undefined
  private readonly sessions = new Map<TTYSessionId, InternalSession>()

  constructor(
    private readonly factory: TTYPersistentPtyFactory,
    options: TTYPersistentRuntimeOptions = {},
  ) {
    this.rootDir = resolve(options.rootDir ?? join(tmpdir(), `${DEFAULT_ROOT_NAME}${process.pid}`))
    this.baseEnv = environment(options.baseEnv ?? {}, undefined)
    this.shell = options.shell ?? defaultShell()
    assertIdentity(this.shell, 'terminal shell')
    this.shellArgs = Object.freeze([...(options.shellArgs ?? [])])
    this.defaultSize = dimensions(options.defaultColumns, options.defaultRows)
    const requestedTerminationWaitMs = Math.floor(options.terminationWaitMs ?? TERMINATION_WAIT_MS)
    if (
      !Number.isSafeInteger(requestedTerminationWaitMs) ||
      requestedTerminationWaitMs < 1 ||
      requestedTerminationWaitMs > MAX_TERMINATION_WAIT_MS
    )
      throw new Error('Invalid terminal termination timeout.')
    this.terminationWaitMs = requestedTerminationWaitMs
    this.useConpty = options.useConpty ?? (process.platform === 'win32' ? false : undefined)
  }

  async createSession(input: {
    readonly sessionId: TTYSessionId
    readonly ownerUserId: string
    readonly workerId: TTYWorkerId
    readonly env?: Readonly<Record<string, string>>
    readonly columns?: number
    readonly rows?: number
    /** Installed before the PTY starts emitting, so startup output is not lost. */
    readonly onData?: (data: string) => void
    readonly onExit?: (event: { readonly exitCode: number; readonly signal?: number }) => void
  }): Promise<TTYPersistentSessionHandle> {
    assertIdentity(input.sessionId, 'session id')
    assertIdentity(input.ownerUserId, 'session owner')
    assertIdentity(input.workerId, 'worker id')
    const existing = this.sessions.get(input.sessionId)
    if (existing) {
      if (existing.metadata.ownerUserId !== input.ownerUserId)
        throw new Error('Terminal session is not owned by caller.')
      const handle = this.handleFor(existing)
      if (input.onData) handle.onData(input.onData)
      if (input.onExit) handle.onExit(input.onExit)
      return handle
    }

    const size = dimensions(input.columns ?? this.defaultSize.columns, input.rows ?? this.defaultSize.rows)
    await mkdir(this.rootDir, { recursive: true })
    const cwd = await mkdtemp(join(this.rootDir, 'session-'))
    let pty: TTYPersistentPty
    try {
      pty = this.factory.spawn(this.shell, this.shellArgs, {
        name: 'xterm-256color',
        cols: size.columns,
        rows: size.rows,
        cwd,
        env: environment(this.baseEnv, input.env),
        ...(this.useConpty === undefined ? {} : { useConpty: this.useConpty }),
      })
    } catch (error) {
      await rm(cwd, { recursive: true, force: true })
      throw error
    }
    const metadata: TTYPersistentSessionMetadata = Object.freeze({
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      workerId: input.workerId,
      pid: pty.pid,
      shell: this.shell,
      cwd,
      startedAt: new Date().toISOString(),
      columns: size.columns,
      rows: size.rows,
      state: 'active',
    })
    let resolveExit!: () => void
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const internal: InternalSession = {
      pty,
      cwd,
      dataListeners: new Set(input.onData ? [input.onData] : []),
      exitListeners: new Set(input.onExit ? [input.onExit] : []),
      metadata,
      dataSubscription: { dispose: () => undefined },
      exitSubscription: { dispose: () => undefined },
      exitPromise,
      resolveExit,
      terminationPromise: null,
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
  }

  getSession(sessionId: TTYSessionId, ownerUserId: string): TTYPersistentSessionHandle | null {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId) return null
    return this.handleFor(internal)
  }

  listSessions(ownerUserId: string): readonly TTYPersistentSessionMetadata[] {
    return Object.freeze(
      [...this.sessions.values()]
        .filter((session) => session.metadata.ownerUserId === ownerUserId)
        .map((session) => session.metadata),
    )
  }

  async terminateSession(sessionId: TTYSessionId, ownerUserId: string): Promise<boolean> {
    const internal = this.sessions.get(sessionId)
    if (!internal || internal.metadata.ownerUserId !== ownerUserId) return false
    await this.terminateInternal(internal)
    return true
  }

  private handleFor(internal: InternalSession): TTYPersistentSessionHandle {
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
        const size = dimensions(columns, rows)
        if (internal.metadata.state !== 'active') throw new Error('Terminal session is not active.')
        internal.pty.resize(size.columns, size.rows)
        internal.metadata = Object.freeze({ ...internal.metadata, columns: size.columns, rows: size.rows })
      },
      onData: (callback) => {
        internal.dataListeners.add(callback)
        return () => internal.dataListeners.delete(callback)
      },
      onExit: (callback) => {
        internal.exitListeners.add(callback)
        return () => internal.exitListeners.delete(callback)
      },
      terminate: () => this.terminateInternal(internal),
    }
  }

  private terminateInternal(internal: InternalSession): Promise<void> {
    if (internal.metadata.state === 'terminated') return Promise.resolve()
    if (internal.terminationPromise !== null) return internal.terminationPromise
    let operation!: Promise<void>
    operation = this.terminateInternalOnce(internal).finally(() => {
      if (internal.terminationPromise === operation && internal.metadata.state !== 'terminated')
        internal.terminationPromise = null
    })
    internal.terminationPromise = operation
    return operation
  }

  private async terminateInternalOnce(internal: InternalSession): Promise<void> {
    if (internal.metadata.state === 'active') {
      internal.pty.kill()
      const exited = await Promise.race([
        internal.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.terminationWaitMs)),
      ])
      if (!exited) throw new Error('Terminal PTY termination was not confirmed; session remains recoverable for retry.')
    }
    internal.metadata = Object.freeze({ ...internal.metadata, state: 'terminated' })
    internal.dataSubscription.dispose()
    internal.exitSubscription.dispose()
    this.sessions.delete(internal.metadata.sessionId)
    await rm(internal.cwd, { recursive: true, force: true })
  }
}

/** Loads node-pty only in the worker process. It remains optional to the web app. */
export async function createNodePtyFactory(): Promise<TTYPersistentPtyFactory> {
  // Loaded only in the worker process; the web runtime never executes this path.
  const nodePty = await import('node-pty')
  return {
    spawn(file, args, options) {
      return nodePty.spawn(file, [...args], options)
    },
  }
}
