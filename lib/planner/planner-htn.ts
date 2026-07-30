/**
 * =============================================================================
 * Hexical AI
 * planner-htn.ts
 * =============================================================================
 *
 * Hierarchical Task Network (HTN) Goal Decomposition Engine
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * planner.ts's default goal decomposition is intentionally minimal: a goal
 * with no linked tasks becomes a single placeholder task. This module
 * implements a richer strategy — recursive HTN decomposition — as a
 * `GoalDecomposer` that can be injected into `PlannerManager` without any
 * change to PlannerManager's public API.
 *
 * A compound goal is decomposed by selecting an applicable `HTNMethod` for
 * its `GoalType` (subject to structured, non-dynamic preconditions evaluated
 * against `PlannerContext.environmentState`), then recursively expanding
 * that method's subtask templates: primitive templates become concrete
 * `Task`s, compound templates become new subgoals which are decomposed in
 * turn, bounded by a maximum depth and guarded against goal recursion
 * cycles.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * - This module ONLY decomposes goals into tasks/subgoals. It never
 *   executes, schedules, or persists anything — those remain the
 *   responsibility of planner.ts's PlannerScheduler / PlannerManager /
 *   executor.ts respectively.
 * - No `eval`, no `Function` construction, no dynamic code evaluation.
 *   Method preconditions are structured `HTNCondition` objects evaluated by
 *   a fixed, safe interpreter — never arbitrary expression strings.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    Goal,
    GoalId,
    GoalStatus,
    GoalType,
    Task,
    TaskPriority,
    TaskState,
    ResourceRequirement,
    Dependency,
    DependencyType,
    PlannerContext,
    GoalDecomposer,
    GoalDecompositionOutcome,
    generateId,
    DEFAULT_TASK_MAX_RETRIES,
    DEFAULT_MAX_PLAN_DEPTH
} from "./planner";

import { Dictionary, JsonValue } from "../memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const HTN_FORMAT_VERSION = 1;
export const DEFAULT_HTN_MAX_DEPTH = DEFAULT_MAX_PLAN_DEPTH;

const DANGEROUS_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type HTNMethodId = string;
export type HTNTemplateId = string;

/* =============================================================================
 * HTN Node Type
 * =============================================================================
 */

export enum HTNNodeType {
    Compound = "compound",
    Primitive = "primitive"
}

/* =============================================================================
 * Decomposition Strategy
 * =============================================================================
 */

export enum DecompositionStrategy {
    OrderedSubtasks = "ordered-subtasks",
    UnorderedSubtasks = "unordered-subtasks",
    ConditionalBranch = "conditional-branch",
    SingleBestMethod = "single-best-method"
}

/* =============================================================================
 * HTN Condition
 * =============================================================================
 *
 * Structured, side-effect-free precondition. Evaluated by
 * `HTNConditionEvaluator` against `PlannerContext.environmentState` — never
 * by dynamic code evaluation.
 */

export enum HTNConditionOperator {
    Equals = "equals",
    NotEquals = "not-equals",
    GreaterThan = "greater-than",
    LessThan = "less-than",
    Exists = "exists",
    NotExists = "not-exists",
    Includes = "includes"
}

export interface HTNCondition {
    /** Dot-separated path into `PlannerContext.environmentState`. */
    path: string;
    operator: HTNConditionOperator;
    value?: JsonValue;
}

/* =============================================================================
 * Subtask Template
 * =============================================================================
 */

export interface HTNSubtaskTemplate {
    id: HTNTemplateId;
    type: HTNNodeType;
    name: string;
    description: string;
    /** Required when `type` is Compound; ignored otherwise. */
    goalType?: GoalType;
    priority?: TaskPriority;
    estimatedDurationMs?: number;
    resourceRequirements?: ResourceRequirement[];
    /** Seeds a compound subtask's synthesized subgoal success criteria. */
    successCriteria?: string[];
    /** Template ids (within the same method) this template depends on. */
    dependsOnTemplateIds: HTNTemplateId[];
}

