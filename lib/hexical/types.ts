/**
 * @file lib/hexical/types.ts
 * Shared types, request schema, and tier/plan configuration.
 * This file is the single source of truth for pricing, limits, and payload
 * shape — every other module imports from here instead of redefining config.
 *
 * v5.1 patch:
 *  - Added SubscriptionStatus / TierEntitlement / resolveEntitlement() so a
 *    tier can carry a real expiry instead of being a bare string that only
 *    ever gets set by hand. resolveEntitlement() is what route.ts now calls
 *    instead of a bare normalizeTier() — it downgrades to 'free' the moment
 *    tier_expires_at is in the past, even if the `profiles.tier` column
 *    itself hasn't been reset yet.
 *  - Added ERROR_CODES: a stable, machine-readable code on every error
 *    response from /api/verify, so the frontend can tell "you need to
 *    upgrade your plan" apart from "this action needs an authorization
 *    scope" apart from "you're rate limited" instead of collapsing every
 *    4xx into the same upgrade modal.
 */

import { z } from 'zod';

export type Tier = 'free' | 'go' | 'plus' | 'pro';
export type Profile = 'recon' | 'swarm' | 'audit' | 'exploit' | 'patch';
export type TargetArch = 'x64' | 'x86' | 'arm64';
export type Aggressiveness = 'low' | 'medium' | 'high';
export type Provider = 'groq' | 'openai' | 'anthropic' | 'gemini' | 'deepseek';
export type Complexity = 'simple' | 'standard' | 'deep';
export type RouteMode = 'single' | 'swarm';
export type ModelSlot = 'main' | 'swarm';

export const VALID_TIERS: readonly Tier[] = ['free', 'go', 'plus', 'pro'] as const;

/** Profiles that can produce offensive-security content (exploitation vectors,
 *  escape payloads). These require a verified authorization scope — see
 *  lib/hexical/authorization.ts — not just a self-declared target string. */
export const AUTHORIZATION_GATED_PROFILES: readonly Profile[] = ['exploit', 'swarm'] as const;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(8_000),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ExecutionPayloadSchema = z.object({
  logic: z.string().min(1).max(500_000), // Bumped to 500k to allow Pro payloads
  profile: z.enum(['recon', 'swarm', 'audit', 'exploit', 'patch']).default('recon'),
  workspace: z
    .string()
    .regex(/^[a-zA-Z0-9\-_]+$/, 'workspace must contain only alphanumeric characters, hyphens, or underscores')
    .max(50)
    .default('global'),
  targetArch: z.enum(['x64', 'x86', 'arm64']).default('x64'),
  autoRedact: z.boolean().default(false),
  aggressiveness: z.enum(['low', 'medium', 'high']).default('low'),
  targetScope: z.string().max(200).optional(),
  extractedTargets: z.array(z.string().max(100)).max(50).optional(),
  bountyPlatform: z.string().max(50).optional(),
  /** Reference to a pre-verified authorization scope (see authorization.ts).
   *  Required — enforced at runtime, not just in the schema — whenever
   *  `profile` is in AUTHORIZATION_GATED_PROFILES. */
  authorizationRef: z.string().uuid().optional(),
  maxConcurrency: z.coerce.number().int().min(1).max(10).default(3),
  contextWindow: z.coerce.number().int().min(1_024).max(32_768).default(4_096),
  conversation: z.array(ChatTurnSchema).max(50).optional(),
  asyncMode: z.boolean().default(false),
  requestNonce: z.string().length(32).regex(/^[a-f0-9]+$/).optional(),
  requestTimestampMs: z.number().int().positive().optional(),
});
export type ExecutionPayload = z.infer<typeof ExecutionPayloadSchema>;
// ---------------------------------------------------------------------------
// Structured finding extraction (grounded LLM output for the trace panel)
// ---------------------------------------------------------------------------
// This schema is used with generateObject to pull verification/risk data
// OUT of the model's own completed analysis text. The model is never asked
// to invent a vulnerability — `risk: null` is a valid, expected, and
// trustworthy answer when nothing was found. Evidence strings are required
// to be specific to avoid the model defaulting to generic filler.
export const StructuredFindingSchema = z.object({
  verification: z.object({
    left: z.string().max(60),
    right: z.string().max(60),
    result: z.enum(['verified', 'conflict', 'unverified']),
    evidence: z.array(z.string().max(140)).min(1).max(6),
  }),
  risk: z
    .object({
      severity: z.enum(['LOW', 'MED', 'HIGH', 'CRITICAL']),
      cvss: z.number().min(0).max(10),
      impact: z.string().max(160),
      attackComplexity: z.enum(['Low', 'High']),
      privilegesRequired: z.enum(['None', 'Low', 'High']),
      userInteraction: z.enum(['None', 'Required']),
    })
    .nullable(),
});
export type StructuredFinding = z.infer<typeof StructuredFindingSchema>;

