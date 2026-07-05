export type MessageRole =
  | 'user'
  | 'hexical'
  | 'error'
  | 'architect'
  | 'red_team'
  | 'blue_team'
  | 'forge_agent'
  | 'system';

export type RoutePath =
  | 'local'
  | 'global'
  | 'math'
  | 'swarm'
  | 'forge_api'
  | 'unknown';

export type PlanTier = 'free' | 'go' | 'plus' | 'pro';

export type PlanFeature =
  | 'basic_ast'
  | 'core_heuristics'
  | 'standard_support'
  | 'interactive_topology'
  | 'bounty_forge'
  | 'swarm_intelligence'
  | 'pdf_export';

export type ExecutionProfile = 'recon' | 'swarm' | 'audit';
export type TargetArch = 'x64' | 'x86' | 'arm64';
export type Aggressiveness = 'low' | 'medium' | 'high';
export type RiskLevel = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';
export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';
export type VerifyStatus = 'completed' | 'failed';
export type RiskLevelSource =
  | 'model_generated_unverified'
  | 'deterministic_rule'
  | 'none';

export interface PlanConfiguration {
  priceId: string;
  name: string;
  maxMessages: number;
  maxCharsPerRequest: number;
  features: PlanFeature[];
}

export const PLAN_LIMITS: Record<PlanTier, PlanConfiguration> = {
  free: {
    priceId: '',
    name: 'Free',
    maxMessages: 20,
    maxCharsPerRequest: 10_000,
    features: ['basic_ast', 'core_heuristics'],
  },
  go: {
    priceId: 'price_go_299',
    name: 'Go',
    maxMessages: 35,
    maxCharsPerRequest: 15_000,
    features: ['basic_ast', 'core_heuristics', 'standard_support'],
  },
  plus: {
    priceId: 'price_plus_999',
    name: 'Plus',
    maxMessages: 100 ,
    maxCharsPerRequest: 12_000,
    features: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge'],
  },
  pro: {
    priceId: 'price_pro_4999',
    name: 'Pro',
    maxMessages: 300,
    maxCharsPerRequest: 120_000,
    features: [
      'basic_ast',
      'core_heuristics',
      'interactive_topology',
      'bounty_forge',
      'swarm_intelligence',
      'pdf_export',
    ],
  },
};

export interface HexicalMetadata {
  cveReference?: string;
  cvssScore?: number;
  threatLevel?: ThreatLevel;
  astNodeCount?: number;
  riskLevel?: RiskLevel;
  riskLevelSource?: RiskLevelSource;
  tokensUsed?: number;
  confidenceScore?: number;
  confidenceMeaning?: string;
  rateLimitRemaining?: number;
  latencyMs?: number;
}

export interface VerifyMetrics {
  latencyMs: number;
  tokensUsed: number;
  confidenceScore: number;
  confidenceMeaning?: string;
  rateLimitRemaining?: number;
}

export interface SwarmRedTeam {
  confidence: number;
  logic: string;
  payloadSuggested: string;
  vulnerabilityClasses?: string[];
  attackPathSummary?: string;
}

export interface SwarmBlueTeam {
  withstandMatrix: string;
  blockedBy: string[];
  riskLevel: RiskLevel;
}

export interface SwarmArchitect {
  route: string;
  architecturalFlaw: string;
}

export interface SwarmConsensus {
  redTeam: SwarmRedTeam;
  blueTeam: SwarmBlueTeam;
  architect: SwarmArchitect;
  finalConsensus: boolean;
  consensusMeaning?: string;
}

export interface StreamMessage {
  id: string;
  role: MessageRole;
  text: string;
  steps?: string[];
  route?: RoutePath;
  status?: VerifyStatus;
  riskLevel?: RiskLevel;
  riskLevelSource?: RiskLevelSource;
  findings?: string[];
  recommendedActions?: string[];
  swarmConsensus?: SwarmConsensus;
  metrics?: VerifyMetrics;
  metadata?: HexicalMetadata;
  valid?: boolean;
  ts: string;
}

export interface VerifyRequest {
  logic: string;
  profile?: ExecutionProfile;
  workspace?: string;
  targetArch?: TargetArch;
  autoRedact?: boolean;
  aggressiveness?: Aggressiveness;
  targetScope?: string;
  extractedTargets?: string[];
  bountyPlatform?: string;
  requestNonce: string;
  requestTimestampMs: number;
}

export interface VerifyResponse {
  analysis: string;
  steps: string[];
  status: VerifyStatus;
  riskLevel?: RiskLevel;
  riskLevelSource?: RiskLevelSource;
  findings?: string[];
  recommendedActions?: string[];
  swarmConsensus?: SwarmConsensus;
  metrics?: VerifyMetrics;
  metadata?: HexicalMetadata;
  valid?: boolean;
}

export interface VerifyErrorResponse {
  error: string;
  message?: string;
  details?: unknown;
}

export function createRequestNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildReplayFields(): Pick<VerifyRequest, 'requestNonce' | 'requestTimestampMs'> {
  return {
    requestNonce: createRequestNonce(),
    requestTimestampMs: Date.now(),
  };
}

export function inferRoute(steps: string[] = []): RoutePath {
  const blob = steps.join(' ').toLowerCase();

  if (/swarm|red\s*team|blue\s*team|consensus|architect/.test(blob)) return 'swarm';
  if (/forge|hackerone|bugcrowd|pdf|export/.test(blob)) return 'forge_api';
  if (/openai|gpt|groq|anthropic|claude|cloud|remote|verification/.test(blob)) return 'global';
  if (/math|calc|solver|equation|compute/.test(blob)) return 'math';
  if (/local|database|offline|cache/.test(blob)) return 'local';

  return 'unknown';
}

export const HEX_ENDPOINT =
  process.env.NODE_ENV === 'production'
    ? process.env.NEXT_PUBLIC_HEX_ENDPOINT || '/api/verify'
    : process.env.NEXT_PUBLIC_HEX_ENDPOINT || 'http://localhost:8000/verify';