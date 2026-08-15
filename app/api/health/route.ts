import { NextResponse } from 'next/server'
import { requestCorrelationId } from '@/lib/hexical/telemetry'
import { createSupabaseRuntimeClient, createSupabaseRuntimeStore } from '@/lib/tty/supabase-runtime-store'
import { usesDirectTTYActivation } from '@/lib/tty/tty-execution-mode'
import type { TTYRuntimeStore } from '@/lib/tty/tty-runtime-store'
import { TTYWorkerHeartbeatService } from '@/lib/tty/tty-worker-heartbeat'
import { ttyPendingExecutionIndexKey } from '@/lib/tty/tty-worker-keys'
import { TTYWorkerRegistry } from '@/lib/tty/tty-worker-registry'

export const runtime = 'nodejs'

type HealthStatus = 'healthy' | 'unhealthy'

type HealthResult = {
  status: HealthStatus
  latencyMs?: number
  configured?: boolean
  message?: string
}

type TTYWorkerHealthResult = HealthResult & {
  mode: 'direct' | 'worker'
  registeredCount: number
  onlineCount: number
  offlineCount: number
  inactiveCount: number
}

type QueueHealthResult = HealthResult & {
  pendingCount: number
}

type AiProvider = 'groq' | 'openai' | 'anthropic'

function responseHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
}

function hasEnv(keys: string[]) {
  return keys.every((key) => Boolean(process.env[key]))
}

async function safeCheck<T extends HealthResult>(
  check: () => Promise<T>,
  timeoutMs = 1_500,
  fallback?: () => T,
): Promise<T> {
  const startedAt = Date.now()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    const result = await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('health check timeout')), timeoutMs)
      }),
    ])
    return { ...result, latencyMs: result.latencyMs ?? Date.now() - startedAt }
  } catch (err) {
    return {
      ...(fallback?.() ?? ({} as T)),
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : 'unknown error',
    } as T
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

function providerStatus(provider: AiProvider): HealthResult {
  const envMap: Record<AiProvider, string[]> = {
    groq: ['GROQ_API_KEY', 'GROQ_MAIN_MODEL'],
    openai: ['OPENAI_API_KEY', 'OPENAI_MAIN_MODEL'],
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MAIN_MODEL', 'ANTHROPIC_SWARM_MODEL'],
  }

  const configured = hasEnv(envMap[provider])

  return {
    status: configured ? 'healthy' : 'unhealthy',
    configured,
  }
}

async function checkTTYWorkers(runtimeStore: TTYRuntimeStore): Promise<TTYWorkerHealthResult> {
  if (usesDirectTTYActivation()) {
    return {
      status: 'healthy',
      configured: true,
      mode: 'direct',
      registeredCount: 0,
      onlineCount: 0,
      offlineCount: 0,
      inactiveCount: 0,
      message: 'Direct activation is enabled for this environment.',
    }
  }

  const registry = new TTYWorkerRegistry(runtimeStore)
  const heartbeat = new TTYWorkerHeartbeatService(runtimeStore, registry)
  const workers = await registry.listWorkers()
  const health = await Promise.all(
    workers.map(async (worker) => ({
      worker,
      health: worker.status === 'inactive' ? null : await heartbeat.computeWorkerHealth(worker.workerId),
    })),
  )
  const onlineCount = health.filter(({ worker, health: workerHealth }) => {
    return worker.status === 'active' && workerHealth?.state === 'online'
  }).length
  const offlineCount = health.filter(({ worker, health: workerHealth }) => {
    return worker.status === 'offline' || (worker.status === 'active' && workerHealth?.state !== 'online')
  }).length
  const inactiveCount = workers.filter((worker) => worker.status === 'inactive').length

  return {
    status: onlineCount > 0 ? 'healthy' : 'unhealthy',
    configured: true,
    mode: 'worker',
    registeredCount: workers.length,
    onlineCount,
    offlineCount,
    inactiveCount,
    ...(onlineCount === 0 ? { message: 'No online TTY execution worker is registered.' } : {}),
  }
}

async function checkPendingQueue(runtimeStore: TTYRuntimeStore): Promise<QueueHealthResult> {
  const startedAt = Date.now()
  const pending = await runtimeStore.smembers(ttyPendingExecutionIndexKey())
  return {
    status: 'healthy',
    latencyMs: Date.now() - startedAt,
    pendingCount: pending.length,
  }
}

export async function GET(request: Request) {
  const requestId = requestCorrelationId(request)
  if (!hasEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])) {
    return NextResponse.json(
      {
        requestId,
        status: 'unhealthy',
        checkedAt: new Date().toISOString(),
        runtimeBackend: {
          status: 'unhealthy',
          configured: false,
          message: 'Supabase runtime environment is missing',
        },
      },
      { status: 503, headers: responseHeaders() },
    )
  }

  const runtimeStore = createSupabaseRuntimeStore()

  const [runtimeHealth, supabaseHealth, queueCheck, ttyWorkerCheck] = await Promise.all([
    safeCheck(async () => {
      await runtimeStore.ping()
      return { status: 'healthy' as const, configured: true, message: 'Supabase Postgres runtime store is reachable.' }
    }),
    safeCheck(async () => {
      const { error } = await createSupabaseRuntimeClient().from('profiles').select('user_id', { head: true }).limit(1)

      if (error) {
        throw error
      }
      return { status: 'healthy' as const }
    }, 5_000),
    safeCheck(
      () => checkPendingQueue(runtimeStore),
      1_500,
      () => ({ status: 'unhealthy', pendingCount: 0 }),
    ),
    safeCheck(
      () => checkTTYWorkers(runtimeStore),
      1_500,
      () => ({
        status: 'unhealthy',
        mode: (usesDirectTTYActivation() ? 'direct' : 'worker') as TTYWorkerHealthResult['mode'],
        registeredCount: 0,
        onlineCount: 0,
        offlineCount: 0,
        inactiveCount: 0,
      }),
    ),
  ])

  const queueHealth = queueCheck
  const ttyWorkerHealth = ttyWorkerCheck

  const providers = {
    groq: providerStatus('groq'),
    openai: providerStatus('openai'),
    anthropic: providerStatus('anthropic'),
  }

  const allStatuses = [
    runtimeHealth.status,
    supabaseHealth.status,
    queueHealth.status,
    ttyWorkerHealth.status,
    providers.groq.status,
    providers.openai.status,
    providers.anthropic.status,
  ]

  const status: HealthStatus = allStatuses.includes('unhealthy') ? 'unhealthy' : 'healthy'

  return NextResponse.json(
    {
      requestId,
      status,
      checkedAt: new Date().toISOString(),
      runtimeBackend: {
        ...runtimeHealth,
        backend: 'supabase_postgres_realtime',
      },
      redis: {
        status: 'healthy',
        configured: false,
        message: 'Disabled for Runtime OS; no Redis calls are made by the runtime plane.',
      },
      supabase: supabaseHealth,
      queue: queueHealth,
      ttyWorker: ttyWorkerHealth,
      providers,
    },
    {
      status: status === 'healthy' ? 200 : 503,
      headers: responseHeaders(),
    },
  )
}
