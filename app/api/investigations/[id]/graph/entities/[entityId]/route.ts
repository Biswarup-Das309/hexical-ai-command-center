import { createEvidenceGraphApiForRequest } from '@/lib/evidence-graph/evidence-graph-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string; entityId: string }> }): Promise<Response> {
  const { id, entityId } = await context.params
  return createEvidenceGraphApiForRequest().entity(request, id, entityId)
}
