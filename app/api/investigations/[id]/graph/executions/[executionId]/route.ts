import { createEvidenceGraphApiForRequest } from '@/lib/evidence-graph/evidence-graph-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; executionId: string }> },
): Promise<Response> {
  const { id, executionId } = await context.params
  return createEvidenceGraphApiForRequest().execution(request, id, executionId)
}