// ---------------------------------------------------------------------------
// Result / response shapes
// ---------------------------------------------------------------------------

export interface ModelRoute {
  provider: Provider;
  model: string;
  mode: RouteMode;
  maxOutputTokens: number;
  temperature: number;
  complexity: Complexity;
  confidenceScore: number;
  cacheable: boolean;
  reason: string;
}

export interface ModelExecutionResult {
  provider: Provider;
  model: string;
  mode: RouteMode;
  text: string;
  tokensIn: number;
  tokensOut: number;
  confidenceScore: number;
  swarmConsensus?: Record<string, unknown>;
  fallbackTrail: string[];
  providerRetryCount: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
}

export interface MessageQuotaResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

export interface TokenReservation {
  allowed: boolean;
  reservedTokens: number;
  usedTokens: number;
  remainingTokens: number;
  limitTokens: number;
}

/** Mirrors TokenReservation but tracks real provider $ cost (in paise)
 *  instead of raw token count. See MONTHLY_COST_BUDGET_PAISE below for why
 *  this exists alongside MONTHLY_TOKEN_BUDGETS rather than replacing it. */
export interface CostReservation {
  allowed: boolean;
  reservedPaise: number;
  usedPaise: number;
  remainingPaise: number;
  limitPaise: number;
}

export interface DailySpendState {
  budgetPaise: number;
  usedPaise: number;
  forceCheapModels: boolean;
}

export interface AuthorizationDecision {
  allowed: boolean;
  scopeId: string | null;
  reason: string;
  expiresInHours: number | null;
}

export interface ResponseMetrics {
  latencyMs: number;
  tokensUsed: number;
  tokensReserved: number;
  monthlyTokenRemaining: number;
  confidenceScore: number;
  rateLimitRemaining: number;
  provider: Provider | 'cache';
  model: string;
  routeMode: RouteMode | 'cache';
  complexity: Complexity;
  estimatedCostInr: number;
  estimatedProfitInr: number;
  cacheHit: boolean;
  dailySpendRemainingInr: number;
  fallbackUsed: boolean;
  providerRetryCount: number;
  requestSizeChars: number;
  swarmUsed: boolean;
  messageQuotaLimit: number;
  messageQuotaRemaining: number;
  messageQuotaResetSeconds: number;
  authorizationScopeId: string | null;
  authorizationExpiresInHours: number | null;
}

export interface ExecutionResponse {
  analysis: string;
  steps: string[];
  status: 'completed';
  swarmConsensus?: Record<string, unknown>;
  traceEvents?: TraceEvent[]; // <-- ADDED THIS LINE
  metrics: ResponseMetrics;
}

export interface PromptPayload {
  promptLogic: string;
  compressedConversation: boolean;
  olderTurnsCompressed: number;
}

export interface UsageEvent {
  user_id: string;
  tier: Tier;
  profile: Profile;
  provider: Provider | 'cache';
  model: string;
  route_mode: RouteMode | 'cache';
  complexity: Complexity;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  estimated_cost_paise: number;
  allocated_revenue_paise: number;
  estimated_profit_paise: number;
  latency_ms: number;
  provider_retry_count: number;
  fallback_used: boolean;
  cache_key: string | null;
  swarm_used: boolean;
  confidence_score: number;
  request_size_chars: number;
  cache_hit: boolean;
  authorization_scope_id: string | null;
}

