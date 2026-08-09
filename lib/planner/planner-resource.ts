/**
 * =============================================================================
 * Hexical AI
 * planner-resource.ts
 * =============================================================================
 *
 * Resource Management Layer
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * planner.ts defines `ResourceId`, `ResourceState`, and `ResourceRequirement`
 * as part of a Task's shape, but PlannerManager never tracks *actual* resource
 * capacity, availability, or reservations — it only records what a task
 * declares it needs. This module fills that gap: a standalone resource
 * subsystem that tracks concrete `Resource`s and `ResourcePool`s, reserves and
 * allocates capacity against them, detects over-allocation and state
 * conflicts, and reports utilization — all independent of any single Plan.
 *
 * `PlannerConstraintEngine.isSatisfied` (planner.ts) currently treats
 * `ConstraintType.Resource` structurally, by inspecting a task's declared
 * `ResourceRequirement[]`. A future `planner-constraint.ts` revision can
 * instead query a `ResourceManager` from this module for the *actual* live
 * state of a resource, without this module needing to know anything about
 * constraints, tasks, or goals.
 *
 * STRICT BOUNDARIES
 * -----------------------------------------------------------------------------
 * This module NEVER:
 *   - plans, decomposes goals, or builds task graphs (see planner.ts /
 *     planner-htn.ts)
 *   - schedules or optimizes tasks (see planner.ts's PlannerScheduler /
 *     PlannerOptimizer, and the future planner-scheduler.ts)
 *   - evaluates task/goal constraints (see planner.ts's
 *     PlannerConstraintEngine, and the future planner-constraint.ts)
 *   - executes anything or has side effects outside its own in-memory state
 *
 * It ONLY manages resources: registration, pooling, capacity, availability,
 * utilization, reservations, allocations, and conflict detection. Diagnostics
 * in this module observe consistency only — they never repair or mutate
 * indexed state, matching planner.ts's and planner-index.ts's "diagnostics
 * observe only" rule. No `eval`, no `Function` construction, no dynamic code
 * evaluation anywhere in this module.
 * =============================================================================
 */

/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    ResourceId,
    ResourceState,
    ResourceRequirement,
    TaskId,
    RiskLevel,
    generateId
} from "./planner";

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
} from "../memory";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const RESOURCE_FORMAT_VERSION = 1;
export const INITIAL_RESOURCE_VERSION = 1;

export const MIN_RESOURCE_AMOUNT = 0;
export const MIN_RESOURCE_CAPACITY = 0;

export const DEFAULT_RESERVATION_SNAPSHOT_CAPACITY = 100;

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type ResourcePoolId = string;
export type ResourceReservationId = string;
export type ResourceAllocationId = string;
export type ResourceConflictId = string;
export type ResourceManagerSnapshotId = string;

/**
 * Clamps a number into [min, max]. NaN and other non-finite values collapse
 * to `min` rather than propagating, mirroring planner.ts's own `clamp`
 * helper (duplicated locally rather than imported, since planner.ts does not
 * export it and this module must not depend on planner.ts internals beyond
 * its public surface).
 */
function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
}

/* =============================================================================
 * Resource Category
 * =============================================================================
 */

export enum ResourceCategory {
    Compute = "compute",
    Memory = "memory",
    Storage = "storage",
    Network = "network",
    Human = "human",
    Financial = "financial",
    Custom = "custom"
}

/* =============================================================================
 * Resource Scope
 * =============================================================================
 *
 * Reserved for future distributed / multi-agent resource management: a
 * resource may be private to a single agent, shared across a set of
 * cooperating agents, or distributed across a cluster. This module does not
 * yet implement cross-agent coordination; the scope is tracked so a future
 * distributed resource broker can be layered on without a breaking change to
 * the `Resource` shape.
 */

export enum ResourceScope {
    Local = "local",
    Shared = "shared",
    Distributed = "distributed"
}

/* =============================================================================
 * Resource Reservation Status
 * =============================================================================
 */

export enum ResourceReservationStatus {
    Pending = "pending",
    Active = "active",
    Converted = "converted",
    Released = "released",
    Expired = "expired",
    Cancelled = "cancelled"
}

/* =============================================================================
 * Resource Conflict Type
 * =============================================================================
 */

export enum ResourceConflictType {
    OverAllocation = "over-allocation",
    StateMismatch = "state-mismatch",
    DanglingReference = "dangling-reference",
    NegativeCapacity = "negative-capacity"
}

/* =============================================================================
 * Resource
 * =============================================================================
 */

