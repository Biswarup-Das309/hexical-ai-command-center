/**
 * =============================================================================
 * Hexical AI
 * memory.ts
 * =============================================================================
 *
 * Cognitive Memory Framework
 * =============================================================================
 */
/* =============================================================================
 * Imports
 * =============================================================================
 */

import {
    ReasoningSession,
    ReasoningReport
} from "./reasoner";

/* =============================================================================
 * Global Constants
 * =============================================================================
 */

export const DEFAULT_MEMORY_CONFIDENCE = 1.0;
export const DEFAULT_MEMORY_IMPORTANCE = 0.5;
export const INITIAL_MEMORY_VERSION = 1;
export const MAX_MEMORY_CONFIDENCE = 1;
export const MIN_MEMORY_CONFIDENCE = 0;
export const MAX_MEMORY_IMPORTANCE = 1;
export const MIN_MEMORY_IMPORTANCE = 0;
export const MEMORY_FORMAT_VERSION = 1;

/* =============================================================================
 * Utility Types
 * =============================================================================
 */

export type Primitive =
    string |
    number |
    boolean |
    bigint |
    symbol |
    null |
    undefined;

export type JsonObject = {
    [key: string]: JsonValue;
};

export type JsonArray = JsonValue[];

export type JsonValue =
    Primitive |
    JsonObject |
    JsonArray;

export type Nullable<T> = T | null;

export type Optional<T> = T | undefined;

export type DeepReadonly<T> = {
    readonly [K in keyof T]:
        T[K] extends object
            ? DeepReadonly<T[K]>
            : T[K];
};

export type DeepPartial<T> = {
    [K in keyof T]?:
        T[K] extends object
            ? DeepPartial<T[K]>
            : T[K];
};

export type Mutable<T> = {
    -readonly [K in keyof T]: T[K];
};

export type MemoryId = string;
export type Timestamp = number;
export type Score = number;
export type VersionNumber = number;
export type Checksum = string;
export type MemoryTag = string;
export type MemoryLabel = string;
export type Embedding = number[];

export type Dictionary<T = unknown> = Record<string, T>;

export type Predicate<T> = (value: T) => boolean;
export type Comparator<T> = (a: T, b: T) => number;
export type AsyncCallback<T> = (value: T) => Promise<void>;
export type Callback<T> = (value: T) => void;

/* =============================================================================
 * Memory Type
 * =============================================================================
 */

export enum MemoryType {
    Working = "working",
    ShortTerm = "short-term",
    LongTerm = "long-term",
    Semantic = "semantic",
    Episodic = "episodic",
    Procedural = "procedural",
    Evidence = "evidence",
    Inference = "inference",
    Recommendation = "recommendation",
    Context = "context",
    Session = "session"
}

/* =============================================================================
 * Memory State
 * =============================================================================
 */

export enum MemoryState {
    Active = "active",
    Inactive = "inactive",
    Archived = "archived",
    Deleted = "deleted",
    Locked = "locked",
    Corrupted = "corrupted"
}

/* =============================================================================
 * Memory Priority
 * =============================================================================
 */

export enum MemoryPriority {
    Low = "low",
    Normal = "normal",
    High = "high",
    Critical = "critical"
}

/* =============================================================================
 * Memory Events
 * =============================================================================
 */

export enum MemoryEventType {
    Created = "created",
    Updated = "updated",
    Deleted = "deleted",
    Archived = "archived",
    Restored = "restored",
    Accessed = "accessed",
    Validated = "validated",
    Consolidated = "consolidated",
    Imported = "imported",
    Exported = "exported",
    Snapshot = "snapshot"
}

/* =============================================================================
 * Memory Access Mode
 * =============================================================================
 */

export enum MemoryAccessMode {
    ReadOnly = "read-only",
    ReadWrite = "read-write",
    AppendOnly = "append-only",
    Locked = "locked"
}

/* =============================================================================
 * Memory Storage Tier
 * =============================================================================
 */

export enum MemoryStorageTier {
    Hot = "hot",
    Warm = "warm",
    Cold = "cold",
    Archive = "archive"
}

/* =============================================================================
 * Memory Consistency
 * =============================================================================
 */

export enum MemoryConsistency {
    Strong = "strong",
    Eventual = "eventual",
    Snapshot = "snapshot"
}

/* =============================================================================
 * Memory Compression
 * =============================================================================
 */

export enum MemoryCompression {
    None = "none",
    Gzip = "gzip",
    Brotli = "brotli",
    Lz4 = "lz4"
}

/* =============================================================================
 * Memory Conflict Resolution
 * =============================================================================
 */

export enum MemoryConflictStrategy {
    Ignore = "ignore",
    Replace = "replace",
    Merge = "merge",
    HighestConfidence = "highest-confidence",
    LatestVersion = "latest-version",
    Manual = "manual"
}

/* =============================================================================
 * Memory Validation
 * =============================================================================
 */

export enum MemoryValidationState {
    Unknown = "unknown",
    Pending = "pending",
    Valid = "valid",
    Invalid = "invalid"
}

/* =============================================================================
 * Memory Importance Category
 * =============================================================================
 */

export enum MemoryImportanceLevel {
    Trivial = "trivial",
    Minor = "minor",
    Moderate = "moderate",
    Major = "major",
    Critical = "critical"
}

/* =============================================================================
 * Memory Search Mode
 * =============================================================================
 */

export enum MemorySearchMode {
    Exact = "exact",
    Prefix = "prefix",
    Fuzzy = "fuzzy",
    Semantic = "semantic",
    Hybrid = "hybrid"
}

/* =============================================================================
 * Memory Sort Order
 * =============================================================================
 */

export enum SortOrder {
    Ascending = "ascending",
    Descending = "descending"
}

/* =============================================================================
 * Memory Index Type
 * =============================================================================
 */

export enum MemoryIndexType {
    Id = "id",
    Type = "type",
    State = "state",
    Priority = "priority",
    Confidence = "confidence",
    Importance = "importance",
    Tag = "tag",
    Label = "label",
    Session = "session",
    Timestamp = "timestamp"
}

/* =============================================================================
 * Memory Relationship Type
 * =============================================================================
 */

export enum MemoryRelationshipType {
    Parent = "parent",
    Child = "child",
    Related = "related",
    Dependency = "dependency",
    Reference = "reference",
    Duplicate = "duplicate",
    Derived = "derived"
}

/* =============================================================================
 * Memory Lifecycle
 * =============================================================================
 */

export enum MemoryLifecycle {
    Created = "created",
    Active = "active",
    Consolidated = "consolidated",
    Archived = "archived",
    Deleted = "deleted"
}

/* =============================================================================
 * Base Contracts
 * =============================================================================
 */

export interface Serializable<T = unknown> {
    serialize(): T;
}

export interface Cloneable<T> {
    clone(): T;
}

export interface Validatable {
    validate(): boolean;
}

export interface Versioned {
    readonly version: VersionNumber;
}

export interface Identifiable {
    readonly id: MemoryId;
}

export interface Timestamped {
    readonly createdAt: Timestamp;
    readonly updatedAt: Timestamp;
}

export interface MemoryObject
    extends Identifiable, Timestamped, Versioned, Validatable {
}

/* =============================================================================
 * Memory Access
 * =============================================================================
 */

export interface MemoryAccess {
    count: number;
    firstAccess: Timestamp;
    lastAccess: Timestamp;
    mode: MemoryAccessMode;
}

/* =============================================================================
 * Memory Relationship
 * =============================================================================
 */

export interface MemoryRelationship {
    parentId?: MemoryId;
    childIds: MemoryId[];
    relatedIds: MemoryId[];
    dependencyIds: MemoryId[];
}

/* =============================================================================
 * Memory Metadata
 * =============================================================================
 */

export interface MemoryMetadata {
    createdAt: Timestamp;
    updatedAt: Timestamp;
    createdBy?: string;
    source?: string;
    version: VersionNumber;
    checksum?: Checksum;
    tags: MemoryTag[];
    labels: MemoryLabel[];
    confidence: Score;
    importance: Score;
    validationState: MemoryValidationState;
    storageTier: MemoryStorageTier;
    compression: MemoryCompression;
}

/* =============================================================================
 * Memory Version
 * =============================================================================
 */

export interface MemoryVersion<T = unknown> {
    version: VersionNumber;
    timestamp: Timestamp;
    author?: string;
    changes: string[];
    snapshot: T;
}

/* =============================================================================
 * Memory Entry
 * =============================================================================
 */

export interface MemoryEntry<T = unknown> {
    id: MemoryId;
    type: MemoryType;
    state: MemoryState;
    priority: MemoryPriority;
    session?: ReasoningSession;
    report?: ReasoningReport;
    data: T;
    metadata: MemoryMetadata;
    relationships: MemoryRelationship;
    access: MemoryAccess;
    versions: MemoryVersion<T>[];
    expiresAt?: Timestamp;
    lastValidated?: Timestamp;
    score: Score;
    embedding?: Embedding;
    customProperties?: Dictionary;
}

