import { randomUUID } from 'node:crypto'
import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { EngineeringStore } from '@/lib/engineering/engineering-store'
import { runRepositoryVerification } from '@/lib/engineering/verification'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SCHEMA = z
  .object({
    changedPaths: z.array(z.string().trim().min(1).max(512)).max(50).default([]),
    checks: z
      .array(z.enum(['diff', 'graph_consistency', 'security', 'tests', 'typecheck', 'lint', 'build']))
      .max(7)
      .default(['graph_consistency', 'security']),
  })
  .strict()

const HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' } as const

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const ownerUserId = (await auth()).userId
  if (!ownerUserId)
    return NextResponse.json(
      { ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      { status: 401, headers: HEADERS },
    )
  const { runId } = await context.params
  try {
    const parsed = SCHEMA.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success)
      return NextResponse.json(
        { ok: false, code: 'INVALID_VERIFICATION_REQUEST', message: 'Verification options are invalid.' },
        { status: 400, headers: HEADERS },
      )
    const store = new EngineeringStore()
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

    await store.updateRun(ownerUserId, runId, { status: 'VERIFYING' })
    const result = runRepositoryVerification(current.repository, runId, parsed.data.changedPaths, parsed.data.checks)
    await store.createTask(ownerUserId, {
      runId,
      role: 'VERIFICATION_ENGINEER',
      objective: 'Run supported repository checks and identify checks that require a connected checkout.',
      status: result.status === 'FAILED' ? 'FAILED' : result.status === 'BLOCKED' ? 'BLOCKED' : 'COMPLETED',
      findings: result.checks.map((check) => ({ check: check.check, status: check.status, summary: check.summary })),
      confidence: result.status === 'VERIFIED' ? 100 : result.status === 'PARTIALLY_VERIFIED' ? 70 : null,
      error: result.errors.length > 0 ? result.errors.join('; ') : null,
    })
    await store.createVerificationEvidence(ownerUserId, runId, result)
    await store.updateRun(ownerUserId, runId, {
      status: result.status === 'BLOCKED' ? 'BLOCKED' : result.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
      verificationStatus: result.status,
      errors: result.errors,
    })

    return NextResponse.json({ ok: true, requestId: randomUUID(), result }, { headers: HEADERS })
  } catch (error) {
    console.error('[ENGINEERING_VERIFICATION_ERROR]', {
      runId,
      error: error instanceof Error ? error.name : 'unknown_error',
    })
    return NextResponse.json(
      { ok: false, code: 'VERIFICATION_FAILED', message: 'Engineering verification could not be completed.' },
      { status: 500, headers: HEADERS },
    )
  }
}
