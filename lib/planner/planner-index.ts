/**
 * =============================================================================
 * Hexical AI
 * planner-index.ts
 * =============================================================================
 *
 * Planner Indexing Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * This module is responsible ONLY for indexing planner data so that large
 * plans (thousands of tasks/goals) can be looked up without repeated linear
 * scans. It mirrors the indexing role `MemoryIndex` plays in memory.ts, but
 * scoped to the planner domain's `PlannerTask` / `PlannerGoal` / `Plan`
 * shapes.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - schedules tasks (see planner.ts's PlannerScheduler)
 *   - optimizes plans (see planner.ts's PlannerOptimizer)
 *   - executes anything
 *   - validates plan/goal/task semantics (see planner.ts's PlannerValidator)
 *   - plans or decomposes goals (see planner.ts / planner-htn.ts)
 *
 * It ONLY maintains indexes: `add`/`update`/`remove`/`rebuild`/`clear`,
 * O(1)-ish lookup, statistics, and diagnostics. Diagnostics in this module
 * observe consistency only — they never repair or mutate indexed objects,
 * matching planner.ts's "Diagnostics observe only" rule.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    Goal,
    GoalId,
    PlanId,
    PlannerGoal,
    PlannerTask,
    PlanStatus,
    Task,
    TaskId,
    TaskPriority,
    TaskState,
    generateId
} from "./planner";

import {
    Dictionary,
    Optional,
    Timestamp,
    VersionNumber
} from "../memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const PLANNER_INDEX_FORMAT_VERSION = 1;

const ALL_TASK_STATES: readonly TaskState[] = Object.values(TaskState);
const ALL_TASK_PRIORITIES: readonly TaskPriority[] = Object.values(TaskPriority);
const ALL_PLAN_STATUSES: readonly PlanStatus[] = Object.values(PlanStatus);

/* =============================================================================
 * Planner Index Snapshot
 * =============================================================================
 *
 * A fully self-contained, serializable representation of everything a
 * PlannerIndexManager has indexed. Used by `serialize()`/`clone()` and by
 * `rebuild()` for restoring an index from a prior snapshot.
 */

export interface PlannerIndexSnapshot {
    id: string;
    timestamp: Timestamp;
    version: VersionNumber;
    tasks: Task[];
    goals: Goal[];
    planStatuses: PlannerIndexPlanStatusEntry[];
}

export interface PlannerIndexPlanStatusEntry {
    planId: PlanId;
    status: PlanStatus;
}

/* =============================================================================
 * Planner Index Statistics
 * =============================================================================
 */

export interface PlannerIndexStatistics {
    totalTasks: number;
    totalGoals: number;
    totalPlans: number;
    goalsWithTasks: number;
    tasksByState: Partial<Record<TaskState, number>>;
    tasksByPriority: Partial<Record<TaskPriority, number>>;
    plansByStatus: Partial<Record<PlanStatus, number>>;
    totalDependencyEdges: number;
    averageDependenciesPerTask: number;
    averageDependentsPerTask: number;
    maxDependenciesForATask: number;
    maxDependentsForATask: number;
}

/* =============================================================================
 * Planner Index Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over a PlannerIndexManager's
 * internal indexes. Every `validate*` method only inspects state; none of
 * them mutate the manager or repair inconsistencies — an inconsistent index
 * is surfaced, never silently patched.
 */