/* =============================================================================
 * HTN Method
 * =============================================================================
 */

export interface HTNMethod {
    id: HTNMethodId;
    name: string;
    description: string;
    appliesToGoalType: GoalType;
    /** Higher values are preferred when multiple methods are applicable. */
    priority: number;
    preconditions: HTNCondition[];
    strategy: DecompositionStrategy;
    subtasks: HTNSubtaskTemplate[];
}

/* =============================================================================
 * Decomposition Tree / Result
 * =============================================================================
 */

export interface HTNDecompositionNode {
    id: string;
    type: HTNNodeType;
    goalId?: GoalId;
    taskId?: string;
    methodId?: HTNMethodId;
    depth: number;
    children: HTNDecompositionNode[];
}

export interface HTNDecompositionResult {
    rootGoalId: GoalId;
    tree: HTNDecompositionNode;
    tasks: Task[];
    subGoals: Goal[];
    dependencies: Dependency[];
    methodsApplied: HTNMethodId[];
    unresolvedGoalIds: GoalId[];
    maxDepthReached: boolean;
    diagnostics: string[];
}

/* =============================================================================
 * HTN Statistics
 * =============================================================================
 */

export interface HTNStatistics {
    totalDecompositions: number;
    methodsApplied: number;
    placeholdersEmitted: number;
    cyclesDetected: number;
    depthLimitHits: number;
}

/* =============================================================================
 * Condition Evaluator
 * =============================================================================
 *
 * Safely resolves a dot-path into a plain object without dynamic evaluation
 * or reflection, defensively rejecting prototype-pollution-style segments —
 * mirrors the guard used for session metadata in reasoner.ts.
 */

export class HTNConditionEvaluator {

    private evaluations = 0;

    constructor() {}

    resolvePath(source: Dictionary, path: string): JsonValue | undefined {
        const segments = path.split(".").filter(segment => segment.length > 0);

        let current: unknown = source;

        for (const segment of segments) {
            if (DANGEROUS_PATH_SEGMENTS.has(segment)) {
                return undefined;
            }
            if (current === null || typeof current !== "object") {
                return undefined;
            }
            current = (current as Dictionary)[segment];
        }

        return current as JsonValue | undefined;
    }

    evaluate(condition: HTNCondition, environmentState: Dictionary): boolean {
        this.evaluations++;

        const actual = this.resolvePath(environmentState, condition.path);

        switch (condition.operator) {
            case HTNConditionOperator.Exists:
                return actual !== undefined;

            case HTNConditionOperator.NotExists:
                return actual === undefined;

            case HTNConditionOperator.Equals:
                return actual === condition.value;

            case HTNConditionOperator.NotEquals:
                return actual !== condition.value;

            case HTNConditionOperator.GreaterThan:
                return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;

            case HTNConditionOperator.LessThan:
                return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;

            case HTNConditionOperator.Includes:
                return Array.isArray(actual) && actual.includes(condition.value as JsonValue);

            default:
                return false;
        }
    }

    evaluateAll(conditions: readonly HTNCondition[], environmentState: Dictionary): boolean {
        return conditions.every(condition => this.evaluate(condition, environmentState));
    }

    evaluationCount(): number {
        return this.evaluations;
    }

    describe(): string {
        return ["HTNConditionEvaluator", `evaluations=${this.evaluations}`].join(", ");
    }

    inspect(): Dictionary {
        return { evaluations: this.evaluations };
    }
}

/* =============================================================================
 * HTN Method Registry
 * =============================================================================
 */

export class HTNMethodRegistry {

    private readonly methods = new Map<HTNMethodId, HTNMethod>();

    private readonly byGoalType = new Map<GoalType, Set<HTNMethodId>>();

    constructor() {}

    private index(method: HTNMethod): void {
        let bucket = this.byGoalType.get(method.appliesToGoalType);
        if (!bucket) {
            bucket = new Set();
            this.byGoalType.set(method.appliesToGoalType, bucket);
        }
        bucket.add(method.id);
    }

