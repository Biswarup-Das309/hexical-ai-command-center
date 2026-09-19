import { randomUUID } from 'node:crypto'
import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { EngineeringStore } from '@/lib/engineering/engineering-store'
import { orchestrateEngineeringEvidence } from '@/lib/engineering/swarm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } as const

export async function POST(_request: Request, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const ownerUserId = (await auth()).userId
  if (!ownerUserId)
    return NextResponse.json(
      { ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      { status: 401, headers: HEADERS },
    )

  const { runId } = await context.params
  const store = new EngineeringStore()
  try {
    const current = await store.getRun(ownerUserId, runId)
    if (!current)
      return NextResponse.json(
        { ok: false, code: 'RUN_NOT_FOUND', message: 'Engineering run not found.' },
        { status: 404, headers: HEADERS },
      )
    if (!current.repository)
      return NextResponse.json(
        { ok: false, code: 'REPOSITORY_NOT_FOUND', message: 'Repository context not found.' },
        { status: 409, headers: HEADERS },
      )

    await store.updateRun(ownerUserId, runId, { status: 'PLANNING' })
    const orchestration = orchestrateEngineeringEvidence(current.repository, current.run.objective)
    for (const role of orchestration.roles) {
      await store.createTask(ownerUserId, {
        runId,
        role: role.role,
        objective: role.objective,
        status: role.status,
        inputContext: role.inputContext,
        findings: role.findings,
        evidence: role.evidence,
        confidence: role.confidence,
      })
      for (const roleEvidence of role.evidence) await store.createEvidence(ownerUserId, { ...roleEvidence, runId })
    }
    await store.createEvidence(ownerUserId, {
      runId,
      type: 'graph_relationship',
      certainty: 'DERIVED',
      title: 'Engineering role reconciliation',
      explanation: 'Specialized evidence roles consumed the same persisted graph and produced a bounded synthesis.',
      payload: {
        objective: orchestration.objective,
        synthesis: orchestration.synthesis,
        disagreements: [...orchestration.disagreements],
        limitations: [...orchestration.limitations],
      },
    })
    await store.updateRun(ownerUserId, runId, { status: 'COMPLETED' })

    return NextResponse.json(
      {
        ok: true,
        requestId: randomUUID(),
        runId,
        mode: 'static_repository_evidence',
        roles: orchestration.roles,
        reconciliation: {
          disagreements: orchestration.disagreements,
          synthesis: orchestration.synthesis,
          limitations: orchestration.limitations,
        },
      },
      { headers: HEADERS },
    )
  } catch (error) {
    await store
      .updateRun(ownerUserId, runId, {
        status: 'FAILED',
        errors: ['Engineering evidence roles failed.'],
      })
      .catch(() => undefined)
    console.error('[ENGINEERING_EVIDENCE_ROLES_ERROR]', {
      runId,
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return NextResponse.json(
      { ok: false, code: 'ENGINEERING_ROLES_FAILED', message: 'Engineering evidence roles could not be completed.' },
      { status: 500, headers: HEADERS },
    )
  }
}
