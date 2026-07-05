export type PlanTier = 'free' | 'go' | 'plus' | 'pro'

export type PlanCapability =
  | 'basic_ast'
  | 'core_heuristics'
  | 'standard_support'
  | 'interactive_topology'
  | 'bounty_forge'
  | 'swarm_intelligence'
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
  maxMessages: number
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
    maxMessages: 25,
    maxCharsPerRequest: 10_000,
    requestsPerMinute: 20,
    capabilities: ['basic_ast', 'core_heuristics'],
  },
  go: {
    priceId: 'price_go_299',
    pricePaise: 299 * 100,
    monthlyTokenBudget: 8_000_000,
    maxMessages: 50,
    maxCharsPerRequest: 15_000,
    requestsPerMinute: 60,
    capabilities: ['basic_ast', 'core_heuristics', 'standard_support'],
  },
  plus: {
    priceId: 'price_plus_1999',
    pricePaise: 1_999 * 100,
    monthlyTokenBudget: 35_000_000,
    maxMessages: 500,
    maxCharsPerRequest: 60_000,
    requestsPerMinute: 120,
    capabilities: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge'],
  },
  pro: {
    priceId: 'price_pro_9599',
    pricePaise: 9_599 * 100,
    monthlyTokenBudget: 120_000_000, // 120M tokens
    maxMessages: 9999,
    maxCharsPerRequest: 120_000,
    requestsPerMinute: 300,
    capabilities: [
      'basic_ast',
      'core_heuristics',
      'interactive_topology',
      'bounty_forge',
      'swarm_intelligence',
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

export const PLAN_CATALOG: Record<PlanTier, PlanDisplayConfig> = {
  free: {
    tier: 'free',
    name: 'Sandbox',
    priceLabel: `${RUPEE}0`,
    description: 'Perfect for trying Hexical AI with essential analysis features.',
    features: [
      { icon: 'terminal', tone: 'muted', text: 'Groq fast inference route' },
      { icon: 'network', tone: 'muted', text: 'Basic code and logic analysis' },
      { icon: 'activity', tone: 'muted', text: 'Recon profile for standard checks' },
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
    priceLabel: `${RUPEE}1,999`,
    badge: 'Hunter',
    description: 'Premium analysis for larger inputs, audits, and bounty workflows.',
    features: [
      { icon: 'zap', tone: 'accent', text: tokenBudgetText('plus') },
      { icon: 'terminal', tone: 'accent', text: 'OpenAI route for standard and deep analysis' },
      { icon: 'crosshair', tone: 'accent', text: 'Bounty workflow context' },
      { icon: 'target', tone: 'accent', text: 'Interactive topology features' },
      { icon: 'gitMerge', tone: 'accent', text: requestSizeText('plus') },
    ],
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    checkoutName: 'Pro',
    priceLabel: `${RUPEE}9,599`,
    badge: 'Architect',
    description: 'Highest limits with Claude deep analysis and Pro multi-agent review.',
    includesLabel: 'Includes Plus, and:',
    features: [
      { icon: 'sparkles', tone: 'accent', text: tokenBudgetText('pro') },
      { icon: 'shield', tone: 'accent', text: 'Claude route for deep analysis' },
      { icon: 'fileBadge', tone: 'accent', text: '10 multi-agent review requests per day' },
      { icon: 'zap', tone: 'accent', text: requestSizeText('pro') },
    ],
  },
} as const