/* =============================================================================
 * Memory Snapshot
 * =============================================================================
 */

export interface MemorySnapshot<T = unknown> {
    id: MemoryId;
    timestamp: Timestamp;
    version: VersionNumber;
    entries: MemoryEntry<T>[];
}

/* =============================================================================
 * Memory Query
 * =============================================================================
 */

export interface MemoryQuery {
    id?: MemoryId;
    type?: MemoryType;
    state?: MemoryState;
    priority?: MemoryPriority;
    tags?: MemoryTag[];
    labels?: MemoryLabel[];
    minimumConfidence?: Score;
    minimumImportance?: Score;
    createdAfter?: Timestamp;
    createdBefore?: Timestamp;
    updatedAfter?: Timestamp;
    updatedBefore?: Timestamp;
    sessionId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    ascending?: boolean;
    sortBy?: keyof MemoryMetadata;
}

/* =============================================================================
 * Memory Search Result
 * =============================================================================
 */

export interface MemorySearchResult<T = unknown> {
    entry: MemoryEntry<T>;
    score: Score;
    matchedFields: string[];
    reason: string;
}

/* =============================================================================
 * Memory Statistics
 * =============================================================================
 */

export interface MemoryStatistics {
    totalEntries: number;
    activeEntries: number;
    archivedEntries: number;
    deletedEntries: number;
    workingMemory: number;
    shortTermMemory: number;
    longTermMemory: number;
    semanticMemory: number;
    episodicMemory: number;
    proceduralMemory: number;
    recommendationMemory: number;
    evidenceMemory: number;
    inferenceMemory: number;
    averageConfidence: number;
    averageImportance: number;
    averageVersions: number;
    graphNodes: number;
    graphEdges: number;
    cacheHits: number;
    cacheMisses: number;
}

/* =============================================================================
 * Memory Transaction
 * =============================================================================
 */

export interface MemoryTransaction {
    id: MemoryId;
    timestamp: Timestamp;
    description?: string;
    operations: string[];
    committed: boolean;
}

/* =============================================================================
 * Memory Configuration
 * =============================================================================
 */

export interface MemoryConfiguration {
    maxEntries: number;
    cacheSize: number;
    enableCompression: boolean;
    enableSnapshots: boolean;
    enableDeduplication: boolean;
    enableDiagnostics: boolean;
    enableArchiving: boolean;
    autoConsolidation: boolean;
    defaultAccessMode: MemoryAccessMode;
    defaultStorageTier: MemoryStorageTier;
    defaultConflictStrategy: MemoryConflictStrategy;
}

/* =============================================================================
 * Memory Index
 * =============================================================================
 */

export interface MemoryIndexEntry {
    key: string;
    memoryId: MemoryId;
    type: MemoryIndexType;
}

/* =============================================================================
 * Memory Graph
 * =============================================================================
 */

export interface MemoryGraphNode {
    id: MemoryId;
    type: MemoryType;
}

export interface MemoryGraphEdge {
    from: MemoryId;
    to: MemoryId;
    relationship: MemoryRelationshipType;
}

/* =============================================================================
 * Memory Import / Export
 * =============================================================================
 */

export interface MemoryExport<T = unknown> {
    exportedAt: Timestamp;
    formatVersion: number;
    entries: MemoryEntry<T>[];
}

export interface MemoryImport<T = unknown> {
    importedAt: Timestamp;
    entries: MemoryEntry<T>[];
}

/* =============================================================================
 * Memory Observer
 * =============================================================================
 */

export interface MemoryObserver<T = unknown> {
    onCreated?(entry: MemoryEntry<T>): void;
    onUpdated?(entry: MemoryEntry<T>): void;
    onDeleted?(entry: MemoryEntry<T>): void;
    onArchived?(entry: MemoryEntry<T>): void;
    onRestored?(entry: MemoryEntry<T>): void;
}

/* =============================================================================
 * Memory Factory
 * =============================================================================
 */

export interface MemoryFactory {
    create<T>(entry: MemoryEntry<T>): MemoryEntry<T>;
}

/* =============================================================================
 * Memory Node
 * =============================================================================
 */