    private unindex(method: HTNMethod): void {
        this.byGoalType.get(method.appliesToGoalType)?.delete(method.id);
    }

    register(method: HTNMethod): void {
        if (this.methods.has(method.id)) {
            throw new Error(`HTN method '${method.id}' is already registered.`);
        }
        if (method.subtasks.length === 0) {
            throw new Error(`HTN method '${method.id}' must declare at least one subtask.`);
        }

        const templateIds = new Set<HTNTemplateId>();
        for (const subtask of method.subtasks) {
            if (templateIds.has(subtask.id)) {
                throw new Error(`HTN method '${method.id}' has a duplicate subtask template id '${subtask.id}'.`);
            }
            templateIds.add(subtask.id);

            if (subtask.type === HTNNodeType.Compound && subtask.goalType === undefined) {
                throw new Error(
                    `HTN method '${method.id}' subtask '${subtask.id}' is Compound but has no goalType.`
                );
            }
        }

        for (const subtask of method.subtasks) {
            for (const dependencyId of subtask.dependsOnTemplateIds) {
                if (!templateIds.has(dependencyId)) {
                    throw new Error(
                        `HTN method '${method.id}' subtask '${subtask.id}' depends on unknown template '${dependencyId}'.`
                    );
                }
            }
        }

        this.methods.set(method.id, method);
        this.index(method);
    }

    unregister(id: HTNMethodId): boolean {
        const method = this.methods.get(id);
        if (!method) {
            return false;
        }
        this.unindex(method);
        return this.methods.delete(id);
    }

    has(id: HTNMethodId): boolean {
        return this.methods.has(id);
    }

    get(id: HTNMethodId): HTNMethod | undefined {
        return this.methods.get(id);
    }

    /** Methods applicable to a goal type, sorted by descending priority. */
    methodsFor(goalType: GoalType): HTNMethod[] {
        const ids = this.byGoalType.get(goalType) ?? new Set();
        return [...ids]
            .map(id => this.methods.get(id)!)
            .sort((a, b) => b.priority - a.priority);
    }

    all(): HTNMethod[] {
        return [...this.methods.values()];
    }

    size(): number {
        return this.methods.size;
    }

    clear(): void {
        this.methods.clear();
        this.byGoalType.clear();
    }

