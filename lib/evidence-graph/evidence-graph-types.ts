import type { InvestigationId, InvestigationRecord } from '@/lib/investigations/investigation-types'

declare const evidenceGraphEntityIdBrand: unique symbol
declare const evidenceGraphEdgeIdBrand: unique symbol

export type EvidenceGraphEntityId = string & { readonly [evidenceGraphEntityIdBrand]: true }
export type EvidenceGraphEdgeId = string & { readonly [evidenceGraphEdgeIdBrand]: true }

export const EVIDENCE_GRAPH_ENTITY_TYPES = [
  'investigation',
  'execution',
  'host',
  'domain',
  'ip',
  'port',
  'service',
  'url',
  'technology',
  'vulnerability',
  'finding',
  'credential',
  'evidence',
  'file',
  'screenshot',
  'note',
] as const

export type EvidenceGraphEntityType = (typeof EVIDENCE_GRAPH_ENTITY_TYPES)[number]

export const EVIDENCE_GRAPH_RELATIONSHIPS = [
  'DISCOVERED',
  'RESOLVES_TO',
  'EXPOSES',
  'RUNS',
  'LINKS_TO',
  'DETECTED',
  'CONFIRMS',
  'EVIDENCE_FOR',
  'GENERATED_FROM',
  'RELATED_TO',
] as const

export type EvidenceGraphRelationship = (typeof EVIDENCE_GRAPH_RELATIONSHIPS)[number]

export type EvidenceGraphMetadataValue = string | number | boolean | null
export type EvidenceGraphMetadata = Readonly<Record<string, EvidenceGraphMetadataValue>>

export interface EvidenceGraphEntity {
  readonly id: EvidenceGraphEntityId
  readonly investigationId: InvestigationId
  readonly type: EvidenceGraphEntityType
  readonly label: string
  readonly value: string | null
  readonly metadata: EvidenceGraphMetadata
  readonly createdAt: string
  readonly sourceExecutionId: string | null
}

export interface EvidenceGraphEdge {
  readonly id: EvidenceGraphEdgeId
  readonly source: EvidenceGraphEntityId
  readonly target: EvidenceGraphEntityId
  readonly relationship: EvidenceGraphRelationship
  readonly executionId: string
  readonly investigationId: InvestigationId
  readonly timestamp: string
  readonly confidence: number
  readonly metadata: EvidenceGraphMetadata
}

export interface EvidenceGraphEntityCandidate {
  readonly type: EvidenceGraphEntityType
  readonly canonicalKey: string
  readonly label: string
  readonly value?: string | null
  readonly metadata?: EvidenceGraphMetadata
}

export interface EvidenceGraphEntityReference {
  readonly type: EvidenceGraphEntityType
  readonly canonicalKey: string
}

export interface EvidenceGraphRelationshipCandidate {
  readonly source: EvidenceGraphEntityReference
  readonly target: EvidenceGraphEntityReference
  readonly relationship: EvidenceGraphRelationship
  readonly confidence: number
  readonly metadata?: EvidenceGraphMetadata
  readonly dedupeKey?: string
}

export interface EvidenceGraphExtraction {
  readonly entities: readonly EvidenceGraphEntityCandidate[]
  readonly relationships: readonly EvidenceGraphRelationshipCandidate[]
}

export interface EvidenceGraphObservation {
  readonly investigationId: InvestigationId
  readonly executionId: string
  readonly sequence: number
  readonly timestamp: string
  readonly extraction: EvidenceGraphExtraction
}

export interface EvidenceGraphEntityPage {
  readonly entities: readonly EvidenceGraphEntity[]
  readonly nextCursor: string | null
}

export interface EvidenceGraphRelationshipPage {
  readonly relationships: readonly EvidenceGraphEdge[]
  readonly nextCursor: string | null
}

export interface EvidenceGraphConnectedPage {
  readonly entity: EvidenceGraphEntity
  readonly relationships: readonly EvidenceGraphEdge[]
  readonly entities: readonly EvidenceGraphEntity[]
  readonly nextCursor: string | null
}

export interface EvidenceGraphSummary {
  readonly investigation: Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'>
  readonly entityCount: number
  readonly relationshipCount: number
  readonly entitiesByType: Readonly<Partial<Record<EvidenceGraphEntityType, number>>>
  readonly relationshipsByType: Readonly<Partial<Record<EvidenceGraphRelationship, number>>>
  readonly lastUpdatedAt: string | null
}

export interface EvidenceGraphInvestigationView {
  readonly summary: EvidenceGraphSummary
  readonly entities: EvidenceGraphEntityPage
  readonly relationships: EvidenceGraphRelationshipPage
}
