/**
 * ============================================================================
 * HEXICAL AI — ADVANCED TTY SANDBOX — PHASE 1.2 POLICY / VALIDATION LAYER
 * ============================================================================
 * Server-only. This module is the mandatory checkpoint between untrusted
 * terminal input and the future TTYSandboxRuntime (lib/tty/tty-types.ts).
 * It performs validation, classification, and allow/deny policy decisions.
 * It does NOT execute anything — there is no shell, no child_process, no
 * container/VM invocation, and no code path in this file that turns a
 * string into an OS command. That constraint holds regardless of how this
 * module's output is later consumed.
 *
 * TRUST CONTRACT (this module cannot enforce this by itself — see below):
 * Every `TTYPrincipal` passed into this module's functions MUST already
 * have been resolved server-side from a verified identity/entitlement
 * source (e.g. a Clerk session plus a DB-backed tier lookup, mirroring
 * `resolveEntitlement()` in lib/hexical/types.ts) — NEVER constructed by
 * reading a `tier` field out of an incoming request body. Likewise, every
 * `InternalTTYSession` passed in MUST have been loaded from a trusted
 * server-side store keyed by the request's own `sessionId`, never
 * constructed from client-supplied fields. This module can only validate
 * *shape*, not *provenance* — it has no way to detect a caller that
 * violates this contract, so it is a hard requirement on every caller.
 *
 * TARGET AUTHORIZATION (added in this revision):
 * `recon_probe` / `fuzz_probe` / `network_probe` interact with a real,
 * named target and therefore MUST NOT reach 'allow' on classification
 * alone. Before final 'allow', this module extracts target candidates
 * from the already-validated raw input and calls the existing, real
 * `verifyAuthorization()` (lib/hexical/authorization.ts) — the same
 * server-enforced scope-verification gate already used for the
 * `exploit`/`swarm` LLM profiles. No second authorization system is
 * introduced.
 *
 * `verifyAuthorization()` only performs a real check when
 * `isAuthorizationGated(profile)` is true, and
 * `AUTHORIZATION_GATED_PROFILES` (lib/hexical/types.ts) currently contains
 * only `'exploit'`. TTYExecutionKind is a distinct type from `Profile` —
 * there is no natural 1:1 mapping. This module therefore always passes the
 * literal `'exploit'` as `profile` for target-gated TTY kinds. This is
 * deliberate, not arbitrary: passing any other `Profile` value would make
 * `isAuthorizationGated` return false and cause `verifyAuthorization` to
 * return `{ allowed: true, ... }` immediately without checking anything —
 * i.e. it would silently recreate the exact bypass this revision closes.
 * `'exploit'` is the only literal that actually routes into real
 * scope-matching logic today.
 *
 * `evaluateExecutionPolicy` is now async (target authorization requires a
 * Supabase + Redis round trip) and REQUIRES a `TTYAuthorizationDependencies`
 * argument — not optional — so no caller can omit it and accidentally
 * bypass the gate by construction.
 *
 * POLICY FLOW (evaluateExecutionPolicy, the primary entry point):
 *   1. principal shape validity            -> deny 'unauthenticated'
 *   2. session/request/principal agreement -> deny 'session_not_found'
 *   3. session status admits new work      -> deny 'session_terminated'
 *   4. capability re-derived from session  -> deny 'capability_locked'
 *   5. resource limits vs. session usage   -> deny (rate/concurrency/queue)
 *   6. raw input shape/encoding            -> deny 'input_rejected'
 *   7. classification                      -> deny 'unsupported_kind'
 *   8. target authorization (gated kinds only) -> deny 'authorization_required'
 *      else                                -> allow, with classified kind
 * Each step is fail-closed: any exception to the expected shape, or any
 * exception thrown while checking authorization, denies — nothing is ever
 * inferred charitably or defaulted to allow.
 * ============================================================================
 */

