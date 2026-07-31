'use client'

import { useState, useEffect, useRef, useCallback, useReducer } from 'react'
import { 
  Loader2, Eye, Crosshair, ChevronDown, Activity, X, Command, AlertTriangle, 
  TerminalSquare, LayoutDashboard, Zap, SearchCode, GitMerge, Shield, 
  Hash, Code, FileText, CheckCircle, Timer, Cpu, ShieldCheck, FileJson, Workflow,
  Network, Lock, Download, Database, ArrowRightLeft, Brain
} from 'lucide-react'
import { toast } from 'sonner' 

import { HexicalLogo } from '@/components/hexical/hexical-logo'
import { createSupabaseClient } from '@/lib/supabase' 
import { useGuestLimit } from '@/hooks/use-guest-limit'
import {
  inferRoute,
  type StreamMessage,
  type TraceEvent,
  type PlanTier,
  PLAN_LIMITS
} from '@/lib/hexical/types'
import { ChatSidebar } from '@/components/hexical/chat-sidebar'
import { DataStream } from '@/components/hexical/data-stream'
import { CommandInput } from '@/components/hexical/command-input'

import UpgradeModal from '@/components/hexical/upgrade-modal'
import { useUser, useClerk, useSession } from '@clerk/nextjs'

import { 
  CVSSCalculator, 
  ASTVisualizer, 
  AttackGraphVisualizer, 
  ReconDashboard, 
  PayloadMutator, 
  BugBountyForge, 
  AdvancedTerminal 
} from '@/components/hexical/tabs'

// =============================================================================
// SECURITY NOTES — read before shipping
// =============================================================================
// This pass hardens the FRONTEND half of this console. A frontend can shrink
// its own attack surface (safer ID generation, explicit auth headers, no
// fabricated data presented as real, defense-in-depth query filters) but it
// can never make an application "fully secure" by itself — every fix here
// assumes a correctly configured backend. Concretely, /api/verify and
// anything behind it MUST, independently of whatever this client sends:
//   1. Re-derive the caller's identity from the Authorization/session token,
//      never trust a client-supplied user id, email, or plan/tier field.
//   2. Look up the caller's plan itself and enforce feature gates + rate
//      limits server-side. Everything gated in this file (hasFeatureAccess,
//      the guest usage cap) is UX only and is trivially bypassable client-side.
//   3. Enforce Supabase Row Level Security with matching USING and WITH CHECK
//      policies (e.g. `user_id = auth.uid()`) on `conversations` and
//      `messages`, so the explicit `.eq('user_id', ...)` filters added below
//      are true defense in depth, not the only thing stopping cross-account
//      access.
//   4. Sanitize/escape any model output before it's stored or rendered as
//      HTML/Markdown downstream (in DataStream et al.) to prevent stored XSS.
//      The client-side redaction below is a best-effort convenience filter
//      for accidental secret paste, not a substitute for that.
//   5. Serve job-status polling from an authenticated, same-origin route and
//      validate Origin/CSRF tokens on state-changing requests.
// None of the above can be verified or fixed from this file alone — treat
// this diff as raising the floor, not a guarantee of "zero exploitable flaws".
// =============================================================================
//
// TRUST NOTE — Investigation Timeline (read before touching the trace panel)
// =============================================================================
// The Investigation tab in the trace panel exists to answer "why should I
// trust this answer" — sources checked, cross-validation performed, risk
// assessed. Every field it renders (TraceEvent[], metrics.sourceCount,
// metrics.claimsVerified, metrics.conflictsDetected) is OPTIONAL and must
// only ever come from what the /api/verify pipeline actually did. If the
// backend hasn't started emitting `traceEvents` yet, the UI shows an honest
// empty state pointing to the raw Diagnostics tab — it must never backfill
// with a plausible-looking placeholder sequence (e.g. "✓ Searching MITRE...").
// A fake evidence trail is strictly worse than no evidence trail: the first
// time a user asks "did it actually search MITRE?" and the answer is no,
// the product's entire trust proposition breaks. See the TraceEvent
// interface below for the exact contract the backend needs to fill in.
// =============================================================================

// =============================================================================
// 1. EXTENDED TYPES & INTERFACES
// =============================================================================
type ViewMode = 'chat' | 'recon' | 'payloads' | 'terminal' | 'graph' | 'cvss' | 'bounty' | 'ast';
export type AccentTheme = 'cyan' | 'emerald' | 'rose' | 'violet' | 'amber';
type EncodingType = 'base64' | 'url' | 'hex' | 'rot13' | 'unicode';
type VerifyProfile = 'recon' | 'swarm' | 'exploit' | 'patch';
type TargetArch = 'x64' | 'x86' | 'arm64';
type Aggressiveness = 'low' | 'medium' | 'high';

interface TraceSource { 
  name: string; 
  verified: boolean; 
  type?: 'database' | 'web' | 'heuristic'; 
}

interface TraceMetrics { 
  latencyMs: number; 
  // Optional: only render these when the backend actually reports them.
  // A random placeholder number is worse than no number — it looks like data.
  tokensUsed?: number; 
  confidenceScore?: number; 
  // Same rule applies to these three: they back the Investigation tab's
  // trust signals (Sources / Claims Verified / Conflicts). Each one is only
  // rendered if the verification engine actually reports it — an empty grid
  // cell is honest, a hardcoded "4 sources" is not.
  sourceCount?: number;
  claimsVerified?: number;
  conflictsDetected?: number;
}

// A single, backend-reported step in the evidence trail behind a response.
// This type is the contract for the Investigation tab: every field must
// come from something the verification pipeline actually did. There is no
// path from here to a fabricated source or a hardcoded "match" — if the
// backend doesn't send traceEvents, the UI shows an honest empty state
// instead of inventing one (see the Investigation Timeline render below).
//
// Suggested backend shapes:
//   { type:'search', label:'MITRE CVE Database', status:'success', latencyMs:142 }
//   { type:'verification', label:'Cross Validation', left:'MITRE', right:'CISA KEV', result:'match' }
//   { type:'reasoning', label:'Threat Analysis', detail:'Weighed exploit maturity against patch availability.' }
//   { type:'risk', label:'Risk Assessment', severity:'Critical', cvss:9.8 }
//   { type:'synthesis', label:'Report Generated', detail:'Findings compiled from 4 corroborating sources.' }


interface ExtendedStreamMessage extends StreamMessage {
  sources?: TraceSource[]; 
  isVerifiedContent?: boolean; 
  metrics?: TraceMetrics;
  swarmConsensus?: SwarmEvaluation; 
  graphData?: AttackGraph;
  // Ordered evidence trail for the Investigation tab. Undefined/empty means
  // the pipeline didn't report structured trace events for this response —
  // render the honest fallback, never a placeholder timeline.
  traceEvents?: TraceEvent[];
}

interface SwarmEvaluation {
  redTeam: { confidence: number; logic: string; payloadSuggested: string };
  blueTeam: { mitigation: string; blockedBy: string[]; riskLevel: 'LOW' | 'MED' | 'HIGH' | 'CRITICAL'; withstandMatrix: string };
  architect: { route: string; architecturalFlaw: string };
  finalConsensus: boolean;
}

interface GraphNode { id: string; label: string; type: 'entry' | 'vuln' | 'pivot' | 'impact'; x: number; y: number; }
interface GraphEdge { source: string; target: string; label: string; }
interface AttackGraph { nodes: GraphNode[]; edges: GraphEdge[]; }
interface ChatState {
  id: string;
  title: string;
  pinned: boolean;
  messages: ExtendedStreamMessage[];
}
// =============================================================================
// 2. CONSTANTS, DICTIONARIES & CONFIGURATIONS
// =============================================================================
const DEFAULT_GUEST_NAME = 'Guest'
const DEFAULT_GUEST_EMAIL = 'guest@hexical.ai'

const PENDING_SESSION_ID = 'local_pending_session'
const VERIFY_ENDPOINT = '/api/verify'
// NOTE: the flat MAX_LOGIC_CHARS = 12000 constant that used to live here was
// the bug — it applied the same 12k ceiling to every tier, including Pro.
// Per-request character limits now come straight from PLAN_LIMITS[tier]
// (see lib/hexical-types.ts), read at call time in handleSubmit below, so
// each tier gets its own configured ceiling (free 10k / go 15k / plus 60k /
// pro 120k as of this writing) instead of one hardcoded number for everyone.
const POLL_INTERVAL_MS = 1500
const MAX_POLL_ATTEMPTS = 80
const PROFILE_TO_VERIFY_PROFILE: Record<string, VerifyProfile> = {
  recon: 'recon',
  swarm: 'swarm',
  'bug-hunter': 'exploit',
  defense: 'patch'
}

const createFreshChatState = (id: string): ChatState => ({
  id,
  title: 'New Context',
  pinned: false,
  messages: [{ 
    id: 'init', 
    role: 'hexical', 
    text: 'Reasoning system activated. SECURE PROTOCOLS ENGAGED. AWAITING TARGET VECTORS.', 
    ts: '00:00', 
    steps: [], 
    valid: true,
    route: 'system' as any // Fulfills the required route property
  }]
})

const THEME_MAP: Record<AccentTheme, { border: string, text: string, bg: string, glow: string, accent: string }> = {
  cyan: { border: 'border-cyan-500/20', text: 'text-cyan-400', bg: 'bg-cyan-500/10', glow: 'shadow-cyan-950/20', accent: 'cyan' },
  emerald: { border: 'border-emerald-500/20', text: 'text-emerald-400', bg: 'bg-emerald-500/10', glow: 'shadow-emerald-950/20', accent: 'emerald' },
  rose: { border: 'border-rose-500/20', text: 'text-rose-400', bg: 'bg-rose-500/10', glow: 'shadow-rose-950/20', accent: 'rose' },
  violet: { border: 'border-violet-500/20', text: 'text-violet-400', bg: 'bg-violet-500/10', glow: 'shadow-violet-950/20', accent: 'violet' },
  amber: { border: 'border-amber-500/20', text: 'text-amber-400', bg: 'bg-amber-500/10', glow: 'shadow-amber-950/20', accent: 'amber' }
}

const SECURITY_PROFILES = [
  { id: 'recon', name: 'Recon Engine', description: 'Attack surface mapping & enumeration', icon: Network, color: 'text-emerald-400', reqFeature: 'core_heuristics' },
  { id: 'swarm', name: 'Swarm Intelligence', description: 'Multi-agent Red/Blue team consensus', icon: GitMerge, color: 'text-amber-400', reqFeature: 'swarm_intelligence' },
  { id: 'bug-hunter', name: 'Exploit Architect', description: 'Weaponized PoC generation', icon: Crosshair, color: 'text-rose-400', reqFeature: 'core_heuristics' },
  { id: 'defense', name: 'Defense Matrix', description: 'WAF rules & code patch generation', icon: Shield, color: 'text-cyan-400', reqFeature: 'core_heuristics' }
]

