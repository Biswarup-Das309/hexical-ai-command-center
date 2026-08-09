import { createInvestigationApiForRequest } from '@/lib/investigations/investigation-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationApiForRequest().get(request, id)
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationApiForRequest().patch(request, id)
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return createInvestigationApiForRequest().delete(request, id)
}
