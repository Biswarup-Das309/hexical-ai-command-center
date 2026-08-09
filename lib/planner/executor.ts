/**
 * =============================================================================
 * Hexical AI
 * executor.ts
 * =============================================================================
 *
 * Execution Orchestration Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * `planner-scheduler.ts` produces a `PlannerSchedule`: a dependency-ordered,
 * concurrency-bounded *plan* of when tasks are expected to run. This module
 * is what actually carries that plan out — it owns execution lifecycle,
 * dispatching ready tasks to an injected `TaskExecutionHandler`, waiting on
 * dependencies, tracking progress, retrying transient failures, rolling back
 * and recovering from terminal ones, honoring cancellation and pause/resume,
 * enforcing per-task timeouts, and recording execution history — all
 * independent of any single Plan, mirroring the `ResourceManager`
 * (planner-resource.ts), `PlannerConstraintManager` (planner-constraint.ts),
 * and `PlannerScheduler` (planner-scheduler.ts) pattern of a focused
 * subsystem manager with its own encapsulated domain objects, diagnostics,
 * and statistics.
 *
 * Unlike its sibling modules, this one is intrinsically asynchronous: a
 * `TaskExecutionHandler` performs real work (agent calls, tool invocations,
 * I/O) that this module has no visibility into and no ability to interrupt
 * mid-flight. Dispatch is therefore driven off *live* dependency resolution
 * and *live* outcomes, never off a schedule's planned timestamps — those
 * were only ever estimates, and treating them as authoritative at execution
 * time would silently desynchronize the executor from reality the moment
 * any task ran faster or slower than planned.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - plans, decomposes goals, or builds task graphs (see planner.ts /
 *     planner-htn.ts) — it only consumes an already-validated `Plan`
 *   - schedules or reschedules tasks, computes critical paths, or performs
 *     concurrency allocation (see planner-scheduler.ts's `PlannerScheduler`)
 *     — it only consumes a `PlannerSchedule` produced elsewhere, as a
 *     contractual input, and drives dispatch independently of it
 *   - manages constraints or decides their satisfaction beyond delegating to
 *     a supplied `PlannerConstraintManager` (see planner-constraint.ts)
 *   - allocates, reserves, or manages resource capacity itself (see
 *     planner-resource.ts's `ResourceManager`) — it only *reserves against*
 *     and *releases* one, through its already-public API, immediately
 *     around a task's dispatch window
 *   - performs the actual work of a task. Every side effect a task has on
 *     the outside world happens inside an injected `TaskExecutionHandler`,
 *     which this module treats as an opaque, untrusted boundary
 *
 * It ONLY orchestrates execution: dispatching, dependency waiting, progress
 * tracking, retries, rollback, recovery, cancellation, pause/resume, timeout
 * handling, execution history, snapshots, diagnostics, and statistics.
 * Diagnostics in this module observe consistency only — they never repair
 * or mutate indexed state, matching every sibling module's "diagnostics
 * observe only" rule. No `eval`, no `Function` construction, no reflection,
 * and no dynamic code evaluation anywhere in this module.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    Task,
    TaskId,
    PlanId,
    Plan,
    RiskLevel,
    RollbackPolicy,
    RecoveryStrategy,
    RollbackPlan,
    ExecutionPolicyDefinition,
    PlannerTask,
    PlannerDependencyGraph,
    DEFAULT_TASK_MAX_RETRIES,
    generateId
} from "./planner";

import {
    PlannerSchedule
} from "./planner-scheduler";

import {
    ResourceManager
} from "./planner-resource";

import {
    PlannerConstraintManager
} from "./planner-constraint";

import {
    Dictionary,
    JsonValue,
    Optional,
    Predicate,
    Comparator,
    Serializable,
    Cloneable,
    Validatable,
    Versioned,
    Identifiable,
    Timestamped,
    Timestamp,
    VersionNumber
} from "../memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const EXECUTOR_FORMAT_VERSION = 1;
export const INITIAL_EXECUTION_VERSION = 1;

export const DEFAULT_EXECUTOR_SNAPSHOT_CAPACITY = 100;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/* =============================================================================
 * Utility Functions
 * =============================================================================
 */

