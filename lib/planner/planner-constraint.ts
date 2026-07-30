/**
 * =============================================================================
 * Hexical AI
 * planner-constraint.ts
 * =============================================================================
 *
 * Constraint Management Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * planner.ts defines the `Constraint` shape and a minimal
 * `PlannerConstraintEngine` that evaluates constraints *structurally*, by
 * inspecting a task's declared `ResourceRequirement[]` and a goal's deadline.
 * This module is the dedicated constraint subsystem referenced in
 * planner-resource.ts's header comment: a standalone, richer constraint
 * engine that can query a `ResourceManager` (planner-resource.ts) for the
 * *actual* live state of a resource instead of relying only on what a task
 * declares, while still supporting every constraint type planner.ts defines
 * (temporal, resource, dependency, policy, budget, safety, custom).
 *
 * It provides registration, validation, evaluation, conflict detection,
 * propagation, serialization, cloning, snapshots, and statistics for
 * `Constraint`s independently of any single Plan — mirroring the
 * `ResourceManager` / `PlannerResource` pattern in planner-resource.ts and
 * the `MemoryManager` / `MemoryNode` pattern in memory.ts.
 *
 * This module is also designed to integrate with a `GoalDecomposer`
 * (planner-htn.ts): decomposition strategies frequently emit new
 * task-scoped constraints (e.g. ordering constraints between generated
 * subtasks), and those constraints can be registered here exactly like any
 * other constraint, with no dependency in either direction between this
 * module and planner-htn.ts.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - plans, decomposes goals, or builds task graphs (see planner.ts /
 *     planner-htn.ts)
 *   - schedules or optimizes tasks (see planner.ts's PlannerScheduler /
 *     PlannerOptimizer)
 *   - allocates, reserves, or manages resource capacity (see
 *     planner-resource.ts's ResourceManager) — it only *queries* a
 *     ResourceManager, read-only, when one is supplied
 *   - executes anything or has side effects outside its own in-memory state
 *
 * It ONLY manages constraints: registration, scoping, validation,
 * evaluation, conflict detection, violation propagation, and statistics.
 * Diagnostics in this module observe consistency only — they never repair
 * or mutate indexed state, matching planner.ts's, planner-index.ts's, and
 * planner-resource.ts's "diagnostics observe only" rule. No `eval`, no
 * `Function` construction, no reflection, and no dynamic evaluation of a
 * constraint's `expression` field anywhere in this module — expressions are
 * carried as opaque, advisory text only.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    Constraint,
    ConstraintId,
    ConstraintType,
    TaskId,
    GoalId,
    PlanId,
    ResourceState,
    RiskLevel,
    TaskState,
    ValidationIssue,
    ValidationResult,
    ValidationState,
    PlannerTask,
    PlannerGoal,
    generateId
} from "./planner";

import {
    ResourceManager
} from "./planner-resource";

import {
    Dictionary,
    Optional,
    Predicate,
    Serializable,
    Cloneable,
    Validatable,
    Versioned,
    Identifiable,
    Timestamped,
    Timestamp,
    VersionNumber
} from "./memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const CONSTRAINT_FORMAT_VERSION = 1;
export const INITIAL_CONSTRAINT_VERSION = 1;

export const DEFAULT_CONSTRAINT_SNAPSHOT_CAPACITY = 100;

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type ConstraintConflictId = string;
export type ConstraintSnapshotId = string;

/* =============================================================================
 * Constraint Conflict Type
 * =============================================================================
 */

export enum ConstraintConflictType {
    DuplicateIdentifier = "duplicate-identifier",
    DanglingTaskReference = "dangling-task-reference",
    DanglingGoalReference = "dangling-goal-reference",
    UnsatisfiableResourceConstraint = "unsatisfiable-resource-constraint",
    OverdueHardTemporalConstraint = "overdue-hard-temporal-constraint",
    SelfContradictingScope = "self-contradicting-scope"
}

/* =============================================================================
 * Constraint Manager Event
 * =============================================================================
 */

export enum ConstraintManagerEvent {
    ConstraintRegistered = "constraint-registered",
    ConstraintRemoved = "constraint-removed",
    ConstraintUpdated = "constraint-updated",
    ConstraintViolated = "constraint-violated",
    ConflictDetected = "conflict-detected",
    SnapshotCreated = "snapshot-created"
}

/* =============================================================================
 * Constraint Conflict
 * =============================================================================
 */

export interface ConstraintConflict {
    id: ConstraintConflictId;
    type: ConstraintConflictType;
    constraintIds: ConstraintId[];
    taskId?: TaskId;
    goalId?: GoalId;
    description: string;
    severity: RiskLevel;
    detectedAt: Timestamp;
}

/* =============================================================================
 * Constraint Evaluation Options / Result
 * =============================================================================
 */

export interface ConstraintEvaluationOptions {
    resources?: ResourceManager;
    tasksById?: ReadonlyMap<TaskId, PlannerTask>;
}

