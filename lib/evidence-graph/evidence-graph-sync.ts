import type { TTYBrowserExecutionView, TTYBrowserOutputEvent } from '@/lib/tty/tty-execution-api'
import type { InvestigationExecution, InvestigationId, InvestigationRecord } from '@/lib/investigations/investigation-types'
import { DeterministicExtractionEngine } from './deterministic-extractor'
import type { EvidenceGraphStore } from './evidence-graph-store'

const MAX_EXECUTIONS_PER_SYNC = 50
const MAX_OUTPUT_EVENTS_PER_SYNC = 100_000
const OBSERVATION_BATCH_SIZE = 25

export interface EvidenceGraphSynchronizationSource {
  readonly getInvestigation: (ownerUserId: string, investigationId: InvestigationId) => Promise<Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'> | null>
  readonly getExecutions: (ownerUserId: string, investigationId: InvestigationId) => Promise<readonly InvestigationExecution[]>
  readonly getExecution: (executionId: string, ownerUserId: string) => Promise<TTYBrowserExecutionView | null>
  readonly getOutput: (executionId: string, ownerUserId: string, options: { readonly count: number }) => Promise<readonly TTYBrowserOutputEvent[] | null>
}

export class EvidenceGraphSynchronizer {
  constructor(private readonly store: EvidenceGraphStore, private readonly source: EvidenceGraphSynchronizationSource, private readonly extractor = new DeterministicExtractionEngine()) {}

  async synchronizeInvestigation(ownerUserId: string, investigationId: InvestigationId): Promise<void> {
    const investigation = await this.source.getInvestigation(ownerUserId, investigationId)
    if (!investigation || investigation.status === 'deleted') return
    await this.store.ensureInvestigation(ownerUserId, investigation)
    const executions = (await this.source.getExecutions(ownerUserId, investigationId)).slice(0, MAX_EXECUTIONS_PER_SYNC)
    for (const execution of executions) await this.synchronizeExecutionInternal(ownerUserId, investigationId, execution.executionId, false)
  }

  async synchronizeExecution(ownerUserId: string, investigationId: InvestigationId, executionId: string): Promise<void> {
    await this.synchronizeExecutionInternal(ownerUserId, investigationId, executionId, true)
  }

  private async synchronizeExecutionInternal(ownerUserId: string, investigationId: InvestigationId, executionId: string, verifyAttachment: boolean): Promise<void> {
    if (verifyAttachment) {
      const attached = await this.source.getExecutions(ownerUserId, investigationId)
      if (!attached.some(execution => execution.executionId === executionId)) return
    }
    const execution = await this.source.getExecution(executionId, ownerUserId)
    if (!execution) return
    const output = await this.source.getOutput(executionId, ownerUserId, { count: MAX_OUTPUT_EVENTS_PER_SYNC })
    if (!output) return
    const processed = await this.store.getProcessedSequences(ownerUserId, investigationId, executionId)
    if (!processed) return
    this.extractor.reset(executionId)
    let batch: Array<{ readonly sequence: number; readonly timestamp: string; readonly extraction: ReturnType<DeterministicExtractionEngine['extract']> }> = []
    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return
      await this.store.upsertObservations(ownerUserId, investigationId, batch.map(item => ({ investigationId, executionId, sequence: item.sequence, timestamp: item.timestamp, extraction: item.extraction })))
      for (const item of batch) await this.store.markProcessedSequence(investigationId, executionId, item.sequence)
      batch = []
    }

    let lastSequence = 0
    let lastTimestamp = execution.timestamps.updatedAt
    for (const event of output) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) continue
      lastSequence = event.sequence
      lastTimestamp = event.timestamp
      const extraction = event.type === 'stdout' || event.type === 'stderr'
        ? this.extractor.extract(executionId, { type: event.type, text: event.text ?? '', sequence: event.sequence, timestamp: event.timestamp })
        : { entities: [], relationships: [] }
      if (processed.has(event.sequence)) continue
      batch.push({ sequence: event.sequence, timestamp: event.timestamp, extraction })
      if (batch.length >= OBSERVATION_BATCH_SIZE) await flushBatch()
    }
    const flushed = this.extractor.flush(executionId)
    if (flushed.entities.length > 0 || flushed.relationships.length > 0) {
      batch.push({ sequence: lastSequence || 1, timestamp: lastTimestamp, extraction: flushed })
    }
    if (output.length === 0 && batch.length === 0) {
      batch.push({ sequence: 1, timestamp: execution.timestamps.updatedAt, extraction: { entities: [], relationships: [] } })
    }
    await flushBatch()
  }
}
