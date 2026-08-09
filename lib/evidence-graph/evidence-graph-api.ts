import { z } from 'zod'

import type { InvestigationId } from '@/lib/investigations/investigation-types'
import type { EvidenceGraphStore } from './evidence-graph-store'
import { EVIDENCE_GRAPH_ENTITY_TYPES, EVIDENCE_GRAPH_RELATIONSHIPS } from './evidence-graph-types'
import type { EvidenceGraphEntityId, EvidenceGraphEntityType, EvidenceGraphRelationship } from './evidence-graph-types'

const ID_SCHEMA = z.string().uuid()
const ENTITY_ID_SCHEMA = z.string().regex(/^entity_[0-9a-f]{16}$/)
const EXECUTION_ID_SCHEMA = z.string().uuid()
const ENTITY_TYPE_SCHEMA = z.enum(EVIDENCE_GRAPH_ENTITY_TYPES)
const RELATIONSHIP_SCHEMA = z.enum(EVIDENCE_GRAPH_RELATIONSHIPS)
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', 'Content-Type': 'application/json' } as const

type Store = Pick<EvidenceGraphStore, 'summary' | 'listEntities' | 'listRelationships' | 'getEntity' | 'getConnected' | 'executionGraph' | 'investigationGraph'>

export interface EvidenceGraphApiDependencies {
  readonly authenticate: () => Promise<string | null>
  readonly getStore: () => Store
  readonly synchronize?: (ownerUserId: string, investigationId: InvestigationId, executionId?: string) => Promise<void>
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS })
}

function failure(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status)
}

function normalizeUserId(value: string | null): string | null {
  const normalized = value?.trim()
  return normalized && normalized.length <= 200 ? normalized : null
}

async function requireUser(dependencies: EvidenceGraphApiDependencies): Promise<string | Response> {
  const userId = normalizeUserId(await dependencies.authenticate())
  return userId ?? failure(401, 'UNAUTHENTICATED', 'Authentication is required.')
}

function parseInvestigationId(raw: string): InvestigationId | null {
  return ID_SCHEMA.safeParse(raw).success ? raw as InvestigationId : null
}

function parseEntityId(raw: string): EvidenceGraphEntityId | null {
  return ENTITY_ID_SCHEMA.safeParse(raw).success ? raw as EvidenceGraphEntityId : null
}

function emptyBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length')
  return contentLength === null || contentLength === '0'
}

function pagination(url: URL, maximum: number): { readonly cursor: string | null; readonly limit: number | undefined } | Response {
  const cursor = url.searchParams.get('cursor')
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : Number(limitRaw)
  if (cursor !== null && !/^\d+$/.test(cursor)) return failure(400, 'INVALID_PAGINATION', 'The graph cursor is invalid.')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) return failure(400, 'INVALID_PAGINATION', 'The graph page size is invalid.')
  return { cursor, limit }
}

