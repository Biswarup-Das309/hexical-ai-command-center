/** Worker-crash reconciliation for orphaned runtime processes. */

import type { Redis } from '@upstash/redis'
import { log } from '@/lib/hexical/telemetry'
import type { TTYExecutionState, TTYExecutionStateRecord } from './tty-execution-state'
import type { TTYProcessRuntime, TTYOrphanProcess } from './tty-process-runtime'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyExecutionActiveIndexKey, ttyExecutionRuntimeKey, ttyExecutionStateKey } from './tty-worker-keys'

export interface TTYRecoveryCandidate {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly state: TTYExecutionState
  readonly runtime: TTYOrphanProcess | null
}

export interface TTYRecoveryReconcileResult {
  readonly scanned: number
  readonly cleaned: number
  readonly recovered: number
  readonly failed: number
}

export type TTYRecoveryStateHandler = (
  executionId: TTYExecutionId,
  sessionId: TTYSessionId,
) => Promise<TTYExecutionStateRecord | null>

function parseState(
  value: unknown,
): { executionId: TTYExecutionId; sessionId: TTYSessionId; state: TTYExecutionState } | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const states: readonly string[] = [
      'queued',
      'leased',
      'starting',
      'running',
      'streaming',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'expired',
    ]
    if (
      typeof record.executionId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.state !== 'string' ||
      !states.includes(record.state)
    )
      return null
    return {
      executionId: record.executionId as TTYExecutionId,
      sessionId: record.sessionId as TTYSessionId,
      state: record.state as TTYExecutionState,
    }
  } catch {
    return null
  }
}

function parseRuntime(value: unknown): TTYOrphanProcess | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      !Number.isInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      typeof record.cwd !== 'string' ||
      record.cwd.length === 0
    )
      return null
    return { pid: record.pid as number, cwd: record.cwd }
  } catch {
    return null
  }
}

export class TTYRecoveryManager {
  constructor(
    private readonly redis: Redis,
    private readonly processRuntime: Pick<TTYProcessRuntime, 'cleanupOrphan'>,
  ) {}

  async findCandidates(): Promise<readonly TTYRecoveryCandidate[]> {
    try {
      const executionIds = await this.redis.smembers(ttyExecutionActiveIndexKey())
      const candidates = await Promise.all(
        executionIds.map(async (value) => {
          const executionId = value as TTYExecutionId
          const rawState = await this.redis.get<unknown>(ttyExecutionStateKey(executionId))
          const state = parseState(rawState)
          if (!state || (state.state !== 'starting' && state.state !== 'running' && state.state !== 'streaming'))
            return null
          const runtime = parseRuntime(await this.redis.get<unknown>(ttyExecutionRuntimeKey(executionId)))
          return { ...state, runtime } satisfies TTYRecoveryCandidate
        }),
      )
      return candidates.filter((candidate): candidate is TTYRecoveryCandidate => candidate !== null)
    } catch {
      return []
    }
  }

  async reconcile(recoverState: TTYRecoveryStateHandler): Promise<TTYRecoveryReconcileResult> {
    const candidates = await this.findCandidates()
    let cleaned = 0
    let recovered = 0
    let failed = 0
    for (const candidate of candidates) {
      try {
        if (candidate.runtime) {
          const didClean = await this.processRuntime.cleanupOrphan(candidate.runtime)
          if (didClean) cleaned += 1
        }
        const state = await recoverState(candidate.executionId, candidate.sessionId)
        if (state?.state === 'queued' || state?.state === 'expired') recovered += 1
        else failed += 1
      } catch (error) {
        failed += 1
        log.warn('tty.execution.recovery_failed', {
          executionId: candidate.executionId,
          sessionId: candidate.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { scanned: candidates.length, cleaned, recovered, failed }
  }
}
