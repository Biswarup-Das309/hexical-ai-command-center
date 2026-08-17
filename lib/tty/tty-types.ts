/**
 * ============================================================================
 * HEXICAL AI — ADVANCED TTY SANDBOX — PHASE 1 TYPE FOUNDATION
 * ============================================================================
 * Canonical TypeScript contracts for the TTY sandbox subsystem. Defines NO
 * execution behavior.
 *
 * Out of scope here (and for all of Phase 1): shell execution,
 * child_process, container/VM orchestration, or any code path that can run
 * arbitrary OS commands. Nothing in this file, including TTYSandboxRuntime,
 * is implemented — it is an interface a future, carefully-reviewed runtime
 * must satisfy.
 *
 * Trust boundary: every string that originates from a terminal input field
 * is UNTRUSTED. See RawTerminalInput — it exists so unvalidated input
 * cannot silently flow into code that assumes it has already been
 * classified/sanitized.
 *
 * Browser-safe vs internal: types intended to cross into client components
 * carry no diagnostic detail, stack traces, or internal identifiers beyond
 * what the UI needs to render state. Types prefixed `Internal`
 * (InternalTTYSession, InternalTTYFailureDiagnostics) must never be
 * imported into a 'use client' module or serialized to the browser.
 *
 * Tier reuse: `Tier` is imported from lib/hexical/types.ts, which is that
 * module's own stated "single source of truth for pricing, limits, and
 * payload shape." `PlanTier` (also exported there) is explicitly documented
 * in that file as a frontend-compatibility alias for `Tier`, so this file
 * imports `Tier` directly rather than the alias.
 *
 * Capability check: `advanced_terminal` is verified directly against
 * `PLAN_FEATURES` (lib/hexical/types.ts) — confirmed present only under
 * `PLAN_FEATURES.pro` — via {@link hasTTYCapability} below, the same
 * mechanism every other capability gate in the app already uses
 * (`hasFeatureAccess` in components/hexical/hexical-console.tsx checks the
 * derived `PLAN_LIMITS[currentTier].capabilities`, which is built directly
 * from this same `PLAN_FEATURES` array).
 *
 * Executor integration: this file intentionally does NOT import from
 * lib/planner/executor.ts. That file's `TaskExecutionHandler` interface —
 * `execute(task: Task, context: ExecutionRuntimeContext):
 * Promise<TaskExecutionOutcome>` — is already the correct integration seam
 * for a future TTY execution handler, and it is sufficient as-is. This file
 * does not redeclare, wrap, or adapt it (see the closing section below).
 * lib/planner/executor.ts's own `Task`/`TaskId`/`PlanId`/`generateId` are
 * re-exported there from `./planner`, which was not part of this review —
 * this file has no dependency on that module either.
 * ============================================================================
 */

import { PLAN_FEATURES, type Tier } from '@/lib/hexical/types'

// ============================================================================
// 1. BRANDED IDENTIFIERS & UNTRUSTED INPUT
// ============================================================================
// No shared branded-ID utility is exported from lib/hexical/types.ts. A
// branding *pattern* is visible elsewhere (lib/hexical-supabase.ts casts
// row fields `as ScanId` / `as ProjectId` / `as UserId`), but the utility
// backing those brands lives in a `./hexical-types` module not covered by
// this review, and is a different module path than lib/hexical/types.ts
// (the canonical Tier/PLAN_FEATURES source). This file defines its own
// minimal, self-contained branding rather than depending on that
// unreviewed module.

declare const __ttySessionIdBrand: unique symbol
declare const __ttyExecutionIdBrand: unique symbol
declare const __rawTerminalInputBrand: unique symbol

/** Opaque identifier for a TTY sandbox session. Construct only via
 * {@link createTTYSessionId}. */
export type TTYSessionId = string & { readonly [__ttySessionIdBrand]: true }

/** Opaque identifier for a single TTY execution within a session. */
export type TTYExecutionId = string & { readonly [__ttyExecutionIdBrand]: true }

