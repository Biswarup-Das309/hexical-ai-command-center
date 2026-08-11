/**
 * Adapter that lets the durable execution state machine run against a
 * session-bound persistent PTY instead of spawning a child process per job.
 *
 * Its surface intentionally matches the coordinator's historical process
 * boundary.  The implementation never imports child_process, never invokes a
 * shell through Node, and never creates a second runtime: argv is framed and
 * written into the manager-owned long-lived shell.
 */

import { PassThrough } from 'node:stream'
import type { TTYPersistentExecutionHandle, TTYPersistentSessionManager } from './tty-persistent-session-manager'
import type { TTYProcessHandle, TTYProcessMetadata, TTYProcessRuntime, TTYProcessSpec } from './tty-process-runtime'

interface PersistentProcessHandle extends TTYProcessHandle {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly persistent: TTYPersistentExecutionHandle
  readonly unsubscribe: () => void
}

function executableName(file: string): string {
  const normalized = file.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}

/**
 * Worker-side execution bridge for the Runtime OS.
 *
 * `start()` dispatches an admitted argv into the session manager's existing
 * shell. `attachRecovered()` wraps an already-running framed command after a
 * worker handoff; it never dispatches argv a second time.
 */
export class TTYPersistentProcessRuntime {
  private readonly handles = new Map<string, PersistentProcessHandle>()

  constructor(private readonly sessions: TTYPersistentSessionManager) {}

  async start(spec: TTYProcessSpec): Promise<TTYProcessHandle> {
    if (!spec.ownerUserId) throw new Error('Persistent PTY execution is missing its resolved owner.')
    const command = executableName(spec.file)
    if (!command || command.includes('\u0000')) throw new Error('Persistent PTY execution command is invalid.')
    const argv = [command, ...spec.args] as [string, ...string[]]
    const persistent = await this.sessions.startExecution({
      executionId: spec.executionId,
      sessionId: spec.sessionId,
      ownerUserId: spec.ownerUserId,
      argv,
    })
    return this.wrap(spec, persistent)
  }

  async attachRecovered(input: {
    readonly executionId: TTYProcessSpec['executionId']
    readonly sessionId: TTYProcessSpec['sessionId']
    readonly workerId: TTYProcessSpec['workerId']
    readonly persistent: TTYPersistentExecutionHandle
  }): Promise<TTYProcessHandle> {
    if (input.persistent.metadata.executionId !== input.executionId)
      throw new Error('Recovered persistent execution identity does not match the admitted job.')
    if (input.persistent.metadata.sessionId !== input.sessionId)
      throw new Error('Recovered persistent session identity does not match the admitted job.')
    return this.wrap(
      {
        executionId: input.executionId,
        sessionId: input.sessionId,
        workerId: input.workerId,
        file: 'recovered-persistent-pty',
        args: [],
      },
      input.persistent,
    )
  }

  private wrap(spec: TTYProcessSpec, persistent: TTYPersistentExecutionHandle): TTYProcessHandle {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const unsubscribe = persistent.onData((data) => {
      if (!stdout.destroyed) stdout.write(data)
    })
    const exit = persistent.exit.then(
      (result) => {
        if (!stdout.destroyed) stdout.end()
        if (!stderr.destroyed) stderr.end()
        return result
      },
      (error) => {
        if (!stdout.destroyed) stdout.end()
        if (!stderr.destroyed) stderr.end()
        return {
          code: null,
          signal: null,
          error: error instanceof Error ? error.message : 'Persistent PTY execution failed.',
        }
      },
    )
    const handle: PersistentProcessHandle = {
      handleId: persistent.metadata.handleId,
      pid: persistent.metadata.pid,
      startedAt: persistent.metadata.startedAt,
      executionId: spec.executionId,
      sessionId: spec.sessionId,
      workerId: spec.workerId,
      stdout,
      // A PTY intentionally merges stdout/stderr at the terminal boundary.
      // The durable output event remains `stdout` and its surrounding state
      // records `transport=pty` in the manager audit trail.
      stderr,
      exit,
      persistent,
      unsubscribe,
    }
    this.handles.set(handle.handleId, handle)
    return handle
  }

  async stop(handle: TTYProcessHandle): Promise<void> {
    const persistent = this.requireHandle(handle)
    await persistent.persistent.interrupt()
  }

  async kill(handle: TTYProcessHandle): Promise<void> {
    const persistent = this.requireHandle(handle)
    await persistent.persistent.forceTerminate()
  }

  async cleanup(handle: TTYProcessHandle): Promise<void> {
    const persistent = this.requireHandle(handle)
    persistent.unsubscribe()
    await persistent.persistent.finalize?.()
    persistent.persistent.dispose()
    if (!persistent.stdout.destroyed) persistent.stdout.end()
    if (!persistent.stderr.destroyed) persistent.stderr.end()
    this.handles.delete(persistent.handleId)
  }

  getMetadata(handle: TTYProcessHandle): TTYProcessMetadata {
    const persistent = this.requireHandle(handle)
    return {
      handleId: persistent.handleId,
      pid: persistent.pid,
      cwd: persistent.persistent.metadata.cwd,
      executionId: persistent.executionId,
      sessionId: persistent.sessionId,
      workerId: persistent.workerId,
      startedAt: persistent.startedAt,
      transport: 'persistent_pty',
      outputDurable: persistent.persistent.durableOutput === true,
    }
  }

  private requireHandle(handle: TTYProcessHandle): PersistentProcessHandle {
    const persistent = this.handles.get(handle.handleId)
    if (!persistent || persistent !== handle) throw new Error('Unknown persistent PTY execution handle.')
    return persistent
  }
}

/** Compile-time guard: keep this adapter aligned with the coordinator contract. */
export type TTYPersistentCoordinatorRuntime = Pick<
  TTYProcessRuntime,
  'start' | 'stop' | 'kill' | 'cleanup' | 'getMetadata'
>
