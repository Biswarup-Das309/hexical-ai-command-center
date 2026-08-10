/**
 * =============================================================================
 * Hexical AI
 * agent.ts
 * =============================================================================
 *
 * Cognitive Pipeline Orchestrator
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * The Agent is the single orchestration layer coordinating Hexical's full
 * cognitive pipeline:
 *
 *     Input -> Severity -> Semantic -> Impact -> Behavior -> Recommendation
 *           -> Reasoner -> Memory -> Planner -> PlannerScheduler -> Executor
 *           -> Output
 *
 * Every arrow above is a call into another module's already-public API.
 * This file adds no analysis, planning, scheduling, execution, memory, or
 * reasoning logic of its own — it only sequences calls, translates data
 * between subsystem contracts (e.g. Recommendation -> Goal, pipeline output
 * -> EvidenceNode, pipeline output -> MemoryEntry), and publishes a unified
 * lifecycle event stream so a caller never has to subscribe to more than one
 * observer.
 *
 * A NOTE ON A NAME COLLISION IN THE EXISTING CODEBASE
 * -----------------------------------------------------------------------------
 * Both `planner.ts` and `planner-scheduler.ts` export a class named
 * `PlannerScheduler` — the former is `PlannerManager`'s own internal
 * critical-path scheduler (used only inside `createPlan`, producing an
 * `ExecutionSchedule` embedded in `Plan.schedule`), the latter is the
 * standalone scheduling subsystem this file's "PlannerScheduler" pipeline
 * stage actually refers to (producing the `PlannerSchedule` that
 * `ExecutorManager` consumes). This file only ever imports the
 * planner-scheduler.ts one, aliased to `PlannerSchedulingEngine` so the two
 * are never confused by a future reader.
 *
 * WHY SUBSYSTEM RELAY IS A SINGLE GENERIC EVENT RATHER THAN A MIRRORED ENUM
 * -----------------------------------------------------------------------------
 * `PlannerManager`, `PlannerSchedulingEngine`, and `ExecutorManager` each
 * publish their own event enum (`PlannerEvent`, `SchedulerEvent`,
 * `ExecutionEvent`) with dozens of values between them. Hand-mirroring every
 * one of those into a parallel `AgentEvent` value would need updating here
 * every time any subsystem adds an event, and would still only be a
 * relabeling exercise. Instead, `AgentManager` subscribes to all three
 * subsystems once and republishes everything under a single
 * `AgentEvent.SubsystemEvent`, carrying the originating subsystem and the
 * original event name/payload — a caller who wants finer-grained handling
 * can switch on `payload.subsystem` / `payload.subsystemEvent` themselves.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - performs severity scoring, semantic analysis, impact estimation, or
 *     behavior analysis itself (see severity.ts / semantic.ts / impact.ts /
 *     behavior.ts) — it only calls their exported functions
 *   - authors or evaluates recommendation rules (see recommendation.ts's
 *     `RecommendationEngine` / `RecommendationRule`) — rules are supplied by
 *     the caller and registered on an injected `RecommendationEngine`
 *   - performs inference, hypothesis generation, contradiction detection, or
 *     any reasoning logic (see recommendation.ts's engines, orchestrated by
 *     reasoner.ts's `Reasoner`) — it only drives an injected `Reasoner`
 *   - decomposes goals, builds task graphs, or otherwise plans (see
 *     planner.ts / planner-htn.ts) — it only calls `PlannerManager.createPlan`
 *   - schedules tasks or computes critical paths (see planner-scheduler.ts)
 *     — it only calls `PlannerSchedulingEngine.generateSchedule`
 *   - dispatches, retries, rolls back, or otherwise executes tasks (see
 *     executor.ts) — it only calls `ExecutorManager`'s public API and hands
 *     it a caller-supplied `TaskExecutionHandler`
 *   - manages memory storage/indexing/retention itself (see memory.ts) — it
 *     only constructs well-formed `MemoryEntry` values and calls
 *     `MemoryManager.add`
 *
 * It ONLY orchestrates: session/lifecycle management, data-flow sequencing
 * between the stages above, event relay, snapshots, diagnostics, and
 * statistics. Diagnostics in this module observe consistency only — they
 * never repair or mutate indexed state, matching every subsystem's
 * "diagnostics observe only" rule. No `eval`, no `Function` construction,
 * no reflection, and no dynamic code evaluation anywhere in this module.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import { BehaviorReport, BehaviorObservation, analyzeBehaviorBatch } from './behavior'
import { ASTDiffNode } from './hexical-types'
import { ImpactReport, analyzeImpactBatch } from './impact'
import {
  MemoryManager,
  MemoryNode,
  MemoryEntry,
  MemoryType,
  MemoryState,
  MemoryPriority,
  MemoryValidationState,
  MemoryStorageTier,
  MemoryCompression,
  MemoryAccessMode,
  Dictionary,
  Optional,
  Predicate,
  Comparator,
  Versioned,
  Identifiable,
  Timestamped,
  Serializable,
  Timestamp,
  VersionNumber,
} from './memory'
import {
  ExecutorManager,
  TaskExecutionHandler,
  ExecutionSummary,
  ExecutionPhase,
  CancellationReason,
} from './planner/executor'
import {
  Task,
  PlanId,
  ScheduleId,
  Plan,
  Goal,
  GoalType,
  GoalStatus,
  TaskPriority,
  Constraint,
  PlannerContext,
  PlannerManager,
  PlannerTask,
  PlannerDependencyGraph,
  ExecutionPolicyDefinition,
  OptimizationLevel,
  SchedulePolicy,
  RollbackPolicy,
  RecoveryStrategy,
  RollbackPlan,
} from './planner/planner'
import { PlannerConstraintManager } from './planner/planner-constraint'
import { ResourceManager } from './planner/planner-resource'
import { PlannerScheduler as PlannerSchedulingEngine, PlannerSchedule, Schedule } from './planner/planner-scheduler'
import { Reasoner, ReasoningSession, ReasoningResponse, ReasoningReport, Explanation } from './reasoner'
import {
  Recommendation,
  RecommendationPriority,
  RecommendationContext,
  RecommendationEngine,
  EvidenceNode,
  EvidenceNodeType,
} from './recommendation'
import { SemanticInsight, analyzeSemanticBatch, generateExecutiveSummary } from './semantic'
import { SeverityResult, SeverityLevel, calculateSeverity, compareSeverity } from './severity'

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const AGENT_FORMAT_VERSION = 1
export const INITIAL_AGENT_SESSION_VERSION = 1

export const DEFAULT_AGENT_SNAPSHOT_CAPACITY = 100

/* =============================================================================
 * Pipeline Stage
 * =============================================================================
 */