/**
 * A string known ONLY to have come from a terminal input field — nothing
 * more. Wrapping input in this type at the boundary (e.g. CommandInput's
 * onSubmit) forces every downstream consumer to make an explicit choice
 * about validation instead of accidentally treating raw text as safe. This
 * type carries no guarantee of length, encoding, or content safety.
 */
export type RawTerminalInput = string & { readonly [__rawTerminalInputBrand]: true }

export function createTTYSessionId(): TTYSessionId {
  return crypto.randomUUID() as TTYSessionId
}

export function createTTYExecutionId(): TTYExecutionId {
  return crypto.randomUUID() as TTYExecutionId
}

/** Marks a plain string as untrusted terminal input. Performs no
 * validation or sanitization — it is a type-level boundary marker only. */
export function toRawTerminalInput(value: string): RawTerminalInput {
  return value as RawTerminalInput
}

// ============================================================================
// 2. CAPABILITY GATING (reuses the existing entitlement model — does not
//    define a parallel one)
// ============================================================================

/**
 * The literal capability key that gates the TTY sandbox. Verified against
 * lib/hexical/types.ts's `PLAN_FEATURES`, where it appears only in the
 * `pro` tier's array:
 *   pro: ['core_heuristics', 'interactive_topology', 'pdf_export',
 *         'swarm_intelligence', 'advanced_terminal']
 * This is the exact same string already used to gate the TTY tab client-
 * side in components/hexical/hexical-console.tsx
 * (`hasFeatureAccess('advanced_terminal')`).
 */
export const TTY_REQUIRED_CAPABILITY = 'advanced_terminal' as const
export type TTYRequiredCapability = typeof TTY_REQUIRED_CAPABILITY

/**
 * Server- and client-safe capability check, delegating entirely to
 * `PLAN_FEATURES` (lib/hexical/types.ts) rather than re-deriving or
 * duplicating the entitlement decision. No `any`, no bespoke gating logic.
 *
 * `tier` MUST be an already-resolved effective tier — i.e. the `tier` field
 * of a `TierEntitlement` returned by `resolveEntitlement()`
 * (lib/hexical/types.ts), not a raw `profiles.tier` column value. That
 * function is what downgrades an expired paid tier back to `'free'` even
 * if the database column hasn't been reset yet; this function does not
 * repeat that expiry check and must not be treated as a substitute for it.
 */
export function hasTTYCapability(tier: Tier): boolean {
  return PLAN_FEATURES[tier].includes(TTY_REQUIRED_CAPABILITY)
}

// ============================================================================
// 3. PRINCIPAL
// ============================================================================

/**
 * The authenticated identity a TTY operation is performed on behalf of.
 * `tier` must be the already-resolved effective tier (see
 * {@link hasTTYCapability} doc above) — this type does not itself carry
 * expiry/subscription-status, that is `resolveEntitlement()`'s job,
 * upstream of constructing this.
 */
export interface TTYPrincipal {
  readonly userId: string
  readonly tier: Tier
}

// ============================================================================
// 4. SESSION LIFECYCLE
// ============================================================================

export type TTYSessionStatus =
  | 'initializing'
  | 'active'
  | 'idle'
  | 'suspended'
  | 'terminating'
  | 'terminated'
  | 'expired'
  | 'error'

/** Browser-safe view of a TTY session. Safe to serialize to a client
 * component or an API response body. */
export interface TTYSession {
  readonly sessionId: TTYSessionId
  readonly status: TTYSessionStatus
  readonly tier: Tier
  readonly createdAt: string
  readonly lastActiveAt: string
  readonly limits: TTYResourceLimits
}

/** Server-only session record. Never send to the browser. */
export interface InternalTTYSession extends TTYSession {
  readonly ownerUserId: string
  readonly usage: TTYResourceUsageSnapshot
}

export interface TTYClientMeta {
  readonly userAgent?: string
  readonly clientVersion?: string
}

export interface TTYSessionCreateRequest {
  readonly requestedBy: TTYPrincipal
  readonly workspaceId?: string
  readonly clientMeta?: TTYClientMeta
}

