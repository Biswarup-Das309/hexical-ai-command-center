import { createInvestigationApiForRequest } from '@/lib/investigations/investigation-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; noteId: string }> },
): Promise<Response> {
  const { id, noteId } = await context.params
  return createInvestigationApiForRequest().patchNote(request, id, noteId)
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; noteId: string }> },
): Promise<Response> {
  const { id, noteId } = await context.params
  return createInvestigationApiForRequest().deleteNote(request, id, noteId)
}