    describe(): string {
        return ["HTNMethodRegistry", `methods=${this.methods.size}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            methods: this.methods.size,
            goalTypesCovered: this.byGoalType.size
        };
    }
}

/* =============================================================================
 * HTN Planner
 * =============================================================================
 *
 * Recursive HTN decomposition engine. Implements `GoalDecomposer` so it can
 * be handed straight to `new PlannerManager(config, htnPlanner)`.
 */

export class HTNPlanner implements GoalDecomposer {

    private readonly registry: HTNMethodRegistry;
    private readonly evaluator: HTNConditionEvaluator;
    private readonly maxDepth: number;

    private readonly stats: HTNStatistics = {
        totalDecompositions: 0,
        methodsApplied: 0,
        placeholdersEmitted: 0,
        cyclesDetected: 0,
        depthLimitHits: 0
    };

    constructor(
        registry: HTNMethodRegistry = new HTNMethodRegistry(),
        evaluator: HTNConditionEvaluator = new HTNConditionEvaluator(),
        maxDepth: number = DEFAULT_HTN_MAX_DEPTH
    ) {
        if (maxDepth <= 0) {
            throw new RangeError("HTNPlanner maxDepth must be greater than zero.");
        }
        this.registry = registry;
        this.evaluator = evaluator;
        this.maxDepth = maxDepth;
    }

    getRegistry(): HTNMethodRegistry {
        return this.registry;
    }

    /* --------------------------------------------------------------------- *
     * GoalDecomposer entry point
     * --------------------------------------------------------------------- */

    decompose(goal: Goal, context: PlannerContext): GoalDecompositionOutcome {
        const result = this.decomposeFull(goal, context);
        return { tasks: result.tasks, subGoals: result.subGoals };
    }

    /**
     * Full decomposition, exposing the tree and diagnostics for callers that
     * want more than the minimal `GoalDecomposer` contract (e.g. debugging
     * tools, plan explainers).
     */
    decomposeFull(goal: Goal, context: PlannerContext): HTNDecompositionResult {
        this.stats.totalDecompositions++;

        const tasks: Task[] = [];
        const taskById = new Map<string, Task>();
        const subGoals: Goal[] = [];
        const methodsApplied: HTNMethodId[] = [];
        const unresolvedGoalIds: GoalId[] = [];
        const diagnostics: string[] = [];
        let maxDepthReached = false;

        const visitedPath = new Set<string>();

        const tree = this.expandGoal(
            goal,
            context,
            0,
            visitedPath,
            tasks,
            taskById,
            subGoals,
            methodsApplied,
            unresolvedGoalIds,
            diagnostics,
            state => {
                maxDepthReached = maxDepthReached || state;
            }
        );

        return {
            rootGoalId: goal.id,
            tree,
            tasks,
            subGoals,
            dependencies: this.deriveDependencyRecords(tasks),
            methodsApplied,
            unresolvedGoalIds,
            maxDepthReached,
            diagnostics
        };
    }

    /**
     * Derives reportable `Dependency` records from each task's own
     * `dependencyIds` — the single source of truth that `PlannerManager`
     * itself reads (via `buildGraph` / `deriveDependencies`). This mirrors
     * planner.ts's own `deriveDependencies` so the two never disagree.
     */
    private deriveDependencyRecords(tasks: readonly Task[]): Dependency[] {
        const records: Dependency[] = [];
        for (const task of tasks) {
            for (const dependencyId of task.dependencyIds) {
                records.push({
                    id: generateId("dep"),
                    fromTaskId: dependencyId,
                    toTaskId: task.id,
                    type: DependencyType.FinishToStart
                });
            }
        }
        return records;
    }

    /* --------------------------------------------------------------------- *
     * Recursive expansion
     * --------------------------------------------------------------------- */

    private signature(goal: Goal): string {
        return `${goal.type}:${goal.title}`;
    }

    private expandGoal(
        goal: Goal,
        context: PlannerContext,
        depth: number,
        visitedPath: Set<string>,
        tasks: Task[],
        taskById: Map<string, Task>,
        subGoals: Goal[],
        methodsApplied: HTNMethodId[],
        unresolvedGoalIds: GoalId[],
        diagnostics: string[],
        onDepthLimit: (hit: boolean) => void
    ): HTNDecompositionNode {
        const nodeId = generateId("htn-node");
        const signature = this.signature(goal);

        if (depth >= this.maxDepth) {
            this.stats.depthLimitHits++;
            onDepthLimit(true);
            diagnostics.push(
                `Depth limit (${this.maxDepth}) reached while decomposing goal '${goal.id}'; emitting a placeholder task.`
            );
            const placeholder = this.emitPlaceholder(goal, context, tasks, taskById);
            unresolvedGoalIds.push(goal.id);
            return { id: nodeId, type: HTNNodeType.Primitive, goalId: goal.id, taskId: placeholder.id, depth, children: [] };
        }

        if (visitedPath.has(signature)) {
            this.stats.cyclesDetected++;
            diagnostics.push(
                `Cycle detected while decomposing goal '${goal.id}' (signature '${signature}'); emitting a placeholder task.`
            );
            const placeholder = this.emitPlaceholder(goal, context, tasks, taskById);
            unresolvedGoalIds.push(goal.id);
            return { id: nodeId, type: HTNNodeType.Primitive, goalId: goal.id, taskId: placeholder.id, depth, children: [] };
        }

        const method = this.selectMethod(goal, context);

        if (!method) {
            const placeholder = this.emitPlaceholder(goal, context, tasks, taskById);
            unresolvedGoalIds.push(goal.id);
            diagnostics.push(`No applicable HTN method for goal '${goal.id}' (type '${goal.type}').`);
            return { id: nodeId, type: HTNNodeType.Primitive, goalId: goal.id, taskId: placeholder.id, depth, children: [] };
        }

        visitedPath.add(signature);
        methodsApplied.push(method.id);
        this.stats.methodsApplied++;

        const children: HTNDecompositionNode[] = [];

        // template id -> the set of task ids that represent "entry points"
        // (no incoming dependency within this expansion) and "exit points"
        // (no outgoing dependency within this expansion) for that template.
        const entryPoints = new Map<HTNTemplateId, string[]>();
        const exitPoints = new Map<HTNTemplateId, string[]>();

        let previousTemplateId: HTNTemplateId | undefined;

        for (const template of method.subtasks) {
            const explicitDependencies = [...template.dependsOnTemplateIds];

            if (
                method.strategy === DecompositionStrategy.OrderedSubtasks &&
                previousTemplateId !== undefined &&
                explicitDependencies.length === 0
            ) {
                explicitDependencies.push(previousTemplateId);
            }

            if (template.type === HTNNodeType.Primitive) {
                const task = this.instantiateTask(template, goal, context);
                tasks.push(task);
                taskById.set(task.id, task);
                entryPoints.set(template.id, [task.id]);
                exitPoints.set(template.id, [task.id]);
                children.push({ id: generateId("htn-node"), type: HTNNodeType.Primitive, goalId: goal.id, taskId: task.id, depth: depth + 1, children: [] });
            } else {
                const subGoal = this.instantiateSubGoal(template, goal, context);
                subGoals.push(subGoal);

                const childNode = this.expandGoal(
                    subGoal,
                    context,
                    depth + 1,
                    visitedPath,
                    tasks,
                    taskById,
                    subGoals,
                    methodsApplied,
                    unresolvedGoalIds,
                    diagnostics,
                    onDepthLimit
                );

                children.push(childNode);

                const subtreeTaskIds = this.collectTaskIds(childNode);
                const { roots, leaves } = this.computeRootsAndLeaves(subtreeTaskIds, taskById);
                entryPoints.set(template.id, roots);
                exitPoints.set(template.id, leaves);
            }

            for (const dependencyTemplateId of explicitDependencies) {
                const fromTaskIds = exitPoints.get(dependencyTemplateId) ?? [];
                const toTaskIds = entryPoints.get(template.id) ?? [];

                for (const toTaskId of toTaskIds) {
                    const toTask = taskById.get(toTaskId);
                    if (!toTask) {
                        continue;
                    }
                    for (const fromTaskId of fromTaskIds) {
                        if (fromTaskId !== toTaskId && !toTask.dependencyIds.includes(fromTaskId)) {
                            toTask.dependencyIds.push(fromTaskId);
                        }
                    }
                }
            }

            previousTemplateId = template.id;
        }

        visitedPath.delete(signature);

        return { id: nodeId, type: HTNNodeType.Compound, goalId: goal.id, methodId: method.id, depth, children };
    }

    private selectMethod(goal: Goal, context: PlannerContext): HTNMethod | undefined {
        const candidates = this.registry.methodsFor(goal.type);

        for (const method of candidates) {
            if (this.evaluator.evaluateAll(method.preconditions, context.environmentState)) {
                return method;
            }
        }

        return undefined;
    }

    private instantiateTask(template: HTNSubtaskTemplate, goal: Goal, context: PlannerContext): Task {
        const now = context.timestamp;

        return {
            id: generateId("task"),
            goalId: goal.id,
            name: template.name,
            description: template.description,
            state: TaskState.Pending,
            priority: template.priority ?? goal.priority,
            estimatedDurationMs: template.estimatedDurationMs ?? 0,
            dependencyIds: [],
            resourceRequirements: template.resourceRequirements
                ? structuredClone(template.resourceRequirements)
                : [],
            constraintIds: [],
            retryCount: 0,
            maxRetries: DEFAULT_TASK_MAX_RETRIES,
            createdAt: now,
            updatedAt: now
        };
    }

    private instantiateSubGoal(template: HTNSubtaskTemplate, parent: Goal, context: PlannerContext): Goal {
        const now = context.timestamp;

        return {
            id: generateId("goal"),
            type: template.goalType!,
            status: GoalStatus.Pending,
            title: template.name,
            description: template.description,
            priority: template.priority ?? parent.priority,
            successCriteria: template.successCriteria ? [...template.successCriteria] : [],
            parentGoalId: parent.id,
            subGoalIds: [],
            relatedTaskIds: [],
            createdAt: now,
            updatedAt: now
        };
    }

    private emitPlaceholder(goal: Goal, context: PlannerContext, tasks: Task[], taskById: Map<string, Task>): Task {
        this.stats.placeholdersEmitted++;

        const now = context.timestamp;
        const task: Task = {
            id: generateId("task"),
            goalId: goal.id,
            name: `Achieve: ${goal.title}`,
            description: goal.description,
            state: TaskState.Pending,
            priority: goal.priority,
            estimatedDurationMs: 0,
            dependencyIds: [],
            resourceRequirements: [],
            constraintIds: [],
            retryCount: 0,
            maxRetries: DEFAULT_TASK_MAX_RETRIES,
            createdAt: now,
            updatedAt: now
        };

        tasks.push(task);
        taskById.set(task.id, task);
        return task;
    }

    private collectTaskIds(node: HTNDecompositionNode): string[] {
        const ids: string[] = [];

        const visit = (current: HTNDecompositionNode): void => {
            if (current.taskId !== undefined) {
                ids.push(current.taskId);
            }
            for (const child of current.children) {
                visit(child);
            }
        };

        visit(node);
        return ids;
    }

    /**
     * Given a set of task ids belonging to a single expanded subtree, returns
     * the tasks with no incoming edge from within the set (roots/entry
     * points) and no outgoing edge to within the set (leaves/exit points).
     * Reads directly off each task's own `dependencyIds` — the same field
     * `PlannerManager` builds its dependency graph from — restricted to
     * edges whose endpoints are both inside the subtree.
     */
    private computeRootsAndLeaves(
        taskIds: readonly string[],
        taskById: ReadonlyMap<string, Task>
    ): { roots: string[]; leaves: string[] } {
        const idSet = new Set(taskIds);
        const hasIncoming = new Set<string>();
        const hasOutgoing = new Set<string>();

        for (const id of taskIds) {
            const task = taskById.get(id);
            if (!task) {
                continue;
            }
            for (const dependencyId of task.dependencyIds) {
                if (idSet.has(dependencyId)) {
                    hasIncoming.add(id);
                    hasOutgoing.add(dependencyId);
                }
            }
        }

        const roots = taskIds.filter(id => !hasIncoming.has(id));
        const leaves = taskIds.filter(id => !hasOutgoing.has(id));

        return {
            roots: roots.length > 0 ? roots : [...taskIds],
            leaves: leaves.length > 0 ? leaves : [...taskIds]
        };
    }

    /* --------------------------------------------------------------------- *
     * Introspection
     * --------------------------------------------------------------------- */

    getStatistics(): HTNStatistics {
        return { ...this.stats };
    }

    resetStatistics(): void {
        this.stats.totalDecompositions = 0;
        this.stats.methodsApplied = 0;
        this.stats.placeholdersEmitted = 0;
        this.stats.cyclesDetected = 0;
        this.stats.depthLimitHits = 0;
    }

    describe(): string {
        return [
            "HTNPlanner",
            `methods=${this.registry.size()}`,
            `decompositions=${this.stats.totalDecompositions}`,
            `maxDepth=${this.maxDepth}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            maxDepth: this.maxDepth,
            registry: this.registry.inspect(),
            evaluator: this.evaluator.inspect(),
            statistics: this.getStatistics()
        };
    }
}