export type TTYSessionCreateResult =
  | { readonly created: true; readonly session: TTYSession }
  | { readonly created: false; readonly failure: TTYFailure }

// ============================================================================
// 5. EXECUTION KINDS
// ============================================================================

/**
 * Curated, sandbox-defined capability categories. These are classifications
 * a future input classifier assigns to validated/sanitized input — they are
 * NOT raw shell verbs, and nothing in this file maps a TTYExecutionKind to
 * an actual OS command. 'unsupported' is a valid classification result
 * (distinct from a policy denial) representing "recognized as terminal
 * input, but not a kind this sandbox exposes."
 */
export type TTYExecutionKind =
  | 'recon_probe'
  | 'fuzz_probe'
  | 'network_probe'
  | 'session_utility'
  | 'diagnostic'
  | 'unsupported'

// ============================================================================
// 6. RESOURCE LIMITS & USAGE
// ============================================================================

/**
 * Shape of the resource ceiling enforced for a session/tier. No concrete
 * numeric defaults are exported from this file: those are policy decisions
 * that belong with the rest of lib/hexical/types.ts's entitlement config
 * (alongside `PLAN_FEATURES` / `MARGIN_CHAR_LIMITS` / `RATE_LIMITS`), not
 * duplicated here.
 */
export interface TTYResourceLimits {
  readonly maxConcurrentSessions: number
  readonly maxConcurrentExecutionsPerSession: number
  readonly maxExecutionsPerMinute: number
  /** Enforcement of this ceiling MUST be runtime-side (see
   * {@link TTYTimeoutEnforcement}), never a caller-side Promise.race. */
  readonly maxExecutionDurationMs: number
  readonly maxSessionIdleMs: number
  readonly maxSessionDurationMs: number
  readonly maxOutputBytesPerExecution: number
  readonly maxQueueDepth: number
}

export interface TTYResourceUsageSnapshot {
  readonly activeSessions: number
  readonly activeExecutionsInSession: number
  readonly executionsInLastMinute: number
  readonly queueDepth: number
  readonly capturedAt: string
}

/**
 * Resolves the resource ceiling for a tier. Returns null when the tier is
 * not entitled to the TTY sandbox at all (mirrors
 * `hasTTYCapability(tier) === false`), so callers have a single place to
 * branch on "no access" vs "access with limits" instead of treating an
 * all-zero limits object as a stand-in for no access.
 */
export type ResolveTTYResourceLimits = (tier: Tier) => TTYResourceLimits | null

// ============================================================================
// 7. TIMEOUT ENFORCEMENT
// ============================================================================

/**
 * 'runtime_enforced' is the only acceptable value. It asserts that the
 * sandbox runtime itself guarantees the underlying work stops when a
 * duration limit elapses.
 *
 * This matters concretely because of how the existing planner executor
 * behaves: `ExecutionDispatcher.withTimeout` (lib/planner/executor.ts)
 * wraps `handler.execute()` in `Promise.race` against a timer and, on
 * timeout, only stops *awaiting* — it does not and cannot stop whatever
 * work is actually in flight inside the handler. That module's own header
 * documents this explicitly: cancellation there is cooperative, and an
 * in-flight `handler.execute()` call "is allowed to settle... rather than
 * being forcibly interrupted, since this module never assumes a handler's
 * underlying work is safely abortable mid-flight." A TTY sandbox executing
 * untrusted input cannot rely on that assumption — this enforcement type
 * exists so a caller-side abandon-the-promise timeout is never mistaken
 * for a real one.
 */
export type TTYTimeoutEnforcement = 'runtime_enforced'

export interface TTYExecutionTimeoutPolicy {
  readonly enforcement: TTYTimeoutEnforcement
  readonly limitMs: number
}

// ============================================================================
// 8. POLICY DECISIONS
// ============================================================================

export type TTYPolicyDecision = 'allow' | 'deny'

