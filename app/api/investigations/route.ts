import { createInvestigationApiForRequest } from '@/lib/investigations/investigation-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return createInvestigationApiForRequest().create(request)
}

export async function GET(request: Request): Promise<Response> {
  return createInvestigationApiForRequest().list(request)
}
