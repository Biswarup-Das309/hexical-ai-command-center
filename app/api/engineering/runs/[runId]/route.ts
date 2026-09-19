import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { EngineeringStore } from '@/lib/engineering/engineering-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } as const

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
