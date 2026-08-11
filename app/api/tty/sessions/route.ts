import { createTTYLifecycleApiForRequest } from '@/lib/tty/tty-lifecycle-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return createTTYLifecycleApiForRequest().list(request)
}

export async function POST(request: Request): Promise<Response> {
  return createTTYLifecycleApiForRequest().create(request)
}