/** Clamps a fraction into [0, 1]. NaN and other non-finite values collapse to 0. */
function clampFraction(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/** Non-blocking delay, used by the dispatch loop's idle/backoff waits. */
function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/* =============================================================================
 * Execution State
 * =============================================================================
 *
 * A finer-grained state machine than planner.ts's `TaskState`: `TaskState`
 * describes a task's status from the *planning* domain's perspective
 * (pending/ready/scheduled/blocked/...), while `ExecutionState` describes it
 * from the *runtime* domain's perspective, with states (`Dispatched`,
 * `Retrying`, `TimedOut`, `RolledBack`) that only make sense once execution
 * has actually begun. This module never writes back into a `Task`'s own
 * `state` field — that remains planner.ts's / `PlannerTask`'s to own; a
 * caller that wants planning-domain state kept in sync is expected to read
 * `ExecutionTask.getState()` and translate it explicitly.
 */

export enum ExecutionState {
    Pending = "pending",
    Waiting = "waiting",
    Ready = "ready",
    Dispatched = "dispatched",
    Running = "running",
    Paused = "paused",
    Retrying = "retrying",
    Completed = "completed",
    Failed = "failed",
    Skipped = "skipped",
    Cancelled = "cancelled",
    TimedOut = "timed-out",
    RolledBack = "rolled-back"
}

/**
 * The legal state-machine transitions for `ExecutionState`. `ExecutionTask
 * .setState` validates every move against this table and throws on an
 * illegal one rather than silently accepting it — a corrupted execution
 * state machine is far more dangerous to observe late (e.g. a "completed"
 * task quietly re-entering "running") than to reject the instant it would
 * occur.
 */
const LEGAL_EXECUTION_TRANSITIONS: ReadonlyMap<ExecutionState, ReadonlySet<ExecutionState>> = new Map<ExecutionState, ReadonlySet<ExecutionState>>([
    [ExecutionState.Pending, new Set([ExecutionState.Waiting, ExecutionState.Ready, ExecutionState.Cancelled])],
    [ExecutionState.Waiting, new Set([ExecutionState.Ready, ExecutionState.Skipped, ExecutionState.Cancelled])],
    [ExecutionState.Ready, new Set([ExecutionState.Dispatched, ExecutionState.Skipped, ExecutionState.Cancelled])],
    [ExecutionState.Dispatched, new Set([ExecutionState.Running, ExecutionState.TimedOut, ExecutionState.Cancelled])],
    [ExecutionState.Running, new Set([
        ExecutionState.Completed,
        ExecutionState.Failed,
        ExecutionState.TimedOut,
        ExecutionState.Paused,
        ExecutionState.Cancelled
    ])],
    [ExecutionState.Paused, new Set([ExecutionState.Running, ExecutionState.Cancelled])],
    [ExecutionState.Retrying, new Set([ExecutionState.Ready, ExecutionState.Dispatched, ExecutionState.Cancelled])],
    [ExecutionState.Failed, new Set([
        ExecutionState.Retrying,
        ExecutionState.Skipped,
        ExecutionState.RolledBack,
        ExecutionState.Cancelled
    ])],
    [ExecutionState.TimedOut, new Set([
        ExecutionState.Retrying,
        ExecutionState.Skipped,
        ExecutionState.RolledBack,
        ExecutionState.Cancelled
    ])],
    [ExecutionState.Completed, new Set([ExecutionState.RolledBack])],
    [ExecutionState.Skipped, new Set([])],
    [ExecutionState.Cancelled, new Set([])],
    [ExecutionState.RolledBack, new Set([])]
]);

/* =============================================================================
 * Cancellation Reason
 * =============================================================================
 */

export enum CancellationReason {
    UserRequested = "user-requested",
    Timeout = "timeout",
    DependencyFailed = "dependency-failed",
    PolicyViolation = "policy-violation",
    FatalError = "fatal-error"
}

/* =============================================================================
 * Retry Backoff Strategy
 * =============================================================================
 */

export enum RetryBackoffStrategy {
    Fixed = "fixed",
    Linear = "linear",
    Exponential = "exponential",
    ExponentialJitter = "exponential-jitter"
}

/* =============================================================================
 * Execution Phase
 * =============================================================================
 *
 * The lifecycle of an `ExecutionContext` as a whole, as distinct from any
 * single task's `ExecutionState` within it.
 */

export enum ExecutionPhase {
    Idle = "idle",
    Running = "running",
    Paused = "paused",
    RollingBack = "rolling-back",
    Completed = "completed",
    Failed = "failed",
    Cancelled = "cancelled"
}

/* =============================================================================
 * Recovery Action
 * =============================================================================
 */

export enum RecoveryAction {
    Retry = "retry",
    Skip = "skip",
    Abort = "abort",
    Escalate = "escalate",
    Compensate = "compensate"
}

/* =============================================================================
 * Executor Event
 * =============================================================================
 */

export enum ExecutionEvent {
    ExecutionStarted = "execution-started",
    ExecutionPaused = "execution-paused",
    ExecutionResumed = "execution-resumed",
    ExecutionCompleted = "execution-completed",
    ExecutionFailed = "execution-failed",
    ExecutionCancelled = "execution-cancelled",
    TaskDispatched = "task-dispatched",
    TaskStarted = "task-started",
    TaskCompleted = "task-completed",
    TaskFailed = "task-failed",
    TaskRetried = "task-retried",
    TaskSkipped = "task-skipped",
    TaskTimedOut = "task-timed-out",
    TaskCancelled = "task-cancelled",
    TaskRolledBack = "task-rolled-back",
    RollbackStarted = "rollback-started",
    RollbackCompleted = "rollback-completed",
    RecoveryTriggered = "recovery-triggered",
    SnapshotCreated = "snapshot-created"
}

/* =============================================================================
 * Execution Timeout Error
 * =============================================================================
 */

export class ExecutionTimeoutError extends Error {
    public readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`Execution exceeded its timeout of ${timeoutMs}ms.`);
        this.name = "ExecutionTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/* =============================================================================
 * Execution Record / State Transition
 * =============================================================================
 */

export interface ExecutionStateTransition {
    from: ExecutionState;
    to: ExecutionState;
    timestamp: Timestamp;
    reason?: string;
}

export interface ExecutionRecord {
    taskId: TaskId;
    planId: PlanId;
    state: ExecutionState;
    attempt: number;
    maxAttempts: number;
    startedAt?: Timestamp;
    finishedAt?: Timestamp;
    timeoutMs?: number;
    output?: JsonValue;
    error?: string;
    cancellationReason?: CancellationReason;
    resourceReservationIds: string[];
    history: ExecutionStateTransition[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

/* =============================================================================
 * Task Execution Handler (extension point)
 * =============================================================================
 *
 * The single seam between this module's orchestration and a task's real
 * side effects, mirroring the `GoalDecomposer` (planner.ts /
 * planner-htn.ts) extension-point pattern: `ExecutorManager` never performs
 * a task's work itself, it only calls into whatever `TaskExecutionHandler`
 * the caller supplies.
 */

export interface TaskExecutionOutcome {
    success: boolean;
    output?: JsonValue;
    error?: string;
}

export interface ExecutionRuntimeContext {
    readonly planId: PlanId;
    readonly taskId: TaskId;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly startedAt: Timestamp;
    readonly metadata: Dictionary;
    isCancelled(): boolean;
}

export interface TaskExecutionHandler {
    execute(task: Task, context: ExecutionRuntimeContext): Promise<TaskExecutionOutcome>;
    /**
     * Undoes a previously-completed task's effects. Optional: a handler
     * that cannot meaningfully undo a task's work is expected to omit this
     * rather than this module guessing at a no-op. `ExecutionRollbackManager`
     * skips any checkpoint task whose handler defines no `rollback`.
     */
    rollback?(task: Task, context: ExecutionRuntimeContext): Promise<void>;
}

/* =============================================================================
 * Executor Configuration
 * =============================================================================
 */

export interface ExecutorConfiguration {
    defaultMaxRetries: number;
    retryBackoff: RetryBackoffStrategy;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    autoRollbackOnFailure: boolean;
    enableSnapshots: boolean;
    enableDiagnostics: boolean;
    snapshotCapacity: number;
}

export const DEFAULT_EXECUTOR_CONFIGURATION: ExecutorConfiguration = Object.freeze({
    defaultMaxRetries: DEFAULT_TASK_MAX_RETRIES,
    retryBackoff: RetryBackoffStrategy.ExponentialJitter,
    retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    autoRollbackOnFailure: true,
    enableSnapshots: true,
    enableDiagnostics: true,
    snapshotCapacity: DEFAULT_EXECUTOR_SNAPSHOT_CAPACITY
});

/* =============================================================================
 * Execution Summary / Progress
 * =============================================================================
 */

export interface ExecutionSummary {
    planId: PlanId;
    phase: ExecutionPhase;
    completedTaskIds: TaskId[];
    failedTaskIds: TaskId[];
    skippedTaskIds: TaskId[];
    cancelledTaskIds: TaskId[];
    startedAt: Timestamp;
    finishedAt: Timestamp;
    durationMs: number;
}

export interface ExecutionProgress {
    planId: PlanId;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    skippedTasks: number;
    cancelledTasks: number;
    runningTasks: number;
    pendingTasks: number;
    percentComplete: number;
    elapsedMs: number;
    estimatedRemainingMs?: number;
    computedAt: Timestamp;
}

/* =============================================================================
 * Executor Statistics / Metrics
 * =============================================================================
 */

export interface ExecutionStatistics {
    totalExecutions: number;
    activeExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    cancelledExecutions: number;
    totalTasks: number;
    pendingTasks: number;
    runningTasks: number;
    completedTasks: number;
    failedTasks: number;
    skippedTasks: number;
    cancelledTasks: number;
    timedOutTasks: number;
    totalRetries: number;
    totalRollbacks: number;
    totalRecoveries: number;
    averageTaskDurationMs: number;
    averageExecutionDurationMs: number;
}

export interface ExecutorMetrics {
    lastDispatchCycleMs: number;
    averageDispatchLatencyMs: number;
    lastComputedAt: Timestamp;
}

/* =============================================================================
 * Executor Snapshot / Export
 * =============================================================================
 */

export interface ExecutionContextSnapshot {
    planId: PlanId;
    phase: ExecutionPhase;
    records: ExecutionRecord[];
}

export interface ExecutorSnapshot {
    id: string;
    timestamp: Timestamp;
    version: VersionNumber;
    contexts: ExecutionContextSnapshot[];
}

export interface ExecutorExport {
    exportedAt: Timestamp;
    formatVersion: number;
    contexts: ExecutionContextSnapshot[];
}

/* =============================================================================
 * Executor Observer
 * =============================================================================
 */

export interface ExecutorObserver {
    onEvent?(event: ExecutionEvent, payload: Dictionary): void;
}

/* =============================================================================
 * Execution Task
 * =============================================================================
 *
 * A single mutable, encapsulated runtime record for one task's execution.
 * Wraps an `ExecutionRecord` value object with private state, defensive
 * cloning on every read/write, and explicit invariant checks before
 * mutation — mirroring the `PlannerScheduleEntry` / `PlannerResource`
 * pattern used elsewhere in Hexical. Every state change is both validated
 * against `LEGAL_EXECUTION_TRANSITIONS` and appended to `history`, so a
 * task's full lifecycle is always reconstructable from `serialize()` alone.
 */

export class ExecutionTask
    implements
        Serializable<ExecutionRecord>,
        Cloneable<ExecutionTask>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: TaskId;
    public readonly planId: PlanId;

    private state: ExecutionState;
    private attempt: number;
    private maxAttempts: number;
    private startedAt?: Timestamp;
    private finishedAt?: Timestamp;
    private timeoutMs?: number;
    private output?: JsonValue;
    private error?: string;
    private cancellationReason?: CancellationReason;
    private resourceReservationIds: string[];
    private history: ExecutionStateTransition[];

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_EXECUTION_VERSION;

    private frozen = false;

    constructor(record: ExecutionRecord) {
        this.id = record.taskId;
        this.planId = record.planId;
        this.state = record.state;
        this.attempt = record.attempt;
        this.maxAttempts = record.maxAttempts;
        this.startedAt = record.startedAt;
        this.finishedAt = record.finishedAt;
        this.timeoutMs = record.timeoutMs;
        this.output = record.output;
        this.error = record.error;
        this.cancellationReason = record.cancellationReason;
        this.resourceReservationIds = [...record.resourceReservationIds];
        this.history = structuredClone(record.history);
        this.created = record.createdAt;
        this.updated = record.updatedAt;
    }

    static create(taskId: TaskId, planId: PlanId, maxAttempts: number, timeoutMs?: number): ExecutionTask {
        const now = Date.now();
        return new ExecutionTask({
            taskId,
            planId,
            state: ExecutionState.Pending,
            attempt: 0,
            maxAttempts,
            timeoutMs,
            resourceReservationIds: [],
            history: [],
            createdAt: now,
            updatedAt: now
        });
    }

    get version(): VersionNumber {
        return this.revision;
    }

    get createdAt(): Timestamp {
        return this.created;
    }

    get updatedAt(): Timestamp {
        return this.updated;
    }

    getState(): ExecutionState {
        return this.state;
    }

    getAttempt(): number {
        return this.attempt;
    }

    getMaxAttempts(): number {
        return this.maxAttempts;
    }

    getStartedAt(): Optional<Timestamp> {
        return this.startedAt;
    }

    getFinishedAt(): Optional<Timestamp> {
        return this.finishedAt;
    }

    getTimeoutMs(): Optional<number> {
        return this.timeoutMs;
    }

    getOutput(): Optional<JsonValue> {
        return this.output;
    }

    getError(): Optional<string> {
        return this.error;
    }

    getCancellationReason(): Optional<CancellationReason> {
        return this.cancellationReason;
    }

    getResourceReservationIds(): readonly string[] {
        return [...this.resourceReservationIds];
    }

    getHistory(): readonly ExecutionStateTransition[] {
        return structuredClone(this.history);
    }

    getDurationMs(): Optional<number> {
        if (this.startedAt === undefined || this.finishedAt === undefined) {
            return undefined;
        }
        return Math.max(0, this.finishedAt - this.startedAt);
    }

    isTerminal(): boolean {
        return (
            this.state === ExecutionState.Completed ||
            this.state === ExecutionState.Failed ||
            this.state === ExecutionState.Skipped ||
            this.state === ExecutionState.Cancelled ||
            this.state === ExecutionState.TimedOut ||
            this.state === ExecutionState.RolledBack
        );
    }

    isActive(): boolean {
        return (
            this.state === ExecutionState.Dispatched ||
            this.state === ExecutionState.Running ||
            this.state === ExecutionState.Paused
        );
    }

    isRunnable(): boolean {
        return this.state === ExecutionState.Ready;
    }

    canRetry(): boolean {
        return (
            (this.state === ExecutionState.Failed || this.state === ExecutionState.TimedOut) &&
            this.attempt < this.maxAttempts
        );
    }

    hasTimedOut(referenceTime: Timestamp = Date.now()): boolean {
        if (this.timeoutMs === undefined || this.startedAt === undefined) {
            return false;
        }
        return referenceTime - this.startedAt > this.timeoutMs;
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    private assertMutable(): void {
        if (this.frozen) {
            throw new Error(`ExecutionTask '${this.id}' is frozen and cannot be modified.`);
        }
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    /**
     * Transitions to `state`, validating the move against
     * `LEGAL_EXECUTION_TRANSITIONS` before applying it. Throws rather than
     * silently accepting an illegal transition.
     */
    setState(state: ExecutionState, reason?: string): this {
        this.assertMutable();

        if (this.state === state) {
            return this;
        }

        const allowed = LEGAL_EXECUTION_TRANSITIONS.get(this.state) ?? new Set();
        if (!allowed.has(state)) {
            throw new Error(
                `Illegal execution state transition for task '${this.id}': '${this.state}' -> '${state}'.`
            );
        }

        this.history.push({ from: this.state, to: state, timestamp: Date.now(), reason });
        this.state = state;
        this.touch();
        return this;
    }

    markWaiting(): this {
        return this.setState(ExecutionState.Waiting);
    }

    markReady(): this {
        return this.setState(ExecutionState.Ready);
    }

    recordDispatch(): this {
        return this.setState(ExecutionState.Dispatched);
    }

    recordStart(): this {
        this.assertMutable();
        this.attempt++;
        this.startedAt = Date.now();
        return this.setState(ExecutionState.Running);
    }

    recordSuccess(output?: JsonValue): this {
        this.assertMutable();
        this.output = output;
        this.error = undefined;
        this.finishedAt = Date.now();
        return this.setState(ExecutionState.Completed);
    }

    recordFailure(error: string): this {
        this.assertMutable();
        this.error = error;
        this.finishedAt = Date.now();
        return this.setState(ExecutionState.Failed, error);
    }

    recordTimeout(): this {
        this.assertMutable();
        this.error = `Task '${this.id}' exceeded its timeout of ${this.timeoutMs ?? 0}ms.`;
        this.finishedAt = Date.now();
        return this.setState(ExecutionState.TimedOut, "timeout");
    }

    recordCancellation(reason: CancellationReason): this {
        this.assertMutable();
        this.cancellationReason = reason;
        this.finishedAt = Date.now();
        return this.setState(ExecutionState.Cancelled, reason);
    }

    recordSkip(reason: string): this {
        this.assertMutable();
        this.finishedAt = Date.now();
        return this.setState(ExecutionState.Skipped, reason);
    }

    recordRollback(): this {
        return this.setState(ExecutionState.RolledBack, "rollback");
    }

    /** Resets error state and transitions to `Retrying`, ahead of being re-readied. */
    prepareRetry(): this {
        this.assertMutable();
        this.error = undefined;
        return this.setState(ExecutionState.Retrying, "retry-scheduled");
    }

    assignReservation(reservationId: string): this {
        this.assertMutable();
        if (!this.resourceReservationIds.includes(reservationId)) {
            this.resourceReservationIds.push(reservationId);
            this.touch();
        }
        return this;
    }

    freeze(): this {
        this.frozen = true;
        return this;
    }

    unfreeze(): this {
        this.frozen = false;
        return this;
    }

    validate(): boolean {
        if (this.id.length === 0 || this.planId.length === 0) {
            return false;
        }
        if (this.attempt < 0 || this.maxAttempts < 0) {
            return false;
        }
        if (this.finishedAt !== undefined && this.startedAt !== undefined && this.finishedAt < this.startedAt) {
            return false;
        }
        return true;
    }

    serialize(): ExecutionRecord {
        return {
            taskId: this.id,
            planId: this.planId,
            state: this.state,
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            timeoutMs: this.timeoutMs,
            output: this.output,
            error: this.error,
            cancellationReason: this.cancellationReason,
            resourceReservationIds: [...this.resourceReservationIds],
            history: structuredClone(this.history),
            createdAt: this.created,
            updatedAt: this.updated
        };
    }

    clone(): ExecutionTask {
        return new ExecutionTask(this.serialize());
    }

    describe(): string {
        return [
            `ExecutionTask(${this.id})`,
            `state=${this.state}`,
            `attempt=${this.attempt}/${this.maxAttempts}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            planId: this.planId,
            state: this.state,
            attempt: this.attempt,
            maxAttempts: this.maxAttempts,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            durationMs: this.getDurationMs(),
            error: this.error,
            resourceReservations: this.resourceReservationIds.length,
            frozen: this.frozen
        };
    }
}

/* =============================================================================
 * Execution Queue
 * =============================================================================
 *
 * Tracks dependency-driven readiness over a fixed set of task ids, mirroring
 * the bucket/counter pattern `PlannerConcurrencyAllocator` (planner-
 * scheduler.ts) uses internally, but stateful and incremental rather than a
 * one-shot computation: readiness here reacts to *real* completions
 * (`markResolved`) arriving over time, not to estimated durations.
 */

export class ExecutionQueue {

    private readonly remainingDependencies = new Map<TaskId, number>();
    private readonly dependentsOf = new Map<TaskId, Set<TaskId>>();
    private readonly ready: TaskId[] = [];
    private readonly readySet = new Set<TaskId>();
    private readonly enqueued = new Set<TaskId>();

    constructor() {}

    /**
     * Seeds the queue from a dependency graph: every task with zero
     * unresolved dependencies becomes immediately ready; every other task
     * waits until `markResolved` has been called for each of its
     * dependencies.
     */
    seed(taskIds: readonly TaskId[], graph: PlannerDependencyGraph): void {
        for (const taskId of taskIds) {
            this.enqueued.add(taskId);
            this.remainingDependencies.set(taskId, graph.dependencies(taskId).size);
            this.dependentsOf.set(taskId, new Set(graph.dependents(taskId)));
        }

        for (const taskId of taskIds) {
            if ((this.remainingDependencies.get(taskId) ?? 0) === 0) {
                this.pushReady(taskId);
            }
        }
    }

    private pushReady(taskId: TaskId): void {
        if (this.readySet.has(taskId)) {
            return;
        }
        this.ready.push(taskId);
        this.readySet.add(taskId);
    }

    /** Re-admits a task (e.g. after a retry delay) directly to the ready set, bypassing dependency counting. */
    requeue(taskId: TaskId): void {
        this.pushReady(taskId);
    }

    hasReady(): boolean {
        return this.ready.length > 0;
    }

    peekReady(): readonly TaskId[] {
        return [...this.ready];
    }

    /** Removes and returns up to `count` ready task ids, FIFO order. */
    dequeueReady(count: number): TaskId[] {
        const taken = this.ready.splice(0, Math.max(0, count));
        for (const taskId of taken) {
            this.readySet.delete(taskId);
        }
        return taken;
    }

    /**
     * Marks `taskId` as resolved (completed, skipped, or otherwise no
     * longer blocking its dependents), decrementing the remaining-
     * dependency count of every dependent and promoting any dependent that
     * reaches zero to ready. Returns the ids newly promoted by this call.
     */
    markResolved(taskId: TaskId): TaskId[] {
        const promoted: TaskId[] = [];
        for (const dependent of this.dependentsOf.get(taskId) ?? new Set()) {
            const remaining = (this.remainingDependencies.get(dependent) ?? 0) - 1;
            this.remainingDependencies.set(dependent, Math.max(0, remaining));
            if (remaining <= 0) {
                this.pushReady(dependent);
                promoted.push(dependent);
            }
        }
        return promoted;
    }

    /** Removes `taskId` from the ready set without resolving it, e.g. because it is being skipped/cancelled. */
    discard(taskId: TaskId): void {
        const index = this.ready.indexOf(taskId);
        if (index >= 0) {
            this.ready.splice(index, 1);
            this.readySet.delete(taskId);
        }
    }

    remainingDependencyCount(taskId: TaskId): number {
        return this.remainingDependencies.get(taskId) ?? 0;
    }

    isEnqueued(taskId: TaskId): boolean {
        return this.enqueued.has(taskId);
    }

    size(): number {
        return this.enqueued.size;
    }

    readyCount(): number {
        return this.ready.length;
    }

    clear(): void {
        this.remainingDependencies.clear();
        this.dependentsOf.clear();
        this.ready.length = 0;
        this.readySet.clear();
        this.enqueued.clear();
    }

    describe(): string {
        return ["ExecutionQueue", `enqueued=${this.enqueued.size}`, `ready=${this.ready.length}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            enqueued: this.enqueued.size,
            ready: this.ready.length
        };
    }
}

/* =============================================================================
 * Retry Manager
 * =============================================================================
 */

export class RetryManager {

    private readonly backoff: RetryBackoffStrategy;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;

    private retries = 0;

    constructor(
        backoff: RetryBackoffStrategy = RetryBackoffStrategy.ExponentialJitter,
        baseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
        maxDelayMs: number = DEFAULT_RETRY_MAX_DELAY_MS
    ) {
        this.backoff = backoff;
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = maxDelayMs;
    }

    shouldRetry(task: ExecutionTask): boolean {
        return task.canRetry();
    }

    /** Computes the delay before the next attempt, in milliseconds. */
    computeDelayMs(attempt: number): number {
        const clampedAttempt = Math.max(0, attempt);

        let delay: number;
        switch (this.backoff) {
            case RetryBackoffStrategy.Fixed:
                delay = this.baseDelayMs;
                break;
            case RetryBackoffStrategy.Linear:
                delay = this.baseDelayMs * (clampedAttempt + 1);
                break;
            case RetryBackoffStrategy.Exponential:
                delay = this.baseDelayMs * Math.pow(2, clampedAttempt);
                break;
            case RetryBackoffStrategy.ExponentialJitter:
            default: {
                const exponential = this.baseDelayMs * Math.pow(2, clampedAttempt);
                delay = exponential / 2 + Math.random() * (exponential / 2);
                break;
            }
        }

        return Math.min(this.maxDelayMs, Math.max(0, delay));
    }

    /** Marks a task for retry, incrementing internal counters and returning the delay to wait before redispatch. */
    scheduleRetry(task: ExecutionTask): number {
        this.retries++;
        const delay = this.computeDelayMs(task.getAttempt());
        task.prepareRetry();
        return delay;
    }

    retryCount(): number {
        return this.retries;
    }

    reset(): void {
        this.retries = 0;
    }

    describe(): string {
        return ["RetryManager", `backoff=${this.backoff}`, `retries=${this.retries}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            backoff: this.backoff,
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxDelayMs,
            retries: this.retries
        };
    }
}

/* =============================================================================
 * Execution Rollback Manager
 * =============================================================================
 *
 * Executes a `RollbackPlan` (built by planner.ts's `PlannerRollbackManager`)
 * against real `ExecutionTask`s. `PlannerRollbackManager` decides *what*
 * should be undone and in what order; this manager is the one that actually
 * calls a handler's `rollback` hook and records the outcome, mirroring the
 * "planner.ts decides, executor.ts does" split this module maintains for
 * scheduling and recovery too.
 */

export class ExecutionRollbackManager {

    private rollbacksExecuted = 0;

    constructor() {}

    /**
     * Walks `plan.checkpointTaskIds` (already reverse-ordered by
     * `PlannerRollbackManager.build`) and, for each task that reached
     * `Completed`, invokes the handler's optional `rollback` hook before
     * marking it `RolledBack`. A task with no completed record, or whose
     * handler defines no `rollback`, is left untouched — a task that never
     * ran has nothing to undo, and a handler that cannot undo a task is
     * expected to say so structurally rather than this manager guessing at
     * a no-op.
     */
    async execute(
        plan: RollbackPlan,
        tasksById: ReadonlyMap<TaskId, ExecutionTask>,
        taskDefinitionsById: ReadonlyMap<TaskId, Task>,
        handler: TaskExecutionHandler,
        isCancelled: () => boolean = () => false
    ): Promise<TaskId[]> {
        if (plan.policy === RollbackPolicy.None) {
            return [];
        }

        const rolledBack: TaskId[] = [];

        for (const taskId of plan.checkpointTaskIds) {
            if (isCancelled()) {
                break;
            }

            const executionTask = tasksById.get(taskId);
            const definition = taskDefinitionsById.get(taskId);

            if (!executionTask || !definition || executionTask.getState() !== ExecutionState.Completed) {
                continue;
            }

            if (handler.rollback) {
                await handler.rollback(definition, {
                    planId: executionTask.planId,
                    taskId,
                    attempt: executionTask.getAttempt(),
                    maxAttempts: executionTask.getMaxAttempts(),
                    startedAt: executionTask.getStartedAt() ?? Date.now(),
                    metadata: structuredClone(definition.metadata ?? {}),
                    isCancelled
                });
            }

            executionTask.recordRollback();
            rolledBack.push(taskId);
            this.rollbacksExecuted++;
        }

        return rolledBack;
    }

    rollbackCount(): number {
        return this.rollbacksExecuted;
    }

    reset(): void {
        this.rollbacksExecuted = 0;
    }

    describe(): string {
        return ["ExecutionRollbackManager", `rollbacks=${this.rollbacksExecuted}`].join(", ");
    }

    inspect(): Dictionary {
        return { rollbacksExecuted: this.rollbacksExecuted };
    }
}

/* =============================================================================
 * Execution Recovery Manager
 * =============================================================================
 *
 * Decides what should happen to a task that has exhausted its retry budget,
 * given the plan's configured `RecoveryStrategy` (planner.ts). This manager
 * only *decides* — it never itself retries, skips, aborts, or rolls
 * anything back; `ExecutionDispatcher` carries out the returned
 * `RecoveryAction` using `RetryManager` / `ExecutionRollbackManager` / its
 * own cancellation path, consistent with this module's "decision engines
 * decide, managers act" separation.
 */

export class ExecutionRecoveryManager {

    private recoveriesTriggered = 0;

    constructor() {}

    /**
     * `RecoveryStrategy.Substitute` has no direct executor-level
     * equivalent — finding or building a substitute task is a planning
     * concern this module has no authority over — so it is translated to
     * `Escalate`: the caller is expected to surface the failure to
     * whatever upstream policy is responsible for supplying a substitute
     * plan or task.
     */
    determineAction(strategy: RecoveryStrategy, task: ExecutionTask): RecoveryAction {
        this.recoveriesTriggered++;

        switch (strategy) {
            case RecoveryStrategy.Retry:
                return task.getAttempt() < task.getMaxAttempts() ? RecoveryAction.Retry : RecoveryAction.Escalate;
            case RecoveryStrategy.Skip:
                return RecoveryAction.Skip;
            case RecoveryStrategy.Substitute:
                return RecoveryAction.Escalate;
            case RecoveryStrategy.Escalate:
                return RecoveryAction.Escalate;
            case RecoveryStrategy.Compensate:
                return RecoveryAction.Compensate;
            case RecoveryStrategy.Abort:
            default:
                return RecoveryAction.Abort;
        }
    }

    recoveryCount(): number {
        return this.recoveriesTriggered;
    }

    reset(): void {
        this.recoveriesTriggered = 0;
    }

    describe(): string {
        return ["ExecutionRecoveryManager", `recoveries=${this.recoveriesTriggered}`].join(", ");
    }

    inspect(): Dictionary {
        return { recoveriesTriggered: this.recoveriesTriggered };
    }
}

/* =============================================================================
 * Execution Monitor
 * =============================================================================
 *
 * Stateless (beyond an invocation counter) progress aggregation over a set
 * of `ExecutionTask`s. Never mutates its inputs.
 */

export class ExecutionMonitor {

    private observations = 0;

    constructor() {}

    snapshot(
        planId: PlanId,
        tasks: readonly ExecutionTask[],
        startedAt: Timestamp,
        referenceTime: Timestamp = Date.now()
    ): ExecutionProgress {
        this.observations++;

        const total = tasks.length;
        const completed = tasks.filter(task => task.getState() === ExecutionState.Completed).length;
        const failed = tasks.filter(
            task => task.getState() === ExecutionState.Failed || task.getState() === ExecutionState.TimedOut
        ).length;
        const skipped = tasks.filter(task => task.getState() === ExecutionState.Skipped).length;
        const cancelled = tasks.filter(task => task.getState() === ExecutionState.Cancelled).length;
        const running = tasks.filter(task => task.isActive()).length;
        const resolved = completed + failed + skipped + cancelled;
        const pending = Math.max(0, total - resolved - running);

        const elapsedMs = Math.max(0, referenceTime - startedAt);
        const percentComplete = total > 0 ? clampFraction(resolved / total) : 0;

        let estimatedRemainingMs: number | undefined;
        if (resolved > 0 && resolved < total) {
            const averagePerTask = elapsedMs / resolved;
            estimatedRemainingMs = Math.max(0, averagePerTask * (total - resolved));
        }

        return {
            planId,
            totalTasks: total,
            completedTasks: completed,
            failedTasks: failed,
            skippedTasks: skipped,
            cancelledTasks: cancelled,
            runningTasks: running,
            pendingTasks: pending,
            percentComplete,
            elapsedMs,
            estimatedRemainingMs,
            computedAt: referenceTime
        };
    }

    observationCount(): number {
        return this.observations;
    }

    reset(): void {
        this.observations = 0;
    }

    describe(): string {
        return ["ExecutionMonitor", `observations=${this.observations}`].join(", ");
    }

    inspect(): Dictionary {
        return { observations: this.observations };
    }
}

/* =============================================================================
 * Execution Snapshot Manager
 * =============================================================================
 */

export class ExecutionSnapshotManager {

    private readonly snapshots = new Map<string, ExecutorSnapshot>();
    private readonly history: string[] = [];
    private readonly capacity: number;

    constructor(capacity: number = DEFAULT_EXECUTOR_SNAPSHOT_CAPACITY) {
        if (capacity <= 0) {
            throw new RangeError("Snapshot capacity must be greater than zero.");
        }
        this.capacity = capacity;
    }

    create(contexts: readonly ExecutionContextSnapshot[]): ExecutorSnapshot {
        const snapshot: ExecutorSnapshot = {
            id: generateId("xsnap"),
            timestamp: Date.now(),
            version: EXECUTOR_FORMAT_VERSION,
            contexts: structuredClone([...contexts])
        };

        this.snapshots.set(snapshot.id, structuredClone(snapshot));
        this.history.push(snapshot.id);

        while (this.history.length > this.capacity) {
            const oldest = this.history.shift();
            if (oldest !== undefined) {
                this.snapshots.delete(oldest);
            }
        }

        return structuredClone(snapshot);
    }

    get(id: string): Optional<ExecutorSnapshot> {
        const snapshot = this.snapshots.get(id);
        return snapshot ? structuredClone(snapshot) : undefined;
    }

    latest(): Optional<ExecutorSnapshot> {
        const id = this.history.at(-1);
        return id ? this.get(id) : undefined;
    }

    remove(id: string): boolean {
        const index = this.history.indexOf(id);
        if (index >= 0) {
            this.history.splice(index, 1);
        }
        return this.snapshots.delete(id);
    }

    clear(): void {
        this.snapshots.clear();
        this.history.length = 0;
    }

    size(): number {
        return this.snapshots.size;
    }

    ids(): readonly string[] {
        return [...this.history];
    }

    describe(): string {
        return ["ExecutionSnapshotManager", `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(", ");
    }

    inspect(): Dictionary {
        return { size: this.size(), capacity: this.capacity, history: [...this.history] };
    }
}

/* =============================================================================
 * Execution Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over an `ExecutionContext`. Every
 * `validate*` method only inspects state; none of them mutate the context
 * or repair inconsistencies, matching every sibling module's "diagnostics
 * observe only" rule.
 */

export class ExecutionDiagnostics {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validateTaskInvariants(context: ExecutionContext): boolean {
        this.checks++;
        const valid = context.allTasks().every(task => task.validate());
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateConcurrency(context: ExecutionContext): boolean {
        this.checks++;
        const active = context.allTasks().filter(task => task.isActive()).length;
        const valid = active <= context.getMaxConcurrency();
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    /**
     * Referential-integrity check: every `ExecutionTask` must correspond to
     * a task id known to the context's own plan. This never repairs the
     * reference — it only reports it.
     */
    findOrphanedTasks(context: ExecutionContext): TaskId[] {
        this.checks++;
        const orphaned = context.allTasks()
            .filter(task => !context.hasTaskDefinition(task.id))
            .map(task => task.id);

        if (orphaned.length > 0) {
            this.failures++;
        }
        return orphaned;
    }

    validateTerminalConsistency(context: ExecutionContext): boolean {
        this.checks++;
        const valid =
            context.getPhase() !== ExecutionPhase.Completed ||
            context.allTasks().every(task => task.isTerminal());

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    runAll(context: ExecutionContext): boolean {
        const orphaned = this.findOrphanedTasks(context);
        return (
            this.validateTaskInvariants(context) &&
            this.validateConcurrency(context) &&
            this.validateTerminalConsistency(context) &&
            orphaned.length === 0
        );
    }

    checksPerformed(): number {
        return this.checks;
    }

    failuresDetected(): number {
        return this.failures;
    }

    successRate(): number {
        if (this.checks === 0) {
            return 1;
        }
        return (this.checks - this.failures) / this.checks;
    }

    reset(): void {
        this.checks = 0;
        this.failures = 0;
    }

    describe(): string {
        return [
            "ExecutionDiagnostics",
            `checks=${this.checks}`,
            `failures=${this.failures}`,
            `success=${this.successRate()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            checks: this.checks,
            failures: this.failures,
            successRate: this.successRate()
        };
    }
}

/* =============================================================================
 * Execution Context
 * =============================================================================
 *
 * A single mutable, encapsulated execution run for one `Plan`. Owns the
 * canonical `TaskId -> ExecutionTask` map, the `ExecutionQueue` driving
 * dependency-based readiness, and the plan-derived policy (concurrency
 * limit, partial-failure tolerance, rollback policy, recovery strategy)
 * that `ExecutionDispatcher` consults while running it.
 */

export class ExecutionContext {

    public readonly planId: PlanId;

    private readonly taskDefinitionsById: Map<TaskId, Task>;
    private executionTasksById: Map<TaskId, ExecutionTask>;
    private readonly graph: PlannerDependencyGraph;
    private readonly queue: ExecutionQueue;

    private phase: ExecutionPhase = ExecutionPhase.Idle;
    private cancelled = false;
    private cancellationReason?: CancellationReason;
    private paused = false;

    private readonly maxConcurrency: number;
    private readonly allowPartialFailure: boolean;
    private readonly rollbackPolicy: RollbackPolicy;
    private readonly recoveryStrategy: RecoveryStrategy;

    private readonly startedAt: Timestamp;
    private finishedAt?: Timestamp;

    constructor(
        planId: PlanId,
        tasks: readonly Task[],
        graph: PlannerDependencyGraph,
        executionPolicy: ExecutionPolicyDefinition,
        rollbackPolicy: RollbackPolicy,
        recoveryStrategy: RecoveryStrategy,
        defaultMaxRetries: number
    ) {
        this.planId = planId;
        this.taskDefinitionsById = new Map(tasks.map(task => [task.id, task]));
        this.graph = graph;
        this.queue = new ExecutionQueue();
        this.queue.seed(tasks.map(task => task.id), graph);

        this.executionTasksById = new Map(
            tasks.map(task => [
                task.id,
                ExecutionTask.create(task.id, planId, task.maxRetries || defaultMaxRetries, executionPolicy.timeoutMs)
            ])
        );

        for (const [taskId, executionTask] of this.executionTasksById) {
            if (this.queue.remainingDependencyCount(taskId) === 0) {
                executionTask.markReady();
            } else {
                executionTask.markWaiting();
            }
        }

        this.maxConcurrency = Math.max(1, executionPolicy.maxConcurrency);
        this.allowPartialFailure = executionPolicy.allowPartialFailure;
        this.rollbackPolicy = rollbackPolicy;
        this.recoveryStrategy = recoveryStrategy;
        this.startedAt = Date.now();
    }

    getPhase(): ExecutionPhase {
        return this.phase;
    }

    setPhase(phase: ExecutionPhase): void {
        this.phase = phase;
        if (
            phase === ExecutionPhase.Completed ||
            phase === ExecutionPhase.Failed ||
            phase === ExecutionPhase.Cancelled
        ) {
            this.finishedAt = this.finishedAt ?? Date.now();
        }
    }

    getMaxConcurrency(): number {
        return this.maxConcurrency;
    }

    getAllowPartialFailure(): boolean {
        return this.allowPartialFailure;
    }

    getRollbackPolicy(): RollbackPolicy {
        return this.rollbackPolicy;
    }

    getRecoveryStrategy(): RecoveryStrategy {
        return this.recoveryStrategy;
    }

    getStartedAt(): Timestamp {
        return this.startedAt;
    }

    getFinishedAt(): Optional<Timestamp> {
        return this.finishedAt;
    }

    getQueue(): ExecutionQueue {
        return this.queue;
    }

    getGraph(): PlannerDependencyGraph {
        return this.graph;
    }

    getTaskDefinition(taskId: TaskId): Optional<Task> {
        return this.taskDefinitionsById.get(taskId);
    }

    requireTaskDefinition(taskId: TaskId): Task {
        const task = this.taskDefinitionsById.get(taskId);
        if (!task) {
            throw new Error(`Task definition '${taskId}' is not part of plan '${this.planId}'.`);
        }
        return task;
    }

    hasTaskDefinition(taskId: TaskId): boolean {
        return this.taskDefinitionsById.has(taskId);
    }

    allTaskDefinitions(): Task[] {
        return [...this.taskDefinitionsById.values()];
    }

    getExecutionTask(taskId: TaskId): Optional<ExecutionTask> {
        return this.executionTasksById.get(taskId);
    }

    requireExecutionTask(taskId: TaskId): ExecutionTask {
        const task = this.executionTasksById.get(taskId);
        if (!task) {
            throw new Error(`Execution task '${taskId}' does not exist in plan '${this.planId}'.`);
        }
        return task;
    }

    allTasks(): ExecutionTask[] {
        return [...this.executionTasksById.values()];
    }

    where(predicate: Predicate<ExecutionTask>): ExecutionTask[] {
        return this.allTasks().filter(predicate);
    }

    isCancelled(): boolean {
        return this.cancelled;
    }

    getCancellationReason(): Optional<CancellationReason> {
        return this.cancellationReason;
    }

    requestCancellation(reason: CancellationReason): void {
        this.cancelled = true;
        this.cancellationReason = this.cancellationReason ?? reason;
    }

    isPaused(): boolean {
        return this.paused;
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
    }

    isComplete(): boolean {
        return this.allTasks().every(task => task.isTerminal());
    }

    hasUnresolvedFailures(): boolean {
        return this.allTasks().some(
            task => task.getState() === ExecutionState.Failed || task.getState() === ExecutionState.TimedOut
        );
    }

    serializeRecords(): ExecutionRecord[] {
        return this.allTasks().map(task => task.serialize());
    }

    /**
     * Replaces every `ExecutionTask` whose id appears in `records` with a
     * freshly-reconstructed instance, and resynchronizes the queue's
     * readiness bookkeeping to match (any task recorded as resolved is
     * treated as resolved for its dependents too). Intended to be called
     * at most once, immediately after construction and before any dispatch
     * has begun — calling it again mid-run would double-resolve dependents
     * already unblocked by the first call.
     */
    restoreRecords(records: readonly ExecutionRecord[]): void {
        for (const record of records) {
            if (this.taskDefinitionsById.has(record.taskId)) {
                this.executionTasksById.set(record.taskId, new ExecutionTask(record));
            }
        }

        for (const task of this.executionTasksById.values()) {
            if (task.isTerminal() && task.getState() !== ExecutionState.Cancelled) {
                this.queue.markResolved(task.id);
                this.queue.discard(task.id);
            }
        }
    }

    describe(): string {
        return [
            `ExecutionContext(${this.planId})`,
            `phase=${this.phase}`,
            `tasks=${this.executionTasksById.size}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            planId: this.planId,
            phase: this.phase,
            cancelled: this.cancelled,
            paused: this.paused,
            maxConcurrency: this.maxConcurrency,
            allowPartialFailure: this.allowPartialFailure,
            tasks: this.executionTasksById.size,
            queue: this.queue.inspect()
        };
    }
}

/* =============================================================================
 * Execution Dispatcher
 * =============================================================================
 *
 * Drives a single `ExecutionContext` to completion: dispatches ready tasks
 * to a `TaskExecutionHandler` bounded by the context's concurrency limit,
 * enforces per-task timeouts, and applies retry/recovery decisions as
 * outcomes arrive. This class contains all of the module's actual
 * concurrency/timeout/async-orchestration logic; `ExecutorManager` only
 * owns *which* contexts exist and delegates running them here.
 */

export class ExecutionDispatcher {

    private readonly retryManager: RetryManager;
    private readonly recoveryManager: ExecutionRecoveryManager;

    private dispatchCount = 0;
    private totalDispatchTimeMs = 0;

    constructor(retryManager: RetryManager, recoveryManager: ExecutionRecoveryManager) {
        this.retryManager = retryManager;
        this.recoveryManager = recoveryManager;
    }

    /**
     * Runs `context` to completion. Returns the ids of every task that
     * ended in a non-recovered failed/timed-out state (i.e. recovery
     * determined `Escalate`, `Compensate`, or `Abort` for it).
     */
    async run(
        context: ExecutionContext,
        handler: TaskExecutionHandler,
        emit: (event: ExecutionEvent, payload: Dictionary) => void,
        resources?: ResourceManager,
        constraints?: PlannerConstraintManager
    ): Promise<TaskId[]> {
        const inFlight = new Map<TaskId, Promise<{ taskId: TaskId; outcome: "success" | "failure" | "timeout" }>>();
        const pendingRetries: Array<{ taskId: TaskId; readyAt: Timestamp }> = [];
        const unresolvedFailures: TaskId[] = [];

        const skipDependents = (taskId: TaskId, reason: string): void => {
            for (const dependentId of context.getGraph().dependents(taskId)) {
                const dependentTask = context.getExecutionTask(dependentId);
                if (!dependentTask || dependentTask.isTerminal() || dependentTask.isActive()) {
                    continue;
                }
                context.getQueue().discard(dependentId);
                dependentTask.recordSkip(reason);
                emit(ExecutionEvent.TaskSkipped, { planId: context.planId, taskId: dependentId, reason });
                skipDependents(dependentId, reason);
            }
        };

        while (!context.isComplete()) {
            if (context.isCancelled()) {
                break;
            }

            if (context.isPaused()) {
                await sleep(25);
                continue;
            }

            const now = Date.now();
            for (let i = pendingRetries.length - 1; i >= 0; i--) {
                if (pendingRetries[i].readyAt <= now) {
                    const [due] = pendingRetries.splice(i, 1);
                    context.getExecutionTask(due.taskId)?.markReady();
                    context.getQueue().requeue(due.taskId);
                }
            }

            const availableSlots = context.getMaxConcurrency() - inFlight.size;

            if (availableSlots > 0 && context.getQueue().hasReady()) {
                const readyIds = context.getQueue().dequeueReady(availableSlots);

                for (const taskId of readyIds) {
                    const executionTask = context.requireExecutionTask(taskId);
                    const definition = context.requireTaskDefinition(taskId);

                    if (constraints) {
                        const issues = constraints.evaluateTask(new PlannerTask(definition), { resources });
                        const hardFailure = issues.some(
                            issue => issue.severity === RiskLevel.Severe || issue.severity === RiskLevel.High
                        );
                        if (hardFailure) {
                            executionTask.recordFailure(`Task '${taskId}' failed pre-dispatch constraint evaluation.`);
                            emit(ExecutionEvent.TaskFailed, { planId: context.planId, taskId });
                            unresolvedFailures.push(taskId);
                            skipDependents(taskId, `Upstream task '${taskId}' failed constraint evaluation.`);
                            continue;
                        }
                    }

                    if (resources && definition.resourceRequirements.length > 0) {
                        try {
                            const reservations = resources.reserveForRequirements(definition.resourceRequirements, taskId);
                            for (const reservation of reservations) {
                                executionTask.assignReservation(reservation.id);
                            }
                        } catch (error) {
                            executionTask.recordFailure(error instanceof Error ? error.message : String(error));
                            emit(ExecutionEvent.TaskFailed, { planId: context.planId, taskId });
                            unresolvedFailures.push(taskId);
                            skipDependents(taskId, `Upstream task '${taskId}' failed resource reservation.`);
                            continue;
                        }
                    }

                    executionTask.recordDispatch();
                    emit(ExecutionEvent.TaskDispatched, { planId: context.planId, taskId });
                    inFlight.set(taskId, this.dispatchOne(context, executionTask, definition, handler, emit));
                }
            }

            if (inFlight.size === 0) {
                if (!context.getQueue().hasReady() && pendingRetries.length === 0) {
                    break;
                }
                await sleep(10);
                continue;
            }

            const settled = await Promise.race(inFlight.values());
            inFlight.delete(settled.taskId);

            const executionTask = context.requireExecutionTask(settled.taskId);
            this.releaseResources(executionTask, resources);

            if (settled.outcome === "success") {
                context.getQueue().markResolved(settled.taskId);
                emit(ExecutionEvent.TaskCompleted, { planId: context.planId, taskId: settled.taskId });
                continue;
            }

            if (this.retryManager.shouldRetry(executionTask)) {
                const delayMs = this.retryManager.scheduleRetry(executionTask);
                pendingRetries.push({ taskId: settled.taskId, readyAt: Date.now() + delayMs });
                emit(ExecutionEvent.TaskRetried, { planId: context.planId, taskId: settled.taskId, delayMs });
                continue;
            }

            const action = this.recoveryManager.determineAction(context.getRecoveryStrategy(), executionTask);
            emit(ExecutionEvent.RecoveryTriggered, { planId: context.planId, taskId: settled.taskId, action });

            switch (action) {
                case RecoveryAction.Retry: {
                    const delayMs = this.retryManager.scheduleRetry(executionTask);
                    pendingRetries.push({ taskId: settled.taskId, readyAt: Date.now() + delayMs });
                    break;
                }

                case RecoveryAction.Skip:
                    executionTask.recordSkip("Recovery strategy: skip.");
                    emit(ExecutionEvent.TaskSkipped, { planId: context.planId, taskId: settled.taskId });
                    context.getQueue().markResolved(settled.taskId);
                    break;

                case RecoveryAction.Compensate:
                case RecoveryAction.Escalate:
                case RecoveryAction.Abort:
                default:
                    unresolvedFailures.push(settled.taskId);
                    skipDependents(settled.taskId, `Upstream task '${settled.taskId}' failed.`);
                    if (action === RecoveryAction.Abort || !context.getAllowPartialFailure()) {
                        context.requestCancellation(CancellationReason.DependencyFailed);
                    }
                    break;
            }
        }

        if (inFlight.size > 0) {
            await Promise.allSettled(inFlight.values());
        }

        return unresolvedFailures;
    }

    private async dispatchOne(
        context: ExecutionContext,
        executionTask: ExecutionTask,
        definition: Task,
        handler: TaskExecutionHandler,
        emit: (event: ExecutionEvent, payload: Dictionary) => void
    ): Promise<{ taskId: TaskId; outcome: "success" | "failure" | "timeout" }> {
        const started = performance.now();
        this.dispatchCount++;

        executionTask.recordStart();
        emit(ExecutionEvent.TaskStarted, { planId: context.planId, taskId: executionTask.id });

        const runtimeContext: ExecutionRuntimeContext = {
            planId: context.planId,
            taskId: executionTask.id,
            attempt: executionTask.getAttempt(),
            maxAttempts: executionTask.getMaxAttempts(),
            startedAt: executionTask.getStartedAt() ?? Date.now(),
            metadata: structuredClone(definition.metadata ?? {}),
            isCancelled: () => context.isCancelled()
        };

        try {
            const timeoutMs = executionTask.getTimeoutMs();
            const outcome = timeoutMs !== undefined
                ? await this.withTimeout(handler.execute(definition, runtimeContext), timeoutMs)
                : await handler.execute(definition, runtimeContext);

            this.totalDispatchTimeMs += performance.now() - started;

            if (outcome.success) {
                executionTask.recordSuccess(outcome.output);
                return { taskId: executionTask.id, outcome: "success" };
            }

            executionTask.recordFailure(outcome.error ?? `Task '${executionTask.id}' reported failure.`);
            emit(ExecutionEvent.TaskFailed, { planId: context.planId, taskId: executionTask.id });
            return { taskId: executionTask.id, outcome: "failure" };
        } catch (error) {
            this.totalDispatchTimeMs += performance.now() - started;

            if (error instanceof ExecutionTimeoutError) {
                executionTask.recordTimeout();
                emit(ExecutionEvent.TaskTimedOut, { planId: context.planId, taskId: executionTask.id });
                return { taskId: executionTask.id, outcome: "timeout" };
            }

            executionTask.recordFailure(error instanceof Error ? error.message : String(error));
            emit(ExecutionEvent.TaskFailed, { planId: context.planId, taskId: executionTask.id });
            return { taskId: executionTask.id, outcome: "failure" };
        }
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        let timer!: ReturnType<typeof setTimeout>;
        const timeout = new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new ExecutionTimeoutError(timeoutMs)), timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    private releaseResources(executionTask: ExecutionTask, resources?: ResourceManager): void {
        if (!resources) {
            return;
        }
        for (const reservationId of executionTask.getResourceReservationIds()) {
            try {
                resources.releaseReservation(reservationId);
            } catch {
                // Already released or converted to an allocation elsewhere;
                // nothing further for this manager to do.
            }
        }
    }

    dispatchCountValue(): number {
        return this.dispatchCount;
    }

    averageDispatchTimeMs(): number {
        return this.dispatchCount > 0 ? this.totalDispatchTimeMs / this.dispatchCount : 0;
    }

    reset(): void {
        this.dispatchCount = 0;
        this.totalDispatchTimeMs = 0;
    }

    describe(): string {
        return ["ExecutionDispatcher", `dispatched=${this.dispatchCount}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            dispatched: this.dispatchCount,
            averageDispatchTimeMs: this.averageDispatchTimeMs()
        };
    }
}

/* =============================================================================
 * Executor Manager
 * =============================================================================
 *
 * The single public façade over the execution subsystem. Owns the
 * canonical `PlanId -> ExecutionContext` map, an `ExecutionDispatcher`, a
 * `RetryManager`, an `ExecutionRollbackManager`, an `ExecutionRecoveryManager`,
 * an `ExecutionMonitor`, an `ExecutionSnapshotManager`, and an
 * `ExecutionDiagnostics` instance.
 *
 * `ExecutorManager` never plans, schedules, or manages constraints/
 * resources itself; it only orchestrates the execution of an already-built
 * `Plan` against an already-built `PlannerSchedule`, delegating every
 * side effect to an injected `TaskExecutionHandler`.
 */

export class ExecutorManager {

    private readonly contexts = new Map<PlanId, ExecutionContext>();

    private readonly configuration: ExecutorConfiguration;

    private readonly retryManager: RetryManager;
    private readonly rollbackManager = new ExecutionRollbackManager();
    private readonly recoveryManager = new ExecutionRecoveryManager();
    private readonly dispatcher: ExecutionDispatcher;
    private readonly monitor = new ExecutionMonitor();
    private readonly snapshotManager: ExecutionSnapshotManager;
    private readonly diagnostics = new ExecutionDiagnostics();

    private readonly observers = new Set<ExecutorObserver>();

    private totalExecutions = 0;
    private completedExecutions = 0;
    private failedExecutions = 0;
    private cancelledExecutions = 0;

    private readonly metrics: ExecutorMetrics = {
        lastDispatchCycleMs: 0,
        averageDispatchLatencyMs: 0,
        lastComputedAt: Date.now()
    };

    constructor(configuration: Partial<ExecutorConfiguration> = {}) {
        this.configuration = Object.freeze({
            ...DEFAULT_EXECUTOR_CONFIGURATION,
            ...configuration
        });
        this.retryManager = new RetryManager(
            this.configuration.retryBackoff,
            this.configuration.retryBaseDelayMs,
            this.configuration.retryMaxDelayMs
        );
        this.dispatcher = new ExecutionDispatcher(this.retryManager, this.recoveryManager);
        this.snapshotManager = new ExecutionSnapshotManager(this.configuration.snapshotCapacity);
    }

    /* --------------------------------------------------------------------- *
     * Observers
     * --------------------------------------------------------------------- */

    subscribe(observer: ExecutorObserver): void {
        this.observers.add(observer);
    }

    unsubscribe(observer: ExecutorObserver): void {
        this.observers.delete(observer);
    }

    private emit(event: ExecutionEvent, payload: Dictionary): void {
        for (const observer of this.observers) {
            observer.onEvent?.(event, payload);
        }
    }

    /* --------------------------------------------------------------------- *
     * Dependency Graph Construction
     * --------------------------------------------------------------------- *
     * Mirrors planner.ts's own private PlannerManager.buildGraph exactly
     * (addNode for every task, then addEdge for every declared dependency),
     * so a Plan's tasks never need to be re-threaded through a separately
     * maintained graph by the caller.
     */

    private buildGraph(tasks: readonly Task[]): PlannerDependencyGraph {
        const graph = new PlannerDependencyGraph();

        for (const task of tasks) {
            graph.addNode(task.id);
        }

        for (const task of tasks) {
            for (const dependencyId of task.dependencyIds) {
                graph.addEdge(dependencyId, task.id);
            }
        }

        return graph;
    }

    /* --------------------------------------------------------------------- *
     * Execution Lifecycle
     * --------------------------------------------------------------------- */

    /**
     * Registers a new execution context for `plan`. `schedule` is accepted
     * as a contractual input — every task in `plan.tasks` must have a
     * corresponding schedule entry — but its planned timestamps are never
     * read; see this module's header for why dispatch is driven off live
     * dependency resolution instead.
     */
    beginExecution(plan: Plan, schedule: PlannerSchedule): ExecutionContext {
        if (this.contexts.has(plan.id)) {
            throw new Error(`An execution context for plan '${plan.id}' already exists.`);
        }

        for (const task of plan.tasks) {
            if (!schedule.hasEntry(task.id)) {
                throw new Error(
                    `Cannot begin execution for plan '${plan.id}': schedule '${schedule.id}' has no entry for task '${task.id}'.`
                );
            }
        }

        const graph = this.buildGraph(plan.tasks);

        const context = new ExecutionContext(
            plan.id,
            plan.tasks,
            graph,
            plan.executionPolicy,
            plan.rollbackPolicy,
            plan.recoveryStrategy,
            this.configuration.defaultMaxRetries
        );

        this.contexts.set(plan.id, context);
        this.totalExecutions++;

        return context;
    }

    /**
     * Drives a previously-registered execution context to completion,
     * dispatching tasks via `handler` until every task reaches a terminal
     * state or the context is cancelled. If `autoRollbackOnFailure` is
     * configured, the plan's `RollbackPolicy` is not `None`, and a
     * `rollbackPlan` was supplied, a rollback is automatically executed
     * against every completed task once dispatch ends with unresolved
     * failures.
     */
    async run(
        planId: PlanId,
        handler: TaskExecutionHandler,
        options: { resources?: ResourceManager; constraints?: PlannerConstraintManager; rollbackPlan?: RollbackPlan } = {}
    ): Promise<ExecutionSummary> {
        const context = this.requireContext(planId);
        context.setPhase(ExecutionPhase.Running);
        this.emit(ExecutionEvent.ExecutionStarted, { planId });

        const started = performance.now();

        const unresolvedFailures = await this.dispatcher.run(
            context,
            handler,
            (event, payload) => this.emit(event, payload),
            options.resources,
            options.constraints
        );

        this.metrics.lastDispatchCycleMs = performance.now() - started;
        this.metrics.averageDispatchLatencyMs = this.dispatcher.averageDispatchTimeMs();
        this.metrics.lastComputedAt = Date.now();

        // A task can only remain non-terminal here if the context was
        // cancelled mid-dispatch; finalize it explicitly so
        // `ExecutionContext.isComplete()` (and every diagnostic/statistic
        // built on top of it) never has to reason about a task stuck
        // indefinitely between states.
        if (context.isCancelled()) {
            for (const task of context.allTasks()) {
                if (!task.isTerminal()) {
                    task.recordCancellation(context.getCancellationReason() ?? CancellationReason.UserRequested);
                    this.emit(ExecutionEvent.TaskCancelled, { planId, taskId: task.id });
                }
            }
        }

        if (
            unresolvedFailures.length > 0 &&
            this.configuration.autoRollbackOnFailure &&
            context.getRollbackPolicy() !== RollbackPolicy.None &&
            options.rollbackPlan
        ) {
            await this.rollback(planId, options.rollbackPlan, handler);
        }

        const phase = context.isCancelled()
            ? ExecutionPhase.Cancelled
            : unresolvedFailures.length > 0
                ? ExecutionPhase.Failed
                : ExecutionPhase.Completed;

        context.setPhase(phase);

        if (phase === ExecutionPhase.Completed) {
            this.completedExecutions++;
            this.emit(ExecutionEvent.ExecutionCompleted, { planId });
        } else if (phase === ExecutionPhase.Cancelled) {
            this.cancelledExecutions++;
            this.emit(ExecutionEvent.ExecutionCancelled, { planId });
        } else {
            this.failedExecutions++;
            this.emit(ExecutionEvent.ExecutionFailed, { planId, failedTaskIds: unresolvedFailures as unknown as JsonValue });
        }

        return this.summarize(context);
    }

    private summarize(context: ExecutionContext): ExecutionSummary {
        const tasks = context.allTasks();
        return {
            planId: context.planId,
            phase: context.getPhase(),
            completedTaskIds: tasks.filter(task => task.getState() === ExecutionState.Completed).map(task => task.id),
            failedTaskIds: tasks
                .filter(task => task.getState() === ExecutionState.Failed || task.getState() === ExecutionState.TimedOut)
                .map(task => task.id),
            skippedTaskIds: tasks.filter(task => task.getState() === ExecutionState.Skipped).map(task => task.id),
            cancelledTaskIds: tasks.filter(task => task.getState() === ExecutionState.Cancelled).map(task => task.id),
            startedAt: context.getStartedAt(),
            finishedAt: context.getFinishedAt() ?? Date.now(),
            durationMs: (context.getFinishedAt() ?? Date.now()) - context.getStartedAt()
        };
    }

    pause(planId: PlanId): void {
        const context = this.requireContext(planId);
        context.setPaused(true);
        context.setPhase(ExecutionPhase.Paused);
        this.emit(ExecutionEvent.ExecutionPaused, { planId });
    }

    resume(planId: PlanId): void {
        const context = this.requireContext(planId);
        context.setPaused(false);
        context.setPhase(ExecutionPhase.Running);
        this.emit(ExecutionEvent.ExecutionResumed, { planId });
    }

    /**
     * Requests cancellation of an in-progress execution. Cancellation is
     * cooperative: the active dispatch loop observes it on its next
     * iteration, and any in-flight `handler.execute` call is allowed to
     * settle — surfaced to the handler via
     * `ExecutionRuntimeContext.isCancelled()` — rather than being forcibly
     * interrupted, since this module never assumes a handler's underlying
     * work is safely abortable mid-flight.
     */
    cancel(planId: PlanId, reason: CancellationReason = CancellationReason.UserRequested): void {
        const context = this.requireContext(planId);
        context.requestCancellation(reason);
    }

    /**
     * Manually re-queues a `Failed`/`TimedOut` task outside the automatic
     * retry/recovery flow (e.g. after a human has addressed the underlying
     * cause). The task becomes `Ready` immediately; call `run()` again to
     * resume dispatch for it and anything still blocked behind it.
     */
    retryTask(planId: PlanId, taskId: TaskId): void {
        const context = this.requireContext(planId);
        const task = context.requireExecutionTask(taskId);

        if (task.getState() !== ExecutionState.Failed && task.getState() !== ExecutionState.TimedOut) {
            throw new Error(`Task '${taskId}' is not in a retryable state ('${task.getState()}').`);
        }

        task.prepareRetry();
        task.markReady();
        context.getQueue().requeue(taskId);
    }

    async rollback(planId: PlanId, plan: RollbackPlan, handler: TaskExecutionHandler): Promise<TaskId[]> {
        const context = this.requireContext(planId);
        const previousPhase = context.getPhase();
        context.setPhase(ExecutionPhase.RollingBack);
        this.emit(ExecutionEvent.RollbackStarted, { planId });

        const tasksById = new Map(context.allTasks().map(task => [task.id, task]));
        const definitionsById = new Map(context.allTaskDefinitions().map(task => [task.id, task]));

        const rolledBack = await this.rollbackManager.execute(
            plan,
            tasksById,
            definitionsById,
            handler,
            () => context.isCancelled()
        );

        for (const taskId of rolledBack) {
            this.emit(ExecutionEvent.TaskRolledBack, { planId, taskId });
        }

        context.setPhase(previousPhase);
        this.emit(ExecutionEvent.RollbackCompleted, { planId, count: rolledBack.length });
        return rolledBack;
    }

    /* --------------------------------------------------------------------- *
     * Accessors
     * --------------------------------------------------------------------- */

    getContext(planId: PlanId): Optional<ExecutionContext> {
        return this.contexts.get(planId);
    }

    requireContext(planId: PlanId): ExecutionContext {
        const context = this.contexts.get(planId);
        if (!context) {
            throw new Error(`No execution context exists for plan '${planId}'.`);
        }
        return context;
    }

    hasContext(planId: PlanId): boolean {
        return this.contexts.has(planId);
    }

    removeContext(planId: PlanId): boolean {
        return this.contexts.delete(planId);
    }

    allContexts(): ExecutionContext[] {
        return [...this.contexts.values()];
    }

    where(predicate: Predicate<ExecutionContext>): ExecutionContext[] {
        return this.allContexts().filter(predicate);
    }

    sortedBy(comparator: Comparator<ExecutionContext>): ExecutionContext[] {
        return this.allContexts().sort(comparator);
    }

    getProgress(planId: PlanId): ExecutionProgress {
        const context = this.requireContext(planId);
        return this.monitor.snapshot(planId, context.allTasks(), context.getStartedAt());
    }

    /* --------------------------------------------------------------------- *
     * Snapshot / Serialization
     * --------------------------------------------------------------------- */

    snapshot(): ExecutorSnapshot {
        const contextSnapshots = this.contextSnapshots();
        const snapshot = this.snapshotManager.create(contextSnapshots);
        this.emit(ExecutionEvent.SnapshotCreated, { snapshotId: snapshot.id });
        return snapshot;
    }

    private contextSnapshots(): ExecutionContextSnapshot[] {
        return this.allContexts().map(context => ({
            planId: context.planId,
            phase: context.getPhase(),
            records: context.serializeRecords()
        }));
    }

    /**
     * Applies a snapshot's recorded `ExecutionTask` state onto whichever of
     * its contexts are currently registered (via `beginExecution`).
     * Contexts referenced by the snapshot but not currently registered are
     * skipped, since reconstructing one requires the originating `Plan`'s
     * task definitions, which this module does not itself retain — a
     * snapshot restores *how far execution got*, not the plan being
     * executed. Returns the number of contexts actually restored.
     */
    restoreSnapshot(snapshot: ExecutorSnapshot): number {
        let restored = 0;
        for (const contextSnapshot of snapshot.contexts) {
            const context = this.contexts.get(contextSnapshot.planId);
            if (!context) {
                continue;
            }
            context.restoreRecords(contextSnapshot.records);
            context.setPhase(contextSnapshot.phase);
            restored++;
        }
        return restored;
    }

    export(): ExecutorExport {
        return {
            exportedAt: Date.now(),
            formatVersion: EXECUTOR_FORMAT_VERSION,
            contexts: this.contextSnapshots()
        };
    }

    /* --------------------------------------------------------------------- *
     * Diagnostics / Statistics
     * --------------------------------------------------------------------- */

    runDiagnostics(planId: PlanId): boolean {
        const context = this.requireContext(planId);
        return this.diagnostics.runAll(context);
    }

    getMetrics(): ExecutorMetrics {
        return structuredClone(this.metrics);
    }

    getStatistics(): ExecutionStatistics {
        const contexts = this.allContexts();

        let totalTasks = 0;
        let pendingTasks = 0;
        let runningTasks = 0;
        let completedTasks = 0;
        let failedTasks = 0;
        let skippedTasks = 0;
        let cancelledTasks = 0;
        let timedOutTasks = 0;
        let durationSum = 0;
        let durationCount = 0;

        for (const context of contexts) {
            for (const task of context.allTasks()) {
                totalTasks++;

                switch (task.getState()) {
                    case ExecutionState.Completed:
                        completedTasks++;
                        break;
                    case ExecutionState.Failed:
                        failedTasks++;
                        break;
                    case ExecutionState.Skipped:
                        skippedTasks++;
                        break;
                    case ExecutionState.Cancelled:
                        cancelledTasks++;
                        break;
                    case ExecutionState.TimedOut:
                        timedOutTasks++;
                        break;
                    case ExecutionState.Dispatched:
                    case ExecutionState.Running:
                    case ExecutionState.Paused:
                        runningTasks++;
                        break;
                    default:
                        pendingTasks++;
                        break;
                }

                const duration = task.getDurationMs();
                if (duration !== undefined) {
                    durationSum += duration;
                    durationCount++;
                }
            }
        }

        const executionDurations = contexts
            .filter(context => context.getFinishedAt() !== undefined)
            .map(context => (context.getFinishedAt() as Timestamp) - context.getStartedAt());

        return {
            totalExecutions: this.totalExecutions,
            activeExecutions: contexts.filter(context => !context.isComplete() && !context.isCancelled()).length,
            completedExecutions: this.completedExecutions,
            failedExecutions: this.failedExecutions,
            cancelledExecutions: this.cancelledExecutions,
            totalTasks,
            pendingTasks,
            runningTasks,
            completedTasks,
            failedTasks,
            skippedTasks,
            cancelledTasks,
            timedOutTasks,
            totalRetries: this.retryManager.retryCount(),
            totalRollbacks: this.rollbackManager.rollbackCount(),
            totalRecoveries: this.recoveryManager.recoveryCount(),
            averageTaskDurationMs: durationCount > 0 ? durationSum / durationCount : 0,
            averageExecutionDurationMs:
                executionDurations.length > 0
                    ? executionDurations.reduce((sum, value) => sum + value, 0) / executionDurations.length
                    : 0
        };
    }

    /* --------------------------------------------------------------------- *
     * Introspection
     * --------------------------------------------------------------------- */

    describe(): string {
        return [
            "ExecutorManager",
            `contexts=${this.contexts.size}`,
            `completed=${this.completedExecutions}`,
            `failed=${this.failedExecutions}`,
            `cancelled=${this.cancelledExecutions}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            configuration: structuredClone(this.configuration),
            contexts: this.contexts.size,
            metrics: this.getMetrics(),
            statistics: this.getStatistics() as unknown as Dictionary,
            dispatcher: this.dispatcher.inspect(),
            retryManager: this.retryManager.inspect(),
            rollbackManager: this.rollbackManager.inspect(),
            recoveryManager: this.recoveryManager.inspect(),
            snapshots: this.snapshotManager.inspect(),
            diagnostics: this.diagnostics.inspect()
        };
    }
}
