/**
 * @file lib/hexical/types.ts
 * Shared types, request schema, and tier/plan configuration.
 * This file is the single source of truth for pricing, limits, and payload
 * shape — every other module imports from here instead of redefining config.
 *
 * In addition to compile-time types, this file exports Zod schemas and
 * small runtime helpers (type guards, exhaustiveness checks, tier
 * comparisons) so the same definitions protect API boundaries at runtime,
 * not just the editor at compile time.
 */

import { z } from 'zod';

export type UserTargetId = string & { readonly __brand: unique symbol };
export type WorkspaceId = string & { readonly __brand: unique symbol };
export type ProjectId = string & { readonly __brand: unique symbol };
export type ScanId = string & { readonly __brand: unique symbol };
export type AgentId = string & { readonly __brand: unique symbol };
export type SessionId = string & { readonly __brand: unique symbol };
export type MessageId = string & { readonly __brand: unique symbol };
export type FindingId = string & { readonly __brand: unique symbol };
export type EventId = string & { readonly __brand: unique symbol };
export type PluginId = string & { readonly __brand: unique symbol };

// =============================================================================
// MODULE 0: GENERIC TYPE-SAFETY & RUNTIME UTILITIES
// =============================================================================
// Small, dependency-light helpers used throughout the rest of this file (and
// safe to import anywhere else in the codebase) to keep the discriminated
// unions and branded ids below honest at both compile time and runtime.

/**
 * Exhaustiveness guard for switch statements over a union type. Put this in
 * the `default` case; if a new member is ever added to the union without a
 * matching case being written, the call site fails to compile instead of
 * silently falling through at runtime.
 *
 * @example
 * switch (tier) {
 *   case 'free': return ...
 *   case 'go': return ...
 *   default: return assertNever(tier, 'PlanTier switch');
 * }
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled union member${context ? ` in ${context}` : ''}: ${JSON.stringify(value)}`,
  );
}

/**
 * Recursively freezes an object graph so shared, module-level config
 * (pricing tables, plan limits, etc.) can't be mutated at runtime by a
 * stray `PLAN_LIMITS.pro.maxConcurrentJobs = 999` somewhere downstream.
 * TypeScript's `as const` only protects this at compile time — this is
 * the runtime backstop, important in long-lived Node/Next.js processes
 * where a module-level object is shared across requests.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Builds a Zod schema for a branded id type (e.g. `ProjectId`): validates
 * that the raw value is a non-empty string, then brands it so the parsed
 * output lines up with the nominal type used across the rest of this file.
 */
export function brandedIdSchema<T extends string>(fieldName = 'id') {
  return z
    .string()
    .trim()
    .min(1, `${fieldName} cannot be empty`)
    .transform((value) => value as T);
}

// =============================================================================
// MODULE 1: CORE RUNTIME CONSTANTS & ENUMS
// =============================================================================
export const MessageRole = {
  USER: 'user',
  HEXICAL: 'hexical',
  ERROR: 'error',
  SYSTEM: 'system',
  TELEMETRY: 'telemetry',
  KERNEL: 'kernel',
  SANDBOX: 'sandbox',
} as const;
export type MessageRoleType = typeof MessageRole[keyof typeof MessageRole];

export const AgentRole = {
  PLANNER: 'planner',
  COORDINATOR: 'coordinator',
  CODE_REVIEWER: 'code_reviewer',
  AST_ANALYZER: 'ast_analyzer',
  RED_TEAM_EXPLOIT: 'red_team_exploit',
  BLUE_TEAM_DEFENSE: 'blue_team_defense',
  ARCHITECT: 'architect',
  PATCH_GENERATOR: 'patch_generator',
  MEMORY_AGENT: 'memory_agent',
  CONSENSUS_ENGINE: 'consensus_engine',
  FORGE_AGENT: 'forge_agent',
} as const;
export type AgentRoleType = typeof AgentRole[keyof typeof AgentRole];