export interface Resource {
    id: ResourceId;
    name: string;
    description: string;
    category: ResourceCategory;
    scope: ResourceScope;
    state: ResourceState;
    capacity: number;
    allocated: number;
    reserved: number;
    unit?: string;
    ownerAgentId?: string;
    tags: string[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Resource Pool
 * =============================================================================
 */

export interface ResourcePool {
    id: ResourcePoolId;
    name: string;
    description: string;
    scope: ResourceScope;
    resourceIds: ResourceId[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
    metadata?: Dictionary;
}

/* =============================================================================
 * Resource Reservation / Allocation
 * =============================================================================
 */

export interface ResourceReservation {
    id: ResourceReservationId;
    resourceId: ResourceId;
    taskId?: TaskId;
    amount: number;
    status: ResourceReservationStatus;
    requestedAt: Timestamp;
    expiresAt?: Timestamp;
    releasedAt?: Timestamp;
}

export interface ResourceAllocation {
    id: ResourceAllocationId;
    resourceId: ResourceId;
    taskId?: TaskId;
    reservationId?: ResourceReservationId;
    amount: number;
    allocatedAt: Timestamp;
    releasedAt?: Timestamp;
}

/* =============================================================================
 * Resource Conflict
 * =============================================================================
 */

export interface ResourceConflict {
    id: ResourceConflictId;
    type: ResourceConflictType;
    resourceId: ResourceId;
    poolId?: ResourcePoolId;
    description: string;
    severity: RiskLevel;
    detectedAt: Timestamp;
}

/* =============================================================================
 * Resource Manager Statistics
 * =============================================================================
 */

export interface ResourceManagerStatistics {
    totalResources: number;
    availableResources: number;
    reservedResources: number;
    allocatedResources: number;
    exhaustedResources: number;
    unavailableResources: number;
    totalPools: number;
    totalReservations: number;
    activeReservations: number;
    totalAllocations: number;
    activeAllocations: number;
    totalCapacity: number;
    totalAllocatedAmount: number;
    totalReservedAmount: number;
    averageUtilization: number;
}

/* =============================================================================
 * Resource Manager Snapshot
 * =============================================================================
 */

export interface ResourceManagerSnapshot {
    id: ResourceManagerSnapshotId;
    timestamp: Timestamp;
    version: VersionNumber;
    resources: Resource[];
    pools: ResourcePool[];
    reservations: ResourceReservation[];
    allocations: ResourceAllocation[];
}

/* =============================================================================
 * Planner Resource
 * =============================================================================
 *
 * A single mutable, encapsulated resource. Wraps a `Resource` value object
 * with private state, defensive cloning on every read/write, and explicit
 * invariant checks before mutation — mirroring the `PlannerTask` /
 * `MemoryNode` pattern used elsewhere in Hexical.
 *
 * `PlannerResource` owns its own capacity bookkeeping (`allocated`,
 * `reserved`) but never decides *whether* to reserve or allocate — that
 * decision belongs to `ResourceReservationLedger`, which calls
 * `reserveAmount` / `allocateAmount` only after confirming availability.
 */

export class PlannerResource
    implements
        Serializable<Resource>,
        Cloneable<PlannerResource>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: ResourceId;

    private name: string;
    private description: string;
    private category: ResourceCategory;
    private scope: ResourceScope;
    private state: ResourceState;
    private capacity: number;
    private allocated: number;
    private reserved: number;
    private unit?: string;
    private ownerAgentId?: string;
    private tags: string[];
    private metadata: Dictionary;

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_RESOURCE_VERSION;

    private frozen = false;

    constructor(resource: Resource) {
        this.id = resource.id;
        this.name = resource.name;
        this.description = resource.description;
        this.category = resource.category;
        this.scope = resource.scope;
        this.state = resource.state;
        this.capacity = resource.capacity;
        this.allocated = resource.allocated;
        this.reserved = resource.reserved;
        this.unit = resource.unit;
        this.ownerAgentId = resource.ownerAgentId;
        this.tags = [...resource.tags];
        this.metadata = structuredClone(resource.metadata ?? {});
        this.created = resource.createdAt;
        this.updated = resource.updatedAt;
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

    getName(): string {
        return this.name;
    }

    getDescription(): string {
        return this.description;
    }

    getCategory(): ResourceCategory {
        return this.category;
    }

    getScope(): ResourceScope {
        return this.scope;
    }

    getState(): ResourceState {
        return this.state;
    }

    getCapacity(): number {
        return this.capacity;
    }

    getAllocated(): number {
        return this.allocated;
    }

    getReserved(): number {
        return this.reserved;
    }

    getUnit(): Optional<string> {
        return this.unit;
    }

    getOwnerAgentId(): Optional<string> {
        return this.ownerAgentId;
    }

    getTags(): readonly string[] {
        return [...this.tags];
    }

    hasTag(tag: string): boolean {
        return this.tags.includes(tag);
    }

    /** Capacity not currently allocated or reserved. Never negative. */
    getAvailable(): number {
        return Math.max(0, this.capacity - this.allocated - this.reserved);
    }

    /** Fraction of capacity currently allocated or reserved, in [0, 1]. */
    getUtilization(): number {
        if (this.capacity <= 0) {
            return this.allocated > 0 || this.reserved > 0 ? 1 : 0;
        }
        return clamp((this.allocated + this.reserved) / this.capacity, 0, 1);
    }

    hasCapacityFor(amount: number): boolean {
        return amount > MIN_RESOURCE_AMOUNT && this.getAvailable() >= amount;
    }

    isOverCommitted(): boolean {
        return this.allocated + this.reserved > this.capacity;
    }

    isExhausted(): boolean {
        return this.state === ResourceState.Exhausted || this.getAvailable() <= 0;
    }

    isAvailable(): boolean {
        return this.state === ResourceState.Available && this.getAvailable() > 0;
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    private assertMutable(): void {
        if (this.frozen) {
            throw new Error(`PlannerResource '${this.id}' is frozen and cannot be modified.`);
        }
        if (this.state === ResourceState.Unavailable) {
            throw new Error(`PlannerResource '${this.id}' is unavailable and cannot be modified.`);
        }
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    setState(state: ResourceState): this {
        if (this.frozen) {
            throw new Error(`PlannerResource '${this.id}' is frozen and cannot be modified.`);
        }
        if (this.state === state) {
            return this;
        }
        this.state = state;
        this.touch();
        return this;
    }

    setCapacity(capacity: number): this {
        this.assertMutable();
        if (capacity < MIN_RESOURCE_CAPACITY) {
            throw new RangeError("Resource capacity cannot be negative.");
        }
        this.capacity = capacity;
        this.touch();
        return this;
    }

    setDescription(description: string): this {
        this.assertMutable();
        this.description = description;
        this.touch();
        return this;
    }

    setOwnerAgentId(ownerAgentId: string): this {
        this.assertMutable();
        this.ownerAgentId = ownerAgentId;
        this.touch();
        return this;
    }

    addTag(tag: string): this {
        this.assertMutable();
        if (!this.tags.includes(tag)) {
            this.tags.push(tag);
            this.touch();
        }
        return this;
    }

    removeTag(tag: string): this {
        this.assertMutable();
        const before = this.tags.length;
        this.tags = this.tags.filter(existing => existing !== tag);
        if (this.tags.length !== before) {
            this.touch();
        }
        return this;
    }

    /**
     * Reserves `amount` of this resource's capacity. Callers (normally only
     * `ResourceReservationLedger`) are expected to have already confirmed
     * `hasCapacityFor(amount)`; this method re-checks defensively and throws
     * rather than silently over-committing.
     */
    reserveAmount(amount: number): this {
        this.assertMutable();
        if (amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Reservation amount must be greater than zero.");
        }
        if (!this.hasCapacityFor(amount)) {
            throw new Error(
                `Resource '${this.id}' cannot reserve ${amount}: only ${this.getAvailable()} available.`
            );
        }
        this.reserved += amount;
        this.touch();
        return this;
    }

    /** Releases a previously reserved amount without ever going negative. */
    releaseReservation(amount: number): this {
        this.assertMutable();
        if (amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Released reservation amount must be greater than zero.");
        }
        this.reserved = Math.max(0, this.reserved - amount);
        this.touch();
        return this;
    }

    /**
     * Allocates `amount` of this resource's capacity directly. As with
     * `reserveAmount`, callers are expected to have already confirmed
     * capacity; this re-checks defensively.
     */
    allocateAmount(amount: number): this {
        this.assertMutable();
        if (amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Allocation amount must be greater than zero.");
        }
        if (!this.hasCapacityFor(amount)) {
            throw new Error(
                `Resource '${this.id}' cannot allocate ${amount}: only ${this.getAvailable()} available.`
            );
        }
        this.allocated += amount;
        this.touch();
        return this;
    }

    /**
     * Converts a reserved amount directly into an allocated amount without
     * ever passing through "available" — the reservation already accounted
     * for this capacity, so no additional availability check is performed.
     */
    commitReservedAmount(amount: number): this {
        this.assertMutable();
        if (amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Committed amount must be greater than zero.");
        }
        if (amount > this.reserved) {
            throw new Error(
                `Resource '${this.id}' cannot commit ${amount}: only ${this.reserved} currently reserved.`
            );
        }
        this.reserved -= amount;
        this.allocated += amount;
        this.touch();
        return this;
    }

    /** Releases a previously allocated amount without ever going negative. */
    releaseAllocation(amount: number): this {
        this.assertMutable();
        if (amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Released allocation amount must be greater than zero.");
        }
        this.allocated = Math.max(0, this.allocated - amount);
        this.touch();
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
        if (this.id.length === 0 || this.name.length === 0) {
            return false;
        }
        if (this.capacity < MIN_RESOURCE_CAPACITY) {
            return false;
        }
        if (this.allocated < 0 || this.reserved < 0) {
            return false;
        }
        return true;
    }

    serialize(): Resource {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            category: this.category,
            scope: this.scope,
            state: this.state,
            capacity: this.capacity,
            allocated: this.allocated,
            reserved: this.reserved,
            unit: this.unit,
            ownerAgentId: this.ownerAgentId,
            tags: [...this.tags],
            createdAt: this.created,
            updatedAt: this.updated,
            metadata: structuredClone(this.metadata)
        };
    }

    clone(): PlannerResource {
        return new PlannerResource(this.serialize());
    }

    describe(): string {
        return [
            `PlannerResource(${this.id})`,
            `name=${this.name}`,
            `category=${this.category}`,
            `state=${this.state}`,
            `capacity=${this.capacity}`,
            `allocated=${this.allocated}`,
            `reserved=${this.reserved}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            name: this.name,
            category: this.category,
            scope: this.scope,
            state: this.state,
            capacity: this.capacity,
            allocated: this.allocated,
            reserved: this.reserved,
            available: this.getAvailable(),
            utilization: this.getUtilization(),
            overCommitted: this.isOverCommitted(),
            frozen: this.frozen
        };
    }
}

/* =============================================================================
 * Planner Resource Pool
 * =============================================================================
 *
 * A named grouping of resource ids. A pool never owns capacity itself — it
 * only tracks membership, so total pool capacity/availability must be
 * derived by a caller (typically `ResourceManager`) by looking each member
 * resource up individually.
 */

export class PlannerResourcePool
    implements
        Serializable<ResourcePool>,
        Cloneable<PlannerResourcePool>,
        Validatable,
        Versioned,
        Identifiable,
        Timestamped {

    public readonly id: ResourcePoolId;

    private name: string;
    private description: string;
    private scope: ResourceScope;
    private resourceIds: ResourceId[];
    private metadata: Dictionary;

    private created: Timestamp;
    private updated: Timestamp;
    private revision: VersionNumber = INITIAL_RESOURCE_VERSION;

    constructor(pool: ResourcePool) {
        this.id = pool.id;
        this.name = pool.name;
        this.description = pool.description;
        this.scope = pool.scope;
        this.resourceIds = [...pool.resourceIds];
        this.metadata = structuredClone(pool.metadata ?? {});
        this.created = pool.createdAt;
        this.updated = pool.updatedAt;
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

    getName(): string {
        return this.name;
    }

    getDescription(): string {
        return this.description;
    }

    getScope(): ResourceScope {
        return this.scope;
    }

    getResourceIds(): readonly ResourceId[] {
        return [...this.resourceIds];
    }

    hasResource(id: ResourceId): boolean {
        return this.resourceIds.includes(id);
    }

    isEmpty(): boolean {
        return this.resourceIds.length === 0;
    }

    size(): number {
        return this.resourceIds.length;
    }

    private touch(): void {
        this.updated = Date.now();
        this.revision++;
    }

    setDescription(description: string): this {
        this.description = description;
        this.touch();
        return this;
    }

    addResource(id: ResourceId): this {
        if (!this.resourceIds.includes(id)) {
            this.resourceIds.push(id);
            this.touch();
        }
        return this;
    }

    removeResource(id: ResourceId): this {
        const before = this.resourceIds.length;
        this.resourceIds = this.resourceIds.filter(resourceId => resourceId !== id);
        if (this.resourceIds.length !== before) {
            this.touch();
        }
        return this;
    }

    validate(): boolean {
        if (this.id.length === 0 || this.name.length === 0) {
            return false;
        }
        return new Set(this.resourceIds).size === this.resourceIds.length;
    }

    serialize(): ResourcePool {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            scope: this.scope,
            resourceIds: [...this.resourceIds],
            createdAt: this.created,
            updatedAt: this.updated,
            metadata: structuredClone(this.metadata)
        };
    }

    clone(): PlannerResourcePool {
        return new PlannerResourcePool(this.serialize());
    }

    describe(): string {
        return [
            `PlannerResourcePool(${this.id})`,
            `name=${this.name}`,
            `resources=${this.resourceIds.length}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            name: this.name,
            scope: this.scope,
            resourceCount: this.resourceIds.length
        };
    }
}

/* =============================================================================
 * Resource Conflict Detector
 * =============================================================================
 *
 * Structural, side-effect-free conflict detection. Every check only reads
 * resource/pool state and produces `ResourceConflict` records — it never
 * mutates a `PlannerResource` or `PlannerResourcePool`, and never performs
 * dynamic code evaluation of any kind.
 */

export class ResourceConflictDetector {

    private detections = 0;

    constructor() {}

    private severityForOverAllocation(resource: PlannerResource): RiskLevel {
        const excess = resource.getAllocated() + resource.getReserved() - resource.getCapacity();
        if (resource.getCapacity() <= 0) {
            return RiskLevel.Severe;
        }
        const ratio = excess / resource.getCapacity();
        if (ratio >= 0.5) {
            return RiskLevel.Severe;
        }
        if (ratio >= 0.2) {
            return RiskLevel.High;
        }
        return RiskLevel.Moderate;
    }

    detectResourceConflicts(resource: PlannerResource): ResourceConflict[] {
        const conflicts: ResourceConflict[] = [];

        if (resource.isOverCommitted()) {
            this.detections++;
            conflicts.push({
                id: generateId("rconflict"),
                type: ResourceConflictType.OverAllocation,
                resourceId: resource.id,
                description:
                    `Resource '${resource.id}' has allocated (${resource.getAllocated()}) plus reserved ` +
                    `(${resource.getReserved()}) exceeding capacity (${resource.getCapacity()}).`,
                severity: this.severityForOverAllocation(resource),
                detectedAt: Date.now()
            });
        }

        if (resource.getCapacity() < MIN_RESOURCE_CAPACITY) {
            this.detections++;
            conflicts.push({
                id: generateId("rconflict"),
                type: ResourceConflictType.NegativeCapacity,
                resourceId: resource.id,
                description: `Resource '${resource.id}' has a negative capacity.`,
                severity: RiskLevel.Severe,
                detectedAt: Date.now()
            });
        }

        if (resource.getState() === ResourceState.Available && resource.getAvailable() <= 0) {
            this.detections++;
            conflicts.push({
                id: generateId("rconflict"),
                type: ResourceConflictType.StateMismatch,
                resourceId: resource.id,
                description:
                    `Resource '${resource.id}' is marked '${ResourceState.Available}' but has no available capacity.`,
                severity: RiskLevel.Moderate,
                detectedAt: Date.now()
            });
        }

        if (resource.getState() === ResourceState.Unavailable && resource.getAllocated() > 0) {
            this.detections++;
            conflicts.push({
                id: generateId("rconflict"),
                type: ResourceConflictType.StateMismatch,
                resourceId: resource.id,
                description:
                    `Resource '${resource.id}' is marked '${ResourceState.Unavailable}' but still has active allocations.`,
                severity: RiskLevel.High,
                detectedAt: Date.now()
            });
        }

        return conflicts;
    }

    detectPoolConflicts(
        pool: PlannerResourcePool,
        knownResourceIds: ReadonlySet<ResourceId>
    ): ResourceConflict[] {
        const conflicts: ResourceConflict[] = [];

        for (const resourceId of pool.getResourceIds()) {
            if (!knownResourceIds.has(resourceId)) {
                this.detections++;
                conflicts.push({
                    id: generateId("rconflict"),
                    type: ResourceConflictType.DanglingReference,
                    resourceId,
                    poolId: pool.id,
                    description: `Pool '${pool.id}' references unknown resource '${resourceId}'.`,
                    severity: RiskLevel.High,
                    detectedAt: Date.now()
                });
            }
        }

        return conflicts;
    }

    detectAll(
        resources: Iterable<PlannerResource>,
        pools: Iterable<PlannerResourcePool>
    ): ResourceConflict[] {
        const conflicts: ResourceConflict[] = [];
        const knownResourceIds = new Set<ResourceId>();

        for (const resource of resources) {
            knownResourceIds.add(resource.id);
            conflicts.push(...this.detectResourceConflicts(resource));
        }

        for (const pool of pools) {
            conflicts.push(...this.detectPoolConflicts(pool, knownResourceIds));
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
        return ["ResourceConflictDetector", `detections=${this.detections}`].join(", ");
    }

    inspect(): Dictionary {
        return { detections: this.detections };
    }
}

/* =============================================================================
 * Resource Reservation Ledger
 * =============================================================================
 *
 * Tracks reservation and allocation records and their derived indexes
 * (`ResourceId -> record ids`, `TaskId -> record ids`), mirroring the bucket
 * pattern used by `PlannerIndexManager` in planner-index.ts. The ledger never
 * holds `PlannerResource` instances itself — every method that needs to
 * change a resource's live capacity is handed the relevant `PlannerResource`
 * explicitly by the caller (normally `ResourceManager`), the same way
 * `PlannerConstraintEngine.propagate` is handed a task map rather than
 * owning one.
 */

export class ResourceReservationLedger {

    private readonly reservationsById = new Map<ResourceReservationId, ResourceReservation>();
    private readonly allocationsById = new Map<ResourceAllocationId, ResourceAllocation>();

    private readonly reservationIdsByResource = new Map<ResourceId, Set<ResourceReservationId>>();
    private readonly reservationIdsByTask = new Map<TaskId, Set<ResourceReservationId>>();

    private readonly allocationIdsByResource = new Map<ResourceId, Set<ResourceAllocationId>>();
    private readonly allocationIdsByTask = new Map<TaskId, Set<ResourceAllocationId>>();

    constructor() {}

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
     * Reservations
     * --------------------------------------------------------------------- */

    reserve(
        resource: PlannerResource,
        request: { amount: number; taskId?: TaskId; expiresAt?: Timestamp }
    ): ResourceReservation {
        if (request.amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Reservation amount must be greater than zero.");
        }
        if (!resource.hasCapacityFor(request.amount)) {
            throw new Error(
                `Cannot reserve ${request.amount} of resource '${resource.id}': ` +
                `only ${resource.getAvailable()} available.`
            );
        }

        resource.reserveAmount(request.amount);

        const reservation: ResourceReservation = {
            id: generateId("reservation"),
            resourceId: resource.id,
            taskId: request.taskId,
            amount: request.amount,
            status: ResourceReservationStatus.Active,
            requestedAt: Date.now(),
            expiresAt: request.expiresAt
        };

        this.reservationsById.set(reservation.id, reservation);
        this.addToBucket(this.reservationIdsByResource, resource.id, reservation.id);
        if (request.taskId !== undefined) {
            this.addToBucket(this.reservationIdsByTask, request.taskId, reservation.id);
        }

        return { ...reservation };
    }

    /**
     * Releases an active reservation, returning its reserved capacity back
     * to the resource without ever converting it into an allocation.
     */
    release(reservationId: ResourceReservationId, resource: PlannerResource): ResourceReservation {
        const reservation = this.requireReservation(reservationId);

        if (reservation.resourceId !== resource.id) {
            throw new Error(
                `Reservation '${reservationId}' belongs to resource '${reservation.resourceId}', not '${resource.id}'.`
            );
        }
        if (
            reservation.status !== ResourceReservationStatus.Active &&
            reservation.status !== ResourceReservationStatus.Pending
        ) {
            throw new Error(`Reservation '${reservationId}' is not active and cannot be released.`);
        }

        resource.releaseReservation(reservation.amount);

        const updated: ResourceReservation = {
            ...reservation,
            status: ResourceReservationStatus.Released,
            releasedAt: Date.now()
        };
        this.reservationsById.set(reservationId, updated);

        return { ...updated };
    }

    /**
     * Marks every active/pending reservation past its `expiresAt` as
     * expired, releasing its reserved capacity. `resourcesById` must contain
     * every resource referenced by a candidate reservation; a reservation
     * whose resource cannot be found is skipped rather than throwing, since
     * expiry sweeps are expected to run unattended.
     */
    expireDue(resourcesById: ReadonlyMap<ResourceId, PlannerResource>, now: Timestamp = Date.now()): ResourceReservation[] {
        const expired: ResourceReservation[] = [];

        for (const reservation of this.reservationsById.values()) {
            const isActive =
                reservation.status === ResourceReservationStatus.Active ||
                reservation.status === ResourceReservationStatus.Pending;

            if (!isActive || reservation.expiresAt === undefined || reservation.expiresAt > now) {
                continue;
            }

            const resource = resourcesById.get(reservation.resourceId);
            if (!resource) {
                continue;
            }

            resource.releaseReservation(reservation.amount);

            const updated: ResourceReservation = {
                ...reservation,
                status: ResourceReservationStatus.Expired,
                releasedAt: now
            };
            this.reservationsById.set(reservation.id, updated);
            expired.push({ ...updated });
        }

        return expired;
    }

    getReservation(id: ResourceReservationId): Optional<ResourceReservation> {
        const reservation = this.reservationsById.get(id);
        return reservation ? { ...reservation } : undefined;
    }

    requireReservation(id: ResourceReservationId): ResourceReservation {
        const reservation = this.reservationsById.get(id);
        if (!reservation) {
            throw new Error(`Reservation '${id}' does not exist.`);
        }
        return reservation;
    }

    reservationsForResource(resourceId: ResourceId): ResourceReservation[] {
        const ids = this.reservationIdsByResource.get(resourceId) ?? new Set();
        return [...ids].map(id => ({ ...this.reservationsById.get(id)! }));
    }

    reservationsForTask(taskId: TaskId): ResourceReservation[] {
        const ids = this.reservationIdsByTask.get(taskId) ?? new Set();
        return [...ids].map(id => ({ ...this.reservationsById.get(id)! }));
    }

    activeReservations(): ResourceReservation[] {
        return [...this.reservationsById.values()]
            .filter(reservation => reservation.status === ResourceReservationStatus.Active)
            .map(reservation => ({ ...reservation }));
    }

    allReservations(): ResourceReservation[] {
        return [...this.reservationsById.values()].map(reservation => ({ ...reservation }));
    }

    /* --------------------------------------------------------------------- *
     * Allocations
     * --------------------------------------------------------------------- */

    /** Allocates capacity directly, with no pre-existing reservation. */
    allocateDirect(
        resource: PlannerResource,
        request: { amount: number; taskId?: TaskId }
    ): ResourceAllocation {
        if (request.amount <= MIN_RESOURCE_AMOUNT) {
            throw new RangeError("Allocation amount must be greater than zero.");
        }
        if (!resource.hasCapacityFor(request.amount)) {
            throw new Error(
                `Cannot allocate ${request.amount} of resource '${resource.id}': ` +
                `only ${resource.getAvailable()} available.`
            );
        }

        resource.allocateAmount(request.amount);

        return this.recordAllocation(resource.id, request.amount, request.taskId);
    }

    /**
     * Converts an active reservation into an allocation. The reservation's
     * capacity was already carved out of the resource's availability, so no
     * additional availability check is performed — only that the
     * reservation is still active.
     */
    convert(reservationId: ResourceReservationId, resource: PlannerResource): ResourceAllocation {
        const reservation = this.requireReservation(reservationId);

        if (reservation.resourceId !== resource.id) {
            throw new Error(
                `Reservation '${reservationId}' belongs to resource '${reservation.resourceId}', not '${resource.id}'.`
            );
        }
        if (reservation.status !== ResourceReservationStatus.Active) {
            throw new Error(`Reservation '${reservationId}' is not active and cannot be converted.`);
        }

        resource.commitReservedAmount(reservation.amount);

        const updatedReservation: ResourceReservation = {
            ...reservation,
            status: ResourceReservationStatus.Converted,
            releasedAt: Date.now()
        };
        this.reservationsById.set(reservationId, updatedReservation);

        return this.recordAllocation(resource.id, reservation.amount, reservation.taskId, reservationId);
    }

    private recordAllocation(
        resourceId: ResourceId,
        amount: number,
        taskId?: TaskId,
        reservationId?: ResourceReservationId
    ): ResourceAllocation {
        const allocation: ResourceAllocation = {
            id: generateId("allocation"),
            resourceId,
            taskId,
            reservationId,
            amount,
            allocatedAt: Date.now()
        };

        this.allocationsById.set(allocation.id, allocation);
        this.addToBucket(this.allocationIdsByResource, resourceId, allocation.id);
        if (taskId !== undefined) {
            this.addToBucket(this.allocationIdsByTask, taskId, allocation.id);
        }

        return { ...allocation };
    }

    releaseAllocation(allocationId: ResourceAllocationId, resource: PlannerResource): ResourceAllocation {
        const allocation = this.requireAllocation(allocationId);

        if (allocation.resourceId !== resource.id) {
            throw new Error(
                `Allocation '${allocationId}' belongs to resource '${allocation.resourceId}', not '${resource.id}'.`
            );
        }
        if (allocation.releasedAt !== undefined) {
            throw new Error(`Allocation '${allocationId}' has already been released.`);
        }

        resource.releaseAllocation(allocation.amount);

        const updated: ResourceAllocation = { ...allocation, releasedAt: Date.now() };
        this.allocationsById.set(allocationId, updated);

        return { ...updated };
    }

    getAllocation(id: ResourceAllocationId): Optional<ResourceAllocation> {
        const allocation = this.allocationsById.get(id);
        return allocation ? { ...allocation } : undefined;
    }

    requireAllocation(id: ResourceAllocationId): ResourceAllocation {
        const allocation = this.allocationsById.get(id);
        if (!allocation) {
            throw new Error(`Allocation '${id}' does not exist.`);
        }
        return allocation;
    }

    allocationsForResource(resourceId: ResourceId): ResourceAllocation[] {
        const ids = this.allocationIdsByResource.get(resourceId) ?? new Set();
        return [...ids].map(id => ({ ...this.allocationsById.get(id)! }));
    }

    allocationsForTask(taskId: TaskId): ResourceAllocation[] {
        const ids = this.allocationIdsByTask.get(taskId) ?? new Set();
        return [...ids].map(id => ({ ...this.allocationsById.get(id)! }));
    }

    activeAllocations(): ResourceAllocation[] {
        return [...this.allocationsById.values()]
            .filter(allocation => allocation.releasedAt === undefined)
            .map(allocation => ({ ...allocation }));
    }

    allAllocations(): ResourceAllocation[] {
        return [...this.allocationsById.values()].map(allocation => ({ ...allocation }));
    }

    /* --------------------------------------------------------------------- *
     * Debug accessors
     * --------------------------------------------------------------------- *
     * Read-only escape hatches used exclusively by ResourceDiagnostics.
     * Prefixed `debug*` so application code is not tempted to depend on the
     * ledger's internal bucket shape.
     */

    debugReservationIdsByResource(): ReadonlyMap<ResourceId, ReadonlySet<ResourceReservationId>> {
        return this.reservationIdsByResource;
    }

    debugAllocationIdsByResource(): ReadonlyMap<ResourceId, ReadonlySet<ResourceAllocationId>> {
        return this.allocationIdsByResource;
    }

    /* --------------------------------------------------------------------- *
     * Bulk operations / introspection
     * --------------------------------------------------------------------- */

    clear(): void {
        this.reservationsById.clear();
        this.allocationsById.clear();
        this.reservationIdsByResource.clear();
        this.reservationIdsByTask.clear();
        this.allocationIdsByResource.clear();
        this.allocationIdsByTask.clear();
    }

    reservationCount(): number {
        return this.reservationsById.size;
    }

    allocationCount(): number {
        return this.allocationsById.size;
    }

    describe(): string {
        return [
            "ResourceReservationLedger",
            `reservations=${this.reservationsById.size}`,
            `allocations=${this.allocationsById.size}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            reservations: this.reservationsById.size,
            activeReservations: this.activeReservations().length,
            allocations: this.allocationsById.size,
            activeAllocations: this.activeAllocations().length
        };
    }
}

/* =============================================================================
 * Resource Diagnostics
 * =============================================================================
 *
 * Read-only structural consistency checks over a ResourceManager's internal
 * state. Every `validate*` method only inspects state; none of them mutate
 * the manager or repair inconsistencies — an inconsistent resource ledger is
 * surfaced, never silently patched, mirroring
 * `PlannerIndexDiagnostics` / `PlannerDiagnostics`.
 */

export class ResourceDiagnostics {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validateResourceInvariants(manager: ResourceManager): boolean {
        this.checks++;
        let valid = true;

        for (const resource of manager.allResources()) {
            if (!resource.validate() || resource.isOverCommitted()) {
                valid = false;
            }
        }

        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validatePoolReferences(manager: ResourceManager): boolean {
        this.checks++;
        let valid = true;

        for (const pool of manager.allPools()) {
            for (const resourceId of pool.getResourceIds()) {
                if (!manager.hasResource(resourceId)) {
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
     * Referential-integrity check: a reservation or allocation may reference
     * a resource id that is no longer registered (e.g. a resource removed
     * without first releasing everything against it). This never repairs
     * the reference — it only reports it.
     */
    findOrphanedRecords(manager: ResourceManager): { reservationIds: ResourceReservationId[]; allocationIds: ResourceAllocationId[] } {
        this.checks++;

        const reservationIds: ResourceReservationId[] = [];
        const allocationIds: ResourceAllocationId[] = [];

        for (const [resourceId, ids] of manager.debugLedger().debugReservationIdsByResource()) {
            if (!manager.hasResource(resourceId)) {
                reservationIds.push(...ids);
            }
        }

        for (const [resourceId, ids] of manager.debugLedger().debugAllocationIdsByResource()) {
            if (!manager.hasResource(resourceId)) {
                allocationIds.push(...ids);
            }
        }

        if (reservationIds.length > 0 || allocationIds.length > 0) {
            this.failures++;
        }

        return { reservationIds, allocationIds };
    }

    runAll(manager: ResourceManager): boolean {
        const orphaned = this.findOrphanedRecords(manager);
        return (
            this.validateResourceInvariants(manager) &&
            this.validatePoolReferences(manager) &&
            orphaned.reservationIds.length === 0 &&
            orphaned.allocationIds.length === 0
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
            "ResourceDiagnostics",
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
 * Resource Manager
 * =============================================================================
 *
 * The single public façade over the resource subsystem. Owns the canonical
 * `ResourceId -> PlannerResource` and `ResourcePoolId -> PlannerResourcePool`
 * maps, a `ResourceReservationLedger`, a `ResourceConflictDetector`, and a
 * `ResourceDiagnostics` instance.
 *
 * ResourceManager never plans, schedules, or executes anything; it only
 * tracks the live state of resources for other subsystems (a future
 * planner-constraint.ts, planner-scheduler.ts, or executor.ts) to query.
 */

export class ResourceManager {

    private readonly resourcesById = new Map<ResourceId, PlannerResource>();
    private readonly poolsById = new Map<ResourcePoolId, PlannerResourcePool>();

    private readonly ledger = new ResourceReservationLedger();
    private readonly conflictDetector = new ResourceConflictDetector();
    private readonly diagnostics = new ResourceDiagnostics();

    constructor() {}

    /* --------------------------------------------------------------------- *
     * Resource registration
     * --------------------------------------------------------------------- */

    registerResource(resource: Resource): PlannerResource {
        if (this.resourcesById.has(resource.id)) {
            throw new Error(`Resource '${resource.id}' is already registered.`);
        }
        const wrapped = new PlannerResource(resource);
        this.resourcesById.set(resource.id, wrapped);
        return wrapped;
    }

    /**
     * Removes a resource. Refuses to remove one with any active reservation
     * or unreleased allocation unless `force` is set, since doing so would
     * silently orphan those records.
     */
    removeResource(id: ResourceId, force = false): boolean {
        if (!this.resourcesById.has(id)) {
            return false;
        }

        if (!force) {
            const hasActiveReservations = this.ledger.reservationsForResource(id)
                .some(reservation => reservation.status === ResourceReservationStatus.Active);
            const hasActiveAllocations = this.ledger.allocationsForResource(id)
                .some(allocation => allocation.releasedAt === undefined);

            if (hasActiveReservations || hasActiveAllocations) {
                throw new Error(
                    `Resource '${id}' has active reservations or allocations; pass force=true to remove anyway.`
                );
            }
        }

        for (const pool of this.poolsById.values()) {
            pool.removeResource(id);
        }

        return this.resourcesById.delete(id);
    }

    getResource(id: ResourceId): Optional<PlannerResource> {
        return this.resourcesById.get(id);
    }

    requireResource(id: ResourceId): PlannerResource {
        const resource = this.resourcesById.get(id);
        if (!resource) {
            throw new Error(`Resource '${id}' does not exist.`);
        }
        return resource;
    }

    hasResource(id: ResourceId): boolean {
        return this.resourcesById.has(id);
    }

    allResources(): PlannerResource[] {
        return [...this.resourcesById.values()];
    }

    resourceCount(): number {
        return this.resourcesById.size;
    }

    where(predicate: Predicate<PlannerResource>): PlannerResource[] {
        return this.allResources().filter(predicate);
    }

    /* --------------------------------------------------------------------- *
     * Pool registration
     * --------------------------------------------------------------------- */

    registerPool(pool: ResourcePool): PlannerResourcePool {
        if (this.poolsById.has(pool.id)) {
            throw new Error(`Resource pool '${pool.id}' is already registered.`);
        }
        const wrapped = new PlannerResourcePool(pool);
        this.poolsById.set(pool.id, wrapped);
        return wrapped;
    }

    removePool(id: ResourcePoolId): boolean {
        return this.poolsById.delete(id);
    }

    getPool(id: ResourcePoolId): Optional<PlannerResourcePool> {
        return this.poolsById.get(id);
    }

    requirePool(id: ResourcePoolId): PlannerResourcePool {
        const pool = this.poolsById.get(id);
        if (!pool) {
            throw new Error(`Resource pool '${id}' does not exist.`);
        }
        return pool;
    }

    hasPool(id: ResourcePoolId): boolean {
        return this.poolsById.has(id);
    }

    allPools(): PlannerResourcePool[] {
        return [...this.poolsById.values()];
    }

    poolCount(): number {
        return this.poolsById.size;
    }

    addResourceToPool(poolId: ResourcePoolId, resourceId: ResourceId): PlannerResourcePool {
        const pool = this.requirePool(poolId);
        if (!this.hasResource(resourceId)) {
            throw new Error(`Cannot add unknown resource '${resourceId}' to pool '${poolId}'.`);
        }
        pool.addResource(resourceId);
        return pool;
    }

    removeResourceFromPool(poolId: ResourcePoolId, resourceId: ResourceId): PlannerResourcePool {
        const pool = this.requirePool(poolId);
        pool.removeResource(resourceId);
        return pool;
    }

    /** Total available capacity across every resource currently in a pool. */
    poolAvailableCapacity(poolId: ResourcePoolId): number {
        const pool = this.requirePool(poolId);
        let total = 0;
        for (const resourceId of pool.getResourceIds()) {
            const resource = this.resourcesById.get(resourceId);
            if (resource) {
                total += resource.getAvailable();
            }
        }
        return total;
    }

    /* --------------------------------------------------------------------- *
     * Reservations / Allocations
     * --------------------------------------------------------------------- */

    reserve(
        resourceId: ResourceId,
        request: { amount: number; taskId?: TaskId; expiresAt?: Timestamp }
    ): ResourceReservation {
        const resource = this.requireResource(resourceId);
        return this.ledger.reserve(resource, request);
    }

    releaseReservation(reservationId: ResourceReservationId): ResourceReservation {
        const reservation = this.ledger.requireReservation(reservationId);
        const resource = this.requireResource(reservation.resourceId);
        return this.ledger.release(reservationId, resource);
    }

    /**
     * Allocates capacity for a resource, either by converting an existing
     * active reservation (`reservationId` supplied) or directly against
     * available capacity (no `reservationId`).
     */
    allocate(
        resourceId: ResourceId,
        request: { amount?: number; taskId?: TaskId; reservationId?: ResourceReservationId }
    ): ResourceAllocation {
        const resource = this.requireResource(resourceId);

        if (request.reservationId !== undefined) {
            return this.ledger.convert(request.reservationId, resource);
        }

        if (request.amount === undefined) {
            throw new TypeError("An amount is required when allocating without a reservationId.");
        }

        return this.ledger.allocateDirect(resource, { amount: request.amount, taskId: request.taskId });
    }

    releaseAllocation(allocationId: ResourceAllocationId): ResourceAllocation {
        const allocation = this.ledger.requireAllocation(allocationId);
        const resource = this.requireResource(allocation.resourceId);
        return this.ledger.releaseAllocation(allocationId, resource);
    }

    expireReservations(now: Timestamp = Date.now()): ResourceReservation[] {
        return this.ledger.expireDue(this.resourcesById, now);
    }

    reservationsForTask(taskId: TaskId): ResourceReservation[] {
        return this.ledger.reservationsForTask(taskId);
    }

    allocationsForTask(taskId: TaskId): ResourceAllocation[] {
        return this.ledger.allocationsForTask(taskId);
    }

    /**
     * Reserves capacity for every declared `ResourceRequirement` of a task
     * in one call, rolling back any already-made reservations if a later
     * requirement in the same batch cannot be satisfied — the batch is
     * all-or-nothing so a task never ends up with only partial resourcing.
     */
    reserveForRequirements(
        requirements: readonly ResourceRequirement[],
        taskId: TaskId,
        expiresAt?: Timestamp
    ): ResourceReservation[] {
        const made: ResourceReservation[] = [];

        try {
            for (const requirement of requirements) {
                const reservation = this.reserve(requirement.resourceId, {
                    amount: requirement.amount,
                    taskId,
                    expiresAt
                });
                made.push(reservation);
            }
        } catch (error) {
            for (const reservation of made) {
                const resource = this.getResource(reservation.resourceId);
                if (resource) {
                    this.ledger.release(reservation.id, resource);
                }
            }
            throw error;
        }

        return made;
    }

    /* --------------------------------------------------------------------- *
     * Conflict detection
     * --------------------------------------------------------------------- */

    detectConflicts(): ResourceConflict[] {
        return this.conflictDetector.detectAll(this.allResources(), this.allPools());
    }

    /* --------------------------------------------------------------------- *
     * Debug accessors
     * --------------------------------------------------------------------- */

    debugLedger(): ResourceReservationLedger {
        return this.ledger;
    }

    /* --------------------------------------------------------------------- *
     * Validation / Diagnostics / Statistics
     * --------------------------------------------------------------------- */

    validate(): boolean {
        return this.diagnostics.runAll(this);
    }

    runDiagnostics(): boolean {
        return this.validate();
    }

    getStatistics(): ResourceManagerStatistics {
        const resources = this.allResources();

        let totalCapacity = 0;
        let totalAllocatedAmount = 0;
        let totalReservedAmount = 0;
        let utilizationSum = 0;

        let availableResources = 0;
        let reservedResources = 0;
        let allocatedResources = 0;
        let exhaustedResources = 0;
        let unavailableResources = 0;

        for (const resource of resources) {
            totalCapacity += resource.getCapacity();
            totalAllocatedAmount += resource.getAllocated();
            totalReservedAmount += resource.getReserved();
            utilizationSum += resource.getUtilization();

            switch (resource.getState()) {
                case ResourceState.Available:
                    availableResources++;
                    break;
                case ResourceState.Reserved:
                    reservedResources++;
                    break;
                case ResourceState.Allocated:
                    allocatedResources++;
                    break;
                case ResourceState.Exhausted:
                    exhaustedResources++;
                    break;
                case ResourceState.Unavailable:
                    unavailableResources++;
                    break;
                default:
                    break;
            }
        }

        return {
            totalResources: resources.length,
            availableResources,
            reservedResources,
            allocatedResources,
            exhaustedResources,
            unavailableResources,
            totalPools: this.poolsById.size,
            totalReservations: this.ledger.reservationCount(),
            activeReservations: this.ledger.activeReservations().length,
            totalAllocations: this.ledger.allocationCount(),
            activeAllocations: this.ledger.activeAllocations().length,
            totalCapacity,
            totalAllocatedAmount,
            totalReservedAmount,
            averageUtilization: resources.length > 0 ? utilizationSum / resources.length : 0
        };
    }

    /* --------------------------------------------------------------------- *
     * Snapshot / Serialization
     * --------------------------------------------------------------------- */

    snapshot(): ResourceManagerSnapshot {
        return {
            id: generateId("rsnap"),
            timestamp: Date.now(),
            version: RESOURCE_FORMAT_VERSION,
            resources: this.allResources().map(resource => resource.serialize()),
            pools: this.allPools().map(pool => pool.serialize()),
            reservations: this.ledger.allReservations(),
            allocations: this.ledger.allAllocations()
        };
    }

    /**
     * Restores this manager's resource/pool state from a snapshot. This
     * only reconstructs resources and pools with their capacity/allocated/
     * reserved figures as recorded in the snapshot; the reservation/
     * allocation *ledger* entries in the snapshot are informational only —
     * restoring live ledger bucket state from a snapshot taken elsewhere
     * would risk indexing records against resources that no longer match,
     * so callers that need full ledger continuity should restore into a
     * fresh `ResourceManager` immediately after registering resources.
     */
    restoreSnapshot(snapshot: ResourceManagerSnapshot): void {
        this.resourcesById.clear();
        this.poolsById.clear();
        this.ledger.clear();

        for (const resource of snapshot.resources) {
            this.resourcesById.set(resource.id, new PlannerResource(resource));
        }

        for (const pool of snapshot.pools) {
            this.poolsById.set(pool.id, new PlannerResourcePool(pool));
        }
    }

    /**
     * Deep, fully independent copy: reconstructs every `PlannerResource` /
     * `PlannerResourcePool` from serialized data rather than sharing
     * references with the original manager. Ledger state (reservations and
     * allocations) is intentionally not carried over to the clone — a clone
     * represents a fresh manager seeded with the same resources and pools,
     * matching the "no shared mutable state" guarantee `PlannerIndexManager
     * .clone()` provides for planner indexes.
     */
    clone(): ResourceManager {
        const snapshot = this.snapshot();
        const clone = new ResourceManager();
        clone.restoreSnapshot(snapshot);
        return clone;
    }

    describe(): string {
        return [
            "ResourceManager",
            `resources=${this.resourcesById.size}`,
            `pools=${this.poolsById.size}`,
            `reservations=${this.ledger.reservationCount()}`,
            `allocations=${this.ledger.allocationCount()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            resources: this.resourcesById.size,
            pools: this.poolsById.size,
            ledger: this.ledger.inspect(),
            conflictDetector: this.conflictDetector.inspect(),
            diagnostics: this.diagnostics.inspect(),
            statistics: this.getStatistics() as unknown as Dictionary
        };
    }
}