export class MemoryNode<T = unknown>
    implements
        Serializable<MemoryEntry<T>>,
        Cloneable<MemoryNode<T>>,
        Validatable,
        Versioned,
        Identifiable {

    public readonly id: MemoryId;

    private type: MemoryType;
    private state: MemoryState;
    private priority: MemoryPriority;

    private value: T;

    private metadata: MemoryMetadata;

    private relationships: MemoryRelationship;

    private access: MemoryAccess;

    private versions: MemoryVersion<T>[];

    private dirty = false;
    private frozen = false;
    private archived = false;
    private deleted = false;
    private validated = false;

    constructor(entry: MemoryEntry<T>) {
        this.id = entry.id;
        this.type = entry.type;
        this.state = entry.state;
        this.priority = entry.priority;
        this.value = structuredClone(entry.data);
        this.metadata = structuredClone(entry.metadata);
        this.relationships = structuredClone(entry.relationships);
        this.access = structuredClone(entry.access);
        this.versions = structuredClone(entry.versions);
    }

    get version(): VersionNumber {
        return this.metadata.version;
    }

    get createdAt(): Timestamp {
        return this.metadata.createdAt;
    }

    get updatedAt(): Timestamp {
        return this.metadata.updatedAt;
    }

    getId(): MemoryId {
        return this.id;
    }

    getType(): MemoryType {
        return this.type;
    }

    getState(): MemoryState {
        return this.state;
    }

    getPriority(): MemoryPriority {
        return this.priority;
    }

    getValue(): T {
        return this.value;
    }

    getValueCopy(): T {
        return structuredClone(this.value);
    }

    hasValue(): boolean {
        return this.value !== undefined;
    }

    isEmpty(): boolean {
        return this.value === undefined || this.value === null;
    }

    getMetadata(): DeepReadonly<MemoryMetadata> {
        return structuredClone(this.metadata);
    }

    getConfidence(): Score {
        return this.metadata.confidence;
    }

    getImportance(): Score {
        return this.metadata.importance;
    }

    getChecksum(): Optional<Checksum> {
        return this.metadata.checksum;
    }

    getTags(): readonly MemoryTag[] {
        return [...this.metadata.tags];
    }

    getLabels(): readonly MemoryLabel[] {
        return [...this.metadata.labels];
    }

    hasTag(tag: MemoryTag): boolean {
        return this.metadata.tags.includes(tag);
    }

    hasLabel(label: MemoryLabel): boolean {
        return this.metadata.labels.includes(label);
    }

    /**
     * Returns every relationship.
     */
    getRelationships(): DeepReadonly<MemoryRelationship> {
        return structuredClone(this.relationships);
    }

    getParentId(): Optional<MemoryId> {
        return this.relationships.parentId;
    }

    getChildren(): readonly MemoryId[] {
        return [...this.relationships.childIds];
    }

    getRelated(): readonly MemoryId[] {
        return [...this.relationships.relatedIds];
    }

    getDependencies(): readonly MemoryId[] {
        return [...this.relationships.dependencyIds];
    }

    hasParent(): boolean {
        return this.relationships.parentId !== undefined;
    }

    hasChildren(): boolean {
        return this.relationships.childIds.length > 0;
    }

    hasDependencies(): boolean {
        return this.relationships.dependencyIds.length > 0;
    }

    hasRelations(): boolean {
        return this.relationships.relatedIds.length > 0;
    }

    isRelatedTo(id: MemoryId): boolean {
        return this.relationships.relatedIds.includes(id);
    }

    dependsOn(id: MemoryId): boolean {
        return this.relationships.dependencyIds.includes(id);
    }

    getAccess(): DeepReadonly<MemoryAccess> {
        return structuredClone(this.access);
    }

    getAccessCount(): number {
        return this.access.count;
    }

    getFirstAccess(): Timestamp {
        return this.access.firstAccess;
    }

    getLastAccess(): Timestamp {
        return this.access.lastAccess;
    }

    getAccessMode(): MemoryAccessMode {
        return this.access.mode;
    }

    touch(): void {
        this.access.count++;
        this.access.lastAccess = Date.now();
    }

    isFrozen(): boolean {
        return this.frozen;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    isDeleted(): boolean {
        return this.deleted;
    }

    isArchived(): boolean {
        return this.archived;
    }

    isValidated(): boolean {
        return this.validated;
    }

    isActive(): boolean {
        return this.state === MemoryState.Active;
    }

    isInactive(): boolean {
        return this.state === MemoryState.Inactive;
    }

    isLocked(): boolean {
        return this.state === MemoryState.Locked;
    }

    isCorrupted(): boolean {
        return this.state === MemoryState.Corrupted;
    }

    isMutable(): boolean {
        return !(
            this.deleted ||
            this.archived ||
            this.frozen ||
            this.state === MemoryState.Locked
        );
    }

    isUsable(): boolean {
        return (
            !this.deleted &&
            !this.archived &&
            this.state === MemoryState.Active
        );
    }

    hasExpired(): boolean {
        return false;
    }

    hasData(): boolean {
        return this.value !== undefined;
    }

    hasGraphConnections(): boolean {
        return (
            this.hasParent() ||
            this.hasChildren() ||
            this.hasRelations() ||
            this.hasDependencies()
        );
    }

    private assertMutable(): void {
        if (this.deleted) {
            throw new Error("Cannot modify a deleted memory node.");
        }
        if (this.archived) {
            throw new Error("Cannot modify an archived memory node.");
        }
        if (this.frozen) {
            throw new Error("Cannot modify a frozen memory node.");
        }
        if (this.state === MemoryState.Locked) {
            throw new Error("Memory node is locked.");
        }
    }

    private markDirty(): void {
        this.dirty = true;
        this.metadata.updatedAt = Date.now();
    }

    private clearDirty(): void {
        this.dirty = false;
    }

    private markValidated(): void {
        this.validated = true;
        this.metadata.validationState = MemoryValidationState.Valid;
    }

    private markInvalid(): void {
        this.validated = false;
        this.metadata.validationState = MemoryValidationState.Invalid;
    }

    private incrementVersion(): void {
        this.metadata.version++;
    }

    private touchMetadata(): void {
        this.metadata.updatedAt = Date.now();
    }

    private createVersion(change: string): void {
        this.versions.push({
            version: this.metadata.version,
            timestamp: Date.now(),
            changes: [change],
            snapshot: structuredClone(this.value)
        });
    }

    private commitMutation(description: string): void {
        this.incrementVersion();
        this.touchMetadata();
        this.markDirty();
        this.createVersion(description);
    }

    setValue(value: T): this {
        this.assertMutable();
        this.value = structuredClone(value);
        this.commitMutation("Updated value");
        return this;
    }

    setState(state: MemoryState): this {
        this.assertMutable();
        if (this.state === state) {
            return this;
        }
        this.state = state;
        this.commitMutation(`State changed to ${state}`);
        return this;
    }

    setPriority(priority: MemoryPriority): this {
        this.assertMutable();
        if (this.priority === priority) {
            return this;
        }
        this.priority = priority;
        this.commitMutation(`Priority changed to ${priority}`);
        return this;
    }

    setConfidence(confidence: Score): this {
        this.assertMutable();
        if (confidence < MIN_MEMORY_CONFIDENCE || confidence > MAX_MEMORY_CONFIDENCE) {
            throw new RangeError("Confidence is outside the valid range.");
        }
        this.metadata.confidence = confidence;
        this.commitMutation("Updated confidence");
        return this;
    }

    setImportance(importance: Score): this {
        this.assertMutable();
        if (importance < MIN_MEMORY_IMPORTANCE || importance > MAX_MEMORY_IMPORTANCE) {
            throw new RangeError("Importance is outside the valid range.");
        }
        this.metadata.importance = importance;
        this.commitMutation("Updated importance");
        return this;
    }

    setChecksum(checksum: Checksum): this {
        this.assertMutable();
        this.metadata.checksum = checksum;
        this.commitMutation("Updated checksum");
        return this;
    }

    setSource(source: string): this {
        this.assertMutable();
        this.metadata.source = source;
        this.commitMutation("Updated source");
        return this;
    }

    setCreatedBy(createdBy: string): this {
        this.assertMutable();
        this.metadata.createdBy = createdBy;
        this.commitMutation("Updated creator");
        return this;
    }

    addTag(tag: MemoryTag): this {
        this.assertMutable();
        if (!this.metadata.tags.includes(tag)) {
            this.metadata.tags.push(tag);
            this.commitMutation(`Added tag '${tag}'`);
        }
        return this;
    }

    removeTag(tag: MemoryTag): this {
        this.assertMutable();
        const index = this.metadata.tags.indexOf(tag);
        if (index >= 0) {
            this.metadata.tags.splice(index, 1);
            this.commitMutation(`Removed tag '${tag}'`);
        }
        return this;
    }

    clearTags(): this {
        this.assertMutable();
        if (this.metadata.tags.length > 0) {
            this.metadata.tags = [];
            this.commitMutation("Cleared tags");
        }
        return this;
    }

    addLabel(label: MemoryLabel): this {
        this.assertMutable();
        if (!this.metadata.labels.includes(label)) {
            this.metadata.labels.push(label);
            this.commitMutation(`Added label '${label}'`);
        }
        return this;
    }

    removeLabel(label: MemoryLabel): this {
        this.assertMutable();
        const index = this.metadata.labels.indexOf(label);
        if (index >= 0) {
            this.metadata.labels.splice(index, 1);
            this.commitMutation(`Removed label '${label}'`);
        }
        return this;
    }

    clearLabels(): this {
        this.assertMutable();
        if (this.metadata.labels.length > 0) {
            this.metadata.labels = [];
            this.commitMutation("Cleared labels");
        }
        return this;
    }

    setParent(id: MemoryId): this {
        this.assertMutable();
        this.relationships.parentId = id;
        this.commitMutation("Updated parent");
        return this;
    }

    clearParent(): this {
        this.assertMutable();
        delete this.relationships.parentId;
        this.commitMutation("Removed parent");
        return this;
    }

    addChild(id: MemoryId): this {
        this.assertMutable();
        if (!this.relationships.childIds.includes(id)) {
            this.relationships.childIds.push(id);
            this.commitMutation("Added child");
        }
        return this;
    }

    removeChild(id: MemoryId): this {
        this.assertMutable();
        this.relationships.childIds =
            this.relationships.childIds.filter(child => child !== id);
        this.commitMutation("Removed child");
        return this;
    }

    addRelated(id: MemoryId): this {
        this.assertMutable();
        if (!this.relationships.relatedIds.includes(id)) {
            this.relationships.relatedIds.push(id);
            this.commitMutation("Added relation");
        }
        return this;
    }

    addDependency(id: MemoryId): this {
        this.assertMutable();
        if (!this.relationships.dependencyIds.includes(id)) {
            this.relationships.dependencyIds.push(id);
            this.commitMutation("Added dependency");
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

    archive(): this {
        this.archived = true;
        this.state = MemoryState.Archived;
        this.commitMutation("Archived");
        return this;
    }

    restore(): this {
        this.archived = false;
        this.deleted = false;
        this.state = MemoryState.Active;
        this.commitMutation("Restored");
        return this;
    }

    delete(): this {
        this.deleted = true;
        this.state = MemoryState.Deleted;
        this.commitMutation("Deleted");
        return this;
    }

    invalidate(): this {
        this.markInvalid();
        return this;
    }

    validate(): boolean {
        const valid = this.id.length > 0 && this.metadata.version > 0;
        if (valid) {
            this.markValidated();
        } else {
            this.markInvalid();
        }
        return valid;
    }

    /**
     * Returns the full version history.
     */
    getVersions(): readonly MemoryVersion<T>[] {
        return structuredClone(this.versions);
    }

    serialize(): MemoryEntry<T> {
        return {
            id: this.id,
            type: this.type,
            state: this.state,
            priority: this.priority,
            data: structuredClone(this.value),
            metadata: structuredClone(this.metadata),
            relationships: structuredClone(this.relationships),
            access: structuredClone(this.access),
            versions: structuredClone(this.versions),
            score: this.metadata.confidence * this.metadata.importance
        };
    }

    toJSON(): MemoryEntry<T> {
        return this.serialize();
    }

    clone(): MemoryNode<T> {
        return new MemoryNode(this.serialize());
    }

    deepClone(): MemoryNode<T> {
        return this.clone();
    }

    equals(other: MemoryNode<T>): boolean {
        return this.id === other.id;
    }

    contentEquals(other: MemoryNode<T>): boolean {
        return JSON.stringify(this.value) === JSON.stringify(other.value);
    }

    merge(other: MemoryNode<T>): this {
        this.assertMutable();

        if (other.getConfidence() > this.getConfidence()) {
            this.value = structuredClone(other.getValue());
        }

        this.metadata.tags = [
            ...new Set([...this.metadata.tags, ...other.getTags()])
        ];

        this.metadata.labels = [
            ...new Set([...this.metadata.labels, ...other.getLabels()])
        ];

        this.metadata.confidence = Math.max(
            this.metadata.confidence,
            other.getConfidence()
        );

        this.metadata.importance = Math.max(
            this.metadata.importance,
            other.getImportance()
        );

        this.commitMutation("Merged node");
        return this;
    }

    reset(): this {
        this.assertMutable();
        this.dirty = false;
        this.validated = false;
        this.access.count = 0;
        this.access.firstAccess = Date.now();
        this.access.lastAccess = this.access.firstAccess;
        this.commitMutation("Reset node");
        return this;
    }

    snapshot(): MemorySnapshot<T> {
        return {
            id: this.id,
            timestamp: Date.now(),
            version: this.version,
            entries: [this.serialize()]
        };
    }

    describe(): string {
        return [
            `MemoryNode(${this.id})`,
            `type=${this.type}`,
            `state=${this.state}`,
            `priority=${this.priority}`,
            `version=${this.version}`,
            `confidence=${this.metadata.confidence}`,
            `importance=${this.metadata.importance}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            id: this.id,
            type: this.type,
            state: this.state,
            priority: this.priority,
            dirty: this.dirty,
            frozen: this.frozen,
            archived: this.archived,
            deleted: this.deleted,
            validated: this.validated,
            metadata: structuredClone(this.metadata),
            access: structuredClone(this.access),
            relationships: structuredClone(this.relationships)
        };
    }
}

/* =============================================================================
 * Memory Store
 * =============================================================================
 */

export class MemoryStore<T = unknown> {

    private readonly nodes = new Map<MemoryId, MemoryNode<T>>();

    private readonly deletedNodes = new Map<MemoryId, MemoryNode<T>>();

    private readonly observers = new Set<MemoryObserver<T>>();

    private readonly configuration: MemoryConfiguration;

    private readonly statistics: MemoryStatistics;

    constructor(configuration: Partial<MemoryConfiguration> = {}) {
        this.configuration = {
            maxEntries: Number.MAX_SAFE_INTEGER,
            cacheSize: 1000,
            enableCompression: true,
            enableSnapshots: true,
            enableDeduplication: true,
            enableDiagnostics: true,
            enableArchiving: true,
            autoConsolidation: false,
            defaultAccessMode: MemoryAccessMode.ReadWrite,
            defaultStorageTier: MemoryStorageTier.Hot,
            defaultConflictStrategy: MemoryConflictStrategy.Merge,
            ...configuration
        };

        this.statistics = {
            totalEntries: 0,
            activeEntries: 0,
            archivedEntries: 0,
            deletedEntries: 0,
            workingMemory: 0,
            shortTermMemory: 0,
            longTermMemory: 0,
            semanticMemory: 0,
            episodicMemory: 0,
            proceduralMemory: 0,
            recommendationMemory: 0,
            evidenceMemory: 0,
            inferenceMemory: 0,
            averageConfidence: 0,
            averageImportance: 0,
            averageVersions: 0,
            graphNodes: 0,
            graphEdges: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
    }

    size(): number {
        return this.nodes.size;
    }

    isEmpty(): boolean {
        return this.nodes.size === 0;
    }

    contains(id: MemoryId): boolean {
        return this.nodes.has(id);
    }

    get(id: MemoryId): MemoryNode<T> | undefined {
        return this.nodes.get(id);
    }

    require(id: MemoryId): MemoryNode<T> {
        const node = this.nodes.get(id);
        if (!node) {
            throw new Error(`Memory node '${id}' does not exist.`);
        }
        return node;
    }

    add(node: MemoryNode<T>): this {
        const id = node.getId();

        if (this.nodes.has(id)) {
            throw new Error(`Memory node '${id}' already exists.`);
        }

        if (this.nodes.size >= this.configuration.maxEntries) {
            throw new Error("Maximum memory capacity reached.");
        }

        this.nodes.set(id, node);
        this.statistics.totalEntries++;
        this.statistics.activeEntries++;
        return this;
    }

    addMany(nodes: Iterable<MemoryNode<T>>): this {
        for (const node of nodes) {
            this.add(node);
        }
        return this;
    }

    replace(node: MemoryNode<T>): this {
        this.nodes.set(node.getId(), node);
        return this;
    }

    update(node: MemoryNode<T>): this {
        if (!this.nodes.has(node.getId())) {
            throw new Error("Cannot update missing node.");
        }
        this.nodes.set(node.getId(), node);
        return this;
    }

    remove(id: MemoryId): boolean {
        const node = this.nodes.get(id);
        if (!node) {
            return false;
        }
        this.nodes.delete(id);
        this.deletedNodes.set(id, node);
        this.statistics.activeEntries--;
        this.statistics.deletedEntries++;
        return true;
    }

    restore(id: MemoryId): boolean {
        const node = this.deletedNodes.get(id);
        if (!node) {
            return false;
        }
        this.deletedNodes.delete(id);
        this.nodes.set(id, node);
        this.statistics.deletedEntries--;
        this.statistics.activeEntries++;
        return true;
    }

    clear(): void {
        this.nodes.clear();
        this.deletedNodes.clear();
        this.statistics.totalEntries = 0;
        this.statistics.activeEntries = 0;
        this.statistics.deletedEntries = 0;
    }

    keys(): IterableIterator<MemoryId> {
        return this.nodes.keys();
    }

    values(): IterableIterator<MemoryNode<T>> {
        return this.nodes.values();
    }

    entries(): IterableIterator<[MemoryId, MemoryNode<T>]> {
        return this.nodes.entries();
    }

    [Symbol.iterator](): IterableIterator<[MemoryId, MemoryNode<T>]> {
        return this.entries();
    }

    forEach(callback: (node: MemoryNode<T>, id: MemoryId) => void): void {
        for (const [id, node] of this.nodes) {
            callback(node, id);
        }
    }

    map<R>(callback: (node: MemoryNode<T>, id: MemoryId) => R): R[] {
        const results: R[] = [];
        for (const [id, node] of this.nodes) {
            results.push(callback(node, id));
        }
        return results;
    }

    filter(predicate: (node: MemoryNode<T>, id: MemoryId) => boolean): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const [id, node] of this.nodes) {
            if (predicate(node, id)) {
                results.push(node);
            }
        }
        return results;
    }

    find(predicate: (node: MemoryNode<T>, id: MemoryId) => boolean): MemoryNode<T> | undefined {
        for (const [id, node] of this.nodes) {
            if (predicate(node, id)) {
                return node;
            }
        }
        return undefined;
    }

    some(predicate: (node: MemoryNode<T>, id: MemoryId) => boolean): boolean {
        for (const [id, node] of this.nodes) {
            if (predicate(node, id)) {
                return true;
            }
        }
        return false;
    }

    every(predicate: (node: MemoryNode<T>, id: MemoryId) => boolean): boolean {
        for (const [id, node] of this.nodes) {
            if (!predicate(node, id)) {
                return false;
            }
        }
        return true;
    }

    reduce<R>(
        callback: (accumulator: R, node: MemoryNode<T>, id: MemoryId) => R,
        initialValue: R
    ): R {
        let accumulator = initialValue;
        for (const [id, node] of this.nodes) {
            accumulator = callback(accumulator, node, id);
        }
        return accumulator;
    }

    toArray(): MemoryNode<T>[] {
        return Array.from(this.nodes.values());
    }

    ids(): MemoryId[] {
        return Array.from(this.nodes.keys());
    }

    first(): MemoryNode<T> | undefined {
        for (const node of this.nodes.values()) {
            return node;
        }
        return undefined;
    }

    last(): MemoryNode<T> | undefined {
        let result: MemoryNode<T> | undefined;
        for (const node of this.nodes.values()) {
            result = node;
        }
        return result;
    }

    random(): MemoryNode<T> | undefined {
        if (this.nodes.size === 0) {
            return undefined;
        }
        const nodes = this.toArray();
        return nodes[Math.floor(Math.random() * nodes.length)];
    }

    getStatistics(): MemoryStatistics {
        this.recalculateStatistics();
        return structuredClone(this.statistics);
    }

    recalculateStatistics(): void {
        this.statistics.totalEntries = this.nodes.size;
        this.statistics.activeEntries = this.nodes.size;
        this.statistics.deletedEntries = this.deletedNodes.size;

        let confidence = 0;
        let importance = 0;
        let versions = 0;

        for (const node of this.nodes.values()) {
            confidence += node.getConfidence();
            importance += node.getImportance();
            versions += node.getVersions().length;
        }

        if (this.nodes.size > 0) {
            this.statistics.averageConfidence = confidence / this.nodes.size;
            this.statistics.averageImportance = importance / this.nodes.size;
            this.statistics.averageVersions = versions / this.nodes.size;
        }
    }

    validate(): boolean {
        for (const node of this.nodes.values()) {
            if (!node.validate()) {
                return false;
            }
        }
        return true;
    }

    validateNode(id: MemoryId): boolean {
        const node = this.get(id);
        if (!node) {
            return false;
        }
        return node.validate();
    }

    compact(): number {
        let removed = 0;
        for (const [id, node] of this.deletedNodes) {
            if (node.isArchived()) {
                this.deletedNodes.delete(id);
                removed++;
            }
        }
        this.statistics.deletedEntries = this.deletedNodes.size;
        return removed;
    }

    vacuum(): void {
        this.compact();
        this.recalculateStatistics();
    }

    snapshot(): MemorySnapshot<T> {
        return {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            version: 1,
            entries: this.toArray().map(node => node.serialize())
        };
    }

    export(): MemoryExport<T> {
        return {
            exportedAt: Date.now(),
            formatVersion: MEMORY_FORMAT_VERSION,
            entries: this.toArray().map(node => node.serialize())
        };
    }

    describe(): string {
        return [
            `MemoryStore`,
            `nodes=${this.nodes.size}`,
            `deleted=${this.deletedNodes.size}`,
            `capacity=${this.configuration.maxEntries}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            size: this.nodes.size,
            deleted: this.deletedNodes.size,
            statistics: structuredClone(this.statistics),
            configuration: structuredClone(this.configuration)
        };
    }
}

/* =============================================================================
 * Memory Index
 * =============================================================================
 */

export class MemoryIndex<T = unknown> {

    private readonly typeIndex = new Map<MemoryType, Set<MemoryId>>();
    private readonly stateIndex = new Map<MemoryState, Set<MemoryId>>();
    private readonly priorityIndex = new Map<MemoryPriority, Set<MemoryId>>();
    private readonly tagIndex = new Map<MemoryTag, Set<MemoryId>>();
    private readonly labelIndex = new Map<MemoryLabel, Set<MemoryId>>();
    private readonly sessionIndex = new Map<string, Set<MemoryId>>();

    private indexedCount = 0;

    constructor() {}

    private addToIndex<K>(map: Map<K, Set<MemoryId>>, key: K, id: MemoryId): void {
        let bucket = map.get(key);
        if (!bucket) {
            bucket = new Set();
            map.set(key, bucket);
        }
        bucket.add(id);
    }

    private removeFromIndex<K>(map: Map<K, Set<MemoryId>>, key: K, id: MemoryId): void {
        const bucket = map.get(key);
        if (!bucket) {
            return;
        }
        bucket.delete(id);
        if (bucket.size === 0) {
            map.delete(key);
        }
    }

    add(node: MemoryNode<T>): void {
        const id = node.getId();

        this.addToIndex(this.typeIndex, node.getType(), id);
        this.addToIndex(this.stateIndex, node.getState(), id);
        this.addToIndex(this.priorityIndex, node.getPriority(), id);

        for (const tag of node.getTags()) {
            this.addToIndex(this.tagIndex, tag, id);
        }

        for (const label of node.getLabels()) {
            this.addToIndex(this.labelIndex, label, id);
        }

        this.indexedCount++;
    }

    remove(node: MemoryNode<T>): void {
        const id = node.getId();

        this.removeFromIndex(this.typeIndex, node.getType(), id);
        this.removeFromIndex(this.stateIndex, node.getState(), id);
        this.removeFromIndex(this.priorityIndex, node.getPriority(), id);

        for (const tag of node.getTags()) {
            this.removeFromIndex(this.tagIndex, tag, id);
        }

        for (const label of node.getLabels()) {
            this.removeFromIndex(this.labelIndex, label, id);
        }

        this.indexedCount = Math.max(0, this.indexedCount - 1);
    }

    rebuild(store: MemoryStore<T>): void {
        this.clear();
        for (const [, node] of store) {
            this.add(node);
        }
    }

    byType(type: MemoryType): ReadonlySet<MemoryId> {
        return this.typeIndex.get(type) ?? new Set();
    }

    byState(state: MemoryState): ReadonlySet<MemoryId> {
        return this.stateIndex.get(state) ?? new Set();
    }

    byPriority(priority: MemoryPriority): ReadonlySet<MemoryId> {
        return this.priorityIndex.get(priority) ?? new Set();
    }

    byTag(tag: MemoryTag): ReadonlySet<MemoryId> {
        return this.tagIndex.get(tag) ?? new Set();
    }

    byLabel(label: MemoryLabel): ReadonlySet<MemoryId> {
        return this.labelIndex.get(label) ?? new Set();
    }

    size(): number {
        return this.indexedCount;
    }

    clear(): void {
        this.typeIndex.clear();
        this.stateIndex.clear();
        this.priorityIndex.clear();
        this.tagIndex.clear();
        this.labelIndex.clear();
        this.sessionIndex.clear();
        this.indexedCount = 0;
    }

    describe(): string {
        return ["MemoryIndex", `indexed=${this.indexedCount}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            indexed: this.indexedCount,
            types: this.typeIndex.size,
            states: this.stateIndex.size,
            priorities: this.priorityIndex.size,
            tags: this.tagIndex.size,
            labels: this.labelIndex.size
        };
    }
}

/* =============================================================================
 * Memory Graph
 * =============================================================================
 */

export class MemoryGraph<T = unknown> {

    private readonly adjacency = new Map<MemoryId, Set<MemoryId>>();
    private readonly reverseAdjacency = new Map<MemoryId, Set<MemoryId>>();

    private edgeCount = 0;

    constructor() {}

    private ensure(id: MemoryId): Set<MemoryId> {
        let neighbors = this.adjacency.get(id);
        if (!neighbors) {
            neighbors = new Set();
            this.adjacency.set(id, neighbors);
        }
        return neighbors;
    }

    private ensureReverse(id: MemoryId): Set<MemoryId> {
        let neighbors = this.reverseAdjacency.get(id);
        if (!neighbors) {
            neighbors = new Set();
            this.reverseAdjacency.set(id, neighbors);
        }
        return neighbors;
    }

    addEdge(from: MemoryId, to: MemoryId): this {
        const neighbors = this.ensure(from);
        if (!neighbors.has(to)) {
            neighbors.add(to);
            this.ensureReverse(to).add(from);
            this.edgeCount++;
        }
        return this;
    }

    removeEdge(from: MemoryId, to: MemoryId): this {
        const neighbors = this.adjacency.get(from);
        if (neighbors?.delete(to)) {
            this.reverseAdjacency.get(to)?.delete(from);
            this.edgeCount--;
        }
        return this;
    }

    hasEdge(from: MemoryId, to: MemoryId): boolean {
        return this.adjacency.get(from)?.has(to) ?? false;
    }

    removeNode(id: MemoryId): void {
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

    clear(): void {
        this.adjacency.clear();
        this.reverseAdjacency.clear();
        this.edgeCount = 0;
    }

    neighbors(id: MemoryId): ReadonlySet<MemoryId> {
        return this.adjacency.get(id) ?? new Set();
    }

    incoming(id: MemoryId): ReadonlySet<MemoryId> {
        return this.reverseAdjacency.get(id) ?? new Set();
    }

    degree(id: MemoryId): number {
        return this.adjacency.get(id)?.size ?? 0;
    }

    edges(): number {
        return this.edgeCount;
    }

    nodes(): number {
        return this.adjacency.size;
    }

    breadthFirst(start: MemoryId): MemoryId[] {
        const visited = new Set<MemoryId>();
        const queue: MemoryId[] = [start];
        const result: MemoryId[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) {
                continue;
            }
            visited.add(current);
            result.push(current);
            for (const next of this.neighbors(current)) {
                queue.push(next);
            }
        }

        return result;
    }

    depthFirst(start: MemoryId): MemoryId[] {
        const visited = new Set<MemoryId>();
        const result: MemoryId[] = [];

        const visit = (id: MemoryId) => {
            if (visited.has(id)) {
                return;
            }
            visited.add(id);
            result.push(id);
            for (const next of this.neighbors(id)) {
                visit(next);
            }
        };

        visit(start);
        return result;
    }

    describe(): string {
        return ["MemoryGraph", `nodes=${this.nodes()}`, `edges=${this.edges()}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            nodes: this.nodes(),
            edges: this.edges(),
            adjacency: structuredClone(Array.from(this.adjacency.entries()))
        };
    }
}

/* =============================================================================
 * Memory Cache
 * =============================================================================
 */

export class MemoryCache<T = unknown> {

    private readonly cache = new Map<MemoryId, MemoryNode<T>>();

    private readonly capacity: number;

    private hits = 0;
    private misses = 0;
    private evictions = 0;

    constructor(capacity = 1000) {
        if (capacity <= 0) {
            throw new RangeError("Cache capacity must be greater than zero.");
        }
        this.capacity = capacity;
    }

    size(): number {
        return this.cache.size;
    }

    isEmpty(): boolean {
        return this.cache.size === 0;
    }

    capacityLimit(): number {
        return this.capacity;
    }

    contains(id: MemoryId): boolean {
        return this.cache.has(id);
    }

    get(id: MemoryId): MemoryNode<T> | undefined {
        const node = this.cache.get(id);
        if (!node) {
            this.misses++;
            return undefined;
        }
        this.cache.delete(id);
        this.cache.set(id, node);
        this.hits++;
        return node;
    }

    peek(id: MemoryId): MemoryNode<T> | undefined {
        return this.cache.get(id);
    }

    /**
     * Stores a node in the cache, keyed by its own id.
     */
    put(id: MemoryId, node: MemoryNode<T>): this {
        if (this.cache.has(id)) {
            this.cache.delete(id);
        }

        this.cache.set(id, node);

        while (this.cache.size > this.capacity) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
                this.evictions++;
            }
        }

        return this;
    }

    remove(id: MemoryId): boolean {
        return this.cache.delete(id);
    }

    clear(): void {
        this.cache.clear();
    }

    hitCount(): number {
        return this.hits;
    }

    missCount(): number {
        return this.misses;
    }

    evictionCount(): number {
        return this.evictions;
    }

    hitRate(): number {
        const total = this.hits + this.misses;
        if (total === 0) {
            return 0;
        }
        return this.hits / total;
    }

    keys(): MemoryId[] {
        return Array.from(this.cache.keys());
    }

    values(): MemoryNode<T>[] {
        return Array.from(this.cache.values());
    }

    entries(): [MemoryId, MemoryNode<T>][] {
        return Array.from(this.cache.entries());
    }

    describe(): string {
        return [
            "MemoryCache",
            `size=${this.size()}`,
            `capacity=${this.capacity}`,
            `hits=${this.hits}`,
            `misses=${this.misses}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            size: this.size(),
            capacity: this.capacity,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            hitRate: this.hitRate()
        };
    }
}

/* =============================================================================
 * Memory Snapshot Manager
 * =============================================================================
 */

export class MemorySnapshotManager<T = unknown> {

    private readonly snapshots = new Map<string, MemorySnapshot<T>>();

    private readonly history: string[] = [];

    private readonly capacity: number;

    constructor(capacity = 100) {
        if (capacity <= 0) {
            throw new RangeError("Snapshot capacity must be greater than zero.");
        }
        this.capacity = capacity;
    }

    /**
     * Creates and stores a snapshot of the given store.
     * The optional `label` is recorded only for the caller's convenience;
     * it is not part of the returned MemorySnapshot shape.
     */
    create(store: MemoryStore<T>, label?: string): MemorySnapshot<T> {
        const snapshot = store.snapshot();

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

    get(id: string): MemorySnapshot<T> | undefined {
        const snapshot = this.snapshots.get(id);
        if (!snapshot) {
            return undefined;
        }
        return structuredClone(snapshot);
    }

    latest(): MemorySnapshot<T> | undefined {
        const id = this.history.at(-1);
        if (!id) {
            return undefined;
        }
        return this.get(id);
    }

    oldest(): MemorySnapshot<T> | undefined {
        if (this.history.length === 0) {
            return undefined;
        }
        return this.get(this.history[0]);
    }

    restore(snapshot: MemorySnapshot<T>): MemoryStore<T> {
        const store = new MemoryStore<T>();
        for (const entry of snapshot.entries) {
            store.add(new MemoryNode(entry));
        }
        return store;
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

    isEmpty(): boolean {
        return this.snapshots.size === 0;
    }

    ids(): readonly string[] {
        return [...this.history];
    }

    snapshotsArray(): MemorySnapshot<T>[] {
        return this.history
            .map(id => this.snapshots.get(id)!)
            .map(snapshot => structuredClone(snapshot));
    }

    describe(): string {
        return ["MemorySnapshotManager", `snapshots=${this.size()}`, `capacity=${this.capacity}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            size: this.size(),
            capacity: this.capacity,
            history: [...this.history]
        };
    }
}

/* =============================================================================
 * Memory Transaction Manager
 * =============================================================================
 */

export class MemoryTransactionManager<T = unknown> {

    private readonly transactions = new Map<string, MemoryTransaction>();

    private readonly stack: MemoryTransaction[] = [];

    private readonly snapshots: MemorySnapshotManager<T>;

    constructor(snapshots: MemorySnapshotManager<T>) {
        this.snapshots = snapshots;
    }

    begin(description = "Transaction"): MemoryTransaction {
        const transaction: MemoryTransaction = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            description,
            operations: [],
            committed: false
        };

        this.transactions.set(transaction.id, transaction);
        this.stack.push(transaction);
        return transaction;
    }

    current(): MemoryTransaction | undefined {
        return this.stack.at(-1);
    }

    inTransaction(): boolean {
        return this.stack.length > 0;
    }

    record(operation: string): void {
        const tx = this.current();
        if (!tx) {
            throw new Error("No active transaction.");
        }
        tx.operations.push(operation);
    }

    commit(store: MemoryStore<T>): MemoryTransaction {
        const tx = this.current();
        if (!tx) {
            throw new Error("No active transaction.");
        }
        this.snapshots.create(store);
        tx.committed = true;
        this.stack.pop();
        return tx;
    }

    rollback(): MemorySnapshot<T> | undefined {
        const tx = this.current();
        if (!tx) {
            return undefined;
        }
        this.stack.pop();
        return this.snapshots.latest();
    }

    get(id: string): MemoryTransaction | undefined {
        return this.transactions.get(id);
    }

    history(): MemoryTransaction[] {
        return Array.from(this.transactions.values());
    }

    clear(): void {
        this.transactions.clear();
        this.stack.length = 0;
    }

    totalTransactions(): number {
        return this.transactions.size;
    }

    activeTransactions(): number {
        return this.stack.length;
    }

    committedTransactions(): number {
        let total = 0;
        for (const tx of this.transactions.values()) {
            if (tx.committed) {
                total++;
            }
        }
        return total;
    }

    describe(): string {
        return [
            "MemoryTransactionManager",
            `transactions=${this.totalTransactions()}`,
            `active=${this.activeTransactions()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            total: this.totalTransactions(),
            active: this.activeTransactions(),
            committed: this.committedTransactions(),
            stack: this.stack.map(tx => tx.id)
        };
    }
}

/* =============================================================================
 * Memory Search Engine
 * =============================================================================
 */

export class MemorySearchEngine<T = unknown> {

    private readonly store: MemoryStore<T>;

    private readonly index: MemoryIndex<T>;

    constructor(store: MemoryStore<T>, index: MemoryIndex<T>) {
        this.store = store;
        this.index = index;
    }

    byId(id: MemoryId): MemoryNode<T> | undefined {
        return this.store.get(id);
    }

    byType(type: MemoryType): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const id of this.index.byType(type)) {
            const node = this.store.get(id);
            if (node) {
                results.push(node);
            }
        }
        return results;
    }

    byState(state: MemoryState): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const id of this.index.byState(state)) {
            const node = this.store.get(id);
            if (node) {
                results.push(node);
            }
        }
        return results;
    }

    byPriority(priority: MemoryPriority): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const id of this.index.byPriority(priority)) {
            const node = this.store.get(id);
            if (node) {
                results.push(node);
            }
        }
        return results;
    }

    byTag(tag: MemoryTag): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const id of this.index.byTag(tag)) {
            const node = this.store.get(id);
            if (node) {
                results.push(node);
            }
        }
        return results;
    }

    byLabel(label: MemoryLabel): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const id of this.index.byLabel(label)) {
            const node = this.store.get(id);
            if (node) {
                results.push(node);
            }
        }
        return results;
    }

    where(predicate: (node: MemoryNode<T>) => boolean): MemoryNode<T>[] {
        return this.store.filter(predicate);
    }

    first(predicate: (node: MemoryNode<T>) => boolean): MemoryNode<T> | undefined {
        return this.store.find(predicate);
    }

    exists(predicate: (node: MemoryNode<T>) => boolean): boolean {
        return this.store.some(predicate);
    }

    count(predicate?: (node: MemoryNode<T>) => boolean): number {
        if (!predicate) {
            return this.store.size();
        }
        return this.where(predicate).length;
    }

    query(query: MemoryQuery): MemoryNode<T>[] {
        let results = this.store.toArray();

        if (query.type !== undefined) {
            results = results.filter(node => node.getType() === query.type);
        }

        if (query.state !== undefined) {
            results = results.filter(node => node.getState() === query.state);
        }

        if (query.priority !== undefined) {
            results = results.filter(node => node.getPriority() === query.priority);
        }

        if (query.minimumConfidence !== undefined) {
            results = results.filter(node => node.getConfidence() >= query.minimumConfidence!);
        }

        if (query.minimumImportance !== undefined) {
            results = results.filter(node => node.getImportance() >= query.minimumImportance!);
        }

        return results;
    }

    describe(): string {
        return "MemorySearchEngine";
    }

    inspect(): Dictionary {
        return {
            indexed: this.index.size(),
            nodes: this.store.size()
        };
    }
}

/* =============================================================================
 * Memory Ranking Engine
 * =============================================================================
 */

export class MemoryRankingEngine<T = unknown> {

    private confidenceWeight = 0.35;
    private importanceWeight = 0.30;
    private recencyWeight = 0.20;
    private accessWeight = 0.15;

    constructor() {}

    setWeights(weights: Partial<{
        confidence: number;
        importance: number;
        recency: number;
        access: number;
    }>): this {
        if (weights.confidence !== undefined) {
            this.confidenceWeight = weights.confidence;
        }
        if (weights.importance !== undefined) {
            this.importanceWeight = weights.importance;
        }
        if (weights.recency !== undefined) {
            this.recencyWeight = weights.recency;
        }
        if (weights.access !== undefined) {
            this.accessWeight = weights.access;
        }
        return this;
    }

    confidenceScore(node: MemoryNode<T>): number {
        return node.getConfidence();
    }

    importanceScore(node: MemoryNode<T>): number {
        return node.getImportance();
    }

    recencyScore(node: MemoryNode<T>): number {
        const age = Date.now() - node.updatedAt;
        const days = age / 86400000;
        return 1 / (1 + days);
    }

    accessScore(node: MemoryNode<T>): number {
        return Math.min(node.getAccessCount() / 100, 1);
    }

    score(node: MemoryNode<T>): number {
        return (
            this.confidenceScore(node) * this.confidenceWeight +
            this.importanceScore(node) * this.importanceWeight +
            this.recencyScore(node) * this.recencyWeight +
            this.accessScore(node) * this.accessWeight
        );
    }

    rank(nodes: Iterable<MemoryNode<T>>): MemorySearchResult<T>[] {
        const results: MemorySearchResult<T>[] = [];

        for (const node of nodes) {
            results.push({
                entry: node.serialize(),
                score: this.score(node),
                matchedFields: [],
                reason: "Composite ranking"
            });
        }

        results.sort((a, b) => b.score - a.score);
        return results;
    }

    top(nodes: Iterable<MemoryNode<T>>, limit = 10): MemorySearchResult<T>[] {
        return this.rank(nodes).slice(0, limit);
    }

    best(nodes: Iterable<MemoryNode<T>>): MemorySearchResult<T> | undefined {
        return this.top(nodes, 1)[0];
    }

    describe(): string {
        return [
            "MemoryRankingEngine",
            `weights=[${this.confidenceWeight},${this.importanceWeight},${this.recencyWeight},${this.accessWeight}]`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            confidenceWeight: this.confidenceWeight,
            importanceWeight: this.importanceWeight,
            recencyWeight: this.recencyWeight,
            accessWeight: this.accessWeight
        };
    }
}

/* =============================================================================
 * Memory Consolidator
 * =============================================================================
 */

export class MemoryConsolidator<T = unknown> {

    private similarityThreshold = 0.90;

    private consolidations = 0;

    constructor() {}

    setSimilarityThreshold(threshold: number): this {
        if (threshold < 0 || threshold > 1) {
            throw new RangeError("Similarity threshold must be between 0 and 1.");
        }
        this.similarityThreshold = threshold;
        return this;
    }

    similarity(first: MemoryNode<T>, second: MemoryNode<T>): number {
        if (first.contentEquals(second)) {
            return 1;
        }

        let score = 0;

        if (first.getType() === second.getType()) {
            score += 0.30;
        }

        if (first.getState() === second.getState()) {
            score += 0.10;
        }

        const sharedTags = first.getTags().filter(tag => second.getTags().includes(tag)).length;
        const maxTags = Math.max(first.getTags().length, second.getTags().length, 1);
        score += (sharedTags / maxTags) * 0.30;

        const sharedLabels = first.getLabels().filter(label => second.getLabels().includes(label)).length;
        const maxLabels = Math.max(first.getLabels().length, second.getLabels().length, 1);
        score += (sharedLabels / maxLabels) * 0.30;

        return Math.min(score, 1);
    }

    isDuplicate(first: MemoryNode<T>, second: MemoryNode<T>): boolean {
        return this.similarity(first, second) >= this.similarityThreshold;
    }

    findDuplicates(store: MemoryStore<T>): Array<[MemoryNode<T>, MemoryNode<T>]> {
        const duplicates: Array<[MemoryNode<T>, MemoryNode<T>]> = [];
        const nodes = store.toArray();

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                if (this.isDuplicate(nodes[i], nodes[j])) {
                    duplicates.push([nodes[i], nodes[j]]);
                }
            }
        }

        return duplicates;
    }

    consolidate(store: MemoryStore<T>): number {
        const duplicates = this.findDuplicates(store);

        for (const [primary, duplicate] of duplicates) {
            primary.merge(duplicate);
            store.remove(duplicate.getId());
            this.consolidations++;
        }

        return duplicates.length;
    }

    consolidationCount(): number {
        return this.consolidations;
    }

    threshold(): number {
        return this.similarityThreshold;
    }

    reset(): void {
        this.consolidations = 0;
    }

    describe(): string {
        return [
            "MemoryConsolidator",
            `threshold=${this.similarityThreshold}`,
            `consolidations=${this.consolidations}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            threshold: this.similarityThreshold,
            consolidations: this.consolidations
        };
    }
}

