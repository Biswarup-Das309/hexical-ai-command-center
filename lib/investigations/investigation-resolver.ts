import type { InvestigationStore } from './investigation-store'
import type { InvestigationHydration, InvestigationId } from './investigation-types'

/**
 * Single canonical path for resolving "does this investigation exist and is it
 * owned by this user, right now" — used by every route that needs that answer
 * (workspace hydration, session ensure/terminate, execution attach).
 *
 * Why this exists: InvestigationStore.get() reads the record directly by key
 * plus its owner check, so it is already logically identical everywhere it is
 * called. The gap this closes is *temporal*, not logical — Upstash's REST API
 * is a distributed, multi-region store, and a read issued milliseconds after a
 * write (e.g. "create investigation" immediately followed by "attach a
 * session") is not guaranteed to observe that write on every route. A
 * workspace GET a few hundred ms later almost always does; a session POST
 * racing right behind the create sometimes does not. That gap is exactly what
 * turns into "workspace shows HYDRATED ACTIVE, session POST 404s".
 *
 * The fix is a short, bounded retry on a miss only — never on a hit — so the
 * common path costs nothing and a transient miss self-heals within tens of
 * milliseconds instead of surfacing as a hard 404. If the investigation is
 * genuinely absent or not owned by this user, every attempt returns null and
 * callers correctly 404.
 */

export interface ResolveInvestigationOptions {
  readonly timelineCursor?: string | null
  readonly timelineLimit?: number
  readonly executionCursor?: string | null
  readonly executionLimit?: number
  readonly retries?: number
  readonly retryDelayMs?: number
}

export interface InvestigationResolverLogger {
  readonly onMiss?: (attempt: number, investigationId: InvestigationId) => void
  readonly onRecovered?: (attempt: number, investigationId: InvestigationId) => void
}

const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function resolveCanonicalInvestigation(
  store: Pick<InvestigationStore, 'get'>,
  ownerUserId: string,
  investigationId: InvestigationId,
  options: ResolveInvestigationOptions = {},
  logger: InvestigationResolverLogger = {},
): Promise<InvestigationHydration | null> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  const getOptions = {
    timelineCursor: options.timelineCursor,
    timelineLimit: options.timelineLimit,
    executionCursor: options.executionCursor,
    executionLimit: options.executionLimit,
  }

  let hydration = await store.get(ownerUserId, investigationId, getOptions)
  if (hydration) return hydration

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    logger.onMiss?.(attempt, investigationId)
    await sleep(retryDelayMs * attempt)
    hydration = await store.get(ownerUserId, investigationId, getOptions)
    if (hydration) {
      logger.onRecovered?.(attempt, investigationId)
      return hydration
    }
  }

  return null
}
