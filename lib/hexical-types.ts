// ============================================================================
// HEXICAL CORE TYPES & CONFIGURATION
// ============================================================================

// 1. EXPANDED ROLES (To support the Swarm Intelligence)
export type MessageRole = 
  | 'user' 
  | 'hexical' 
  | 'error' 
  | 'architect' 
  | 'red_team' 
  | 'blue_team' 
  | 'forge_agent'

// 2. EXPANDED ROUTES (To support the new backend features)
export type RoutePath = 
  | 'local' 
  | 'global' 
  | 'math' 
  | 'swarm' 
  | 'forge_api' 
  | 'unknown'

// 3. TIER ARCHITECTURE (The Monetization Engine)
export type PlanTier = 'go' | 'plus' | 'pro'

export interface PlanConfiguration {
  priceId: string;
  name: string;
  maxMessages: number;
  features: string[];
}

export const PLAN_LIMITS: Record<PlanTier, PlanConfiguration> = {
  go: {
    priceId: 'price_go_299',
    name: 'Go',
    maxMessages: 50,
    features: ['basic_ast', 'core_heuristics', 'standard_support'],
  },
  plus: {
    priceId: 'price_plus_1999',
    name: 'Plus',
    maxMessages: 500,
    features: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge'],
  },
  pro: {
    priceId: 'price_pro_9599',
    name: 'Pro',
    maxMessages: 9999,
    features: ['basic_ast', 'core_heuristics', 'interactive_topology', 'bounty_forge', 'swarm_intelligence', 'pdf_export'],
  }
}

// 4. METADATA INJECTION (To handle advanced vulnerability data)
export interface HexicalMetadata {
  cveReference?: string;
  cvssScore?: number;
  threatLevel?: 'low' | 'medium' | 'high' | 'critical';
  astNodeCount?: number;
}

// 5. UPGRADED MESSAGE STRUCTURE
export interface StreamMessage {
  id: string
  role: MessageRole
  text: string
  steps?: string[]
  valid?: boolean
  route?: RoutePath
  metadata?: HexicalMetadata // New: Allows the UI to render CVSS badges on messages
  ts: string
}

// 6. UPGRADED VERIFY RESPONSE
export interface VerifyResponse {
  analysis: string
  steps: string[]
  valid: boolean
  swarmConsensus?: boolean // New: For when the red_team and blue_team agree
  metadata?: HexicalMetadata
}

// 7. ENHANCED ROUTE INFERENCE
/**
 * Infer which part of the engine handled the request from the routing steps.
 * Drives the telemetry highlight in the right sidebar.
 */
export function inferRoute(steps: string[] = []): RoutePath {
  const blob = steps.join(' ').toLowerCase()
  
  // High-priority professional routes
  if (/swarm|red team|blue team|consensus|architect/.test(blob)) return 'swarm'
  if (/forge|report|hackerone|bugcrowd|export/.test(blob)) return 'forge_api'
  
  // Standard routes
  if (/groq|global|cloud|remote/.test(blob)) return 'global'
  if (/math|calc|solver|equation|compute/.test(blob)) return 'math'
  if (/local|k-?12|database|offline|cache/.test(blob)) return 'local'
  
  return 'unknown'
}

// 8. ENVIRONMENT-AWARE ENDPOINT
// Never hardcode localhost in production. This checks for a deployed URL first.
export const HEX_ENDPOINT = process.env.NEXT_PUBLIC_HEX_ENDPOINT || 'http://localhost:8000/verify'