export const RiskLevel = {
  LOW: 'LOW',
  MED: 'MED',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
  MAX_EXPLOITABLE: 'MAX_EXPLOITABLE',
} as const;
export type RiskLevelType = typeof RiskLevel[keyof typeof RiskLevel];

export const VerifyStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  HALTED: 'halted',
} as const;
export type VerifyStatusType = typeof VerifyStatus[keyof typeof VerifyStatus];

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical' | 'apocalyptic';
export type ExecutionProfile = 'recon' | 'swarm' | 'audit' | 'deep_fuzz' | 'passive_recon';
export type TargetArch = 'x64' | 'x86' | 'arm64' | 'wasm' | 'mips' | 'riscv';

// =============================================================================
// MODULE 2: AI MODEL & PROVIDER METADATA
// =============================================================================
export type ModelProvider = 'openai' | 'anthropic' | 'groq' | 'google' | 'local_ollama' | 'custom_vpc';

export interface ModelConfiguration {
  provider: ModelProvider;
  modelId: string;
  temperature: number;
  contextWindow: number;
  topP?: number;
  frequencyPenalty?: number;
}

export interface EngineVersions {
  engineVersion: string;
  rulesVersion: string;
  signaturesVersion: string;
  modelVersion: string;
  knowledgeBaseVersion: string;
}

// =============================================================================
// MODULE 3: PLUGIN & ENGINE EXTENSIBILITY
// =============================================================================
export interface EnginePlugin {
  pluginId: PluginId;
  name: string;
  version: string;
  author: string;
  capabilities: ('ast_parser' | 'fuzzer' | 'secret_scanner' | 'custom_llm_router')[];
  isEnabled: boolean;
}

// =============================================================================
// MODULE 4: SWARM ORCHESTRATION & EXECUTION GRAPHS
// =============================================================================
export interface SwarmTask {
  taskId: string;
  assignedAgent: AgentRoleType;
  instruction: string;
  contextRefs: string[];
  status: VerifyStatusType;
}

export interface DebateRound {
  roundNumber: number;
  proposingAgentId: AgentId;
  proposingAgentRole: AgentRoleType;
  argument: string;
  evidenceASTNodeIds: string[];
  concessionMade: boolean;
  timestampMs: number;
}

export interface ConsensusVote {
  agentId: AgentId;
  role: AgentRoleType;
  vote: 'VULNERABLE' | 'SECURE' | 'ABSTAIN' | 'NEEDS_MORE_DATA';
  rationale: string;
}

export interface SwarmExecution {
  coordinatorId: AgentId;
  tasks: SwarmTask[];
  debateRounds: DebateRound[];
  votes: ConsensusVote[];
  finalConsensusReached: boolean;
  consensusMeaning: string;
  executionGraphRef: string;
}

// =============================================================================
// MODULE 5: AST ENGINE & CODE CONTEXT
// =============================================================================
export interface ASTContext {
  language: string;
  parserVersion: string;
  syntaxTreeHash: string;
  semanticGraphRef?: string;
  symbolTableRef?: string;
  callGraphRef?: string;
}

// =============================================================================
// MODULE 6: STRUCTURED VULNERABILITY FINDINGS (OWASP / MITRE)
// =============================================================================
export interface CVSSv3_1 {
  vectorString: string;
  baseScore: number;
  exploitabilityScore: number;
}

export interface Finding {
  id: FindingId;
  title: string;
  description: string;
  cweId: number;
  cweName: string;
  owaspCategory?: string;
  mitreAttackMapping?: string[];
  likelihood: 'LOW' | 'MEDIUM' | 'HIGH';
  exploitMaturity: 'UNPROVEN' | 'PROOF_OF_CONCEPT' | 'WEAPONIZED' | 'ACTIVE_CAMPAIGN';
  affectedFiles: string[];
  affectedASTNodes: string[];
  reproductionSteps: string[];
  remediationPayload: string;
  boxConfidence: number;
  references: string[];
  cvss: CVSSv3_1;
  risk: RiskLevelType;
  isFalsePositive: boolean;
}