export enum PipelineStage {
  Input = 'input',
  Severity = 'severity',
  Semantic = 'semantic',
  Impact = 'impact',
  Behavior = 'behavior',
  Recommendation = 'recommendation',
  Reasoner = 'reasoner',
  Memory = 'memory',
  Planner = 'planner',
  PlannerScheduler = 'planner-scheduler',
  Executor = 'executor',
  Output = 'output',
}

/* =============================================================================
 * Agent Phase
 * =============================================================================
 *
 * The lifecycle of a single `AgentSession` as a whole, as distinct from any
 * individual `PipelineStage` within it.
 */

export enum AgentPhase {
  Idle = 'idle',
  Running = 'running',
  Halted = 'halted',
  Paused = 'paused',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

/* =============================================================================
 * Agent Subsystem
 * =============================================================================
 */

export enum AgentSubsystem {
  Planner = 'planner',
  PlannerScheduler = 'planner-scheduler',
  Executor = 'executor',
}

/* =============================================================================
 * Agent Event
 * =============================================================================
 */

export enum AgentEvent {
  SessionCreated = 'session-created',
  StageStarted = 'stage-started',
  StageCompleted = 'stage-completed',
  PipelineHalted = 'pipeline-halted',
  PipelinePlanned = 'pipeline-planned',
  PipelineExecuting = 'pipeline-executing',
  PipelineCompleted = 'pipeline-completed',
  PipelineFailed = 'pipeline-failed',
  PipelineCancelled = 'pipeline-cancelled',
  PipelinePaused = 'pipeline-paused',
  PipelineResumed = 'pipeline-resumed',
  SnapshotCreated = 'snapshot-created',
  /** See the module header for why subsystem events are relayed generically rather than mirrored 1:1. */
  SubsystemEvent = 'subsystem-event',
}

/* =============================================================================
 * Agent Observer
 * =============================================================================
 */

export interface AgentObserver {
  onEvent?(event: AgentEvent, payload: Dictionary): void
}

/* =============================================================================
 * Agent Configuration
 * =============================================================================
 */

export interface AgentConfiguration {
  /**
   * If true, a session whose generated recommendations include at least
   * one `blocking: true` recommendation halts before Planning, requiring
   * an explicit `AgentManager.approve()` call before it may proceed.
   */
  haltOnBlockingRecommendations: boolean
  /** Nodes scoring below this severity level are dropped before Semantic analysis. */
  minimumSeverityForAnalysis: SeverityLevel
  /** Whether the Memory stage persists reasoning/recommendation artifacts. */
  persistToMemory: boolean
  enableSnapshots: boolean
  enableDiagnostics: boolean
  snapshotCapacity: number
  /** Used for `PlannerContext.userIntent` when a request doesn't supply one. */
  defaultUserIntent: string
}

export const DEFAULT_AGENT_CONFIGURATION: AgentConfiguration = Object.freeze({
  haltOnBlockingRecommendations: true,
  minimumSeverityForAnalysis: 'INFO',
  persistToMemory: true,
  enableSnapshots: true,
  enableDiagnostics: true,
  snapshotCapacity: DEFAULT_AGENT_SNAPSHOT_CAPACITY,
  defaultUserIntent: 'Automated Hexical AI pipeline execution.',
})

/* =============================================================================
 * Agent Dependencies
 * =============================================================================
 *
 * Every subsystem the Agent orchestrates is injected, never constructed
 * internally — composition over inheritance, and it keeps this module
 * agnostic to how each subsystem is configured (rule sets, retry policy,
 * resource pools, etc. are entirely the caller's concern).
 */

export interface AgentDependencies {
  reasoner: Reasoner
  memory: MemoryManager<Dictionary>
  planner: PlannerManager
  scheduler: PlannerSchedulingEngine
  executor: ExecutorManager
  recommendationEngine: RecommendationEngine
}

/* =============================================================================
 * Agent Request (Input stage)
 * =============================================================================
 */

export interface AgentRequest {
  /** Raw AST diff nodes — the pipeline's actual input. */
  nodes: ASTDiffNode[]
  /**
   * Explicit goals to plan around, in addition to whatever goals the
   * Agent mechanically derives from generated recommendations (see
   * `AgentManager.deriveGoalsFromRecommendations`). Never required —
   * derived goals alone are enough to produce a plan.
   */
  goals?: Goal[]
  constraints?: Constraint[]
  environmentState?: Dictionary
  policies?: Dictionary
  userIntent?: string
  executionPolicy?: ExecutionPolicyDefinition
  optimizationLevel?: OptimizationLevel
  schedulePolicy?: SchedulePolicy
  rollbackPolicy?: RollbackPolicy
  recoveryStrategy?: RecoveryStrategy
  /** Passed through to both scheduling (conflict detection) and execution (reservation/allocation). */
  resources?: ResourceManager
  /** Passed through to both scheduling and execution for constraint evaluation. */
  constraintManager?: PlannerConstraintManager
  projectName?: string
  branch?: string
  commit?: string
  metadata?: Dictionary
}

/* =============================================================================
 * Agent Results
 * =============================================================================
 */

export interface AgentAnalysisResult {
  severity: SeverityResult[]
  semantic: SemanticInsight[]
  impact: ImpactReport[]
  behavior: BehaviorReport[]
  recommendations: Recommendation[]
  reasoning: ReasoningResponse
  explanation: Explanation
  reasoningReport: ReasoningReport
  memoryEntryIds: string[]
  executiveSummary: string
}

export interface AgentPlanResult extends AgentAnalysisResult {
  plan: Plan
  schedule: Schedule
}

export interface AgentExecutionResult extends AgentPlanResult {
  summary: ExecutionSummary
}

/* =============================================================================
 * Agent Statistics / Metrics
 * =============================================================================
 */

export interface AgentStatistics {
  totalSessions: number
  activeSessions: number
  completedSessions: number
  failedSessions: number
  cancelledSessions: number
  haltedSessions: number
  totalNodesAnalyzed: number
  totalRecommendationsGenerated: number
  totalBlockingRecommendations: number
  totalPlansCreated: number
  totalSchedulesGenerated: number
  totalExecutionsCompleted: number
  averageAnalysisTimeMs: number
  averagePlanningTimeMs: number
  averageExecutionTimeMs: number
}

export interface AgentMetrics {
  lastStageDurationMs: number
  lastComputedAt: Timestamp
}

/* =============================================================================
 * Agent Snapshot / Export
 * =============================================================================
 */

export interface AgentSessionSnapshot {
  sessionId: string
  phase: AgentPhase
  createdAt: Timestamp
  updatedAt: Timestamp
  planId?: PlanId
  scheduleId?: ScheduleId
  halted: boolean
  blockingRecommendationIds: string[]
}

export interface AgentSnapshot {
  id: string
  timestamp: Timestamp
  version: VersionNumber
  sessions: AgentSessionSnapshot[]
}

export interface AgentExport {
  exportedAt: Timestamp
  formatVersion: number
  sessions: AgentSessionSnapshot[]
}

/* =============================================================================
 * Agent Session
 * =============================================================================
 *
 * A single mutable, encapsulated pipeline run. Owns the request that
 * started it and whatever results each stage has produced so far, plus a
 * reentrancy guard mirroring `ReasoningSession.beginExecution`/
 * `endExecution` — two concurrent stage runs sharing one session could
 * otherwise interleave and corrupt it.
 *
 * `AgentSession` intentionally does NOT implement `Cloneable`. A clone
 * would need to decide whether to share the original's `planId`/
 * `scheduleId`/`ReasoningSession` (in which case pausing or cancelling the
 * "clone" would actually affect the original's live registrations in
 * `PlannerSchedulingEngine`/`ExecutorManager`/`Reasoner`) or fabricate new
 * ones (in which case it wouldn't be a clone of anything real). Neither is
 * an honest "clone" of a live orchestration session; `serialize()` /
 * `AgentSessionSnapshot` is the supported way to capture and later inspect
 * a session's state.
 */

export class AgentSession implements Identifiable, Timestamped, Versioned, Serializable<AgentSessionSnapshot> {
  public readonly id: string

