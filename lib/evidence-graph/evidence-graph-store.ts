import type { InvestigationId, InvestigationRecord } from '@/lib/investigations/investigation-types'
import { graphEdgeId, graphEntityId, normalizeGraphKey } from './evidence-graph-identity'
import {
  graphEdgeExecutionIndexKey,
  graphEdgeIndexKey,
  graphEdgeKey,
  graphEdgeRelationshipIndexKey,
  graphEdgeSourceIndexKey,
  graphEdgeTargetIndexKey,
  graphEntityIndexKey,
  graphEntityKey,
  graphEntityLookupKey,
  graphEntityTypeIndexKey,
  graphProcessedEventIndexKey,
} from './evidence-graph-keys'
import type {
  EvidenceGraphConnectedPage,
  EvidenceGraphEdge,
  EvidenceGraphEntity,
  EvidenceGraphEntityCandidate,
  EvidenceGraphEntityId,
  EvidenceGraphEntityPage,
  EvidenceGraphEntityType,
  EvidenceGraphExtraction,
  EvidenceGraphInvestigationView,
  EvidenceGraphMetadata,
  EvidenceGraphObservation,
  EvidenceGraphRelationship,
  EvidenceGraphRelationshipCandidate,
  EvidenceGraphRelationshipPage,
  EvidenceGraphSummary,
} from './evidence-graph-types'

const MAX_ENTITY_LIMIT = 100
const MAX_RELATIONSHIP_LIMIT = 100
const MAX_CONNECTED_LIMIT = 100

const ENTITY_UPSERT_SCRIPT = `-- hexical:evidence-graph:entity-upsert
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('SET', KEYS[2], ARGV[2], 'NX')
end
-- Re-add indexes even when the entity object already existed.  This repairs
-- an index lost during a partial Redis restore without duplicating members.
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[2])
if created then return 1 end
return 0`

// The investigation root is the one mutable graph entity.  Entity and edge
// observations remain immutable, but the root must be repaired after a Redis
// restore and its title/status must follow the durable investigation record.
const INVESTIGATION_ROOT_UPSERT_SCRIPT = `-- hexical:evidence-graph:investigation-root-upsert
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('SET', KEYS[2], ARGV[2], 'NX')
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[2])
if not created then
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1`

const EDGE_UPSERT_SCRIPT = `-- hexical:evidence-graph:edge-upsert
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
-- Re-add all directional/filter indexes on every replay-safe upsert.
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[5], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[6], ARGV[3], ARGV[2])
if created then return 1 end
return 0`

const LAST_UPDATED_MAX_SCRIPT = `-- hexical:evidence-graph:last-updated-max
local current = redis.call('GET', KEYS[1])
if not current or ARGV[1] > current then redis.call('SET', KEYS[1], ARGV[1]) end
return 1`

export interface EvidenceGraphRedis {
  readonly get: <T = unknown>(key: string) => Promise<T | null>
  readonly set: (key: string, value: unknown, options?: { readonly nx?: boolean }) => Promise<unknown>
  readonly zadd: (key: string, value: { readonly score: number; readonly member: string }) => Promise<number | null>
  readonly zrange: <T extends unknown[]>(
    key: string,
    min: number,
    max: number,
    options: { readonly rev?: boolean; readonly offset: number; readonly count: number },
  ) => Promise<T>
  readonly zcard: (key: string) => Promise<number>
  readonly eval: <T = unknown>(script: string, keys: readonly string[], args: readonly string[]) => Promise<T>
}

export interface EvidenceGraphAuthorization {
  readonly getInvestigation: (
    ownerUserId: string,
    investigationId: InvestigationId,
  ) => Promise<Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'> | null>
}

export interface EvidenceGraphStoreLogger {
  readonly warn: (message: string, metadata?: Record<string, unknown>) => void
  readonly error: (message: string, metadata?: Record<string, unknown>) => void
}

const NOOP_LOGGER: EvidenceGraphStoreLogger = { warn: () => {}, error: () => {} }

interface StoredEntity extends EvidenceGraphEntity {
  readonly canonicalKey: string
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}

function safeCursor(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER)
}