export type TTYPolicyDenialReason =
  | 'capability_locked'
  | 'unauthenticated'
  | 'session_not_found'
  | 'session_terminated'
  | 'session_capacity_exceeded'
  | 'concurrency_limit_exceeded'
  | 'rate_limited'
  | 'queue_full'
  | 'output_limit_exceeded'
  | 'execution_duration_exceeded'
  | 'session_duration_exceeded'
  | 'unsupported_kind'
  | 'input_rejected'
  | 'authorization_required'
  | 'internal_error'

export interface TTYPolicyEvaluation {
  readonly decision: TTYPolicyDecision
  /** Present if and only if decision === 'deny'. */
  readonly reason?: TTYPolicyDenialReason
  readonly evaluatedAt: string
}

// ============================================================================
// 9. STRUCTURED FAILURES
// ============================================================================
// A TTY-scoped failure enumeration, deliberately separate from
// lib/hexical/types.ts's `ERROR_CODES`. `ERROR_CODES` covers the
// /api/verify LLM pipeline's failure surface (token/cost budgets,
// authorization scopes, replay/nonce rejection) — a different subsystem
// with different failure modes than session/execution/policy failures in
// an interactive sandbox. Sharing a single flat code enum across both
// would force one to grow unrelated cases for the other.

export type TTYFailureCode =
  | 'CAPABILITY_LOCKED'
  | 'UNAUTHENTICATED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_TERMINATED'
  | 'SESSION_CAPACITY_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONCURRENCY_LIMIT_EXCEEDED'
  | 'QUEUE_FULL'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'EXECUTION_TIMEOUT'
  | 'SESSION_TIMEOUT'
  | 'UNSUPPORTED_KIND'
  | 'INPUT_REJECTED'
  | 'AUTHORIZATION_REQUIRED'
  | 'CANCELLED_BY_USER'
  | 'TERMINATED_BY_SYSTEM'
  | 'INTERNAL_ERROR'

/**
 * Browser-safe failure surface — mirrors the existing
 * getSafeClientError()/getSafeExceptionMessage() pattern in
 * hexical-console.tsx: a closed code plus a generic, non-leaking message.
 * Never place raw exception text, stack traces, provider payloads, or
 * internal identifiers on this type.
 */
export interface TTYFailure {
  readonly code: TTYFailureCode
  readonly message: string
}

/**
 * Server/internal-only diagnostic detail for a TTYFailure. Must never be
 * sent to the browser, logged to a client-visible channel, or imported into
 * a 'use client' module.
 */
export interface InternalTTYFailureDiagnostics {
  readonly code: TTYFailureCode
  readonly internalMessage: string
  readonly cause?: unknown
  readonly sessionId?: TTYSessionId
  readonly executionId?: TTYExecutionId
  readonly capturedAt: string
}

// ============================================================================
// 10. EXECUTION OUTPUT
// ============================================================================

/**
 * A single unit of sandbox output. text is raw and MUST be escaped before
 * being rendered as HTML/Markdown downstream — same rule the SECURITY NOTES
 * banner in hexical-console.tsx already states for model output.
 */
export interface TTYOutputLine {
  readonly kind: 'stdout' | 'stderr' | 'system'
  readonly text: string
  readonly emittedAt: string
}

// ============================================================================
// 11. EXECUTION REQUEST / STATUS / RESULT
// ============================================================================

export interface TTYExecutionRequest {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly requestedBy: TTYPrincipal
  readonly rawInput: RawTerminalInput
  /** Optional hint only — a trusted classifier, not this field, is the
   * source of truth for the kind actually executed. */
  readonly kindHint?: TTYExecutionKind
  readonly requestedAt: string
  readonly correlationId?: string
}

export type TTYExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'denied'

const TTY_TERMINAL_EXECUTION_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out', 'denied'] as const

export type TTYTerminalExecutionStatus = (typeof TTY_TERMINAL_EXECUTION_STATUSES)[number]

export function isTerminalExecutionStatus(status: TTYExecutionStatus): status is TTYTerminalExecutionStatus {
  return (TTY_TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status)
}

/** Immediate response to execute() — an acceptance/handle, not a final
 * result. Mirrors the existing queued-job + polling pattern already used by
 * /api/verify (see handleSubmit in hexical-console.tsx) rather than a
 * fire-and-await model. */
