import { randomUUID } from 'node:crypto'
import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { EngineeringStore } from '@/lib/engineering/engineering-store'
import { buildRepositoryGraph } from '@/lib/engineering/repository-graph'
import { REPOSITORY_MAX_FILE_BYTES, REPOSITORY_MAX_FILES, REPOSITORY_MAX_TOTAL_BYTES } from '@/lib/engineering/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REQUEST_BYTES = REPOSITORY_MAX_TOTAL_BYTES + 256_000
const INPUT_SCHEMA = z
  .object({
    objective: z.string().trim().min(1).max(2_000),
    repository: z
      .object({
        repositoryKey: z.string().trim().min(1).max(200),
        root: z.string().trim().max(500).optional(),
        files: z
          .array(
            z.object({ path: z.string().min(1).max(512), content: z.string().max(REPOSITORY_MAX_FILE_BYTES) }).strict(),
          )
          .min(1)
          .max(REPOSITORY_MAX_FILES),
      })
      .strict(),
  })
  .strict()

const HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } as const

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: HEADERS })
}

export async function GET(): Promise<NextResponse> {
  const ownerUserId = (await auth()).userId
  if (!ownerUserId) return json({ ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401)

  try {
    const runs = await new EngineeringStore().listRuns(ownerUserId)
    return json({ ok: true, runs })
  } catch (error) {
    console.error('[ENGINEERING_RUN_LIST_ERROR]', {
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return json({ ok: false, code: 'RUN_LIST_FAILED', message: 'Engineering runs could not be loaded.' }, 500)
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomUUID()
  const ownerUserId = (await auth()).userId
  if (!ownerUserId) return json({ ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401)

  const declaredLength = request.headers.get('content-length')
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    return json({ ok: false, code: 'REQUEST_TOO_LARGE', message: 'The repository snapshot is too large.' }, 413)
  }

  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return json({ ok: false, code: 'REQUEST_TOO_LARGE', message: 'The repository snapshot is too large.' }, 413)
    }
    const parsed = INPUT_SCHEMA.safeParse(JSON.parse(raw))
    if (!parsed.success)
      return json(
        { ok: false, code: 'INVALID_REPOSITORY_SNAPSHOT', message: 'The repository snapshot is invalid.' },
        400,
      )

    const graph = buildRepositoryGraph(parsed.data.repository)
    const store = new EngineeringStore()
    const repositoryId = await store.createRepository(ownerUserId, graph)
    const run = await store.createRun(ownerUserId, {
      repositoryId,
      objective: parsed.data.objective,
      correlationId: requestId,
    })
    const unknownPenalty = graph.summary.unknownDependencyCount > 0 ? 20 : 0
    await store.createTask(ownerUserId, {
      runId: run.id,
      role: 'REPOSITORY_ANALYST',
      objective: 'Normalize the submitted repository snapshot and produce traceable graph relationships.',
      status: 'COMPLETED',
      findings: [graph.summary, ...graph.limitations],
      confidence: Math.max(0, 100 - unknownPenalty),
    })
    await store.createEvidence(ownerUserId, {
      runId: run.id,
      type: 'source_file',
      certainty: 'OBSERVED',
      title: 'Repository snapshot received',
      explanation: `Analyzed ${graph.summary.fileCount} submitted files without persisting source bodies.`,
      payload: {
        repositoryKey: graph.repositoryKey,
        summary: graph.summary as unknown as import('@/lib/database.types').Json,
      },
    })
    await store.createEvidence(ownerUserId, {
      runId: run.id,
      type: 'graph_relationship',
      certainty: graph.summary.unknownDependencyCount > 0 ? 'INFERRED' : 'OBSERVED',
      title: 'Normalized repository graph',
      explanation: `Built ${graph.nodes.length} nodes and ${graph.edges.length} relationships.`,
      payload: { limitations: graph.limitations as unknown as import('@/lib/database.types').Json },
    })
    await store.updateRun(ownerUserId, run.id, { status: 'COMPLETED' })

    return json(
      {
        ok: true,
        requestId,
        runId: run.id,
        repositoryId,
        status: 'COMPLETED',
        summary: graph.summary,
        limitations: graph.limitations,
      },
      201,
    )
  } catch (error) {
    console.error('[ENGINEERING_REPOSITORY_INGESTION_ERROR]', {
      requestId,
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return json(
      {
        ok: false,
        code: 'REPOSITORY_INGESTION_FAILED',
        message: 'Repository analysis could not be completed.',
        requestId,
      },
      500,
    )
  }
}