/* =============================================================================
 * Memory Conflict Resolver
 * =============================================================================
 */

export class MemoryConflictResolver<T = unknown> {

    private strategy: MemoryConflictStrategy = MemoryConflictStrategy.Merge;

    private resolved = 0;

    constructor(strategy: MemoryConflictStrategy = MemoryConflictStrategy.Merge) {
        this.strategy = strategy;
    }

    getStrategy(): MemoryConflictStrategy {
        return this.strategy;
    }

    setStrategy(strategy: MemoryConflictStrategy): this {
        this.strategy = strategy;
        return this;
    }

    resolve(first: MemoryNode<T>, second: MemoryNode<T>): MemoryNode<T> {
        switch (this.strategy) {
            case MemoryConflictStrategy.Ignore:
                return first;

            case MemoryConflictStrategy.Replace:
                this.resolved++;
                return second;

            case MemoryConflictStrategy.HighestConfidence:
                this.resolved++;
                return first.getConfidence() >= second.getConfidence() ? first : second;

            case MemoryConflictStrategy.LatestVersion:
                this.resolved++;
                return first.version >= second.version ? first : second;

            case MemoryConflictStrategy.Merge:
                first.merge(second);
                this.resolved++;
                return first;

            case MemoryConflictStrategy.Manual:
                throw new Error("Manual conflict resolution required.");

            default:
                throw new Error("Unsupported conflict strategy.");
        }
    }

