import { createInvestigationSessionApiForRequest } from '@/lib/investigations/investigation-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationSessionApiForRequest().ensure(request, id)
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationSessionApiForRequest().terminate(request, id)
}
