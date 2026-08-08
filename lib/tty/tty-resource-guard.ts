/** Runtime-side resource enforcement for one worker process. */

import type { TTYExecutionId } from './tty-types'

export type TTYOutputStreamKind = 'stdout' | 'stderr'

export type TTYResourceDenialReason =
  | 'max_concurrent_processes'
  | 'output_limit_exceeded'
  | 'stdout_rate_exceeded'
  | 'stderr_rate_exceeded'
  | 'invalid_output_bytes'

export interface TTYResourceGuardConfig {
  readonly maxConcurrentProcesses: number
  readonly maxStdoutBytesPerSecond: number
  readonly maxStderrBytesPerSecond: number
}

export interface TTYRuntimeResourceLimits {
  readonly maxExecutionDurationMs: number
  readonly maxOutputBytesPerExecution: number
}

export interface TTYOutputAccounting {
  readonly allowed: boolean
  readonly acceptedBytes: number
  readonly totalBytes: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly reason?: TTYResourceDenialReason
}

export type TTYTimeoutDisposer = () => void

export interface TTYResourceReservation {
  readonly executionId: TTYExecutionId
  readonly limits: TTYRuntimeResourceLimits
  readonly recordOutput: (stream: TTYOutputStreamKind, bytes: number, nowMs?: number) => TTYOutputAccounting
  readonly armTimeout: (callback: () => void, nowMs?: number) => TTYTimeoutDisposer
  readonly release: () => void
}

export type TTYResourceReservationResult =
  | { readonly allowed: true; readonly reservation: TTYResourceReservation }
  | { readonly allowed: false; readonly reason: TTYResourceDenialReason }

interface MutableCounters {
  totalBytes: number
  stdoutBytes: number
  stderrBytes: number
  stdoutWindowStartMs: number
  stderrWindowStartMs: number
  stdoutWindowBytes: number
  stderrWindowBytes: number
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`)
  return Math.floor(value)
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${label}.`)
  return value
}

export class TTYResourceGuard {
  private readonly config: TTYResourceGuardConfig
  private readonly reservations = new Map<TTYExecutionId, TTYResourceReservationImpl>()

  constructor(config: TTYResourceGuardConfig) {
    this.config = Object.freeze({
      maxConcurrentProcesses: positiveInteger(config.maxConcurrentProcesses, 'max concurrent processes'),
      maxStdoutBytesPerSecond: finiteNonNegative(config.maxStdoutBytesPerSecond, 'stdout byte rate'),
      maxStderrBytesPerSecond: finiteNonNegative(config.maxStderrBytesPerSecond, 'stderr byte rate')
    })
  }

  get activeCount(): number {
    return this.reservations.size
  }

  reserve(executionId: TTYExecutionId, limits: TTYRuntimeResourceLimits): TTYResourceReservationResult {
    if (this.reservations.size >= this.config.maxConcurrentProcesses) {
      return { allowed: false, reason: 'max_concurrent_processes' }
    }
    const maxExecutionDurationMs = positiveInteger(limits.maxExecutionDurationMs, 'execution duration')
    const maxOutputBytesPerExecution = positiveInteger(limits.maxOutputBytesPerExecution, 'execution output limit')
    if (this.reservations.has(executionId)) return { allowed: false, reason: 'max_concurrent_processes' }

    const reservation = new TTYResourceReservationImpl(
      this,
      executionId,
      { maxExecutionDurationMs, maxOutputBytesPerExecution },
      this.config
    )
    this.reservations.set(executionId, reservation)
    return { allowed: true, reservation }
  }

  release(executionId: TTYExecutionId): void {
    const reservation = this.reservations.get(executionId)
    if (!reservation) return
    reservation.disposeTimer()
    this.reservations.delete(executionId)
  }
}

class TTYResourceReservationImpl implements TTYResourceReservation {
  private readonly counters: MutableCounters = {
    totalBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutWindowStartMs: 0,
    stderrWindowStartMs: 0,
    stdoutWindowBytes: 0,
    stderrWindowBytes: 0
  }
  private timeout: ReturnType<typeof setTimeout> | undefined
  private released = false

  constructor(
    private readonly guard: TTYResourceGuard,
    readonly executionId: TTYExecutionId,
    readonly limits: TTYRuntimeResourceLimits,
    private readonly config: TTYResourceGuardConfig
  ) {}

  recordOutput(stream: TTYOutputStreamKind, bytes: number, nowMs = Date.now()): TTYOutputAccounting {
    if (this.released) return this.snapshot(false, 0, 'invalid_output_bytes')
    if (!Number.isSafeInteger(bytes) || bytes < 0) return this.snapshot(false, 0, 'invalid_output_bytes')
    if (bytes === 0) return this.snapshot(true, 0)

    const windowState = this.windowFor(stream, nowMs)
    const rateLimit = stream === 'stdout' ? this.config.maxStdoutBytesPerSecond : this.config.maxStderrBytesPerSecond
    if (rateLimit === 0 || windowState.bytes + bytes > rateLimit) {
      return this.snapshot(false, 0, stream === 'stdout' ? 'stdout_rate_exceeded' : 'stderr_rate_exceeded')
    }

    const available = this.limits.maxOutputBytesPerExecution - this.counters.totalBytes
    const acceptedBytes = Math.min(bytes, Math.max(0, available))
    if (acceptedBytes > 0) {
      this.counters.totalBytes += acceptedBytes
      if (stream === 'stdout') this.counters.stdoutBytes += acceptedBytes
      else this.counters.stderrBytes += acceptedBytes
      windowState.bytes += acceptedBytes
    }
    if (acceptedBytes < bytes) return this.snapshot(false, acceptedBytes, 'output_limit_exceeded')
    return this.snapshot(true, acceptedBytes)
  }

  armTimeout(callback: () => void, nowMs = Date.now()): TTYTimeoutDisposer {
    if (this.released) return () => undefined
    this.disposeTimer()
    const delay = Math.max(1, this.limits.maxExecutionDurationMs - Math.max(0, Date.now() - nowMs))
    let disposed = false
    this.timeout = setTimeout(() => {
      if (disposed || this.released) return
      disposed = true
      this.timeout = undefined
      callback()
    }, delay)
    return () => {
      if (disposed) return
      disposed = true
      if (this.timeout) clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.disposeTimer()
    this.guard.release(this.executionId)
  }

  disposeTimer(): void {
    if (!this.timeout) return
    clearTimeout(this.timeout)
    this.timeout = undefined
  }

  private windowFor(stream: TTYOutputStreamKind, nowMs: number): { bytes: number; startMs: number } {
    const startKey = stream === 'stdout' ? 'stdoutWindowStartMs' : 'stderrWindowStartMs'
    const bytesKey = stream === 'stdout' ? 'stdoutWindowBytes' : 'stderrWindowBytes'
    const counters = this.counters
    const start = this.counters[startKey]
    if (start === 0 || nowMs < start || nowMs - start >= 1_000) {
      counters[startKey] = nowMs
      counters[bytesKey] = 0
    }
    return {
      get bytes() {
        return counters[bytesKey]
      },
      set bytes(value: number) {
        counters[bytesKey] = value
      },
      startMs: counters[startKey]
    }
  }

  private snapshot(allowed: boolean, acceptedBytes: number, reason?: TTYResourceDenialReason): TTYOutputAccounting {
    return {
      allowed,
      acceptedBytes,
      totalBytes: this.counters.totalBytes,
      stdoutBytes: this.counters.stdoutBytes,
      stderrBytes: this.counters.stderrBytes,
      ...(reason ? { reason } : {})
    }
  }
}