function safeLimit(value: number | undefined, maximum: number): number {
  if (!Number.isSafeInteger(value) || value === undefined) return Math.min(20, maximum)
  return Math.max(1, Math.min(maximum, value))
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function score(timestamp: string): number {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : 0
}

function storedPublicEntity(entity: StoredEntity): EvidenceGraphEntity {
  const { canonicalKey: _canonicalKey, ...safe } = entity
  return safe
}

function entityReferenceKey(candidate: {
  readonly type: EvidenceGraphEntityType
  readonly canonicalKey: string
}): string {
  return `${candidate.type}|${normalizeGraphKey(candidate.canonicalKey)}`
}

export class EvidenceGraphStore {
  private readonly logger: EvidenceGraphStoreLogger

  constructor(
    private readonly redis: EvidenceGraphRedis,
    private readonly authorization: EvidenceGraphAuthorization,
    options?: { readonly logger?: EvidenceGraphStoreLogger },
  ) {
    this.logger = options?.logger ?? NOOP_LOGGER
  }

  async ensureInvestigation(
    ownerUserId: string,
    investigation: Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'>,
  ): Promise<EvidenceGraphEntityId | null> {
    const context = await this.authorizedInvestigation(ownerUserId, investigation.investigationId)
    if (!context || context.status === 'deleted' || context.investigationId !== investigation.investigationId)
      return null
    return this.ensureInvestigationRoot(investigation)
  }

  async upsertObservations(
    ownerUserId: string,
    investigationId: InvestigationId,
    observations: readonly EvidenceGraphObservation[],
  ): Promise<{ readonly entitiesCreated: number; readonly relationshipsCreated: number }> {
    const context = await this.authorizedInvestigation(ownerUserId, investigationId)
    if (!context || context.status === 'deleted') return { entitiesCreated: 0, relationshipsCreated: 0 }
    let entitiesCreated = 0
    let relationshipsCreated = 0
    for (const observation of observations) {
      if (observation.investigationId !== investigationId) continue
      const investigationIdEntity = graphEntityId(investigationId, 'investigation', investigationId)
      const executionCandidate: EvidenceGraphEntityCandidate = {
        type: 'execution',
        canonicalKey: observation.executionId,
        label: `Execution ${observation.executionId.slice(0, 12)}`,
        value: null,
        metadata: { parser: 'system' },
      }
      const candidates = [
        {
          type: 'investigation' as const,
          canonicalKey: investigationId,
          label: context.title,
          value: context.title,
          metadata: { status: context.status, parser: 'system' },
        },
        executionCandidate,
        ...observation.extraction.entities,
      ]
      const references = new Map<string, EvidenceGraphEntityId>()
      for (const candidate of candidates) {
        const key = entityReferenceKey(candidate)
        if (references.has(key)) continue
        const id = graphEntityId(investigationId, candidate.type, candidate.canonicalKey)
        references.set(key, id)
        const created = await this.upsertEntityInternal(
          investigationId,
          candidate,
          candidate.type === 'investigation' ? null : observation.executionId,
          observation.timestamp,
        )
        entitiesCreated += created.created ? 1 : 0
      }
      const executionIdEntity = references.get(entityReferenceKey(executionCandidate))!
      const entityCandidates = candidates.filter(
        (candidate) => candidate.type !== 'investigation' && candidate.type !== 'execution',
      )
      for (const candidate of entityCandidates) {
        const entityId = references.get(entityReferenceKey(candidate))!
        relationshipsCreated += await this.upsertEdgeInternal(investigationId, {
          source: investigationIdEntity,
          target: entityId,
          relationship: 'DISCOVERED',
          executionId: observation.executionId,
          timestamp: observation.timestamp,
          confidence: 0.99,
          metadata: { sequence: observation.sequence, parser: 'system' },
          dedupeKey: `discovered:${candidate.type}:${candidate.canonicalKey}`,
        })
        relationshipsCreated += await this.upsertEdgeInternal(investigationId, {
          source: entityId,
          target: executionIdEntity,
          relationship: 'GENERATED_FROM',
          executionId: observation.executionId,
          timestamp: observation.timestamp,
          confidence: 0.95,
          metadata: { sequence: observation.sequence, parser: 'system' },
          dedupeKey: `generated:${candidate.type}:${candidate.canonicalKey}`,
        })
      }
      relationshipsCreated += await this.upsertEdgeInternal(investigationId, {
        source: executionIdEntity,
        target: investigationIdEntity,
        relationship: 'GENERATED_FROM',
        executionId: observation.executionId,
        timestamp: observation.timestamp,
        confidence: 1,
        metadata: { sequence: observation.sequence, parser: 'system' },
        dedupeKey: 'execution-investigation',
      })
      for (const candidate of observation.extraction.relationships) {
        const source = references.get(entityReferenceKey(candidate.source))
        const target = references.get(entityReferenceKey(candidate.target))
        if (!source || !target) continue
        relationshipsCreated += await this.upsertEdgeInternal(investigationId, {
          source,
          target,
          relationship: candidate.relationship,
          executionId: observation.executionId,
          timestamp: observation.timestamp,
          confidence: candidate.confidence,
          metadata: { ...(candidate.metadata ?? {}), sequence: observation.sequence },
          dedupeKey:
            candidate.dedupeKey ??
            `${entityReferenceKey(candidate.source)}:${candidate.relationship}:${entityReferenceKey(candidate.target)}`,
        })
      }
    }
    if (observations.length > 0) {
      const latest = observations.reduce(
        (current, observation) => (observation.timestamp > current ? observation.timestamp : current),
        observations[0]!.timestamp,
      )
      await this.redis.eval<number>(LAST_UPDATED_MAX_SCRIPT, [this.lastUpdatedKey(investigationId)], [latest])
    }
    return { entitiesCreated, relationshipsCreated }
  }

  async getProcessedSequences(
    ownerUserId: string,
    investigationId: InvestigationId,
    executionId: string,
  ): Promise<ReadonlySet<number> | null> {
    if (!(await this.authorizedInvestigation(ownerUserId, investigationId))) return null
    const members = await this.redis.zrange<string[]>(
      graphProcessedEventIndexKey(investigationId, executionId),
      0,
      -1,
      { offset: 0, count: 100_000 },
    )
    return new Set(members.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))
  }

  async markProcessedSequence(investigationId: InvestigationId, executionId: string, sequence: number): Promise<void> {
    await this.redis.zadd(graphProcessedEventIndexKey(investigationId, executionId), {
      score: sequence,
      member: String(sequence),
    })
  }

  async summary(ownerUserId: string, investigationId: InvestigationId): Promise<EvidenceGraphSummary | null> {
    const investigation = await this.authorizedInvestigation(ownerUserId, investigationId)
    if (!investigation || investigation.status === 'deleted') return null
    // Summary is the first graph request made by the workspace.  It must be
    // self-healing even when no execution has produced observations yet or a
    // Redis restore removed only the graph objects.
    await this.ensureInvestigationRoot(investigation)
    const [entityCount, relationshipCount, entityCounts, relationshipCounts, lastUpdatedAt] = await Promise.all([
      this.redis.zcard(graphEntityIndexKey(investigationId)),
      this.redis.zcard(graphEdgeIndexKey(investigationId)),
      Promise.all(
        (
          [
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
        ).map(async (type) => [type, await this.redis.zcard(graphEntityTypeIndexKey(investigationId, type))] as const),
      ),
      Promise.all(
        (
          [
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
        ).map(
          async (relationship) =>
            [
              relationship,
              await this.redis.zcard(graphEdgeRelationshipIndexKey(investigationId, relationship)),
            ] as const,
        ),
      ),
      this.redis.get<string>(this.lastUpdatedKey(investigationId)),
    ])
    return {
      investigation,
      entityCount,
      relationshipCount,
      entitiesByType: Object.fromEntries(entityCounts),
      relationshipsByType: Object.fromEntries(relationshipCounts),
      lastUpdatedAt,
    }
  }

  async listEntities(
    ownerUserId: string,
    investigationId: InvestigationId,
    options: { readonly type?: EvidenceGraphEntityType; readonly cursor?: string | null; readonly limit?: number } = {},
  ): Promise<EvidenceGraphEntityPage | null> {
    if (!(await this.authorizedInvestigation(ownerUserId, investigationId))) return null
    const offset = safeCursor(options.cursor)
    const limit = safeLimit(options.limit, MAX_ENTITY_LIMIT)
    const ids = await this.redis.zrange<string[]>(
      options.type ? graphEntityTypeIndexKey(investigationId, options.type) : graphEntityIndexKey(investigationId),
      0,
      -1,
      { rev: true, offset, count: limit + 1 },
    )
    const entities = (await Promise.all(ids.map((id) => this.readEntity(investigationId, id)))).filter(
      (entity): entity is EvidenceGraphEntity => entity !== null,
    )
    return { entities: entities.slice(0, limit), nextCursor: entities.length > limit ? String(offset + limit) : null }
  }

  async listRelationships(
    ownerUserId: string,
    investigationId: InvestigationId,
    options: {
      readonly relationship?: EvidenceGraphRelationship
      readonly executionId?: string
      readonly cursor?: string | null
      readonly limit?: number
    } = {},
  ): Promise<EvidenceGraphRelationshipPage | null> {
    if (!(await this.authorizedInvestigation(ownerUserId, investigationId))) return null
    const offset = safeCursor(options.cursor)
    const limit = safeLimit(options.limit, MAX_RELATIONSHIP_LIMIT)
    const ids = await this.redis.zrange<string[]>(
      options.executionId
        ? graphEdgeExecutionIndexKey(investigationId, options.executionId)
        : options.relationship
        ? graphEdgeRelationshipIndexKey(investigationId, options.relationship)
        : graphEdgeIndexKey(investigationId),
      0,
      -1,
      { rev: true, offset, count: limit + 1 },
    )
    const relationships = (await Promise.all(ids.map((id) => this.readEdge(investigationId, id))))
      .filter((edge): edge is EvidenceGraphEdge => edge !== null)
      .filter((edge) => !options.relationship || edge.relationship === options.relationship)
      .filter((edge) => !options.executionId || edge.executionId === options.executionId)
    return {
      relationships: relationships.slice(0, limit),
      nextCursor: relationships.length > limit ? String(offset + limit) : null,
    }
  }

  async getEntity(
    ownerUserId: string,
    investigationId: InvestigationId,
    entityId: EvidenceGraphEntityId,
  ): Promise<EvidenceGraphEntity | null> {
    if (!(await this.authorizedInvestigation(ownerUserId, investigationId))) return null
    return this.readEntity(investigationId, entityId)
  }

  async getConnected(
    ownerUserId: string,
    investigationId: InvestigationId,
    entityId: EvidenceGraphEntityId,
    options: { readonly cursor?: string | null; readonly limit?: number } = {},
  ): Promise<EvidenceGraphConnectedPage | null> {
    if (!(await this.authorizedInvestigation(ownerUserId, investigationId))) return null
    const entity = await this.readEntity(investigationId, entityId)
    if (!entity) return null
    const offset = safeCursor(options.cursor)
    const limit = safeLimit(options.limit, MAX_CONNECTED_LIMIT)
    const [outgoing, incoming] = await Promise.all([
      this.redis.zrange<string[]>(graphEdgeSourceIndexKey(investigationId, entityId), 0, -1, {
        rev: true,
        offset: 0,
        count: offset + limit + 1,
      }),
      this.redis.zrange<string[]>(graphEdgeTargetIndexKey(investigationId, entityId), 0, -1, {
        rev: true,
        offset: 0,
        count: offset + limit + 1,
      }),
    ])
    const edgeIds = [...new Set([...outgoing, ...incoming])]
    const relationships = (await Promise.all(edgeIds.map((id) => this.readEdge(investigationId, id)))).filter(
      (edge): edge is EvidenceGraphEdge => edge !== null,
    )
    const page = relationships.slice(offset, offset + limit + 1)
    const relatedIds = page.slice(0, limit).map((edge) => (edge.source === entityId ? edge.target : edge.source))
    const entities = (
      await Promise.all([...new Set(relatedIds)].map((id) => this.readEntity(investigationId, id)))
    ).filter((related): related is EvidenceGraphEntity => related !== null)
    return {
      entity,
      relationships: page.slice(0, limit),
      entities,
      nextCursor: page.length > limit ? String(offset + limit) : null,
    }
  }

  async executionGraph(
    ownerUserId: string,
    investigationId: InvestigationId,
    executionId: string,
    options: { readonly cursor?: string | null; readonly limit?: number } = {},
  ): Promise<EvidenceGraphRelationshipPage | null> {
    return this.listRelationships(ownerUserId, investigationId, {
      executionId,
      cursor: options.cursor,
      limit: options.limit,
    })
  }

  async investigationGraph(
    ownerUserId: string,
    investigationId: InvestigationId,
  ): Promise<EvidenceGraphInvestigationView | null> {
    const summary = await this.summary(ownerUserId, investigationId)
    if (!summary) return null
    const [entities, relationships] = await Promise.all([
      this.listEntities(ownerUserId, investigationId, { limit: 100 }),
      this.listRelationships(ownerUserId, investigationId, { limit: 100 }),
    ])
    if (!entities || !relationships) return null
    return { summary, entities, relationships }
  }

  private async authorizedInvestigation(
    ownerUserId: string,
    investigationId: InvestigationId,
  ): Promise<Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'> | null> {
    try {
      return await this.authorization.getInvestigation(ownerUserId, investigationId)
    } catch {
      this.logger.warn('evidence_graph.authorization_failed', { investigationId })
      return null
    }
  }

  private async upsertEntityInternal(
    investigationId: InvestigationId,
    candidate: EvidenceGraphEntityCandidate,
    sourceExecutionId: string | null,
    timestamp: string,
  ): Promise<{ readonly id: EvidenceGraphEntityId; readonly created: boolean }> {
    const id = graphEntityId(investigationId, candidate.type, candidate.canonicalKey)
    const entity: StoredEntity = {
      id,
      investigationId,
      type: candidate.type,
      canonicalKey: normalizeGraphKey(candidate.canonicalKey),
      label: candidate.label.slice(0, 500),
      value: candidate.value === undefined ? null : candidate.value,
      metadata: candidate.metadata ?? {},
      createdAt: timestamp,
      sourceExecutionId,
    }
    try {
      const result = await this.redis.eval<number>(
        ENTITY_UPSERT_SCRIPT,
        [
          graphEntityKey(investigationId, id),
          graphEntityLookupKey(investigationId, candidate.type, candidate.canonicalKey),
          graphEntityIndexKey(investigationId),
          graphEntityTypeIndexKey(investigationId, candidate.type),
        ],
        [JSON.stringify(entity), id, String(score(timestamp))],
      )
      return { id, created: Number(result) === 1 }
    } catch (error) {
      this.logger.error('evidence_graph.entity_upsert_failed', { investigationId, entityType: candidate.type })
      throw error
    }
  }

  private async ensureInvestigationRoot(
    investigation: Pick<InvestigationRecord, 'investigationId' | 'title' | 'status'>,
  ): Promise<EvidenceGraphEntityId> {
    const id = graphEntityId(investigation.investigationId, 'investigation', investigation.investigationId)
    const entity: StoredEntity = {
      id,
      investigationId: investigation.investigationId,
      type: 'investigation',
      canonicalKey: normalizeGraphKey(investigation.investigationId),
      label: investigation.title.slice(0, 500),
      value: investigation.title,
      metadata: { status: investigation.status, parser: 'system' },
      createdAt: new Date().toISOString(),
      sourceExecutionId: null,
    }
    await this.redis.eval<number>(
      INVESTIGATION_ROOT_UPSERT_SCRIPT,
      [
        graphEntityKey(investigation.investigationId, id),
        graphEntityLookupKey(investigation.investigationId, 'investigation', investigation.investigationId),
        graphEntityIndexKey(investigation.investigationId),
        graphEntityTypeIndexKey(investigation.investigationId, 'investigation'),
      ],
      [JSON.stringify(entity), id, String(score(entity.createdAt))],
    )
    return id
  }

  private async upsertEdgeInternal(
    investigationId: InvestigationId,
    edge: {
      readonly source: EvidenceGraphEntityId
      readonly target: EvidenceGraphEntityId
      readonly relationship: EvidenceGraphRelationship
      readonly executionId: string
      readonly timestamp: string
      readonly confidence: number
      readonly metadata: EvidenceGraphMetadata
      readonly dedupeKey: string
    },
  ): Promise<number> {
    const id = graphEdgeId(
      investigationId,
      edge.source,
      edge.target,
      edge.relationship,
      edge.executionId,
      edge.dedupeKey,
    )
    const stored: EvidenceGraphEdge = {
      id,
      source: edge.source,
      target: edge.target,
      relationship: edge.relationship,
      executionId: edge.executionId,
      investigationId,
      timestamp: edge.timestamp,
      confidence: clampConfidence(edge.confidence),
      metadata: edge.metadata,
    }
    try {
      const result = await this.redis.eval<number>(
        EDGE_UPSERT_SCRIPT,
        [
          graphEdgeKey(investigationId, id),
          graphEdgeIndexKey(investigationId),
          graphEdgeSourceIndexKey(investigationId, edge.source),
          graphEdgeTargetIndexKey(investigationId, edge.target),
          graphEdgeRelationshipIndexKey(investigationId, edge.relationship),
          graphEdgeExecutionIndexKey(investigationId, edge.executionId),
        ],
        [JSON.stringify(stored), id, String(score(edge.timestamp))],
      )
      return Number(result) === 1 ? 1 : 0
    } catch (error) {
      this.logger.error('evidence_graph.edge_upsert_failed', { investigationId, relationship: edge.relationship })
      throw error
    }
  }

  private async readEntity(investigationId: InvestigationId, entityId: string): Promise<EvidenceGraphEntity | null> {
    const stored = parseJson<StoredEntity>(await this.redis.get(graphEntityKey(investigationId, entityId)))
    return stored && stored.investigationId === investigationId ? storedPublicEntity(stored) : null
  }

  private async readEdge(investigationId: InvestigationId, edgeId: string): Promise<EvidenceGraphEdge | null> {
    const edge = parseJson<EvidenceGraphEdge>(await this.redis.get(graphEdgeKey(investigationId, edgeId)))
    return edge && edge.investigationId === investigationId ? edge : null
  }

  private lastUpdatedKey(investigationId: InvestigationId): string {
    return `hexical:evidence-graph:last-updated:${investigationId}`
  }
}
