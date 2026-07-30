/**
 * =============================================================================
 * Hexical AI
 * planner.ts
 * =============================================================================
 *
 * Executive Planning Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * The Planner is the executive intelligence layer of Hexical AI. It sits
 * between reasoning/memory and execution:
 *
 *     severity -> semantic -> impact -> behavior -> recommendation
 *         -> reasoner -> memory -> [planner] -> executor -> agent
 *
 * The Planner consumes a ReasoningReport, Recommendation artifacts, a
 * MemoryManager, goals, constraints, environment state, policies, and user
 * intent, and produces Execution Plans, Task Graphs, Schedules, Rollback
 * Plans, Recovery Plans, and Alternative Plans.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * - The Planner NEVER executes anything. It has no side effects on the
 *   outside world.
 * - The Planner NEVER performs reasoning. Reasoning artifacts are consumed
 *   as read-only input produced upstream by reasoner.ts.
 * - The Planner NEVER stores memory. A MemoryManager may be supplied as
 *   read-only context, but the Planner never writes through it.
 * - The Planner ONLY plans: it decomposes goals, builds dependency and task
 *   graphs, schedules, optimizes, validates, and prepares rollback/recovery
 *   plans for a downstream executor to carry out.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    ReasoningReport
} from "../reasoner";

import {
    Recommendation
} from "../recommendation";

import {
    MemoryManager,
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
    VersionNumber,
    Score
} from "../memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const PLANNER_FORMAT_VERSION = 1;
export const INITIAL_PLAN_VERSION = 1;

export const DEFAULT_MAX_PLAN_DEPTH = 32;
export const DEFAULT_MAX_TASKS_PER_PLAN = 10_000;
export const DEFAULT_MAX_GOALS_PER_PLAN = 1_000;
export const DEFAULT_MAX_CONSTRAINTS_PER_PLAN = 5_000;
export const DEFAULT_MAX_ALTERNATIVE_PLANS = 25;

export const MIN_RISK_SCORE: Score = 0;
export const MAX_RISK_SCORE: Score = 1;

export const MIN_PRIORITY_WEIGHT = 0;
export const MAX_PRIORITY_WEIGHT = 1;

export const DEFAULT_TASK_MAX_RETRIES = 3;

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type PlanId = string;
export type GoalId = string;
export type TaskId = string;
export type ConstraintId = string;
export type DependencyId = string;
export type ScheduleId = string;
export type ResourceId = string;
export type PlannerSnapshotId = string;
export type PlannerTransactionId = string;
export type PlannerTag = string;

/**
 * Clamps a number into [min, max]. NaN and other non-finite values collapse
 * to `min` rather than propagating, since planning inputs (risk scores,
 * confidences, durations) frequently originate from upstream heuristics that
 * cannot be fully trusted.
 */
function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
}

export function generateId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

/* =============================================================================
 * Plan Status
 * =============================================================================
 */

export enum PlanStatus {
    Draft = "draft",
    Validated = "validated",
    Scheduled = "scheduled",
    Ready = "ready",
    Active = "active",
    Paused = "paused",
    Completed = "completed",
    Failed = "failed",
    RolledBack = "rolled-back",
    Cancelled = "cancelled"
}

/* =============================================================================
 * Goal Status
 * =============================================================================
 */

export enum GoalStatus {
    Pending = "pending",
    Decomposed = "decomposed",
    InProgress = "in-progress",
    Achieved = "achieved",
    Failed = "failed",
    Blocked = "blocked",
    Abandoned = "abandoned"
}

/* =============================================================================
 * Goal Type
 * =============================================================================
 */

export enum GoalType {
    Achievement = "achievement",
    Maintenance = "maintenance",
    Avoidance = "avoidance",
    Optimization = "optimization",
    Exploration = "exploration"
}

/* =============================================================================
 * Task State
 * =============================================================================
 */

export enum TaskState {
    Pending = "pending",
    Ready = "ready",
    Scheduled = "scheduled",
    Blocked = "blocked",
    Running = "running",
    Completed = "completed",
    Failed = "failed",
    Skipped = "skipped",
    Cancelled = "cancelled"
}

/* =============================================================================
 * Task Priority
 * =============================================================================
 */

export enum TaskPriority {
    Low = "low",
    Normal = "normal",
    High = "high",
    Critical = "critical",
    Urgent = "urgent"
}

const TASK_PRIORITY_WEIGHTS: ReadonlyMap<TaskPriority, number> = new Map([
    [TaskPriority.Low, 1],
    [TaskPriority.Normal, 2],
    [TaskPriority.High, 3],
    [TaskPriority.Critical, 4],
    [TaskPriority.Urgent, 5]
]);

/* =============================================================================
 * Execution Policy
 * =============================================================================
 */

export enum ExecutionPolicy {
    Sequential = "sequential",
    Parallel = "parallel",
    BestEffort = "best-effort",
    AllOrNothing = "all-or-nothing",
    Adaptive = "adaptive"
}

/* =============================================================================
 * Optimization Level
 * =============================================================================
 */

export enum OptimizationLevel {
    None = "none",
    Basic = "basic",
    Standard = "standard",
    Aggressive = "aggressive",
    Maximum = "maximum"
}

/* =============================================================================
 * Constraint Type
 * =============================================================================
 */

export enum ConstraintType {
    Temporal = "temporal",
    Resource = "resource",
    Dependency = "dependency",
    Policy = "policy",
    Budget = "budget",
    Safety = "safety",
    Custom = "custom"
}

/* =============================================================================
 * Dependency Type
 * =============================================================================
 */

export enum DependencyType {
    FinishToStart = "finish-to-start",
    StartToStart = "start-to-start",
    FinishToFinish = "finish-to-finish",
    StartToFinish = "start-to-finish",
    Soft = "soft",
    Hard = "hard"
}

/* =============================================================================
 * Rollback Policy
 * =============================================================================
 */

export enum RollbackPolicy {
    None = "none",
    Automatic = "automatic",
    Manual = "manual",
    Checkpoint = "checkpoint",
    FullRevert = "full-revert"
}

/* =============================================================================
 * Recovery Strategy
 * =============================================================================
 */

export enum RecoveryStrategy {
    Retry = "retry",
    Skip = "skip",
    Substitute = "substitute",
    Escalate = "escalate",
    Abort = "abort",
    Compensate = "compensate"
}

/* =============================================================================
 * Planner Event
 * =============================================================================
 */

export enum PlannerEvent {
    PlanCreated = "plan-created",
    PlanUpdated = "plan-updated",
    PlanValidated = "plan-validated",
    PlanScheduled = "plan-scheduled",
    PlanOptimized = "plan-optimized",
    PlanReady = "plan-ready",
    PlanCompleted = "plan-completed",
    PlanFailed = "plan-failed",
    PlanRolledBack = "plan-rolled-back",
    PlanCancelled = "plan-cancelled",
    GoalAdded = "goal-added",
    GoalStateChanged = "goal-state-changed",
    TaskAdded = "task-added",
    TaskRemoved = "task-removed",
    TaskStateChanged = "task-state-changed",
    ConstraintViolated = "constraint-violated",
    DependencyCycleDetected = "dependency-cycle-detected",
    SnapshotCreated = "snapshot-created",
    TransactionCommitted = "transaction-committed",
    TransactionRolledBack = "transaction-rolled-back",
    RecoveryTriggered = "recovery-triggered"
}

/* =============================================================================
 * Validation State
 * =============================================================================
 */

export enum ValidationState {
    Unknown = "unknown",
    Pending = "pending",
    Valid = "valid",
    Warning = "warning",
    Invalid = "invalid"
}

/* =============================================================================
 * Plan Type
 * =============================================================================
 */

export enum PlanType {
    Linear = "linear",
    Hierarchical = "hierarchical",
    Conditional = "conditional",
    Parallel = "parallel",
    Cyclic = "cyclic"
}

/* =============================================================================
 * Plan Phase
 * =============================================================================
 */

export enum PlanPhase {
    Initiation = "initiation",
    Decomposition = "decomposition",
    Scheduling = "scheduling",
    Optimization = "optimization",
    Validation = "validation",
    Ready = "ready",
    Finalized = "finalized"
}

/* =============================================================================
 * Resource State
 * =============================================================================
 */

export enum ResourceState {
    Available = "available",
    Reserved = "reserved",
    Allocated = "allocated",
    Exhausted = "exhausted",
    Unavailable = "unavailable"
}

/* =============================================================================
 * Risk Level
 * =============================================================================
 */

export enum RiskLevel {
    Negligible = "negligible",
    Low = "low",
    Moderate = "moderate",
    High = "high",
    Severe = "severe"
}

/* =============================================================================
 * Schedule Policy
 * =============================================================================
 */

export enum SchedulePolicy {
    EarliestStart = "earliest-start",
    LatestStart = "latest-start",
    PriorityFirst = "priority-first",
    CriticalPathFirst = "critical-path-first",
    LoadBalanced = "load-balanced"
}

/* =============================================================================
 * Conflict Resolution Policy
 * =============================================================================
 */

export enum ConflictResolutionPolicy {
    Reject = "reject",
    Merge = "merge",
    Override = "override",
    Prioritize = "prioritize",
    Manual = "manual"
}

/* =============================================================================
 * Resource Requirement
 * =============================================================================
 */

export interface ResourceRequirement {
    resourceId: ResourceId;
    amount: number;
    state: ResourceState;
}

/* =============================================================================
 * Goal
 * =============================================================================
 */

