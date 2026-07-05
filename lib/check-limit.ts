import { PLAN_LIMITS, PlanTier } from './plans'

export function assertLimit(
  tier: PlanTier,
  usage: { messages: number; tokens: number },
  inputChars: number
) {
  const limit = PLAN_LIMITS[tier]

  if (usage.messages >= limit.maxMessages) {
    throw new Error('MESSAGE_LIMIT_EXCEEDED')
  }

  if (usage.tokens >= limit.monthlyTokenBudget) {
    throw new Error('TOKEN_LIMIT_EXCEEDED')
  }

  if (inputChars > limit.maxCharsPerRequest) {
    throw new Error('INPUT_TOO_LARGE')
  }
}