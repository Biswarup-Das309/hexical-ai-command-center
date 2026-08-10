import { recordActivationLateSettlement, recordActivationPending } from './tty-activation-metrics'

export interface ActivationBudgetLogger {
  readonly onRequested?: () => void
  readonly onPending?: (budgetMs: number) => void
  readonly onSettledLate?: (result: { readonly accepted: boolean; readonly reason?: string }) => void
  readonly onErroredLate?: (message: string) => void
  readonly onRejected?: (reason: string | undefined) => void
  readonly onAccepted?: () => void
}

export type ActivationBudgetResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason?: string }
  | { readonly kind: 'pending' }

const DEFAULT_ACTIVATION_RESPONSE_BUDGET_MS = 3000

/**
 * Races a short response budget against an in-flight activation instead of
 * blocking the caller's HTTP response on full coordinator acceptance. This is
 * the one implementation both the investigation execution API and the direct
 * TTY admission API call, so a stalled activation degrades the same way
 * (202 pending, never abandoned, latency and outcome always logged) no matter
 * which endpoint triggered it.
 *
 * Fast outcomes (accept, or a fast-fail reason like resource_denied /
 * session_terminated / invalid_job) are almost always inside the budget and
 * still resolve synchronously with the real result. A stall past the budget
 * resolves as 'pending' — the underlying promise keeps running regardless,
 * and its eventual settlement (or error) is reported via onSettledLate /
 * onErroredLate and recorded in activation metrics, so a "pending" response
 * can later be distinguished as healthy-but-slow vs. genuinely stuck.
 */
export async function raceActivationBudget(
  startExecution: () => Promise<{ readonly accepted: boolean; readonly reason?: string }>,
  budgetMs: number = DEFAULT_ACTIVATION_RESPONSE_BUDGET_MS,
  logger: ActivationBudgetLogger = {}
): Promise<ActivationBudgetResult> {
  logger.onRequested?.()
  const pending = startExecution()

  const budgetResult = await Promise.race([
    pending.then(result => ({ kind: 'settled' as const, result })),
    new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), budgetMs))
  ])

  if (budgetResult.kind === 'timeout') {
    recordActivationPending()
    logger.onPending?.(budgetMs)
    void pending
      .then(result => {
        recordActivationLateSettlement(result.accepted ? 'accepted' : 'rejected')
        logger.onSettledLate?.(result)
      })
      .catch(error => {
        recordActivationLateSettlement('error')
        logger.onErroredLate?.(error instanceof Error ? error.message : String(error))
      })
    return { kind: 'pending' }
  }

  // A response without a definitive reason is an indeterminate activation,
  // not a safe synchronous rejection. Keep the durable job pending and
  // observe the late result instead of returning a misleading 503.
  if (!budgetResult.result.accepted && budgetResult.result.reason === undefined) {
    recordActivationPending()
    logger.onPending?.(budgetMs)
    void pending
      .then(result => {
        recordActivationLateSettlement(result.accepted ? 'accepted' : 'rejected')
        logger.onSettledLate?.(result)
      })
      .catch(error => {
        recordActivationLateSettlement('error')
        logger.onErroredLate?.(error instanceof Error ? error.message : String(error))
      })
    return { kind: 'pending' }
  }

  if (!budgetResult.result.accepted) {
    logger.onRejected?.(budgetResult.result.reason)
    return { kind: 'rejected', reason: budgetResult.result.reason }
  }

  logger.onAccepted?.()
  return { kind: 'accepted' }
}