    resolveAll(conflicts: Array<[MemoryNode<T>, MemoryNode<T>]>): MemoryNode<T>[] {
        const results: MemoryNode<T>[] = [];
        for (const [first, second] of conflicts) {
            results.push(this.resolve(first, second));
        }
        return results;
    }

    resolutionCount(): number {
        return this.resolved;
    }

    reset(): void {
        this.resolved = 0;
    }

    describe(): string {
        return ["MemoryConflictResolver", `strategy=${this.strategy}`, `resolved=${this.resolved}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            strategy: this.strategy,
            resolved: this.resolved
        };
    }
}

/* =============================================================================
 * Memory Retention Policy
 * =============================================================================
 */

export class MemoryRetentionPolicy<T = unknown> {

    private workingMemoryTTL = 60 * 60 * 1000;
    private shortTermTTL = 24 * 60 * 60 * 1000;
    private longTermTTL = 365 * 24 * 60 * 60 * 1000;
    private archiveAfter = 30 * 24 * 60 * 60 * 1000;
    private deleteAfter = 365 * 24 * 60 * 60 * 1000;

    private archived = 0;
    private expired = 0;
    private deleted = 0;

    constructor() {}

    setWorkingMemoryTTL(milliseconds: number): this {
        this.workingMemoryTTL = milliseconds;
        return this;
    }

    setShortTermTTL(milliseconds: number): this {
        this.shortTermTTL = milliseconds;
        return this;
    }

    setLongTermTTL(milliseconds: number): this {
        this.longTermTTL = milliseconds;
        return this;
    }

    setArchiveAfter(milliseconds: number): this {
        this.archiveAfter = milliseconds;
        return this;
    }

    setDeleteAfter(milliseconds: number): this {
        this.deleteAfter = milliseconds;
        return this;
    }

    private age(node: MemoryNode<T>): number {
        return Date.now() - node.updatedAt;
    }

    isExpired(node: MemoryNode<T>): boolean {
        const age = this.age(node);

        switch (node.getType()) {
            case MemoryType.Working:
                return age > this.workingMemoryTTL;
            case MemoryType.ShortTerm:
                return age > this.shortTermTTL;
            case MemoryType.LongTerm:
                return age > this.longTermTTL;
            default:
                return false;
        }
    }

    shouldArchive(node: MemoryNode<T>): boolean {
        return this.age(node) > this.archiveAfter;
    }

    shouldDelete(node: MemoryNode<T>): boolean {
        return this.age(node) > this.deleteAfter;
    }

    evaluate(node: MemoryNode<T>): MemoryLifecycle {
        if (this.shouldDelete(node)) {
            this.deleted++;
            return MemoryLifecycle.Deleted;
        }

        if (this.shouldArchive(node)) {
            this.archived++;
            return MemoryLifecycle.Archived;
        }

        if (this.isExpired(node)) {
            this.expired++;
            return MemoryLifecycle.Consolidated;
        }

        return MemoryLifecycle.Active;
    }

    evaluateStore(store: MemoryStore<T>): Map<MemoryId, MemoryLifecycle> {
        const results = new Map<MemoryId, MemoryLifecycle>();
        for (const [id, node] of store) {
            results.set(id, this.evaluate(node));
        }
        return results;
    }

    archivedCount(): number {
        return this.archived;
    }

    expiredCount(): number {
        return this.expired;
    }

    deletedCount(): number {
        return this.deleted;
    }

    reset(): void {
        this.archived = 0;
        this.expired = 0;
        this.deleted = 0;
    }

    describe(): string {
        return [
            "MemoryRetentionPolicy",
            `expired=${this.expired}`,
            `archived=${this.archived}`,
            `deleted=${this.deleted}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            workingTTL: this.workingMemoryTTL,
            shortTermTTL: this.shortTermTTL,
            longTermTTL: this.longTermTTL,
            archiveAfter: this.archiveAfter,
            deleteAfter: this.deleteAfter,
            expired: this.expired,
            archived: this.archived,
            deleted: this.deleted
        };
    }
}