  private phase: AgentPhase = AgentPhase.Idle
  private request: AgentRequest

  private analysisResult?: AgentAnalysisResult
  private planResult?: AgentPlanResult
  private executionResult?: AgentExecutionResult

  private halted = false
  private blockingRecommendations: Recommendation[] = []

  private planId?: PlanId
  private scheduleId?: ScheduleId

  private reasoningSession?: ReasoningSession

  private cancelled = false
  private running = false

  private readonly created: Timestamp
  private updated: Timestamp
  private revision: VersionNumber = INITIAL_AGENT_SESSION_VERSION

  constructor(id: string, request: AgentRequest) {
    this.id = id
    // Shallow copy only: `request` may legitimately hold live subsystem
    // instances (`resources`, `constraintManager`) that cannot be
    // structurally cloned, and are not this session's to own — a
    // shallow copy still protects against the caller mutating the
    // top-level request object out from under an in-flight session.
    this.request = { ...request }
    this.created = Date.now()
    this.updated = this.created
  }

  get version(): VersionNumber {
    return this.revision
  }

  get createdAt(): Timestamp {
    return this.created
  }

  get updatedAt(): Timestamp {
    return this.updated
  }

  getPhase(): AgentPhase {
    return this.phase
  }

  setPhase(phase: AgentPhase): void {
    this.phase = phase
    this.touch()
  }

  getRequest(): AgentRequest {
    return { ...this.request }
  }

  getAnalysis(): Optional<AgentAnalysisResult> {
    return this.analysisResult
  }

  setAnalysis(result: AgentAnalysisResult): void {
    this.analysisResult = result
    this.touch()
  }

  getPlanResult(): Optional<AgentPlanResult> {
    return this.planResult
  }

  setPlanResult(result: AgentPlanResult): void {
    this.planResult = result
    this.planId = result.plan.id
    this.scheduleId = result.schedule.id
    this.touch()
  }

  getExecutionResult(): Optional<AgentExecutionResult> {
    return this.executionResult
  }

  setExecutionResult(result: AgentExecutionResult): void {
    this.executionResult = result
    this.touch()
  }

  getPlanId(): Optional<PlanId> {
    return this.planId
  }

  getScheduleId(): Optional<ScheduleId> {
    return this.scheduleId
  }

  isHalted(): boolean {
    return this.halted
  }

  getBlockingRecommendations(): readonly Recommendation[] {
    return [...this.blockingRecommendations]
  }

  halt(blocking: readonly Recommendation[]): void {
    this.halted = true
    this.blockingRecommendations = [...blocking]
    this.phase = AgentPhase.Halted
    this.touch()
  }

  approve(): void {
    this.halted = false
    this.blockingRecommendations = []
    this.touch()
  }

  getReasoningSession(): Optional<ReasoningSession> {
    return this.reasoningSession
  }