// ---------------------------------------------------------------------------
// Tier / plan configuration
// ---------------------------------------------------------------------------

export const PLAN_FEATURES: Record<Tier, readonly string[]> = {
  free: ['core_heuristics'],
  go: ['core_heuristics'],
  plus: ['core_heuristics', 'interactive_topology', 'pdf_export'],
  pro: ['core_heuristics', 'interactive_topology', 'pdf_export', 'swarm_intelligence', 'advanced_terminal'],
};

export const MARGIN_CHAR_LIMITS: Record<Tier, number> = {
  free: 10_000,
  go: 15_000,
  plus: 60_000,
  pro: 500_000, // Massive allocation unlocked for Pro tier
};

// --- ADDED FOR FRONTEND COMPATIBILITY ---
export interface PlanLimitConfig {
  capabilities: readonly string[];
  maxCharsPerRequest: number;
}

// Bridges the backend data structures directly to the frontend's expectations
export const PLAN_LIMITS: Record<Tier, PlanLimitConfig> = {
  free: { capabilities: PLAN_FEATURES.free, maxCharsPerRequest: MARGIN_CHAR_LIMITS.free },
  go: { capabilities: PLAN_FEATURES.go, maxCharsPerRequest: MARGIN_CHAR_LIMITS.go },
  plus: { capabilities: PLAN_FEATURES.plus, maxCharsPerRequest: MARGIN_CHAR_LIMITS.plus },
  pro: { capabilities: PLAN_FEATURES.pro, maxCharsPerRequest: MARGIN_CHAR_LIMITS.pro },
};

// Aliases PlanTier to Tier so frontend imports don't crash
export type PlanTier = Tier;
// ----------------------------------------

export const MONTHLY_TOKEN_BUDGETS: Record<Tier, number> = {
  free: 1_000_000,
  go: 8_000_000,
  plus: 40_000_000,
  pro: 120_000_000,
};

export const PLAN_MONTHLY_PRICE_PAISE: Record<Tier, number> = {
  free: 0,
  go: 299 * 100,
  plus: 999 * 100,
  pro: 4_999 * 100,
};

/**
 * Hard ceiling on actual provider $ cost per user per tier per month, in
 * paise. This is the real margin defense — MONTHLY_TOKEN_BUDGETS above is
 * kept as a loose backstop, but a flat token count can't tell a cheap input
 * token apart from an output token that costs 5-17x more depending on
 * provider (see MODEL_PRICING_USD_PER_MILLION), so it can't be sized safely
 * against a price in rupees on its own. This can, because it's enforced
 * against real per-request cost via reserveMonthlyCost/reconcileMonthlyCost
 * in limits.ts, using the same atomic reserve-then-reconcile Lua pattern
 * already used for MONTHLY_TOKEN_BUDGETS.
 *
 * Targets (confirm/adjust if pricing or margin targets change):
 *   free: ~₹25/mo  — trial abuse cap, not margin-derived (price is ₹0)
 *   go:   ~₹85/mo  — ≥70% margin at ₹299/mo
 *   plus: ~₹390/mo — ≥60% margin at ₹999/mo
 *   pro:  ~₹1,950/mo — ≥60% margin at ₹4,999/mo
 * Each is set below the exact breakeven line to leave headroom for
 * USD/INR drift and non-LLM overhead (Redis, hosting) that this ledger
 * doesn't account for.
 */
export const MONTHLY_COST_BUDGET_PAISE: Record<Tier, number> = {
  free: 2_500,
  go: 8_500,
  plus: 39_000,
  pro: 195_000,
};

export const RATE_LIMITS: Record<Tier, { windowSecs: number; maxReq: number }> = {
  free: { windowSecs: 60, maxReq: 20 },
  go: { windowSecs: 60, maxReq: 60 },
  plus: { windowSecs: 60, maxReq: 120 },
  pro: { windowSecs: 60, maxReq: 300 },
};

/** Rolling window, not calendar-aligned: a user's first message starts their
 *  own 5-hour timer. Sits between the per-minute burst limiter and the
 *  monthly token budget as a mid-range abuse/cost guard. */
export const MESSAGE_QUOTA_WINDOW_SECS = 5 * 60 * 60;

