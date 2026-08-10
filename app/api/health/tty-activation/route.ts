import { NextResponse } from 'next/server'

import { snapshotActivationMetrics } from '@/lib/tty/tty-activation-metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function responseHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache',
    'X-Content-Type-Options': 'nosniff'
  }
}

/**
 * Process-local snapshot of activation latency (p50/p95/p99), the activator's
 * own hard-timeout count, and the response-budget pending/late-settlement
 * counters. Resets on cold start, same caveat as any in-memory metric on
 * serverless — treat this as "what has this warm instance seen recently,"
 * not a durable time series. Correlate with the structured
 * tty.activation.* / *.execution_activation_* log lines for anything that
 * needs to survive a cold start or be aggregated across instances.
 */
export async function GET() {
  return NextResponse.json(
    { checkedAt: new Date().toISOString(), activation: snapshotActivationMetrics() },
    { status: 200, headers: responseHeaders() }
  )
}