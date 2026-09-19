import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/database.types'
import { createSupabaseAdminClient } from '@/lib/supabase-admin-runtime'
import type {
  EngineeringRunStatus,
  EngineeringTaskStatus,
  EngineeringVerificationResult,
  EvidenceRecord,
  RepositoryGraph,
  RepositoryNode,
  RepositoryEdge,
  VerificationStatus,
} from './types'

type Client = SupabaseClient<Database>

function asJson(value: unknown): Json {
  return value as Json
}

function requireData<T>(data: T | null, error: { message?: string } | null, label: string): T {
  if (error) throw new Error(`${label}: ${error.message ?? 'database request failed'}`)
  if (!data) throw new Error(`${label}: no record returned`)
  return data
}

export class EngineeringStore {
  constructor(private readonly client: Client = createSupabaseAdminClient()) {}

  async createRepository(ownerUserId: string, graph: RepositoryGraph): Promise<string> {
    const contextResult = await this.client
      .from('hexical_repository_contexts')
      .insert({
        owner_user_id: ownerUserId,
        repository_key: graph.repositoryKey,
        root: graph.root,
        status: 'ready',
        summary: asJson(graph.summary),
        limitations: asJson(graph.limitations),
        file_count: graph.summary.fileCount,
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
      })
      .select('id')
      .single()
    const context = requireData(contextResult.data, contextResult.error, 'repository context insert')
    const repositoryId = context.id

    const nodes = graph.nodes.map((node) => ({
      repository_id: repositoryId,
      owner_user_id: ownerUserId,
      node_id: node.id,
      kind: node.kind,
      node_key: node.key,
      name: node.name,
      path: node.path,
      language: node.language ?? null,
      metadata: asJson(node.metadata),
    }))
    const edges = graph.edges.map((edge) => ({
      repository_id: repositoryId,
      owner_user_id: ownerUserId,
      edge_id: edge.id,
      source_node_id: edge.source,
      target_node_id: edge.target,
      relation: edge.relation,
      direct: edge.direct,
      confidence: edge.confidence,
      evidence: asJson(edge.evidence),
    }))
    if (nodes.length > 0) {
      const { error } = await this.client.from('hexical_repository_nodes').insert(nodes)
      if (error) throw new Error(`repository node insert: ${error.message}`)
    }
    if (edges.length > 0) {
      const { error } = await this.client.from('hexical_repository_edges').insert(edges)
      if (error) throw new Error(`repository edge insert: ${error.message}`)
    }
    return repositoryId
  }

  async createRun(ownerUserId: string, input: { repositoryId: string; objective: string; correlationId: string }) {
    const result = await this.client
      .from('hexical_engineering_runs')
      .insert({
        owner_user_id: ownerUserId,
        repository_id: input.repositoryId,
        objective: input.objective,
        status: 'ANALYZING',
        verification_status: null,
        correlation_id: input.correlationId,
      })
      .select('*')
      .single()
    return requireData(result.data, result.error, 'engineering run insert')
  }

  async updateRun(
    ownerUserId: string,
    runId: string,
    fields: {
      status?: EngineeringRunStatus
      verificationStatus?: VerificationStatus | null
      errors?: readonly string[]
    },
  ) {
    const result = await this.client
      .from('hexical_engineering_runs')
      .update({
        ...(fields.status ? { status: fields.status } : {}),
        ...(fields.verificationStatus !== undefined ? { verification_status: fields.verificationStatus } : {}),
        ...(fields.errors ? { errors: asJson(fields.errors) } : {}),
      })
      .eq('id', runId)
      .eq('owner_user_id', ownerUserId)
      .select('*')
      .maybeSingle()
    return result.data
  }

  async createTask(
    ownerUserId: string,
    input: {
      runId: string
      role: string
      objective: string
      status: EngineeringTaskStatus
      inputContext?: unknown
      findings?: unknown
      evidence?: unknown
      confidence?: number | null
      error?: string | null
    },
  ) {
    const result = await this.client
      .from('hexical_engineering_tasks')
      .insert({
        run_id: input.runId,
        owner_user_id: ownerUserId,
        role: input.role,
        objective: input.objective,
        status: input.status,
        input_context: asJson(input.inputContext ?? {}),
        findings: asJson(input.findings ?? []),
        evidence: asJson(input.evidence ?? []),
        confidence: input.confidence ?? null,
        error: input.error ?? null,
        started_at: input.status === 'RUNNING' || input.status === 'COMPLETED' ? new Date().toISOString() : null,
        completed_at:
          input.status === 'COMPLETED' || input.status === 'FAILED' || input.status === 'BLOCKED'
            ? new Date().toISOString()
            : null,
      })
      .select('*')
      .single()
    return requireData(result.data, result.error, 'engineering task insert')
  }

  async createEvidence(ownerUserId: string, evidence: EvidenceRecord): Promise<void> {
    const { error } = await this.client.from('hexical_engineering_evidence').insert({
      run_id: evidence.runId,
      owner_user_id: ownerUserId,
      evidence_type: evidence.type,
      certainty: evidence.certainty,
      title: evidence.title,
      explanation: evidence.explanation,
      source: asJson(evidence.source ?? null),
      payload: asJson(evidence.payload ?? null),
    })
    if (error) throw new Error(`engineering evidence insert: ${error.message}`)
  }

