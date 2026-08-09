import { createEvidenceGraphApiForRequest } from '@/lib/evidence-graph/evidence-graph-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createEvidenceGraphApiForRequest().relationships(request, id)
}