  setReasoningSession(session: ReasoningSession): void {
    this.reasoningSession = session
    this.touch()
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  requestCancellation(): void {
    this.cancelled = true
    this.touch()
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Marks the session as actively running a pipeline stage. Throws if a
   * run is already in flight, mirroring `ReasoningSession
   * .beginExecution`'s reentrancy guard, for the same reason: two
   * concurrent pipeline stages sharing one `AgentSession` could
   * interleave and corrupt its cached results.
   */
  beginRun(): void {
    if (this.running) {
      throw new Error(
        `Agent session '${this.id}' is already running; concurrent ` +
          `stage execution on the same session is not supported.`,
      )
    }
    this.running = true
  }

  /** Releases the run lock. Always call from a finally block. */
  endRun(): void {
    this.running = false
  }

  private touch(): void {
    this.updated = Date.now()
    this.revision++
  }

  serialize(): AgentSessionSnapshot {
    return {
      sessionId: this.id,
      phase: this.phase,
      createdAt: this.created,
      updatedAt: this.updated,
      planId: this.planId,
      scheduleId: this.scheduleId,
      halted: this.halted,
      blockingRecommendationIds: this.blockingRecommendations.map((r) => r.id),
    }
  }

  describe(): string {
    return [`AgentSession(${this.id})`, `phase=${this.phase}`, `halted=${this.halted}`].join(', ')
  }

  inspect(): Dictionary {
    return {
      id: this.id,
      phase: this.phase,
      halted: this.halted,
      cancelled: this.cancelled,
      planId: this.planId,
      scheduleId: this.scheduleId,
      hasAnalysis: this.analysisResult !== undefined,
      hasPlan: this.planResult !== undefined,
      hasExecution: this.executionResult !== undefined,
    }
  }
}

/* =============================================================================
 * Agent Snapshot Manager
 * =============================================================================
 */

export class AgentSnapshotManager {
  private readonly snapshots = new Map<string, AgentSnapshot>()
  private readonly history: string[] = []
  private readonly capacity: number

  constructor(capacity: number = DEFAULT_AGENT_SNAPSHOT_CAPACITY) {
    if (capacity <= 0) {
      throw new RangeError('Snapshot capacity must be greater than zero.')
    }
    this.capacity = capacity
  }

  create(sessions: readonly AgentSessionSnapshot[]): AgentSnapshot {
    const snapshot: AgentSnapshot = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      version: AGENT_FORMAT_VERSION,
      sessions: [...sessions],
    }

    this.snapshots.set(snapshot.id, snapshot)
    this.history.push(snapshot.id)

    while (this.history.length > this.capacity) {
      const oldest = this.history.shift()
      if (oldest !== undefined) {
        this.snapshots.delete(oldest)
      }
    }

    return snapshot
  }

  get(id: string): Optional<AgentSnapshot> {
    return this.snapshots.get(id)
  }

  latest(): Optional<AgentSnapshot> {
    const id = this.history.at(-1)
    return id ? this.snapshots.get(id) : undefined
  }

  remove(id: string): boolean {
    const index = this.history.indexOf(id)
    if (index >= 0) {
      this.history.splice(index, 1)
    }
    return this.snapshots.delete(id)
  }

  clear(): void {
    this.snapshots.clear()
    this.history.length = 0
  }

  size(): number {
    return this.snapshots.size
  }

  ids(): readonly string[] {
    return [...this.history]
  }

  describe(): string {
    return ['AgentSnapshotManager', `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(', ')
  }

  inspect(): Dictionary {
    return { size: this.size(), capacity: this.capacity, history: [...this.history] }
  }
}

/* =============================================================================
 * Agent Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over an `AgentSession`. Every
 * `validate*` method only inspects state; none of them mutate the session
 * or repair inconsistencies, matching every subsystem's "diagnostics
 * observe only" rule.
 */

export class AgentDiagnostics {
  private checks = 0
  private failures = 0

  constructor() {}

  validateSessionInvariants(session: AgentSession): boolean {
    this.checks++
    const valid = session.id.length > 0
    if (!valid) {
      this.failures++
    }
    return valid
  }

  validatePhaseConsistency(session: AgentSession): boolean {
    this.checks++
    const valid = !(session.getPhase() === AgentPhase.Completed && session.getExecutionResult() === undefined)
    if (!valid) {
      this.failures++
    }
    return valid
  }

  validateHaltConsistency(session: AgentSession): boolean {
    this.checks++
    const valid = session.isHalted() ? session.getBlockingRecommendations().length > 0 : true
    if (!valid) {
      this.failures++
    }
    return valid
  }

  /**
   * A planned session must carry both a `planId` and a `scheduleId`
   * together — `AgentSession.setPlanResult` always assigns both from the
   * same `AgentPlanResult`, so one present without the other indicates
   * state was mutated outside the normal pipeline flow.
   */
  validatePlanScheduleConsistency(session: AgentSession): boolean {
    this.checks++
    const hasPlan = session.getPlanId() !== undefined
    const hasSchedule = session.getScheduleId() !== undefined
    const valid = hasPlan === hasSchedule
    if (!valid) {
      this.failures++
    }
    return valid
  }

  runAll(session: AgentSession): boolean {
    return (
      this.validateSessionInvariants(session) &&
      this.validatePhaseConsistency(session) &&
      this.validateHaltConsistency(session) &&
      this.validatePlanScheduleConsistency(session)
    )
  }

  checksPerformed(): number {
    return this.checks
  }

  failuresDetected(): number {
    return this.failures
  }

  successRate(): number {
    if (this.checks === 0) {
      return 1
    }
    return (this.checks - this.failures) / this.checks
  }

  reset(): void {
    this.checks = 0
    this.failures = 0
  }

  describe(): string {
    return [
      'AgentDiagnostics',
      `checks=${this.checks}`,
      `failures=${this.failures}`,
      `success=${this.successRate()}`,
    ].join(', ')
  }

  inspect(): Dictionary {
    return {
      checks: this.checks,
      failures: this.failures,
      successRate: this.successRate(),
    }
  }
}

/* =============================================================================
 * Agent Manager
 * =============================================================================
 *
 * The single public façade over the cognitive pipeline. Owns the canonical
 * `sessionId -> AgentSession` map and every injected subsystem dependency.
 * `AgentManager` performs no analysis/planning/scheduling/execution/memory
 * logic itself; every stage method below is a thin, validated call into the
 * corresponding subsystem's own public API plus the data translation that
 * connects one subsystem's output shape to the next one's input shape.
 */

export class AgentManager {
  private readonly sessions = new Map<string, AgentSession>()

  private readonly configuration: AgentConfiguration

  private readonly reasoner: Reasoner
  private readonly memory: MemoryManager<Dictionary>
  private readonly planner: PlannerManager
  private readonly scheduler: PlannerSchedulingEngine
  private readonly executor: ExecutorManager
  private readonly recommendationEngine: RecommendationEngine

  private readonly snapshotManager: AgentSnapshotManager
  private readonly diagnostics = new AgentDiagnostics()

  private readonly observers = new Set<AgentObserver>()

  private totalSessions = 0
  private completedSessions = 0
  private failedSessions = 0
  private cancelledSessions = 0
  private haltedSessions = 0

  private totalNodesAnalyzed = 0
  private totalRecommendationsGenerated = 0
  private totalBlockingRecommendations = 0
  private totalPlansCreated = 0
  private totalSchedulesGenerated = 0
  private totalExecutionsCompleted = 0

  private analysisTimeSumMs = 0
  private analysisCount = 0
  private planningTimeSumMs = 0
  private planningCount = 0
  private executionTimeSumMs = 0
  private executionCount = 0

  private readonly metrics: AgentMetrics = {
    lastStageDurationMs: 0,
    lastComputedAt: Date.now(),
  }

  constructor(dependencies: AgentDependencies, configuration: Partial<AgentConfiguration> = {}) {
    this.reasoner = dependencies.reasoner
    this.memory = dependencies.memory
    this.planner = dependencies.planner
    this.scheduler = dependencies.scheduler
    this.executor = dependencies.executor
    this.recommendationEngine = dependencies.recommendationEngine

    this.configuration = Object.freeze({ ...DEFAULT_AGENT_CONFIGURATION, ...configuration })
    this.snapshotManager = new AgentSnapshotManager(this.configuration.snapshotCapacity)

    this.relaySubsystemEvents()
  }

  /* --------------------------------------------------------------------- *
   * Observers
   * --------------------------------------------------------------------- */

  subscribe(observer: AgentObserver): void {
    this.observers.add(observer)
  }

  unsubscribe(observer: AgentObserver): void {
    this.observers.delete(observer)
  }

  private emit(event: AgentEvent, payload: Dictionary): void {
    for (const observer of this.observers) {
      observer.onEvent?.(event, payload)
    }
  }

  /** See the module header for why this relays generically rather than mirroring each subsystem's enum. */
  private relaySubsystemEvents(): void {
    this.planner.subscribe({
      onEvent: (event, payload) =>
        this.emit(AgentEvent.SubsystemEvent, {
          subsystem: AgentSubsystem.Planner,
          subsystemEvent: event,
          ...payload,
        }),
    })

    this.scheduler.subscribe({
      onEvent: (event, payload) =>
        this.emit(AgentEvent.SubsystemEvent, {
          subsystem: AgentSubsystem.PlannerScheduler,
          subsystemEvent: event,
          ...payload,
        }),
    })

    this.executor.subscribe({
      onEvent: (event, payload) =>
        this.emit(AgentEvent.SubsystemEvent, {
          subsystem: AgentSubsystem.Executor,
          subsystemEvent: event,
          ...payload,
        }),
    })
  }

  /* --------------------------------------------------------------------- *
   * Session Lifecycle
   * --------------------------------------------------------------------- */

  createSession(request: AgentRequest): AgentSession {
    if (!Array.isArray(request.nodes)) {
      throw new TypeError('AgentRequest.nodes must be an array of AST diff nodes.')
    }

    const session = new AgentSession(crypto.randomUUID(), request)
    this.sessions.set(session.id, session)
    this.totalSessions++

    this.emit(AgentEvent.SessionCreated, { sessionId: session.id, nodeCount: request.nodes.length })

    return session
  }

  /** Clears a halted session's block, allowing `plan()`/`execute()`/`run()` to proceed past it. */
  approve(sessionId: string): void {
    const session = this.requireSession(sessionId)
    session.approve()
    this.emit(AgentEvent.PipelineResumed, { sessionId })
  }

  pause(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const planId = session.getPlanId()
    if (!planId) {
      throw new Error(`Agent session '${sessionId}' has no active execution to pause.`)
    }
    this.executor.pause(planId)
    session.setPhase(AgentPhase.Paused)
    this.emit(AgentEvent.PipelinePaused, { sessionId })
  }

  resume(sessionId: string): void {
    const session = this.requireSession(sessionId)
    const planId = session.getPlanId()
    if (!planId) {
      throw new Error(`Agent session '${sessionId}' has no active execution to resume.`)
    }
    this.executor.resume(planId)
    session.setPhase(AgentPhase.Running)
    this.emit(AgentEvent.PipelineResumed, { sessionId })
  }

  /**
   * Requests cancellation. If the session has an active execution
   * context, cancellation is delegated to `ExecutorManager.cancel` (which
   * is itself cooperative — see executor.ts). Otherwise the session is
   * simply marked cancelled directly, since there is nothing downstream
   * yet to cooperatively wind down.
   */
  cancel(sessionId: string, reason: CancellationReason = CancellationReason.UserRequested): void {
    const session = this.requireSession(sessionId)
    session.requestCancellation()

    const planId = session.getPlanId()
    if (planId && this.executor.hasContext(planId)) {
      this.executor.cancel(planId, reason)
    } else {
      session.setPhase(AgentPhase.Cancelled)
      this.cancelledSessions++
      this.emit(AgentEvent.PipelineCancelled, { sessionId })
    }
  }

  getSession(sessionId: string): Optional<AgentSession> {
    return this.sessions.get(sessionId)
  }

  requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`No agent session exists with id '${sessionId}'.`)
    }
    return session
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  allSessions(): AgentSession[] {
    return [...this.sessions.values()]
  }

  where(predicate: Predicate<AgentSession>): AgentSession[] {
    return this.allSessions().filter(predicate)
  }

  sortedBy(comparator: Comparator<AgentSession>): AgentSession[] {
    return this.allSessions().sort(comparator)
  }

  /* --------------------------------------------------------------------- *
   * Pipeline: Severity -> Semantic -> Impact -> Behavior -> Recommendation
   *           -> Reasoner -> Memory
   * --------------------------------------------------------------------- */

  /**
   * Runs the synchronous portion of the pipeline — Severity through
   * Memory — against `session`'s request, caching the result on the
   * session. Safe to call more than once; every underlying stage function
   * is pure, so a repeat call simply recomputes and overwrites the cached
   * result.
   */
  analyze(session: AgentSession): AgentAnalysisResult {
    session.beginRun()
    const started = performance.now()
    let currentStage: PipelineStage = PipelineStage.Severity

    try {
      session.setPhase(AgentPhase.Running)
      const request = session.getRequest()

      currentStage = PipelineStage.Severity
      this.emitStage(currentStage, 'started', session)
      const severity = request.nodes.map((node) => calculateSeverity(node))
      this.emitStage(currentStage, 'completed', session)

      const minimum = { level: this.configuration.minimumSeverityForAnalysis } as SeverityResult
      const filteredNodes = request.nodes.filter((_, index) => compareSeverity(severity[index], minimum) <= 0)

      currentStage = PipelineStage.Semantic
      this.emitStage(currentStage, 'started', session)
      const semantic = analyzeSemanticBatch(filteredNodes)
      const executiveSummary = generateExecutiveSummary(semantic)
      this.emitStage(currentStage, 'completed', session)

      currentStage = PipelineStage.Impact
      this.emitStage(currentStage, 'started', session)
      const impact = analyzeImpactBatch(semantic)
      this.emitStage(currentStage, 'completed', session)

      currentStage = PipelineStage.Behavior
      this.emitStage(currentStage, 'started', session)
      const behavior = analyzeBehaviorBatch(semantic, impact)
      this.emitStage(currentStage, 'completed', session)

      currentStage = PipelineStage.Recommendation
      this.emitStage(currentStage, 'started', session)
      const recommendations = this.generateRecommendations(request, semantic, impact, behavior)
      this.emitStage(currentStage, 'completed', session)

      currentStage = PipelineStage.Reasoner
      this.emitStage(currentStage, 'started', session)
      const { reasoningSession, response, explanation, report } = this.runReasoning(
        request,
        severity,
        semantic,
        impact,
        behavior,
        recommendations,
      )
      session.setReasoningSession(reasoningSession)
      this.emitStage(currentStage, 'completed', session)

      let memoryEntryIds: string[] = []
      if (this.configuration.persistToMemory) {
        currentStage = PipelineStage.Memory
        this.emitStage(currentStage, 'started', session)
        memoryEntryIds = this.persistToMemory(session.id, report, recommendations)
        this.emitStage(currentStage, 'completed', session)
      }

      const result: AgentAnalysisResult = {
        severity,
        semantic,
        impact,
        behavior,
        recommendations,
        reasoning: response,
        explanation,
        reasoningReport: report,
        memoryEntryIds,
        executiveSummary,
      }

      session.setAnalysis(result)

      this.totalNodesAnalyzed += request.nodes.length
      this.totalRecommendationsGenerated += recommendations.length

      const blocking = recommendations.filter((r) => r.blocking)
      this.totalBlockingRecommendations += blocking.length

      if (blocking.length > 0 && this.configuration.haltOnBlockingRecommendations) {
        session.halt(blocking)
        this.haltedSessions++
        this.emit(AgentEvent.PipelineHalted, {
          sessionId: session.id,
          blockingRecommendationIds: blocking.map((r) => r.id),
        })
      } else {
        session.setPhase(AgentPhase.Running)
      }

      return result
    } catch (error) {
      session.setPhase(AgentPhase.Failed)
      this.failedSessions++
      this.emit(AgentEvent.PipelineFailed, {
        sessionId: session.id,
        stage: currentStage,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      const elapsed = performance.now() - started
      this.analysisTimeSumMs += elapsed
      this.analysisCount++
      this.metrics.lastStageDurationMs = elapsed
      this.metrics.lastComputedAt = Date.now()
      session.endRun()
    }
  }

  /**
   * Runs `RecommendationEngine.generate` once per analyzed node.
   * `RecommendationContext` is a per-node contract (one severity/
   * semantic/impact/behavior 4-tuple at a time), so unlike every other
   * stage this one cannot be a single batched call — the Agent's role
   * here is exactly the fan-out/fan-in this loop performs.
   */
  private generateRecommendations(
    request: AgentRequest,
    semantic: readonly SemanticInsight[],
    impact: readonly ImpactReport[],
    behavior: readonly BehaviorReport[],
  ): Recommendation[] {
    const timestamp = Date.now()
    const recommendations: Recommendation[] = []

    for (let i = 0; i < semantic.length; i++) {
      const context: RecommendationContext = {
        severity: semantic[i].risk,
        semantic: semantic[i],
        impact: impact[i],
        behavior: behavior[i],
        timestamp,
        projectName: request.projectName,
        branch: request.branch,
        commit: request.commit,
        metadata: request.metadata,
      }

      const report = this.recommendationEngine.generate(context)
      recommendations.push(...report.recommendations)
    }

    return recommendations
  }

  /**
   * Translates every prior stage's output into `EvidenceNode`s, seeds a
   * fresh `ReasoningSession` with them, and executes the reasoning
   * pipeline with an explanation attached. Confidence fields are
   * normalized to `Reasoner`'s [0, 1] scale before being handed over —
   * severity.ts/semantic.ts/impact.ts/behavior.ts all report confidence
   * on a 0-100 scale, while recommendation.ts's `Recommendation
   * .confidence` is already [0, 1].
   */
  private runReasoning(
    request: AgentRequest,
    severity: readonly SeverityResult[],
    semantic: readonly SemanticInsight[],
    impact: readonly ImpactReport[],
    behavior: readonly BehaviorReport[],
    recommendations: readonly Recommendation[],
  ): {
    reasoningSession: ReasoningSession
    response: ReasoningResponse
    explanation: Explanation
    report: ReasoningReport
  } {
    const evidence: EvidenceNode[] = []

    for (const result of severity) {
      evidence.push(
        this.toEvidenceNode(
          EvidenceNodeType.SEVERITY,
          result.badge,
          result.reasons.join('; '),
          result.confidence / 100,
        ),
      )
    }

    for (const insight of semantic) {
      evidence.push(
        this.toEvidenceNode(
          EvidenceNodeType.SEMANTIC,
          insight.title,
          insight.summary,
          insight.confidence / 100,
          insight.id,
        ),
      )
    }

    for (const report of impact) {
      evidence.push(
        this.toEvidenceNode(EvidenceNodeType.IMPACT, report.summary, report.narrative, report.confidence / 100),
      )
    }

    for (const report of behavior) {
      evidence.push(
        this.toEvidenceNode(
          EvidenceNodeType.BEHAVIOR,
          report.summary,
          report.observations.map((o) => o.headline).join('; '),
          this.averageBehaviorConfidence(report) / 100,
        ),
      )
    }

    for (const recommendation of recommendations) {
      evidence.push(
        this.toEvidenceNode(
          EvidenceNodeType.RECOMMENDATION,
          recommendation.title,
          recommendation.summary,
          recommendation.confidence,
          recommendation.id,
        ),
      )
    }

    const reasoningSession = this.reasoner.createSession()
    if (evidence.length > 0) {
      reasoningSession.addEvidenceBatch(evidence)
    }
    reasoningSession.setMetadata({
      projectName: request.projectName ?? null,
      branch: request.branch ?? null,
      commit: request.commit ?? null,
    })

    const { response, explanation, report } = this.reasoner.executeWithExplanation(reasoningSession)
    return { reasoningSession, response, explanation, report }
  }

  private toEvidenceNode(
    type: EvidenceNodeType,
    title: string,
    description: string,
    confidence: number,
    id: string = crypto.randomUUID(),
  ): EvidenceNode {
    return {
      id,
      type,
      title,
      description,
      confidence: Math.min(1, Math.max(0, confidence)),
    }
  }

  private averageBehaviorConfidence(report: BehaviorReport): number {
    if (report.observations.length === 0) {
      return 0
    }
    const total = report.observations.reduce((sum, observation) => sum + observation.confidence, 0)
    return total / report.observations.length
  }

  /**
   * Persists the reasoning report and every generated recommendation
   * into the injected `MemoryManager`, returning the ids assigned to
   * each stored entry. `memory.ts` deliberately provides no factory for
   * building a `MemoryEntry` itself — `MemoryNode`'s constructor takes an
   * already-complete one by design, leaving construction to whichever
   * caller owns the data being stored, which for pipeline artifacts is
   * this module.
   */
  private persistToMemory(
    sessionId: string,
    report: ReasoningReport,
    recommendations: readonly Recommendation[],
  ): string[] {
    const ids: string[] = []

    const reportEntry = this.buildMemoryEntry(
      MemoryType.Session,
      report as unknown as Dictionary,
      report.trace.explanation.confidence,
      [sessionId, 'reasoning-report'],
    )
    this.memory.add(new MemoryNode(reportEntry))
    ids.push(reportEntry.id)

    for (const recommendation of recommendations) {
      const entry = this.buildMemoryEntry(
        MemoryType.Recommendation,
        recommendation as unknown as Dictionary,
        recommendation.confidence,
        [sessionId, recommendation.category],
      )
      this.memory.add(new MemoryNode(entry))
      ids.push(entry.id)
    }

    return ids
  }

  private buildMemoryEntry(
    type: MemoryType,
    data: Dictionary,
    confidence: number,
    tags: string[],
  ): MemoryEntry<Dictionary> {
    const now = Date.now()
    const normalizedConfidence = Math.min(1, Math.max(0, confidence))

    return {
      id: crypto.randomUUID(),
      type,
      state: MemoryState.Active,
      priority: MemoryPriority.Normal,
      data,
      metadata: {
        createdAt: now,
        updatedAt: now,
        source: 'agent',
        version: 1,
        tags,
        labels: [],
        confidence: normalizedConfidence,
        importance: normalizedConfidence,
        validationState: MemoryValidationState.Valid,
        storageTier: MemoryStorageTier.Hot,
        compression: MemoryCompression.None,
      },
      relationships: {
        childIds: [],
        relatedIds: [],
        dependencyIds: [],
      },
      access: {
        count: 0,
        firstAccess: now,
        lastAccess: now,
        mode: MemoryAccessMode.ReadWrite,
      },
      versions: [],
      score: normalizedConfidence,
    }
  }

  private emitStage(stage: PipelineStage, status: 'started' | 'completed', session: AgentSession): void {
    this.emit(status === 'started' ? AgentEvent.StageStarted : AgentEvent.StageCompleted, {
      sessionId: session.id,
      stage,
    })
  }

  /* --------------------------------------------------------------------- *
   * Pipeline: Planner -> PlannerScheduler
   * --------------------------------------------------------------------- */

  /**
   * Runs the Planner and PlannerScheduler stages against a session's
   * cached analysis (running `analyze()` first if it hasn't been run
   * yet). Throws if the session is halted on blocking recommendations
   * and has not been explicitly approved via `approve()`.
   */
  plan(session: AgentSession): AgentPlanResult {
    const analysis = session.getAnalysis() ?? this.analyze(session)

    if (session.isHalted()) {
      throw new Error(
        `Agent session '${session.id}' is halted on ` +
          `${session.getBlockingRecommendations().length} blocking recommendation(s); ` +
          `call approve() before planning.`,
      )
    }

    session.beginRun()
    const started = performance.now()
    let currentStage: PipelineStage = PipelineStage.Planner

    try {
      const request = session.getRequest()

      currentStage = PipelineStage.Planner
      this.emitStage(currentStage, 'started', session)

      const goals = [...(request.goals ?? []), ...this.deriveGoalsFromRecommendations(analysis.recommendations)]

      const context: PlannerContext = {
        reasoningReport: analysis.reasoningReport,
        recommendations: analysis.recommendations,
        memory: this.memory,
        goals,
        constraints: request.constraints ?? [],
        environmentState: request.environmentState ?? {},
        policies: request.policies ?? {},
        userIntent: request.userIntent ?? this.configuration.defaultUserIntent,
        executionPolicy: request.executionPolicy,
        optimizationLevel: request.optimizationLevel,
        schedulePolicy: request.schedulePolicy,
        rollbackPolicy: request.rollbackPolicy,
        recoveryStrategy: request.recoveryStrategy,
        timestamp: Date.now(),
        metadata: request.metadata,
      }

      const plan = this.planner.createPlan(context)
      this.totalPlansCreated++
      this.emitStage(currentStage, 'completed', session)

      currentStage = PipelineStage.PlannerScheduler
      this.emitStage(currentStage, 'started', session)

      const graph = this.buildDependencyGraph(plan.tasks)
      const plannerTasks = plan.tasks.map((task) => new PlannerTask(task))

      const schedule = this.scheduler.generateSchedule(plan.id, plannerTasks, graph, {
        policy: request.schedulePolicy,
        resources: request.resources,
        constraints: request.constraintManager,
      })
      this.totalSchedulesGenerated++
      this.emitStage(currentStage, 'completed', session)

      const result: AgentPlanResult = {
        ...analysis,
        plan,
        schedule: schedule.serialize(),
      }

      session.setPlanResult(result)
      this.emit(AgentEvent.PipelinePlanned, {
        sessionId: session.id,
        planId: plan.id,
        scheduleId: schedule.id,
      })

      return result
    } catch (error) {
      session.setPhase(AgentPhase.Failed)
      this.failedSessions++
      this.emit(AgentEvent.PipelineFailed, {
        sessionId: session.id,
        stage: currentStage,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      const elapsed = performance.now() - started
      this.planningTimeSumMs += elapsed
      this.planningCount++
      this.metrics.lastStageDurationMs = elapsed
      this.metrics.lastComputedAt = Date.now()
      session.endRun()
    }
  }

  /**
   * Mechanically translates each Recommendation into a single Goal whose
   * success criteria are the recommendation's own action titles. This is
   * a data-shape translation only — no decomposition, scheduling, or
   * dependency inference happens here; all of that remains
   * `PlannerManager`'s / `HTNPlanner`'s responsibility. Derived goals are
   * appended alongside any explicit `AgentRequest.goals`, never replacing
   * them.
   */
  private deriveGoalsFromRecommendations(recommendations: readonly Recommendation[]): Goal[] {
    const now = Date.now()

    return recommendations.map((recommendation) => ({
      id: crypto.randomUUID(),
      type: GoalType.Achievement,
      status: GoalStatus.Pending,
      title: recommendation.title,
      description: recommendation.summary,
      priority: this.mapRecommendationPriority(recommendation),
      successCriteria: recommendation.actions.map((action) => action.title),
      subGoalIds: [],
      relatedTaskIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: {
        recommendationId: recommendation.id,
        category: recommendation.category,
        automated: recommendation.automated,
        blocking: recommendation.blocking,
      },
    }))
  }

  private mapRecommendationPriority(recommendation: Recommendation): TaskPriority {
    if (recommendation.blocking && recommendation.priority === RecommendationPriority.CRITICAL) {
      return TaskPriority.Urgent
    }

    switch (recommendation.priority) {
      case RecommendationPriority.CRITICAL:
        return TaskPriority.Critical
      case RecommendationPriority.HIGH:
        return TaskPriority.High
      case RecommendationPriority.MEDIUM:
        return TaskPriority.Normal
      case RecommendationPriority.LOW:
      case RecommendationPriority.INFORMATIONAL:
      default:
        return TaskPriority.Low
    }
  }

  /**
   * Mirrors planner.ts's own private `PlannerManager.buildGraph` and
   * executor.ts's own private `ExecutorManager.buildGraph` — neither is
   * exported, so any caller needing a live `PlannerDependencyGraph` from
   * a plan's tasks (this module included) must reconstruct one the same
   * way. Worth revisiting upstream as a shared exported utility if a
   * fourth consumer ever needs it.
   */
  private buildDependencyGraph(tasks: readonly Task[]): PlannerDependencyGraph {
    const graph = new PlannerDependencyGraph()

    for (const task of tasks) {
      graph.addNode(task.id)
    }

    for (const task of tasks) {
      for (const dependencyId of task.dependencyIds) {
        graph.addEdge(dependencyId, task.id)
      }
    }

    return graph
  }

  /* --------------------------------------------------------------------- *
   * Pipeline: Executor -> Output
   * --------------------------------------------------------------------- */

  /**
   * Runs the Executor stage against a session's cached plan (running
   * `plan()` — and transitively `analyze()` — first if it hasn't been run
   * yet). This is the pipeline's only inherently asynchronous stage:
   * everything through PlannerScheduler is pure synchronous computation,
   * while dispatching real tasks to `handler` is not.
   */
  async execute(
    session: AgentSession,
    handler: TaskExecutionHandler,
    options: { rollbackPlan?: RollbackPlan } = {},
  ): Promise<AgentExecutionResult> {
    const planResult = session.getPlanResult() ?? this.plan(session)

    session.beginRun()
    const started = performance.now()

    try {
      const request = session.getRequest()

      this.emitStage(PipelineStage.Executor, 'started', session)
      session.setPhase(AgentPhase.Running)

      const liveSchedule = this.requireLiveSchedule(session)
      this.executor.beginExecution(planResult.plan, liveSchedule)
      this.emit(AgentEvent.PipelineExecuting, { sessionId: session.id, planId: planResult.plan.id })

      const summary = await this.executor.run(planResult.plan.id, handler, {
        resources: request.resources,
        constraints: request.constraintManager,
        rollbackPlan: options.rollbackPlan,
      })

      this.emitStage(PipelineStage.Executor, 'completed', session)
      this.emitStage(PipelineStage.Output, 'completed', session)

      const result: AgentExecutionResult = { ...planResult, summary }
      session.setExecutionResult(result)

      const phase =
        summary.phase === ExecutionPhase.Completed
          ? AgentPhase.Completed
          : summary.phase === ExecutionPhase.Cancelled
          ? AgentPhase.Cancelled
          : AgentPhase.Failed

      session.setPhase(phase)

      if (phase === AgentPhase.Completed) {
        this.completedSessions++
        this.totalExecutionsCompleted++
        this.emit(AgentEvent.PipelineCompleted, { sessionId: session.id, planId: planResult.plan.id })
      } else if (phase === AgentPhase.Cancelled) {
        this.cancelledSessions++
        this.emit(AgentEvent.PipelineCancelled, { sessionId: session.id, planId: planResult.plan.id })
      } else {
        this.failedSessions++
        this.emit(AgentEvent.PipelineFailed, {
          sessionId: session.id,
          stage: PipelineStage.Executor,
          failedTaskIds: summary.failedTaskIds,
        })
      }

      return result
    } catch (error) {
      session.setPhase(AgentPhase.Failed)
      this.failedSessions++
      this.emit(AgentEvent.PipelineFailed, {
        sessionId: session.id,
        stage: PipelineStage.Executor,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      const elapsed = performance.now() - started
      this.executionTimeSumMs += elapsed
      this.executionCount++
      this.metrics.lastStageDurationMs = elapsed
      this.metrics.lastComputedAt = Date.now()
      session.endRun()
    }
  }

  /**
   * `AgentPlanResult.schedule` is the serialized `Schedule` value (safe
   * to hand back to a caller as immutable output data), but
   * `ExecutorManager.beginExecution` needs the *live* `PlannerSchedule`
   * instance. Rather than caching a second live reference on
   * `AgentSession` — which would need to be kept in sync with whatever
   * `PlannerSchedulingEngine` does internally — this simply asks the
   * scheduling engine for the instance it already owns, by the id
   * `AgentSession.setPlanResult` recorded.
   */
  private requireLiveSchedule(session: AgentSession): PlannerSchedule {
    const scheduleId = session.getScheduleId()
    if (!scheduleId) {
      throw new Error(`Agent session '${session.id}' has no schedule; call plan() first.`)
    }
    return this.scheduler.requireSchedule(scheduleId)
  }

  /**
   * Full convenience pipeline: creates a session and runs every stage
   * through Executor, returning the complete result. Equivalent to
   * `plan(session)` followed by `execute(session, handler, options)`,
   * except it also creates the session. A halt on blocking
   * recommendations surfaces as a thrown error (from the internal
   * `plan()` call) rather than a silent partial result — callers that
   * want to inspect and approve a halted session should call
   * `createSession` / `analyze` / `approve` / `plan` / `execute`
   * individually instead of `run()`.
   */
  async run(
    request: AgentRequest,
    handler: TaskExecutionHandler,
    options: { rollbackPlan?: RollbackPlan } = {},
  ): Promise<AgentExecutionResult> {
    const session = this.createSession(request)
    this.plan(session)
    return this.execute(session, handler, options)
  }

  /* --------------------------------------------------------------------- *
   * Snapshot / Serialization
   * --------------------------------------------------------------------- */

  snapshot(): AgentSnapshot {
    const sessionSnapshots = this.allSessions().map((session) => session.serialize())
    const snapshot = this.snapshotManager.create(sessionSnapshots)
    this.emit(AgentEvent.SnapshotCreated, { snapshotId: snapshot.id })
    return snapshot
  }

  export(): AgentExport {
    return {
      exportedAt: Date.now(),
      formatVersion: AGENT_FORMAT_VERSION,
      sessions: this.allSessions().map((session) => session.serialize()),
    }
  }

  /* --------------------------------------------------------------------- *
   * Diagnostics / Statistics
   * --------------------------------------------------------------------- */

  runDiagnostics(sessionId: string): boolean {
    const session = this.requireSession(sessionId)
    return this.diagnostics.runAll(session)
  }

  getMetrics(): AgentMetrics {
    return { ...this.metrics }
  }

  getStatistics(): AgentStatistics {
    const sessions = this.allSessions()

    return {
      totalSessions: this.totalSessions,
      activeSessions: sessions.filter(
        (session) => session.getPhase() === AgentPhase.Running || session.getPhase() === AgentPhase.Paused,
      ).length,
      completedSessions: this.completedSessions,
      failedSessions: this.failedSessions,
      cancelledSessions: this.cancelledSessions,
      haltedSessions: this.haltedSessions,
      totalNodesAnalyzed: this.totalNodesAnalyzed,
      totalRecommendationsGenerated: this.totalRecommendationsGenerated,
      totalBlockingRecommendations: this.totalBlockingRecommendations,
      totalPlansCreated: this.totalPlansCreated,
      totalSchedulesGenerated: this.totalSchedulesGenerated,
      totalExecutionsCompleted: this.totalExecutionsCompleted,
      averageAnalysisTimeMs: this.analysisCount > 0 ? this.analysisTimeSumMs / this.analysisCount : 0,
      averagePlanningTimeMs: this.planningCount > 0 ? this.planningTimeSumMs / this.planningCount : 0,
      averageExecutionTimeMs: this.executionCount > 0 ? this.executionTimeSumMs / this.executionCount : 0,
    }
  }

  /* --------------------------------------------------------------------- *
   * Introspection
   * --------------------------------------------------------------------- */

  describe(): string {
    return [
      'AgentManager',
      `sessions=${this.sessions.size}`,
      `completed=${this.completedSessions}`,
      `failed=${this.failedSessions}`,
      `halted=${this.haltedSessions}`,
    ].join(', ')
  }

  inspect(): Dictionary {
    return {
      configuration: { ...this.configuration },
      sessions: this.sessions.size,
      metrics: this.getMetrics(),
      statistics: this.getStatistics() as unknown as Dictionary,
      snapshots: this.snapshotManager.inspect(),
      diagnostics: this.diagnostics.inspect(),
    }
  }
}
