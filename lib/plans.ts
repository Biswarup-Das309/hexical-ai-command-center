export type PlanTier = 'free' | 'go' | 'plus' | 'pro'

export type PlanCapability =
  | 'basic_ast'
  | 'core_heuristics'
  | 'standard_support'
  | 'interactive_topology'
  | 'bounty_forge'
  | 'swarm_intelligence'
  | 'advanced_terminal'
  | 'pdf_export'

export type PlanFeatureIcon =
  | 'activity'
  | 'crosshair'
  | 'fileBadge'
  | 'fileJson'
  | 'gitMerge'
  | 'network'
  | 'shield'
  | 'sparkles'
  | 'target'
  | 'terminal'
  | 'zap'

export type PlanFeatureTone = 'accent' | 'muted'

export type PlanFeatureCopy = {
  icon: PlanFeatureIcon
  tone: PlanFeatureTone
  text: string
}

export type PlanLimitConfig = {
  priceId: string
  pricePaise: number
  monthlyTokenBudget: number
  /**
   * Message allowance for a rolling window, NOT a calendar month.
   * A user's window starts on their first message and lasts
   * `messageWindowHours`; once it elapses, the next message starts a
   * fresh window with a full `maxMessages` allowance again.
   * Must stay in sync with MESSAGE_QUOTA_LIMITS / MESSAGE_QUOTA_WINDOW_SECS
   * in app/api/verify/route.ts, which is what actually enforces this.
   */
  maxMessages: number
  messageWindowHours: number
  maxCharsPerRequest: number
  requestsPerMinute: number
  capabilities: readonly PlanCapability[]
}

export type PlanDisplayConfig = {
  tier: PlanTier
  name: string
  checkoutName?: 'Go' | 'Plus' | 'Pro'
  priceLabel: string
  description: string
  badge?: string
  includesLabel?: string
  features: readonly PlanFeatureCopy[]
}

export const PLAN_ORDER: readonly PlanTier[] = ['free', 'go', 'plus', 'pro']

const RUPEE = '\u20b9'

export const PLAN_LIMITS: Record<PlanTier, PlanLimitConfig> = {
  free: {
    priceId: '',
    pricePaise: 0,
    monthlyTokenBudget: 2_000_000,
    maxMessages: 20,
    messageWindowHours: 5,
    maxCharsPerRequest: 10_000,
    requestsPerMinute: 20,
    capabilities: ['basic_ast', 'core_heuristics'],
  },
  go: {
    priceId: 'price_go_299',
    pricePaise: 299 * 100,
    monthlyTokenBudget: 20_000_000,
    maxMessages: 35,
    messageWindowHours: 5,
    maxCharsPerRequest: 15_000,
    requestsPerMinute: 60,
    capabilities: ['basic_ast', 'core_heuristics', 'standard_support'],
  },
  plus: {
    priceId: 'price_plus_999',
    pricePaise: 999 * 100,
    monthlyTokenBudget: 80_000_000,
    maxMessages: 100,
    messageWindowHours: 5,
    maxCharsPerRequest: 60_000,
    requestsPerMinute: 120,
    capabilities: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge'],
  },
  pro: {
    priceId: 'price_pro_4999',
    pricePaise: 4999 * 100,
    monthlyTokenBudget: 200_000_000, // 1B tokens
    maxMessages: 500,
    messageWindowHours: 5,
    maxCharsPerRequest: 120_000,
    requestsPerMinute: 300,
    capabilities: [
      'basic_ast',
      'core_heuristics',
      'interactive_topology',
      'bounty_forge',
      'swarm_intelligence',
      'advanced_terminal',
      'pdf_export',
    ],
  },
} as const

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${value / 1_000_000_000}B`
  if (value >= 1_000_000) return `${value / 1_000_000}M`
  if (value >= 1_000) return `${value / 1_000}K`
  return String(value)
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value)
}

function tokenBudgetText(tier: PlanTier): string {
  return `${formatCompactNumber(PLAN_LIMITS[tier].monthlyTokenBudget)} monthly token budget`
}

function requestSizeText(tier: PlanTier): string {
  return `${formatInteger(PLAN_LIMITS[tier].maxCharsPerRequest)} characters per request`
}

function rateLimitText(tier: PlanTier): string {
  return `${formatInteger(PLAN_LIMITS[tier].requestsPerMinute)} requests per minute`
}

export function messageQuotaText(tier: PlanTier): string {
  const { maxMessages, messageWindowHours } = PLAN_LIMITS[tier]
  return `${formatInteger(maxMessages)} messages every ${messageWindowHours}h`
}

export const PLAN_CATALOG: Record<PlanTier, PlanDisplayConfig> = {
  free: {
    tier: 'free',
    name: 'Sandbox',
    priceLabel: `${RUPEE}0`,
    description: 'Perfect for trying Hexical AI with essential analysis features.',
    features: [
      { icon: 'terminal', tone: 'muted', text: 'Groq fast inference route' },
      { icon: 'network', tone: 'muted', text: 'Basic code and logic analysis' },
      { icon: 'activity', tone: 'muted', text: 'Repository intelligence for standard checks' },
      { icon: 'fileJson', tone: 'muted', text: tokenBudgetText('free') },
    ],
  },
  go: {
    tier: 'go',
    name: 'Go',
    checkoutName: 'Go',
    priceLabel: `${RUPEE}299`,
    description: 'More throughput for regular analysis and faster iteration.',
    features: [
      { icon: 'zap', tone: 'accent', text: tokenBudgetText('go') },
      { icon: 'terminal', tone: 'muted', text: 'Groq fast inference route' },
      { icon: 'shield', tone: 'muted', text: requestSizeText('go') },
      { icon: 'network', tone: 'muted', text: rateLimitText('go') },
    ],
  },
  plus: {
    tier: 'plus',
    name: 'Plus',
    checkoutName: 'Plus',
    priceLabel: `${RUPEE}999`,
    badge: 'Builder',
    description: 'Premium engineering analysis for larger inputs, change planning, and validation workflows.',
    features: [
      { icon: 'zap', tone: 'accent', text: tokenBudgetText('plus') },
      { icon: 'terminal', tone: 'accent', text: 'OpenAI route for standard and deep analysis' },
      { icon: 'crosshair', tone: 'accent', text: 'Structured remediation workflow' },
      { icon: 'target', tone: 'accent', text: 'Interactive impact analysis' },
      { icon: 'gitMerge', tone: 'accent', text: requestSizeText('plus') },
    ],
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    checkoutName: 'Pro',
    priceLabel: `${RUPEE}4,999`,
    badge: 'Engineering',
    description: 'Highest limits with deep analysis and coordinated multi-agent engineering review.',
    includesLabel: 'Includes Plus, and:',
    features: [
      { icon: 'sparkles', tone: 'accent', text: tokenBudgetText('pro') },
      { icon: 'shield', tone: 'accent', text: 'Claude route for deep analysis' },
      { icon: 'fileBadge', tone: 'accent', text: '10 coordinated engineering reviews per day' },
      { icon: 'zap', tone: 'accent', text: requestSizeText('pro') },
    ],
  },
} as const