export type TTYExecutionAcceptance =
  | {
      readonly accepted: true
      readonly executionId: TTYExecutionId
      readonly status: Extract<TTYExecutionStatus, 'queued' | 'running'>
    }
  | {
      readonly accepted: false
      readonly reason: TTYPolicyDenialReason
      readonly failure: TTYFailure
    }

interface TTYExecutionResultBase {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly updatedAt: string
}

export interface TTYExecutionResultQueued extends TTYExecutionResultBase {
  readonly status: 'queued'
  readonly queuePosition: number
}

export interface TTYExecutionResultRunning extends TTYExecutionResultBase {
  readonly status: 'running'
  readonly startedAt: string
}

export interface TTYExecutionResultCompleted extends TTYExecutionResultBase {
  readonly status: 'completed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly output: readonly TTYOutputLine[]
  readonly outputTruncated: boolean
}

export interface TTYExecutionResultFailed extends TTYExecutionResultBase {
  readonly status: 'failed'
  readonly failure: TTYFailure
  readonly output: readonly TTYOutputLine[]
}

export interface TTYExecutionResultCancelled extends TTYExecutionResultBase {
  readonly status: 'cancelled'
  readonly reason: TTYCancellationReason
  readonly output: readonly TTYOutputLine[]
}

export interface TTYExecutionResultTimedOut extends TTYExecutionResultBase {
  readonly status: 'timed_out'
  readonly limitMs: number
  readonly output: readonly TTYOutputLine[]
}

export interface TTYExecutionResultDenied extends TTYExecutionResultBase {
  readonly status: 'denied'
  readonly reason: TTYPolicyDenialReason
  readonly failure: TTYFailure
}

export type TTYExecutionResult =
  | TTYExecutionResultQueued
  | TTYExecutionResultRunning
  | TTYExecutionResultCompleted
  | TTYExecutionResultFailed
  | TTYExecutionResultCancelled
  | TTYExecutionResultTimedOut
  | TTYExecutionResultDenied

// ============================================================================
// 12. CANCELLATION & TERMINATION
// ============================================================================

export type TTYCancellationReason = 'user_requested' | 'client_disconnected' | 'superseded'

export interface TTYCancellationResult {
  readonly executionId: TTYExecutionId
  /**
   * True only once the runtime has CONFIRMED the underlying sandboxed work
   * has actually stopped consuming resources — not merely that the caller
   * gave up awaiting it. This is a deliberately stronger guarantee than
   * `lib/planner/executor.ts` itself provides for a generic
   * `TaskExecutionHandler` (see the {@link TTYTimeoutEnforcement} doc
   * comment above for the concrete `withTimeout`/`Promise.race` behavior
   * this is guarding against). A runtime that can only abandon a Promise
   * MUST NOT report `acknowledged: true`.
   */
  readonly acknowledged: boolean
  readonly stoppedAt?: string
}

export type TTYTerminationReason =
  | 'user_requested'
  | 'idle_timeout'
  | 'duration_limit_exceeded'
  | 'resource_limit_exceeded'
  | 'policy_violation'
  | 'runtime_exited'
  | 'system_shutdown'

export interface TTYTerminationResult {
  readonly sessionId: TTYSessionId
  readonly acknowledged: boolean
  readonly terminatedAt?: string
}

// ============================================================================
// 13. TYPED EVENTS
// ============================================================================

export type TTYEvent =
  | { readonly type: 'session_created'; readonly sessionId: TTYSessionId; readonly at: string }
  | {
      readonly type: 'session_status_changed'
      readonly sessionId: TTYSessionId
      readonly status: TTYSessionStatus
      readonly at: string
    }
  | {
      readonly type: 'execution_queued'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly queuePosition: number
      readonly at: string
    }
  | {
      readonly type: 'execution_started'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly at: string
    }
  | {
      readonly type: 'execution_output'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly line: TTYOutputLine
    }
  | {
      readonly type: 'execution_completed'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly at: string
    }
  | {
      readonly type: 'execution_failed'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly failure: TTYFailure
      readonly at: string
    }
  | {
      readonly type: 'execution_cancelled'
      readonly sessionId: TTYSessionId
      readonly executionId: TTYExecutionId
      readonly reason: TTYCancellationReason
      readonly at: string
    }
  | {
      readonly type: 'policy_denied'
      readonly sessionId: TTYSessionId
      readonly executionId?: TTYExecutionId
      readonly reason: TTYPolicyDenialReason
      readonly at: string
    }
  | {
      readonly type: 'session_terminated'
      readonly sessionId: TTYSessionId
      readonly reason: TTYTerminationReason
      readonly at: string
    }