const WORKSPACES = [
  { id: 'global', name: 'Global Namespace' }, 
  { id: 'cloud', name: 'Cloud Infrastructure (AWS/GCP)' }, 
  { id: 'web', name: 'Web Application (React/Next.js)' }, 
  { id: 'binary', name: 'Compiled Binary / Memory' },
  { id: 'appsec', name: 'AppSec (Java / C++)' }
]

const PROCESSING_PHASES = [
  "Spawning isolated WebContainer...", 
  "Injecting pre-flight heuristic hooks...",
  "Compiling AST & Control Flow Graphs...", 
  "Fuzzing input interpolations...",
  "Deploying Red Team Agent...", 
  "Deploying Blue Team Agent...",
  "Negotiating exploit feasibility...", 
  "Generating Attack SVG Maps..."
]

// =============================================================================
// 3. UTILITY ENGINES
// =============================================================================
function generateTimestamp(): string { 
  return new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 }) 
}

function generateUniqueID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();

  // Fallback for older browsers without crypto.randomUUID: still derive the
  // id from crypto.getRandomValues rather than Math.random(), which is not
  // cryptographically secure and is predictable enough to be brute-forced.
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort only (non-browser env with no Web Crypto at all).
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// NOTE: client-generated ids are fine for React `key`s and optimistic UI, but
// they are NOT an access-control boundary. Don't treat a message/job id as a
// secret token — the backend still needs auth + ownership checks on every
// read, independent of whether the id "looks" hard to guess.

// IMPORTANT: this is a best-effort convenience filter that catches obvious,
// common secret shapes before they leave the browser. It is NOT a DLP
// guarantee — regexes can't reliably catch every secret format, and a
// determined or careless paste can still get through. The backend should
// run its own scanning/redaction on anything it stores or logs; don't let
// this function be the only thing standing between a pasted secret and a
// database row.
function sanitizeLocalPayload(text: string, isActive: boolean): string {
  if (!isActive) return text;
  let s = text.replace(/\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, '[REDACTED_IPv4]');
  s = s.replace(/(eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,})/g, '[REDACTED_JWT]');
  s = s.replace(/(?:api_key|access_token|secret_key|password|client_secret|private_key)[=:\s]*(["']?)[a-zA-Z0-9_\-\/+]{16,}\1/gi, '[REDACTED_SECRET]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  s = s.replace(/\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]');
  s = s.replace(/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/g, 'Bearer [REDACTED_TOKEN]');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  s = s.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|ai|app)\b/gi, '[REDACTED_DOMAIN]');
  return s;
}

function clampNumber(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function parseJsonResponse<T = any>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return response.json().catch(() => null);
}

function getSafeClientError(status?: number): string {
  if (status === 400) return 'Request rejected. Please check the selected profile and options.';
  if (status === 401) return 'Session expired. Please sign in again.';
  if (status === 402 || status === 403) return 'Your current plan cannot run this operation.';
  if (status === 408) return 'The operation timed out. Try a smaller target or lower concurrency.';
  if (status === 429) return 'Rate limit reached. Please wait a moment and retry.';
  if (status && status >= 500) return 'The verification service is temporarily unavailable.';
  return 'Pipeline sequence failed.';
}

function getSafeExceptionMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'AUTH_TOKEN_UNAVAILABLE') return 'Session token unavailable. Please sign in again.';
    if (error.message === 'EMPTY_RESPONSE') return 'Verification service returned an empty response.';
    if (error.message === 'INVALID_JOB_ID') return 'Verification queue returned an invalid job.';
    if (error.message === 'VERIFY_JOB_ERROR') return 'Verification job failed on the server.';
    if (error.message === 'POLL_TIMEOUT') return 'Verification timed out while waiting in the queue.';
    const statusMatch = error.message.match(/^HTTP_(\d{3})$/);
    if (statusMatch) return getSafeClientError(Number(statusMatch[1]));
  }
  return 'Pipeline sequence failed.';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Request aborted', 'AbortError'));
    }, { once: true });
  });
}

const extractTargetsFromLogic = (text: string): string[] => {
  const ipRegex = /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  const domainRegex = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|ai|app|local)\b/gi;
  return Array.from(new Set([...(text.match(ipRegex) || []), ...(text.match(domainRegex) || [])])).slice(0, 8);
}

const parseAttackGraph = (logic: string): AttackGraph => {
  const isWeb = logic.includes('xss') || logic.includes('sql') || logic.includes('http');
  if (isWeb) {
    return {
      nodes: [
        { id: '1', label: 'HTTP Request', type: 'entry', x: 50, y: 150 },
        { id: '2', label: 'WAF Bypass', type: 'pivot', x: 250, y: 80 },
        { id: '3', label: 'Input Interpolation', type: 'vuln', x: 250, y: 220 },
        { id: '4', label: 'Database Execution', type: 'impact', x: 500, y: 150 }
      ],
      edges: [ 
        { source: '1', target: '2', label: 'Obfuscation' }, 
        { source: '1', target: '3', label: 'Raw Injection' }, 
        { source: '2', target: '4', label: 'Execution' }, 
        { source: '3', target: '4', label: 'Execution' } 
      ]
    };
  }
  return {
    nodes: [
      { id: '1', label: 'External Attack Surface', type: 'entry', x: 50, y: 150 },
      { id: '2', label: 'Service Enumeration', type: 'pivot', x: 300, y: 150 },
      { id: '3', label: 'Privilege Escalation', type: 'impact', x: 550, y: 150 }
    ],
    edges: [ 
      { source: '1', target: '2', label: 'Scan' }, 
      { source: '2', target: '3', label: 'Exploit' } 
    ]
  };
}

// =============================================================================
// 4. CHAT INITIALIZATION STATE MACHINE
// =============================================================================
// chats/activeId gate handleSubmit and are mutated from five call sites
// (hydration, new chat, delete, submit, pin/rename). Independent useState
// calls at each site cannot enforce the joint invariant "chats is non-empty
// AND activeId references an existing chat" under async interleaving — that
// is exactly how the "Console is still initializing" incident happened. A
// reducer makes every transition atomic and lets HYDRATE_SUCCESS see the
// real current state (React guarantees this at dispatch time, even under
// concurrent rendering / StrictMode replay) instead of a stale closure, so
// it can merge server data instead of blindly clobbering local state.
// =============================================================================

type ChatPhase = 'local' | 'hydrating' | 'ready' | 'hydration_failed'

interface ChatMachineState {
  phase: ChatPhase;
  chats: ChatState[];
  activeId: string;
  hydratedIdentity: string | null;
}

type ChatAction =
  | { type: 'HYDRATE_START' }
  | { type: 'HYDRATE_SUCCESS'; identity: string; serverChats: ChatState[] }
  | { type: 'HYDRATE_ERROR' }
  | { type: 'NEW_CHAT' }
  | { type: 'SELECT_CHAT'; id: string }
  | { type: 'DELETE_CHAT_OPTIMISTIC'; id: string }
  | { type: 'DELETE_CHAT_ROLLBACK'; snapshot: ChatState[]; activeId: string }
  | { type: 'APPEND_MESSAGES'; chatId: string; title?: string; messages: ExtendedStreamMessage[] }
  | { type: 'TOGGLE_PIN'; id: string }
  | { type: 'RENAME'; id: string; title: string }

// "Dirty" = the user has actually typed into this chat. A chat containing
// only the synthetic init message is safe to discard/replace.
function isChatDirty(chat: ChatState | undefined): boolean {
  return !!chat && chat.messages.some(m => m.role === 'user')
}

function ensureActiveId(chats: ChatState[], desired: string): string {
  return chats.some(c => c.id === desired) ? desired : (chats[0]?.id ?? desired)
}

function chatReducer(state: ChatMachineState, action: ChatAction): ChatMachineState {
  switch (action.type) {
    case 'HYDRATE_START':
      return { ...state, phase: 'hydrating' }

    case 'HYDRATE_SUCCESS': {
      const localActive = state.chats.find(c => c.id === state.activeId)

      // If the user already sent a message in the local placeholder chat
      // before this snapshot arrived, that chat is authoritative — the
      // server snapshot was taken before that message existed and would
      // silently erase it from the UI if we overwrote. Keep it, splice in
      // every other server chat. It reconciles naturally on the next
      // hydration once its own writes (conversation upsert + message
      // insert) have landed.
      if (isChatDirty(localActive)) {
        const rest = action.serverChats.filter(c => c.id !== localActive!.id)
        return {
          phase: 'ready',
          chats: [localActive!, ...rest],
          activeId: state.activeId,
          hydratedIdentity: action.identity
        }
      }

      // Local chat was untouched — safe to fully adopt the server snapshot.
      // If the local pending chat hasn't been persisted server-side yet,
      // keep it as a local-only entry rather than dropping it.
      const pendingId = state.activeId
      const serverHasPending = action.serverChats.some(c => c.id === pendingId)
      let merged = serverHasPending
        ? action.serverChats
        : [state.chats.find(c => c.id === pendingId) ?? createFreshChatState(pendingId), ...action.serverChats]

      if (merged.length === 0) merged = [createFreshChatState(generateUniqueID())]

      const existingEmpty = merged.find(c => c.messages.length <= 1)
      const nextActiveId = existingEmpty?.id ?? merged[0].id

      return {
        phase: 'ready',
        chats: merged,
        activeId: ensureActiveId(merged, nextActiveId),
        hydratedIdentity: action.identity
      }
    }

    case 'HYDRATE_ERROR':
      // Degrade gracefully: keep whatever local state already exists (it is
      // guaranteed non-empty by the initializer). No auto-retry loop here —
      // the next identity change or remount retries naturally via
      // hasHydratedRef being released by the caller.
      return { ...state, phase: 'hydration_failed', hydratedIdentity: null }

    case 'NEW_CHAT': {
      const existingEmpty = state.chats.find(c => c.messages.length <= 1)
      if (existingEmpty) return { ...state, activeId: existingEmpty.id }
      const id = generateUniqueID()
      return { ...state, chats: [createFreshChatState(id), ...state.chats], activeId: id }
    }

    case 'SELECT_CHAT':
      return state.chats.some(c => c.id === action.id) ? { ...state, activeId: action.id } : state

    case 'DELETE_CHAT_OPTIMISTIC': {
      const next = state.chats.filter(c => c.id !== action.id)
      const chats = next.length > 0 ? next : [createFreshChatState(generateUniqueID())]
      const activeId = state.activeId === action.id ? chats[0].id : ensureActiveId(chats, state.activeId)
      return { ...state, chats, activeId }
    }

    case 'DELETE_CHAT_ROLLBACK':
      return { ...state, chats: action.snapshot, activeId: action.activeId }

    case 'APPEND_MESSAGES':
      return {
        ...state,
        chats: state.chats.map(c =>
          c.id === action.chatId
            ? { ...c, title: action.title ?? c.title, messages: [...c.messages, ...action.messages] }
            : c
        )
      }

    case 'TOGGLE_PIN':
      return { ...state, chats: state.chats.map(c => c.id === action.id ? { ...c, pinned: !c.pinned } : c) }

    case 'RENAME':
      return { ...state, chats: state.chats.map(c => c.id === action.id ? { ...c, title: action.title } : c) }

    default:
      return state
  }
}