import {
  hasTTYCapability,
  type TTYPrincipal,
  type TTYSessionCreateRequest,
  type TTYExecutionRequest,
  type InternalTTYSession,
  type TTYExecutionKind,
  type TTYPolicyDenialReason,
  type TTYPolicyEvaluation,
  type TTYFailureCode,
  type TTYFailure,
  type InternalTTYFailureDiagnostics,
  type RawTerminalInput,
  type TTYResourceLimits,
  type TTYResourceUsageSnapshot,
  type ResolveTTYResourceLimits,
  type TTYSessionId,
  type TTYExecutionId
} from './tty-types'

import { VALID_TIERS, type Profile } from '@/lib/hexical/types'
import { verifyAuthorization } from '@/lib/hexical/authorization'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Redis } from '@upstash/redis'

// ============================================================================
// 1. INPUT SHAPE CONSTANTS
// ============================================================================

export const TTY_INPUT_MIN_LENGTH = 1
export const TTY_INPUT_MAX_LENGTH = 4_000
export const WORKSPACE_ID_MAX_LENGTH = 100
export const CLIENT_META_FIELD_MAX_LENGTH = 300

// ============================================================================
// 2. SHAPE / ENCODING VALIDATION
// ============================================================================

const DISALLOWED_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Validates the shape/encoding of untrusted terminal input. Returns the
 * applicable denial reason, or null if the input passes. Does not inspect
 * *meaning* — that is {@link classifyTerminalInput}'s and
 * {@link extractTargetCandidates}'s job, and both must only ever be called
 * on input that has already passed this check.
 */
export function validateRawTerminalInput(rawInput: RawTerminalInput): TTYPolicyDenialReason | null {
  if (rawInput.trim().length < TTY_INPUT_MIN_LENGTH) {
    return 'input_rejected'
  }
  if (rawInput.length > TTY_INPUT_MAX_LENGTH) {
    return 'input_rejected'
  }
  if (DISALLOWED_CONTROL_CHARS.test(rawInput)) {
    return 'input_rejected'
  }
  if (LONE_SURROGATE.test(rawInput)) {
    return 'input_rejected'
  }
  return null
}

// ============================================================================
// 3. CLASSIFICATION — TTYExecutionKind
// ============================================================================
// Kept strictly separate from authorization: this section decides WHAT KIND
// of input this is. Section 8 below decides WHETHER its target is allowed.
// Neither calls into the other.

export const SESSION_UTILITY_KEYWORDS = ['clear', 'help', 'whoami', 'history', 'status', 'exit', 'ls', 'pwd', 'echo'] as const
export const RECON_PROBE_KEYWORDS = ['nmap', 'recon', 'enum', 'whois', 'dig', 'nslookup', 'subfinder', 'amass'] as const
export const FUZZ_PROBE_KEYWORDS = ['ffuf', 'fuzz', 'wfuzz', 'gobuster', 'dirbuster', 'dirb'] as const
export const NETWORK_PROBE_KEYWORDS = ['curl', 'wget', 'ping', 'traceroute', 'nc', 'telnet', 'openssl'] as const
export const DIAGNOSTIC_KEYWORDS = ['diag', 'debug', 'trace', 'inspect', 'version', 'uptime'] as const

function extractFirstToken(rawInput: RawTerminalInput): string | null {
  const match = rawInput.trim().match(/^\S+/)
  return match ? match[0].toLowerCase() : null
}

function matchesAny(token: string, keywords: readonly string[]): boolean {
  return keywords.includes(token)
}

/**
 * Classifies already-validated terminal input into a TTYExecutionKind.
 * Callers MUST run {@link validateRawTerminalInput} first.
 */
export function classifyTerminalInput(rawInput: RawTerminalInput): TTYExecutionKind {
  const firstToken = extractFirstToken(rawInput)
  if (firstToken === null) {
    return 'unsupported'
  }
  if (matchesAny(firstToken, SESSION_UTILITY_KEYWORDS)) return 'session_utility'
  if (matchesAny(firstToken, RECON_PROBE_KEYWORDS)) return 'recon_probe'
  if (matchesAny(firstToken, FUZZ_PROBE_KEYWORDS)) return 'fuzz_probe'
  if (matchesAny(firstToken, NETWORK_PROBE_KEYWORDS)) return 'network_probe'
  if (matchesAny(firstToken, DIAGNOSTIC_KEYWORDS)) return 'diagnostic'
  return 'unsupported'
}