// =============================================================================
// MODULE 7: AST DIFFING & STRUCTURAL DELTAS
// =============================================================================
export type DiffOperationType = 'INSERT' | 'DELETE' | 'UPDATE' | 'MOVE';

export interface ASTDiffNode {
  path: string;
  nodeType: string;
  operation: DiffOperationType;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
}

export interface ASTDiffResult {
  previousScanId: ScanId;
  currentScanId: ScanId;
  addedNodes: ASTDiffNode[];
  removedNodes: ASTDiffNode[];
  modifiedNodes: ASTDiffNode[];
  structuralDeltaCount: number;
  riskChanged: boolean;
  findingsChanged: boolean;
  hasChanges: boolean;
}

// =============================================================================
// MODULE 8: RISK TIMELINE & THREAT TRAJECTORY
// =============================================================================
export interface RiskTimelineEvent {
  eventId: EventId;
  scanIdRef: ScanId;
  timestamp: string;
  deltaType: 'vulnerability_introduced' | 'vulnerability_patched' | 'risk_escalation' | 'policy_override';
  findingIdRef?: FindingId;
  previousRiskState: RiskLevelType;
  newRiskState: RiskLevelType;
  actorUserId?: string;
}

// =============================================================================
// MODULE 9: PERFORMANCE, TELEMETRY, & CACHING
// =============================================================================
export interface CacheEntryMetadata {
  cacheKey: string;
  strategyUsed: 'exact_ast_match' | 'fuzzy_structural_match';
  hitCount: number;
  expiresAt: string;
}

export interface ScanPerformanceMetrics {
  durationMs: number;
  cpuUsagePct: number;
  ramUsageMb: number;
  agentExecutionTimesMs: Partial<Record<AgentRoleType, number>>;
  promptTokens: number;
  completionTokens: number;
  computeCostUsd: number;
  cacheStatistics: {
    cacheHitRate: number;
    queriesBypassed: number;
    entriesRef: CacheEntryMetadata[];
  };
}

// =============================================================================
// MODULE 10: MULTI-TENANT WORKSPACES & PROJECTS
// =============================================================================
export interface Workspace {
  id: WorkspaceId;
  name: string;
  ownerId: string;
  settings: Record<string, unknown>;
}

export interface Project {
  id: ProjectId;
  workspaceId: WorkspaceId;
  name: string;
  repositoryUrl?: string;
  totalScansExecuted: number;
  latestScanId?: ScanId;
}

// =============================================================================
// MODULE 11: IMMUTABLE AUDIT LOGGING
// =============================================================================
export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY_ALERT';