/* =============================================================================
 * Memory Archive
 * =============================================================================
 */

export class MemoryArchive<T = unknown> {

    private readonly archivedNodes = new Map<MemoryId, MemoryEntry<T>>();

    private readonly archivedSnapshots = new Map<string, MemorySnapshot<T>>();

    private archiveOperations = 0;
    private restoreOperations = 0;

    constructor() {}

    archiveNode(node: MemoryNode<T>): this {
        this.archivedNodes.set(node.getId(), node.serialize());
        this.archiveOperations++;
        return this;
    }

    archiveNodes(nodes: Iterable<MemoryNode<T>>): this {
        for (const node of nodes) {
            this.archiveNode(node);
        }
        return this;
    }

    archiveSnapshot(snapshot: MemorySnapshot<T>): this {
        this.archivedSnapshots.set(snapshot.id, structuredClone(snapshot));
        this.archiveOperations++;
        return this;
    }

    restoreNode(id: MemoryId): MemoryNode<T> | undefined {
        const entry = this.archivedNodes.get(id);
        if (!entry) {
            return undefined;
        }
        this.restoreOperations++;
        return new MemoryNode(structuredClone(entry));
    }

    restoreSnapshot(id: string): MemorySnapshot<T> | undefined {
        const snapshot = this.archivedSnapshots.get(id);
        if (!snapshot) {
            return undefined;
        }
        this.restoreOperations++;
        return structuredClone(snapshot);
    }