export interface ConstraintEvaluationResult {
    constraintId: ConstraintId;
    taskId?: TaskId;
    goalId?: GoalId;
    satisfied: boolean;
    message: string;
    evaluatedAt: Timestamp;
}

/* =============================================================================
 * Constraint Propagation Result
 * =============================================================================
 */

export interface ConstraintPropagationResult {
    sourceConstraintId: ConstraintId;
    sourceTaskId: TaskId;
    blockedTaskIds: TaskId[];
    propagatedAt: Timestamp;
}

/* =============================================================================
 * Constraint Manager Statistics
 * =============================================================================
 */

export interface ConstraintManagerStatistics {
    totalConstraints: number;
    hardConstraints: number;
    softConstraints: number;
    byType: Dictionary<number>;
    totalEvaluations: number;
    totalViolations: number;
    totalConflictsDetected: number;
    totalPropagations: number;
    averageViolationRate: number;
    lastEvaluatedAt?: Timestamp;
}

/* =============================================================================
 * Constraint Manager Snapshot
 * =============================================================================
 */

export interface ConstraintManagerSnapshot {
    id: ConstraintSnapshotId;
    timestamp: Timestamp;
    version: VersionNumber;
    constraints: Constraint[];
}

/* =============================================================================
 * Constraint Export / Import
 * =============================================================================
 */

export interface ConstraintExport {
    exportedAt: Timestamp;
    formatVersion: number;
    constraints: Constraint[];
}

export interface ConstraintImport {
    importedAt: Timestamp;
    constraints: Constraint[];
}

/* =============================================================================
 * Constraint Manager Observer
 * =============================================================================
 */

export interface ConstraintManagerObserver {
    onEvent?(event: ConstraintManagerEvent, payload: Dictionary): void;
}

/* =============================================================================
 * Planner Constraint
 * =============================================================================
 *
 * A single mutable, encapsulated constraint. Wraps a `Constraint` value
 * object with private state, defensive cloning on every read/write, and
 * explicit invariant checks before mutation — mirroring the `PlannerResource`
 * / `MemoryNode` pattern used elsewhere in Hexical.
 *
 * `PlannerConstraint` never evaluates itself against a task or goal — that
 * responsibility belongs to `PlannerConstraintEvaluator`, which is handed
 * the constraint explicitly by `PlannerConstraintManager`.
 */

