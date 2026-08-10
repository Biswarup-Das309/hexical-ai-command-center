import type { TTYBrowserExecutionView, TTYBrowserOutputEvent } from '@/lib/tty/tty-execution-api'
import type { InvestigationStore } from './investigation-store'
import type { InvestigationId, InvestigationExecutionState } from './investigation-types'

const MAX_OUTPUT_EVENTS_PER_SYNC = 2_000

type Store = Pick<InvestigationStore, 'get' | 'updateExecution' | 'recordExecutionEvent'>

export interface InvestigationExecutionSource {
  readonly getExecution: (executionId: string, ownerUserId: string) => Promise<TTYBrowserExecutionView | null>
  readonly getOutput: (
    executionId: string,
    ownerUserId: string,
    options: { readonly count: number },
  ) => Promise<readonly TTYBrowserOutputEvent[] | null>
}

function investigationState(state: TTYBrowserExecutionView['state']): InvestigationExecutionState {
  return state
}

export class InvestigationExecutionSynchronizer {
  constructor(
    private readonly store: Store,
    private readonly source: InvestigationExecutionSource,
  ) {}

  async synchronize(ownerUserId: string, investigationId: InvestigationId): Promise<void> {
    const hydration = await this.store.get(ownerUserId, investigationId, { executionLimit: 50, timelineLimit: 1 })
    if (!hydration) return
    await Promise.all(
      hydration.executions.map((execution) =>
        this.synchronizeExecution(ownerUserId, investigationId, execution.executionId),
      ),
    )
  }

  private async synchronizeExecution(
    ownerUserId: string,
    investigationId: InvestigationId,
    executionId: string,
  ): Promise<void> {
    const execution = await this.source.getExecution(executionId, ownerUserId)
    if (!execution) return
    await this.store.updateExecution(ownerUserId, investigationId, executionId, investigationState(execution.state), {
      updatedAt: execution.timestamps.updatedAt,
      finishedAt: execution.timestamps.finishedAt,
      durationMs: execution.resourceUsage.durationMs,
    })
    const output = await this.source.getOutput(executionId, ownerUserId, { count: MAX_OUTPUT_EVENTS_PER_SYNC })
    if (!output) return
    for (const event of output) await this.persistOutputEvent(ownerUserId, investigationId, executionId, event)
  }

  private async persistOutputEvent(
    ownerUserId: string,
    investigationId: InvestigationId,
    executionId: string,
    event: TTYBrowserOutputEvent,
  ): Promise<void> {
    if (event.type === 'stdout' || event.type === 'stderr') {
      await this.store.recordExecutionEvent(ownerUserId, investigationId, {
        type: event.type,
        executionId,
        sequence: event.sequence,
        occurredAt: event.timestamp,
        payload: { text: event.text },
      })
      return
    }
    if (event.type === 'state' && (event.state === 'running' || event.state === 'streaming')) {
      await this.store.recordExecutionEvent(ownerUserId, investigationId, {
        type: 'execution_started',
        executionId,
        sequence: event.sequence,
        occurredAt: event.timestamp,
        payload: { state: event.state },
      })
      return
    }
    if (event.type === 'completion') {
      const type = event.state === 'succeeded' ? 'execution_completed' : 'execution_failed'
      await this.store.recordExecutionEvent(ownerUserId, investigationId, {
        type,
        executionId,
        sequence: event.sequence,
        occurredAt: event.timestamp,
        payload: { state: event.state },
      })
    }
  }
}
