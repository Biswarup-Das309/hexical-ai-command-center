export interface TTYLatencySummary {
  readonly count: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))
  return sorted[index] ?? 0
}

export function summarizeTTYLatencies(values: readonly number[]): TTYLatencySummary {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right)
  return Object.freeze({
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  })
}
