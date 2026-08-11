/** Browser-safe polling and output projection for a TTY execution. */

import type { TTYExecutionStateRecord } from './tty-execution-state'
import type { TTYOutputEvent, TTYOutputStreamManager } from './tty-output-stream'
import type { TTYSessionStore } from './tty-session-store'
import type { TTYExecutionId, TTYSessionId } from './tty-types'

export interface TTYBrowserExecutionView {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly state: TTYExecutionStateRecord['state']
  readonly timestamps: {
    readonly queuedAt: string
    readonly updatedAt: string
    readonly leasedAt: string | null
    readonly startedAt: string | null
    readonly finishedAt: string | null
  }
  readonly outputSummary: {
    readonly eventCount: number
    readonly stdoutBytes: number
    readonly stderrBytes: number
    readonly totalBytes: number
    readonly lastEventAt: string | null
  }
  readonly diagnostics: {
    readonly exitCode: number | null
    readonly signal: string | null
    readonly failureCode: string | null
    readonly completionReason: string | null
  }
  readonly resourceUsage: {
    readonly queueWaitMs: number | null
    readonly startupMs: number | null
    readonly durationMs: number | null
  }
}

export interface TTYBrowserOutputEvent {
  readonly sequence: number
  readonly timestamp: string
  readonly type: 'stdout' | 'stderr' | 'state' | 'completion'
  readonly text: string | null
  readonly state: string | null
}

export interface TTYExecutionApiDependencies {
  readonly getState: (executionId: TTYExecutionId) => Promise<TTYExecutionStateRecord | null>
  readonly outputStream: Pick<TTYOutputStreamManager, 'read'>
  readonly sessionStore: Pick<TTYSessionStore, 'getSession'>
}

function safeOutputEvent(event: TTYOutputEvent): TTYBrowserOutputEvent | null {
  if (event.type !== 'stdout' && event.type !== 'stderr' && event.type !== 'state' && event.type !== 'completion')
    return null
  const text = typeof event.data.text === 'string' ? event.data.text : null
  const state = typeof event.data.state === 'string' ? event.data.state : null
  return { sequence: event.sequence, timestamp: event.timestamp, type: event.type, text, state }
}

export class TTYExecutionApi {
  constructor(private readonly dependencies: TTYExecutionApiDependencies) {}

  async getExecution(executionId: TTYExecutionId, ownerUserId: string): Promise<TTYBrowserExecutionView | null> {
    const state = await this.authorizedState(executionId, ownerUserId)
    if (!state) return null
    const events = await this.dependencies.outputStream.read(executionId)
    const stdoutBytes = events.reduce(
      (sum, event) =>
        sum + (event.type === 'stdout' && typeof event.data.byteLength === 'number' ? event.data.byteLength : 0),
      0,
    )
    const stderrBytes = events.reduce(
      (sum, event) =>
        sum + (event.type === 'stderr' && typeof event.data.byteLength === 'number' ? event.data.byteLength : 0),
      0,
    )
    return {
      executionId: state.executionId,
      sessionId: state.sessionId,
      state: state.state,
      timestamps: {
        queuedAt: state.queuedAt,
        updatedAt: state.updatedAt,
        leasedAt: state.leasedAt,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
      },
      outputSummary: {
        eventCount: events.length,
        stdoutBytes,
        stderrBytes,
        totalBytes: stdoutBytes + stderrBytes,
        lastEventAt: events.at(-1)?.timestamp ?? null,
      },
      diagnostics: {
        exitCode: state.exitCode,
        signal: state.signal,
        failureCode: state.failureCode,
        completionReason: state.completionReason,
      },
      resourceUsage: {
        queueWaitMs: state.queueWaitMs,
        startupMs: state.startupMs,
        durationMs: state.durationMs,
      },
    }
  }

  async getOutput(
    executionId: TTYExecutionId,
    ownerUserId: string,
    options?: { readonly start?: string; readonly end?: string; readonly count?: number },
  ): Promise<readonly TTYBrowserOutputEvent[] | null> {
    const state = await this.authorizedState(executionId, ownerUserId)
    if (!state) return null
    const events = await this.dependencies.outputStream.read(executionId, options)
    return events.map(safeOutputEvent).filter((event): event is TTYBrowserOutputEvent => event !== null)
  }

  private async authorizedState(
    executionId: TTYExecutionId,
    ownerUserId: string,
  ): Promise<TTYExecutionStateRecord | null> {
    const state = await this.dependencies.getState(executionId)
    if (!state) return null
    if (state.ownerUserId !== null && state.ownerUserId !== ownerUserId) return null
    if (state.ownerUserId === ownerUserId) return state
    // Legacy records predate admission-time ownership. They retain the old
    // active-session authorization path until their short retention expires.
    const session = await this.dependencies.sessionStore.getSession(state.sessionId, ownerUserId)
    if (!session || session.sessionId !== state.sessionId || session.ownerUserId !== ownerUserId) return null
    return state
  }
}