export type TTYEventListener = (event: TTYEvent) => void
export type TTYUnsubscribe = () => void

// ============================================================================
// 14. SANDBOX RUNTIME INTERFACE — ISOLATED-EXECUTION BOUNDARY ONLY
// (NOT IMPLEMENTED — CONTRACT ONLY)
// ============================================================================

/**
 * Contract for the future sandbox execution backend. NOT implemented in
 * Phase 1 — no method here may be backed by child_process, a container
 * runtime, or any other real OS execution anywhere in this codebase yet.
 *
 * Scope discipline: this interface represents ONLY the isolated-runtime
 * boundary for a single interactive TTY session — provisioning/tearing
 * down one isolated environment and running/stopping discrete units of
 * validated input inside it. It deliberately does NOT include dependency
 * graphs, retries, rollback, recovery strategies, pause/resume, snapshots,
 * or cross-session concurrency accounting — that orchestration already
 * belongs to `ExecutorManager` / `ExecutionDispatcher`
 * (lib/planner/executor.ts) for multi-step planner `Task` graphs, which is
 * a different domain (planned agent task execution) from an interactive
 * TTY session. Re-implementing any of that here would create a second,
 * competing orchestration system; this file does not do that.
 *
 * execute() returns quickly with an acceptance/handle; it does not block
 * until the sandboxed work finishes. Callers observe progress via
 * subscribe()/TTYEvent or by polling getExecutionResult().
 *
 * cancel()/terminateSession() must resolve only once the runtime confirms
 * the work has actually stopped (see TTYCancellationResult.acknowledged /
 * TTYTerminationResult.acknowledged) — see the {@link TTYTimeoutEnforcement}
 * doc comment for exactly why a caller-side abandoned Promise does not
 * satisfy this contract. A real implementation must plumb these calls down
 * to whatever primitive can actually stop execution (process signal,
 * container kill, worker termination, etc.) once that primitive exists.
 */
export interface TTYSandboxRuntime {
  createSession(request: TTYSessionCreateRequest): Promise<TTYSessionCreateResult>
  execute(request: TTYExecutionRequest): Promise<TTYExecutionAcceptance>
  getExecutionResult(executionId: TTYExecutionId): Promise<TTYExecutionResult>
  cancel(executionId: TTYExecutionId, reason: TTYCancellationReason): Promise<TTYCancellationResult>
  terminateSession(sessionId: TTYSessionId, reason: TTYTerminationReason): Promise<TTYTerminationResult>
  subscribe(sessionId: TTYSessionId, listener: TTYEventListener): TTYUnsubscribe
}

// ============================================================================
// NOTE — Executor integration (no code in this section, intentionally)
// ============================================================================
// A future implementation that dispatches TTY executions as planner Tasks
// should have its handler class implement `TaskExecutionHandler` from
// lib/planner/executor.ts directly:
//
//   execute(task: Task, context: ExecutionRuntimeContext):
//     Promise<TaskExecutionOutcome>
//
// translating a `Task`'s `metadata: Dictionary` into a `TTYExecutionRequest`
// and a `TTYExecutionResult` into `TaskExecutionOutcome.output: JsonValue`
// internally, and calling into a `TTYSandboxRuntime` to do the actual
// isolated work. That interface is already the correct integration seam
// and is sufficient as written — this file does not redeclare, wrap, or
// adapt it with a parallel type, since doing so would be exactly the kind
// of competing/speculative executor abstraction this phase must avoid.