export class PlannerConstraint
    implements
        Serializable<Constraint>,
        Cloneable<PlannerConstraint>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: ConstraintId;

    private type: ConstraintType;
    private description: string;
    private hard: boolean;
    private appliesToTaskIds: TaskId[];
    private appliesToGoalIds: GoalId[];
    private expression?: string;

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_CONSTRAINT_VERSION;

    private frozen = false;

    constructor(constraint: Constraint) {
        this.id = constraint.id;
        this.type = constraint.type;
        this.description = constraint.description;
        this.hard = constraint.hard;
        this.appliesToTaskIds = [...constraint.appliesToTaskIds];
        this.appliesToGoalIds = [...constraint.appliesToGoalIds];
        this.expression = constraint.expression;
        this.created = constraint.createdAt;
        this.updated = constraint.createdAt;
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

    getType(): ConstraintType {
        return this.type;
    }

    getDescription(): string {
        return this.description;
    }

    isHard(): boolean {
        return this.hard;
    }

    isSoft(): boolean {
        return !this.hard;
    }

    /** An opaque, advisory annotation. Never evaluated or executed. */
    getExpression(): Optional<string> {
        return this.expression;
    }

    getAppliesToTaskIds(): readonly TaskId[] {
        return [...this.appliesToTaskIds];
    }

    getAppliesToGoalIds(): readonly GoalId[] {
        return [...this.appliesToGoalIds];
    }

    /** An empty scope list means "applies to every task/goal", matching planner.ts. */
    isGlobal(): boolean {
        return this.appliesToTaskIds.length === 0 && this.appliesToGoalIds.length === 0;
    }

    appliesToTask(taskId: TaskId): boolean {
        return this.appliesToTaskIds.length === 0 || this.appliesToTaskIds.includes(taskId);
    }

    appliesToGoal(goalId: GoalId): boolean {
        return this.appliesToGoalIds.length === 0 || this.appliesToGoalIds.includes(goalId);
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    private assertMutable(): void {
        if (this.frozen) {
            throw new Error(`PlannerConstraint '${this.id}' is frozen and cannot be modified.`);
        }
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    setDescription(description: string): this {
        this.assertMutable();
        this.description = description;
        this.touch();
        return this;
    }

    setHard(hard: boolean): this {
        this.assertMutable();
        if (this.hard === hard) {
            return this;
        }
        this.hard = hard;
        this.touch();
        return this;
    }

    setExpression(expression: string): this {
        this.assertMutable();
        this.expression = expression;
        this.touch();
        return this;
    }

    clearExpression(): this {
        this.assertMutable();
        this.expression = undefined;
        this.touch();
        return this;
    }

    addTaskScope(taskId: TaskId): this {
        this.assertMutable();
        if (!this.appliesToTaskIds.includes(taskId)) {
            this.appliesToTaskIds.push(taskId);
            this.touch();
        }
        return this;
    }

    removeTaskScope(taskId: TaskId): this {
        this.assertMutable();
        const before = this.appliesToTaskIds.length;
        this.appliesToTaskIds = this.appliesToTaskIds.filter(id => id !== taskId);
        if (this.appliesToTaskIds.length !== before) {
            this.touch();
        }
        return this;
    }

    addGoalScope(goalId: GoalId): this {
        this.assertMutable();
        if (!this.appliesToGoalIds.includes(goalId)) {
            this.appliesToGoalIds.push(goalId);
            this.touch();
        }
        return this;
    }

    removeGoalScope(goalId: GoalId): this {
        this.assertMutable();
        const before = this.appliesToGoalIds.length;
        this.appliesToGoalIds = this.appliesToGoalIds.filter(id => id !== goalId);
        if (this.appliesToGoalIds.length !== before) {
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
        if (this.id.length === 0 || this.description.length === 0) {
            return false;
        }
        return true;
    }

    serialize(): Constraint {
        return {
            id: this.id,
            type: this.type,
            description: this.description,
            hard: this.hard,
            appliesToTaskIds: [...this.appliesToTaskIds],
            appliesToGoalIds: [...this.appliesToGoalIds],
            expression: this.expression,
            createdAt: this.created
        };
    }

    clone(): PlannerConstraint {
        return new PlannerConstraint(this.serialize());
    }

    describe(): string {
        return [
            `PlannerConstraint(${this.id})`,
            `type=${this.type}`,
            `hard=${this.hard}`,
            `tasks=${this.appliesToTaskIds.length}`,
            `goals=${this.appliesToGoalIds.length}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            type: this.type,
            hard: this.hard,
            global: this.isGlobal(),
            appliesToTaskIds: [...this.appliesToTaskIds],
            appliesToGoalIds: [...this.appliesToGoalIds],
            hasExpression: this.expression !== undefined,
            frozen: this.frozen
        };
    }
}

/* =============================================================================
 * Planner Constraint Evaluator
 * =============================================================================
 *
 * Evaluates constraints against tasks and goals. When a `ResourceManager`
 * (planner-resource.ts) is supplied, `ConstraintType.Resource` constraints
 * are checked against the *actual* live state of each resource a task
 * declares a requirement for, rather than only the task's own declared
 * `ResourceRequirement.state`. Every evaluation only reads state; nothing is
 * ever mutated here.
 */

export class PlannerConstraintEvaluator {

    private evaluations = 0;
    private violations = 0;

    constructor() {}

    evaluateTask(
        task: PlannerTask,
        constraints: readonly PlannerConstraint[],
        options: ConstraintEvaluationOptions = {}
    ): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const constraint of constraints) {
            if (!constraint.appliesToTask(task.id)) {
                continue;
            }

            this.evaluations++;

            const satisfied = this.isTaskConstraintSatisfied(constraint, task, options);
            if (!satisfied) {
                this.violations++;
                issues.push({
                    code: `CONSTRAINT_${constraint.getType().toUpperCase()}_VIOLATED`,
                    message: `Task '${task.id}' violates constraint '${constraint.id}': ${constraint.getDescription()}`,
                    severity: constraint.isHard() ? RiskLevel.High : RiskLevel.Low,
                    taskId: task.id,
                    constraintId: constraint.id
                });
            }
        }

        return issues;
    }

    evaluateGoal(
        goal: PlannerGoal,
        constraints: readonly PlannerConstraint[]
    ): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const constraint of constraints) {
            if (!constraint.appliesToGoal(goal.id)) {
                continue;
            }

            this.evaluations++;

            const satisfied = this.isGoalConstraintSatisfied(constraint, goal);
            if (!satisfied) {
                this.violations++;
                issues.push({
                    code: `CONSTRAINT_${constraint.getType().toUpperCase()}_VIOLATED`,
                    message: `Goal '${goal.id}' violates constraint '${constraint.id}': ${constraint.getDescription()}`,
                    severity: constraint.isHard() ? RiskLevel.High : RiskLevel.Moderate,
                    goalId: goal.id,
                    constraintId: constraint.id
                });
            }
        }

        return issues;
    }

    evaluateAll(
        tasks: readonly PlannerTask[],
        goals: readonly PlannerGoal[],
        constraints: readonly PlannerConstraint[],
        options: ConstraintEvaluationOptions = {}
    ): ValidationIssue[] {
        const issues: ValidationIssue[] = [];

        for (const task of tasks) {
            issues.push(...this.evaluateTask(task, constraints, options));
        }

        for (const goal of goals) {
            issues.push(...this.evaluateGoal(goal, constraints));
        }

        return issues;
    }

    private isTaskConstraintSatisfied(
        constraint: PlannerConstraint,
        task: PlannerTask,
        options: ConstraintEvaluationOptions
    ): boolean {
        switch (constraint.getType()) {
            case ConstraintType.Temporal:
                // Structural check only: a task with no scheduled window
                // cannot yet violate a temporal constraint.
                return true;

            case ConstraintType.Resource:
                return this.isResourceConstraintSatisfied(task, options.resources);

            case ConstraintType.Dependency:
                if (!task.dependsOn(task.id)) {
                    return true;
                }
                return false;

            case ConstraintType.Policy:
            case ConstraintType.Budget:
            case ConstraintType.Safety:
            case ConstraintType.Custom:
                // Advisory constraint categories: `expression` is opaque text,
                // never evaluated or executed (no eval, no reflection). These
                // are considered satisfied unless flagged elsewhere by a
                // conflict detector or an upstream policy engine.
                return true;

            default:
                return true;
        }
    }

    /**
     * Resource satisfaction check. Without a `ResourceManager`, this falls
     * back to the task's own declared requirement states (structural,
     * matching planner.ts's PlannerConstraintEngine). With one supplied, it
     * queries the live `PlannerResource` for each requirement instead —
     * catching cases where a resource has since become exhausted or
     * unavailable even though the task's stored requirement still claims
     * otherwise.
     */
    private isResourceConstraintSatisfied(task: PlannerTask, resources?: ResourceManager): boolean {
        const requirements = task.getResourceRequirements();

        if (!resources) {
            return requirements.every(requirement => requirement.state !== ResourceState.Unavailable);
        }

        return requirements.every(requirement => {
            const resource = resources.getResource(requirement.resourceId);
            if (!resource) {
                return false;
            }
            if (resource.getState() === ResourceState.Unavailable) {
                return false;
            }
            return resource.hasCapacityFor(requirement.amount) || resource.getAllocated() > 0;
        });
    }

    private isGoalConstraintSatisfied(constraint: PlannerConstraint, goal: PlannerGoal): boolean {
        if (constraint.getType() === ConstraintType.Temporal) {
            return !goal.isOverdue();
        }
        return true;
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
            "PlannerConstraintEvaluator",
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
 * Planner Constraint Conflict Detector
 * =============================================================================
 *
 * Structural, side-effect-free conflict detection over a set of
 * constraints. Every check only reads constraint/task/goal state and
 * produces `ConstraintConflict` records — it never mutates a
 * `PlannerConstraint`, `PlannerTask`, or `PlannerGoal`, and never performs
 * dynamic code evaluation of any kind.
 */

export class PlannerConstraintConflictDetector {

    private detections = 0;

    constructor() {}

    detectAll(
        constraints: readonly PlannerConstraint[],
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>,
        resources?: ResourceManager
    ): ConstraintConflict[] {
        const conflicts: ConstraintConflict[] = [];

        conflicts.push(...this.detectDuplicateIdentifiers(constraints));

        for (const constraint of constraints) {
            conflicts.push(...this.detectDanglingReferences(constraint, tasksById, goalsById));
            conflicts.push(...this.detectUnsatisfiableResourceConstraints(constraint, tasksById, resources));
            conflicts.push(...this.detectOverdueHardTemporalConstraints(constraint, goalsById));
        }

        return conflicts;
    }

    private detectDuplicateIdentifiers(constraints: readonly PlannerConstraint[]): ConstraintConflict[] {
        const conflicts: ConstraintConflict[] = [];
        const seen = new Map<ConstraintId, number>();

        for (const constraint of constraints) {
            seen.set(constraint.id, (seen.get(constraint.id) ?? 0) + 1);
        }

        for (const [id, count] of seen) {
            if (count > 1) {
                this.detections++;
                conflicts.push({
                    id: generateId("cconflict"),
                    type: ConstraintConflictType.DuplicateIdentifier,
                    constraintIds: [id],
                    description: `Constraint identifier '${id}' appears ${count} times in the supplied set.`,
                    severity: RiskLevel.High,
                    detectedAt: Date.now()
                });
            }
        }

        return conflicts;
    }

    private detectDanglingReferences(
        constraint: PlannerConstraint,
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): ConstraintConflict[] {
        const conflicts: ConstraintConflict[] = [];

        for (const taskId of constraint.getAppliesToTaskIds()) {
            if (!tasksById.has(taskId)) {
                this.detections++;
                conflicts.push({
                    id: generateId("cconflict"),
                    type: ConstraintConflictType.DanglingTaskReference,
                    constraintIds: [constraint.id],
                    taskId,
                    description: `Constraint '${constraint.id}' references unknown task '${taskId}'.`,
                    severity: RiskLevel.High,
                    detectedAt: Date.now()
                });
            }
        }

        for (const goalId of constraint.getAppliesToGoalIds()) {
            if (!goalsById.has(goalId)) {
                this.detections++;
                conflicts.push({
                    id: generateId("cconflict"),
                    type: ConstraintConflictType.DanglingGoalReference,
                    constraintIds: [constraint.id],
                    goalId,
                    description: `Constraint '${constraint.id}' references unknown goal '${goalId}'.`,
                    severity: RiskLevel.High,
                    detectedAt: Date.now()
                });
            }
        }

        return conflicts;
    }

    private detectUnsatisfiableResourceConstraints(
        constraint: PlannerConstraint,
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        resources?: ResourceManager
    ): ConstraintConflict[] {
        const conflicts: ConstraintConflict[] = [];

        if (constraint.getType() !== ConstraintType.Resource || !constraint.isHard() || !resources) {
            return conflicts;
        }

        for (const taskId of constraint.getAppliesToTaskIds()) {
            const task = tasksById.get(taskId);
            if (!task) {
                continue;
            }

            for (const requirement of task.getResourceRequirements()) {
                const resource = resources.getResource(requirement.resourceId);

                if (!resource || resource.isExhausted()) {
                    this.detections++;
                    conflicts.push({
                        id: generateId("cconflict"),
                        type: ConstraintConflictType.UnsatisfiableResourceConstraint,
                        constraintIds: [constraint.id],
                        taskId,
                        description: resource
                            ? `Hard resource constraint '${constraint.id}' on task '${taskId}' requires ` +
                              `exhausted resource '${requirement.resourceId}'.`
                            : `Hard resource constraint '${constraint.id}' on task '${taskId}' references ` +
                              `unknown resource '${requirement.resourceId}'.`,
                        severity: RiskLevel.Severe,
                        detectedAt: Date.now()
                    });
                }
            }
        }

        return conflicts;
    }

    private detectOverdueHardTemporalConstraints(
        constraint: PlannerConstraint,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): ConstraintConflict[] {
        const conflicts: ConstraintConflict[] = [];

        if (constraint.getType() !== ConstraintType.Temporal || !constraint.isHard()) {
            return conflicts;
        }

        for (const goalId of constraint.getAppliesToGoalIds()) {
            const goal = goalsById.get(goalId);
            if (goal && goal.isOverdue()) {
                this.detections++;
                conflicts.push({
                    id: generateId("cconflict"),
                    type: ConstraintConflictType.OverdueHardTemporalConstraint,
                    constraintIds: [constraint.id],
                    goalId,
                    description: `Hard temporal constraint '${constraint.id}' applies to overdue goal '${goalId}'.`,
                    severity: RiskLevel.High,
                    detectedAt: Date.now()
                });
            }
        }

        return conflicts;
    }

    detectionCount(): number {
        return this.detections;
    }

    reset(): void {
        this.detections = 0;
    }

    describe(): string {
        return ["PlannerConstraintConflictDetector", `detections=${this.detections}`].join(", ");
    }

    inspect(): Dictionary {
        return { detections: this.detections };
    }
}

/* =============================================================================
 * Planner Constraint Propagation Engine
 * =============================================================================
 *
 * Propagates a hard-constraint violation on a task to every task that
 * transitively depends on it, marking them Blocked. This mirrors
 * `PlannerConstraintEngine.propagate` in planner.ts but is owned here so
 * propagation can be triggered directly from constraint evaluation/conflict
 * detection results rather than only from planner.ts's own validator.
 */

export class PlannerConstraintPropagationEngine {

    private propagations = 0;

    constructor() {}

    propagate(taskId: TaskId, tasks: ReadonlyMap<TaskId, PlannerTask>): ConstraintPropagationResult {
        this.propagations++;

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

        return {
            sourceConstraintId: "",
            sourceTaskId: taskId,
            blockedTaskIds: blocked,
            propagatedAt: Date.now()
        };
    }

    /** Propagates on behalf of a specific violated constraint, tagging the result with its id. */
    propagateForConstraint(
        constraintId: ConstraintId,
        taskId: TaskId,
        tasks: ReadonlyMap<TaskId, PlannerTask>
    ): ConstraintPropagationResult {
        const result = this.propagate(taskId, tasks);
        return { ...result, sourceConstraintId: constraintId };
    }

    propagationCount(): number {
        return this.propagations;
    }

    reset(): void {
        this.propagations = 0;
    }

    describe(): string {
        return ["PlannerConstraintPropagationEngine", `propagations=${this.propagations}`].join(", ");
    }

    inspect(): Dictionary {
        return { propagations: this.propagations };
    }
}

/* =============================================================================
 * Constraint Snapshot Manager
 * =============================================================================
 */

export class ConstraintSnapshotManager {

    private readonly snapshots = new Map<ConstraintSnapshotId, ConstraintManagerSnapshot>();

    private readonly history: ConstraintSnapshotId[] = [];

    private readonly capacity: number;

    constructor(capacity = DEFAULT_CONSTRAINT_SNAPSHOT_CAPACITY) {
        if (capacity <= 0) {
            throw new RangeError("Snapshot capacity must be greater than zero.");
        }
        this.capacity = capacity;
    }

    create(constraints: readonly Constraint[]): ConstraintManagerSnapshot {
        const snapshot: ConstraintManagerSnapshot = {
            id: generateId("csnap"),
            timestamp: Date.now(),
            version: CONSTRAINT_FORMAT_VERSION,
            constraints: structuredClone([...constraints])
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

    get(id: ConstraintSnapshotId): Optional<ConstraintManagerSnapshot> {
        const snapshot = this.snapshots.get(id);
        return snapshot ? structuredClone(snapshot) : undefined;
    }

    latest(): Optional<ConstraintManagerSnapshot> {
        const id = this.history.at(-1);
        return id ? this.get(id) : undefined;
    }

    remove(id: ConstraintSnapshotId): boolean {
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

    ids(): readonly ConstraintSnapshotId[] {
        return [...this.history];
    }

    describe(): string {
        return ["ConstraintSnapshotManager", `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(", ");
    }

    inspect(): Dictionary {
        return { size: this.size(), capacity: this.capacity, history: [...this.history] };
    }
}

/* =============================================================================
 * Planner Constraint Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over a
 * `PlannerConstraintManager`'s internal state. Every `validate*` method only
 * inspects state; none of them mutate the manager or repair
 * inconsistencies — an inconsistent constraint set is surfaced, never
 * silently patched, mirroring `ResourceDiagnostics` / `PlannerDiagnostics`.
 */

export class PlannerConstraintDiagnostics {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validateConstraintInvariants(manager: PlannerConstraintManager): boolean {
        this.checks++;
        let valid = true;

        for (const constraint of manager.allConstraints()) {
            if (!constraint.validate()) {
                valid = false;
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateReferences(
        manager: PlannerConstraintManager,
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): boolean {
        this.checks++;
        let valid = true;

        for (const constraint of manager.allConstraints()) {
            for (const taskId of constraint.getAppliesToTaskIds()) {
                if (!tasksById.has(taskId)) {
                    valid = false;
                }
            }
            for (const goalId of constraint.getAppliesToGoalIds()) {
                if (!goalsById.has(goalId)) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    /**
     * Referential-integrity report: which constraint ids reference a task or
     * goal id that is no longer known. This never repairs the reference —
     * it only reports it.
     */
    findDanglingReferences(
        manager: PlannerConstraintManager,
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): { taskReferences: ConstraintId[]; goalReferences: ConstraintId[] } {
        this.checks++;

        const taskReferences: ConstraintId[] = [];
        const goalReferences: ConstraintId[] = [];

        for (const constraint of manager.allConstraints()) {
            if (constraint.getAppliesToTaskIds().some(taskId => !tasksById.has(taskId))) {
                taskReferences.push(constraint.id);
            }
            if (constraint.getAppliesToGoalIds().some(goalId => !goalsById.has(goalId))) {
                goalReferences.push(constraint.id);
            }
        }

        if (taskReferences.length > 0 || goalReferences.length > 0) {
            this.failures++;
        }

        return { taskReferences, goalReferences };
    }

    runAll(
        manager: PlannerConstraintManager,
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): boolean {
        return (
            this.validateConstraintInvariants(manager) &&
            this.validateReferences(manager, tasksById, goalsById)
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
            "PlannerConstraintDiagnostics",
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
 * Planner Constraint Manager
 * =============================================================================
 *
 * The single public façade over the constraint subsystem. Owns the
 * canonical `ConstraintId -> PlannerConstraint` map, a
 * `PlannerConstraintEvaluator`, a `PlannerConstraintConflictDetector`, a
 * `PlannerConstraintPropagationEngine`, a `ConstraintSnapshotManager`, and a
 * `PlannerConstraintDiagnostics` instance.
 *
 * PlannerConstraintManager never plans, schedules, allocates resources, or
 * executes anything; it only tracks and evaluates constraints for other
 * subsystems (planner.ts's PlannerManager, planner-resource.ts's
 * ResourceManager consumers, or a planner-htn.ts decomposer) to query.
 */

export class PlannerConstraintManager {

    private readonly constraintsById = new Map<ConstraintId, PlannerConstraint>();

    private readonly evaluator = new PlannerConstraintEvaluator();
    private readonly conflictDetector = new PlannerConstraintConflictDetector();
    private readonly propagationEngine = new PlannerConstraintPropagationEngine();
    private readonly snapshotManager: ConstraintSnapshotManager;
    private readonly diagnostics = new PlannerConstraintDiagnostics();

    private readonly observers = new Set<ConstraintManagerObserver>();

    private lastEvaluatedAt?: Timestamp;

    constructor(snapshotCapacity: number = DEFAULT_CONSTRAINT_SNAPSHOT_CAPACITY) {
        this.snapshotManager = new ConstraintSnapshotManager(snapshotCapacity);
    }

    /* --------------------------------------------------------------------- *
     * Observers
     * --------------------------------------------------------------------- */

    subscribe(observer: ConstraintManagerObserver): void {
        this.observers.add(observer);
    }

    unsubscribe(observer: ConstraintManagerObserver): void {
        this.observers.delete(observer);
    }

    private emit(event: ConstraintManagerEvent, payload: Dictionary): void {
        for (const observer of this.observers) {
            observer.onEvent?.(event, payload);
        }
    }

    /* --------------------------------------------------------------------- *
     * Registration
     * --------------------------------------------------------------------- */

    registerConstraint(constraint: Constraint): PlannerConstraint {
        if (this.constraintsById.has(constraint.id)) {
            throw new Error(`Constraint '${constraint.id}' is already registered.`);
        }
        const wrapped = new PlannerConstraint(constraint);
        this.constraintsById.set(constraint.id, wrapped);
        this.emit(ConstraintManagerEvent.ConstraintRegistered, { constraintId: constraint.id });
        return wrapped;
    }

    removeConstraint(id: ConstraintId): boolean {
        const removed = this.constraintsById.delete(id);
        if (removed) {
            this.emit(ConstraintManagerEvent.ConstraintRemoved, { constraintId: id });
        }
        return removed;
    }

    getConstraint(id: ConstraintId): Optional<PlannerConstraint> {
        return this.constraintsById.get(id);
    }

    requireConstraint(id: ConstraintId): PlannerConstraint {
        const constraint = this.constraintsById.get(id);
        if (!constraint) {
            throw new Error(`Constraint '${id}' does not exist.`);
        }
        return constraint;
    }

    hasConstraint(id: ConstraintId): boolean {
        return this.constraintsById.has(id);
    }

    allConstraints(): PlannerConstraint[] {
        return [...this.constraintsById.values()];
    }

    constraintCount(): number {
        return this.constraintsById.size;
    }

    where(predicate: Predicate<PlannerConstraint>): PlannerConstraint[] {
        return this.allConstraints().filter(predicate);
    }

    byTask(taskId: TaskId): PlannerConstraint[] {
        return this.where(constraint => constraint.appliesToTask(taskId));
    }

    byGoal(goalId: GoalId): PlannerConstraint[] {
        return this.where(constraint => constraint.appliesToGoal(goalId));
    }

    byType(type: ConstraintType): PlannerConstraint[] {
        return this.where(constraint => constraint.getType() === type);
    }

    hardConstraints(): PlannerConstraint[] {
        return this.where(constraint => constraint.isHard());
    }

    softConstraints(): PlannerConstraint[] {
        return this.where(constraint => constraint.isSoft());
    }

    /* --------------------------------------------------------------------- *
     * Evaluation
     * --------------------------------------------------------------------- */

    evaluateTask(task: PlannerTask, options: ConstraintEvaluationOptions = {}): ValidationIssue[] {
        const issues = this.evaluator.evaluateTask(task, this.allConstraints(), options);
        this.lastEvaluatedAt = Date.now();
        this.emitViolations(issues);
        return issues;
    }

    evaluateGoal(goal: PlannerGoal): ValidationIssue[] {
        const issues = this.evaluator.evaluateGoal(goal, this.allConstraints());
        this.lastEvaluatedAt = Date.now();
        this.emitViolations(issues);
        return issues;
    }

    evaluateAll(
        tasks: readonly PlannerTask[],
        goals: readonly PlannerGoal[],
        options: ConstraintEvaluationOptions = {}
    ): ValidationResult {
        const issues = this.evaluator.evaluateAll(tasks, goals, this.allConstraints(), options);
        this.lastEvaluatedAt = Date.now();
        this.emitViolations(issues);

        const hardFailures = issues.filter(
            issue => issue.severity === RiskLevel.Severe || issue.severity === RiskLevel.High
        );
        const valid = hardFailures.length === 0;

        return {
            state: valid ? (issues.length > 0 ? ValidationState.Warning : ValidationState.Valid) : ValidationState.Invalid,
            valid,
            issues,
            validatedAt: Date.now()
        };
    }

    private emitViolations(issues: readonly ValidationIssue[]): void {
        for (const issue of issues) {
            if (issue.constraintId !== undefined) {
                this.emit(ConstraintManagerEvent.ConstraintViolated, {
                    constraintId: issue.constraintId,
                    taskId: issue.taskId,
                    goalId: issue.goalId,
                    code: issue.code
                });
            }
        }
    }

    /* --------------------------------------------------------------------- *
     * Conflict Detection
     * --------------------------------------------------------------------- */

    detectConflicts(
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>,
        resources?: ResourceManager
    ): ConstraintConflict[] {
        const conflicts = this.conflictDetector.detectAll(this.allConstraints(), tasksById, goalsById, resources);

        if (conflicts.length > 0) {
            this.emit(ConstraintManagerEvent.ConflictDetected, { count: conflicts.length });
        }

        return conflicts;
    }

    /* --------------------------------------------------------------------- *
     * Propagation
     * --------------------------------------------------------------------- */

    propagateViolation(
        constraintId: ConstraintId,
        taskId: TaskId,
        tasksById: ReadonlyMap<TaskId, PlannerTask>
    ): ConstraintPropagationResult {
        return this.propagationEngine.propagateForConstraint(constraintId, taskId, tasksById);
    }

    /* --------------------------------------------------------------------- *
     * Diagnostics / Statistics
     * --------------------------------------------------------------------- */

    runDiagnostics(
        tasksById: ReadonlyMap<TaskId, PlannerTask>,
        goalsById: ReadonlyMap<GoalId, PlannerGoal>
    ): boolean {
        return this.diagnostics.runAll(this, tasksById, goalsById);
    }

    getStatistics(): ConstraintManagerStatistics {
        const constraints = this.allConstraints();

        const byType: Dictionary<number> = {};
        let hard = 0;
        let soft = 0;

        for (const constraint of constraints) {
            const key = constraint.getType();
            byType[key] = (byType[key] ?? 0) + 1;
            if (constraint.isHard()) {
                hard++;
            } else {
                soft++;
            }
        }

        const totalEvaluations = this.evaluator.evaluationCount();
        const totalViolations = this.evaluator.violationCount();

        return {
            totalConstraints: constraints.length,
            hardConstraints: hard,
            softConstraints: soft,
            byType,
            totalEvaluations,
            totalViolations,
            totalConflictsDetected: this.conflictDetector.detectionCount(),
            totalPropagations: this.propagationEngine.propagationCount(),
            averageViolationRate: totalEvaluations > 0 ? totalViolations / totalEvaluations : 0,
            lastEvaluatedAt: this.lastEvaluatedAt
        };
    }

    /* --------------------------------------------------------------------- *
     * Snapshot / Serialization
     * --------------------------------------------------------------------- */

    snapshot(): ConstraintManagerSnapshot {
        const snapshot = this.snapshotManager.create(this.allConstraints().map(constraint => constraint.serialize()));
        this.emit(ConstraintManagerEvent.SnapshotCreated, { snapshotId: snapshot.id });
        return snapshot;
    }

    /**
     * Restores this manager's constraint state from a snapshot, discarding
     * any constraints currently registered. Evaluation/conflict/propagation
     * counters are intentionally left untouched, since they describe this
     * manager's own operational history rather than the constraint data
     * itself.
     */
    restoreSnapshot(snapshot: ConstraintManagerSnapshot): void {
        this.constraintsById.clear();
        for (const constraint of snapshot.constraints) {
            this.constraintsById.set(constraint.id, new PlannerConstraint(constraint));
        }
    }

    /**
     * Deep, fully independent copy: reconstructs every `PlannerConstraint`
     * from serialized data rather than sharing references with the
     * original manager. Operational counters (evaluations, violations,
     * conflicts, propagations) are not carried over — a clone represents a
     * fresh manager seeded with the same constraints, matching the "no
     * shared mutable state" guarantee `ResourceManager.clone()` provides.
     */
    clone(): PlannerConstraintManager {
        const clone = new PlannerConstraintManager();
        for (const constraint of this.allConstraints()) {
            clone.constraintsById.set(constraint.id, constraint.clone());
        }
        return clone;
    }

    export(): ConstraintExport {
        return {
            exportedAt: Date.now(),
            formatVersion: CONSTRAINT_FORMAT_VERSION,
            constraints: this.allConstraints().map(constraint => constraint.serialize())
        };
    }

    import(data: ConstraintImport): number {
        if (!Array.isArray(data.constraints)) {
            throw new TypeError("ConstraintImport.constraints must be an array.");
        }

        let count = 0;
        for (const constraint of data.constraints) {
            this.constraintsById.set(constraint.id, new PlannerConstraint(constraint));
            count++;
        }
        return count;
    }

    /* --------------------------------------------------------------------- *
     * Introspection
     * --------------------------------------------------------------------- */

    describe(): string {
        return [
            "PlannerConstraintManager",
            `constraints=${this.constraintsById.size}`,
            `snapshots=${this.snapshotManager.size()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            constraints: this.constraintsById.size,
            evaluator: this.evaluator.inspect(),
            conflictDetector: this.conflictDetector.inspect(),
            propagationEngine: this.propagationEngine.inspect(),
            snapshots: this.snapshotManager.inspect(),
            diagnostics: this.diagnostics.inspect(),
            statistics: this.getStatistics() as unknown as Dictionary
        };
    }
}