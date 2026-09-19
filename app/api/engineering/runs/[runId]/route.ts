import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { EngineeringStore } from '@/lib/engineering/engineering-store'
import { runRepositoryVerification } from '@/lib/engineering/verification'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function roleProjection(task: Record<string, unknown>) {
  return {
    role: task.role,
    objective: task.objective,
    status: task.status,
    findings: asArray(task.findings),
    evidence: asArray(task.evidence).flatMap((item) => {
      const evidence = asRecord(item)
      if (!evidence || typeof evidence.title !== 'string' || typeof evidence.explanation !== 'string') return []
      return [
        {
          title: evidence.title,
          explanation: evidence.explanation,
          certainty: typeof evidence.certainty === 'string' ? evidence.certainty : 'DERIVED',
        },
      ]
    }),
    confidence: typeof task.confidence === 'number' ? task.confidence : null,
  }
}

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const ownerUserId = (await auth()).userId
  if (!ownerUserId)
    return NextResponse.json(
      { ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      { status: 401, headers: HEADERS },
    )
  const { runId } = await context.params
  try {
    const result = await new EngineeringStore().getRun(ownerUserId, runId)
    if (!result)
      return NextResponse.json(
        { ok: false, code: 'RUN_NOT_FOUND', message: 'Engineering run not found.' },
        { status: 404, headers: HEADERS },
      )

    const roleNames = new Set(['ARCHITECT', 'SECURITY_ENGINEER', 'TEST_ENGINEER'])
    const roles = result.tasks
      .filter((task) => roleNames.has(task.role))
      .map((task) => roleProjection(task as unknown as Record<string, unknown>))
    const reconciliationEvidence = result.evidence.find(
      (evidence) => evidence.title === 'Engineering role reconciliation',
    )
    const reconciliationPayload = asRecord(reconciliationEvidence?.payload)
    const reconciliation = reconciliationPayload
      ? {
          disagreements: asArray(reconciliationPayload.disagreements).filter(
            (value): value is string => typeof value === 'string',
          ),
          synthesis: asRecord(reconciliationPayload.synthesis) ?? {},
          limitations: asArray(reconciliationPayload.limitations).filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : null
    const verificationTask = result.tasks.find((task) => task.role === 'VERIFICATION_ENGINEER')
    const verificationFindings = asArray(verificationTask?.findings)
      .map(asRecord)
      .filter((finding): finding is Record<string, unknown> => finding !== null)
    const verification =
      result.run.verification_status && result.repository
        ? runRepositoryVerification(
            result.repository,
            result.run.id,
            result.repository.files.map((file) => file.path),
            ['diff', 'graph_consistency', 'security', 'tests', 'typecheck', 'lint', 'build'],
          )
        : result.run.verification_status
        ? {
            status: result.run.verification_status,
            correlationId: result.run.correlation_id,
            checks: verificationFindings,
            impact: [],
            errors: [],
            startedAt: result.run.created_at,
            completedAt: result.run.updated_at,
          }
        : null

    return NextResponse.json(
      {
        ok: true,
        run: {
          id: result.run.id,
          repositoryId: result.run.repository_id,
          objective: result.run.objective,
          status: result.run.status,
          verificationStatus: result.run.verification_status,
          correlationId: result.run.correlation_id,
          createdAt: result.run.created_at,
          updatedAt: result.run.updated_at,
        },
        tasks: result.tasks,
        evidence: result.evidence,
        repository: result.repository,
        verification,
        roles,
        reconciliation,
      },
      { headers: HEADERS },
    )
  } catch (error) {
    console.error('[ENGINEERING_RUN_READ_ERROR]', {
      runId,
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return NextResponse.json(
      { ok: false, code: 'RUN_READ_FAILED', message: 'Engineering run could not be read.' },
      { status: 500, headers: HEADERS },
    )
  }
}
