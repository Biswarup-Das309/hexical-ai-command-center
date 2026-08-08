export function computeLeaseAge(claimedAtMs: number, nowMs: number = Date.now()): number {
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(nowMs)) return 0
  return Math.max(0, nowMs - claimedAtMs)
}