export const MESSAGE_QUOTA_LIMITS: Record<Tier, number> = {
  free: 20,
  go: 35,
  plus: 100,
  pro: 180,
};

export const MODEL_PRICING_USD_PER_MILLION: Record<Provider, { input: number; output: number }> = {
  groq: { input: 0.59, output: 0.79 },
  openai: { input: 2.5, output: 10 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 0.075, output: 0.3 },
  deepseek: { input: 0.27, output: 1.1 },
};

export function readNumberEnv(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function normalizeTier(raw: unknown): Tier {
  const tier = String(raw ?? 'free').trim().toLowerCase();
  return VALID_TIERS.includes(tier as Tier) ? (tier as Tier) : 'free';
}

// ---------------------------------------------------------------------------
// Entitlement resolution (tier + expiry + subscription status)
// ---------------------------------------------------------------------------
// Previously, `profiles.tier` was read as a bare string with no concept of
// "until when." That's what made manual upgrades (Supabase dashboard edits,
// support-granted trials, etc.) impossible to reason about on the frontend
// ("is this still active? until when?") and let a cancelled/expired grant
// keep working indefinitely if nobody remembered to flip the column back.
//
// resolveEntitlement() is the single place that turns
// (tier, tier_expires_at, subscription_status) into what actually gets
// enforced. Call it everywhere tier gating happens — don't call
// normalizeTier() directly on a profile row and skip the expiry check.
//
// Schema this expects on `profiles` (see supabase/migrations in the repo
// root for the exact SQL): `tier_expires_at timestamptz null`,
// `subscription_status text null`. Both are nullable — a null
// `tier_expires_at` means "no expiry on file" (e.g. free tier, or a
// lifetime/manual grant with no end date), not "expired."

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'none';
const VALID_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['active', 'canceled', 'past_due', 'none'] as const;

export interface TierEntitlement {
  /** The tier that should actually be enforced right now — already
   *  downgraded to 'free' if `expiresAt` has passed. */
  tier: Tier;
  subscriptionStatus: SubscriptionStatus;
  /** ISO timestamp string, or null if there's no expiry on record. */
  expiresAt: string | null;
  /** True if `expiresAt` was in the past at resolution time. */
  expired: boolean;
}

export function resolveEntitlement(rawTier: unknown, rawExpiresAt: unknown, rawStatus: unknown): TierEntitlement {
  const storedTier = normalizeTier(rawTier);
  const expiresAt = typeof rawExpiresAt === 'string' && rawExpiresAt.length > 0 ? rawExpiresAt : null;

  const parsedExpiry = expiresAt ? new Date(expiresAt) : null;
  const expired = parsedExpiry !== null && !Number.isNaN(parsedExpiry.getTime()) && parsedExpiry.getTime() < Date.now();

  const statusRaw = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  const storedStatus: SubscriptionStatus = VALID_SUBSCRIPTION_STATUSES.includes(statusRaw as SubscriptionStatus)
    ? (statusRaw as SubscriptionStatus)
    : storedTier === 'free'
      ? 'none'
      : 'active';

  return {
    tier: expired ? 'free' : storedTier,
    subscriptionStatus: expired ? 'past_due' : storedStatus,
    expiresAt,
    expired,
  };
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------
// Stable, machine-readable identifiers attached to every error JSON body
// /api/verify returns (as `code`). HTTP status alone isn't enough for the
// frontend to react correctly — a 403 from "you need to upgrade" and a 403
// from "you need an authorization scope for this target" require completely
// different UI (upgrade modal vs. a scope-required message), and collapsing
// them was the direct cause of Pro users being sent to the billing page for
// swarm/exploit requests that actually failed the authorization gate, not
// the tier gate.
export const ERROR_CODES = {
  SERVER_CONFIG_ERROR: 'SERVER_CONFIG_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REQUEST_BODY_TOO_LARGE: 'REQUEST_BODY_TOO_LARGE',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  REPLAY_REJECTED: 'REPLAY_REJECTED',
  TIER_CHAR_LIMIT_EXCEEDED: 'TIER_CHAR_LIMIT_EXCEEDED',
  TIER_UPGRADE_REQUIRED: 'TIER_UPGRADE_REQUIRED',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  MESSAGE_QUOTA_EXCEEDED: 'MESSAGE_QUOTA_EXCEEDED',
  SWARM_DAILY_LIMIT_EXCEEDED: 'SWARM_DAILY_LIMIT_EXCEEDED',
  MONTHLY_TOKEN_BUDGET_EXCEEDED: 'MONTHLY_TOKEN_BUDGET_EXCEEDED',
  MONTHLY_COST_BUDGET_EXCEEDED: 'MONTHLY_COST_BUDGET_EXCEEDED',
  SWARM_CONSENSUS_FAILURE: 'SWARM_CONSENSUS_FAILURE',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const FEATURE_FLAGS = {
  swarmEnabled: readBooleanEnv('SWARM_ENABLED', true),
  cacheEnabled: readBooleanEnv('CACHE_ENABLED', true),
  cheapMode: readBooleanEnv('CHEAP_MODE', false),
  dailySpendGuard: readBooleanEnv('DAILY_SPEND_GUARD', true),
  autoFallback: readBooleanEnv('AUTO_FALLBACK', true),
  streamingEnabled: readBooleanEnv('STREAMING_ENABLED', true),
} as const;

export const NONCE_TTL_SECS = 120;
export const REQUEST_MAX_AGE_MS = 30_000;
export const MAX_BODY_BYTES = 150_000;
export const OUTPUT_MAX_CHARS = 8_000;
export const DAILY_SWARM_LIMIT = 10;
export const CACHE_TTL_SECS = 60 * 60 * 24;
export const CACHE_MAX_PROMPT_CHARS = 4_000;
export const HEAVY_QUEUE_THRESHOLD_CHARS = 80_000;
export const DEFAULT_DAILY_BUDGET_INR = 5_000;
export const DEFAULT_USD_TO_INR = 83.5;
export const PROVIDER_TIMEOUT_MS = 20_000;
export const PROVIDER_MAX_RETRIES = 2;
export const CIRCUIT_BREAKER_TTL_SECS = 300;
export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const SWARM_CONFIDENCE_STOP_THRESHOLD = readNumberEnv('SWARM_CONFIDENCE_STOP_THRESHOLD', 90);
export const TOKENIZER_MAX_CHARS = 200_000;
export const AUTHORIZATION_EXPIRY_WARNING_HOURS = 48;

export const API_VERSION = process.env.HEXICAL_API_VERSION ?? 'hexical-api-v5.0';
export const SYSTEM_PROMPT_VERSION = process.env.HEXICAL_SYSTEM_PROMPT_VERSION ?? 'hexical-system-v5.0';
export const PROVIDER_ROUTER_VERSION = process.env.HEXICAL_PROVIDER_ROUTER_VERSION ?? 'hexical-router-v5.0';

export const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_MAIN_MODEL',
  'OPENAI_MAIN_MODEL',
  'ANTHROPIC_MAIN_MODEL',
  'ANTHROPIC_SWARM_MODEL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const;

export function modelEnvKey(provider: Provider, slot: ModelSlot = 'main'): string {
  if (provider === 'anthropic' && slot === 'swarm') return 'ANTHROPIC_SWARM_MODEL';
  if (provider === 'anthropic') return 'ANTHROPIC_MAIN_MODEL';
  if (provider === 'openai') return 'OPENAI_MAIN_MODEL';
  if (provider === 'groq') return 'GROQ_MAIN_MODEL';
  if (provider === 'gemini') return 'GEMINI_MAIN_MODEL';
  return 'DEEPSEEK_MAIN_MODEL';
}

export function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function getModelName(provider: Provider, slot: ModelSlot = 'main'): string {
  return requiredEnv(modelEnvKey(provider, slot));
}

export function providerAvailable(provider: Provider): boolean {
  const hasModel = Boolean(process.env[modelEnvKey(provider)]);
  if (provider === 'gemini') return hasModel && Boolean(process.env.GEMINI_API_KEY);
  if (provider === 'deepseek') return hasModel && Boolean(process.env.DEEPSEEK_API_KEY);
  if (provider === 'openai') return hasModel && Boolean(process.env.OPENAI_API_KEY);
  if (provider === 'anthropic') return hasModel && Boolean(process.env.ANTHROPIC_API_KEY);
  return hasModel && Boolean(process.env.GROQ_API_KEY);
}

export function getUsdToInr(): number {
  return readNumberEnv('USD_TO_INR', DEFAULT_USD_TO_INR);
}

export function getDailyBudgetPaise(): number {
  const configured = Number(process.env.HEXICAL_DAILY_BUDGET_INR);
  const budgetInr = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_BUDGET_INR;
  return Math.round(budgetInr * 100);
}
// ---------------------------------------------------------------------------
// Swarm Engine Types (Added for Interactive UI Support)
// ---------------------------------------------------------------------------

// All valid AI agent roles in the Hexical Swarm
export type AgentRoleType = 
  | 'coordinator' 
  | 'planner' 
  | 'red_team_exploit' 
  | 'blue_team_defense' 
  | 'consensus_engine';

// The structure of a single argument made by an agent during execution
export interface DebateRound {
  roundNumber: number;
  proposingAgentId: string;
  proposingAgentRole: AgentRoleType;
  argument: string;
  evidenceASTNodeIds: string[]; // The specific AST nodes they are referencing
  concessionMade: boolean;
  timestampMs: number;
}

// The final vote cast by an agent after a debate to determine vulnerability state
export interface ConsensusVote {
  agentId: string;
  role: AgentRoleType;
  vote: 'SECURE' | 'VULNERABLE' | 'ABSTAIN';
  rationale: string;
}
// ---------------------------------------------------------------------------
// Chat Stream Types & Telemetry
// ---------------------------------------------------------------------------

// The structured telemetry event for the Investigation Timeline
export interface TraceEvent {
  id: string;
  type: 'recon' | 'fingerprint' | 'route' | 'search' | 'verification' | 'reasoning' | 'risk' | 'synthesis' | 'general';
  label: string;
  detail?: string;
  status?: 'completed' | 'partial' | 'failed';
  latencyMs?: number;

  // 'recon' — only set when measureAttackSurface() actually found matches
  attackSurfaceMetrics?: { endpoints: number; forms: number; authRoutes: number };

  // 'fingerprint' — only set when detectTechnologies() actually matched something
  technologies?: string[];

  // 'route' — mirrors the real ModelRoute decision, nothing invented
  routeInfo?: { selectedRoute: string; model: string; reason: string };

  // 'verification'
  left?: string;
  right?: string;
  result?: 'verified' | 'conflict' | 'unverified';
  evidence?: string[]; // model-reported, grounded in this specific analysis — never canned

  // 'risk'
  severity?: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';
  cvss?: number;
  impact?: string;
  attackComplexity?: 'Low' | 'High';
  privilegesRequired?: 'None' | 'Low' | 'High';
  userInteraction?: 'None' | 'Required';
}

export interface StreamMessage {
  id: string;
  role: 'user' | 'hexical' | 'system' | 'error';
  text: string;
  ts: string; 
  steps?: string[];
  valid?: boolean;
  route?: RoutePath;
  traceEvents?: TraceEvent[]; // Maps directly to the Investigation Panel
}
export type RoutePath =
  | 'swarm'
  | 'forge_api'
  | 'global'
  | 'math'
  | 'local'
  | 'cluster_edge'
  | 'unknown';

export function inferRoute(
  steps: readonly string[] = []
): RoutePath {
  const blob = steps.join(' ').toLowerCase();

  if (/swarm|red\s*team|blue\s*team|consensus|architect/.test(blob))
    return 'swarm';

  if (/forge|hackerone|bugcrowd|pdf|export/.test(blob))
    return 'forge_api';

  if (/openai|gpt|groq|anthropic|claude|cloud|remote|verification/.test(blob))
    return 'global';

  if (/math|calc|solver|equation|compute/.test(blob))
    return 'math';

  if (/local|database|offline|cache/.test(blob))
    return 'local';

  if (/cluster|edge|mesh|gateway/.test(blob))
    return 'cluster_edge';

  return 'unknown';
}