// ============================================================================
// 4. PRINCIPAL VALIDATION
// ============================================================================

export function isValidTTYPrincipalShape(principal: TTYPrincipal): boolean {
  if (typeof principal.userId !== 'string') {
    return false
  }
  const userId = principal.userId.trim()
  if (userId.length === 0 || userId.length > 200) {
    return false
  }
  if (!VALID_TIERS.includes(principal.tier)) {
    return false
  }
  return true
}

// ============================================================================
// 5. RESOURCE LIMIT EVALUATION
// ============================================================================

export function evaluateResourceLimits(
  limits: TTYResourceLimits,
  usage: TTYResourceUsageSnapshot
): TTYPolicyDenialReason | null {
  if (usage.activeExecutionsInSession >= limits.maxConcurrentExecutionsPerSession) {
    return 'concurrency_limit_exceeded'
  }
  if (usage.executionsInLastMinute >= limits.maxExecutionsPerMinute) {
    return 'rate_limited'
  }
  if (usage.queueDepth >= limits.maxQueueDepth) {
    return 'queue_full'
  }
  return null
}

// ============================================================================
// 6. FAILURE MAPPING
// ============================================================================

const DENIAL_REASON_TO_FAILURE_CODE: Record<TTYPolicyDenialReason, TTYFailureCode> = {
  capability_locked: 'CAPABILITY_LOCKED',
  unauthenticated: 'UNAUTHENTICATED',
  session_not_found: 'SESSION_NOT_FOUND',
  session_terminated: 'SESSION_TERMINATED',
  concurrency_limit_exceeded: 'CONCURRENCY_LIMIT_EXCEEDED',
  rate_limited: 'RATE_LIMITED',
  queue_full: 'QUEUE_FULL',
  output_limit_exceeded: 'OUTPUT_LIMIT_EXCEEDED',
  execution_duration_exceeded: 'EXECUTION_TIMEOUT',
  session_duration_exceeded: 'SESSION_TIMEOUT',
  unsupported_kind: 'UNSUPPORTED_KIND',
  input_rejected: 'INPUT_REJECTED',
  authorization_required: 'AUTHORIZATION_REQUIRED',
  internal_error: 'INTERNAL_ERROR'
}

export const FAILURE_CODE_MESSAGES: Record<TTYFailureCode, string> = {
  CAPABILITY_LOCKED: 'This action requires a Pro workspace license.',
  UNAUTHENTICATED: 'Your session could not be verified. Please sign in again.',
  SESSION_NOT_FOUND: 'This sandbox session could not be found.',
  SESSION_TERMINATED: 'This sandbox session is no longer accepting commands.',
  RATE_LIMITED: 'Rate limit reached. Please wait a moment and retry.',
  CONCURRENCY_LIMIT_EXCEEDED: 'Too many concurrent operations for this session.',
  QUEUE_FULL: 'The execution queue is full. Please retry shortly.',
  OUTPUT_LIMIT_EXCEEDED: 'Output limit exceeded for this execution.',
  EXECUTION_TIMEOUT: 'The operation exceeded its allotted time.',
  SESSION_TIMEOUT: 'This session has exceeded its maximum duration.',
  UNSUPPORTED_KIND: 'This input could not be classified into a supported command category.',
  INPUT_REJECTED: 'The input was rejected for containing invalid or unsafe content.',
  AUTHORIZATION_REQUIRED:
    'This target requires a verified authorization scope before it can be used. Submit a scope for review to proceed.',
  CANCELLED_BY_USER: 'The operation was cancelled.',
  TERMINATED_BY_SYSTEM: 'The session was terminated by the system.',
  INTERNAL_ERROR: 'The sandbox policy engine encountered an internal error.'
}