// Pure lazy initializer — safe under StrictMode's double-invoke-on-mount,
// since React only ever commits one of the two invocations. sessionStorage
// is *read* here, never written (writing is a side effect and belongs in
// an effect — see the mount effect below).
function initChatMachine(): ChatMachineState {
  const pendingId =
    (typeof window !== 'undefined' && sessionStorage.getItem(PENDING_SESSION_ID)) || generateUniqueID()
  return {
    phase: 'local',
    chats: [createFreshChatState(pendingId)],
    activeId: pendingId,
    hydratedIdentity: null
  }
}

// =============================================================================
// 5. MAIN CONSOLE COMPONENT
// =============================================================================
export function HexicalConsole() {
  const { user, isLoaded: isUserLoaded } = useUser()
  const { session, isLoaded: isSessionLoaded } = useSession()
  // Both Clerk hooks must be resolved before we trust `session` for auth
  // calls. Gating only on isUserLoaded let getAuthenticatedClient() run
  // against a not-yet-resolved session, silently fall back to the
  // anonymous singleton client, and return an empty (but error-free) result
  // from RLS-filtered queries — indistinguishable from "new user" and a
  // real data-loss risk for returning users.
  const isClerkReady = isUserLoaded && isSessionLoaded
  const { signOut, openSignIn } = useClerk() 
  const { checkLimit, recordUsage } = useGuestLimit()

  // ---------------------------------------------------------------------
  // chats/activeId are owned by the reducer above. This guarantees, from
  // the very first render (before any effect runs), that:
  //   - chats.length > 0
  //   - activeId references an existing entry in chats
  // No call site can violate that invariant; every mutation goes through
  // chatReducer.
  // ---------------------------------------------------------------------
  const [chatState, dispatch] = useReducer(chatReducer, undefined, initChatMachine)
  const { chats, activeId } = chatState

  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [loadingPhase, setLoadingPhase] = useState<string>(PROCESSING_PHASES[0])
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  const [uiTheme, setUiTheme] = useState<AccentTheme>('cyan')
  
  // TIER STATE DRIVER
  const [currentTier, setCurrentTier] = useState<PlanTier>('go') 
  
  const [systemLogs, setSystemLogs] = useState<string[]>([
    '[SYSTEM] Kernel loaded.', 
    '[AUTH] Waiting for handshake...'
  ])
  const [targetScope, setTargetScope] = useState<string>('')
  const [extractedTargets, setExtractedTargets] = useState<string[]>([])
  const [activeGraph, setActiveGraph] = useState<AttackGraph>({nodes:[], edges:[]})

  const [userName, setUserName] = useState<string>(DEFAULT_GUEST_NAME)
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_GUEST_EMAIL)
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true)
  const [isMounted, setIsMounted] = useState<boolean>(false)

  const [activeTraceMessage, setActiveTraceMessage] = useState<ExtendedStreamMessage | null>(null)
  const [showTracePanel, setShowTracePanel] = useState<boolean>(false)
  const [showRawJson, setShowRawJson] = useState<boolean>(false)
  // Trace panel is split into a user-facing "why trust this" view and a
  // developer-facing raw execution view. Investigation is the default because
  // that's the audience the product is actually for; Diagnostics is one tap
  // away for anyone who wants the unprocessed trace.
  const [activePanelTab, setActivePanelTab] = useState<'investigation' | 'diagnostics'>('investigation')
  const [activeProfileId, setActiveProfileId] = useState<string>(SECURITY_PROFILES[0].id)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(WORKSPACES[0].id)
  
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false)
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState<boolean>(false)
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false)
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false)
  
  const [stealthMode, setStealthMode] = useState<boolean>(false)
  const [autoRedact, setAutoRedact] = useState<boolean>(true) 
  const [targetArch, setTargetArch] = useState<TargetArch>('x64')
  const [aggressiveness, setAggressiveness] = useState<Aggressiveness>('low')
  const [bountyPlatform, setBountyPlatform] = useState<string>('hackerone')
  const [contextWindow, setContextWindow] = useState<string>('4096')
  const [maxConcurrency, setMaxConcurrency] = useState<string>('3')

  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const hasHydratedRef = useRef<string | null>(null)

  // FIX: PLAN_LIMITS entries expose a `capabilities` array (see
  // lib/hexical-types.ts). This previously read `.features`, which doesn't
  // exist on PlanLimitConfig — every call returned `undefined.includes(...)`
  // and threw at render time, since this gates the Topology/Payloads/TTY
  // tab icons and the profile menu unconditionally in the header.
  const hasFeatureAccess = useCallback((requiredFeature: string) => {
    return PLAN_LIMITS[currentTier].capabilities.includes(requiredFeature as any);
  }, [currentTier]);

  const logToTerminal = useCallback((msg: string) => {
    setSystemLogs(prev => [...prev, msg])
  }, []);

  // PDF export of the current trace/diagnostics panel is a paid-tier feature.
  // Gated the same way as every other premium surface in this file: check
  // hasFeatureAccess client-side for UX only. The actual report generation
  // (if this becomes a real server-rendered PDF rather than a print-to-PDF
  // export) MUST re-check entitlement server-side before returning the file.
  const handleExportPdf = useCallback(() => {
    if (!hasFeatureAccess('pdf_export')) {
      toast.error('PDF Export locked.', {
        description: 'Upgrade to a Plus or Pro workspace to export diagnostic reports as PDF.'
      });
      setShowUpgradeModal(true);
      return;
    }
    logToTerminal(`[EXPORT] Generating PDF report for current trace...`);
    window.print();
  }, [hasFeatureAccess, logToTerminal]);

  // This is intentionally a simulated console — it never executes anything.
  // If real command execution is ever wired in, it must run in an isolated,
  // backend-controlled sandbox with a strict allow-list and output limits;
  // never interpolate user input into a real shell reachable from the browser.
  const handleTerminalCommand = (cmd: string) => {
    logToTerminal(`$ ${cmd}`);
    const normalized = cmd.trim().toLowerCase();
    
    if (normalized.startsWith('nmap')) {
      setTimeout(() => logToTerminal(`Starting Nmap 7.94...`), 200);
      setTimeout(() => logToTerminal(`Nmap scan report for ${cmd.split(' ')[1] || 'target'}`), 800);
      setTimeout(() => logToTerminal(`PORT    STATE SERVICE\n80/tcp   open  http\n443/tcp  open  https\n8080/tcp open  http-proxy`), 1500);
    } else if (normalized.startsWith('ffuf')) {
      setTimeout(() => logToTerminal(`[WARN] Directory brute-forcing initiated. WAF detection likely.`), 300);
      setTimeout(() => logToTerminal(`[SUCCESS] Found: /api/v1/users (Status: 401)`), 1200);
      setTimeout(() => logToTerminal(`[SUCCESS] Found: /admin/dashboard (Status: 302)`), 1800);
    } else if (normalized.startsWith('curl')) {
      setTimeout(() => logToTerminal(`[HTTP] Sending GET request...`), 200);
      setTimeout(() => logToTerminal(`[WARN] 403 Forbidden - Request blocked by WAF.`), 600);
    } else if (normalized.startsWith('whoami')) {
      setTimeout(() => logToTerminal(`root`), 200);
    } else if (normalized === 'clear') {
      setSystemLogs([]);
    } else {
      logToTerminal(`[ERR] Command not found in WebContainer: ${cmd.split(' ')[0]}`);
    }
  }

  const getAuthenticatedClient = useCallback(async () => {
    const token = await session?.getToken({ template: 'supabase' });
    return createSupabaseClient(token || undefined);
  }, [session])

  const getApiAuthToken = useCallback(async () => {
    return session?.getToken() ?? undefined;
  }, [session])

  // Persist the pending chat id to sessionStorage exactly once, on mount.
  // This is a side effect and must live in an effect, not in the reducer's
  // lazy initializer (which must stay pure for StrictMode double-invoke
  // safety). Idempotent: if a value is already there (e.g. from a prior
  // mount in the same tab), it's left untouched.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!sessionStorage.getItem(PENDING_SESSION_ID)) {
      sessionStorage.setItem(PENDING_SESSION_ID, chatState.activeId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleNewChat = useCallback(() => {
    dispatch({ type: 'NEW_CHAT' })
    setActiveTraceMessage(null)
    setExtractedTargets([])
    setActiveGraph({ nodes: [], edges: [] })
    logToTerminal(`[SYSTEM] Spawned isolated lazy context.`)
  }, [logToTerminal])

  // ============================================================================
  // CRITICAL FIX: SECURE DELETE WITH PESSIMISTIC ROLLBACK
  // ============================================================================
  const handleDelete = useCallback(async (id: string) => {
    // 1. Cleanup the pending session memory leak
    if (id === sessionStorage.getItem(PENDING_SESSION_ID)) {
      sessionStorage.removeItem(PENDING_SESSION_ID);
    }

    // 2. Snapshot current state for rollback
    const previousChats = chats;
    const previousActiveId = activeId;

    // 3. Optimistic update via reducer — guarantees chats stays non-empty
    // and activeId stays valid even mid-delete.
    dispatch({ type: 'DELETE_CHAT_OPTIMISTIC', id });

    if (user && !stealthMode) {
      try {
        const client = await getAuthenticatedClient();
        if (!client) throw new Error("Cryptographic token missing.");
        
        // 4. Actual Database Transaction
        // Defense in depth: scope the delete to this user explicitly, even
        // though Row Level Security should already enforce it. A
        // misconfigured RLS policy shouldn't be the only thing standing
        // between a user and someone else's conversation.
        const { error } = await client.from('conversations').delete().eq('id', id).eq('user_id', user.id);
        
        if (error) {
           throw error; // Toss to catch block for immediate rollback
        }
        
        logToTerminal(`[DB] Permanent cryptographic purge executed for workspace: ${id}`);

      } catch (err: any) {
        logToTerminal(`[DB_ERR] Kernel panic during purge. Restoring session state.`);
        console.error("Supabase Delete Error:", err);
        
        // 5. Rollback to exactly how it was
        dispatch({ type: 'DELETE_CHAT_ROLLBACK', snapshot: previousChats, activeId: previousActiveId });
        toast.error("Database purge failed.", { description: "Session data restored to UI." });
      }
    }
  }, [chats, activeId, user, stealthMode, getAuthenticatedClient, logToTerminal]);

  useEffect(() => { setIsMounted(true) }, [])
  useEffect(() => { if (window.innerWidth >= 768) setIsSidebarOpen(true) }, [])
  
  useEffect(() => {
    if (!isClerkReady) return;
    let cancelled = false;

    const syncIdentity = async () => {
      if (user) {
        setUserName(user.fullName || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'User')
        setUserEmail(user.primaryEmailAddress?.emailAddress || 'no-email@hexical.ai')
        setUserAvatar(user.imageUrl || null)
        logToTerminal(`[AUTH] Cloud token derived. Sync engine online.`);

        // SECURITY: a valid session proves *who* the user is, not *what
        // they've paid for*. Default to the free tier and only upgrade the
        // UI after confirming the plan from a trusted source (a billing
        // table or Clerk metadata your webhook writes). This value is for
        // show/hide UI only — the backend must independently verify
        // entitlement on every request regardless of what's set here.
        setCurrentTier('go');
        try {
          const client = await getAuthenticatedClient();
          const { data: profile, error } = await client
            .from('profiles')
            .select('tier')
            .eq('user_id', user.id)
            .single();
          if (!cancelled && !error && profile?.tier) {
            setCurrentTier(profile.tier as PlanTier);
          }
        } catch {
          // Fail closed: if we can't confirm entitlement, stay on 'go'.
        }
      } else {
        setUserName(DEFAULT_GUEST_NAME); 
        setUserEmail(DEFAULT_GUEST_EMAIL); 
        setUserAvatar(null);
        setCurrentTier('go');
        logToTerminal(`[WARN] Ephemeral session. All telemetry and sync disabled.`);
      }
      if (!cancelled) setIsAuthLoading(false)
    };

    syncIdentity();
    return () => { cancelled = true; };
  }, [isClerkReady, user, logToTerminal, getAuthenticatedClient])

  // ============================================================================
  // CHAT HYDRATION — dispatches into chatReducer instead of setChats/
  // setActiveId directly, so the non-empty / valid-activeId invariant can
  // never be violated regardless of how this effect interleaves with user
  // actions (including a submit that lands before this resolves).
  // ============================================================================
  useEffect(() => {
    if (!isMounted || isAuthLoading) return;

    const currentUserId = user?.id || 'guest_session';
    if (hasHydratedRef.current === currentUserId) {
      return; // already hydrated this identity — don't steal focus
    }
    hasHydratedRef.current = currentUserId;

    let cancelled = false;

    const initializeChats = async () => {
      if (!user) {
        // Local seed chat already exists from initChatMachine(); mark ready.
        if (!cancelled) dispatch({ type: 'HYDRATE_SUCCESS', identity: currentUserId, serverChats: [] });
        return;
      }

      dispatch({ type: 'HYDRATE_START' });

      const supabaseAuth = await getAuthenticatedClient();
      const { data: convos, error: convoErr } = await supabaseAuth
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (cancelled) return;

      if (convoErr) {
        logToTerminal(`[DB_ERR] Failed to load sessions. Continuing in local-only mode.`);
        toast.error('Could not sync chat history.', {
          description: 'Working locally — this session will sync once the connection recovers.'
        });
        hasHydratedRef.current = null; // release lock so a later retry can re-run
        dispatch({ type: 'HYDRATE_ERROR' });
        return;
      }

      let formatted: ChatState[] = [];
      if (convos && convos.length > 0) {
        const convoIds = convos.map(c => c.id);
        const { data: msgs } = await supabaseAuth
          .from('messages')
          .select('*')
          .in('conversation_id', convoIds)
          .eq('user_id', user.id) // defense in depth alongside RLS
          .order('created_at', { ascending: true });

        if (cancelled) return;

        // NOTE: only role/text/ts/steps are persisted and rehydrated here.
        // metrics / swarmConsensus / traceEvents are NOT stored in `messages`
        // today, so the Investigation tab will show its honest empty state
        // for any message loaded from history rather than a live response.
        // If you want the evidence trail to survive a reload, `messages`
        // needs a jsonb column for this payload and the insert calls in
        // handleSubmit below need to write it.
        formatted = convos.map(c => ({
          id: c.id, 
          title: c.title, 
          pinned: c.pinned,
          messages: msgs ? msgs.filter(m => m.conversation_id === c.id).map(m => ({
              id: m.id, 
              role: m.role, 
              text: m.content, 
              ts: new Date(m.created_at).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 }),
              steps: m.role === 'hexical' ? ['REHYDRATED_STATE'] : [], 
              valid: true,
              route: 'system' as any // ADDED THIS TO SATISFY TYPESCRIPT
          })) : []
        }));

        formatted.forEach(c => { 
          if(c.messages.length === 0) c.messages = createFreshChatState(c.id).messages; 
        });
      }

      if (!cancelled) {
        dispatch({ type: 'HYDRATE_SUCCESS', identity: currentUserId, serverChats: formatted });
        sessionStorage.removeItem(PENDING_SESSION_ID);
      }
    };
    
    initializeChats();
    return () => { cancelled = true; };
  }, [isMounted, isAuthLoading, user, getAuthenticatedClient, logToTerminal]);

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    const hexMessages = activeChat?.messages.filter((m: any) => m.role === 'hexical' && m.steps?.length > 0)
    
    if (hexMessages && hexMessages.length > 0) {
      setActiveTraceMessage(hexMessages[hexMessages.length - 1])
    }
  }, [chats, activeId, busy, viewMode])

  useEffect(() => {
    let interval: NodeJS.Timeout
    if (busy && !loadingPhase.includes('Queue')) {
      let step = 0; 
      setLoadingPhase(PROCESSING_PHASES[0]);
      interval = setInterval(() => { 
        step = (step + 1) % PROCESSING_PHASES.length; 
        setLoadingPhase(PROCESSING_PHASES[step]); 
      }, 1500)
    }
    return () => clearInterval(interval)
  }, [busy, loadingPhase])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); setIsSidebarOpen(prev => !prev); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); if (activeTraceMessage) setShowTracePanel(prev => !prev); }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setShowSettingsModal(true); }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTraceMessage])

  // Cancel any in-flight request/poll loop if the console unmounts mid-request
  // (route change, tab close, etc.) so we don't keep hitting the network or
  // updating state after unmount.
  useEffect(() => {
    return () => { abortControllerRef.current?.abort(); };
  }, [])

  // ============================================================================
  // SECURE TRANSACTION HANDLER
  // ============================================================================
  const handleSubmit = async (rawLogic: string) => {
    const trimmedLogic = rawLogic.trim();
    if (busy || !trimmedLogic) return

    // FIX: read the ceiling for the user's actual tier instead of a single
    // flat constant. Previously this checked against a hardcoded 12,000
    // chars for every tier, including Pro — so Pro users hit the same wall
    // as Free users. PLAN_LIMITS[currentTier].maxCharsPerRequest is the
    // single source of truth for this (see lib/hexical-types.ts) and must
    // stay in sync with MARGIN_CHAR_LIMITS enforced server-side.
    const activeCharLimit = PLAN_LIMITS[currentTier].maxCharsPerRequest;

    if (trimmedLogic.length > activeCharLimit) {
      toast.error('Payload too large.', {
        description: `Keep verification requests under ${activeCharLimit.toLocaleString()} characters for the ${currentTier.toUpperCase()} tier.`
      });
      return;
    }

    // NOTE: this guest-usage cap lives in client storage and can be cleared
    // or bypassed trivially (incognito, devtools, etc.) — it's a UX nicety,
    // not a security control. The backend must enforce its own limits
    // (per-IP, per-fingerprint, or per-account) independently.
    if (!checkLimit()) {
      const systemWarning: ExtendedStreamMessage = { 
        id: generateUniqueID(), role: 'hexical', text: `**LOCKOUT:** Guest Limit reached.`, 
        steps: ['GUEST_LIMIT_REACHED'], valid: false, route: 'unknown' as any, ts: generateTimestamp() 
      }
      const userMsg: ExtendedStreamMessage = {
        id: generateUniqueID(), role: 'user', text: trimmedLogic, ts: generateTimestamp(),
        steps: [], valid: true, route: 'user_input' as any
      }
      dispatch({ type: 'APPEND_MESSAGES', chatId: activeId, messages: [userMsg, systemWarning] })
      openSignIn(); 
      return;
    }

    // Defensive assertion only — with the reducer guaranteeing chats is
    // always non-empty and activeId always valid from first render, this
    // branch should be structurally unreachable. Kept as a last-resort
    // guard rather than removed.
    const currentChatContext = chats.find(c => c.id === activeId) || chats[0];
    if (!currentChatContext) {
      toast.error('Console is still initializing.', { description: 'Please try again in a moment.' });
      return;
    }

    const targets = extractTargetsFromLogic(trimmedLogic);
    if (targets.length > 0) { 
      setExtractedTargets(prev => Array.from(new Set([...prev, ...targets])).slice(0, 8)); 
      logToTerminal(`[RECON] Extracted ${targets.length} valid entities from AST flow.`); 
    }
    
    const safeLogic = sanitizeLocalPayload(trimmedLogic, autoRedact);
    if (safeLogic !== trimmedLogic) {
      logToTerminal(`[SEC] Zero-Knowledge Regex triggered. Secrets stripped prior to transit.`);
    }

    const userMsg: ExtendedStreamMessage = { 
      id: generateUniqueID(), role: 'user', text: safeLogic, ts: generateTimestamp(),
      steps: [], valid: true, route: 'user_input' as any
    }
    const isNewChat = currentChatContext.messages.length <= 1;
    const generatedTitle = isNewChat ? safeLogic.split(' ').slice(0, 4).join(' ') + '...' : currentChatContext.title;

    dispatch({ type: 'APPEND_MESSAGES', chatId: activeId, title: generatedTitle, messages: [userMsg] })
    setBusy(true); 
    logToTerminal(`[TX] Transmitting heuristic model to remote cluster...`);

    if (user && !stealthMode) {
      const supabaseAuth = await getAuthenticatedClient();
      if (isNewChat) {
        await supabaseAuth.from('conversations').upsert({ id: activeId, user_id: user.id, title: generatedTitle, pinned: currentChatContext.pinned });
        sessionStorage.removeItem(PENDING_SESSION_ID); 
      }
      await supabaseAuth.from('messages').insert({ id: userMsg.id, conversation_id: activeId, user_id: user.id, content: safeLogic, role: 'user' });
    }
    
    const startTime = performance.now();
    
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const requestSignal = abortControllerRef.current.signal;

    try {
      // SECURITY: send a Clerk session token when present and keep the
      // request same-origin so cookie-based Clerk auth still works. The
      // backend must derive identity from its verified auth context, never
      // from a user id, email, or tier sent by this client.
      const authToken = user ? await getApiAuthToken() : undefined;
      if (user && !authToken) {
        throw new Error('AUTH_TOKEN_UNAVAILABLE');
      }

      const boundedMaxConcurrency = clampNumber(maxConcurrency, 1, 10, 3);
      const boundedContextWindow = clampNumber(contextWindow, 1024, 32768, 4096);
      const verifyProfile = PROFILE_TO_VERIFY_PROFILE[activeProfileId] ?? 'recon';

      const res = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          'X-Hexical-Client': 'web-console'
        },
        signal: requestSignal,
        body: JSON.stringify({
          logic: safeLogic,
          profile: verifyProfile,
          workspace: activeWorkspaceId,
          targetArch,
          autoRedact,
          aggressiveness,
          targetScope: targetScope.trim().slice(0, 500),
          extractedTargets: targets,
          bountyPlatform,
          maxConcurrency: boundedMaxConcurrency,
          contextWindow: boundedContextWindow
        })
      });
      
      if (!res.ok) {
        const errData = await parseJsonResponse<{ error?: string }>(res);
        
        // ADD 429 TO THIS CHECK:
        if (res.status === 402 || res.status === 403 || res.status === 429) {
           logToTerminal(`[SYSTEM_HALT] Transaction rejected: ${res.status}`);
           
           // Custom message if it's a 429 Rate Limit
           const errorMsg = getSafeClientError(res.status);

           const systemWarning: ExtendedStreamMessage = { 
             id: generateUniqueID(), role: 'hexical', 
             text: `**SYSTEM HALT:** ${errorMsg}`, 
             steps: ['LIMIT_REACHED'], valid: false, route: 'unknown' as any, ts: generateTimestamp() 
           }
           dispatch({ type: 'APPEND_MESSAGES', chatId: activeId, messages: [systemWarning] });
           
           // Only show upgrade modal for 402/403, not a standard rate limit cooldown
           if (res.status !== 429) setShowUpgradeModal(true);
           setBusy(false);
           return;
        }
        throw new Error(errData?.error || `HTTP_${res.status}`);
      }
      
      const initData = await parseJsonResponse(res);
      if (!initData) {
        throw new Error('EMPTY_RESPONSE');
      }
      let finalData = initData;

      if (initData.status === 'queued') {
        const jobId = initData.job_id;
        if (typeof jobId !== 'string' || jobId.length < 8) {
          throw new Error('INVALID_JOB_ID');
        }
        logToTerminal(`[QUEUE] Assigned Job ID: ${jobId}. Position: ${initData.position}`);
        setLoadingPhase(`In Queue (Position: ${initData.position})...`);

        let isPolling = true;
        let attempts = 0;
        while (isPolling && attempts < MAX_POLL_ATTEMPTS) {
          attempts += 1;
          if (requestSignal.aborted) {
            logToTerminal(`[SYSTEM] User aborted request.`); 
            setBusy(false); 
            return;
          }
          await sleep(POLL_INTERVAL_MS, requestSignal);
          
          try {
            // SECURITY: poll through our own authenticated Next.js API route
            // instead of hitting the job runner directly. A raw client-side
            // call to an internal service — and a hardcoded localhost URL is
            // itself a dev leftover that won't resolve in production — skips
            // auth, rate limiting, and CORS controls, and turns a guessable
            // job id into a de-facto bearer token: anyone who learns or
            // enumerates a jobId could read someone else's results (IDOR).
            const statusRes = await fetch(`/api/verify/status/${jobId}`, {
              headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
              credentials: 'same-origin',
              signal: requestSignal
            });
            if (!statusRes.ok) {
              throw new Error(`POLL_HTTP_${statusRes.status}`);
            }
            const statusData = await parseJsonResponse(statusRes);
            if (!statusData) {
              throw new Error('POLL_EMPTY_RESPONSE');
            }

            if (statusData.status === 'queued') { 
              setLoadingPhase(`In Queue (Position: ${statusData.position})...`); 
            } else if (statusData.status === 'processing') { 
              setLoadingPhase('Executing payload...'); 
            } else if (statusData.status === 'completed') {
              finalData = statusData.data; 
              isPolling = false;
            } else if (statusData.status === 'error') {
              throw new Error('VERIFY_JOB_ERROR');
            } else if (statusData.status === 'not_found') { 
              throw new Error("Job lost in server queue."); 
            }
          } catch (pollErr: any) {
            if (pollErr?.name === 'AbortError') { isPolling = false; return; }
            logToTerminal(`[ERR] Polling error. Retrying...`); 
          }
        }
        if (isPolling) {
          throw new Error('POLL_TIMEOUT');
        }
      }
      if (!finalData || typeof finalData !== 'object') {
        throw new Error('EMPTY_RESPONSE');
      }
      
      const executionTimeMs = Math.round(performance.now() - startTime)
      const analysisText = typeof finalData.analysis === 'string'
        ? finalData.analysis
        : 'Verification completed, but the server returned no analysis text.';
      const responseSteps = Array.isArray(finalData.steps) && finalData.steps.every((step: unknown) => typeof step === 'string')
        ? finalData.steps
        : ['VERIFY_RESPONSE_RECEIVED'];
      const responseValid = typeof finalData.valid === 'boolean' ? finalData.valid : false;

      // Only latencyMs is something we genuinely measured. Don't invent
      // plausible-looking token counts, confidence scores, source counts,
      // claim counts, or conflict counts when the backend doesn't supply
      // them — a random number that *looks* real is more misleading than an
      // honestly blank field. Each of these renders conditionally in the
      // Investigation tab's metrics grid — see the trace panel below.
      const mockMetrics: TraceMetrics = {
        latencyMs: finalData.metrics?.latencyMs ?? executionTimeMs,
        tokensUsed: finalData.metrics?.tokensUsed,
        confidenceScore: finalData.metrics?.confidenceScore,
        sourceCount: finalData.metrics?.sourceCount,
        claimsVerified: finalData.metrics?.claimsVerified,
        conflictsDetected: finalData.metrics?.conflictsDetected
      }

      // Prefer a real graph from the backend; fall back to a lightweight
      // local heuristic only as a placeholder preview, not an authoritative
      // attack graph.
      const newGraph = finalData.graphData ?? parseAttackGraph(safeLogic);
      setActiveGraph(newGraph);

      // Only show a red/blue "swarm" evaluation if the backend actually ran
      // one. The previous hardcoded object made the UI claim a multi-agent
      // evaluation happened on every message, whether or not it did — that's
      // misleading UI, not a real security capability.
      const swarmData: SwarmEvaluation | undefined = finalData.swarmConsensus

      // Same rule as swarmConsensus above: only wire through an evidence
      // trail if the backend actually generated one. Absent -> the
      // Investigation tab renders its honest empty state instead of a
      // fabricated timeline.
      const traceEventsData: TraceEvent[] | undefined = Array.isArray(finalData.traceEvents)
        ? finalData.traceEvents
        : undefined

      logToTerminal(`[RX] Received evaluated payload. Status: ${responseValid ? 'SUCCESS' : 'WARN'}. Computation Time: ${executionTimeMs}ms.`);

      const hexMsg: ExtendedStreamMessage = { 
        id: generateUniqueID(), role: 'hexical', text: analysisText, steps: responseSteps, 
        valid: responseValid, route: inferRoute(responseSteps), ts: generateTimestamp(), 
        sources: [{ name: 'Hexical Verify API', verified: true, type: 'heuristic' }], 
        isVerifiedContent: responseValid, metrics: mockMetrics, swarmConsensus: swarmData, 
        graphData: newGraph, traceEvents: traceEventsData
      }

      dispatch({ type: 'APPEND_MESSAGES', chatId: activeId, title: generatedTitle, messages: [hexMsg] })
      setActiveTraceMessage(hexMsg)
      
      if (user && !stealthMode) {
        const supabaseAuth = await getAuthenticatedClient();
        await supabaseAuth.from('messages').insert({ id: hexMsg.id, conversation_id: activeId, user_id: user.id, content: analysisText, role: 'hexical' });
      }
      recordUsage()
    } catch (err: any) { 
      if (err.name === 'AbortError') {
         logToTerminal(`[SYSTEM] Execution aborted by operator.`);
         return;
      }
      const safeErrorText = getSafeExceptionMessage(err);
      logToTerminal(`[ERR] Pipeline crash during remote execution: ${safeErrorText}`); 
      const errorMsg: ExtendedStreamMessage = { 
        id: generateUniqueID(), role: 'hexical', text: `**FATAL ERROR:** ${safeErrorText}`, 
        steps: ['SYSTEM_CRASH'], valid: false, route: 'unknown' as any, ts: generateTimestamp() 
      }
      dispatch({ type: 'APPEND_MESSAGES', chatId: activeId, messages: [errorMsg] });
    } finally { 
      setBusy(false)
      abortControllerRef.current = null
    }
  }

  if (!isMounted) return null
  
  const activeProfile = SECURITY_PROFILES.find(p => p.id === activeProfileId) || SECURITY_PROFILES[0]
  const activeWorkspace = WORKSPACES.find(w => w.id === activeWorkspaceId) || WORKSPACES[0]

  function getContextualGreeting() {
    const hour = new Date().getHours()
    const timePhrase = hour < 6 ? 'Night shift' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
    return `${timePhrase}, ${activeProfile?.name} ready for ${activeWorkspace?.name} diagnostics`
  }

  function handleRename(id: string, newTitle: string): void {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    dispatch({ type: 'RENAME', id, title: trimmed });
    if (user && !stealthMode) {
      void (async () => {
        try {
          const supabaseAuth = await getAuthenticatedClient();
          await supabaseAuth.from('conversations').update({ title: trimmed }).eq('id', id).eq('user_id', user.id);
        } catch {
          logToTerminal(`[WARN] Failed to sync rename for chat ${id}.`);
        }
      })()
    }
  }

  function handleTogglePin(id: string): void {
    const chat = chats.find(c => c.id === id);
    dispatch({ type: 'TOGGLE_PIN', id })

    if (chat && user && !stealthMode) {
      void (async () => {
        try {
          const supabaseAuth = await getAuthenticatedClient()
          // Requires an RLS policy with a WITH CHECK on `user_id = auth.uid()`
          // for both insert and update — otherwise an upsert keyed on a
          // guessed/leaked conversation id could let one user overwrite
          // another user's title/pin state.
          await supabaseAuth.from('conversations').upsert({ 
            id: chat.id, user_id: user.id, title: chat.title, pinned: !chat.pinned 
          })
        } catch (error) { 
          logToTerminal(`[WARN] Failed to sync pin state for chat ${id}.`) 
        }
      })()
    }
  }

  const lastUserPayload = activeChat?.messages?.filter((m: any) => m.role === 'user').slice(-1)[0]?.text || '';

  const LockedFeatureOverlay = ({ featureName }: { featureName: string }) => (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md font-sans p-6 text-center">
      <div className="max-w-md bg-[#111116] border border-white/10 rounded-2xl p-8 shadow-2xl flex flex-col items-center">
        <div className="size-16 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-6">
          <Lock className="size-8 text-cyan-400" />
        </div>
        <h3 className="text-xl font-bold text-white mb-2">Restricted Action</h3>
        <p className="text-sm text-zinc-400 mb-8 leading-relaxed">
          The <span className="text-white font-medium">{featureName}</span> is locked under your current license. 
          Upgrade to a Plus or Pro workspace to deploy advanced diagnostic matrices.
        </p>
        <button 
          onClick={() => setShowUpgradeModal(true)}
          className="w-full py-3 bg-white text-black hover:bg-white/90 font-bold rounded-xl transition-colors shadow-[0_0_20px_rgba(255,255,255,0.1)]"
        >
          View System Licenses
        </button>
      </div>
    </div>
  )

  return (
    <>
      {showUpgradeModal && <UpgradeModal onClose={() => setShowUpgradeModal(false)} />}
      
      {showSettingsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in font-sans">
           <div className="bg-[#0a0a0c] border border-white/10 rounded-2xl w-full max-w-5xl h-[85vh] flex p-4 text-white">
              <div className="m-auto text-center">Settings modal content remains the same. Click X to close.</div>
              <button onClick={() => setShowSettingsModal(false)} className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-white"><X/></button>
           </div>
        </div>
      )}

      {/* ---------------- MAIN UI LAYOUT ---------------- */}
      <div className={`flex h-screen w-full bg-[#0a0a0c] text-foreground overflow-hidden font-mono selection:${THEME_MAP[uiTheme].bg}`}>
        
        {isSidebarOpen && (
          <>
            <div 
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40 md:hidden" 
              onClick={() => setIsSidebarOpen(false)} 
            />
            <div className="fixed md:relative w-[280px] h-full border-r border-white/5 flex-shrink-0 z-50 bg-[#0a0a0c] shadow-[20px_0_50px_rgba(0,0,0,0.5)] md:shadow-none transition-transform">
               <ChatSidebar 
                 chats={chats} 
                 activeId={activeId} 
                 isOpen={isSidebarOpen} 
                 userName={isAuthLoading ? "Booting..." : userName} 
                 userEmail={isAuthLoading ? "Securing..." : userEmail} 
                 avatarUrl={userAvatar} 
                 currentTier={currentTier}
                 onToggleOpen={() => setIsSidebarOpen(false)} 
                 onSelect={(id) => dispatch({ type: 'SELECT_CHAT', id })} 
                 onNewChat={handleNewChat} 
                 onDeleteChat={handleDelete} 
                 onRenameChat={handleRename} 
                 onTogglePin={handleTogglePin} 
                 onSignOut={() => signOut(() => window.location.reload())} 
                 onOpenUpgrade={() => setShowUpgradeModal(true)}
               />
            </div>
          </>
        )}

        <main className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-zinc-950 via-[#0a0a0c] to-[#0a0a0c] min-w-0 overflow-hidden">
          
          <header className="relative z-[50] flex shrink-0 h-16 items-center justify-between gap-3 border-b border-white/5 bg-[#0a0a0c]/80 px-4 md:px-6 backdrop-blur-md overflow-visible">
            
            <div className="flex items-center gap-3 shrink-0" ref={headerMenuRef}>
              {!isSidebarOpen && (
                <button 
                  onClick={() => setIsSidebarOpen(true)} 
                  className="flex items-center gap-3 hover:bg-white/5 p-2 rounded-xl transition-all"
                >
                  <HexicalLogo className={`size-6 ${THEME_MAP[uiTheme].text}`} />
                </button>
              )}
              <div className="h-6 w-px bg-white/10 mx-1 hidden md:block"></div>
            </div>

            <div className="flex-1 flex items-center overflow-x-auto no-scrollbar gap-2 shrink">
              <div className="hidden lg:flex p-1 bg-white/[0.02] border border-white/5 rounded-lg backdrop-blur-md shrink-0">
                <button onClick={() => setViewMode('chat')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'chat' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><LayoutDashboard size={14}/> Core</button>
                
                <button onClick={() => setViewMode('graph')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'graph' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}>
                  {hasFeatureAccess('interactive_topology') ? <Workflow size={14}/> : <Lock size={12} className="text-zinc-600" />} Topology
                </button>
                <button onClick={() => setViewMode('payloads')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'payloads' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}>
                  {hasFeatureAccess('core_heuristics') ? <Zap size={14}/> : <Lock size={12} className="text-zinc-600" />} Payloads
                </button>
                <button onClick={() => setViewMode('bounty')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'bounty' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}>
                  <FileText size={14}/> Forge
                </button>
                
                <button onClick={() => setViewMode('ast')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'ast' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Code size={14}/> AST</button>
                <button onClick={() => setViewMode('cvss')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'cvss' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}><Hash size={14}/> CVSS</button>
                <button onClick={() => setViewMode('terminal')} className={`px-3 py-1.5 text-xs font-sans rounded-md transition-all flex items-center gap-2 ${viewMode === 'terminal' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'}`}>
                  {hasFeatureAccess('advanced_terminal') ? <TerminalSquare size={14}/> : <Lock size={12} className="text-zinc-600" />} TTY
                </button>
              </div>

              {extractedTargets.length > 0 && viewMode === 'chat' && (
                <div className="hidden xl:flex items-center gap-2 ml-2 pl-3 border-l border-white/10 shrink-0">
                  <span className={`text-[9px] ${THEME_MAP[uiTheme].text} uppercase tracking-widest font-bold`}>Targets</span>
                  {extractedTargets.slice(0,3).map((target, idx) => (
                    <span 
                      key={idx} 
                      className={`${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border} px-2 py-1 rounded text-[10px] font-mono whitespace-nowrap`}
                    >
                      {target}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0 relative z-10 pl-2">
              <div className="relative">
                <button 
                  onClick={() => { setShowProfileMenu(!showProfileMenu); setShowWorkspaceMenu(false); }} 
                  className="flex items-center gap-2 bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 px-3 py-1.5 rounded-lg transition-all text-xs font-sans"
                >
                  <activeProfile.icon className={`size-3.5 ${activeProfile.color}`} />
                  <span className="font-medium text-foreground/80 hidden sm:block">{activeProfile.name}</span>
                  <ChevronDown className="size-3 text-muted-foreground ml-1" />
                </button>
                
                {showProfileMenu && (
                  <div className="absolute top-full right-0 mt-2 w-64 bg-[#111116] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-fade-in z-[100]">
                    <div className="p-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-white/5">
                      Active Agent Override
                    </div>
                    <div className="p-1">
                      {SECURITY_PROFILES.map(profile => {
                        const canAccessProfile = hasFeatureAccess(profile.reqFeature);
                        return (
                          <button 
                            key={profile.id} 
                            onClick={() => { 
                              if(canAccessProfile) {
                                setActiveProfileId(profile.id); 
                                setShowProfileMenu(false);
                              } else {
                                toast.error(`${profile.name} locked.`, {
                                  description: "Requires advanced matrix license. Defaulting to Recon Engine."
                                });
                                setActiveProfileId('recon'); 
                                setShowProfileMenu(false);
                                setTimeout(() => setShowUpgradeModal(true), 500); 
                              }
                            }} 
                            className={`w-full flex items-start gap-3 p-2.5 rounded-lg text-left transition-all ${!canAccessProfile ? 'opacity-50 hover:bg-white/5' : activeProfileId === profile.id ? 'bg-white/5' : 'hover:bg-white/5'}`}
                          >
                            {canAccessProfile ? <profile.icon className={`size-4 mt-0.5 ${profile.color}`} /> : <Lock className="size-4 mt-0.5 text-zinc-500" />}
                            <div className="flex-1">
                              <div className={`font-sans font-medium text-xs ${activeProfileId === profile.id && canAccessProfile ? 'text-white' : 'text-foreground/80'}`}>
                                {profile.name}
                              </div>
                              <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                                {profile.description}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              {activeTraceMessage && activeTraceMessage.steps && activeTraceMessage.steps.length > 0 && viewMode === 'chat' && (
                <button 
                  onClick={() => setShowTracePanel(!showTracePanel)} 
                  title="Inspect Logic (Cmd+I)" 
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-sans border transition-all shadow-lg ${showTracePanel ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].border} text-white` : 'bg-white/5 border-white/10 hover:border-white/20 text-muted-foreground hover:text-white backdrop-blur-md'}`}
                >
                  <Eye className="size-3.5" />
                  <span className="hidden sm:inline">{showTracePanel ? 'Close' : 'Trace Logs'}</span>
                  <kbd className="hidden md:inline-flex items-center gap-1 font-mono text-[9px] opacity-50 ml-2 border border-current rounded px-1">
                    <Command className="size-2.5"/> I
                  </kbd>
                </button>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 flex flex-col relative">
            
            {viewMode === 'recon' && (
              <div className="p-4 md:p-6 h-full relative">
                {!hasFeatureAccess('core_heuristics') && <LockedFeatureOverlay featureName="Reconnaissance Engine" />}
                <div className={!hasFeatureAccess('core_heuristics') ? 'blur-md pointer-events-none' : ''}><ReconDashboard targets={extractedTargets} theme={uiTheme} /></div>
              </div>
            )}
            
            {viewMode === 'graph' && (
              <div className="p-4 md:p-6 h-full relative">
                {!hasFeatureAccess('interactive_topology') && <LockedFeatureOverlay featureName="Interactive Topology Graph" />}
                <div className={`w-full h-full ${!hasFeatureAccess('interactive_topology') ? 'blur-md pointer-events-none' : ''}`}>
                  <AttackGraphVisualizer graph={activeGraph} theme={uiTheme} />
                </div>
              </div>
            )}

            {viewMode === 'payloads' && (
              <div className="p-4 md:p-6 h-full relative">
                {!hasFeatureAccess('core_heuristics') && <LockedFeatureOverlay featureName="Advanced Payload Mutator" />}
                <div className={!hasFeatureAccess('core_heuristics') ? 'blur-md pointer-events-none' : ''}><PayloadMutator theme={uiTheme} /></div>
              </div>
            )}

            {viewMode === 'bounty' && (
              <div className="p-4 md:p-6 h-full relative">
                <BugBountyForge theme={uiTheme} targets={extractedTargets} />
              </div>
            )}

            {viewMode === 'cvss' && <div className="p-4 md:p-6 h-full"><CVSSCalculator theme={uiTheme} /></div>}
            {viewMode === 'ast' && <div className="p-4 md:p-6 h-full"><ASTVisualizer theme={uiTheme} codePayload={lastUserPayload} /></div>}
            {viewMode === 'terminal' && (
              <div className="p-4 md:p-6 h-full relative">
                {!hasFeatureAccess('advanced_terminal') && <LockedFeatureOverlay featureName="Advanced TTY Sandbox" />}
                <div className={`mx-auto h-full max-w-5xl ${!hasFeatureAccess('advanced_terminal') ? 'blur-md pointer-events-none' : ''}`}>
                  <AdvancedTerminal logs={systemLogs} theme={uiTheme} onCommand={handleTerminalCommand} />
                </div>
              </div>
            )}

            {viewMode === 'chat' && (
              <div className="flex-1 flex flex-col justify-end px-2 md:px-6 py-6 max-w-3xl mx-auto w-full">
                {activeChat?.messages.length <= 1 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center my-auto min-h-[50vh]">
                    <div className="mb-8 relative flex justify-center">
                      <div className={`absolute inset-0 bg-${THEME_MAP[uiTheme].accent}-500 blur-[80px] opacity-20 rounded-full w-48 h-48 m-auto`} />
                      <HexicalLogo className={`size-16 relative z-10 ${THEME_MAP[uiTheme].text}`} />
                    </div>
                    <h2 className="text-2xl md:text-4xl font-sans mb-8 text-foreground tracking-tight leading-relaxed">
                      {isAuthLoading ? (
                        <span className="flex items-center justify-center gap-3 text-muted-foreground text-xl">
                          <Loader2 className={`animate-spin size-6 ${THEME_MAP[uiTheme].text}`} /> 
                          Securing session bounds...
                        </span>
                      ) : (
                        <>
                          {getContextualGreeting()}, 
                          <span className={`font-semibold drop-shadow-[0_0_15px_rgba(255,255,255,0.1)] ${THEME_MAP[uiTheme].text}`}>
                            {userName}
                          </span>.
                        </>
                      )}
                    </h2>
                  </div>
                ) : (
                  <div className="flex flex-col pb-4">
                   <DataStream messages={activeChat?.messages ?? []} busy={busy} />
                    <div ref={messagesEndRef} className="h-6 shrink-0" />
                  </div>
                )}
              </div>
            )}
          </div>

          {viewMode === 'chat' && (
            <footer className="shrink-0 border-t border-white/5 bg-[#0a0a0c]/95 px-4 pb-6 pt-3 backdrop-blur-xl z-[40]">
              <div className="mx-auto max-w-3xl flex flex-col">
                <div className={`mb-2 flex justify-center transition-all duration-300 ${busy ? 'h-8 opacity-100' : 'h-0 opacity-0 overflow-hidden'}`}>
                  <div className={`flex items-center gap-2 text-xs font-mono px-4 py-1.5 rounded-full border backdrop-blur-md ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} ${THEME_MAP[uiTheme].border}`}>
                    <Activity className="size-3 animate-pulse" /> 
                    {loadingPhase}
                  </div>
                </div>
                
                <div className={`rounded-3xl border border-white/10 bg-black/60 backdrop-blur-3xl shadow-[0_0_30px_rgba(0,0,0,0.5)] focus-within:border-${THEME_MAP[uiTheme].accent}-500/50 transition-all`}>
                  <div className="flex items-center gap-2 mb-2 px-4 pt-3">
                    <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-semibold px-2 py-1 rounded border ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} ${THEME_MAP[uiTheme].border}`}>
                      <Crosshair size={10} /> 
                      Scope:
                    </div>
                    <input 
                      type="text" 
                      placeholder="e.g. optimizely.com or vercel.app" 
                      value={targetScope} 
                      onChange={(e) => setTargetScope(e.target.value)} 
                      className="bg-transparent text-xs text-zinc-300 placeholder:text-zinc-600 outline-none flex-1 font-mono" 
                    />
                  </div>
                  <div className="px-1 pb-1">
                     <CommandInput 
                       onSubmit={handleSubmit} 
                       busy={busy} 
                       onStop={() => abortControllerRef.current?.abort()} 
                       activeTier={currentTier}
                     />
                  </div>
                </div>
              </div>
            </footer>
          )}
        </main>

        {showTracePanel && activeTraceMessage && viewMode === 'chat' && (
          <div className="w-[380px] md:w-[450px] h-full border-l border-white/5 bg-[#0a0a0c]/95 backdrop-blur-3xl flex flex-col overflow-hidden animate-fade-in flex-shrink-0 z-40 shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">
            
            {/* Header */}
            <div className="border-b border-white/10 bg-black/40">
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <SearchCode className={`size-4 ${THEME_MAP[uiTheme].text}`} />
                  <span className="text-xs uppercase font-bold tracking-widest text-foreground">Case File</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleExportPdf}
                    title={hasFeatureAccess('pdf_export') ? 'Export as PDF' : 'Export as PDF (Paid workspaces only)'}
                    className="p-1 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors"
                  >
                    {hasFeatureAccess('pdf_export') ? <Download size={16} /> : <Lock size={16} className="text-zinc-600" />}
                  </button>
                  <button 
                    onClick={() => setShowTracePanel(false)} 
                    className="p-1 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Investigation vs Diagnostics — Investigation is "why should
                  you trust this", built only from fields the backend actually
                  returned. Diagnostics is "how did the system execute this",
                  for developers who want the raw trace. Neither tab is
                  allowed to backfill missing data with something invented. */}
              <div className="px-4 pb-3 flex items-center gap-1">
                <button
                  onClick={() => setActivePanelTab('investigation')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[10px] font-sans font-semibold uppercase tracking-wider transition-all ${activePanelTab === 'investigation' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-500 hover:text-white border border-transparent'}`}
                >
                  <Eye size={12} /> Investigation
                </button>
                <button
                  onClick={() => setActivePanelTab('diagnostics')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[10px] font-sans font-semibold uppercase tracking-wider transition-all ${activePanelTab === 'diagnostics' ? `${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}` : 'text-zinc-500 hover:text-white border border-transparent'}`}
                >
                  <TerminalSquare size={12} /> Diagnostics
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs scrollbar-thin scrollbar-thumb-white/10">

              {activePanelTab === 'investigation' ? (
                <>
                  {/* Status Tags */}
                  <div className="flex items-center justify-between text-[10px] font-mono font-bold uppercase tracking-wider">
                    <div>
                      <span className="text-muted-foreground block mb-1 font-sans normal-case tracking-wide font-semibold">Analysis Route</span>
                      <span className={`px-2 py-1 ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border} rounded`}>
                        {activeTraceMessage.route || 'default_eval'}
                      </span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-muted-foreground block mb-1 font-sans normal-case tracking-wide font-semibold">Evidence Status</span>
                      {activeTraceMessage.isVerifiedContent ? 
                        <span className="text-emerald-400 flex items-center gap-1 bg-emerald-950/40 border border-emerald-500/20 px-2 py-1 rounded">
                          <CheckCircle size={12}/> VERIFIED
                        </span> : 
                        <span className="text-amber-400 flex items-center gap-1 bg-amber-950/40 border border-amber-500/20 px-2 py-1 rounded">
                          <AlertTriangle size={12}/> UNVERIFIED
                        </span>
                      }
                    </div>
                  </div>

                  {/* Trust metrics — every cell is optional and only appears
                      if activeTraceMessage.metrics actually carries that
                      field. An empty grid is the honest outcome when the
                      backend hasn't wired this up yet; never fill gaps with
                      plausible-looking numbers. */}
                  {(() => {
                    const m = activeTraceMessage.metrics;
                    const cells = [
                      m?.confidenceScore != null && { icon: ShieldCheck, label: 'Confidence', value: `${m.confidenceScore}%`, tone: THEME_MAP[uiTheme].text },
                      m?.sourceCount != null && { icon: Database, label: 'Sources', value: String(m.sourceCount), tone: 'text-white' },
                      m?.claimsVerified != null && { icon: FileText, label: 'Claims Verified', value: String(m.claimsVerified), tone: 'text-white' },
                      m?.conflictsDetected != null && { icon: AlertTriangle, label: 'Conflicts', value: String(m.conflictsDetected), tone: m.conflictsDetected > 0 ? 'text-rose-400' : 'text-emerald-400' }
                    ].filter(Boolean) as { icon: any; label: string; value: string; tone: string }[];

                    if (cells.length === 0) {
                      return (
                        <div className="text-muted-foreground italic text-center py-2 border border-dashed border-white/10 rounded-lg bg-white/[0.01]">
                          Extended verification metrics not reported by this pipeline yet.
                        </div>
                      );
                    }

                    const colClass = cells.length >= 4 ? 'grid-cols-4' : cells.length === 3 ? 'grid-cols-3' : cells.length === 2 ? 'grid-cols-2' : 'grid-cols-1';

                    return (
                      <div className={`grid gap-2 ${colClass}`}>
                        {cells.map((c, i) => (
                          <div key={i} className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                            <c.icon size={14} className="text-zinc-500 mb-1" />
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-sans">{c.label}</span>
                            <span className={`${c.tone} font-mono text-xs`}>{c.value}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Swarm Consensus — only renders if the backend actually
                      ran a red/blue team evaluation for this message. */}
                  {activeTraceMessage.swarmConsensus && (
                    <div className="space-y-3">
                       <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2 flex items-center gap-2">
                         <GitMerge size={12}/> Multi-Agent Swarm Consensus
                       </span>
                       <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl relative overflow-hidden group">
                         <div className="absolute top-0 right-0 bg-rose-500/20 text-rose-400 text-[8px] px-2 py-0.5 rounded-bl-lg font-bold">RED TEAM (OFFENSIVE)</div>
                         <div className="font-mono text-rose-300/80 mb-2 leading-relaxed mt-2">"{activeTraceMessage.swarmConsensus.redTeam.logic}"</div>
                         <div className="flex items-center justify-between bg-black/40 p-2 rounded border border-rose-500/10">
                           <span className="text-rose-400/50">Exploit Confidence</span>
                           <span className="text-rose-400 font-bold">{activeTraceMessage.swarmConsensus.redTeam.confidence}%</span>
                         </div>
                       </div>
                       <div className="p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-xl relative overflow-hidden group">
                         <div className="absolute top-0 right-0 bg-cyan-500/20 text-cyan-400 text-[8px] px-2 py-0.5 rounded-bl-lg font-bold">BLUE TEAM (DEFENSIVE)</div>
                         <div className="font-mono text-cyan-300/80 mb-2 leading-relaxed mt-2">"{activeTraceMessage.swarmConsensus.blueTeam.mitigation}"</div>
                         <div className="flex items-center justify-between bg-black/40 p-2 rounded border border-cyan-500/10">
                           <span className="text-cyan-400/50">Calculated Risk Level</span>
                           <span className="text-cyan-400 font-bold">{activeTraceMessage.swarmConsensus.blueTeam.riskLevel}</span>
                         </div>
                       </div>
                    </div>
                  )}

                  {/* Investigation Timeline — built entirely from
                      activeTraceMessage.traceEvents. If the backend hasn't
                      started emitting these yet, this shows an honest empty
                      state rather than a fake "Searching MITRE... ✓"
                      sequence. See the TraceEvent interface near the top of
                      this file for the exact contract /api/verify needs to
                      fill in for this section to populate. */}
                  {(() => {
                    const events = activeTraceMessage.traceEvents ?? [];

                    if (events.length === 0) {
                      return (
                        <div className="space-y-3 pt-2">
                          <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2 flex items-center gap-2">
                            <SearchCode size={12}/> Investigation Timeline
                          </span>
                          <div className="text-muted-foreground italic p-4 text-center border border-dashed border-white/10 rounded-xl bg-white/[0.01] leading-relaxed">
                            This response doesn't have a structured evidence trail yet.
                            Check the <span className="text-foreground/70 font-medium not-italic">Diagnostics</span> tab for the raw execution log.
                          </div>
                        </div>
                      );
                    }

                    const iconFor = (ev: TraceEvent) => {
                      switch (ev.type) {
                        case 'recon': return SearchCode;
                        case 'fingerprint': return Cpu;
                        case 'route': return Network;
                        case 'search': return Database;
                        case 'verification': return ArrowRightLeft;
                        case 'reasoning': return Brain;
                        case 'risk': return AlertTriangle;
                        case 'synthesis': return FileText;
                        default: return Activity;
                      }
                    };

                    const toneFor = (ev: TraceEvent) => {
                      if (ev.result === 'conflict' || ev.status === 'failed') return { dot: 'border-rose-500/50 shadow-[0_0_8px_rgba(244,63,94,0.5)]', text: 'text-rose-400' };
                      if (ev.result === 'unverified' || ev.status === 'partial') return { dot: 'border-amber-500/50 shadow-[0_0_8px_rgba(245,158,11,0.5)]', text: 'text-amber-400' };
                      if (ev.type === 'risk') return { dot: 'border-amber-500/50 shadow-[0_0_8px_rgba(245,158,11,0.5)]', text: 'text-amber-400' };
                      return { dot: 'border-emerald-500/50 shadow-[0_0_8px_rgba(16,185,129,0.5)]', text: 'text-emerald-400' };
                    };

                    return (
                      <div className="space-y-3 pt-2">
                        <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2 flex items-center gap-2">
                          <SearchCode size={12}/> Investigation Timeline
                        </span>
                        <div className="space-y-0 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
                          {events.map((ev, idx) => {
                            const Icon = iconFor(ev);
                            const tone = toneFor(ev);
                            return (
                              <div key={ev.id ?? idx} className="relative flex items-start gap-3 pb-6 last:pb-0 group">
                                <div className={`absolute -left-1.5 top-1 size-3 bg-[#0a0a0c] border-2 rounded-full z-10 ${tone.dot}`} />
                                <div className="ml-2 w-full bg-white/[0.02] border border-white/5 rounded-lg p-3">
                                  <h3 className={`text-xs font-bold mb-2 flex items-center gap-2 ${tone.text}`}>
                                    <Icon className="w-3 h-3 shrink-0" /> 
                                    <span className="flex-1">{ev.label}</span>
                                    {ev.latencyMs != null && <span className="text-[9px] text-zinc-500 font-mono normal-case">{ev.latencyMs}ms</span>}
                                  </h3>

                                  {ev.type === 'recon' && ev.attackSurfaceMetrics && (
                                    <div className="grid grid-cols-3 gap-2 mt-1 font-mono text-[10px]">
                                      {(['endpoints', 'forms', 'authRoutes'] as const).map((k) => (
                                        <div key={k} className="bg-black/40 p-2 rounded border border-white/5 text-center">
                                          <div className="text-zinc-500 capitalize">{k}</div>
                                          <div className="text-white font-bold">{ev.attackSurfaceMetrics![k]}</div>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {ev.type === 'fingerprint' && ev.technologies && ev.technologies.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                      {ev.technologies.map((tech, tIdx) => (
                                        <span key={tIdx} className="bg-white/5 border border-white/10 px-2 py-0.5 rounded text-[9px] text-zinc-300 font-mono">
                                          {tech}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {ev.type === 'route' && ev.routeInfo && (
                                    <div className="grid grid-cols-1 gap-1 mt-2 bg-black/40 p-2 rounded border border-white/5 font-mono text-[10px]">
                                      <div><span className="text-zinc-500">Route:</span> <span className="text-cyan-400 font-bold">{ev.routeInfo.selectedRoute}</span></div>
                                      <div><span className="text-zinc-500">Model:</span> <span className="text-zinc-300">{ev.routeInfo.model}</span></div>
                                      <div><span className="text-zinc-500">Reason:</span> <span className="text-zinc-300">{ev.routeInfo.reason}</span></div>
                                    </div>
                                  )}

                                  {ev.type === 'verification' && (
                                    <>
                                      <div className="flex items-center gap-2 bg-black/40 p-1.5 rounded border border-white/5 font-mono text-[10px] text-zinc-300">
                                        <span>{ev.left}</span> <ArrowRightLeft className="w-2.5 h-2.5 text-zinc-600 shrink-0"/> <span>{ev.right}</span>
                                        <span className={`ml-auto ${tone.text} capitalize`}>{ev.result ?? 'unknown'}</span>
                                      </div>
                                      {ev.evidence && ev.evidence.length > 0 && (
                                        <div className="mt-2 space-y-1 bg-black/30 p-2 rounded border border-white/5 font-mono text-[10px]">
                                          {ev.evidence.map((item, eIdx) => (
                                            <div key={eIdx} className="text-zinc-300 flex items-start gap-1">
                                              <span className="text-amber-400">•</span> {item}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </>
                                  )}

                                  {ev.type === 'risk' && (
                                    <div className="mt-1 grid grid-cols-2 gap-2 bg-black/40 p-2 rounded border border-white/5 font-mono text-[10px]">
                                      {ev.severity && (
                                        <div className="col-span-2">
                                          <span className="text-zinc-500">Severity:</span>{' '}
                                          <span className={`font-bold ${tone.text}`}>{ev.severity}{ev.cvss != null ? ` (CVSS ${ev.cvss})` : ''}</span>
                                        </div>
                                      )}
                                      {ev.impact && (
                                        <div className="col-span-2"><span className="text-zinc-500">Impact:</span> <span className="text-white font-medium">{ev.impact}</span></div>
                                      )}
                                      {ev.attackComplexity && (
                                        <div><span className="text-zinc-500">Complexity:</span> <span className="text-zinc-300">{ev.attackComplexity}</span></div>
                                      )}
                                      {ev.privilegesRequired && (
                                        <div><span className="text-zinc-500">Privileges:</span> <span className="text-zinc-300">{ev.privilegesRequired}</span></div>
                                      )}
                                      {ev.userInteraction && (
                                        <div className="col-span-2"><span className="text-zinc-500">Interaction:</span> <span className="text-zinc-300">{ev.userInteraction}</span></div>
                                      )}
                                    </div>
                                  )}

                                  {(ev.type === 'reasoning' || ev.type === 'synthesis' || ev.type === 'search' || ev.type === 'general') && ev.detail && (
                                    <p className="font-mono text-[10px] text-zinc-400 leading-relaxed">{ev.detail}</p>
                                  )}

                                  {/* Recon/fingerprint honest empty state — no matches found, no metrics to show */}
                                  {ev.type === 'recon' && !ev.attackSurfaceMetrics && ev.detail && (
                                    <p className="font-mono text-[10px] text-zinc-500 italic leading-relaxed">{ev.detail}</p>
                                  )}
                                  {ev.type === 'fingerprint' && (!ev.technologies || ev.technologies.length === 0) && ev.detail && (
                                    <p className="font-mono text-[10px] text-zinc-500 italic leading-relaxed">{ev.detail}</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </>
              ) : (
                <>
                  {/* Diagnostics: developer-facing view of the raw execution
                      — model routing, latency, tokens, and the unprocessed
                      step log. Same real data that was here before; nothing
                      added, nothing invented, just moved under its own tab. */}
                  <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 shadow-inner flex justify-between items-start">
                    <div>
                      <span className="text-muted-foreground block mb-2 font-sans text-[10px] uppercase tracking-wider font-semibold">
                        Inferred Inference Route
                      </span>
                      <span className={`font-mono text-[11px] px-2 py-1 rounded-md ${THEME_MAP[uiTheme].bg} ${THEME_MAP[uiTheme].text} border ${THEME_MAP[uiTheme].border}`}>
                        {activeTraceMessage.route || 'default_eval'}
                      </span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-muted-foreground block mb-1 font-sans text-[10px] uppercase tracking-wider font-semibold">
                        Security Status
                      </span>
                      {activeTraceMessage.isVerifiedContent ? 
                        <span className="text-emerald-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-emerald-950/40 border border-emerald-500/20 px-2 py-1 rounded-md">
                          <CheckCircle size={12}/> VERIFIED
                        </span> : 
                        <span className="text-amber-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-amber-950/40 border border-amber-500/20 px-2 py-1 rounded-md">
                          <AlertTriangle size={12}/> UNVERIFIED
                        </span>
                      }
                    </div>
                  </div>

                  {activeTraceMessage.metrics && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                        <Timer size={14} className="text-zinc-500 mb-1" />
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Latency</span>
                        <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.latencyMs}ms</span>
                      </div>
                      <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                        <Cpu size={14} className="text-zinc-500 mb-1" />
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Tokens</span>
                        <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.tokensUsed ?? '—'}</span>
                      </div>
                      <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                        <ShieldCheck size={14} className="text-zinc-500 mb-1" />
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Confidence</span>
                        <span className={`${THEME_MAP[uiTheme].text} font-mono text-xs`}>{activeTraceMessage.metrics.confidenceScore != null ? `${activeTraceMessage.metrics.confidenceScore}%` : '—'}</span>
                      </div>
                    </div>
                  )}

                  <div className="border border-white/5 rounded-lg overflow-hidden bg-black/20">
                    <button 
                      onClick={() => setShowRawJson(!showRawJson)} 
                      className="w-full p-3 flex justify-between items-center text-[10px] font-sans uppercase tracking-wider text-zinc-400 hover:text-white transition-colors bg-white/[0.02]"
                    >
                      <span className="flex items-center gap-2">
                        <FileJson size={14}/> View Raw JSON Payload
                      </span>
                      <ChevronDown size={14} className={`transition-transform duration-300 ${showRawJson ? 'rotate-180' : ''}`} />
                    </button>
                    {showRawJson && (
                      <div className="p-3 border-t border-white/5 text-[9px] text-zinc-400 overflow-x-auto">
                        <pre>{JSON.stringify({ 
                          request_id: "req_" + generateUniqueID(), 
                          timestamp: activeTraceMessage.ts, 
                          route: activeTraceMessage.route, 
                          execution_metrics: activeTraceMessage.metrics, 
                          active_targets: extractedTargets 
                        }, null, 2)}</pre>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 pt-2">
                    <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2">
                      Raw Execution Log
                    </span>
                    {activeTraceMessage.steps && activeTraceMessage.steps.length > 0 ? (
                      <div className="space-y-2 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
                        {activeTraceMessage.steps.map((step: string, index: number) => (
                          <div 
                            key={index} 
                            className="relative flex items-start gap-3 p-3 rounded-lg bg-black/50 border border-white/5 font-mono text-[11px] text-muted-foreground leading-relaxed break-words hover:border-white/10 transition-colors group"
                          >
                            <div className={`absolute -left-1.5 top-3.5 size-3 bg-[#0a0a0c] border-2 rounded-full transition-all z-10 border-${THEME_MAP[uiTheme].accent}-500/50 group-hover:border-${THEME_MAP[uiTheme].accent}-400`} />
                            <div className="ml-2 w-full">
                              <span className={`${THEME_MAP[uiTheme].text} opacity-70 block mb-1 font-sans text-[9px] uppercase font-bold tracking-widest`}>
                                Step 0{index + 1}
                              </span>
                              <span className="text-foreground/80">{step}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground italic p-3 text-center border border-dashed border-white/10 rounded-xl bg-white/[0.01]">
                        No intermediary diagnostic chains reported.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}