import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { requestCorrelationId } from '@/lib/hexical/telemetry';

export const runtime = 'nodejs';

type HealthStatus = 'healthy' | 'unhealthy';

type HealthResult = {
  status: HealthStatus;
  latencyMs?: number;
  configured?: boolean;
  message?: string;
};

type AiProvider = 'groq' | 'openai' | 'anthropic';

function responseHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
}

function hasEnv(keys: string[]) {
  return keys.every((key) => Boolean(process.env[key]));
}

async function safeCheck(check: () => Promise<unknown>, timeoutMs = 1_500): Promise<HealthResult> {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('health check timeout')), timeoutMs);
      }),
    ]);
    return {
      status: 'healthy',
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : 'unknown error',
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function providerStatus(provider: AiProvider): HealthResult {
  const envMap: Record<AiProvider, string[]> = {
    groq: ['GROQ_API_KEY', 'GROQ_MAIN_MODEL'],
    openai: ['OPENAI_API_KEY', 'OPENAI_MAIN_MODEL'],
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MAIN_MODEL', 'ANTHROPIC_SWARM_MODEL'],
  };

  const configured = hasEnv(envMap[provider]);

  return {
    status: configured ? 'healthy' : 'unhealthy',
    configured,
  };
}

export async function GET(request: Request) {
  const requestId = requestCorrelationId(request);
  if (!hasEnv(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'])) {
    return NextResponse.json(
      {
        requestId,
        status: 'unhealthy',
        checkedAt: new Date().toISOString(),
        redis: {
          status: 'unhealthy',
          configured: false,
          message: 'Redis env missing',
        },
      },
      { status: 503, headers: responseHeaders() },
    );
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const [redisHealth, supabaseHealth, queueHealth] = await Promise.all([
    safeCheck(async () => {
      await redis.ping();
    }),
    safeCheck(async () => {
      if (!hasEnv(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])) {
        throw new Error('Supabase env missing');
      }

      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );

      const { error } = await supabase
        .from('usage_events')
        .select('id', { head: true })
        .limit(1);

      if (error) {
        throw error;
      }
    }),
    safeCheck(async () => {
      await redis.llen('queue:hexical:execution');
    }),
  ]);

  const providers = {
    groq: providerStatus('groq'),
    openai: providerStatus('openai'),
    anthropic: providerStatus('anthropic'),
  };

  const allStatuses = [
    redisHealth.status,
    supabaseHealth.status,
    queueHealth.status,
    providers.groq.status,
    providers.openai.status,
    providers.anthropic.status,
  ];

  const status: HealthStatus = allStatuses.includes('unhealthy') ? 'unhealthy' : 'healthy';

  return NextResponse.json(
      {
        requestId,
        status,
      checkedAt: new Date().toISOString(),
      redis: redisHealth,
      supabase: supabaseHealth,
      queue: queueHealth,
      providers,
    },
    {
      status: status === 'healthy' ? 200 : 503,
      headers: responseHeaders(),
    },
  );
}
