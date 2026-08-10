/**
 * In-process activation metrics: a bounded rolling sample of activation
 * latencies (for p50/p95/p99) plus counters for the two distinct "slow"
 * signals that matter operationally:
 *
 *  - timeoutCount: activateTTYExecution() itself never settled within its own
 *    hard ceiling (DEFAULT_ACTIVATION_TIMEOUT_MS). This is the "genuinely
 *    stuck coordinator" signal.
 *  - pendingCount / lateSettlementCount: the HTTP response budget elapsed
 *    before activation settled, so the caller returned 202 activationPending.
 *    lateSettlementCount, split by accepted/rejected, tells you whether those
 *    pending activations are healthy-but-slow (mostly settle accepted a
 *    moment later) or actually stuck (mostly time out too, or never settle).
 *
 * This is process-local, not a durable metrics backend — on serverless it
 * resets per cold start. It is meant to be cheap enough to read on every
 * request (e.g. from a health/diagnostics route) without external dependencies,
 * not to replace a real metrics pipeline if one exists downstream of the logs.
 */

const MAX_SAMPLES = 500

interface ActivationMetricsState {
  readonly latenciesMs: number[]
  timeoutCount: number
  pendingCount: number
  lateSettledAcceptedCount: number
  lateSettledRejectedCount: number
  lateSettledErrorCount: number
}

function initialState(): ActivationMetricsState {
  return { latenciesMs: [], timeoutCount: 0, pendingCount: 0, lateSettledAcceptedCount: 0, lateSettledRejectedCount: 0, lateSettledErrorCount: 0 }
}

let state: ActivationMetricsState = initialState()

export function recordActivationLatency(ms: number): void {
  state.latenciesMs.push(ms)
  if (state.latenciesMs.length > MAX_SAMPLES) state.latenciesMs.shift()
}

export function recordActivationTimeout(): void {
  state.timeoutCount += 1
}

export function recordActivationPending(): void {
  state.pendingCount += 1
}

export function recordActivationLateSettlement(outcome: 'accepted' | 'rejected' | 'error'): void {
  if (outcome === 'accepted') state.lateSettledAcceptedCount += 1
  else if (outcome === 'rejected') state.lateSettledRejectedCount += 1
  else state.lateSettledErrorCount += 1
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

export interface ActivationMetricsSnapshot {
  readonly sampleCount: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly p99Ms: number | null
  readonly timeoutCount: number
  readonly pendingCount: number
  readonly lateSettledAcceptedCount: number
  readonly lateSettledRejectedCount: number
  readonly lateSettledErrorCount: number
}

export function snapshotActivationMetrics(): ActivationMetricsSnapshot {
  const sorted = [...state.latenciesMs].sort((a, b) => a - b)
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    timeoutCount: state.timeoutCount,
    pendingCount: state.pendingCount,
    lateSettledAcceptedCount: state.lateSettledAcceptedCount,
    lateSettledRejectedCount: state.lateSettledRejectedCount,
    lateSettledErrorCount: state.lateSettledErrorCount
  }
}

/** Test-only: reset all counters/samples between test cases. */
export function resetActivationMetricsForTests(): void {
  state = initialState()
}