export function denialReasonToFailure(reason: TTYPolicyDenialReason): TTYFailure {
  const code = DENIAL_REASON_TO_FAILURE_CODE[reason]
  return { code, message: FAILURE_CODE_MESSAGES[code] }
}

function buildDiagnostics(
  reason: TTYPolicyDenialReason,
  internalMessage: string,
  extra?: { sessionId?: TTYSessionId; executionId?: TTYExecutionId; cause?: unknown }
): InternalTTYFailureDiagnostics {
  return {
    code: DENIAL_REASON_TO_FAILURE_CODE[reason],
    internalMessage,
    sessionId: extra?.sessionId,
    executionId: extra?.executionId,
    cause: extra?.cause,
    capturedAt: new Date().toISOString()
  }
}

function allowEvaluation(): TTYPolicyEvaluation {
  return { decision: 'allow', evaluatedAt: new Date().toISOString() }
}

function denyEvaluation(reason: TTYPolicyDenialReason): TTYPolicyEvaluation {
  return { decision: 'deny', reason, evaluatedAt: new Date().toISOString() }
}

// ============================================================================
// 7. SESSION CREATION POLICY (unaffected by this revision — no raw input,
//    no classification, no target involved at session-creation time)
// ============================================================================

export interface TTYSessionCreationPolicyInput {
  readonly request: TTYSessionCreateRequest
  readonly resolveLimits: ResolveTTYResourceLimits
  readonly currentActiveSessionCount?: number
}

export interface TTYSessionCreationPolicyResult {
  readonly evaluation: TTYPolicyEvaluation
  readonly limits: TTYResourceLimits | null
  readonly failure?: TTYFailure
  readonly diagnostics?: InternalTTYFailureDiagnostics
}

function denySessionCreation(
  reason: TTYPolicyDenialReason,
  limits: TTYResourceLimits | null,
  diagnostics?: InternalTTYFailureDiagnostics
): TTYSessionCreationPolicyResult {
  return { evaluation: denyEvaluation(reason), limits, failure: denialReasonToFailure(reason), diagnostics }
}

function isValidSessionCreateRequestShape(request: TTYSessionCreateRequest): boolean {
  if (request.workspaceId !== undefined) {
    if (
      typeof request.workspaceId !== 'string' ||
      request.workspaceId.length === 0 ||
      request.workspaceId.length > WORKSPACE_ID_MAX_LENGTH ||
      DISALLOWED_CONTROL_CHARS.test(request.workspaceId)
    ) {
      return false
    }
  }
  if (request.clientMeta) {
    const { userAgent, clientVersion } = request.clientMeta
    if (
      userAgent !== undefined &&
      (typeof userAgent !== 'string' ||
        userAgent.length > CLIENT_META_FIELD_MAX_LENGTH ||
        DISALLOWED_CONTROL_CHARS.test(userAgent))
    ) {
      return false
    }
    if (
      clientVersion !== undefined &&
      (typeof clientVersion !== 'string' ||
        clientVersion.length > CLIENT_META_FIELD_MAX_LENGTH ||
        DISALLOWED_CONTROL_CHARS.test(clientVersion))
    ) {
      return false
    }
  }
  return true
}

export function evaluateSessionCreationPolicy(
  input: TTYSessionCreationPolicyInput
): TTYSessionCreationPolicyResult {
  const { request, resolveLimits, currentActiveSessionCount } = input
  const principal = request.requestedBy

  if (!isValidTTYPrincipalShape(principal)) {
    return denySessionCreation(
      'unauthenticated',
      null,
      buildDiagnostics('unauthenticated', 'Session creation request carried a structurally invalid principal.')
    )
  }

  const limits = resolveLimits(principal.tier)

  if (limits === null || !hasTTYCapability(principal.tier)) {
    return denySessionCreation(
      'capability_locked',
      limits,
      buildDiagnostics('capability_locked', `Tier '${principal.tier}' is not entitled to the TTY sandbox.`)
    )
  }

  if (
    typeof currentActiveSessionCount === 'number' &&
    currentActiveSessionCount >= limits.maxConcurrentSessions
  ) {
    return denySessionCreation('concurrency_limit_exceeded', limits)
  }

  if (!isValidSessionCreateRequestShape(request)) {
    return denySessionCreation('input_rejected', limits)
  }

  return { evaluation: allowEvaluation(), limits }
}