    removeNode(id: MemoryId): boolean {
        return this.archivedNodes.delete(id);
    }

    removeSnapshot(id: string): boolean {
        return this.archivedSnapshots.delete(id);
    }

    clear(): void {
        this.archivedNodes.clear();
        this.archivedSnapshots.clear();
    }

    export(): MemoryExport<T> {
        return {
            formatVersion: MEMORY_FORMAT_VERSION,
            exportedAt: Date.now(),
            entries: Array.from(this.archivedNodes.values())
        };
    }

    import(archive: MemoryImport<T>): number {
        let count = 0;
        for (const entry of archive.entries) {
            this.archivedNodes.set(entry.id, structuredClone(entry));
            count++;
        }
        return count;
    }

    nodeCount(): number {
        return this.archivedNodes.size;
    }

    snapshotCount(): number {
        return this.archivedSnapshots.size;
    }

    isEmpty(): boolean {
        return this.archivedNodes.size === 0 && this.archivedSnapshots.size === 0;
    }

    archiveCount(): number {
        return this.archiveOperations;
    }

    restoreCount(): number {
        return this.restoreOperations;
    }

    describe(): string {
        return ["MemoryArchive", `nodes=${this.nodeCount()}`, `snapshots=${this.snapshotCount()}`].join(", ");
    }

