import { createInvestigationExecutionApiForRequest } from '@/lib/investigations/investigation-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationExecutionApiForRequest().attach(request, id)
}