// ============================================================================
// 8. TARGET AUTHORIZATION GATE (recon_probe / fuzz_probe / network_probe)
// ============================================================================
// This section owns exactly two responsibilities: (a) conservatively
// extracting target-shaped candidates from already-validated raw input, and
// (b) calling the real, existing verifyAuthorization() with them. It makes
// no authorization decision of its own — verifyAuthorization() remains the
// single source of truth for "is this target actually authorized," exactly
// as it already is for the exploit/swarm LLM profiles.

/**
 * TTY kinds that name and interact with a real target, and therefore MUST
 * pass target authorization before 'allow'. session_utility and diagnostic
 * are intentionally excluded — the requirement explicitly scopes them as
 * local/non-target-gated.
 */
export const TARGET_GATED_EXECUTION_KINDS: ReadonlySet<TTYExecutionKind> = new Set([
  'recon_probe',
  'fuzz_probe',
  'network_probe'
])

export function isTargetGatedExecutionKind(kind: TTYExecutionKind): boolean {
  return TARGET_GATED_EXECUTION_KINDS.has(kind)
}

/**
 * The only Profile literal that actually routes into verifyAuthorization's
 * real scope-matching logic today (see file banner). Every target-gated
 * TTY kind is checked as if it were an 'exploit'-profile request — this is
 * intentionally the strictest existing gate, not a semantic claim that TTY
 * probes literally are exploit-profile LLM requests.
 */
const TTY_TARGET_AUTHORIZATION_PROFILE: Profile = 'exploit'

const IPV4_TOKEN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// Deliberately reuses the exact TLD allowlist already used for target
// extraction elsewhere in this codebase (extractTargetsFromLogic in
// components/hexical/hexical-console.tsx), rather than a generic
// "any 2-24 letter suffix" pattern. A generic suffix pattern would treat
// ordinary filename extensions (wordlist.txt, payload.json, notes.md) as
// domain-shaped and inflate false positives; this narrower, already-used
// list keeps extraction conservative.
const DOMAIN_TOKEN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|ai|app|local)$/i