export function createEvidenceGraphApi(dependencies: EvidenceGraphApiDependencies) {
  const hydrate = async (ownerUserId: string, investigationId: InvestigationId, executionId?: string): Promise<void> => {
    await dependencies.synchronize?.(ownerUserId, investigationId, executionId)
  }

  return {
    async graph(request: Request, rawInvestigationId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        await hydrate(user, investigationId)
        const view = await dependencies.getStore().investigationGraph(user, investigationId)
        return view ? json({ ok: true, ...view }, 200) : failure(404, 'NOT_FOUND', 'Investigation graph not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The investigation graph could not be loaded.')
      }
    },

    async summary(request: Request, rawInvestigationId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        await hydrate(user, investigationId)
        const summary = await dependencies.getStore().summary(user, investigationId)
        return summary ? json({ ok: true, summary }, 200) : failure(404, 'NOT_FOUND', 'Investigation graph not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The graph summary could not be loaded.')
      }
    },

    async entities(request: Request, rawInvestigationId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const url = new URL(request.url)
        const page = pagination(url, 100)
        if (page instanceof Response) return page
        const typeRaw = url.searchParams.get('type')
        let entityType: EvidenceGraphEntityType | undefined
        if (typeRaw !== null) {
          const parsedType = ENTITY_TYPE_SCHEMA.safeParse(typeRaw)
          if (!parsedType.success) return failure(400, 'INVALID_ENTITY_TYPE', 'The entity type is invalid.')
          entityType = parsedType.data
        }
        await hydrate(user, investigationId)
        const result = await dependencies.getStore().listEntities(user, investigationId, { type: entityType, cursor: page.cursor, limit: page.limit })
        return result ? json({ ok: true, ...result }, 200) : failure(404, 'NOT_FOUND', 'Investigation graph not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'Graph entities could not be loaded.')
      }
    },

    async relationships(request: Request, rawInvestigationId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        const url = new URL(request.url)
        const page = pagination(url, 100)
        if (page instanceof Response) return page
        const relationshipRaw = url.searchParams.get('relationship')
        let relationshipType: EvidenceGraphRelationship | undefined
        if (relationshipRaw !== null) {
          const parsedRelationship = RELATIONSHIP_SCHEMA.safeParse(relationshipRaw)
          if (!parsedRelationship.success) return failure(400, 'INVALID_RELATIONSHIP', 'The relationship is invalid.')
          relationshipType = parsedRelationship.data
        }
        const executionRaw = url.searchParams.get('executionId')
        if (executionRaw !== null && !EXECUTION_ID_SCHEMA.safeParse(executionRaw).success) return failure(400, 'INVALID_EXECUTION_ID', 'The execution identifier is invalid.')
        await hydrate(user, investigationId, executionRaw ?? undefined)
        const result = await dependencies.getStore().listRelationships(user, investigationId, { relationship: relationshipType, executionId: executionRaw ?? undefined, cursor: page.cursor, limit: page.limit })
        return result ? json({ ok: true, ...result }, 200) : failure(404, 'NOT_FOUND', 'Investigation graph not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'Graph relationships could not be loaded.')
      }
    },

    async entity(request: Request, rawInvestigationId: string, rawEntityId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        const entityId = parseEntityId(rawEntityId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        if (!entityId) return failure(400, 'INVALID_ENTITY_ID', 'The entity identifier is invalid.')
        await hydrate(user, investigationId)
        const entity = await dependencies.getStore().getEntity(user, investigationId, entityId)
        return entity ? json({ ok: true, entity }, 200) : failure(404, 'NOT_FOUND', 'Graph entity not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The graph entity could not be loaded.')
      }
    },

    async connected(request: Request, rawInvestigationId: string, rawEntityId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        const entityId = parseEntityId(rawEntityId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        if (!entityId) return failure(400, 'INVALID_ENTITY_ID', 'The entity identifier is invalid.')
        const page = pagination(new URL(request.url), 100)
        if (page instanceof Response) return page
        await hydrate(user, investigationId)
        const result = await dependencies.getStore().getConnected(user, investigationId, entityId, page)
        return result ? json({ ok: true, ...result }, 200) : failure(404, 'NOT_FOUND', 'Connected graph data not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'Connected graph data could not be loaded.')
      }
    },

    async execution(request: Request, rawInvestigationId: string, rawExecutionId: string): Promise<Response> {
      try {
        const user = await requireUser(dependencies)
        if (user instanceof Response) return user
        if (!emptyBody(request)) return failure(400, 'INVALID_INPUT', 'The request body must be empty.')
        const investigationId = parseInvestigationId(rawInvestigationId)
        if (!investigationId) return failure(400, 'INVALID_INVESTIGATION_ID', 'The investigation identifier is invalid.')
        if (!EXECUTION_ID_SCHEMA.safeParse(rawExecutionId).success) return failure(400, 'INVALID_EXECUTION_ID', 'The execution identifier is invalid.')
        const page = pagination(new URL(request.url), 100)
        if (page instanceof Response) return page
        await hydrate(user, investigationId, rawExecutionId)
        const result = await dependencies.getStore().executionGraph(user, investigationId, rawExecutionId, page)
        return result ? json({ ok: true, ...result }, 200) : failure(404, 'NOT_FOUND', 'Execution graph not found.')
      } catch {
        return failure(500, 'INTERNAL_ERROR', 'The execution graph could not be loaded.')
      }
    }
  }
}
