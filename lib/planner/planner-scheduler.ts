/**
 * =============================================================================
 * Hexical AI
 * planner-scheduler.ts
 * =============================================================================
 *
 * Scheduling Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * planner.ts's own `PlannerScheduler` computes a single critical-path
 * schedule inline as one step of `PlannerManager.createPlan`. This module is
 * the dedicated, standalone scheduling subsystem: it owns schedule
 * generation, dependency ordering, critical-path analysis, concurrency-aware
 * task assignment, incremental rescheduling, schedule-level conflict
 * detection, and schedule optimization independently of any single Plan —
 * mirroring the `ResourceManager` (planner-resource.ts) and
 * `PlannerConstraintManager` (planner-constraint.ts) pattern of a focused
 * subsystem manager with its own encapsulated domain objects, diagnostics,
 * and statistics.
 *
 * It reuses `PlannerDependencyGraph` and `PlannerTask` from planner.ts
 * directly rather than reimplementing cycle detection or topological
 * sorting, and can optionally query (read-only) a `ResourceManager`
 * (planner-resource.ts) and a `PlannerConstraintManager`
 * (planner-constraint.ts) to make scheduling resource- and
 * constraint-aware. A future `planner.ts` revision, or a
 * `planner-htn.ts`-produced task set, can hand its tasks and dependency
 * graph to this module in place of `PlannerManager`'s own inline scheduler.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - plans, decomposes goals, or builds task graphs (see planner.ts /
 *     planner-htn.ts) — it only consumes a `PlannerDependencyGraph` built
 *     elsewhere
 *   - manages constraints or evaluates their satisfaction beyond delegating
 *     to a supplied `PlannerConstraintManager` (see planner-constraint.ts)
 *   - allocates, reserves, or manages resource capacity (see
 *     planner-resource.ts's `ResourceManager`) — it only *queries* one,
 *     read-only, for resource-aware conflict detection
 *   - executes anything or has side effects outside its own in-memory state
 *
 * It ONLY schedules: dependency-ordered task placement, critical-path
 * analysis, concurrency-limited assignment, execution windows, slack,
 * incremental rescheduling, schedule validation, conflict detection, and
 * schedule optimization. Diagnostics in this module observe consistency
 * only — they never repair or mutate indexed state, matching planner.ts's,
 * planner-index.ts's, planner-resource.ts's, and planner-constraint.ts's
 * "diagnostics observe only" rule. No `eval`, no `Function` construction,
 * no reflection, and no dynamic code evaluation anywhere in this module.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
  TaskId,
  PlanId,
  ScheduleId,
  ConstraintId,
  ResourceId,
  RiskLevel,
  ValidationIssue,
  PlannerTask,
  PlannerDependencyGraph,
  SchedulePolicy,
  generateId,
} from './planner'
import { PlannerConstraintManager } from './planner-constraint'
import { ResourceManager } from './planner-resource'
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
  VersionNumber,
} from '../memory'

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const SCHEDULER_FORMAT_VERSION = 1
export const INITIAL_SCHEDULE_VERSION = 1

export const DEFAULT_SCHEDULE_MAX_CONCURRENCY = 4
export const DEFAULT_SCHEDULE_SNAPSHOT_CAPACITY = 100

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type ScheduleConflictId = string
export type SchedulerSnapshotId = string

/**
 * Clamps a value to be non-negative, collapsing NaN and other non-finite
 * values to zero rather than propagating them, mirroring planner.ts's own
 * `clamp` helper (duplicated locally rather than imported, since planner.ts
 * does not export it and this module must not depend on planner.ts
 * internals beyond its public surface).
 */
function nonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

/* =============================================================================
 * Internal Utilities — Binary Min-Heap
 * =============================================================================
 *
 * A small, dependency-free binary min-heap used internally by
 * PlannerConcurrencyAllocator to select the best-ranked ready task and the
 * earliest-available concurrency slot in O(log n) per operation, keeping
 * schedule generation viable on very large task graphs. Not exported — an
 * implementation detail of this module only.
 */
class BinaryMinHeap<T> {
  private readonly items: T[] = []
  private readonly comparator: (a: T, b: T) => number

  constructor(comparator: (a: T, b: T) => number) {
    this.comparator = comparator
  }

  get size(): number {
    return this.items.length
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  push(item: T): void {
    this.items.push(item)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined
    }
    const top = this.items[0]
    const last = this.items.pop() as T
    if (this.items.length > 0) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  private bubbleUp(index: number): void {
    let current = index
    while (current > 0) {
      const parent = (current - 1) >> 1
      if (this.comparator(this.items[current], this.items[parent]) >= 0) {
        break
      }
      ;[this.items[current], this.items[parent]] = [this.items[parent], this.items[current]]
      current = parent
    }
  }

  private bubbleDown(index: number): void {
    const length = this.items.length
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = current * 2 + 2
      let smallest = current

      if (left < length && this.comparator(this.items[left], this.items[smallest]) < 0) {
        smallest = left
      }
      if (right < length && this.comparator(this.items[right], this.items[smallest]) < 0) {
        smallest = right
      }
      if (smallest === current) {
        break
      }

      ;[this.items[current], this.items[smallest]] = [this.items[smallest], this.items[current]]
      current = smallest
    }
  }
}

/* =============================================================================
 * Schedule Entry Status
 * =============================================================================
 */

export enum ScheduleEntryStatus {
  Pending = 'pending',
  Scheduled = 'scheduled',
  Locked = 'locked',
  InProgress = 'in-progress',
  Completed = 'completed',
  Missed = 'missed',
  Cancelled = 'cancelled',
}

/* =============================================================================
 * Schedule Conflict Type
 * =============================================================================
 */

export enum ScheduleConflictType {
  ConcurrencyExceeded = 'concurrency-exceeded',
  DependencyOrderViolation = 'dependency-order-violation',
  ResourceOverCommit = 'resource-over-commit',
  ConstraintViolation = 'constraint-violation',
  NegativeSlack = 'negative-slack',
}

/* =============================================================================
 * Scheduler Event
 * =============================================================================
 */

export enum SchedulerEvent {
  ScheduleGenerated = 'schedule-generated',
  ScheduleUpdated = 'schedule-updated',
  EntryRescheduled = 'entry-rescheduled',
  ConflictDetected = 'conflict-detected',
  SnapshotCreated = 'snapshot-created',
}

/* =============================================================================
 * Schedule Entry / Schedule
 * =============================================================================
 */

