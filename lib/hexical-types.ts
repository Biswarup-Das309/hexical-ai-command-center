/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║                                     HEXICAL SECURITY OPERATING SYSTEM                                ║
 * ║                                    CORE TYPE DEFINITION MATRIX (v3.0)                                ║
 * ║                                 ULTIMATE ENTERPRISE & COMPILER-HARDENED                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
 */

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ NOMINAL TYPE BRANDING
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export type UserId = string & { readonly __brand: unique symbol };
export type WorkspaceId = string & { readonly __brand: unique symbol };
export type ProjectId = string & { readonly __brand: unique symbol };
export type ScanId = string & { readonly __brand: unique symbol };
export type AgentId = string & { readonly __brand: unique symbol };
export type SessionId = string & { readonly __brand: unique symbol };
export type MessageId = string & { readonly __brand: unique symbol };
export type FindingId = string & { readonly __brand: unique symbol };
export type EventId = string & { readonly __brand: unique symbol };
export type PluginId = string & { readonly __brand: unique symbol };

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 1: CORE RUNTIME CONSTANTS & ENUMS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 2: AI MODEL & PROVIDER METADATA
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 3: PLUGIN & ENGINE EXTENSIBILITY
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export interface EnginePlugin {
  pluginId: PluginId;
  name: string;
  version: string;
  author: string;
  capabilities: ('ast_parser' | 'fuzzer' | 'secret_scanner' | 'custom_llm_router')[];
  isEnabled: boolean;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 4: SWARM ORCHESTRATION & EXECUTION GRAPHS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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
  executionGraphRef: string; // ID referencing the DAG of agent executions
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 5: AST ENGINE & CODE CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export interface ASTContext {
  language: string;
  parserVersion: string;
  syntaxTreeHash: string;
  semanticGraphRef?: string;
  symbolTableRef?: string;
  callGraphRef?: string;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 6: STRUCTURED VULNERABILITY FINDINGS (OWASP / MITRE)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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
  mitreAttackMapping?: string[]; // e.g., ["T1190", "T1059"]
  likelihood: 'LOW' | 'MEDIUM' | 'HIGH';
  exploitMaturity: 'UNPROVEN' | 'PROOF_OF_CONCEPT' | 'WEAPONIZED' | 'ACTIVE_CAMPAIGN';
  affectedFiles: string[];
  affectedASTNodes: string[];
  reproductionSteps: string[];
  remediationPayload: string;
  fixConfidence: number; // 0-100%
  references: string[];
  cvss: CVSSv3_1;
  risk: RiskLevelType;
  isFalsePositive: boolean;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 7: AST DIFFING & STRUCTURAL DELTAS (RESTORED)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 8: RISK TIMELINE & THREAT TRAJECTORY (RESTORED)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export interface RiskTimelineEvent {
  eventId: EventId;
  scanIdRef: ScanId;
  timestamp: string;
  deltaType: 'vulnerability_introduced' | 'vulnerability_patched' | 'risk_escalation' | 'policy_override';
  findingIdRef?: FindingId;
  previousRiskState: RiskLevelType;
  newRiskState: RiskLevelType;
  actorUserId?: UserId;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 9: PERFORMANCE, TELEMETRY, & CACHING
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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
  agentExecutionTimesMs: Partial<Record<AgentRoleType, number>>; // TS Reviewer fix applied
  promptTokens: number;
  completionTokens: number;
  computeCostUsd: number;
  cacheStatistics: {
    cacheHitRate: number; // 0.0 - 1.0
    queriesBypassed: number;
    entriesRef: CacheEntryMetadata[];
  };
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 10: MULTI-TENANT WORKSPACES & PROJECTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export interface Workspace {
  id: WorkspaceId;
  name: string;
  ownerId: UserId;
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 11: IMMUTABLE AUDIT LOGGING
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY_ALERT';

export interface AuditActor {
  actorId: UserId | 'SYSTEM' | 'HEXICAL_AGENT';
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEvent {
  readonly id: EventId;
  readonly timestamp: string;
  readonly actor: AuditActor;
  readonly action: string; // e.g., "WORKSPACE_CREATED", "SCAN_OVERRIDE", "SECRET_VIEWED"
  readonly resourceId?: string;
  readonly severity: AuditSeverity;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 12: HISTORICAL SCAN PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
export interface ScanRecord {
  id: ScanId;
  projectId: ProjectId;
  userId: UserId;
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 13: CONVERSATION & STREAMING CHAT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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

// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ MODULE 14: CENTRALIZED API CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
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

export interface ScanRequest {
  projectId: ProjectId;
  logicPayload: string; // Source code, base64, or Git ref
  profile: ExecutionProfile;
  aggressiveness: 'low' | 'medium' | 'high';
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
  cryptographicSignature: string; // Server-side SHA256 validation token
}
// ═╦═════════════════════════════════════════════════════════════════════════════════════════════════════
//  ║ RESTORED MODULE: PRICING LOGIC, CONSTANTS, & ROUTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

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

export interface PlanConfiguration {
  priceId: string;
  name: string;
  maxMessagesPerMonth: number;
  maxMessagesPerDay: number;
  maxCharsPerRequest: number;
  maxConcurrentJobs: number;
  features: PlanFeature[];
}

export const PLAN_LIMITS: Record<PlanTier, PlanConfiguration> = {
  free: {
    priceId: '',
    name: 'Free Workspace',
    maxMessagesPerMonth: 600,
    maxMessagesPerDay: 20,
    maxCharsPerRequest: 10_000,
    maxConcurrentJobs: 1,
    features: ['basic_ast', 'core_heuristics'],
  },
  go: {
    priceId: 'price_go_299',
    name: 'Hexical Go',
    maxMessagesPerMonth: 1050,
    maxMessagesPerDay: 35,
    maxCharsPerRequest: 15_000,
    maxConcurrentJobs: 2,
    features: ['basic_ast', 'core_heuristics', 'standard_support'],
  },
  plus: {
    priceId: 'price_plus_999',
    name: 'Hexical Plus',
    maxMessagesPerMonth: 3000,
    maxMessagesPerDay: 100,
    maxCharsPerRequest: 32_000,
    maxConcurrentJobs: 4,
    features: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge', 'advanced_terminal'],
  },
  pro: {
    priceId: 'price_pro_4999',
    name: 'Hexical Pro Developer',
    maxMessagesPerMonth: 9000,
    maxMessagesPerDay: 300,
    maxCharsPerRequest: 120_000,
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
  },
  enterprise: {
    priceId: 'price_enterprise_custom',
    name: 'Hexical Enterprise Node',
    maxMessagesPerMonth: 999_999,
    maxMessagesPerDay: 999_999,
    maxCharsPerRequest: 500_000,
    maxConcurrentJobs: 64,
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
  },
};

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