const URL_TOKEN = /^https?:\/\/([^/\s:?#]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i

const MAX_TARGET_CANDIDATES = 10
const MAX_TARGET_TOKEN_LENGTH = 253 // DNS hostname length ceiling

function looksLikeTarget(token: string): string | null {
  if (token.length === 0 || token.length > MAX_TARGET_TOKEN_LENGTH) {
    return null
  }
  if (IPV4_TOKEN.test(token)) {
    return token
  }
  if (DOMAIN_TOKEN.test(token)) {
    return token
  }
  const urlMatch = URL_TOKEN.exec(token)
  if (urlMatch) {
    const host = urlMatch[1]
    if (IPV4_TOKEN.test(host) || DOMAIN_TOKEN.test(host)) {
      return host
    }
  }
  return null
}

/**
 * Conservatively extracts target-shaped candidates (bare IPv4, allowlisted-
 * TLD domain, or http(s) URL host) from already-validated raw input.
 * Callers MUST run {@link validateRawTerminalInput} first.
 *
 * This is pattern matching for authorization purposes ONLY — it is not a
 * command-argument parser and makes no attempt to understand any specific
 * tool's flag grammar. The first token (the command/tool name itself,
 * already consumed by classification) is always skipped; every remaining
 * whitespace-delimited token is tested independently, with the portion
 * after a literal '=' considered too (covers `--url=https://target.com`
 * style flags) without assuming any particular flag schema.
 *
 * Deliberately biased toward over-extraction, not under-extraction: a
 * token that merely looks target-shaped but isn't the tool's actual target
 * (e.g. an incidental IP in an unrelated argument) can only make the
 * downstream authorization check stricter (via verifyAuthorization's
 * require-all-targets-covered semantics), never more permissive. Ambiguous
 * or unrecognized target shapes (IPv6, CIDR, non-allowlisted TLDs) are not
 * extracted and therefore fail closed: an empty result list causes
 * verifyAuthorization's own "missing-target-scope" denial, per its
 * documented fail-safe behavior — this function does not duplicate that
 * check itself.
 */
export function extractTargetCandidates(rawInput: RawTerminalInput): string[] {
  const tokens = rawInput.trim().split(/\s+/)
  const argumentTokens = tokens.slice(1)
  const candidates = new Set<string>()

  for (const token of argumentTokens) {
    if (candidates.size >= MAX_TARGET_CANDIDATES) {
      break
    }
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token
    const target = looksLikeTarget(value)
    if (target !== null) {
      candidates.add(target.toLowerCase())
    }
  }

  return Array.from(candidates)
}

export interface TTYAuthorizationDependencies {
  readonly supabase: SupabaseClient
  readonly redis: Redis
}

/**
 * Runs the real verifyAuthorization() gate for a target-gated TTY kind.
 * Returns a denial reason on any failure to authorize, including a thrown
 * exception from the underlying Supabase/Redis calls — this function never
 * throws and never returns a bare 'allowed' boolean; it always returns
 * either null (authorized) or a typed denial, so a caller cannot
 * accidentally treat an unhandled rejection as an allow.
 */
async function evaluateTargetAuthorization(
  session: InternalTTYSession,
  rawInput: RawTerminalInput,
  authorization: TTYAuthorizationDependencies
): Promise<{ denialReason: TTYPolicyDenialReason; internalMessage: string; cause?: unknown } | null> {
  const candidateTargets = extractTargetCandidates(rawInput)

  if (candidateTargets.length === 0) {
    return { denialReason: 'authorization_required', internalMessage: 'No target candidate could be extracted from input.' }
  }

  try {
    const decision = await verifyAuthorization({
      supabase: authorization.supabase,
      redis: authorization.redis,
      // session.ownerUserId, not request.requestedBy.userId — the value
      // already confirmed to match the trusted session record in step 2
      // of evaluateExecutionPolicy, not whatever the request carried.
      userId: session.ownerUserId,
      profile: TTY_TARGET_AUTHORIZATION_PROFILE,
      targetScope: undefined,
      extractedTargets: candidateTargets,
      // TTYExecutionRequest carries no client-supplied authorization
      // reference field. If one is ever added, it must be treated the same
      // way verifyAuthorization already treats it upstream — as a filter
      // over the user's OWN already-verified scopes, never as proof by
      // itself — and never passed here without that same scoping.
      authorizationRef: undefined
    })

    if (!decision.allowed) {
      return { denialReason: 'authorization_required', internalMessage: decision.reason }
    }
    return null
  } catch (error) {
    // Fail closed on any authorization-service failure (network, Supabase,
    // Redis) — an inability to verify is never treated as verified.
    return { denialReason: 'internal_error', internalMessage: 'verifyAuthorization threw while evaluating target authorization.', cause: error }
  }
}

// ============================================================================
// 9. EXECUTION POLICY — the primary entry point
// ============================================================================

export interface TTYExecutionPolicyResult {
  readonly evaluation: TTYPolicyEvaluation
  /**
   * Meaningful when evaluation.decision === 'allow'. Also carries the
   * actual classified kind for an 'authorization_required' denial, since
   * classification genuinely succeeded there — only the target failed
   * authorization. Set to 'unsupported' for every other deny path, which
   * occur at or before classification.
   */
  readonly classifiedKind: TTYExecutionKind
  readonly failure?: TTYFailure
  readonly diagnostics?: InternalTTYFailureDiagnostics
}

function denyExecution(
  reason: TTYPolicyDenialReason,
  diagnostics?: InternalTTYFailureDiagnostics
): TTYExecutionPolicyResult {
  return {
    evaluation: denyEvaluation(reason),
    classifiedKind: 'unsupported',
    failure: denialReasonToFailure(reason),
    diagnostics
  }
}

function denyExecutionForTarget(
  reason: TTYPolicyDenialReason,
  classifiedKind: TTYExecutionKind,
  diagnostics?: InternalTTYFailureDiagnostics
): TTYExecutionPolicyResult {
  return {
    evaluation: denyEvaluation(reason),
    classifiedKind,
    failure: denialReasonToFailure(reason),
    diagnostics
  }
}

/**
 * Evaluates whether `request` may proceed to execution against `session`.
 * `session` MUST be a trusted, already-loaded record for `request
 * .sessionId` — see the file banner's TRUST CONTRACT. `request.kindHint`
 * is intentionally never read here: classification is always computed
 * independently, so neither a client-asserted kind hint nor any future
 * client-asserted target/authorization field can influence this decision.
 *
 * `authorization` is REQUIRED, not optional, specifically so a caller
 * cannot omit it and silently skip the target-authorization gate for
 * recon_probe/fuzz_probe/network_probe kinds.
 */
export async function evaluateExecutionPolicy(
  request: TTYExecutionRequest,
  session: InternalTTYSession,
  authorization: TTYAuthorizationDependencies
): Promise<TTYExecutionPolicyResult> {
  const principal = request.requestedBy

  // 1. Principal shape.
  if (!isValidTTYPrincipalShape(principal)) {
    return denyExecution(
      'unauthenticated',
      buildDiagnostics('unauthenticated', 'Execution request carried a structurally invalid principal.', {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 2. Session / request / principal agreement.
  if (
    session.sessionId !== request.sessionId ||
    session.ownerUserId !== principal.userId ||
    session.tier !== principal.tier
  ) {
    return denyExecution(
      'session_not_found',
      buildDiagnostics('session_not_found', 'Session/request/principal did not agree.', {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 3. Session status.
  if (session.status !== 'active' && session.status !== 'idle') {
    return denyExecution(
      'session_terminated',
      buildDiagnostics('session_terminated', `Session status '${session.status}' does not admit new executions.`, {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 4. Capability, re-derived from the trusted session's own tier.
  if (!hasTTYCapability(session.tier)) {
    return denyExecution(
      'capability_locked',
      buildDiagnostics('capability_locked', `Tier '${session.tier}' is not entitled to the TTY sandbox.`, {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 5. Resource limits vs. the session's own trusted usage snapshot.
  const resourceDenial = evaluateResourceLimits(session.limits, session.usage)
  if (resourceDenial !== null) {
    return denyExecution(
      resourceDenial,
      buildDiagnostics(resourceDenial, 'Resource limit evaluation denied the request.', {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 6. Raw input shape/encoding.
  const inputDenial = validateRawTerminalInput(request.rawInput)
  if (inputDenial !== null) {
    return denyExecution(
      inputDenial,
      buildDiagnostics(inputDenial, 'Raw terminal input failed shape/encoding validation.', {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 7. Classification.
  const classifiedKind = classifyTerminalInput(request.rawInput)
  if (classifiedKind === 'unsupported') {
    return denyExecution(
      'unsupported_kind',
      buildDiagnostics('unsupported_kind', 'Input did not classify into a supported TTYExecutionKind.', {
        sessionId: request.sessionId,
        executionId: request.executionId
      })
    )
  }

  // 8. Target authorization — the fix. recon_probe/fuzz_probe/network_probe
  // cannot reach 'allow' without a verified scope covering every extracted
  // target candidate. session_utility/diagnostic skip this step entirely,
  // per requirement.
  if (isTargetGatedExecutionKind(classifiedKind)) {
    const denial = await evaluateTargetAuthorization(session, request.rawInput, authorization)
    if (denial !== null) {
      return denyExecutionForTarget(
        denial.denialReason,
        classifiedKind,
        buildDiagnostics(denial.denialReason, denial.internalMessage, {
          sessionId: request.sessionId,
          executionId: request.executionId,
          cause: denial.cause
        })
      )
    }
  }

  return { evaluation: allowEvaluation(), classifiedKind }
}