  async createVerificationEvidence(
    ownerUserId: string,
    runId: string,
    result: EngineeringVerificationResult,
  ): Promise<void> {
    for (const check of result.checks) {
      for (const evidence of check.evidence) await this.createEvidence(ownerUserId, { ...evidence, runId })
      if (check.blockedReason) {
        await this.createEvidence(ownerUserId, {
          runId,
          type: 'test_result',
          certainty: 'OBSERVED',
          title: `${check.check} blocked`,
          explanation: check.blockedReason,
          payload: { status: check.status, durationMs: check.durationMs },
        })
      }
    }
    for (const impact of result.impact) {
      for (const item of impact.items) {
        for (const edgeEvidence of item.evidence) {
          await this.createEvidence(ownerUserId, {
            runId,
            type: 'graph_relationship',
            certainty: edgeEvidence.certainty,
            title: `Impact: ${item.item}`,
            explanation: `${item.reason} Confidence: ${item.confidence}.`,
            source: edgeEvidence.source,
          })
        }
      }
    }
  }

  async getRun(ownerUserId: string, runId: string) {
    const runResult = await this.client
      .from('hexical_engineering_runs')
      .select('*')
      .eq('id', runId)
      .eq('owner_user_id', ownerUserId)
      .maybeSingle()
    if (runResult.error) throw new Error(`engineering run read: ${runResult.error.message}`)
    if (!runResult.data) return null

    const [tasks, evidence, context] = await Promise.all([
      this.client
        .from('hexical_engineering_tasks')
        .select('*')
        .eq('run_id', runId)
        .eq('owner_user_id', ownerUserId)
        .order('created_at', { ascending: true }),
      this.client
        .from('hexical_engineering_evidence')
        .select('*')
        .eq('run_id', runId)
        .eq('owner_user_id', ownerUserId)
        .order('created_at', { ascending: true }),
      this.getRepository(ownerUserId, runResult.data.repository_id),
    ])
    if (tasks.error) throw new Error(`engineering task read: ${tasks.error.message}`)
    if (evidence.error) throw new Error(`engineering evidence read: ${evidence.error.message}`)
    return { run: runResult.data, tasks: tasks.data ?? [], evidence: evidence.data ?? [], repository: context }
  }

  async getRepository(ownerUserId: string, repositoryId: string): Promise<RepositoryGraph | null> {
    const context = await this.client
      .from('hexical_repository_contexts')
      .select('*')
      .eq('id', repositoryId)
      .eq('owner_user_id', ownerUserId)
      .maybeSingle()
    if (context.error) throw new Error(`repository context read: ${context.error.message}`)
    if (!context.data) return null
    const [nodes, edges] = await Promise.all([
      this.client
        .from('hexical_repository_nodes')
        .select('*')
        .eq('repository_id', repositoryId)
        .eq('owner_user_id', ownerUserId),
      this.client
        .from('hexical_repository_edges')
        .select('*')
        .eq('repository_id', repositoryId)
        .eq('owner_user_id', ownerUserId),
    ])
    if (nodes.error) throw new Error(`repository node read: ${nodes.error.message}`)
    if (edges.error) throw new Error(`repository edge read: ${edges.error.message}`)
    const persistedNodes = nodes.data ?? []
    const files = persistedNodes
      .filter((node) => ['file', 'test', 'configuration'].includes(node.kind) && node.path)
      .map((node) => {
        const metadata = (node.metadata ?? {}) as Record<string, unknown>
        return {
          path: node.path!,
          language: node.language ?? 'unknown',
          bytes: typeof metadata.bytes === 'number' ? metadata.bytes : 0,
          digest: typeof metadata.digest === 'string' ? metadata.digest : '',
          securitySignals: Array.isArray(metadata.securitySignals)
            ? metadata.securitySignals.filter((value): value is string => typeof value === 'string')
            : [],
        }
      })
    return {
      repositoryKey: context.data.repository_key,
      root: context.data.root,
      generatedAt: context.data.created_at,
      files,
      nodes: persistedNodes.map((node) => ({
        id: node.node_id,
        kind: node.kind as RepositoryNode['kind'],
        key: node.node_key,
        name: node.name,
        path: node.path,
        language: node.language ?? undefined,
        metadata: (node.metadata ?? {}) as Readonly<Record<string, Json>>,
      })),
      edges: (edges.data ?? []).map((edge) => ({
        id: edge.edge_id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        relation: edge.relation as RepositoryEdge['relation'],
        direct: edge.direct,
        confidence: edge.confidence as RepositoryEdge['confidence'],
        evidence: edge.evidence as unknown as RepositoryEdge['evidence'],
      })),
      summary: (context.data.summary ?? {}) as unknown as RepositoryGraph['summary'],
      limitations: (context.data.limitations ?? []) as unknown as string[],
    }
  }
}
