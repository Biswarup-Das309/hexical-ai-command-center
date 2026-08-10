import type { InvestigationId } from '@/lib/investigations/investigation-types'
import type {
  EvidenceGraphEdgeId,
  EvidenceGraphEntityId,
  EvidenceGraphEntityType,
  EvidenceGraphRelationship,
} from './evidence-graph-types'

function hashPart(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function stableGraphHash(value: string): string {
  return `${hashPart(value, 2_166_136_261).toString(16).padStart(8, '0')}${hashPart(value, 2_654_435_761)
    .toString(16)
    .padStart(8, '0')}`
}

export function normalizeGraphKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function graphEntityId(
  investigationId: InvestigationId,
  type: EvidenceGraphEntityType,
  canonicalKey: string,
): EvidenceGraphEntityId {
  return `entity_${stableGraphHash(
    `${investigationId}|${type}|${normalizeGraphKey(canonicalKey)}`,
  )}` as EvidenceGraphEntityId
}

export function graphEdgeId(
  investigationId: InvestigationId,
  source: EvidenceGraphEntityId,
  target: EvidenceGraphEntityId,
  relationship: EvidenceGraphRelationship,
  executionId: string,
  dedupeKey: string,
): EvidenceGraphEdgeId {
  return `edge_${stableGraphHash(
    `${investigationId}|${source}|${target}|${relationship}|${executionId}|${normalizeGraphKey(dedupeKey)}`,
  )}` as EvidenceGraphEdgeId
}