    inspect(): Dictionary {
        return {
            archivedNodes: this.nodeCount(),
            archivedSnapshots: this.snapshotCount(),
            archiveOperations: this.archiveOperations,
            restoreOperations: this.restoreOperations
        };
    }
}

/* =============================================================================
 * Memory Diagnostics
 * =============================================================================
 */

export class MemoryDiagnostics<T = unknown> {

    private checks = 0;
    private failures = 0;

    constructor() {}

    validateStore(store: MemoryStore<T>): boolean {
        this.checks++;
        let valid = true;
        for (const [, node] of store) {
            if (!node.validate()) {
                valid = false;
            }
        }
        if (!valid) {
            this.failures++;
        }
        return valid;
    }

    validateIndex(store: MemoryStore<T>, index: MemoryIndex<T>): boolean {
        this.checks++;
        for (const [, node] of store) {
            if (!index.byType(node.getType()).has(node.getId())) {
                this.failures++;
                return false;
            }
        }
        return true;
    }

    validateGraph(graph: MemoryGraph<T>): boolean {
        this.checks++;
        return graph.nodes() >= 0 && graph.edges() >= 0;
    }

    validateCache(cache: MemoryCache<T>): boolean {
        this.checks++;
        return cache.size() <= cache.capacityLimit();
    }

    validateSnapshots(snapshots: MemorySnapshotManager<T>): boolean {
        this.checks++;
        return snapshots.size() >= 0;
    }

    validateArchive(archive: MemoryArchive<T>): boolean {
        this.checks++;
        return archive.nodeCount() >= 0;
    }

    runAll(
        store: MemoryStore<T>,
        index: MemoryIndex<T>,
        graph: MemoryGraph<T>,
        cache: MemoryCache<T>,
        snapshots: MemorySnapshotManager<T>,
        archive: MemoryArchive<T>
    ): boolean {
        return (
            this.validateStore(store) &&
            this.validateIndex(store, index) &&
            this.validateGraph(graph) &&
            this.validateCache(cache) &&
            this.validateSnapshots(snapshots) &&
            this.validateArchive(archive)
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
            "MemoryDiagnostics",
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
 * Memory Manager
 * =============================================================================
 */

export class MemoryManager<T = unknown> {

    private readonly store: MemoryStore<T>;
    private readonly index: MemoryIndex<T>;
    private readonly graph: MemoryGraph<T>;
    private readonly cache: MemoryCache<T>;
    private readonly snapshots: MemorySnapshotManager<T>;
    private readonly transactions: MemoryTransactionManager<T>;
    private readonly searchEngine: MemorySearchEngine<T>;
    private readonly ranking: MemoryRankingEngine<T>;
    private readonly consolidator: MemoryConsolidator<T>;
    private readonly conflicts: MemoryConflictResolver<T>;
    private readonly retention: MemoryRetentionPolicy<T>;
    private readonly archive: MemoryArchive<T>;
    private readonly diagnostics: MemoryDiagnostics<T>;

    constructor(configuration?: Partial<MemoryConfiguration>) {
        this.store = new MemoryStore<T>(configuration);
        this.index = new MemoryIndex<T>();
        this.graph = new MemoryGraph<T>();
        this.cache = new MemoryCache<T>();
        this.snapshots = new MemorySnapshotManager<T>();
        this.transactions = new MemoryTransactionManager<T>(this.snapshots);
        this.searchEngine = new MemorySearchEngine<T>(this.store, this.index);
        this.ranking = new MemoryRankingEngine<T>();
        this.consolidator = new MemoryConsolidator<T>();
        this.conflicts = new MemoryConflictResolver<T>();
        this.retention = new MemoryRetentionPolicy<T>();
        this.archive = new MemoryArchive<T>();
        this.diagnostics = new MemoryDiagnostics<T>();
    }

    add(node: MemoryNode<T>): this {
        this.store.add(node);
        this.index.add(node);
        return this;
    }

    get(id: MemoryId): MemoryNode<T> | undefined {
        const cached = this.cache.get(id);
        if (cached) {
            return cached;
        }

        const node = this.store.get(id);
        if (node) {
            this.cache.put(id, node);
        }

        return node;
    }

    remove(id: MemoryId): boolean {
        this.cache.remove(id);

        const node = this.store.get(id);
        if (node) {
            this.index.remove(node);
        }

        this.graph.removeNode(id);
        return this.store.remove(id);
    }

    searchByType(type: MemoryType) {
        return this.searchEngine.byType(type);
    }

    search(query: MemoryQuery) {
        return this.searchEngine.query(query);
    }

    rank(nodes: Iterable<MemoryNode<T>>) {
        return this.ranking.rank(nodes);
    }

    consolidate(): number {
        return this.consolidator.consolidate(this.store);
    }

    evaluateRetention(): Map<MemoryId, MemoryLifecycle> {
        return this.retention.evaluateStore(this.store);
    }

    snapshot(label?: string) {
        return this.snapshots.create(this.store, label);
    }

    validate(): boolean {
        return this.diagnostics.runAll(
            this.store,
            this.index,
            this.graph,
            this.cache,
            this.snapshots,
            this.archive
        );
    }

    getStore() {
        return this.store;
    }

    getIndex() {
        return this.index;
    }

    getGraph() {
        return this.graph;
    }

    getArchive() {
        return this.archive;
    }

    getSearchEngine() {
        return this.searchEngine;
    }

    getRankingEngine() {
        return this.ranking;
    }

    describe(): string {
        return [
            "MemoryManager",
            `nodes=${this.store.size()}`,
            `cache=${this.cache.size()}`,
            `snapshots=${this.snapshots.size()}`
        ].join(", ");
    }

    inspect(): Dictionary {
        return {
            store: this.store.inspect(),
            index: this.index.inspect(),
            graph: this.graph.inspect(),
            cache: this.cache.inspect(),
            snapshots: this.snapshots.inspect(),
            archive: this.archive.inspect(),
            diagnostics: this.diagnostics.inspect()
        };
    }
}