export interface ScheduleEntry {
  taskId: TaskId
  earliestStart: Timestamp
  latestStart: Timestamp
  earliestFinish: Timestamp
  latestFinish: Timestamp
  actualStart: Timestamp
  actualFinish: Timestamp
  slackMs: number
  status: ScheduleEntryStatus
  concurrencySlot: number
  resourceIds: ResourceId[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Schedule {
  id: ScheduleId
  planId: PlanId
  policy: SchedulePolicy
  entries: ScheduleEntry[]
  criticalPath: TaskId[]
  makespanMs: number
  maxConcurrency: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

/* =============================================================================
 * Scheduling Options / Conflict / Validation Result
 * =============================================================================
 */

export interface SchedulingOptions {
  policy?: SchedulePolicy
  maxConcurrency?: number
  referenceStart?: Timestamp
  resources?: ResourceManager
  constraints?: PlannerConstraintManager
}

export interface ScheduleConflict {
  id: ScheduleConflictId
  type: ScheduleConflictType
  taskIds: TaskId[]
  resourceId?: ResourceId
  constraintId?: ConstraintId
  description: string
  severity: RiskLevel
  detectedAt: Timestamp
}

export interface ScheduleValidationResult {
  valid: boolean
  issues: ValidationIssue[]
  conflicts: ScheduleConflict[]
  validatedAt: Timestamp
}

/* =============================================================================
 * Critical Path / Concurrency Allocation Results
 * =============================================================================
 */

export interface CriticalPathResult {
  order: TaskId[]
  earliestStart: ReadonlyMap<TaskId, number>
  earliestFinish: ReadonlyMap<TaskId, number>
  latestStart: ReadonlyMap<TaskId, number>
  latestFinish: ReadonlyMap<TaskId, number>
  slack: ReadonlyMap<TaskId, number>
  makespanMs: number
  criticalPath: TaskId[]
}

export interface ConcurrencyAllocationResult {
  actualStart: ReadonlyMap<TaskId, number>
  actualFinish: ReadonlyMap<TaskId, number>
  concurrencySlot: ReadonlyMap<TaskId, number>
}

/* =============================================================================
 * Scheduler Statistics / Snapshot / Export / Import / Observer
 * =============================================================================
 */

export interface SchedulerStatistics {
  totalSchedules: number
  totalEntries: number
  scheduledEntries: number
  completedEntries: number
  missedEntries: number
  averageMakespanMs: number
  averageSlackMs: number
  averageUtilization: number
  totalConflictsDetected: number
  totalReschedules: number
  totalOptimizations: number
  lastComputedAt?: Timestamp
}

export interface SchedulerMetrics {
  generationTimeMs: number
  reschedulingTimeMs: number
  optimizationTimeMs: number
  lastComputedAt: Timestamp
}

export interface SchedulerSnapshot {
  id: SchedulerSnapshotId
  timestamp: Timestamp
  version: VersionNumber
  schedules: Schedule[]
}

export interface ScheduleExport {
  exportedAt: Timestamp
  formatVersion: number
  schedules: Schedule[]
}

export interface ScheduleImport {
  importedAt: Timestamp
  schedules: Schedule[]
}

export interface SchedulerObserver {
  onEvent?(event: SchedulerEvent, payload: Dictionary): void
}

/* =============================================================================
 * Planner Schedule Entry
 * =============================================================================
 *
 * A single mutable, encapsulated schedule entry for one task. Wraps a
 * `ScheduleEntry` value object with private state, defensive cloning on
 * every read/write, and explicit invariant checks before mutation —
 * mirroring the `PlannerResource` / `PlannerConstraint` pattern used
 * elsewhere in Hexical.
 *
 * `earliestStart`/`latestStart`/`earliestFinish`/`latestFinish` reflect the
 * unconstrained critical-path bounds computed by
 * `PlannerCriticalPathAnalyzer` and only change on a full reschedule.
 * `actualStart`/`actualFinish` reflect the concrete, concurrency-constrained
 * assignment and may shift via `setActualWindow` (used by
 * `PlannerSchedulePropagationEngine` for incremental updates).
 */

export class PlannerScheduleEntry
  implements
    Serializable<ScheduleEntry>,
    Cloneable<PlannerScheduleEntry>,
    Validatable,
    Versioned,
    Identifiable,
    Timestamped
{
  public readonly id: TaskId

  private earliestStart: Timestamp
  private latestStart: Timestamp
  private earliestFinish: Timestamp
  private latestFinish: Timestamp
  private actualStart: Timestamp
  private actualFinish: Timestamp
  private slackMs: number
  private status: ScheduleEntryStatus
  private concurrencySlot: number
  private resourceIds: ResourceId[]

  private created: Timestamp
  private updated: Timestamp
  private revision: VersionNumber = INITIAL_SCHEDULE_VERSION

  private frozen = false

  constructor(entry: ScheduleEntry) {
    this.id = entry.taskId
    this.earliestStart = entry.earliestStart
    this.latestStart = entry.latestStart
    this.earliestFinish = entry.earliestFinish
    this.latestFinish = entry.latestFinish
    this.actualStart = entry.actualStart
    this.actualFinish = entry.actualFinish
    this.slackMs = entry.slackMs
    this.status = entry.status
    this.concurrencySlot = entry.concurrencySlot
    this.resourceIds = [...entry.resourceIds]
    this.created = entry.createdAt
    this.updated = entry.updatedAt
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

  getTaskId(): TaskId {
    return this.id
  }

  getEarliestStart(): Timestamp {
    return this.earliestStart
  }

  getLatestStart(): Timestamp {
    return this.latestStart
  }

  getEarliestFinish(): Timestamp {
    return this.earliestFinish
  }

  getLatestFinish(): Timestamp {
    return this.latestFinish
  }

  getActualStart(): Timestamp {
    return this.actualStart
  }

  getActualFinish(): Timestamp {
    return this.actualFinish
  }

  getSlackMs(): number {
    return this.slackMs
  }

  getStatus(): ScheduleEntryStatus {
    return this.status
  }

  getConcurrencySlot(): number {
    return this.concurrencySlot
  }

  getResourceIds(): readonly ResourceId[] {
    return [...this.resourceIds]
  }

  getDurationMs(): number {
    return nonNegative(this.actualFinish - this.actualStart)
  }

  isCritical(): boolean {
    return this.slackMs <= 0
  }

  isTerminal(): boolean {
    return (
      this.status === ScheduleEntryStatus.Completed ||
      this.status === ScheduleEntryStatus.Missed ||
      this.status === ScheduleEntryStatus.Cancelled
    )
  }

  isFrozen(): boolean {
    return this.frozen
  }

  private assertMutable(): void {
    if (this.frozen) {
      throw new Error(`PlannerScheduleEntry '${this.id}' is frozen and cannot be modified.`)
    }
  }

  private touch(): void {
    this.updated = Date.now()
    this.revision++
  }

  setStatus(status: ScheduleEntryStatus): this {
    this.assertMutable()
    if (this.status === status) {
      return this
    }
    this.status = status
    this.touch()
    return this
  }

  /**
   * Updates the concrete (concurrency-constrained) execution window and
   * recomputes slack against the entry's existing critical-path
   * `latestStart` bound. Never adjusts `earliestStart` / `latestStart` /
   * `earliestFinish` / `latestFinish` themselves — those reflect the
   * unconstrained dependency structure and only change on a full
   * `PlannerScheduler.reschedule`.
   */
  setActualWindow(start: Timestamp, finish: Timestamp): this {
    this.assertMutable()
    if (finish < start) {
      throw new RangeError('Actual finish cannot precede actual start.')
    }
    this.actualStart = start
    this.actualFinish = finish
    this.slackMs = nonNegative(this.latestStart - start)
    this.touch()
    return this
  }

  assignResource(resourceId: ResourceId): this {
    this.assertMutable()
    if (!this.resourceIds.includes(resourceId)) {
      this.resourceIds.push(resourceId)
      this.touch()
    }
    return this
  }

  unassignResource(resourceId: ResourceId): this {
    this.assertMutable()
    const before = this.resourceIds.length
    this.resourceIds = this.resourceIds.filter((id) => id !== resourceId)
    if (this.resourceIds.length !== before) {
      this.touch()
    }
    return this
  }

  freeze(): this {
    this.frozen = true
    return this
  }

  unfreeze(): this {
    this.frozen = false
    return this
  }

  validate(): boolean {
    if (this.id.length === 0) {
      return false
    }
    if (this.actualFinish < this.actualStart) {
      return false
    }
    if (this.concurrencySlot < 0) {
      return false
    }
    return true
  }

  serialize(): ScheduleEntry {
    return {
      taskId: this.id,
      earliestStart: this.earliestStart,
      latestStart: this.latestStart,
      earliestFinish: this.earliestFinish,
      latestFinish: this.latestFinish,
      actualStart: this.actualStart,
      actualFinish: this.actualFinish,
      slackMs: this.slackMs,
      status: this.status,
      concurrencySlot: this.concurrencySlot,
      resourceIds: [...this.resourceIds],
      createdAt: this.created,
      updatedAt: this.updated,
    }
  }

  clone(): PlannerScheduleEntry {
    return new PlannerScheduleEntry(this.serialize())
  }

  describe(): string {
    return [
      `PlannerScheduleEntry(${this.id})`,
      `status=${this.status}`,
      `start=${this.actualStart}`,
      `finish=${this.actualFinish}`,
      `slack=${this.slackMs}`,
      `slot=${this.concurrencySlot}`,
    ].join(', ')
  }

  inspect(): Dictionary {
    return {
      taskId: this.id,
      earliestStart: this.earliestStart,
      latestStart: this.latestStart,
      earliestFinish: this.earliestFinish,
      latestFinish: this.latestFinish,
      actualStart: this.actualStart,
      actualFinish: this.actualFinish,
      slackMs: this.slackMs,
      status: this.status,
      concurrencySlot: this.concurrencySlot,
      resourceIds: [...this.resourceIds],
      critical: this.isCritical(),
      frozen: this.frozen,
    }
  }
}

/* =============================================================================
 * Planner Schedule
 * =============================================================================
 *
 * A single mutable, encapsulated schedule for one plan. Wraps a `Schedule`
 * value object plus a `TaskId -> PlannerScheduleEntry` index, mirroring the
 * `ResourceManager` / `PlannerResource` pattern: the schedule owns its own
 * bookkeeping (makespan, critical path) but never decides *how* to
 * schedule — that responsibility belongs to `PlannerCriticalPathAnalyzer`,
 * `PlannerConcurrencyAllocator`, and `PlannerSchedulePropagationEngine`,
 * which are handed the schedule explicitly by `PlannerScheduler`.
 */

export class PlannerSchedule
  implements Serializable<Schedule>, Cloneable<PlannerSchedule>, Validatable, Versioned, Identifiable, Timestamped
{
  public readonly id: ScheduleId
  public readonly planId: PlanId

  private policy: SchedulePolicy
  private entriesById: Map<TaskId, PlannerScheduleEntry>
  private criticalPathIds: TaskId[]
  private makespanMs: number
  private maxConcurrency: number

  private created: Timestamp
  private updated: Timestamp
  private revision: VersionNumber = INITIAL_SCHEDULE_VERSION

  private frozen = false

  constructor(schedule: Schedule) {
    this.id = schedule.id
    this.planId = schedule.planId
    this.policy = schedule.policy
    this.entriesById = new Map(schedule.entries.map((entry) => [entry.taskId, new PlannerScheduleEntry(entry)]))
    this.criticalPathIds = [...schedule.criticalPath]
    this.makespanMs = schedule.makespanMs
    this.maxConcurrency = schedule.maxConcurrency
    this.created = schedule.createdAt
    this.updated = schedule.updatedAt
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

  getPolicy(): SchedulePolicy {
    return this.policy
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency
  }

  getMakespanMs(): number {
    return this.makespanMs
  }

  getCriticalPath(): readonly TaskId[] {
    return [...this.criticalPathIds]
  }

  isOnCriticalPath(taskId: TaskId): boolean {
    return this.criticalPathIds.includes(taskId)
  }

  getEntry(taskId: TaskId): Optional<PlannerScheduleEntry> {
    return this.entriesById.get(taskId)
  }

  requireEntry(taskId: TaskId): PlannerScheduleEntry {
    const entry = this.entriesById.get(taskId)
    if (!entry) {
      throw new Error(`Schedule '${this.id}' has no entry for task '${taskId}'.`)
    }
    return entry
  }

  hasEntry(taskId: TaskId): boolean {
    return this.entriesById.has(taskId)
  }

  allEntries(): PlannerScheduleEntry[] {
    return [...this.entriesById.values()]
  }

  entryCount(): number {
    return this.entriesById.size
  }

  where(predicate: Predicate<PlannerScheduleEntry>): PlannerScheduleEntry[] {
    return this.allEntries().filter(predicate)
  }

  /** Total scheduled duration divided by (makespan × concurrency slots); 0 for an empty or zero-length schedule. */
  getUtilization(): number {
    if (this.makespanMs <= 0 || this.maxConcurrency <= 0) {
      return 0
    }
    const totalDurationMs = this.allEntries().reduce((sum, entry) => sum + entry.getDurationMs(), 0)
    return nonNegative(totalDurationMs / (this.makespanMs * this.maxConcurrency))
  }

  isFrozen(): boolean {
    return this.frozen
  }

  private assertMutable(): void {
    if (this.frozen) {
      throw new Error(`PlannerSchedule '${this.id}' is frozen and cannot be modified.`)
    }
  }

  private touch(): void {
    this.updated = Date.now()
    this.revision++
  }

  /**
   * Public hook for collaborating engines (e.g.
   * `PlannerSchedulePropagationEngine`) that mutate `PlannerScheduleEntry`
   * instances obtained from this schedule directly and need to bump the
   * schedule's own version/timestamp afterward.
   */
  markUpdated(): void {
    this.assertMutable()
    this.touch()
  }

  setEntryStatus(taskId: TaskId, status: ScheduleEntryStatus): this {
    this.assertMutable()
    this.requireEntry(taskId).setStatus(status)
    this.touch()
    return this
  }

  /** Recomputes `makespanMs` as (latest actual finish − earliest actual start) across all entries. */
  recomputeMakespan(): this {
    this.assertMutable()
    const entries = this.allEntries()
    if (entries.length === 0) {
      this.makespanMs = 0
      return this
    }
    const earliest = Math.min(...entries.map((entry) => entry.getActualStart()))
    const latest = Math.max(...entries.map((entry) => entry.getActualFinish()))
    this.makespanMs = nonNegative(latest - earliest)
    return this
  }

  /** Recomputes the critical path from entries whose slack is currently zero (or negative). */
  recomputeCriticalPath(): this {
    this.assertMutable()
    this.criticalPathIds = this.allEntries()
      .filter((entry) => entry.isCritical())
      .map((entry) => entry.getTaskId())
    return this
  }

  freeze(): this {
    this.frozen = true
    return this
  }

  unfreeze(): this {
    this.frozen = false
    return this
  }

  validate(): boolean {
    if (this.id.length === 0 || this.planId.length === 0) {
      return false
    }
    if (this.maxConcurrency <= 0) {
      return false
    }
    for (const entry of this.entriesById.values()) {
      if (!entry.validate()) {
        return false
      }
    }
    return true
  }

  serialize(): Schedule {
    return {
      id: this.id,
      planId: this.planId,
      policy: this.policy,
      entries: this.allEntries().map((entry) => entry.serialize()),
      criticalPath: [...this.criticalPathIds],
      makespanMs: this.makespanMs,
      maxConcurrency: this.maxConcurrency,
      createdAt: this.created,
      updatedAt: this.updated,
    }
  }

  clone(): PlannerSchedule {
    return new PlannerSchedule(this.serialize())
  }

  describe(): string {
    return [
      `PlannerSchedule(${this.id})`,
      `plan=${this.planId}`,
      `policy=${this.policy}`,
      `entries=${this.entriesById.size}`,
      `makespanMs=${this.makespanMs}`,
    ].join(', ')
  }

  inspect(): Dictionary {
    return {
      id: this.id,
      planId: this.planId,
      policy: this.policy,
      entries: this.entriesById.size,
      criticalPath: [...this.criticalPathIds],
      makespanMs: this.makespanMs,
      maxConcurrency: this.maxConcurrency,
      utilization: this.getUtilization(),
      frozen: this.frozen,
    }
  }
}

/* =============================================================================
 * Planner Critical Path Analyzer
 * =============================================================================
 *
 * Stateless (beyond an invocation counter) forward/backward-pass CPM
 * computation over a task set and dependency graph. All timestamps
 * returned are relative offsets in milliseconds from an implicit zero
 * point — callers add their own reference start time when converting to
 * absolute `Timestamp`s. Never mutates `tasks` or `graph`. Runs in
 * O(V + E) via `PlannerDependencyGraph.topologicalSort()`.
 */

export class PlannerCriticalPathAnalyzer {
  private analyses = 0

  constructor() {}

  analyze(tasks: readonly PlannerTask[], graph: PlannerDependencyGraph): CriticalPathResult {
    this.analyses++

    const order = graph.topologicalSort()
    const byId = new Map<TaskId, PlannerTask>(tasks.map((task) => [task.id, task]))

    const earliestStart = new Map<TaskId, number>()
    const earliestFinish = new Map<TaskId, number>()

    for (const id of order) {
      const duration = byId.get(id)?.getEstimatedDurationMs() ?? 0

      let start = 0
      for (const dependency of graph.dependencies(id)) {
        start = Math.max(start, earliestFinish.get(dependency) ?? 0)
      }

      earliestStart.set(id, start)
      earliestFinish.set(id, start + duration)
    }

    const makespanMs = order.length > 0 ? Math.max(...order.map((id) => earliestFinish.get(id) ?? 0)) : 0

    const latestFinish = new Map<TaskId, number>()
    const latestStart = new Map<TaskId, number>()

    for (const id of [...order].reverse()) {
      const duration = byId.get(id)?.getEstimatedDurationMs() ?? 0

      let finish = makespanMs
      for (const dependent of graph.dependents(id)) {
        finish = Math.min(finish, latestStart.get(dependent) ?? makespanMs)
      }

      latestFinish.set(id, finish)
      latestStart.set(id, finish - duration)
    }

    const slack = new Map<TaskId, number>()
    for (const id of order) {
      slack.set(id, nonNegative((latestStart.get(id) ?? 0) - (earliestStart.get(id) ?? 0)))
    }

    const criticalPath = order.filter((id) => (slack.get(id) ?? 0) === 0)

    return {
      order,
      earliestStart,
      earliestFinish,
      latestStart,
      latestFinish,
      slack,
      makespanMs,
      criticalPath,
    }
  }

  analysisCount(): number {
    return this.analyses
  }

  reset(): void {
    this.analyses = 0
  }

  describe(): string {
    return ['PlannerCriticalPathAnalyzer', `analyses=${this.analyses}`].join(', ')
  }

  inspect(): Dictionary {
    return { analyses: this.analyses }
  }
}

/* =============================================================================
 * Planner Concurrency Allocator
 * =============================================================================
 *
 * Greedily assigns each task to one of `maxConcurrency` identical
 * execution slots using a deterministic list-scheduling heuristic: among
 * tasks whose dependencies are already satisfied, the task ranked best by
 * `policy` is assigned to the earliest-available slot. Runs in
 * O((V + E) log V) via two binary heaps (ready tasks, available slots),
 * making it suitable for very large task graphs. Never mutates `tasks` or
 * `graph`.
 */

export class PlannerConcurrencyAllocator {
  private allocations = 0

  constructor() {}

  allocate(
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
    cpm: CriticalPathResult,
    policy: SchedulePolicy,
    maxConcurrency: number,
  ): ConcurrencyAllocationResult {
    this.allocations++

    const byId = new Map<TaskId, PlannerTask>(tasks.map((task) => [task.id, task]))

    const actualStart = new Map<TaskId, number>()
    const actualFinish = new Map<TaskId, number>()
    const concurrencySlot = new Map<TaskId, number>()

    const remainingDependencies = new Map<TaskId, number>()
    for (const id of cpm.order) {
      remainingDependencies.set(id, graph.dependencies(id).size)
    }

    const rank = (taskId: TaskId): [number, number] => {
      const task = byId.get(taskId)
      switch (policy) {
        case SchedulePolicy.LatestStart:
          return [cpm.latestStart.get(taskId) ?? 0, 0]
        case SchedulePolicy.PriorityFirst:
          return [-(task?.getPriorityWeight() ?? 0), cpm.earliestStart.get(taskId) ?? 0]
        case SchedulePolicy.CriticalPathFirst:
        case SchedulePolicy.LoadBalanced:
          return [cpm.slack.get(taskId) ?? 0, cpm.earliestStart.get(taskId) ?? 0]
        case SchedulePolicy.EarliestStart:
        default:
          return [cpm.earliestStart.get(taskId) ?? 0, 0]
      }
    }

    const ready = new BinaryMinHeap<TaskId>((a, b) => {
      const rankA = rank(a)
      const rankB = rank(b)
      return rankA[0] - rankB[0] || rankA[1] - rankB[1] || (a < b ? -1 : a > b ? 1 : 0)
    })

    for (const [id, count] of remainingDependencies) {
      if (count === 0) {
        ready.push(id)
      }
    }

    const slots = new BinaryMinHeap<{ slot: number; availableAt: number }>(
      (a, b) => a.availableAt - b.availableAt || a.slot - b.slot,
    )
    for (let slot = 0; slot < maxConcurrency; slot++) {
      slots.push({ slot, availableAt: 0 })
    }

    while (!ready.isEmpty()) {
      const taskId = ready.pop() as TaskId
      const duration = byId.get(taskId)?.getEstimatedDurationMs() ?? 0

      let readyTime = cpm.earliestStart.get(taskId) ?? 0
      for (const dependency of graph.dependencies(taskId)) {
        readyTime = Math.max(readyTime, actualFinish.get(dependency) ?? 0)
      }

      const slot = slots.pop() as { slot: number; availableAt: number }
      const start = Math.max(readyTime, slot.availableAt)
      const finish = start + duration

      actualStart.set(taskId, start)
      actualFinish.set(taskId, finish)
      concurrencySlot.set(taskId, slot.slot)

      slots.push({ slot: slot.slot, availableAt: finish })

      for (const dependent of graph.dependents(taskId)) {
        const remaining = (remainingDependencies.get(dependent) ?? 0) - 1
        remainingDependencies.set(dependent, remaining)
        if (remaining === 0) {
          ready.push(dependent)
        }
      }
    }

    return { actualStart, actualFinish, concurrencySlot }
  }

  allocationCount(): number {
    return this.allocations
  }

  reset(): void {
    this.allocations = 0
  }

  describe(): string {
    return ['PlannerConcurrencyAllocator', `allocations=${this.allocations}`].join(', ')
  }

  inspect(): Dictionary {
    return { allocations: this.allocations }
  }
}

/* =============================================================================
 * Planner Schedule Propagation Engine
 * =============================================================================
 *
 * Shifts a single task's actual window and cascades the change forward to
 * dependents, mirroring the BFS propagation pattern used by
 * `PlannerConstraintPropagationEngine` (planner-constraint.ts) and
 * `PlannerConstraintEngine.propagate` (planner.ts). This is an approximate,
 * fast incremental update — it preserves dependency ordering without
 * re-running full concurrency allocation, so it never contends for
 * concurrency slots with unrelated tasks. Callers that need an exactly
 * optimal schedule after many incremental shifts should periodically call
 * `PlannerScheduler.reschedule` instead.
 */

export class PlannerSchedulePropagationEngine {
  private propagations = 0

  constructor() {}

  propagateShift(
    schedule: PlannerSchedule,
    taskId: TaskId,
    newActualStart: Timestamp,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    graph: PlannerDependencyGraph,
  ): TaskId[] {
    this.propagations++

    const shifted: TaskId[] = []
    const entry = schedule.requireEntry(taskId)

    const duration =
      tasksById.get(taskId)?.getEstimatedDurationMs() ?? nonNegative(entry.getActualFinish() - entry.getActualStart())

    entry.setActualWindow(newActualStart, newActualStart + duration)

    const visited = new Set<TaskId>([taskId])
    const queue: TaskId[] = [...graph.dependents(taskId)]

    while (queue.length > 0) {
      const current = queue.shift() as TaskId
      if (visited.has(current)) {
        continue
      }
      visited.add(current)

      const currentEntry = schedule.getEntry(current)
      if (!currentEntry) {
        continue
      }

      let requiredStart = currentEntry.getActualStart()
      for (const dependency of graph.dependencies(current)) {
        const dependencyEntry = schedule.getEntry(dependency)
        if (dependencyEntry) {
          requiredStart = Math.max(requiredStart, dependencyEntry.getActualFinish())
        }
      }

      if (requiredStart > currentEntry.getActualStart()) {
        const currentDuration =
          tasksById.get(current)?.getEstimatedDurationMs() ??
          nonNegative(currentEntry.getActualFinish() - currentEntry.getActualStart())

        currentEntry.setActualWindow(requiredStart, requiredStart + currentDuration)
        shifted.push(current)
        queue.push(...graph.dependents(current))
      }
    }

    schedule.recomputeMakespan()
    schedule.markUpdated()

    return shifted
  }

  propagationCount(): number {
    return this.propagations
  }

  reset(): void {
    this.propagations = 0
  }

  describe(): string {
    return ['PlannerSchedulePropagationEngine', `propagations=${this.propagations}`].join(', ')
  }

  inspect(): Dictionary {
    return { propagations: this.propagations }
  }
}

/* =============================================================================
 * Planner Schedule Conflict Detector
 * =============================================================================
 *
 * Structural, side-effect-free conflict detection over a schedule. Every
 * check only reads schedule/task state (and, optionally, read-only queries
 * a supplied `ResourceManager` / `PlannerConstraintManager`) and produces
 * `ScheduleConflict` records — it never mutates a `PlannerSchedule`,
 * `PlannerScheduleEntry`, `ResourceManager`, or `PlannerConstraintManager`,
 * and never performs dynamic code evaluation of any kind.
 */

export class PlannerScheduleConflictDetector {
  private detections = 0

  constructor() {}

  detectAll(
    schedule: PlannerSchedule,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    options: { maxConcurrency?: number; resources?: ResourceManager; constraints?: PlannerConstraintManager } = {},
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    conflicts.push(
      ...this.detectConcurrencyViolations(schedule, options.maxConcurrency ?? schedule.getMaxConcurrency()),
    )
    conflicts.push(...this.detectDependencyOrderViolations(schedule, tasksById))
    conflicts.push(...this.detectNegativeSlack(schedule))

    if (options.resources) {
      conflicts.push(...this.detectResourceOverCommit(schedule, tasksById, options.resources))
    }

    if (options.constraints) {
      conflicts.push(...this.detectConstraintViolations(schedule, tasksById, options.constraints, options.resources))
    }

    return conflicts
  }

  /**
   * Sweeps entry start/finish events in chronological order and checks
   * that the number of simultaneously active entries never exceeds
   * `maxConcurrency`. O(n log n) via a sorted event list.
   */
  private detectConcurrencyViolations(schedule: PlannerSchedule, maxConcurrency: number): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    type ScheduleEvent = { time: Timestamp; delta: 1 | -1; taskId: TaskId }
    const events: ScheduleEvent[] = []

    for (const entry of schedule.allEntries()) {
      events.push({ time: entry.getActualStart(), delta: 1, taskId: entry.getTaskId() })
      events.push({ time: entry.getActualFinish(), delta: -1, taskId: entry.getTaskId() })
    }

    events.sort((a, b) => a.time - b.time || a.delta - b.delta)

    let active = 0
    const activeTaskIds = new Set<TaskId>()

    for (const event of events) {
      if (event.delta === 1) {
        active++
        activeTaskIds.add(event.taskId)

        if (active > maxConcurrency) {
          this.detections++
          conflicts.push({
            id: generateId('sconflict'),
            type: ScheduleConflictType.ConcurrencyExceeded,
            taskIds: [...activeTaskIds],
            description:
              `${active} tasks are active simultaneously at t=${event.time}, exceeding the ` +
              `configured concurrency limit of ${maxConcurrency}.`,
            severity: RiskLevel.High,
            detectedAt: Date.now(),
          })
        }
      } else {
        active--
        activeTaskIds.delete(event.taskId)
      }
    }

    return conflicts
  }

  private detectDependencyOrderViolations(
    schedule: PlannerSchedule,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    for (const entry of schedule.allEntries()) {
      const task = tasksById.get(entry.getTaskId())
      if (!task) {
        continue
      }

      for (const dependencyId of task.getDependencyIds()) {
        const dependencyEntry = schedule.getEntry(dependencyId)
        if (dependencyEntry && entry.getActualStart() < dependencyEntry.getActualFinish()) {
          this.detections++
          conflicts.push({
            id: generateId('sconflict'),
            type: ScheduleConflictType.DependencyOrderViolation,
            taskIds: [entry.getTaskId(), dependencyId],
            description:
              `Task '${entry.getTaskId()}' is scheduled to start before its dependency ` +
              `'${dependencyId}' finishes.`,
            severity: RiskLevel.Severe,
            detectedAt: Date.now(),
          })
        }
      }
    }

    return conflicts
  }

  private detectNegativeSlack(schedule: PlannerSchedule): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    for (const entry of schedule.allEntries()) {
      if (entry.getSlackMs() < 0) {
        this.detections++
        conflicts.push({
          id: generateId('sconflict'),
          type: ScheduleConflictType.NegativeSlack,
          taskIds: [entry.getTaskId()],
          description: `Task '${entry.getTaskId()}' has negative slack (${entry.getSlackMs()}ms).`,
          severity: RiskLevel.Moderate,
          detectedAt: Date.now(),
        })
      }
    }

    return conflicts
  }

  /**
   * For each resource referenced by any scheduled task's declared
   * `ResourceRequirement`s, sums the required amount across every
   * simultaneously-active entry and flags any point in time where that
   * sum exceeds the resource's live capacity (queried read-only from
   * `ResourceManager`).
   */
  private detectResourceOverCommit(
    schedule: PlannerSchedule,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    resources: ResourceManager,
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    const demandByResource = new Map<ResourceId, Array<{ entry: PlannerScheduleEntry; amount: number }>>()

    for (const entry of schedule.allEntries()) {
      const task = tasksById.get(entry.getTaskId())
      if (!task) {
        continue
      }
      for (const requirement of task.getResourceRequirements()) {
        let bucket = demandByResource.get(requirement.resourceId)
        if (!bucket) {
          bucket = []
          demandByResource.set(requirement.resourceId, bucket)
        }
        bucket.push({ entry, amount: requirement.amount })
      }
    }

    for (const [resourceId, demands] of demandByResource) {
      const resource = resources.getResource(resourceId)
      if (!resource) {
        continue
      }

      type DemandEvent = { time: Timestamp; delta: number }
      const events: DemandEvent[] = []
      for (const demand of demands) {
        events.push({ time: demand.entry.getActualStart(), delta: demand.amount })
        events.push({ time: demand.entry.getActualFinish(), delta: -demand.amount })
      }
      events.sort((a, b) => a.time - b.time || a.delta - b.delta)

      let concurrentAmount = 0
      let flagged = false

      for (const event of events) {
        concurrentAmount += event.delta
        if (!flagged && concurrentAmount > resource.getCapacity()) {
          flagged = true
          this.detections++
          conflicts.push({
            id: generateId('sconflict'),
            type: ScheduleConflictType.ResourceOverCommit,
            taskIds: demands.map((demand) => demand.entry.getTaskId()),
            resourceId,
            description:
              `Scheduled demand for resource '${resourceId}' reaches ${concurrentAmount}, ` +
              `exceeding its capacity of ${resource.getCapacity()}.`,
            severity: RiskLevel.High,
            detectedAt: Date.now(),
          })
        }
      }
    }

    return conflicts
  }

  private detectConstraintViolations(
    schedule: PlannerSchedule,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    constraints: PlannerConstraintManager,
    resources?: ResourceManager,
  ): ScheduleConflict[] {
    const conflicts: ScheduleConflict[] = []

    for (const entry of schedule.allEntries()) {
      const task = tasksById.get(entry.getTaskId())
      if (!task) {
        continue
      }

      const issues = constraints.evaluateTask(task, { resources })
      for (const issue of issues) {
        if (issue.severity !== RiskLevel.Severe && issue.severity !== RiskLevel.High) {
          continue
        }
        this.detections++
        conflicts.push({
          id: generateId('sconflict'),
          type: ScheduleConflictType.ConstraintViolation,
          taskIds: [entry.getTaskId()],
          constraintId: issue.constraintId,
          description: issue.message,
          severity: issue.severity,
          detectedAt: Date.now(),
        })
      }
    }

    return conflicts
  }

  detectionCount(): number {
    return this.detections
  }

  reset(): void {
    this.detections = 0
  }

  describe(): string {
    return ['PlannerScheduleConflictDetector', `detections=${this.detections}`].join(', ')
  }

  inspect(): Dictionary {
    return { detections: this.detections }
  }
}

/* =============================================================================
 * Planner Schedule Validator
 * =============================================================================
 */

export class PlannerScheduleValidator {
  private readonly conflictDetector: PlannerScheduleConflictDetector

  private validations = 0

  constructor(conflictDetector: PlannerScheduleConflictDetector) {
    this.conflictDetector = conflictDetector
  }

  validate(
    schedule: PlannerSchedule,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    options: { resources?: ResourceManager; constraints?: PlannerConstraintManager } = {},
  ): ScheduleValidationResult {
    this.validations++

    const issues: ValidationIssue[] = []

    if (!schedule.validate()) {
      issues.push({
        code: 'SCHEDULE_INVALID',
        message: `Schedule '${schedule.id}' failed structural validation.`,
        severity: RiskLevel.High,
      })
    }

    for (const entry of schedule.allEntries()) {
      if (!tasksById.has(entry.getTaskId())) {
        issues.push({
          code: 'SCHEDULE_ENTRY_UNKNOWN_TASK',
          message: `Schedule '${schedule.id}' has an entry for unknown task '${entry.getTaskId()}'.`,
          severity: RiskLevel.High,
          taskId: entry.getTaskId(),
        })
      }
    }

    const conflicts = this.conflictDetector.detectAll(schedule, tasksById, options)

    for (const conflict of conflicts) {
      issues.push({
        code: `SCHEDULE_${conflict.type.toUpperCase().replace(/-/g, '_')}`,
        message: conflict.description,
        severity: conflict.severity,
        taskId: conflict.taskIds[0],
        constraintId: conflict.constraintId,
      })
    }

    const hardFailures = issues.filter(
      (issue) => issue.severity === RiskLevel.Severe || issue.severity === RiskLevel.High,
    )

    return {
      valid: hardFailures.length === 0,
      issues,
      conflicts,
      validatedAt: Date.now(),
    }
  }

  validationCount(): number {
    return this.validations
  }

  reset(): void {
    this.validations = 0
  }

  describe(): string {
    return ['PlannerScheduleValidator', `validations=${this.validations}`].join(', ')
  }

  inspect(): Dictionary {
    return { validations: this.validations }
  }
}

/* =============================================================================
 * Planner Schedule Optimizer
 * =============================================================================
 *
 * Builds a schedule under each candidate `SchedulePolicy` (via an injected
 * builder callback, keeping this class decoupled from `PlannerScheduler`'s
 * internals) and deterministically selects the one with the lowest
 * makespan, preferring the earliest-listed policy on ties.
 */

export class PlannerScheduleOptimizer {
  private optimizations = 0

  constructor() {}

  optimize(
    policies: readonly SchedulePolicy[],
    buildFn: (policy: SchedulePolicy) => PlannerSchedule,
  ): { schedule: PlannerSchedule; policy: SchedulePolicy } {
    this.optimizations++

    let best: PlannerSchedule | undefined
    let bestPolicy: SchedulePolicy | undefined

    for (const policy of policies) {
      const candidate = buildFn(policy)
      if (!best || candidate.getMakespanMs() < best.getMakespanMs()) {
        best = candidate
        bestPolicy = policy
      }
    }

    if (!best || bestPolicy === undefined) {
      throw new Error('No candidate schedule policies were supplied.')
    }

    return { schedule: best, policy: bestPolicy }
  }

  optimizationCount(): number {
    return this.optimizations
  }

  reset(): void {
    this.optimizations = 0
  }

  describe(): string {
    return ['PlannerScheduleOptimizer', `optimizations=${this.optimizations}`].join(', ')
  }

  inspect(): Dictionary {
    return { optimizations: this.optimizations }
  }
}

/* =============================================================================
 * Planner Schedule Snapshot Manager
 * =============================================================================
 */

export class PlannerScheduleSnapshotManager {
  private readonly snapshots = new Map<SchedulerSnapshotId, SchedulerSnapshot>()

  private readonly history: SchedulerSnapshotId[] = []

  private readonly capacity: number

  constructor(capacity = DEFAULT_SCHEDULE_SNAPSHOT_CAPACITY) {
    if (capacity <= 0) {
      throw new RangeError('Snapshot capacity must be greater than zero.')
    }
    this.capacity = capacity
  }

  create(schedules: readonly Schedule[]): SchedulerSnapshot {
    const snapshot: SchedulerSnapshot = {
      id: generateId('ssnap'),
      timestamp: Date.now(),
      version: SCHEDULER_FORMAT_VERSION,
      schedules: structuredClone([...schedules]),
    }

    this.snapshots.set(snapshot.id, structuredClone(snapshot))
    this.history.push(snapshot.id)

    while (this.history.length > this.capacity) {
      const oldest = this.history.shift()
      if (oldest !== undefined) {
        this.snapshots.delete(oldest)
      }
    }

    return structuredClone(snapshot)
  }

  get(id: SchedulerSnapshotId): Optional<SchedulerSnapshot> {
    const snapshot = this.snapshots.get(id)
    return snapshot ? structuredClone(snapshot) : undefined
  }

  latest(): Optional<SchedulerSnapshot> {
    const id = this.history.at(-1)
    return id ? this.get(id) : undefined
  }

  remove(id: SchedulerSnapshotId): boolean {
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

  ids(): readonly SchedulerSnapshotId[] {
    return [...this.history]
  }

  describe(): string {
    return ['PlannerScheduleSnapshotManager', `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(', ')
  }

  inspect(): Dictionary {
    return { size: this.size(), capacity: this.capacity, history: [...this.history] }
  }
}

/* =============================================================================
 * Planner Scheduler Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over a `PlannerScheduler`'s
 * internal state. Every `validate*` method only inspects state; none of
 * them mutate the scheduler or repair inconsistencies — an inconsistent
 * schedule set is surfaced, never silently patched, mirroring
 * `ResourceDiagnostics` / `PlannerConstraintDiagnostics` / `PlannerDiagnostics`.
 */

export class PlannerSchedulerDiagnostics {
  private checks = 0
  private failures = 0

  constructor() {}

  validateScheduleInvariants(scheduler: PlannerScheduler): boolean {
    this.checks++
    let valid = true

    for (const schedule of scheduler.allSchedules()) {
      if (!schedule.validate()) {
        valid = false
      }
    }

    if (!valid) {
      this.failures++
    }
    return valid
  }

  validateEntryCoverage(scheduler: PlannerScheduler, tasksById: ReadonlyMap<TaskId, PlannerTask>): boolean {
    this.checks++
    let valid = true

    for (const schedule of scheduler.allSchedules()) {
      for (const entry of schedule.allEntries()) {
        if (!tasksById.has(entry.getTaskId())) {
          valid = false
        }
      }
    }

    if (!valid) {
      this.failures++
    }
    return valid
  }

  /**
   * Referential-integrity report: which schedule entries reference a
   * task id that is no longer known. This never repairs the reference —
   * it only reports it.
   */
  findDanglingEntries(
    scheduler: PlannerScheduler,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
  ): Array<{ scheduleId: ScheduleId; taskId: TaskId }> {
    this.checks++

    const dangling: Array<{ scheduleId: ScheduleId; taskId: TaskId }> = []

    for (const schedule of scheduler.allSchedules()) {
      for (const entry of schedule.allEntries()) {
        if (!tasksById.has(entry.getTaskId())) {
          dangling.push({ scheduleId: schedule.id, taskId: entry.getTaskId() })
        }
      }
    }

    if (dangling.length > 0) {
      this.failures++
    }

    return dangling
  }

  runAll(scheduler: PlannerScheduler, tasksById: ReadonlyMap<TaskId, PlannerTask>): boolean {
    const dangling = this.findDanglingEntries(scheduler, tasksById)
    return (
      this.validateScheduleInvariants(scheduler) &&
      this.validateEntryCoverage(scheduler, tasksById) &&
      dangling.length === 0
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
      'PlannerSchedulerDiagnostics',
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
 * Planner Scheduler
 * =============================================================================
 *
 * The single public façade over the scheduling subsystem. Owns the
 * canonical `ScheduleId -> PlannerSchedule` map, a
 * `PlannerCriticalPathAnalyzer`, a `PlannerConcurrencyAllocator`, a
 * `PlannerSchedulePropagationEngine`, a `PlannerScheduleConflictDetector`,
 * a `PlannerScheduleValidator`, a `PlannerScheduleOptimizer`, a
 * `PlannerScheduleSnapshotManager`, and a `PlannerSchedulerDiagnostics`
 * instance.
 *
 * `PlannerScheduler` never plans, decomposes goals, manages constraints, or
 * allocates resource capacity; it only schedules an already-built task set
 * and dependency graph for other subsystems (planner.ts's `PlannerManager`,
 * an executor, or a UI) to consume.
 */

export class PlannerScheduler {
  private readonly schedulesById = new Map<ScheduleId, PlannerSchedule>()

  private readonly analyzer = new PlannerCriticalPathAnalyzer()
  private readonly allocator = new PlannerConcurrencyAllocator()
  private readonly propagationEngine = new PlannerSchedulePropagationEngine()
  private readonly conflictDetector = new PlannerScheduleConflictDetector()
  private readonly validator: PlannerScheduleValidator
  private readonly optimizer = new PlannerScheduleOptimizer()
  private readonly snapshotManager: PlannerScheduleSnapshotManager
  private readonly diagnostics = new PlannerSchedulerDiagnostics()

  private readonly observers = new Set<SchedulerObserver>()

  private readonly defaultMaxConcurrency: number

  private rescheduleCount = 0

  private readonly metrics: SchedulerMetrics = {
    generationTimeMs: 0,
    reschedulingTimeMs: 0,
    optimizationTimeMs: 0,
    lastComputedAt: Date.now(),
  }

  constructor(
    defaultMaxConcurrency: number = DEFAULT_SCHEDULE_MAX_CONCURRENCY,
    snapshotCapacity: number = DEFAULT_SCHEDULE_SNAPSHOT_CAPACITY,
  ) {
    if (defaultMaxConcurrency <= 0) {
      throw new RangeError('defaultMaxConcurrency must be greater than zero.')
    }
    this.defaultMaxConcurrency = defaultMaxConcurrency
    this.snapshotManager = new PlannerScheduleSnapshotManager(snapshotCapacity)
    this.validator = new PlannerScheduleValidator(this.conflictDetector)
  }

  /* --------------------------------------------------------------------- *
   * Observers
   * --------------------------------------------------------------------- */

  subscribe(observer: SchedulerObserver): void {
    this.observers.add(observer)
  }

  unsubscribe(observer: SchedulerObserver): void {
    this.observers.delete(observer)
  }

  private emit(event: SchedulerEvent, payload: Dictionary): void {
    for (const observer of this.observers) {
      observer.onEvent?.(event, payload)
    }
  }

  /* --------------------------------------------------------------------- *
   * Schedule Generation
   * --------------------------------------------------------------------- */

  /**
   * Builds a fresh `PlannerSchedule` for `tasks` over `graph`: critical
   * path analysis, then concurrency-limited task assignment. Throws if
   * `graph` contains a cycle rather than returning a partial or
   * incorrect schedule.
   */
  generateSchedule(
    planId: PlanId,
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
    options: SchedulingOptions = {},
  ): PlannerSchedule {
    const started = performance.now()

    if (graph.hasCycle()) {
      throw new Error(`Cannot schedule plan '${planId}': dependency graph contains a cycle.`)
    }

    const policy = options.policy ?? SchedulePolicy.CriticalPathFirst
    const maxConcurrency = options.maxConcurrency ?? this.defaultMaxConcurrency
    const referenceStart = options.referenceStart ?? Date.now()

    if (maxConcurrency <= 0) {
      throw new RangeError('maxConcurrency must be greater than zero.')
    }

    const schedule = this.buildScheduleInternal(planId, tasks, graph, policy, maxConcurrency, referenceStart)

    this.schedulesById.set(schedule.id, schedule)

    this.metrics.generationTimeMs = performance.now() - started
    this.metrics.lastComputedAt = Date.now()

    this.emit(SchedulerEvent.ScheduleGenerated, { scheduleId: schedule.id, planId })

    return schedule
  }

  private buildScheduleInternal(
    planId: PlanId,
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
    policy: SchedulePolicy,
    maxConcurrency: number,
    referenceStart: Timestamp,
    existingId?: ScheduleId,
  ): PlannerSchedule {
    const cpm = this.analyzer.analyze(tasks, graph)
    const allocation = this.allocator.allocate(tasks, graph, cpm, policy, maxConcurrency)
    const now = Date.now()

    const entries: ScheduleEntry[] = cpm.order.map((taskId) => {
      const actualStart = referenceStart + (allocation.actualStart.get(taskId) ?? 0)
      const actualFinish = referenceStart + (allocation.actualFinish.get(taskId) ?? 0)
      const latestStart = referenceStart + (cpm.latestStart.get(taskId) ?? 0)

      return {
        taskId,
        earliestStart: referenceStart + (cpm.earliestStart.get(taskId) ?? 0),
        latestStart,
        earliestFinish: referenceStart + (cpm.earliestFinish.get(taskId) ?? 0),
        latestFinish: referenceStart + (cpm.latestFinish.get(taskId) ?? 0),
        actualStart,
        actualFinish,
        slackMs: nonNegative(latestStart - actualStart),
        status: ScheduleEntryStatus.Scheduled,
        concurrencySlot: allocation.concurrencySlot.get(taskId) ?? 0,
        resourceIds: [],
        createdAt: now,
        updatedAt: now,
      }
    })

    const starts = entries.map((entry) => entry.actualStart)
    const finishes = entries.map((entry) => entry.actualFinish)
    const makespanMs = entries.length > 0 ? nonNegative(Math.max(...finishes) - Math.min(...starts)) : 0

    const schedule: Schedule = {
      id: existingId ?? generateId('sched'),
      planId,
      policy,
      entries,
      criticalPath: cpm.criticalPath,
      makespanMs,
      maxConcurrency,
      createdAt: now,
      updatedAt: now,
    }

    return new PlannerSchedule(schedule)
  }

  /* --------------------------------------------------------------------- *
   * Rescheduling
   * --------------------------------------------------------------------- */

  /** Fully rebuilds an existing schedule, keeping its id but recomputing every entry. */
  reschedule(
    scheduleId: ScheduleId,
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
    options: SchedulingOptions = {},
  ): PlannerSchedule {
    const started = performance.now()
    const existing = this.requireSchedule(scheduleId)

    if (graph.hasCycle()) {
      throw new Error(`Cannot reschedule '${scheduleId}': dependency graph contains a cycle.`)
    }

    const policy = options.policy ?? existing.getPolicy()
    const maxConcurrency = options.maxConcurrency ?? existing.getMaxConcurrency()
    const referenceStart = options.referenceStart ?? Date.now()

    const rebuilt = this.buildScheduleInternal(
      existing.planId,
      tasks,
      graph,
      policy,
      maxConcurrency,
      referenceStart,
      scheduleId,
    )

    this.schedulesById.set(scheduleId, rebuilt)
    this.rescheduleCount++

    this.metrics.reschedulingTimeMs = performance.now() - started
    this.metrics.lastComputedAt = Date.now()

    this.emit(SchedulerEvent.ScheduleUpdated, { scheduleId })

    return rebuilt
  }

  /**
   * Incrementally shifts a single task's start time and cascades the
   * change to dependents in place, without a full rebuild. Returns the
   * ids of every task whose window was shifted as a result (including
   * `taskId` itself).
   */
  rescheduleTask(
    scheduleId: ScheduleId,
    taskId: TaskId,
    newActualStart: Timestamp,
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
  ): TaskId[] {
    const started = performance.now()
    const schedule = this.requireSchedule(scheduleId)
    const tasksById = new Map<TaskId, PlannerTask>(tasks.map((task) => [task.id, task]))

    const shifted = this.propagationEngine.propagateShift(schedule, taskId, newActualStart, tasksById, graph)
    this.rescheduleCount++

    this.metrics.reschedulingTimeMs = performance.now() - started
    this.metrics.lastComputedAt = Date.now()

    this.emit(SchedulerEvent.EntryRescheduled, { scheduleId, taskId, shifted: shifted.length })

    return [taskId, ...shifted]
  }

  /* --------------------------------------------------------------------- *
   * Optimization
   * --------------------------------------------------------------------- */

  /**
   * Builds a schedule under each of `candidatePolicies` (defaulting to
   * every `SchedulePolicy`) and registers the one with the lowest
   * makespan.
   */
  optimizeSchedule(
    planId: PlanId,
    tasks: readonly PlannerTask[],
    graph: PlannerDependencyGraph,
    candidatePolicies: readonly SchedulePolicy[] = [],
    options: SchedulingOptions = {},
  ): PlannerSchedule {
    const started = performance.now()

    if (graph.hasCycle()) {
      throw new Error(`Cannot optimize schedule for plan '${planId}': dependency graph contains a cycle.`)
    }

    const maxConcurrency = options.maxConcurrency ?? this.defaultMaxConcurrency
    const referenceStart = options.referenceStart ?? Date.now()
    const policies =
      candidatePolicies.length > 0 ? candidatePolicies : (Object.values(SchedulePolicy) as SchedulePolicy[])

    const { schedule } = this.optimizer.optimize(policies, (policy) =>
      this.buildScheduleInternal(planId, tasks, graph, policy, maxConcurrency, referenceStart),
    )

    this.schedulesById.set(schedule.id, schedule)

    this.metrics.optimizationTimeMs = performance.now() - started
    this.metrics.lastComputedAt = Date.now()

    this.emit(SchedulerEvent.ScheduleGenerated, { scheduleId: schedule.id, planId, optimized: true })

    return schedule
  }

  /* --------------------------------------------------------------------- *
   * Conflict Detection / Validation
   * --------------------------------------------------------------------- */

  detectConflicts(
    scheduleId: ScheduleId,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    options: { resources?: ResourceManager; constraints?: PlannerConstraintManager } = {},
  ): ScheduleConflict[] {
    const schedule = this.requireSchedule(scheduleId)
    const conflicts = this.conflictDetector.detectAll(schedule, tasksById, {
      maxConcurrency: schedule.getMaxConcurrency(),
      resources: options.resources,
      constraints: options.constraints,
    })

    if (conflicts.length > 0) {
      this.emit(SchedulerEvent.ConflictDetected, { scheduleId, count: conflicts.length })
    }

    return conflicts
  }

  validateSchedule(
    scheduleId: ScheduleId,
    tasksById: ReadonlyMap<TaskId, PlannerTask>,
    options: { resources?: ResourceManager; constraints?: PlannerConstraintManager } = {},
  ): ScheduleValidationResult {
    const schedule = this.requireSchedule(scheduleId)
    return this.validator.validate(schedule, tasksById, options)
  }

  /* --------------------------------------------------------------------- *
   * Accessors
   * --------------------------------------------------------------------- */

  getSchedule(id: ScheduleId): Optional<PlannerSchedule> {
    return this.schedulesById.get(id)
  }

  requireSchedule(id: ScheduleId): PlannerSchedule {
    const schedule = this.schedulesById.get(id)
    if (!schedule) {
      throw new Error(`Schedule '${id}' does not exist.`)
    }
    return schedule
  }

  hasSchedule(id: ScheduleId): boolean {
    return this.schedulesById.has(id)
  }

  removeSchedule(id: ScheduleId): boolean {
    return this.schedulesById.delete(id)
  }

  allSchedules(): PlannerSchedule[] {
    return [...this.schedulesById.values()]
  }

  scheduleCount(): number {
    return this.schedulesById.size
  }

  where(predicate: Predicate<PlannerSchedule>): PlannerSchedule[] {
    return this.allSchedules().filter(predicate)
  }

  schedulesForPlan(planId: PlanId): PlannerSchedule[] {
    return this.where((schedule) => schedule.planId === planId)
  }

  /* --------------------------------------------------------------------- *
   * Snapshot / Serialization
   * --------------------------------------------------------------------- */

  snapshot(): SchedulerSnapshot {
    const snapshot = this.snapshotManager.create(this.allSchedules().map((schedule) => schedule.serialize()))
    this.emit(SchedulerEvent.SnapshotCreated, { snapshotId: snapshot.id })
    return snapshot
  }

  /** Restores this scheduler's schedule state from a snapshot, discarding any schedules currently registered. */
  restoreSnapshot(snapshot: SchedulerSnapshot): void {
    this.schedulesById.clear()
    for (const schedule of snapshot.schedules) {
      this.schedulesById.set(schedule.id, new PlannerSchedule(schedule))
    }
  }

  /**
   * Deep, fully independent copy: reconstructs every `PlannerSchedule`
   * from serialized data rather than sharing references with the
   * original scheduler. Operational counters (generations, reschedules,
   * conflicts, optimizations) are not carried over — a clone represents
   * a fresh scheduler seeded with the same schedules, matching the
   * "no shared mutable state" guarantee `ResourceManager.clone()` and
   * `PlannerConstraintManager.clone()` provide.
   */
  clone(): PlannerScheduler {
    const clone = new PlannerScheduler(this.defaultMaxConcurrency)
    for (const schedule of this.allSchedules()) {
      clone.schedulesById.set(schedule.id, schedule.clone())
    }
    return clone
  }

  export(): ScheduleExport {
    return {
      exportedAt: Date.now(),
      formatVersion: SCHEDULER_FORMAT_VERSION,
      schedules: this.allSchedules().map((schedule) => schedule.serialize()),
    }
  }

  import(data: ScheduleImport): number {
    if (!Array.isArray(data.schedules)) {
      throw new TypeError('ScheduleImport.schedules must be an array.')
    }

    let count = 0
    for (const schedule of data.schedules) {
      this.schedulesById.set(schedule.id, new PlannerSchedule(schedule))
      count++
    }
    return count
  }

  /* --------------------------------------------------------------------- *
   * Diagnostics / Statistics
   * --------------------------------------------------------------------- */

  runDiagnostics(tasksById: ReadonlyMap<TaskId, PlannerTask>): boolean {
    return this.diagnostics.runAll(this, tasksById)
  }

  getMetrics(): SchedulerMetrics {
    return structuredClone(this.metrics)
  }

  getStatistics(): SchedulerStatistics {
    const schedules = this.allSchedules()

    let totalEntries = 0
    let scheduledEntries = 0
    let completedEntries = 0
    let missedEntries = 0
    let makespanSum = 0
    let slackSum = 0
    let utilizationSum = 0

    for (const schedule of schedules) {
      const entries = schedule.allEntries()

      totalEntries += entries.length
      scheduledEntries += entries.filter((entry) => entry.getStatus() === ScheduleEntryStatus.Scheduled).length
      completedEntries += entries.filter((entry) => entry.getStatus() === ScheduleEntryStatus.Completed).length
      missedEntries += entries.filter((entry) => entry.getStatus() === ScheduleEntryStatus.Missed).length

      makespanSum += schedule.getMakespanMs()
      slackSum += entries.reduce((sum, entry) => sum + entry.getSlackMs(), 0)
      utilizationSum += schedule.getUtilization()
    }

    return {
      totalSchedules: schedules.length,
      totalEntries,
      scheduledEntries,
      completedEntries,
      missedEntries,
      averageMakespanMs: schedules.length > 0 ? makespanSum / schedules.length : 0,
      averageSlackMs: totalEntries > 0 ? slackSum / totalEntries : 0,
      averageUtilization: schedules.length > 0 ? utilizationSum / schedules.length : 0,
      totalConflictsDetected: this.conflictDetector.detectionCount(),
      totalReschedules: this.rescheduleCount,
      totalOptimizations: this.optimizer.optimizationCount(),
      lastComputedAt: this.metrics.lastComputedAt,
    }
  }

  /* --------------------------------------------------------------------- *
   * Introspection
   * --------------------------------------------------------------------- */

  describe(): string {
    return [
      'PlannerScheduler',
      `schedules=${this.schedulesById.size}`,
      `snapshots=${this.snapshotManager.size()}`,
      `defaultMaxConcurrency=${this.defaultMaxConcurrency}`,
    ].join(', ')
  }

  inspect(): Dictionary {
    return {
      schedules: this.schedulesById.size,
      defaultMaxConcurrency: this.defaultMaxConcurrency,
      analyzer: this.analyzer.inspect(),
      allocator: this.allocator.inspect(),
      propagationEngine: this.propagationEngine.inspect(),
      conflictDetector: this.conflictDetector.inspect(),
      validator: this.validator.inspect(),
      optimizer: this.optimizer.inspect(),
      snapshots: this.snapshotManager.inspect(),
      diagnostics: this.diagnostics.inspect(),
      statistics: this.getStatistics() as unknown as Dictionary,
    }
  }
}