export interface AuditActor {
  actorId: string | 'SYSTEM' | 'HEXICAL_AGENT';
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEvent {
  readonly id: EventId;
  readonly timestamp: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceId?: string;
  readonly severity: AuditSeverity;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// =============================================================================
// MODULE 12: HISTORICAL SCAN PERSISTENCE
// =============================================================================
export interface ScanRecord {
  id: ScanId;
  projectId: ProjectId;
  userId: string;
  createdAt: string;
  executionProfileUsed: ExecutionProfile;
  activePlugins: PluginId[];
  modelConfigUsed: ModelConfiguration;
  astContext: ASTContext;
  scanSizeBytes: number;
  filesScannedCount: number;
  skippedFilesCount: number;
  findingsList: Finding[];
  overallRisk: RiskLevelType;
  swarmExecutionData?: SwarmExecution;
  performance: ScanPerformanceMetrics;
}

// =============================================================================
// MODULE 13: CONVERSATION & STREAMING CHAT SYSTEM
// =============================================================================
export interface StreamChunkPayload {
  sequenceId: number;
  deltaText: string;
  isControlToken: boolean;
  activeAgentRole?: AgentRoleType;
}

export interface ChatMessage {
  id: MessageId;
  sessionId: SessionId;
  role: MessageRoleType;
  text: string;
  rawChunks?: StreamChunkPayload[];
  metadata?: {
    tokensUsed: number;
    latencyMs: number;
    findingsReferenced?: FindingId[];
  };
  timestamp: string;
}

export interface Conversation {
  sessionId: SessionId;
  projectId: ProjectId;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// MODULE 14: CENTRALIZED API CONTRACTS
// =============================================================================
export interface PaginatedResult<T> {
  data: T[];
  totalCount: number;
  pageSize: number;
  pageNumber: number;
  hasNextPage: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  diagnosticCode: string;
  serverTimestampMs: number;
  details?: unknown;
}

/** Extracted as a named type (rather than an inline union) so it can be reused by the Zod schema below without drifting out of sync. */
export type ScanAggressiveness = 'low' | 'medium' | 'high';

export interface ScanRequest {
  projectId: ProjectId;
  logicPayload: string;
  profile: ExecutionProfile;
  aggressiveness: ScanAggressiveness;
  targetArch?: TargetArch;
  bypassCache?: boolean;
}

export interface ScanResponse {
  scanId: ScanId;
  status: VerifyStatusType;
  riskLevel: RiskLevelType;
  findings: Finding[];
  astDiff?: ASTDiffResult;
  metrics: ScanPerformanceMetrics;
  cryptographicSignature: string;
}

// -----------------------------------------------------------------------------
// RUNTIME VALIDATION — ZOD SCHEMAS FOR MODULE 14
// -----------------------------------------------------------------------------
// These mirror the interfaces above so any payload crossing a network
// boundary (API routes, webhooks, agent tool calls) can be parsed and
// narrowed at runtime, not just checked at compile time.

export const ExecutionProfileSchema = z.enum([
  'recon',
  'swarm',
  'audit',
  'deep_fuzz',
  'passive_recon',
]);

export const TargetArchSchema = z.enum(['x64', 'x86', 'arm64', 'wasm', 'mips', 'riscv']);

export const ScanAggressivenessSchema = z.enum(['low', 'medium', 'high']);

export const ProjectIdSchema = brandedIdSchema<ProjectId>('projectId');

export const ScanRequestSchema = z.object({
  projectId: ProjectIdSchema,
  logicPayload: z.string().min(1, 'logicPayload cannot be empty'),
  profile: ExecutionProfileSchema,
  aggressiveness: ScanAggressivenessSchema,
  targetArch: TargetArchSchema.optional(),
  bypassCache: z.boolean().optional(),
});

/**
 * Safe-parses an unknown payload (e.g. `req.body`) into a `ScanRequest`.
 * Use this at API boundaries instead of trusting client input directly.
 */
export function parseScanRequest(raw: unknown) {
  return ScanRequestSchema.safeParse(raw);
}

// =============================================================================
// PRICING LOGIC, CONSTANTS, & ROUTING UTILITIES
// =============================================================================
export type PlanTier = 'free' | 'go' | 'plus' | 'pro' | 'enterprise';

export type PlanFeature =
  | 'basic_ast'
  | 'core_heuristics'
  | 'standard_support'
  | 'interactive_topology'
  | 'bounty_forge'
  | 'swarm_intelligence'
  | 'scan_history'
  | 'ast_diffing'
  | 'pdf_export'
  | 'advanced_terminal'
  | 'custom_llm_routing'
  | 'private_vpc_deploy'
  | 'soc2_compliance_logs'
  | 'unlimited_concurrent_agents';


// -----------------------------------------------------------------------------
// DISCRIMINATED UNIONS: Separating Standard Subscriptions from Enterprise SaaS
// -----------------------------------------------------------------------------

export interface BasePlanConfiguration {
  name: string;
  features: PlanFeature[];
  capabilities: PlanFeature[]; // Hardened interface dual-mapping bridge
  maxCharsPerRequest: number;  // Crucial: Kept here so frontend payload checks don't crash
}

export interface StandardPlanConfiguration extends BasePlanConfiguration {
  tierType: 'standard';
  priceId: string;
  maxMessagesPerMonth: number;
  maxMessagesPerDay: number;
  maxConcurrentJobs: number;
}

export interface EnterprisePlanConfiguration extends BasePlanConfiguration {
  tierType: 'enterprise';
  priceId: 'contact_sales';
  salesLabel: string;
  usageLimits: 'Custom volume based on SLA';
  contactInstructions: string;
}

export type PlanConfiguration = StandardPlanConfiguration | EnterprisePlanConfiguration;

// -----------------------------------------------------------------------------
// `as const satisfies` (rather than a plain `Record<PlanTier, PlanConfiguration>`
// annotation) keeps each tier's exact literal shape — so
// `PLAN_LIMITS.pro.maxMessagesPerMonth` resolves without a `tierType` guard —
// while still forcing every entry to structurally satisfy the union. The
// whole tree is then deep-frozen so it can't be mutated at runtime by
// something downstream.
// -----------------------------------------------------------------------------

export const PLAN_LIMITS = deepFreeze(
  {
    free: {
      tierType: 'standard',
      priceId: '',
      name: 'Free Workspace',
      maxMessagesPerMonth: 600,
      maxMessagesPerDay: 20,
      maxCharsPerRequest: 10_000,
      maxConcurrentJobs: 1,
      features: ['basic_ast', 'core_heuristics'],
      capabilities: ['basic_ast', 'core_heuristics'],
    },
    go: {
      tierType: 'standard',
      priceId: 'price_go_299',
      name: 'Hexical Go',
      maxMessagesPerMonth: 1050,
      maxMessagesPerDay: 35,
      maxCharsPerRequest: 15_000,
      maxConcurrentJobs: 2,
      features: ['basic_ast', 'core_heuristics', 'standard_support'],
      capabilities: ['basic_ast', 'core_heuristics', 'standard_support'],
    },
    plus: {
      tierType: 'standard',
      priceId: 'price_plus_999',
      name: 'Hexical Plus',
      maxMessagesPerMonth: 3000,
      maxMessagesPerDay: 100,
      maxCharsPerRequest: 32_000,
      maxConcurrentJobs: 4,
      features: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge', 'advanced_terminal'],
      capabilities: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge', 'advanced_terminal'],
    },
    pro: {
      tierType: 'standard',
      priceId: 'price_pro_4999',
      name: 'Hexical Pro Developer',
      maxMessagesPerMonth: 9000,
      maxMessagesPerDay: 300,
      maxCharsPerRequest: 500_000,
      maxConcurrentJobs: 8,
      features: [
        'basic_ast',
        'core_heuristics',
        'interactive_topology',
        'bounty_forge',
        'swarm_intelligence',
        'scan_history',
        'ast_diffing',
        'pdf_export',
        'advanced_terminal',
      ],
      capabilities: [
        'basic_ast',
        'core_heuristics',
        'interactive_topology',
        'bounty_forge',
        'swarm_intelligence',
        'scan_history',
        'ast_diffing',
        'pdf_export',
        'advanced_terminal',
      ],
    },
    enterprise: {
      tierType: 'enterprise',
      priceId: 'contact_sales',
      name: 'Hexical Enterprise Node',
      salesLabel: 'Contact Founder for Custom Deployment',
      usageLimits: 'Custom volume based on SLA',
      contactInstructions: 'Connect with Biswarup directly to negotiate pricing, deployment, and data limits.',
      maxCharsPerRequest: 1_000_000, // Massive safety ceiling for enterprise payload processing
      features: [
        'basic_ast',
        'core_heuristics',
        'interactive_topology',
        'bounty_forge',
        'swarm_intelligence',
        'scan_history',
        'ast_diffing',
        'pdf_export',
        'advanced_terminal',
        'custom_llm_routing',
        'private_vpc_deploy',
        'soc2_compliance_logs',
        'unlimited_concurrent_agents',
      ],
      capabilities: [
        'basic_ast',
        'core_heuristics',
        'interactive_topology',
        'bounty_forge',
        'swarm_intelligence',
        'scan_history',
        'ast_diffing',
        'pdf_export',
        'advanced_terminal',
        'custom_llm_routing',
        'private_vpc_deploy',
        'soc2_compliance_logs',
        'unlimited_concurrent_agents',
      ],
    },
  } as const satisfies Record<PlanTier, PlanConfiguration>,
);

// -----------------------------------------------------------------------------
// RUNTIME VALIDATION & COMPARISON UTILITIES FOR PLAN TIERS
// -----------------------------------------------------------------------------

/** Zod schema for a raw `PlanTier` string, e.g. the body of a checkout request. */
export const PlanTierSchema = z.enum(['free', 'go', 'plus', 'pro', 'enterprise']);

/** Safe-parses an unknown value into a `PlanTier`, or returns `null`. */
export function parsePlanTier(value: unknown): PlanTier | null {
  const result = PlanTierSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function isPlanTier(value: unknown): value is PlanTier {
  return PlanTierSchema.safeParse(value).success;
}

/** Tiers that can be self-served through the payment gateway; `enterprise` is sales-assisted only. */
export const SELF_SERVE_TIERS: readonly PlanTier[] = ['go', 'plus', 'pro'];

export function isSelfServeTier(tier: PlanTier): boolean {
  return SELF_SERVE_TIERS.includes(tier);
}

export function isStandardPlan(plan: PlanConfiguration): plan is StandardPlanConfiguration {
  return plan.tierType === 'standard';
}

export function isEnterprisePlan(plan: PlanConfiguration): plan is EnterprisePlanConfiguration {
  return plan.tierType === 'enterprise';
}

export function getPlanConfig(tier: PlanTier): PlanConfiguration {
  return PLAN_LIMITS[tier];
}

export function planHasFeature(tier: PlanTier, feature: PlanFeature): boolean {
  return (PLAN_LIMITS[tier].features as readonly PlanFeature[]).includes(feature);
}

/** Ordinal ranking used for upgrade/downgrade comparisons — lower is cheaper. */
export const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  go: 1,
  plus: 2,
  pro: 3,
  enterprise: 4,
};

/** Negative if `a` is a lower tier than `b`, 0 if equal, positive if `a` is higher. */
export function compareTiers(a: PlanTier, b: PlanTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

export function isTierAtLeast(current: PlanTier, required: PlanTier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required];
}

export type ScanRequestValidation =
  | { success: true; data: ScanRequest }
  | { success: false; error: string };

/**
 * Validates a scan request payload against both its shape (Zod) and the
 * caller's plan limits (payload size). This is the single function API
 * routes should call before dispatching a scan — it's the runtime
 * enforcement of the limits declared in `PLAN_LIMITS` above, so pricing
 * and validation can never quietly drift apart.
 */
export function validateScanRequestForTier(raw: unknown, tier: PlanTier): ScanRequestValidation {
  const parsed = ScanRequestSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }

  const { maxCharsPerRequest } = PLAN_LIMITS[tier];

  if (parsed.data.logicPayload.length > maxCharsPerRequest) {
    return {
      success: false,
      error: `logicPayload exceeds the ${maxCharsPerRequest.toLocaleString()} character limit for the "${tier}" plan.`,
    };
  }

  return { success: true, data: parsed.data };
}

export type RoutePath = 'swarm' | 'forge_api' | 'global' | 'math' | 'local' | 'cluster_edge' | 'unknown';

export function inferRoute(steps: readonly string[] = []): RoutePath {
  const blob = steps.join(' ').toLowerCase();

  if (/swarm|red\s*team|blue\s*team|consensus|architect/.test(blob)) return 'swarm';
  if (/forge|hackerone|bugcrowd|pdf|export/.test(blob)) return 'forge_api';
  if (/openai|gpt|groq|anthropic|claude|cloud|remote|verification/.test(blob)) return 'global';
  if (/math|calc|solver|equation|compute/.test(blob)) return 'math';
  if (/local|database|offline|cache/.test(blob)) return 'local';
  if (/cluster|edge|mesh|gateway/.test(blob)) return 'cluster_edge';

  return 'unknown';
}