export class PlannerIndexDiagnostics {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validateTaskGoalIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const [goalId, taskIds] of manager.debugTaskIdsByGoal()) {
            for (const taskId of taskIds) {
                const task = manager.getTask(taskId);
                if (!task || task.getGoalId() !== goalId) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateDependencyIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const [taskId, dependencyIds] of manager.debugDependencyIdsByTask()) {
            const task = manager.getTask(taskId);
            if (!task) {
                valid = false;
                continue;
            }
            const actual = new Set(task.getDependencyIds());
            if (actual.size !== dependencyIds.size) {
                valid = false;
                continue;
            }
            for (const dependencyId of dependencyIds) {
                if (!actual.has(dependencyId)) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateDependentIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const [taskId, dependencyIds] of manager.debugDependencyIdsByTask()) {
            for (const dependencyId of dependencyIds) {
                const dependents = manager.dependentsOf(dependencyId);
                if (!dependents.has(taskId)) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateStateIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const state of ALL_TASK_STATES) {
            for (const taskId of manager.tasksByState(state)) {
                const task = manager.getTask(taskId);
                if (!task || task.getState() !== state) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validatePriorityIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const priority of ALL_TASK_PRIORITIES) {
            for (const taskId of manager.tasksByPriority(priority)) {
                const task = manager.getTask(taskId);
                if (!task || task.getPriority() !== priority) {
                    valid = false;
                }
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validatePlanStatusIndex(manager: PlannerIndexManager): boolean {
        this.checks++;
        let valid = true;

        for (const status of ALL_PLAN_STATUSES) {
            for (const planId of manager.plansByStatus(status)) {
                if (manager.planStatus(planId) !== status) {
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
     * Referential-integrity check: a task's `dependencyIds` may reference a
     * task id that is no longer indexed (e.g. removed without cleanup of
     * dependents that still point at it). This never repairs the reference —
     * it only reports it, consistent with the "diagnostics observe only"
     * rule.
     */
    findDanglingDependencies(manager: PlannerIndexManager): TaskId[] {
        this.checks++;
        const dangling: TaskId[] = [];

        for (const [taskId, dependencyIds] of manager.debugDependencyIdsByTask()) {
            for (const dependencyId of dependencyIds) {
                if (!manager.hasTask(dependencyId)) {
                    dangling.push(taskId);
                    break;
                }
            }
        }

        if (dangling.length > 0) {
            this.failures++;
        }
        return dangling;
    }

    runAll(manager: PlannerIndexManager): boolean {
        return (
            this.validateTaskGoalIndex(manager) &&
            this.validateDependencyIndex(manager) &&
            this.validateDependentIndex(manager) &&
            this.validateStateIndex(manager) &&
            this.validatePriorityIndex(manager) &&
            this.validatePlanStatusIndex(manager) &&
            this.findDanglingDependencies(manager).length === 0
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
            "PlannerIndexDiagnostics",
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
 * Planner Index Manager
 * =============================================================================
 *
 * The single public façade over the planner indexing subsystem. Owns the
 * canonical `TaskId -> PlannerTask` and `GoalId -> PlannerGoal` maps plus
 * every derived lookup index. All derived indexes are kept in sync
 * automatically by `addTask`/`updateTask`/`removeTask` (and their goal/plan
 * equivalents) — callers never manipulate an individual bucket directly.
 */

export class PlannerIndexManager {

    private readonly tasksById = new Map<TaskId, PlannerTask>();
    private readonly goalsById = new Map<GoalId, PlannerGoal>();

    private readonly taskIdsByGoal = new Map<GoalId, Set<TaskId>>();
    private readonly dependencyIdsByTask = new Map<TaskId, Set<TaskId>>();
    private readonly dependentIdsByTask = new Map<TaskId, Set<TaskId>>();
    private readonly taskIdsByState = new Map<TaskState, Set<TaskId>>();
    private readonly taskIdsByPriority = new Map<TaskPriority, Set<TaskId>>();

    private readonly planStatusById = new Map<PlanId, PlanStatus>();
    private readonly planIdsByStatus = new Map<PlanStatus, Set<PlanId>>();

    /**
     * Snapshots of each indexed task's state/priority/goal at the moment it
     * was last indexed. `PlannerTask` is a mutable value object — a caller
     * mutating one in place (e.g. `task.setState(...)`) and then calling
     * `updateTask(task)` means the "old" bucket keys are no longer readable
     * off the live object by the time `updateTask` runs. These caches are
     * the only reliable source for which bucket a task needs to be removed
     * from, mirroring how `dependencyIdsByTask` already caches the previous
     * dependency set for the same reason.
     */
    private readonly lastIndexedState = new Map<TaskId, TaskState>();
    private readonly lastIndexedPriority = new Map<TaskId, TaskPriority>();
    private readonly lastIndexedGoalId = new Map<TaskId, Optional<GoalId>>();

    constructor() {}

    /* --------------------------------------------------------------------- *
     * Bucket helpers
     * --------------------------------------------------------------------- */

    private addToBucket<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
        let bucket = map.get(key);
        if (!bucket) {
            bucket = new Set();
            map.set(key, bucket);
        }
        bucket.add(value);
    }

    private removeFromBucket<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
        const bucket = map.get(key);
        if (!bucket) {
            return;
        }
        bucket.delete(value);
        if (bucket.size === 0) {
            map.delete(key);
        }
    }

    /* --------------------------------------------------------------------- *
     * Task indexing
     * --------------------------------------------------------------------- */

    /**
     * Indexes a task for the first time. Throws if a task with the same id
     * is already indexed — use `updateTask` to re-sync an already-indexed
     * task after it has mutated.
     */
    addTask(task: PlannerTask): void {
        if (this.tasksById.has(task.id)) {
            throw new Error(`Task '${task.id}' is already indexed. Use updateTask() to re-sync it.`);
        }

        this.tasksById.set(task.id, task);
        this.indexTaskDerivedState(task);
    }

    /**
     * Re-syncs every derived index entry for a task that has mutated since
     * it was last indexed (state changed, priority changed, dependencies
     * changed, etc.). Throws if the task was never indexed.
     */
    updateTask(task: PlannerTask): void {
        if (!this.tasksById.has(task.id)) {
            throw new Error(`Task '${task.id}' is not indexed. Use addTask() first.`);
        }

        this.unindexTaskDerivedState(task.id);
        this.tasksById.set(task.id, task);
        this.indexTaskDerivedState(task);
    }

    /**
     * Adds the task if it is not yet indexed, or re-syncs it if it is.
     * Convenience wrapper over `addTask`/`updateTask` for callers that don't
     * want to track indexed-ness themselves.
     */
    upsertTask(task: PlannerTask): void {
        if (this.tasksById.has(task.id)) {
            this.updateTask(task);
        } else {
            this.addTask(task);
        }
    }

    removeTask(id: TaskId): boolean {
        if (!this.tasksById.has(id)) {
            return false;
        }

        this.unindexTaskDerivedState(id);
        this.tasksById.delete(id);
        return true;
    }

    private indexTaskDerivedState(task: PlannerTask): void {
        const goalId = task.getGoalId();
        if (goalId !== undefined) {
            this.addToBucket(this.taskIdsByGoal, goalId, task.id);
        }

        const dependencyIds = new Set(task.getDependencyIds());
        this.dependencyIdsByTask.set(task.id, dependencyIds);
        for (const dependencyId of dependencyIds) {
            this.addToBucket(this.dependentIdsByTask, dependencyId, task.id);
        }

        this.addToBucket(this.taskIdsByState, task.getState(), task.id);
        this.addToBucket(this.taskIdsByPriority, task.getPriority(), task.id);
    }

    private unindexTaskDerivedState(id: TaskId): void {
        const existing = this.tasksById.get(id);
        if (!existing) {
            return;
        }

        const goalId = existing.getGoalId();
        if (goalId !== undefined) {
            this.removeFromBucket(this.taskIdsByGoal, goalId, id);
        }

        const dependencyIds = this.dependencyIdsByTask.get(id) ?? new Set<TaskId>();
        for (const dependencyId of dependencyIds) {
            this.removeFromBucket(this.dependentIdsByTask, dependencyId, id);
        }
        this.dependencyIdsByTask.delete(id);

        // A task being removed owns its own dependent-set bucket; entries in
        // *other* tasks' dependencyIds that still reference this id become
        // dangling references, surfaced by
        // PlannerIndexDiagnostics.findDanglingDependencies rather than
        // silently rewritten here.
        this.dependentIdsByTask.delete(id);

        this.removeFromBucket(this.taskIdsByState, existing.getState(), id);
        this.removeFromBucket(this.taskIdsByPriority, existing.getPriority(), id);
    }

    getTask(id: TaskId): Optional<PlannerTask> {
        return this.tasksById.get(id);
    }

    requireTask(id: TaskId): PlannerTask {
        const task = this.tasksById.get(id);
        if (!task) {
            throw new Error(`Task '${id}' is not indexed.`);
        }
        return task;
    }

    hasTask(id: TaskId): boolean {
        return this.tasksById.has(id);
    }

    allTasks(): PlannerTask[] {
        return [...this.tasksById.values()];
    }

    taskCount(): number {
        return this.tasksById.size;
    }

    /* --------------------------------------------------------------------- *
     * Goal indexing
     * --------------------------------------------------------------------- */

    addGoal(goal: PlannerGoal): void {
        if (this.goalsById.has(goal.id)) {
            throw new Error(`Goal '${goal.id}' is already indexed. Use updateGoal() to re-sync it.`);
        }
        this.goalsById.set(goal.id, goal);
    }

    updateGoal(goal: PlannerGoal): void {
        if (!this.goalsById.has(goal.id)) {
            throw new Error(`Goal '${goal.id}' is not indexed. Use addGoal() first.`);
        }
        this.goalsById.set(goal.id, goal);
    }

    upsertGoal(goal: PlannerGoal): void {
        this.goalsById.set(goal.id, goal);
    }

    removeGoal(id: GoalId): boolean {
        this.taskIdsByGoal.delete(id);
        return this.goalsById.delete(id);
    }

    getGoal(id: GoalId): Optional<PlannerGoal> {
        return this.goalsById.get(id);
    }

    requireGoal(id: GoalId): PlannerGoal {
        const goal = this.goalsById.get(id);
        if (!goal) {
            throw new Error(`Goal '${id}' is not indexed.`);
        }
        return goal;
    }

    hasGoal(id: GoalId): boolean {
        return this.goalsById.has(id);
    }

    allGoals(): PlannerGoal[] {
        return [...this.goalsById.values()];
    }

    goalCount(): number {
        return this.goalsById.size;
    }

    /* --------------------------------------------------------------------- *
     * Plan status indexing
     * --------------------------------------------------------------------- */

    /**
     * Records or updates the status of a plan by id. Plans themselves are
     * not owned by this index (only `PlanId -> PlanStatus` is tracked, per
     * this module's stated responsibilities) — `PlannerManager` remains the
     * source of truth for full `Plan` objects.
     */
    registerPlanStatus(planId: PlanId, status: PlanStatus): void {
        const previous = this.planStatusById.get(planId);
        if (previous !== undefined) {
            this.removeFromBucket(this.planIdsByStatus, previous, planId);
        }

        this.planStatusById.set(planId, status);
        this.addToBucket(this.planIdsByStatus, status, planId);
    }

    removePlan(planId: PlanId): boolean {
        const previous = this.planStatusById.get(planId);
        if (previous === undefined) {
            return false;
        }
        this.removeFromBucket(this.planIdsByStatus, previous, planId);
        return this.planStatusById.delete(planId);
    }

    planStatus(planId: PlanId): Optional<PlanStatus> {
        return this.planStatusById.get(planId);
    }

    hasPlan(planId: PlanId): boolean {
        return this.planStatusById.has(planId);
    }

    planCount(): number {
        return this.planStatusById.size;
    }

    /* --------------------------------------------------------------------- *
     * Lookups
     * --------------------------------------------------------------------- */

    tasksForGoal(goalId: GoalId): ReadonlySet<TaskId> {
        return this.taskIdsByGoal.get(goalId) ?? new Set();
    }

    dependenciesOf(taskId: TaskId): ReadonlySet<TaskId> {
        return this.dependencyIdsByTask.get(taskId) ?? new Set();
    }

    dependentsOf(taskId: TaskId): ReadonlySet<TaskId> {
        return this.dependentIdsByTask.get(taskId) ?? new Set();
    }

    tasksByState(state: TaskState): ReadonlySet<TaskId> {
        return this.taskIdsByState.get(state) ?? new Set();
    }

    tasksByPriority(priority: TaskPriority): ReadonlySet<TaskId> {
        return this.taskIdsByPriority.get(priority) ?? new Set();
    }

    plansByStatus(status: PlanStatus): ReadonlySet<PlanId> {
        return this.planIdsByStatus.get(status) ?? new Set();
    }

    /* --------------------------------------------------------------------- *
     * Debug accessors
     * --------------------------------------------------------------------- *
     * Read-only escape hatches used exclusively by PlannerIndexDiagnostics
     * to inspect raw bucket contents. Prefixed `debug*` so application code
     * is not tempted to depend on the manager's internal bucket shape.
     */

    debugTaskIdsByGoal(): ReadonlyMap<GoalId, ReadonlySet<TaskId>> {
        return this.taskIdsByGoal;
    }

    debugDependencyIdsByTask(): ReadonlyMap<TaskId, ReadonlySet<TaskId>> {
        return this.dependencyIdsByTask;
    }

    /* --------------------------------------------------------------------- *
     * Bulk operations
     * --------------------------------------------------------------------- */

    /**
     * Clears every index and rebuilds from scratch off fresh collections.
     * The safest way to resynchronize after a batch of external mutations
     * whose individual `updateTask`/`updateGoal` calls were skipped for
     * performance.
     */
    rebuild(
        tasks: Iterable<PlannerTask>,
        goals: Iterable<PlannerGoal>,
        planStatuses: Iterable<PlannerIndexPlanStatusEntry> = []
    ): void {
        this.clear();

        for (const goal of goals) {
            this.goalsById.set(goal.id, goal);
        }

        for (const task of tasks) {
            this.tasksById.set(task.id, task);
            this.indexTaskDerivedState(task);
        }

        for (const entry of planStatuses) {
            this.registerPlanStatus(entry.planId, entry.status);
        }
    }

    clear(): void {
        this.tasksById.clear();
        this.goalsById.clear();
        this.taskIdsByGoal.clear();
        this.dependencyIdsByTask.clear();
        this.dependentIdsByTask.clear();
        this.taskIdsByState.clear();
        this.taskIdsByPriority.clear();
        this.planStatusById.clear();
        this.planIdsByStatus.clear();
    }

    /* --------------------------------------------------------------------- *
     * Validation / Statistics / Serialization
     * --------------------------------------------------------------------- */

    validate(): boolean {
        return new PlannerIndexDiagnostics().runAll(this);
    }

    getStatistics(): PlannerIndexStatistics {
        const tasksByState: Partial<Record<TaskState, number>> = {};
        for (const state of ALL_TASK_STATES) {
            const count = this.taskIdsByState.get(state)?.size ?? 0;
            if (count > 0) {
                tasksByState[state] = count;
            }
        }

        const tasksByPriority: Partial<Record<TaskPriority, number>> = {};
        for (const priority of ALL_TASK_PRIORITIES) {
            const count = this.taskIdsByPriority.get(priority)?.size ?? 0;
            if (count > 0) {
                tasksByPriority[priority] = count;
            }
        }

        const plansByStatus: Partial<Record<PlanStatus, number>> = {};
        for (const status of ALL_PLAN_STATUSES) {
            const count = this.planIdsByStatus.get(status)?.size ?? 0;
            if (count > 0) {
                plansByStatus[status] = count;
            }
        }

        let totalDependencyEdges = 0;
        let maxDependencies = 0;
        for (const dependencyIds of this.dependencyIdsByTask.values()) {
            totalDependencyEdges += dependencyIds.size;
            maxDependencies = Math.max(maxDependencies, dependencyIds.size);
        }

        let maxDependents = 0;
        let totalDependents = 0;
        for (const dependentIds of this.dependentIdsByTask.values()) {
            maxDependents = Math.max(maxDependents, dependentIds.size);
            totalDependents += dependentIds.size;
        }

        const taskCount = this.tasksById.size;

        return {
            totalTasks: taskCount,
            totalGoals: this.goalsById.size,
            totalPlans: this.planStatusById.size,
            goalsWithTasks: this.taskIdsByGoal.size,
            tasksByState,
            tasksByPriority,
            plansByStatus,
            totalDependencyEdges,
            averageDependenciesPerTask: taskCount > 0 ? totalDependencyEdges / taskCount : 0,
            averageDependentsPerTask: taskCount > 0 ? totalDependents / taskCount : 0,
            maxDependenciesForATask: maxDependencies,
            maxDependentsForATask: maxDependents
        };
    }

    serialize(): PlannerIndexSnapshot {
        return {
            id: generateId("idx-snap"),
            timestamp: Date.now(),
            version: PLANNER_INDEX_FORMAT_VERSION,
            tasks: this.allTasks().map(task => task.serialize()),
            goals: this.allGoals().map(goal => goal.serialize()),
            planStatuses: [...this.planStatusById.entries()].map(([planId, status]) => ({ planId, status }))
        };
    }

    /**
     * Deep, fully independent copy: reconstructs `PlannerTask`/`PlannerGoal`
     * instances from serialized data (their constructors already deep-clone
     * their input) rather than sharing references with the original index.
     */
    clone(): PlannerIndexManager {
        const snapshot = this.serialize();
        const clone = new PlannerIndexManager();

        clone.rebuild(
            snapshot.tasks.map(task => new PlannerTask(task)),
            snapshot.goals.map(goal => new PlannerGoal(goal)),
            snapshot.planStatuses
        );

        return clone;
    }

    describe(): string {
        return [
            "PlannerIndexManager",
            `tasks=${this.tasksById.size}`,
            `goals=${this.goalsById.size}`,
            `plans=${this.planStatusById.size}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            tasks: this.tasksById.size,
            goals: this.goalsById.size,
            plans: this.planStatusById.size,
            statistics: this.getStatistics() as unknown as Dictionary
        };
    }
}