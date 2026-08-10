import type { InvestigationId } from './investigation-types'

const PREFIX = 'hexical:investigations'

export function investigationRecordKey(investigationId: InvestigationId): string {
  return `${PREFIX}:record:${investigationId}`
}

export function investigationOwnerIndexKey(ownerUserId: string): string {
  return `${PREFIX}:owner:${ownerUserId}`
}

export function investigationExecutionIndexKey(investigationId: InvestigationId): string {
  return `${PREFIX}:executions:${investigationId}`
}

export function investigationExecutionKey(investigationId: InvestigationId, executionId: string): string {
  return `${PREFIX}:execution:${investigationId}:${executionId}`
}

export function investigationSessionKey(investigationId: InvestigationId): string {
  return `${PREFIX}:session:${investigationId}`
}

export function investigationTimelineKey(investigationId: InvestigationId): string {
  return `${PREFIX}:timeline:${investigationId}`
}

export function investigationTimelineDedupeKey(investigationId: InvestigationId): string {
  return `${PREFIX}:timeline-dedupe:${investigationId}`
}

export function investigationBookmarkIndexKey(investigationId: InvestigationId): string {
  return `${PREFIX}:bookmarks:${investigationId}`
}

export function investigationCounterKey(
  investigationId: InvestigationId,
  counter: 'executions' | 'evidence' | 'findings',
): string {
  return `${PREFIX}:counter:${counter}:${investigationId}`
}
