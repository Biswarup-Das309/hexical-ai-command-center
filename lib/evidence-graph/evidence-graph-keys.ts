import type { InvestigationId } from '@/lib/investigations/investigation-types'
import { normalizeGraphKey, stableGraphHash } from './evidence-graph-identity'
import type { EvidenceGraphEntityType, EvidenceGraphRelationship } from './evidence-graph-types'

const PREFIX = 'hexical:evidence-graph'

export function graphEntityKey(investigationId: InvestigationId, entityId: string): string {
  return `${PREFIX}:entity:${investigationId}:${entityId}`
}

export function graphEntityIndexKey(investigationId: InvestigationId): string {
  return `${PREFIX}:entities:${investigationId}`
}

export function graphEntityTypeIndexKey(investigationId: InvestigationId, type: EvidenceGraphEntityType): string {
  return `${PREFIX}:entities:${type}:${investigationId}`
}

export function graphEntityLookupKey(
  investigationId: InvestigationId,
  type: EvidenceGraphEntityType,
  canonicalKey: string,
): string {
  return `${PREFIX}:entity-lookup:${investigationId}:${type}:${stableGraphHash(normalizeGraphKey(canonicalKey))}`
}

export function graphEdgeKey(investigationId: InvestigationId, edgeId: string): string {
  return `${PREFIX}:edge:${investigationId}:${edgeId}`
}

export function graphEdgeIndexKey(investigationId: InvestigationId): string {
  return `${PREFIX}:edges:${investigationId}`
}

export function graphEdgeSourceIndexKey(investigationId: InvestigationId, entityId: string): string {
  return `${PREFIX}:edges:source:${investigationId}:${entityId}`
}

export function graphEdgeTargetIndexKey(investigationId: InvestigationId, entityId: string): string {
  return `${PREFIX}:edges:target:${investigationId}:${entityId}`
}

export function graphEdgeRelationshipIndexKey(
  investigationId: InvestigationId,
  relationship: EvidenceGraphRelationship,
): string {
  return `${PREFIX}:edges:relationship:${investigationId}:${relationship}`
}

export function graphEdgeExecutionIndexKey(investigationId: InvestigationId, executionId: string): string {
  return `${PREFIX}:edges:execution:${investigationId}:${executionId}`
}

export function graphProcessedEventIndexKey(investigationId: InvestigationId, executionId: string): string {
  return `${PREFIX}:processed:${investigationId}:${executionId}`
}