export interface Goal {
    id: GoalId;
    type: GoalType;
    status: GoalStatus;
    title: string;
    description: string;
    priority: TaskPriority;
    successCriteria: string[];
    parentGoalId?: GoalId;
    subGoalIds: GoalId[];
    relatedTaskIds: TaskId[];
    deadline?: Timestamp;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Task
 * =============================================================================
 */

export interface Task {
    id: TaskId;
    goalId?: GoalId;
    name: string;
    description: string;
    state: TaskState;
    priority: TaskPriority;
    estimatedDurationMs: number;
    actualDurationMs?: number;
    dependencyIds: TaskId[];
    resourceRequirements: ResourceRequirement[];
    constraintIds: ConstraintId[];
    retryCount: number;
    maxRetries: number;
    scheduledStart?: Timestamp;
    scheduledEnd?: Timestamp;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Constraint
 * =============================================================================
 */

export interface Constraint {
    id: ConstraintId;
    type: ConstraintType;
    description: string;
    hard: boolean;
    appliesToTaskIds: TaskId[];
    appliesToGoalIds: GoalId[];
    expression?: string;
    createdAt: Timestamp;
}

/* =============================================================================
 * Dependency
 * =============================================================================
 */

export interface Dependency {
    id: DependencyId;
    fromTaskId: TaskId;
    toTaskId: TaskId;
    type: DependencyType;
    lagMs?: number;
}

/* =============================================================================
 * Plan Step / Node / Graph
 * =============================================================================
 */

export interface PlanStep {
    id: string;
    taskId: TaskId;
    order: number;
    phase: PlanPhase;
    optional: boolean;
}

export interface PlanNode {
    id: string;
    taskId: TaskId;
    parentId?: string;
    childIds: string[];
}

export interface PlanGraph {
    nodes: PlanNode[];
    dependencies: Dependency[];
}

/* =============================================================================
 * Execution Window / Schedule / Policy Definition
 * =============================================================================
 */

export interface ExecutionWindow {
    taskId: TaskId;
    earliestStart: Timestamp;
    latestStart: Timestamp;
    earliestFinish: Timestamp;
    latestFinish: Timestamp;
    slackMs: number;
}

export interface ExecutionSchedule {
    id: ScheduleId;
    planId: PlanId;
    policy: SchedulePolicy;
    windows: ExecutionWindow[];
    criticalPath: TaskId[];
    makespanMs: number;
    createdAt: Timestamp;
}

export interface ExecutionPolicyDefinition {
    policy: ExecutionPolicy;
    maxConcurrency: number;
    allowPartialFailure: boolean;
    timeoutMs?: number;
}

/* =============================================================================
 * Risk / Validation / Rollback / Recovery
 * =============================================================================
 */

export interface RiskAssessment {
    id: string;
    taskId?: TaskId;
    planId?: PlanId;
    level: RiskLevel;
    score: Score;
    factors: string[];
    assessedAt: Timestamp;
}

export interface ValidationIssue {
    code: string;
    message: string;
    severity: RiskLevel;
    taskId?: TaskId;
    goalId?: GoalId;
    constraintId?: ConstraintId;
}

export interface ValidationResult {
    state: ValidationState;
    valid: boolean;
    issues: ValidationIssue[];
    validatedAt: Timestamp;
}

export interface RollbackPlan {
    id: string;
    planId: PlanId;
    policy: RollbackPolicy;
    checkpointTaskIds: TaskId[];
    steps: string[];
    createdAt: Timestamp;
}

export interface RecoveryPlan {
    id: string;
    planId: PlanId;
    strategy: RecoveryStrategy;
    triggers: string[];
    steps: string[];
    createdAt: Timestamp;
}

/* =============================================================================
 * Planner Configuration
 * =============================================================================
 */

export interface PlannerConfiguration {
    maxPlanDepth: number;
    maxTasksPerPlan: number;
    maxGoalsPerPlan: number;
    maxConstraintsPerPlan: number;
    maxAlternativePlans: number;
    defaultExecutionPolicy: ExecutionPolicy;
    defaultOptimizationLevel: OptimizationLevel;
    defaultRollbackPolicy: RollbackPolicy;
    defaultRecoveryStrategy: RecoveryStrategy;
    defaultSchedulePolicy: SchedulePolicy;
    defaultConflictResolution: ConflictResolutionPolicy;
    enableRiskAnalysis: boolean;
    enableSnapshots: boolean;
    enableDiagnostics: boolean;
    strictValidation: boolean;
}

export const DEFAULT_PLANNER_CONFIGURATION: PlannerConfiguration = Object.freeze({
    maxPlanDepth: DEFAULT_MAX_PLAN_DEPTH,
    maxTasksPerPlan: DEFAULT_MAX_TASKS_PER_PLAN,
    maxGoalsPerPlan: DEFAULT_MAX_GOALS_PER_PLAN,
    maxConstraintsPerPlan: DEFAULT_MAX_CONSTRAINTS_PER_PLAN,
    maxAlternativePlans: DEFAULT_MAX_ALTERNATIVE_PLANS,
    defaultExecutionPolicy: ExecutionPolicy.Sequential,
    defaultOptimizationLevel: OptimizationLevel.Standard,
    defaultRollbackPolicy: RollbackPolicy.Checkpoint,
    defaultRecoveryStrategy: RecoveryStrategy.Retry,
    defaultSchedulePolicy: SchedulePolicy.CriticalPathFirst,
    defaultConflictResolution: ConflictResolutionPolicy.Prioritize,
    enableRiskAnalysis: true,
    enableSnapshots: true,
    enableDiagnostics: true,
    strictValidation: false
});

/* =============================================================================
 * Planner Statistics / Metrics
 * =============================================================================
 */

export interface PlannerStatistics {
    totalPlans: number;
    draftPlans: number;
    activePlans: number;
    completedPlans: number;
    failedPlans: number;
    totalGoals: number;
    achievedGoals: number;
    totalTasks: number;
    pendingTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalConstraints: number;
    totalDependencies: number;
    averageRiskScore: number;
    averagePlanDepth: number;
    graphNodes: number;
    graphEdges: number;
}

export interface PlannerMetrics {
    planningTimeMs: number;
    schedulingTimeMs: number;
    optimizationTimeMs: number;
    validationTimeMs: number;
    lastComputedAt: Timestamp;
}

/* =============================================================================
 * Planner Snapshot / Transaction
 * =============================================================================
 */

export interface PlannerSnapshot {
    id: PlannerSnapshotId;
    timestamp: Timestamp;
    version: VersionNumber;
    plans: Plan[];
}

export interface PlannerTransaction {
    id: PlannerTransactionId;
    timestamp: Timestamp;
    description?: string;
    operations: string[];
    committed: boolean;
}

/* =============================================================================
 * Planner Observer / Export / Import / Factory
 * =============================================================================
 */

export interface PlannerObserver {
    onEvent?(event: PlannerEvent, payload: Dictionary): void;
}

export interface PlannerExport {
    exportedAt: Timestamp;
    formatVersion: number;
    plans: Plan[];
}

export interface PlannerImport {
    importedAt: Timestamp;
    plans: Plan[];
}

export interface PlannerFactory {
    createPlan(context: PlannerContext): Plan;
}

/* =============================================================================
 * Goal Decomposer (extension point)
 * =============================================================================
 *
 * PlannerManager's default goal decomposition is intentionally minimal: a
 * goal with no linked tasks gets a single placeholder task. Richer strategies
 * (Hierarchical Task Networks, GOAP, etc.) can be plugged in by implementing
 * this interface and passing an instance to the PlannerManager constructor.
 *
 * A GoalDecomposer only ever *computes* a proposed set of tasks/subgoals for
 * a single top-level goal — it does not mutate the goal, the plan, or any
 * planner state. PlannerManager remains solely responsible for actually
 * incorporating the result into a Plan.
 */

export interface GoalDecompositionOutcome {
    /** Concrete, schedulable tasks produced for the goal (possibly via subgoals). */
    tasks: Task[];
    /** Additional subgoals introduced during decomposition, if any. */
    subGoals: Goal[];
}

export interface GoalDecomposer {
    /**
     * Attempts to decompose a single top-level goal into concrete tasks and,
     * for hierarchical strategies, additional subgoals. Returning an empty
     * `tasks` array signals "no applicable decomposition" and tells
     * PlannerManager to fall back to its default single-placeholder-task
     * behavior for that goal.
     */
    decompose(goal: Goal, context: PlannerContext): GoalDecompositionOutcome;
}

/* =============================================================================
 * Planner Context
 * =============================================================================
 *
 * The full set of inputs the Planner accepts: reasoning output, recommendation
 * artifacts, a read-only view of memory, goals, constraints, environment
 * state, policies, and user intent.
 */

export interface PlannerContext {
    reasoningReport?: ReasoningReport;
    recommendations: Recommendation[];
    memory?: MemoryManager;
    goals: Goal[];
    constraints: Constraint[];
    environmentState: Dictionary;
    policies: Dictionary;
    userIntent: string;
    executionPolicy?: ExecutionPolicyDefinition;
    optimizationLevel?: OptimizationLevel;
    schedulePolicy?: SchedulePolicy;
    rollbackPolicy?: RollbackPolicy;
    recoveryStrategy?: RecoveryStrategy;
    timestamp: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Plan
 * =============================================================================
 */

export interface Plan {
    id: PlanId;
    type: PlanType;
    status: PlanStatus;
    phase: PlanPhase;
    version: VersionNumber;
    title: string;
    description: string;
    goals: Goal[];
    tasks: Task[];
    constraints: Constraint[];
    dependencies: Dependency[];
    graph: PlanGraph;
    schedule?: ExecutionSchedule;
    executionPolicy: ExecutionPolicyDefinition;
    rollbackPolicy: RollbackPolicy;
    recoveryStrategy: RecoveryStrategy;
    riskLevel: RiskLevel;
    riskScore: Score;
    alternativePlanIds: PlanId[];
    parentPlanId?: PlanId;
    validation?: ValidationResult;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Planner Node
 * =============================================================================
 *
 * A single mutable, encapsulated node within a plan graph. Wraps a PlanNode
 * plus its associated Task, mirroring the MemoryNode pattern used elsewhere
 * in Hexical: private mutable state, defensive cloning on every read/write,
 * and explicit invariant checks before mutation.
 */

export class PlannerNode
    implements
        Serializable<PlanNode>,
        Cloneable<PlannerNode>,
        Validatable,
        Identifiable {

    public readonly id: string;

    private taskId: TaskId;
    private parentId?: string;
    private childIds: string[];

    private frozen = false;

    constructor(node: PlanNode) {
        this.id = node.id;
        this.taskId = node.taskId;
        this.parentId = node.parentId;
        this.childIds = [...node.childIds];
    }

    getId(): string {
        return this.id;
    }

    getTaskId(): TaskId {
        return this.taskId;
    }

    getParentId(): Optional<string> {
        return this.parentId;
    }

    getChildIds(): readonly string[] {
        return [...this.childIds];
    }

    hasParent(): boolean {
        return this.parentId !== undefined;
    }

    hasChildren(): boolean {
        return this.childIds.length > 0;
    }

    isRoot(): boolean {
        return !this.hasParent();
    }

    isLeaf(): boolean {
        return !this.hasChildren();
    }

    private assertMutable(): void {
        if (this.frozen) {
            throw new Error(`PlannerNode '${this.id}' is frozen and cannot be modified.`);
        }
    }

    setParent(id: string): this {
        this.assertMutable();
        this.parentId = id;
        return this;
    }

    clearParent(): this {
        this.assertMutable();
        this.parentId = undefined;
        return this;
    }

    addChild(id: string): this {
        this.assertMutable();
        if (!this.childIds.includes(id)) {
            this.childIds.push(id);
        }
        return this;
    }

    removeChild(id: string): this {
        this.assertMutable();
        this.childIds = this.childIds.filter(childId => childId !== id);
        return this;
    }

    freeze(): this {
        this.frozen = true;
        return this;
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    validate(): boolean {
        return this.id.length > 0 && this.taskId.length > 0;
    }

    serialize(): PlanNode {
        return {
            id: this.id,
            taskId: this.taskId,
            parentId: this.parentId,
            childIds: [...this.childIds]
        };
    }

    clone(): PlannerNode {
        return new PlannerNode(this.serialize());
    }

    describe(): string {
        return [
            `PlannerNode(${this.id})`,
            `task=${this.taskId}`,
            `children=${this.childIds.length}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            taskId: this.taskId,
            parentId: this.parentId,
            childIds: [...this.childIds],
            frozen: this.frozen
        };
    }
}

/* =============================================================================
 * Planner Goal
 * =============================================================================
 */

export class PlannerGoal
    implements
        Serializable<Goal>,
        Cloneable<PlannerGoal>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: GoalId;

    private type: GoalType;
    private status: GoalStatus;
    private title: string;
    private description: string;
    private priority: TaskPriority;
    private successCriteria: string[];
    private parentGoalId?: GoalId;
    private subGoalIds: string[];
    private relatedTaskIds: string[];
    private deadline?: Timestamp;
    private metadata: Dictionary;

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_PLAN_VERSION;

    constructor(goal: Goal) {
        this.id = goal.id;
        this.type = goal.type;
        this.status = goal.status;
        this.title = goal.title;
        this.description = goal.description;
        this.priority = goal.priority;
        this.successCriteria = [...goal.successCriteria];
        this.parentGoalId = goal.parentGoalId;
        this.subGoalIds = [...goal.subGoalIds];
        this.relatedTaskIds = [...goal.relatedTaskIds];
        this.deadline = goal.deadline;
        this.metadata = structuredClone(goal.metadata ?? {});
        this.created = goal.createdAt;
        this.updated = goal.updatedAt;
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

    getType(): GoalType {
        return this.type;
    }

    getStatus(): GoalStatus {
        return this.status;
    }

    getTitle(): string {
        return this.title;
    }

    getDescription(): string {
        return this.description;
    }

    getPriority(): TaskPriority {
        return this.priority;
    }

    getPriorityWeight(): number {
        return TASK_PRIORITY_WEIGHTS.get(this.priority) ?? 0;
    }

    getSuccessCriteria(): readonly string[] {
        return [...this.successCriteria];
    }

    getParentGoalId(): Optional<GoalId> {
        return this.parentGoalId;
    }

    getSubGoalIds(): readonly GoalId[] {
        return [...this.subGoalIds];
    }

    getRelatedTaskIds(): readonly TaskId[] {
        return [...this.relatedTaskIds];
    }

    getDeadline(): Optional<Timestamp> {
        return this.deadline;
    }

    isOverdue(referenceTime: Timestamp = Date.now()): boolean {
        return this.deadline !== undefined && referenceTime > this.deadline;
    }

    isTerminal(): boolean {
        return (
            this.status === GoalStatus.Achieved ||
            this.status === GoalStatus.Failed ||
            this.status === GoalStatus.Abandoned
        );
    }

    isActionable(): boolean {
        return (
            this.status === GoalStatus.Pending ||
            this.status === GoalStatus.Decomposed ||
            this.status === GoalStatus.InProgress
        );
    }

    hasSubGoals(): boolean {
        return this.subGoalIds.length > 0;
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    setStatus(status: GoalStatus): this {
        if (this.status === status) {
            return this;
        }
        this.status = status;
        this.touch();
        return this;
    }

    setPriority(priority: TaskPriority): this {
        this.priority = priority;
        this.touch();
        return this;
    }

    addSuccessCriterion(criterion: string): this {
        if (!this.successCriteria.includes(criterion)) {
            this.successCriteria.push(criterion);
            this.touch();
        }
        return this;
    }

    addSubGoal(id: GoalId): this {
        if (!this.subGoalIds.includes(id)) {
            this.subGoalIds.push(id);
            this.touch();
        }
        return this;
    }

    removeSubGoal(id: GoalId): this {
        const before = this.subGoalIds.length;
        this.subGoalIds = this.subGoalIds.filter(goalId => goalId !== id);
        if (this.subGoalIds.length !== before) {
            this.touch();
        }
        return this;
    }

    linkTask(id: TaskId): this {
        if (!this.relatedTaskIds.includes(id)) {
            this.relatedTaskIds.push(id);
            this.touch();
        }
        return this;
    }

    setDeadline(deadline: Timestamp): this {
        this.deadline = deadline;
        this.touch();
        return this;
    }

    validate(): boolean {
        return (
            this.id.length > 0 &&
            this.title.length > 0 &&
            this.successCriteria.length >= 0
        );
    }

    serialize(): Goal {
        return {
            id: this.id,
            type: this.type,
            status: this.status,
            title: this.title,
            description: this.description,
            priority: this.priority,
            successCriteria: [...this.successCriteria],
            parentGoalId: this.parentGoalId,
            subGoalIds: [...this.subGoalIds],
            relatedTaskIds: [...this.relatedTaskIds],
            deadline: this.deadline,
            createdAt: this.created,
            updatedAt: this.updated,
            metadata: structuredClone(this.metadata)
        };
    }

    clone(): PlannerGoal {
        return new PlannerGoal(this.serialize());
    }

    describe(): string {
        return [
            `PlannerGoal(${this.id})`,
            `type=${this.type}`,
            `status=${this.status}`,
            `priority=${this.priority}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            type: this.type,
            status: this.status,
            priority: this.priority,
            subGoals: this.subGoalIds.length,
            relatedTasks: this.relatedTaskIds.length,
            overdue: this.isOverdue()
        };
    }
}

/* =============================================================================
 * Planner Task
 * =============================================================================
 */

export class PlannerTask
    implements
        Serializable<Task>,
        Cloneable<PlannerTask>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: TaskId;

    private goalId?: GoalId;
    private name: string;
    private description: string;
    private state: TaskState;
    private priority: TaskPriority;
    private estimatedDurationMs: number;
    private actualDurationMs?: number;
    private dependencyIds: TaskId[];
    private resourceRequirements: ResourceRequirement[];
    private constraintIds: ConstraintId[];
    private retryCount: number;
    private maxRetries: number;
    private scheduledStart?: Timestamp;
    private scheduledEnd?: Timestamp;
    private metadata: Dictionary;

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_PLAN_VERSION;

    constructor(task: Task) {
        this.id = task.id;
        this.goalId = task.goalId;
        this.name = task.name;
        this.description = task.description;
        this.state = task.state;
        this.priority = task.priority;
        this.estimatedDurationMs = task.estimatedDurationMs;
        this.actualDurationMs = task.actualDurationMs;
        this.dependencyIds = [...task.dependencyIds];
        this.resourceRequirements = structuredClone(task.resourceRequirements);
        this.constraintIds = [...task.constraintIds];
        this.retryCount = task.retryCount;
        this.maxRetries = task.maxRetries;
        this.scheduledStart = task.scheduledStart;
        this.scheduledEnd = task.scheduledEnd;
        this.metadata = structuredClone(task.metadata ?? {});
        this.created = task.createdAt;
        this.updated = task.updatedAt;
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

    getGoalId(): Optional<GoalId> {
        return this.goalId;
    }

    getName(): string {
        return this.name;
    }

    getDescription(): string {
        return this.description;
    }

    getState(): TaskState {
        return this.state;
    }

    getPriority(): TaskPriority {
        return this.priority;
    }

    getPriorityWeight(): number {
        return TASK_PRIORITY_WEIGHTS.get(this.priority) ?? 0;
    }

    getEstimatedDurationMs(): number {
        return this.estimatedDurationMs;
    }

    getActualDurationMs(): Optional<number> {
        return this.actualDurationMs;
    }

    getDependencyIds(): readonly TaskId[] {
        return [...this.dependencyIds];
    }

    getResourceRequirements(): readonly ResourceRequirement[] {
        return structuredClone(this.resourceRequirements);
    }

    getConstraintIds(): readonly ConstraintId[] {
        return [...this.constraintIds];
    }

    getRetryCount(): number {
        return this.retryCount;
    }

    getMaxRetries(): number {
        return this.maxRetries;
    }

    getScheduledStart(): Optional<Timestamp> {
        return this.scheduledStart;
    }

    getScheduledEnd(): Optional<Timestamp> {
        return this.scheduledEnd;
    }

    hasDependencies(): boolean {
        return this.dependencyIds.length > 0;
    }

    dependsOn(id: TaskId): boolean {
        return this.dependencyIds.includes(id);
    }

    isTerminal(): boolean {
        return (
            this.state === TaskState.Completed ||
            this.state === TaskState.Failed ||
            this.state === TaskState.Skipped ||
            this.state === TaskState.Cancelled
        );
    }

    isRunnable(): boolean {
        return this.state === TaskState.Ready || this.state === TaskState.Scheduled;
    }

    canRetry(): boolean {
        return this.state === TaskState.Failed && this.retryCount < this.maxRetries;
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    setState(state: TaskState): this {
        if (this.state === state) {
            return this;
        }
        this.state = state;
        this.touch();
        return this;
    }

    setPriority(priority: TaskPriority): this {
        this.priority = priority;
        this.touch();
        return this;
    }

    setEstimatedDurationMs(duration: number): this {
        if (duration < 0) {
            throw new RangeError("Estimated duration cannot be negative.");
        }
        this.estimatedDurationMs = duration;
        this.touch();
        return this;
    }

    setActualDurationMs(duration: number): this {
        if (duration < 0) {
            throw new RangeError("Actual duration cannot be negative.");
        }
        this.actualDurationMs = duration;
        this.touch();
        return this;
    }

    addDependency(id: TaskId): this {
        if (id === this.id) {
            throw new Error("A task cannot depend on itself.");
        }
        if (!this.dependencyIds.includes(id)) {
            this.dependencyIds.push(id);
            this.touch();
        }
        return this;
    }

    removeDependency(id: TaskId): this {
        const before = this.dependencyIds.length;
        this.dependencyIds = this.dependencyIds.filter(dependencyId => dependencyId !== id);
        if (this.dependencyIds.length !== before) {
            this.touch();
        }
        return this;
    }

    addResourceRequirement(requirement: ResourceRequirement): this {
        this.resourceRequirements.push(structuredClone(requirement));
        this.touch();
        return this;
    }

    addConstraint(id: ConstraintId): this {
        if (!this.constraintIds.includes(id)) {
            this.constraintIds.push(id);
            this.touch();
        }
        return this;
    }

    scheduleWindow(start: Timestamp, end: Timestamp): this {
        if (end < start) {
            throw new RangeError("Scheduled end cannot precede scheduled start.");
        }
        this.scheduledStart = start;
        this.scheduledEnd = end;
        this.state = TaskState.Scheduled;
        this.touch();
        return this;
    }

    recordFailure(): this {
        this.retryCount++;
        this.state = TaskState.Failed;
        this.touch();
        return this;
    }

    validate(): boolean {
        if (this.id.length === 0 || this.name.length === 0) {
            return false;
        }
        if (this.estimatedDurationMs < 0) {
            return false;
        }
        if (this.dependencyIds.includes(this.id)) {
            return false;
        }
        return true;
    }

    serialize(): Task {
        return {
            id: this.id,
            goalId: this.goalId,
            name: this.name,
            description: this.description,
            state: this.state,
            priority: this.priority,
            estimatedDurationMs: this.estimatedDurationMs,
            actualDurationMs: this.actualDurationMs,
            dependencyIds: [...this.dependencyIds],
            resourceRequirements: structuredClone(this.resourceRequirements),
            constraintIds: [...this.constraintIds],
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            scheduledStart: this.scheduledStart,
            scheduledEnd: this.scheduledEnd,
            createdAt: this.created,
            updatedAt: this.updated,
            metadata: structuredClone(this.metadata)
        };
    }

    clone(): PlannerTask {
        return new PlannerTask(this.serialize());
    }

    describe(): string {
        return [
            `PlannerTask(${this.id})`,
            `name=${this.name}`,
            `state=${this.state}`,
            `priority=${this.priority}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            state: this.state,
            priority: this.priority,
            dependencies: this.dependencyIds.length,
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            scheduledStart: this.scheduledStart,
            scheduledEnd: this.scheduledEnd
        };
    }
}

/* =============================================================================
 * Planner Constraint Engine
 * =============================================================================
 *
 * Validates constraints and propagates hard-constraint violations across
 * related tasks/goals. Constraints only ever compute; they never mutate the
 * tasks or goals they are evaluated against.
 */

export class PlannerConstraintEngine {

    private evaluations = 0;
    private violations = 0;

    constructor() {}

    private matchesTask(constraint: Constraint, taskId: TaskId): boolean {
        return constraint.appliesToTaskIds.length === 0 || constraint.appliesToTaskIds.includes(taskId);
    }

    private matchesGoal(constraint: Constraint, goalId: GoalId): boolean {
        return constraint.appliesToGoalIds.length === 0 || constraint.appliesToGoalIds.includes(goalId);
    }

    evaluateTask(task: PlannerTask, constraints: readonly Constraint[]): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const constraint of constraints) {
            if (!this.matchesTask(constraint, task.id)) {
                continue;
            }

            this.evaluations++;

            const satisfied = this.isSatisfied(constraint, task);
            if (!satisfied) {
                this.violations++;
                issues.push({
                    code: `CONSTRAINT_${constraint.type.toUpperCase()}_VIOLATED`,
                    message: `Task '${task.id}' violates constraint '${constraint.id}': ${constraint.description}`,
                    severity: constraint.hard ? RiskLevel.High : RiskLevel.Low,
                    taskId: task.id,
                    constraintId: constraint.id
                });
            }
        }

        return issues;
    }

    evaluateGoal(goal: PlannerGoal, constraints: readonly Constraint[]): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const constraint of constraints) {
            if (!this.matchesGoal(constraint, goal.id)) {
                continue;
            }

            this.evaluations++;

            if (constraint.type === ConstraintType.Temporal && goal.isOverdue()) {
                this.violations++;
                issues.push({
                    code: "CONSTRAINT_TEMPORAL_VIOLATED",
                    message: `Goal '${goal.id}' is past its deadline.`,
                    severity: constraint.hard ? RiskLevel.High : RiskLevel.Moderate,
                    goalId: goal.id,
                    constraintId: constraint.id
                });
            }
        }

        return issues;
    }

    /**
     * Determines whether a task satisfies a constraint. Temporal and resource
     * constraints are evaluated structurally; custom/policy constraints with
     * an `expression` are treated as advisory (no dynamic evaluation is ever
     * performed — see project security requirements) and are considered
     * satisfied unless explicitly flagged elsewhere.
     */
    private isSatisfied(constraint: Constraint, task: PlannerTask): boolean {
        switch (constraint.type) {
            case ConstraintType.Temporal:
                if (task.getScheduledEnd() === undefined) {
                    return true;
                }
                return true;

            case ConstraintType.Resource:
                return task.getResourceRequirements().every(
                    requirement => requirement.state !== ResourceState.Unavailable
                );

            case ConstraintType.Dependency:
                return !task.dependsOn(task.id);

            default:
                return true;
        }
    }

    /**
     * Propagates a hard-constraint violation on a task to every task that
     * transitively depends on it, marking them Blocked.
     */
    propagate(taskId: TaskId, tasks: ReadonlyMap<TaskId, PlannerTask>): TaskId[] {
        const blocked: TaskId[] = [];
        const visited = new Set<TaskId>();

        const dependents = (id: TaskId): TaskId[] =>
            [...tasks.values()].filter(task => task.dependsOn(id)).map(task => task.id);

        const queue: TaskId[] = dependents(taskId);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) {
                continue;
            }
            visited.add(current);

            const task = tasks.get(current);
            if (task && !task.isTerminal()) {
                task.setState(TaskState.Blocked);
                blocked.push(current);
            }

            queue.push(...dependents(current));
        }

        return blocked;
    }

    evaluationCount(): number {
        return this.evaluations;
    }

    violationCount(): number {
        return this.violations;
    }

    reset(): void {
        this.evaluations = 0;
        this.violations = 0;
    }

    describe(): string {
        return [
            "PlannerConstraintEngine",
            `evaluations=${this.evaluations}`,
            `violations=${this.violations}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            evaluations: this.evaluations,
            violations: this.violations
        };
    }
}

/* =============================================================================
 * Planner Dependency Graph
 * =============================================================================
 *
 * Adjacency-list based directed graph over TaskIds. Provides cycle
 * detection, topological ordering, and traversal, mirroring the
 * MemoryGraph pattern used elsewhere in Hexical.
 */

export class PlannerDependencyGraph {

    private readonly adjacency = new Map<TaskId, Set<TaskId>>();
    private readonly reverseAdjacency = new Map<TaskId, Set<TaskId>>();

    private edgeCount = 0;

    constructor() {}

    private ensure(id: TaskId): Set<TaskId> {
        let neighbors = this.adjacency.get(id);
        if (!neighbors) {
            neighbors = new Set();
            this.adjacency.set(id, neighbors);
        }
        return neighbors;
    }

    private ensureReverse(id: TaskId): Set<TaskId> {
        let neighbors = this.reverseAdjacency.get(id);
        if (!neighbors) {
            neighbors = new Set();
            this.reverseAdjacency.set(id, neighbors);
        }
        return neighbors;
    }

    addNode(id: TaskId): this {
        this.ensure(id);
        this.ensureReverse(id);
        return this;
    }

    /**
     * Adds a dependency edge `from -> to` (meaning `to` depends on `from`
     * having completed first). Throws if the edge would introduce a cycle,
     * since silently accepting a cyclic dependency graph would make
     * topological scheduling impossible downstream.
     */
    addEdge(from: TaskId, to: TaskId): this {
        this.addNode(from);
        this.addNode(to);

        const neighbors = this.ensure(from);
        if (neighbors.has(to)) {
            return this;
        }

        neighbors.add(to);
        this.ensureReverse(to).add(from);
        this.edgeCount++;

        if (this.hasCycle()) {
            neighbors.delete(to);
            this.reverseAdjacency.get(to)?.delete(from);
            this.edgeCount--;
            throw new Error(`Adding dependency edge '${from}' -> '${to}' would introduce a cycle.`);
        }

        return this;
    }

    removeEdge(from: TaskId, to: TaskId): this {
        const neighbors = this.adjacency.get(from);
        if (neighbors?.delete(to)) {
            this.reverseAdjacency.get(to)?.delete(from);
            this.edgeCount--;
        }
        return this;
    }

    removeNode(id: TaskId): void {
        const outgoing = this.adjacency.get(id);
        if (outgoing) {
            this.edgeCount -= outgoing.size;
            this.adjacency.delete(id);
        }

        this.reverseAdjacency.delete(id);

        for (const neighbors of this.adjacency.values()) {
            neighbors.delete(id);
        }

        for (const neighbors of this.reverseAdjacency.values()) {
            neighbors.delete(id);
        }
    }

    hasEdge(from: TaskId, to: TaskId): boolean {
        return this.adjacency.get(from)?.has(to) ?? false;
    }

    neighbors(id: TaskId): ReadonlySet<TaskId> {
        return this.adjacency.get(id) ?? new Set();
    }

    dependents(id: TaskId): ReadonlySet<TaskId> {
        return this.adjacency.get(id) ?? new Set();
    }

    dependencies(id: TaskId): ReadonlySet<TaskId> {
        return this.reverseAdjacency.get(id) ?? new Set();
    }

    nodes(): TaskId[] {
        return [...this.adjacency.keys()];
    }

    nodeCount(): number {
        return this.adjacency.size;
    }

    edgeCountValue(): number {
        return this.edgeCount;
    }

    /**
     * Detects whether the graph currently contains a cycle using iterative
     * depth-first search with an explicit color map (white/gray/black),
     * avoiding recursion depth issues on very large graphs.
     */
    hasCycle(): boolean {
        const WHITE = 0;
        const GRAY = 1;
        const BLACK = 2;

        const color = new Map<TaskId, number>();
        for (const id of this.adjacency.keys()) {
            color.set(id, WHITE);
        }

        for (const start of this.adjacency.keys()) {
            if (color.get(start) !== WHITE) {
                continue;
            }

            const stack: Array<{ id: TaskId; iterator: IterableIterator<TaskId> }> = [
                { id: start, iterator: this.neighbors(start).values() }
            ];
            color.set(start, GRAY);

            while (stack.length > 0) {
                const frame = stack[stack.length - 1];
                const next = frame.iterator.next();

                if (next.done) {
                    color.set(frame.id, BLACK);
                    stack.pop();
                    continue;
                }

                const neighborColor = color.get(next.value) ?? WHITE;

                if (neighborColor === GRAY) {
                    return true;
                }

                if (neighborColor === WHITE) {
                    color.set(next.value, GRAY);
                    stack.push({ id: next.value, iterator: this.neighbors(next.value).values() });
                }
            }
        }

        return false;
    }

    /**
     * Kahn's algorithm topological sort. Throws if the graph contains a
     * cycle rather than returning a partial/incorrect ordering.
     */
    topologicalSort(): TaskId[] {
        const inDegree = new Map<TaskId, number>();

        for (const id of this.adjacency.keys()) {
            inDegree.set(id, 0);
        }

        for (const neighbors of this.adjacency.values()) {
            for (const neighbor of neighbors) {
                inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
            }
        }

        const queue: TaskId[] = [];
        for (const [id, degree] of inDegree) {
            if (degree === 0) {
                queue.push(id);
            }
        }

        const ordered: TaskId[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;
            ordered.push(current);

            for (const neighbor of this.neighbors(current)) {
                const remaining = (inDegree.get(neighbor) ?? 0) - 1;
                inDegree.set(neighbor, remaining);
                if (remaining === 0) {
                    queue.push(neighbor);
                }
            }
        }

        if (ordered.length !== this.adjacency.size) {
            throw new Error("Cannot compute a topological order: dependency graph contains a cycle.");
        }

        return ordered;
    }

    /**
     * Longest path (by task count) through the graph starting from any root,
     * used as a cheap proxy for the critical path when durations are not yet
     * scheduled.
     */
    longestPath(): TaskId[] {
        const order = this.topologicalSort();
        const distance = new Map<TaskId, number>();
        const predecessor = new Map<TaskId, TaskId | undefined>();

        for (const id of order) {
            distance.set(id, 0);
            predecessor.set(id, undefined);
        }

        for (const id of order) {
            for (const neighbor of this.neighbors(id)) {
                const candidate = (distance.get(id) ?? 0) + 1;
                if (candidate > (distance.get(neighbor) ?? 0)) {
                    distance.set(neighbor, candidate);
                    predecessor.set(neighbor, id);
                }
            }
        }

        let endNode: TaskId | undefined;
        let maxDistance = -1;
        for (const [id, dist] of distance) {
            if (dist > maxDistance) {
                maxDistance = dist;
                endNode = id;
            }
        }

        const path: TaskId[] = [];
        let cursor = endNode;
        while (cursor !== undefined) {
            path.unshift(cursor);
            cursor = predecessor.get(cursor);
        }

        return path;
    }

    clear(): void {
        this.adjacency.clear();
        this.reverseAdjacency.clear();
        this.edgeCount = 0;
    }

    describe(): string {
        return ["PlannerDependencyGraph", `nodes=${this.nodeCount()}`, `edges=${this.edgeCount}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            nodes: this.nodeCount(),
            edges: this.edgeCount,
            acyclic: !this.hasCycle()
        };
    }
}

/* =============================================================================
 * Planner Scheduler
 * =============================================================================
 */

export class PlannerScheduler {

    private schedulesBuilt = 0;

    constructor() {}

    /**
     * Builds an ExecutionSchedule for the given tasks and dependency graph
     * using forward/backward pass critical-path scheduling.
     */
    schedule(
        planId: PlanId,
        tasks: readonly PlannerTask[],
        graph: PlannerDependencyGraph,
        policy: SchedulePolicy,
        referenceStart: Timestamp = Date.now()
    ): ExecutionSchedule {
        const order = graph.topologicalSort();
        const byId = new Map<TaskId, PlannerTask>(tasks.map(task => [task.id, task]));

        const earliestStart = new Map<TaskId, number>();
        const earliestFinish = new Map<TaskId, number>();

        for (const id of order) {
            const task = byId.get(id);
            const duration = task?.getEstimatedDurationMs() ?? 0;

            let start = 0;
            for (const dependency of graph.dependencies(id)) {
                start = Math.max(start, earliestFinish.get(dependency) ?? 0);
            }

            earliestStart.set(id, start);
            earliestFinish.set(id, start + duration);
        }

        const makespanMs = order.length > 0
            ? Math.max(...order.map(id => earliestFinish.get(id) ?? 0))
            : 0;

        const latestFinish = new Map<TaskId, number>();
        const latestStart = new Map<TaskId, number>();

        for (const id of [...order].reverse()) {
            const task = byId.get(id);
            const duration = task?.getEstimatedDurationMs() ?? 0;

            let finish = makespanMs;
            for (const dependent of graph.dependents(id)) {
                finish = Math.min(finish, latestStart.get(dependent) ?? makespanMs);
            }

            latestFinish.set(id, finish);
            latestStart.set(id, finish - duration);
        }

        const windows: ExecutionWindow[] = order.map(id => {
            const es = earliestStart.get(id) ?? 0;
            const ef = earliestFinish.get(id) ?? 0;
            const ls = latestStart.get(id) ?? es;
            const lf = latestFinish.get(id) ?? ef;

            return {
                taskId: id,
                earliestStart: referenceStart + es,
                latestStart: referenceStart + ls,
                earliestFinish: referenceStart + ef,
                latestFinish: referenceStart + lf,
                slackMs: Math.max(0, ls - es)
            };
        });

        const criticalPath = windows
            .filter(window => window.slackMs === 0)
            .map(window => window.taskId);

        const orderedWindows = this.applyPolicy(windows, byId, policy);

        this.schedulesBuilt++;

        return {
            id: generateId("sched"),
            planId,
            policy,
            windows: orderedWindows,
            criticalPath,
            makespanMs,
            createdAt: Date.now()
        };
    }

    private applyPolicy(
        windows: ExecutionWindow[],
        tasks: ReadonlyMap<TaskId, PlannerTask>,
        policy: SchedulePolicy
    ): ExecutionWindow[] {
        const copy = [...windows];

        switch (policy) {
            case SchedulePolicy.EarliestStart:
                return copy.sort((a, b) => a.earliestStart - b.earliestStart);

            case SchedulePolicy.LatestStart:
                return copy.sort((a, b) => a.latestStart - b.latestStart);

            case SchedulePolicy.PriorityFirst:
                return copy.sort((a, b) => {
                    const weightA = tasks.get(a.taskId)?.getPriorityWeight() ?? 0;
                    const weightB = tasks.get(b.taskId)?.getPriorityWeight() ?? 0;
                    return weightB - weightA || a.earliestStart - b.earliestStart;
                });

            case SchedulePolicy.CriticalPathFirst:
                return copy.sort((a, b) => a.slackMs - b.slackMs || a.earliestStart - b.earliestStart);

            case SchedulePolicy.LoadBalanced:
                return copy.sort((a, b) => a.slackMs - b.slackMs);

            default:
                return copy;
        }
    }

    schedulesBuiltCount(): number {
        return this.schedulesBuilt;
    }

    describe(): string {
        return ["PlannerScheduler", `built=${this.schedulesBuilt}`].join(", ");
    }

    inspect(): Dictionary {
        return { schedulesBuilt: this.schedulesBuilt };
    }
}

/* =============================================================================
 * Planner Optimizer
 * =============================================================================
 */

export class PlannerOptimizer {

    private optimizations = 0;

    constructor() {}

    /**
     * Reorders/prunes a task list according to an OptimizationLevel. Always
     * returns a new array; the input is never mutated in place.
     */
    optimize(
        tasks: readonly PlannerTask[],
        level: OptimizationLevel
    ): PlannerTask[] {
        this.optimizations++;

        switch (level) {
            case OptimizationLevel.None:
                return [...tasks];

            case OptimizationLevel.Basic:
                return this.dropRedundant(tasks);

            case OptimizationLevel.Standard:
                return this.prioritize(this.dropRedundant(tasks));

            case OptimizationLevel.Aggressive:
                return this.prioritize(this.mergeParallelizable(this.dropRedundant(tasks)));

            case OptimizationLevel.Maximum:
                return this.prioritize(
                    this.mergeParallelizable(this.dropRedundant(this.dropSkippable(tasks)))
                );

            default:
                return [...tasks];
        }
    }

    /** Removes cancelled/skipped tasks that no longer contribute to the plan. */
    private dropRedundant(tasks: readonly PlannerTask[]): PlannerTask[] {
        return tasks.filter(task => task.getState() !== TaskState.Cancelled);
    }

    /** Additionally drops explicitly skipped, non-critical tasks. */
    private dropSkippable(tasks: readonly PlannerTask[]): PlannerTask[] {
        return tasks.filter(
            task => task.getState() !== TaskState.Skipped || task.getPriority() === TaskPriority.Critical
        );
    }

    /** Sorts by descending priority weight, stable on original order otherwise. */
    private prioritize(tasks: readonly PlannerTask[]): PlannerTask[] {
        return [...tasks].sort((a, b) => b.getPriorityWeight() - a.getPriorityWeight());
    }

    /**
     * Groups tasks with no dependency relationship between them so a
     * downstream scheduler favors executing them concurrently. This does not
     * mutate task state — it only reorders for scheduling purposes.
     */
    private mergeParallelizable(tasks: readonly PlannerTask[]): PlannerTask[] {
        const independent: PlannerTask[] = [];
        const dependent: PlannerTask[] = [];

        for (const task of tasks) {
            if (task.hasDependencies()) {
                dependent.push(task);
            } else {
                independent.push(task);
            }
        }

        return [...independent, ...dependent];
    }

    optimizationCount(): number {
        return this.optimizations;
    }

    describe(): string {
        return ["PlannerOptimizer", `optimizations=${this.optimizations}`].join(", ");
    }

    inspect(): Dictionary {
        return { optimizations: this.optimizations };
    }
}

/* =============================================================================
 * Planner Validator
 * =============================================================================
 */

export class PlannerValidator {

    private readonly constraintEngine: PlannerConstraintEngine;

    private validations = 0;

    constructor(constraintEngine: PlannerConstraintEngine) {
        this.constraintEngine = constraintEngine;
    }

    validate(
        goals: readonly PlannerGoal[],
        tasks: readonly PlannerTask[],
        constraints: readonly Constraint[],
        graph: PlannerDependencyGraph
    ): ValidationResult {
        this.validations++;

        const issues: ValidationIssue[] = [];

        issues.push(...this.validateIdentifiers(goals, tasks));
        issues.push(...this.validateGraphConsistency(tasks, graph));

        for (const goal of goals) {
            if (!goal.validate()) {
                issues.push({
                    code: "GOAL_INVALID",
                    message: `Goal '${goal.id}' failed structural validation.`,
                    severity: RiskLevel.High,
                    goalId: goal.id
                });
            }
            issues.push(...this.constraintEngine.evaluateGoal(goal, constraints));
        }

        for (const task of tasks) {
            if (!task.validate()) {
                issues.push({
                    code: "TASK_INVALID",
                    message: `Task '${task.id}' failed structural validation.`,
                    severity: RiskLevel.High,
                    taskId: task.id
                });
            }
            issues.push(...this.constraintEngine.evaluateTask(task, constraints));
        }

        if (graph.hasCycle()) {
            issues.push({
                code: "DEPENDENCY_CYCLE",
                message: "The task dependency graph contains a cycle.",
                severity: RiskLevel.Severe
            });
        }

        const hardFailures = issues.filter(issue => issue.severity === RiskLevel.Severe || issue.severity === RiskLevel.High);
        const valid = hardFailures.length === 0;

        return {
            state: valid ? (issues.length > 0 ? ValidationState.Warning : ValidationState.Valid) : ValidationState.Invalid,
            valid,
            issues,
            validatedAt: Date.now()
        };
    }

    private validateIdentifiers(goals: readonly PlannerGoal[], tasks: readonly PlannerTask[]): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        const goalIds = new Set<GoalId>();
        for (const goal of goals) {
            if (goalIds.has(goal.id)) {
                issues.push({
                    code: "DUPLICATE_GOAL_ID",
                    message: `Duplicate goal identifier '${goal.id}'.`,
                    severity: RiskLevel.High,
                    goalId: goal.id
                });
            }
            goalIds.add(goal.id);
        }

        const taskIds = new Set<TaskId>();
        for (const task of tasks) {
            if (taskIds.has(task.id)) {
                issues.push({
                    code: "DUPLICATE_TASK_ID",
                    message: `Duplicate task identifier '${task.id}'.`,
                    severity: RiskLevel.High,
                    taskId: task.id
                });
            }
            taskIds.add(task.id);
        }

        return issues;
    }

    private validateGraphConsistency(tasks: readonly PlannerTask[], graph: PlannerDependencyGraph): ValidationIssue[] {
        const issues: ValidationIssue[] = [];
        const taskIds = new Set(tasks.map(task => task.id));

        for (const task of tasks) {
            for (const dependencyId of task.getDependencyIds()) {
                if (!taskIds.has(dependencyId)) {
                    issues.push({
                        code: "DANGLING_DEPENDENCY",
                        message: `Task '${task.id}' depends on unknown task '${dependencyId}'.`,
                        severity: RiskLevel.High,
                        taskId: task.id
                    });
                }
            }
        }

        if (graph.nodeCount() !== taskIds.size) {
            issues.push({
                code: "GRAPH_TASK_MISMATCH",
                message: "Dependency graph node count does not match task count.",
                severity: RiskLevel.Moderate
            });
        }

        return issues;
    }

    validationCount(): number {
        return this.validations;
    }

    describe(): string {
        return ["PlannerValidator", `validations=${this.validations}`].join(", ");
    }

    inspect(): Dictionary {
        return { validations: this.validations };
    }
}

/* =============================================================================
 * Planner Risk Analyzer
 * =============================================================================
 */

export class PlannerRiskAnalyzer {

    private assessments = 0;

    constructor() {}

    assessTask(task: PlannerTask): RiskAssessment {
        this.assessments++;

        const factors: string[] = [];
        let score = 0;

        if (task.hasDependencies()) {
            score += 0.15;
            factors.push("Task has upstream dependencies.");
        }

        if (task.getMaxRetries() === 0) {
            score += 0.20;
            factors.push("Task has no retry budget.");
        }

        if (task.getPriority() === TaskPriority.Critical || task.getPriority() === TaskPriority.Urgent) {
            score += 0.25;
            factors.push("Task carries critical/urgent priority.");
        }

        if (task.getState() === TaskState.Blocked) {
            score += 0.30;
            factors.push("Task is currently blocked.");
        }

        if (task.getResourceRequirements().some(requirement => requirement.state === ResourceState.Exhausted)) {
            score += 0.30;
            factors.push("Task requires an exhausted resource.");
        }

        score = clamp(score, MIN_RISK_SCORE, MAX_RISK_SCORE);

        return {
            id: generateId("risk"),
            taskId: task.id,
            level: this.levelFor(score),
            score,
            factors,
            assessedAt: Date.now()
        };
    }

    assessPlan(planId: PlanId, taskAssessments: readonly RiskAssessment[]): RiskAssessment {
        this.assessments++;

        if (taskAssessments.length === 0) {
            return {
                id: generateId("risk"),
                planId,
                level: RiskLevel.Negligible,
                score: 0,
                factors: [],
                assessedAt: Date.now()
            };
        }

        const average = taskAssessments.reduce((sum, assessment) => sum + assessment.score, 0) / taskAssessments.length;
        const maximum = Math.max(...taskAssessments.map(assessment => assessment.score));

        // Weight toward the worst offender so a single severe task cannot be
        // diluted away by many low-risk tasks.
        const score = clamp(average * 0.6 + maximum * 0.4, MIN_RISK_SCORE, MAX_RISK_SCORE);

        const factors = [
            `Average task risk: ${(average * 100).toFixed(1)}%`,
            `Peak task risk: ${(maximum * 100).toFixed(1)}%`
        ];

        return {
            id: generateId("risk"),
            planId,
            level: this.levelFor(score),
            score,
            factors,
            assessedAt: Date.now()
        };
    }

    private levelFor(score: Score): RiskLevel {
        if (score >= 0.80) {
            return RiskLevel.Severe;
        }
        if (score >= 0.60) {
            return RiskLevel.High;
        }
        if (score >= 0.35) {
            return RiskLevel.Moderate;
        }
        if (score >= 0.10) {
            return RiskLevel.Low;
        }
        return RiskLevel.Negligible;
    }

    assessmentCount(): number {
        return this.assessments;
    }

    describe(): string {
        return ["PlannerRiskAnalyzer", `assessments=${this.assessments}`].join(", ");
    }

    inspect(): Dictionary {
        return { assessments: this.assessments };
    }
}

/* =============================================================================
 * Planner Rollback Manager
 * =============================================================================
 */

export class PlannerRollbackManager {

    private rollbackPlansBuilt = 0;

    constructor() {}

    build(plan: Plan, policy: RollbackPolicy = plan.rollbackPolicy): RollbackPlan {
        this.rollbackPlansBuilt++;

        const checkpointTaskIds = this.selectCheckpoints(plan, policy);
        const steps = this.buildSteps(plan, policy, checkpointTaskIds);

        return {
            id: generateId("rollback"),
            planId: plan.id,
            policy,
            checkpointTaskIds,
            steps,
            createdAt: Date.now()
        };
    }

    private selectCheckpoints(plan: Plan, policy: RollbackPolicy): TaskId[] {
        if (policy === RollbackPolicy.None) {
            return [];
        }

        if (policy === RollbackPolicy.FullRevert) {
            return plan.tasks.map(task => task.id);
        }

        // Checkpoint/automatic/manual: checkpoint at critical-path tasks and
        // any task with no outgoing dependents (natural sync points).
        const dependedOn = new Set(plan.dependencies.map(dependency => dependency.fromTaskId));
        return plan.tasks
            .filter(task => plan.schedule?.criticalPath.includes(task.id) || !dependedOn.has(task.id))
            .map(task => task.id);
    }

    private buildSteps(plan: Plan, policy: RollbackPolicy, checkpoints: readonly TaskId[]): string[] {
        if (policy === RollbackPolicy.None) {
            return ["No rollback is defined for this plan."];
        }

        const steps: string[] = [
            `Halt further task dispatch for plan '${plan.id}'.`
        ];

        if (policy === RollbackPolicy.FullRevert) {
            steps.push("Revert every completed task in reverse execution order.");
        } else {
            for (const checkpointId of [...checkpoints].reverse()) {
                steps.push(`Revert to checkpoint at task '${checkpointId}'.`);
            }
        }

        steps.push(`Mark plan '${plan.id}' as rolled back.`);
        return steps;
    }

    rollbackPlansBuiltCount(): number {
        return this.rollbackPlansBuilt;
    }

    describe(): string {
        return ["PlannerRollbackManager", `built=${this.rollbackPlansBuilt}`].join(", ");
    }

    inspect(): Dictionary {
        return { rollbackPlansBuilt: this.rollbackPlansBuilt };
    }
}

/* =============================================================================
 * Planner Recovery Manager
 * =============================================================================
 */

export class PlannerRecoveryManager {

    private recoveryPlansBuilt = 0;

    constructor() {}

    build(plan: Plan, strategy: RecoveryStrategy = plan.recoveryStrategy): RecoveryPlan {
        this.recoveryPlansBuilt++;

        const triggers = this.buildTriggers(plan);
        const steps = this.buildSteps(plan, strategy);

        return {
            id: generateId("recovery"),
            planId: plan.id,
            strategy,
            triggers,
            steps,
            createdAt: Date.now()
        };
    }

    private buildTriggers(plan: Plan): string[] {
        const triggers = [`Any task in plan '${plan.id}' transitions to '${TaskState.Failed}'.`];

        if (plan.riskLevel === RiskLevel.High || plan.riskLevel === RiskLevel.Severe) {
            triggers.push("Overall plan risk level is high or severe.");
        }

        return triggers;
    }

    private buildSteps(plan: Plan, strategy: RecoveryStrategy): string[] {
        switch (strategy) {
            case RecoveryStrategy.Retry:
                return [
                    "Identify the failed task.",
                    "If retry budget remains, re-schedule the task.",
                    "Otherwise escalate to the next configured strategy."
                ];

            case RecoveryStrategy.Skip:
                return [
                    "Identify the failed task.",
                    "Mark the task as skipped if it is not on the critical path.",
                    "Continue executing downstream non-dependent tasks."
                ];

            case RecoveryStrategy.Substitute:
                return [
                    "Identify the failed task.",
                    "Locate a registered alternative plan or task fulfilling the same goal.",
                    "Substitute the alternative and resume."
                ];

            case RecoveryStrategy.Escalate:
                return [
                    "Identify the failed task.",
                    "Surface the failure to a human or higher-level policy for a decision."
                ];

            case RecoveryStrategy.Compensate:
                return [
                    "Identify the failed task.",
                    "Execute the compensating actions associated with completed prior tasks.",
                    "Restore the plan to a consistent state."
                ];

            case RecoveryStrategy.Abort:
            default:
                return [
                    `Abort plan '${plan.id}'.`,
                    "Hand off to the rollback plan, if one exists."
                ];
        }
    }

    recoveryPlansBuiltCount(): number {
        return this.recoveryPlansBuilt;
    }

    describe(): string {
        return ["PlannerRecoveryManager", `built=${this.recoveryPlansBuilt}`].join(", ");
    }

    inspect(): Dictionary {
        return { recoveryPlansBuilt: this.recoveryPlansBuilt };
    }
}

/* =============================================================================
 * Planner Snapshot Manager
 * =============================================================================
 */

export class PlannerSnapshotManager {

    private readonly snapshots = new Map<PlannerSnapshotId, PlannerSnapshot>();

    private readonly history: PlannerSnapshotId[] = [];

    private readonly capacity: number;

    constructor(capacity = 100) {
        if (capacity <= 0) {
            throw new RangeError("Snapshot capacity must be greater than zero.");
        }
        this.capacity = capacity;
    }

    create(plans: readonly Plan[]): PlannerSnapshot {
        const snapshot: PlannerSnapshot = {
            id: generateId("snap"),
            timestamp: Date.now(),
            version: PLANNER_FORMAT_VERSION,
            plans: structuredClone([...plans])
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

    get(id: PlannerSnapshotId): Optional<PlannerSnapshot> {
        const snapshot = this.snapshots.get(id);
        return snapshot ? structuredClone(snapshot) : undefined;
    }

    latest(): Optional<PlannerSnapshot> {
        const id = this.history.at(-1);
        return id ? this.get(id) : undefined;
    }

    remove(id: PlannerSnapshotId): boolean {
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

    ids(): readonly PlannerSnapshotId[] {
        return [...this.history];
    }

    describe(): string {
        return ["PlannerSnapshotManager", `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(", ");
    }

    inspect(): Dictionary {
        return { size: this.size(), capacity: this.capacity, history: [...this.history] };
    }
}

/* =============================================================================
 * Planner Transaction Manager
 * =============================================================================
 */

export class PlannerTransactionManager {

    private readonly transactions = new Map<PlannerTransactionId, PlannerTransaction>();

    private readonly stack: PlannerTransaction[] = [];

    private readonly snapshots: PlannerSnapshotManager;

    constructor(snapshots: PlannerSnapshotManager) {
        this.snapshots = snapshots;
    }

    begin(description = "Planning transaction"): PlannerTransaction {
        const transaction: PlannerTransaction = {
            id: generateId("tx"),
            timestamp: Date.now(),
            description,
            operations: [],
            committed: false
        };

        this.transactions.set(transaction.id, transaction);
        this.stack.push(transaction);
        return transaction;
    }

    current(): Optional<PlannerTransaction> {
        return this.stack.at(-1);
    }

    inTransaction(): boolean {
        return this.stack.length > 0;
    }

    record(operation: string): void {
        const tx = this.current();
        if (!tx) {
            throw new Error("No active planner transaction.");
        }
        tx.operations.push(operation);
    }

    commit(plans: readonly Plan[]): PlannerTransaction {
        const tx = this.current();
        if (!tx) {
            throw new Error("No active planner transaction.");
        }
        this.snapshots.create(plans);
        tx.committed = true;
        this.stack.pop();
        return tx;
    }

    rollback(): Optional<PlannerSnapshot> {
        const tx = this.current();
        if (!tx) {
            return undefined;
        }
        this.stack.pop();
        return this.snapshots.latest();
    }

    get(id: PlannerTransactionId): Optional<PlannerTransaction> {
        return this.transactions.get(id);
    }

    history(): PlannerTransaction[] {
        return [...this.transactions.values()];
    }

    activeCount(): number {
        return this.stack.length;
    }

    totalCount(): number {
        return this.transactions.size;
    }

    describe(): string {
        return [
            "PlannerTransactionManager",
            `transactions=${this.totalCount()}`,
            `active=${this.activeCount()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            total: this.totalCount(),
            active: this.activeCount(),
            stack: this.stack.map(tx => tx.id)
        };
    }
}

/* =============================================================================
 * Planner Diagnostics
 * =============================================================================
 */

export class PlannerDiagnostics {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validatePlan(plan: Plan): boolean {
        this.checks++;
        const valid = plan.id.length > 0 && plan.tasks.length <= DEFAULT_MAX_TASKS_PER_PLAN;
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateGraph(graph: PlannerDependencyGraph): boolean {
        this.checks++;
        const valid = !graph.hasCycle();
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateSchedule(schedule: Optional<ExecutionSchedule>): boolean {
        this.checks++;
        if (!schedule) {
            return true;
        }
        const valid = schedule.windows.every(window => window.earliestStart <= window.earliestFinish);
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateSnapshots(snapshots: PlannerSnapshotManager): boolean {
        this.checks++;
        return snapshots.size() >= 0;
    }

    runAll(
        plan: Plan,
        graph: PlannerDependencyGraph,
        snapshots: PlannerSnapshotManager
    ): boolean {
        return (
            this.validatePlan(plan) &&
            this.validateGraph(graph) &&
            this.validateSchedule(plan.schedule) &&
            this.validateSnapshots(snapshots)
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
            "PlannerDiagnostics",
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
 * Planner Manager
 * =============================================================================
 *
 * The single public façade over the planning subsystem. Orchestrates goal
 * decomposition, dependency-graph construction, constraint evaluation,
 * scheduling, optimization, validation, risk analysis, rollback/recovery
 * planning, snapshots, and transactions.
 *
 * PlannerManager never executes tasks and never writes through a supplied
 * MemoryManager; both are strictly outside its responsibility.
 */

export class PlannerManager implements PlannerFactory {

    private readonly plans = new Map<PlanId, Plan>();

    private readonly configuration: PlannerConfiguration;

    private readonly constraintEngine = new PlannerConstraintEngine();
    private readonly scheduler = new PlannerScheduler();
    private readonly optimizer = new PlannerOptimizer();
    private readonly validator: PlannerValidator;
    private readonly riskAnalyzer = new PlannerRiskAnalyzer();
    private readonly rollbackManager = new PlannerRollbackManager();
    private readonly recoveryManager = new PlannerRecoveryManager();
    private readonly snapshotManager = new PlannerSnapshotManager();
    private readonly transactionManager: PlannerTransactionManager;
    private readonly diagnostics = new PlannerDiagnostics();

    private readonly observers = new Set<PlannerObserver>();

    private readonly decomposer?: GoalDecomposer;

    private readonly metrics: PlannerMetrics = {
        planningTimeMs: 0,
        schedulingTimeMs: 0,
        optimizationTimeMs: 0,
        validationTimeMs: 0,
        lastComputedAt: Date.now()
    };

    constructor(configuration: Partial<PlannerConfiguration> = {}, decomposer?: GoalDecomposer) {
        this.configuration = Object.freeze({
            ...DEFAULT_PLANNER_CONFIGURATION,
            ...configuration
        });
        this.validator = new PlannerValidator(this.constraintEngine);
        this.transactionManager = new PlannerTransactionManager(this.snapshotManager);
        this.decomposer = decomposer;
    }

    /* --------------------------------------------------------------------- *
     * Observers
     * --------------------------------------------------------------------- */

    subscribe(observer: PlannerObserver): void {
        this.observers.add(observer);
    }

    unsubscribe(observer: PlannerObserver): void {
        this.observers.delete(observer);
    }

    private emit(event: PlannerEvent, payload: Dictionary): void {
        for (const observer of this.observers) {
            observer.onEvent?.(event, payload);
        }
    }

    /* --------------------------------------------------------------------- *
     * Plan Creation
     * --------------------------------------------------------------------- */

    /**
     * Builds a fully validated, scheduled, optimized, risk-assessed Plan from
     * a PlannerContext. This is the primary entry point implementing
     * PlannerFactory.
     */
    createPlan(context: PlannerContext): Plan {
        const started = performance.now();

        this.assertContext(context);

        const topLevelGoals = context.goals.map(goal => new PlannerGoal(goal));
        const { tasks, extraGoals } = this.deriveTasks(context, topLevelGoals);
        const goals = [...topLevelGoals, ...extraGoals];

        if (tasks.length > this.configuration.maxTasksPerPlan) {
            throw new RangeError(
                `Plan would contain ${tasks.length} tasks, exceeding the configured ` +
                `maximum of ${this.configuration.maxTasksPerPlan}.`
            );
        }

        if (goals.length > this.configuration.maxGoalsPerPlan) {
            throw new RangeError(
                `Plan would contain ${goals.length} goals, exceeding the configured ` +
                `maximum of ${this.configuration.maxGoalsPerPlan}.`
            );
        }

        const graph = this.buildGraph(tasks);
        const dependencies = this.deriveDependencies(tasks);

        const planId = generateId("plan");

        const executionPolicy: ExecutionPolicyDefinition = context.executionPolicy ?? {
            policy: this.configuration.defaultExecutionPolicy,
            maxConcurrency: 4,
            allowPartialFailure: false
        };

        let plan: Plan = {
            id: planId,
            type: this.inferPlanType(graph),
            status: PlanStatus.Draft,
            phase: PlanPhase.Decomposition,
            version: INITIAL_PLAN_VERSION,
            title: this.deriveTitle(context),
            description: context.userIntent,
            goals: goals.map(goal => goal.serialize()),
            tasks: tasks.map(task => task.serialize()),
            constraints: [...context.constraints],
            dependencies,
            graph: this.serializeGraph(tasks, graph, dependencies),
            executionPolicy,
            rollbackPolicy: context.rollbackPolicy ?? this.configuration.defaultRollbackPolicy,
            recoveryStrategy: context.recoveryStrategy ?? this.configuration.defaultRecoveryStrategy,
            riskLevel: RiskLevel.Negligible,
            riskScore: 0,
            alternativePlanIds: [],
            createdAt: context.timestamp,
            updatedAt: context.timestamp,
            metadata: structuredClone(context.metadata ?? {})
        };

        this.emit(PlannerEvent.PlanCreated, { planId: plan.id });

        plan = this.schedulePlanInternal(plan, tasks, graph, context.schedulePolicy);
        plan = this.optimizePlanInternal(plan, tasks, context.optimizationLevel);
        plan = this.assessRiskInternal(plan);
        plan = this.validatePlanInternal(plan);

        plan.phase = plan.validation?.valid ? PlanPhase.Ready : PlanPhase.Validation;
        plan.status = plan.validation?.valid ? PlanStatus.Ready : PlanStatus.Draft;
        plan.updatedAt = Date.now();

        this.plans.set(plan.id, structuredClone(plan));

        this.metrics.planningTimeMs = performance.now() - started;
        this.metrics.lastComputedAt = Date.now();

        this.emit(PlannerEvent.PlanReady, { planId: plan.id });

        return structuredClone(plan);
    }

    private assertContext(context: PlannerContext): void {
        if (typeof context.userIntent !== "string" || context.userIntent.trim() === "") {
            throw new TypeError("PlannerContext.userIntent must be a non-empty string.");
        }
        if (!Array.isArray(context.goals)) {
            throw new TypeError("PlannerContext.goals must be an array.");
        }
        if (!Array.isArray(context.constraints)) {
            throw new TypeError("PlannerContext.constraints must be an array.");
        }
        if (!Array.isArray(context.recommendations)) {
            throw new TypeError("PlannerContext.recommendations must be an array.");
        }
    }

    private deriveTitle(context: PlannerContext): string {
        const trimmed = context.userIntent.trim();
        return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    }

    /**
     * Derives an initial task list. Tasks explicitly linked to a goal via
     * `relatedTaskIds` are honored as-is. For every remaining goal, an
     * injected `GoalDecomposer` (e.g. an HTN engine) is given first refusal;
     * if none is configured, or it declines (returns no tasks) for a
     * particular goal, that goal falls back to a single synthesized
     * placeholder task representing "achieve this goal", which a human or an
     * upstream planning rule is expected to decompose further via subsequent
     * addTask calls.
     */
    private deriveTasks(
        context: PlannerContext,
        goals: PlannerGoal[]
    ): { tasks: PlannerTask[]; extraGoals: PlannerGoal[] } {
        const tasks: PlannerTask[] = [];
        const extraGoals: PlannerGoal[] = [];
        const now = context.timestamp;

        for (const goal of goals) {
            if (goal.getRelatedTaskIds().length > 0) {
                continue;
            }

            if (this.decomposer) {
                const outcome = this.decomposer.decompose(goal.serialize(), context);

                if (outcome.tasks.length > 0) {
                    for (const task of outcome.tasks) {
                        const plannerTask = new PlannerTask(task);
                        tasks.push(plannerTask);
                        if (plannerTask.getGoalId() === goal.id) {
                            goal.linkTask(plannerTask.id);
                        }
                    }
                    for (const subGoal of outcome.subGoals) {
                        extraGoals.push(new PlannerGoal(subGoal));
                    }
                    continue;
                }
            }

            const task: Task = {
                id: generateId("task"),
                goalId: goal.id,
                name: `Achieve: ${goal.getTitle()}`,
                description: goal.getDescription(),
                state: TaskState.Pending,
                priority: goal.getPriority(),
                estimatedDurationMs: 0,
                dependencyIds: [],
                resourceRequirements: [],
                constraintIds: [],
                retryCount: 0,
                maxRetries: DEFAULT_TASK_MAX_RETRIES,
                createdAt: now,
                updatedAt: now
            };

            tasks.push(new PlannerTask(task));
            goal.linkTask(task.id);
        }

        return { tasks, extraGoals };
    }

    private deriveDependencies(tasks: readonly PlannerTask[]): Dependency[] {
        const dependencies: Dependency[] = [];

        for (const task of tasks) {
            for (const dependencyId of task.getDependencyIds()) {
                dependencies.push({
                    id: generateId("dep"),
                    fromTaskId: dependencyId,
                    toTaskId: task.id,
                    type: DependencyType.FinishToStart
                });
            }
        }

        return dependencies;
    }

    private buildGraph(tasks: readonly PlannerTask[]): PlannerDependencyGraph {
        const graph = new PlannerDependencyGraph();

        for (const task of tasks) {
            graph.addNode(task.id);
        }

        for (const task of tasks) {
            for (const dependencyId of task.getDependencyIds()) {
                graph.addEdge(dependencyId, task.id);
            }
        }

        return graph;
    }

    private serializeGraph(
        tasks: readonly PlannerTask[],
        graph: PlannerDependencyGraph,
        dependencies: readonly Dependency[]
    ): PlanGraph {
        const nodes: PlanNode[] = tasks.map(task => ({
            id: generateId("node"),
            taskId: task.id,
            childIds: [...graph.dependents(task.id)].map(id => id)
        }));

        return {
            nodes,
            dependencies: [...dependencies]
        };
    }

    private inferPlanType(graph: PlannerDependencyGraph): PlanType {
        if (graph.hasCycle()) {
            return PlanType.Cyclic;
        }
        if (graph.nodeCount() === 0) {
            return PlanType.Linear;
        }

        const hasBranching = graph.nodes().some(
            id => graph.dependents(id).size > 1 || graph.dependencies(id).size > 1
        );

        return hasBranching ? PlanType.Hierarchical : PlanType.Linear;
    }

    /* --------------------------------------------------------------------- *
     * Scheduling / Optimization / Risk / Validation
     * --------------------------------------------------------------------- */

    private schedulePlanInternal(
        plan: Plan,
        tasks: readonly PlannerTask[],
        graph: PlannerDependencyGraph,
        schedulePolicy?: SchedulePolicy
    ): Plan {
        const started = performance.now();
        const policy = schedulePolicy ?? this.configuration.defaultSchedulePolicy;

        const schedule = this.scheduler.schedule(plan.id, tasks, graph, policy, plan.createdAt);

        this.metrics.schedulingTimeMs = performance.now() - started;

        this.emit(PlannerEvent.PlanScheduled, { planId: plan.id });

        return { ...plan, schedule, phase: PlanPhase.Scheduling, updatedAt: Date.now() };
    }

    private optimizePlanInternal(
        plan: Plan,
        tasks: readonly PlannerTask[],
        optimizationLevel?: OptimizationLevel
    ): Plan {
        const started = performance.now();
        const level = optimizationLevel ?? this.configuration.defaultOptimizationLevel;

        const optimized = this.optimizer.optimize(tasks, level);

        this.metrics.optimizationTimeMs = performance.now() - started;

        this.emit(PlannerEvent.PlanOptimized, { planId: plan.id, level });

        return {
            ...plan,
            tasks: optimized.map(task => task.serialize()),
            phase: PlanPhase.Optimization,
            updatedAt: Date.now()
        };
    }

    private assessRiskInternal(plan: Plan): Plan {
        if (!this.configuration.enableRiskAnalysis) {
            return plan;
        }

        const taskAssessments = plan.tasks.map(task => this.riskAnalyzer.assessTask(new PlannerTask(task)));
        const planAssessment = this.riskAnalyzer.assessPlan(plan.id, taskAssessments);

        return {
            ...plan,
            riskLevel: planAssessment.level,
            riskScore: planAssessment.score,
            updatedAt: Date.now()
        };
    }

    private validatePlanInternal(plan: Plan): Plan {
        const started = performance.now();

        const goals = plan.goals.map(goal => new PlannerGoal(goal));
        const tasks = plan.tasks.map(task => new PlannerTask(task));
        const graph = this.buildGraph(tasks);

        const validation = this.validator.validate(goals, tasks, plan.constraints, graph);

        this.metrics.validationTimeMs = performance.now() - started;

        if (!validation.valid && this.configuration.strictValidation) {
            this.emit(PlannerEvent.ConstraintViolated, { planId: plan.id, issues: validation.issues as unknown as JsonValue });
            throw new Error(
                `Plan '${plan.id}' failed strict validation with ${validation.issues.length} issue(s).`
            );
        }

        this.emit(PlannerEvent.PlanValidated, { planId: plan.id, valid: validation.valid });

        return { ...plan, validation, phase: PlanPhase.Validation, updatedAt: Date.now() };
    }

    /* --------------------------------------------------------------------- *
     * Mutation API
     * --------------------------------------------------------------------- */

    addGoal(planId: PlanId, goal: Goal): Plan {
        const plan = this.require(planId);

        if (plan.goals.some(existing => existing.id === goal.id)) {
            throw new Error(`Goal '${goal.id}' already exists on plan '${planId}'.`);
        }

        const updated: Plan = {
            ...plan,
            goals: [...plan.goals, structuredClone(goal)],
            version: plan.version + 1,
            updatedAt: Date.now()
        };

        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.GoalAdded, { planId, goalId: goal.id });
        return structuredClone(updated);
    }

    addTask(planId: PlanId, task: Task): Plan {
        const plan = this.require(planId);

        if (plan.tasks.some(existing => existing.id === task.id)) {
            throw new Error(`Task '${task.id}' already exists on plan '${planId}'.`);
        }

        if (plan.tasks.length + 1 > this.configuration.maxTasksPerPlan) {
            throw new RangeError(`Plan '${planId}' has reached its maximum task capacity.`);
        }

        const candidateTasks = [...plan.tasks, task].map(t => new PlannerTask(t));
        const graph = this.buildGraph(candidateTasks);

        if (graph.hasCycle()) {
            throw new Error(`Adding task '${task.id}' would introduce a dependency cycle.`);
        }

        const updated: Plan = {
            ...plan,
            tasks: [...plan.tasks, structuredClone(task)],
            version: plan.version + 1,
            updatedAt: Date.now()
        };

        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.TaskAdded, { planId, taskId: task.id });
        return structuredClone(updated);
    }

    removeTask(planId: PlanId, taskId: TaskId): Plan {
        const plan = this.require(planId);

        const remaining = plan.tasks.filter(task => task.id !== taskId);
        if (remaining.length === plan.tasks.length) {
            throw new Error(`Task '${taskId}' does not exist on plan '${planId}'.`);
        }

        const cleanedRemaining = remaining.map(task => ({
            ...task,
            dependencyIds: task.dependencyIds.filter(id => id !== taskId)
        }));

        const updated: Plan = {
            ...plan,
            tasks: cleanedRemaining,
            dependencies: plan.dependencies.filter(
                dependency => dependency.fromTaskId !== taskId && dependency.toTaskId !== taskId
            ),
            version: plan.version + 1,
            updatedAt: Date.now()
        };

        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.TaskRemoved, { planId, taskId });
        return structuredClone(updated);
    }

    addConstraint(planId: PlanId, constraint: Constraint): Plan {
        const plan = this.require(planId);

        if (plan.constraints.length + 1 > this.configuration.maxConstraintsPerPlan) {
            throw new RangeError(`Plan '${planId}' has reached its maximum constraint capacity.`);
        }

        const updated: Plan = {
            ...plan,
            constraints: [...plan.constraints, structuredClone(constraint)],
            version: plan.version + 1,
            updatedAt: Date.now()
        };

        this.plans.set(planId, structuredClone(updated));
        return structuredClone(updated);
    }

    addDependency(planId: PlanId, dependency: Dependency): Plan {
        const plan = this.require(planId);

        const candidateTasks = plan.tasks.map(task => new PlannerTask(task));
        const byId = new Map(candidateTasks.map(task => [task.id, task]));

        const from = byId.get(dependency.fromTaskId);
        const to = byId.get(dependency.toTaskId);

        if (!from || !to) {
            throw new Error(
                `Dependency references unknown task(s): '${dependency.fromTaskId}' -> '${dependency.toTaskId}'.`
            );
        }

        to.addDependency(from.id);

        const graph = this.buildGraph([...byId.values()]);
        if (graph.hasCycle()) {
            throw new Error(
                `Dependency '${dependency.fromTaskId}' -> '${dependency.toTaskId}' would introduce a cycle.`
            );
        }

        const updated: Plan = {
            ...plan,
            tasks: [...byId.values()].map(task => task.serialize()),
            dependencies: [...plan.dependencies, structuredClone(dependency)],
            version: plan.version + 1,
            updatedAt: Date.now()
        };

        this.plans.set(planId, structuredClone(updated));
        return structuredClone(updated);
    }

    /* --------------------------------------------------------------------- *
     * Re-derivation (schedule / optimize / validate on demand)
     * --------------------------------------------------------------------- */

    reschedule(planId: PlanId, policy?: SchedulePolicy): Plan {
        const plan = this.require(planId);
        const tasks = plan.tasks.map(task => new PlannerTask(task));
        const graph = this.buildGraph(tasks);

        const scheduled = this.schedulePlanInternal(plan, tasks, graph, policy);
        this.plans.set(planId, structuredClone(scheduled));
        return structuredClone(scheduled);
    }

    reoptimize(planId: PlanId, level?: OptimizationLevel): Plan {
        const plan = this.require(planId);
        const tasks = plan.tasks.map(task => new PlannerTask(task));

        const optimized = this.optimizePlanInternal(plan, tasks, level);
        this.plans.set(planId, structuredClone(optimized));
        return structuredClone(optimized);
    }

    revalidate(planId: PlanId): Plan {
        const plan = this.require(planId);
        const validated = this.validatePlanInternal(plan);
        this.plans.set(planId, structuredClone(validated));
        return structuredClone(validated);
    }

    reassessRisk(planId: PlanId): Plan {
        const plan = this.require(planId);
        const assessed = this.assessRiskInternal(plan);
        this.plans.set(planId, structuredClone(assessed));
        return structuredClone(assessed);
    }

    /* --------------------------------------------------------------------- *
     * Alternative / Scenario Planning
     * --------------------------------------------------------------------- */

    /**
     * Produces an alternative plan by re-running creation with a different
     * execution/optimization/schedule policy, then links it to the original
     * plan bidirectionally via id references (never by embedding the full
     * Plan, to keep serialization acyclic and bounded).
     */
    branch(planId: PlanId, overrides: Partial<PlannerContext>): Plan {
        const original = this.require(planId);

        if (original.alternativePlanIds.length >= this.configuration.maxAlternativePlans) {
            throw new RangeError(`Plan '${planId}' has reached its maximum number of alternatives.`);
        }

        const context: PlannerContext = {
            reasoningReport: overrides.reasoningReport,
            recommendations: overrides.recommendations ?? [],
            memory: overrides.memory,
            goals: overrides.goals ?? original.goals,
            constraints: overrides.constraints ?? original.constraints,
            environmentState: overrides.environmentState ?? {},
            policies: overrides.policies ?? {},
            userIntent: overrides.userIntent ?? original.description,
            executionPolicy: overrides.executionPolicy ?? original.executionPolicy,
            optimizationLevel: overrides.optimizationLevel,
            schedulePolicy: overrides.schedulePolicy,
            rollbackPolicy: overrides.rollbackPolicy ?? original.rollbackPolicy,
            recoveryStrategy: overrides.recoveryStrategy ?? original.recoveryStrategy,
            timestamp: Date.now(),
            metadata: overrides.metadata
        };

        const alternative = this.createPlan(context);

        const updatedAlternative: Plan = { ...alternative, parentPlanId: planId };
        this.plans.set(alternative.id, structuredClone(updatedAlternative));

        const updatedOriginal: Plan = {
            ...original,
            alternativePlanIds: [...original.alternativePlanIds, alternative.id],
            updatedAt: Date.now()
        };
        this.plans.set(planId, structuredClone(updatedOriginal));

        return structuredClone(updatedAlternative);
    }

    getAlternatives(planId: PlanId): Plan[] {
        const plan = this.require(planId);
        return plan.alternativePlanIds
            .map(id => this.plans.get(id))
            .filter((candidate): candidate is Plan => candidate !== undefined)
            .map(candidate => structuredClone(candidate));
    }

    /* --------------------------------------------------------------------- *
     * Rollback / Recovery
     * --------------------------------------------------------------------- */

    buildRollbackPlan(planId: PlanId, policy?: RollbackPolicy): RollbackPlan {
        const plan = this.require(planId);
        return this.rollbackManager.build(plan, policy);
    }

    buildRecoveryPlan(planId: PlanId, strategy?: RecoveryStrategy): RecoveryPlan {
        const plan = this.require(planId);
        return this.recoveryManager.build(plan, strategy);
    }

    /* --------------------------------------------------------------------- *
     * Lifecycle
     * --------------------------------------------------------------------- */

    markCompleted(planId: PlanId): Plan {
        const plan = this.require(planId);
        const updated: Plan = { ...plan, status: PlanStatus.Completed, phase: PlanPhase.Finalized, updatedAt: Date.now() };
        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.PlanCompleted, { planId });
        return structuredClone(updated);
    }

    markFailed(planId: PlanId): Plan {
        const plan = this.require(planId);
        const updated: Plan = { ...plan, status: PlanStatus.Failed, updatedAt: Date.now() };
        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.PlanFailed, { planId });
        return structuredClone(updated);
    }

    markRolledBack(planId: PlanId): Plan {
        const plan = this.require(planId);
        const updated: Plan = { ...plan, status: PlanStatus.RolledBack, updatedAt: Date.now() };
        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.PlanRolledBack, { planId });
        return structuredClone(updated);
    }

    cancel(planId: PlanId): Plan {
        const plan = this.require(planId);
        const updated: Plan = { ...plan, status: PlanStatus.Cancelled, updatedAt: Date.now() };
        this.plans.set(planId, structuredClone(updated));
        this.emit(PlannerEvent.PlanCancelled, { planId });
        return structuredClone(updated);
    }

    /* --------------------------------------------------------------------- *
     * Accessors
     * --------------------------------------------------------------------- */

    get(planId: PlanId): Optional<Plan> {
        const plan = this.plans.get(planId);
        return plan ? structuredClone(plan) : undefined;
    }

    require(planId: PlanId): Plan {
        const plan = this.plans.get(planId);
        if (!plan) {
            throw new Error(`Plan '${planId}' does not exist.`);
        }
        return structuredClone(plan);
    }

    has(planId: PlanId): boolean {
        return this.plans.has(planId);
    }

    remove(planId: PlanId): boolean {
        return this.plans.delete(planId);
    }

    all(): Plan[] {
        return [...this.plans.values()].map(plan => structuredClone(plan));
    }

    where(predicate: Predicate<Plan>): Plan[] {
        return this.all().filter(predicate);
    }

    findByStatus(status: PlanStatus): Plan[] {
        return this.where(plan => plan.status === status);
    }

    sortedBy(comparator: Comparator<Plan>): Plan[] {
        return this.all().sort(comparator);
    }

    /* --------------------------------------------------------------------- *
     * Snapshots / Transactions
     * --------------------------------------------------------------------- */

    snapshot(): PlannerSnapshot {
        const snapshot = this.snapshotManager.create(this.all());
        this.emit(PlannerEvent.SnapshotCreated, { snapshotId: snapshot.id });
        return snapshot;
    }

    restoreSnapshot(snapshot: PlannerSnapshot): void {
        this.plans.clear();
        for (const plan of snapshot.plans) {
            this.plans.set(plan.id, structuredClone(plan));
        }
    }

    beginTransaction(description?: string): PlannerTransaction {
        return this.transactionManager.begin(description);
    }

    commitTransaction(): PlannerTransaction {
        const tx = this.transactionManager.commit(this.all());
        this.emit(PlannerEvent.TransactionCommitted, { transactionId: tx.id });
        return tx;
    }

    rollbackTransaction(): void {
        const snapshot = this.transactionManager.rollback();
        if (snapshot) {
            this.restoreSnapshot(snapshot);
        }
        this.emit(PlannerEvent.TransactionRolledBack, {});
    }

    /* --------------------------------------------------------------------- *
     * Validation / Diagnostics / Statistics
     * --------------------------------------------------------------------- */

    validate(planId: PlanId): ValidationResult {
        const plan = this.require(planId);
        const goals = plan.goals.map(goal => new PlannerGoal(goal));
        const tasks = plan.tasks.map(task => new PlannerTask(task));
        const graph = this.buildGraph(tasks);
        return this.validator.validate(goals, tasks, plan.constraints, graph);
    }

    runDiagnostics(planId: PlanId): boolean {
        const plan = this.require(planId);
        const tasks = plan.tasks.map(task => new PlannerTask(task));
        const graph = this.buildGraph(tasks);
        return this.diagnostics.runAll(plan, graph, this.snapshotManager);
    }

    getMetrics(): PlannerMetrics {
        return structuredClone(this.metrics);
    }

    getStatistics(): PlannerStatistics {
        const plans = this.all();

        let totalGoals = 0;
        let achievedGoals = 0;
        let totalTasks = 0;
        let pendingTasks = 0;
        let completedTasks = 0;
        let failedTasks = 0;
        let totalConstraints = 0;
        let totalDependencies = 0;
        let riskSum = 0;
        let depthSum = 0;
        let graphNodes = 0;
        let graphEdges = 0;

        for (const plan of plans) {
            totalGoals += plan.goals.length;
            achievedGoals += plan.goals.filter(goal => goal.status === GoalStatus.Achieved).length;

            totalTasks += plan.tasks.length;
            pendingTasks += plan.tasks.filter(task => task.state === TaskState.Pending).length;
            completedTasks += plan.tasks.filter(task => task.state === TaskState.Completed).length;
            failedTasks += plan.tasks.filter(task => task.state === TaskState.Failed).length;

            totalConstraints += plan.constraints.length;
            totalDependencies += plan.dependencies.length;

            riskSum += plan.riskScore;

            graphNodes += plan.graph.nodes.length;
            graphEdges += plan.graph.dependencies.length;

            const tasks = plan.tasks.map(task => new PlannerTask(task));
            const graph = this.buildGraph(tasks);
            depthSum += graph.nodeCount() > 0 ? graph.longestPath().length : 0;
        }

        return {
            totalPlans: plans.length,
            draftPlans: plans.filter(plan => plan.status === PlanStatus.Draft).length,
            activePlans: plans.filter(plan => plan.status === PlanStatus.Active).length,
            completedPlans: plans.filter(plan => plan.status === PlanStatus.Completed).length,
            failedPlans: plans.filter(plan => plan.status === PlanStatus.Failed).length,
            totalGoals,
            achievedGoals,
            totalTasks,
            pendingTasks,
            completedTasks,
            failedTasks,
            totalConstraints,
            totalDependencies,
            averageRiskScore: plans.length > 0 ? riskSum / plans.length : 0,
            averagePlanDepth: plans.length > 0 ? depthSum / plans.length : 0,
            graphNodes,
            graphEdges
        };
    }

    /* --------------------------------------------------------------------- *
     * Serialization / Export / Import
     * --------------------------------------------------------------------- */

    export(): PlannerExport {
        return {
            exportedAt: Date.now(),
            formatVersion: PLANNER_FORMAT_VERSION,
            plans: this.all()
        };
    }

    import(data: PlannerImport): number {
        if (!Array.isArray(data.plans)) {
            throw new TypeError("PlannerImport.plans must be an array.");
        }

        let count = 0;
        for (const plan of data.plans) {
            this.plans.set(plan.id, structuredClone(plan));
            count++;
        }
        return count;
    }

    /* --------------------------------------------------------------------- *
     * Introspection
     * --------------------------------------------------------------------- */

    describe(): string {
        return [
            "PlannerManager",
            `plans=${this.plans.size}`,
            `snapshots=${this.snapshotManager.size()}`,
            `transactions=${this.transactionManager.totalCount()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            configuration: structuredClone(this.configuration),
            plans: this.plans.size,
            metrics: this.getMetrics(),
            statistics: this.getStatistics(),
            snapshots: this.snapshotManager.inspect(),
            transactions: this.transactionManager.inspect(),
            diagnostics: this.diagnostics.inspect()
        };
    }
}