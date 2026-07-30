/**
 * =============================================================================
 * Hexical AI
 * recommendation.ts
 * =============================================================================
 *
 * Recommendation Decision Engine
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 * This engine does NOT tell developers what changed (that is semantic.ts),
 * does NOT estimate impact (that is impact.ts), and does NOT explain runtime
 * behavior (that is behavior.ts).
 *
 * This module answers: "Given everything we know, what should happen next?"
 * =============================================================================
 */

import { SeverityResult } from "./severity";
import { SemanticInsight } from "./semantic";
import { ImpactReport } from "./impact";
import { BehaviorReport } from "./behavior";

/* =============================================================================
 * Shared Helpers
 * =============================================================================
 */

/**
 * Clamps a number into [min, max]. NaN is treated as `min` rather than
 * propagating — recommendations are frequently produced by third-party rule
 * plugins and must never be trusted to hand back well-formed numbers.
 */
function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, value));
}

/* =============================================================================
 * Recommendation Priorities
 * =============================================================================
 */

export enum RecommendationPriority {
    INFORMATIONAL = 0,
    LOW = 1,
    MEDIUM = 2,
    HIGH = 3,
    CRITICAL = 4
}

const RECOMMENDATION_PRIORITY_VALUES: ReadonlySet<number> = new Set(
    Object.values(RecommendationPriority).filter(
        (value): value is number => typeof value === "number"
    )
);

/* =============================================================================
 * Recommendation Categories
 * =============================================================================
 */

export enum RecommendationCategory {
    CODE_REVIEW = "CODE_REVIEW",
    TESTING = "TESTING",
    SECURITY = "SECURITY",
    DEPLOYMENT = "DEPLOYMENT",
    ROLLBACK = "ROLLBACK",
    PERFORMANCE = "PERFORMANCE",
    ARCHITECTURE = "ARCHITECTURE",
    MAINTAINABILITY = "MAINTAINABILITY",
    DOCUMENTATION = "DOCUMENTATION",
    COMPLIANCE = "COMPLIANCE",
    OBSERVABILITY = "OBSERVABILITY",
    REFACTORING = "REFACTORING",
    API = "API",
    DATABASE = "DATABASE",
    USER_EXPERIENCE = "USER_EXPERIENCE",
    UNKNOWN = "UNKNOWN"
}

const RECOMMENDATION_CATEGORY_VALUES: ReadonlySet<string> = new Set(
    Object.values(RecommendationCategory)
);

/* =============================================================================
 * Evidence
 * =============================================================================
 */

export interface RecommendationEvidence {
    id: string;
    source:
        | "severity"
        | "semantic"
        | "impact"
        | "behavior"
        | "rule"
        | "heuristic"
        | "future-ai";
    title: string;
    description: string;
    confidence: number;
    weight: number;
    metadata?: Record<string, unknown>;
}

/* =============================================================================
 * Recommendation
 * =============================================================================
 */

export interface Recommendation {
    id: string;
    category: RecommendationCategory;
    priority: RecommendationPriority;
    title: string;
    summary: string;
    rationale: string;
    confidence: number;
    estimatedRiskReduction: number;
    estimatedEngineeringCost: number;
    automated: boolean;
    blocking: boolean;
    evidence: RecommendationEvidence[];
    actions: RecommendationAction[];
    metadata?: Record<string, unknown>;
}

/* =============================================================================
 * Action
 * =============================================================================
 */

export interface RecommendationAction {
    id: string;
    title: string;
    description: string;
    optional: boolean;
    completed: boolean;
}

/* =============================================================================
 * Reviewer
 * =============================================================================
 */

export interface ReviewerSuggestion {
    role:
        | "Backend"
        | "Frontend"
        | "Security"
        | "DevOps"
        | "QA"
        | "Database"
        | "Platform"
        | "AI"
        | "Architect"
        | "General";
    reason: string;
    priority: RecommendationPriority;
}

/* =============================================================================
 * Recommendation Context
 * =============================================================================
 */

export interface RecommendationContext {
    severity: SeverityResult;
    semantic: SemanticInsight;
    impact: ImpactReport;
    behavior: BehaviorReport;
    timestamp: number;
    projectName?: string;
    branch?: string;
    commit?: string;
    metadata?: Record<string, unknown>;
}

/* =============================================================================
 * Engine Configuration
 * =============================================================================
 */

export interface RecommendationEngineConfig {
    minimumConfidence: number;
    enableSecurityRecommendations: boolean;
    enableDeploymentRecommendations: boolean;
    enableRollbackPlanning: boolean;
    enableReviewerSuggestions: boolean;
    enableObservabilitySuggestions: boolean;
    enableArchitectureSuggestions: boolean;
    strictMode: boolean;
    /**
     * Hard ceiling on how many recommendations a single rule may contribute
     * to one `generate()` call. Protects the pipeline from a runaway or
     * malicious/misbehaving rule flooding memory and downstream consumers.
     * Defaults to 500 in `DEFAULT_RECOMMENDATION_CONFIG`.
     */
    maxRecommendationsPerRule: number;
}

/* =============================================================================
 * Default Configuration
 * =============================================================================
 */

export const DEFAULT_RECOMMENDATION_CONFIG: RecommendationEngineConfig = Object.freeze({
    minimumConfidence: 0.65,
    enableSecurityRecommendations: true,
    enableDeploymentRecommendations: true,
    enableRollbackPlanning: true,
    enableReviewerSuggestions: true,
    enableObservabilitySuggestions: true,
    enableArchitectureSuggestions: true,
    strictMode: false,
    maxRecommendationsPerRule: 500
});

/* =============================================================================
 * Engine Diagnostics
 * =============================================================================
 */

export interface RecommendationDiagnostics {
    startedAt: number;
    finishedAt: number;
    executionTime: number;
    evaluatedRules: number;
    skippedRules: number;
    generatedRecommendations: number;
    discardedRecommendations: number;
    warnings: string[];
    errors: string[];
}

/* =============================================================================
 * Recommendation Rule
 * =============================================================================
 */

export interface RecommendationRule {
    /** Globally unique rule identifier. */
    id: string;
    /** Human readable rule name. */
    name: string;
    /** Short explanation of what this rule detects. */
    description: string;
    /** Version of the rule. */
    version: string;
    /** Whether this rule is enabled. */
    enabled: boolean;
    /** Higher values execute first. */
    priority: number;
    /** Categories this rule belongs to. */
    categories: RecommendationCategory[];
    /** Execute rule. */
    evaluate(context: RecommendationContext): Recommendation[];
}

/* =============================================================================
 * Rule Result
 * =============================================================================
 */

export interface RuleExecutionResult {
    ruleId: string;
    executed: boolean;
    executionTime: number;
    recommendations: Recommendation[];
    warnings: string[];
    errors: string[];
}

/* =============================================================================
 * Rule Registry
 * =============================================================================
 */

export class RecommendationRuleRegistry {

    private readonly rules = new Map<string, RecommendationRule>();

    register(rule: RecommendationRule): void {
        if (this.rules.has(rule.id)) {
            throw new Error(`Rule '${rule.id}' already registered.`);
        }
        this.rules.set(rule.id, rule);
    }

    unregister(id: string): boolean {
        return this.rules.delete(id);
    }

    has(id: string): boolean {
        return this.rules.has(id);
    }

    clear(): void {
        this.rules.clear();
    }

    getRules(): RecommendationRule[] {
        return [...this.rules.values()]
            .filter(rule => rule.enabled)
            .sort((a, b) => b.priority - a.priority);
    }
}

/* =============================================================================
 * Recommendation Report
 * =============================================================================
 */

export interface RecommendationReport {
    recommendations: Recommendation[];
    diagnostics: RecommendationDiagnostics;
}

/* =============================================================================
 * Recommendation Engine
 * =============================================================================
 */

export class RecommendationEngine {

    private readonly registry = new RecommendationRuleRegistry();

    private readonly deduplicator = new RecommendationDeduplicator();

    private readonly conflictResolver = new RecommendationConflictResolver();

    private readonly ranker = new RecommendationRanker();

    private readonly config: RecommendationEngineConfig;

    constructor(config: RecommendationEngineConfig = DEFAULT_RECOMMENDATION_CONFIG) {
        this.assertValidConfig(config);
        // Freeze a private copy so mutating the object passed in (or the
        // shared DEFAULT_RECOMMENDATION_CONFIG) after construction can never
        // change this engine's behavior out from under its owner.
        this.config = Object.freeze({ ...config });
    }

    private assertValidConfig(config: RecommendationEngineConfig): void {
        if (config.minimumConfidence < 0 || config.minimumConfidence > 1) {
            throw new RangeError("minimumConfidence must be between 0 and 1.");
        }
        if (!Number.isFinite(config.maxRecommendationsPerRule) || config.maxRecommendationsPerRule <= 0) {
            throw new RangeError("maxRecommendationsPerRule must be a positive finite number.");
        }
    }

    registerRule(rule: RecommendationRule): void {
        this.registry.register(rule);
    }

    unregisterRule(id: string): void {
        this.registry.unregister(id);
    }

    getRules(): RecommendationRule[] {
        return this.registry.getRules();
    }

    /**
     * Runtime shape/sanity check for a value produced by a `RecommendationRule`.
     * Rules are effectively plugins — TypeScript's compile-time types are
     * erased at runtime, so a buggy or hostile rule can hand back anything.
     * Nothing downstream should ever operate on an unvalidated recommendation.
     */
    private isValidRecommendation(value: unknown): value is Recommendation {
        if (!value || typeof value !== "object") {
            return false;
        }

        const candidate = value as Partial<Recommendation>;

        return (
            typeof candidate.id === "string" && candidate.id.length > 0 &&
            typeof candidate.title === "string" && candidate.title.length > 0 &&
            typeof candidate.category === "string" &&
            RECOMMENDATION_CATEGORY_VALUES.has(candidate.category) &&
            typeof candidate.priority === "number" &&
            RECOMMENDATION_PRIORITY_VALUES.has(candidate.priority) &&
            typeof candidate.confidence === "number" &&
            typeof candidate.estimatedRiskReduction === "number" &&
            typeof candidate.estimatedEngineeringCost === "number" &&
            typeof candidate.automated === "boolean" &&
            typeof candidate.blocking === "boolean" &&
            Array.isArray(candidate.evidence) &&
            Array.isArray(candidate.actions)
        );
    }

    /**
     * Clamps numeric fields into their valid ranges. Rules should not be
     * trusted to self-police confidence/cost bounds.
     */
    private sanitize(recommendation: Recommendation): Recommendation {
        return {
            ...recommendation,
            confidence: clamp(recommendation.confidence, 0, 1),
            estimatedRiskReduction: Math.max(0, recommendation.estimatedRiskReduction),
            estimatedEngineeringCost: Math.max(0, recommendation.estimatedEngineeringCost)
        };
    }

    private isCategoryEnabled(category: RecommendationCategory): boolean {
        switch (category) {
            case RecommendationCategory.SECURITY:
                return this.config.enableSecurityRecommendations;
            case RecommendationCategory.DEPLOYMENT:
                return this.config.enableDeploymentRecommendations;
            case RecommendationCategory.ROLLBACK:
                return this.config.enableRollbackPlanning;
            case RecommendationCategory.OBSERVABILITY:
                return this.config.enableObservabilitySuggestions;
            case RecommendationCategory.ARCHITECTURE:
                return this.config.enableArchitectureSuggestions;
            default:
                return true;
        }
    }

    private isRuleEnabled(rule: RecommendationRule): boolean {
        if (rule.categories.length === 0) {
            return true;
        }
        return rule.categories.some(category => this.isCategoryEnabled(category));
    }

    generate(context: RecommendationContext): RecommendationReport {
        const diagnostics: RecommendationDiagnostics = {
            startedAt: performance.now(),
            finishedAt: 0,
            executionTime: 0,
            evaluatedRules: 0,
            skippedRules: 0,
            generatedRecommendations: 0,
            discardedRecommendations: 0,
            warnings: [],
            errors: []
        };

        const collected: Recommendation[] = [];

        for (const rule of this.registry.getRules()) {

            if (!this.isRuleEnabled(rule)) {
                diagnostics.skippedRules++;
                continue;
            }

            diagnostics.evaluatedRules++;

            const started = performance.now();

            try {
                const result = rule.evaluate(context);

                if (!Array.isArray(result)) {
                    diagnostics.warnings.push(
                        `Rule '${rule.name}' returned a non-array result and was ignored.`
                    );
                } else {
                    const capped = result.length > this.config.maxRecommendationsPerRule;
                    const usable = capped
                        ? result.slice(0, this.config.maxRecommendationsPerRule)
                        : result;

                    if (capped) {
                        diagnostics.warnings.push(
                            `Rule '${rule.name}' produced ${result.length} recommendations; ` +
                            `truncated to ${this.config.maxRecommendationsPerRule}.`
                        );
                        diagnostics.discardedRecommendations += result.length - usable.length;
                    }

                    for (const candidate of usable) {
                        if (!this.isValidRecommendation(candidate)) {
                            diagnostics.warnings.push(
                                `Rule '${rule.name}' produced a malformed recommendation; discarded.`
                            );
                            diagnostics.discardedRecommendations++;
                            continue;
                        }
                        collected.push(this.sanitize(candidate));
                    }
                }
            } catch (error) {
                if (this.config.strictMode) {
                    throw error;
                }
                diagnostics.errors.push(error instanceof Error ? error.message : String(error));
            }

            const elapsed = performance.now() - started;
            if (elapsed > 25) {
                diagnostics.warnings.push(`Rule '${rule.name}' is slow (${elapsed.toFixed(2)}ms).`);
            }
        }

        const deduplicated = this.deduplicator.deduplicate(collected);
        const resolved = this.conflictResolver.resolve(deduplicated);

        const accepted: Recommendation[] = [];
        for (const recommendation of resolved) {
            if (recommendation.confidence < this.config.minimumConfidence) {
                diagnostics.discardedRecommendations++;
                continue;
            }
            accepted.push(recommendation);
        }

        const ranked = this.ranker.rank(accepted);

        diagnostics.finishedAt = performance.now();
        diagnostics.executionTime = diagnostics.finishedAt - diagnostics.startedAt;
        diagnostics.generatedRecommendations = ranked.length;

        return {
            recommendations: ranked,
            diagnostics
        };
    }
}

/* =============================================================================
 * Evidence Aggregator
 * =============================================================================
 */

export class RecommendationEvidenceEngine {

    /**
     * Merge duplicated evidence.
     *
     * Grouped by (source, title) using nested Maps rather than a
     * `${source}:${title}` string key — a string key is vulnerable to
     * delimiter-collision spoofing (e.g. source "x", title "foo:bar" collides
     * with source "x:foo", title "bar"), which would let attacker-supplied
     * evidence silently merge into and inflate the confidence of unrelated,
     * legitimate evidence.
     */
    mergeEvidence(evidence: RecommendationEvidence[]): RecommendationEvidence[] {
        const bySource = new Map<string, Map<string, RecommendationEvidence>>();

        for (const item of evidence) {
            let byTitle = bySource.get(item.source);
            if (!byTitle) {
                byTitle = new Map();
                bySource.set(item.source, byTitle);
            }

            const existing = byTitle.get(item.title);

            if (!existing) {
                byTitle.set(item.title, { ...item });
                continue;
            }

            existing.weight += item.weight;
            existing.confidence = Math.max(existing.confidence, item.confidence);
            existing.metadata = { ...existing.metadata, ...item.metadata };
        }

        const merged: RecommendationEvidence[] = [];
        for (const byTitle of bySource.values()) {
            merged.push(...byTitle.values());
        }
        return merged;
    }

    /**
     * Calculate overall evidence confidence.
     */
    calculateConfidence(evidence: RecommendationEvidence[]): number {
        if (!evidence.length) {
            return 0;
        }

        let weightedScore = 0;
        let totalWeight = 0;

        for (const item of evidence) {
            weightedScore += item.confidence * item.weight;
            totalWeight += item.weight;
        }

        if (totalWeight <= 0) {
            return 0;
        }

        return weightedScore / totalWeight;
    }

    /**
     * Normalize weights into [0, 1] relative to the largest weight.
     * Guards against division by zero when every weight is <= 0.
     */
    normalize(evidence: RecommendationEvidence[]): RecommendationEvidence[] {
        if (!evidence.length) {
            return [];
        }

        const max = Math.max(...evidence.map(e => e.weight));

        if (max <= 0) {
            return evidence.map(item => ({ ...item, weight: 0 }));
        }

        return evidence.map(item => ({
            ...item,
            weight: item.weight / max
        }));
    }
}

/* =============================================================================
 * Recommendation Ranking
 * =============================================================================
 */

export class RecommendationRanker {

    rank(recommendations: Recommendation[]): Recommendation[] {
        // Sort a copy — sorting the caller's array in place is a surprising
        // side effect for something named `rank`.
        return [...recommendations].sort((a, b) => this.score(b) - this.score(a));
    }

    score(recommendation: Recommendation): number {
        let score = 0;

        score += recommendation.priority * 100;
        score += recommendation.confidence * 50;
        score += recommendation.estimatedRiskReduction;
        score -= recommendation.estimatedEngineeringCost;

        if (recommendation.blocking) {
            score += 500;
        }

        return score;
    }
}

/* =============================================================================
 * Recommendation Deduplicator
 * =============================================================================
 */

export class RecommendationDeduplicator {

    /**
     * Deduplicates by (category, title) using nested Maps rather than a
     * concatenated string key, for the same collision-safety reason as
     * `RecommendationEvidenceEngine.mergeEvidence` — see note there.
     */
    deduplicate(recommendations: Recommendation[]): Recommendation[] {
        const byCategory = new Map<RecommendationCategory, Map<string, Recommendation>>();

        for (const recommendation of recommendations) {
            let byTitle = byCategory.get(recommendation.category);
            if (!byTitle) {
                byTitle = new Map();
                byCategory.set(recommendation.category, byTitle);
            }

            const existing = byTitle.get(recommendation.title);

            if (!existing) {
                byTitle.set(recommendation.title, recommendation);
                continue;
            }

            existing.evidence.push(...recommendation.evidence);
            existing.actions.push(...recommendation.actions);
            existing.confidence = Math.max(existing.confidence, recommendation.confidence);
            existing.priority = Math.max(existing.priority, recommendation.priority);
        }

        const unique: Recommendation[] = [];
        for (const byTitle of byCategory.values()) {
            unique.push(...byTitle.values());
        }
        return unique;
    }
}

/* =============================================================================
 * Recommendation Conflict Resolver
 * =============================================================================
 */

export class RecommendationConflictResolver {

    /**
     * O(n) via a nested-Map index instead of the original O(n^2) `.find()`
     * scan per candidate — important once a rule set is large enough that
     * an attacker (or just a noisy CI pipeline) can inflate the recommendation
     * count.
     */
    resolve(recommendations: Recommendation[]): Recommendation[] {
        const accepted: Recommendation[] = [];
        const positions = new Map<RecommendationCategory, Map<string, number>>();

        for (const candidate of recommendations) {
            let byTitle = positions.get(candidate.category);
            if (!byTitle) {
                byTitle = new Map();
                positions.set(candidate.category, byTitle);
            }

            const existingIndex = byTitle.get(candidate.title);

            if (existingIndex === undefined) {
                byTitle.set(candidate.title, accepted.length);
                accepted.push(candidate);
                continue;
            }

            const existing = accepted[existingIndex];
            if (candidate.confidence > existing.confidence) {
                accepted[existingIndex] = candidate;
            }
        }

        return accepted;
    }
}

/* =============================================================================
 * Decision Graph
 * =============================================================================
 */

export interface DecisionNode {
    id: string;
    name: string;
    description: string;
    confidence: number;
    score: number;
    category: RecommendationCategory;
    recommendation?: Recommendation;
}

export interface DecisionEdge {
    from: string;
    to: string;
    weight: number;
    reason: string;
}

export interface DecisionGraph {
    nodes: Map<string, DecisionNode>;
    edges: DecisionEdge[];
}

/* =============================================================================
 * Decision Graph Engine
 * =============================================================================
 */

export class RecommendationDecisionGraph {

    private readonly graph: DecisionGraph = {
        nodes: new Map(),
        edges: []
    };

    addNode(node: DecisionNode): void {
        this.graph.nodes.set(node.id, node);
    }

    addEdge(edge: DecisionEdge): void {
        this.graph.edges.push(edge);
    }

    getNode(id: string): DecisionNode | undefined {
        return this.graph.nodes.get(id);
    }

    getChildren(id: string): DecisionNode[] {
        const children: DecisionNode[] = [];

        for (const edge of this.graph.edges) {
            if (edge.from !== id) {
                continue;
            }
            const node = this.graph.nodes.get(edge.to);
            if (node) {
                children.push(node);
            }
        }

        return children;
    }

    getParents(id: string): DecisionNode[] {
        const parents: DecisionNode[] = [];

        for (const edge of this.graph.edges) {
            if (edge.to !== id) {
                continue;
            }
            const node = this.graph.nodes.get(edge.from);
            if (node) {
                parents.push(node);
            }
        }

        return parents;
    }
}

/* =============================================================================
 * Causal Reasoning
 * =============================================================================
 */

export interface ReasoningStep {
    id: string;
    title: string;
    explanation: string;
    evidence: RecommendationEvidence[];
    confidence: number;
}

export interface ReasoningChain {
    id: string;
    title: string;
    rootCause: string;
    consequence: string;
    recommendation: string;
    confidence: number;
    steps: ReasoningStep[];
}

export class ReasoningEngine {

    build(context: RecommendationContext, recommendations: Recommendation[]): ReasoningChain[] {
        const chains: ReasoningChain[] = [];

        for (const recommendation of recommendations) {
            const evidence = recommendation.evidence;

            const chain: ReasoningChain = {
                id: crypto.randomUUID(),
                title: recommendation.title,
                rootCause: this.findRootCause(evidence),
                consequence: this.predictConsequence(recommendation),
                recommendation: recommendation.summary,
                confidence: recommendation.confidence,
                steps: this.buildSteps(recommendation)
            };

            chains.push(chain);
        }

        return chains;
    }

    private buildSteps(recommendation: Recommendation): ReasoningStep[] {
        return recommendation.evidence.map(evidence => ({
            id: crypto.randomUUID(),
            title: evidence.title,
            explanation: evidence.description,
            evidence: [evidence],
            confidence: evidence.confidence
        }));
    }

    /**
     * Fixed: the original wrote `return\n    "Unknown";`. Automatic semicolon
     * insertion turns that into `return;` (returning undefined) followed by an
     * unreachable expression statement — the function silently returned
     * undefined for empty evidence instead of "Unknown". Also now sorts a
     * *copy* of the evidence array instead of mutating the caller's
     * `recommendation.evidence` in place as a side effect of computing a
     * rationale string.
     */
    private findRootCause(evidence: RecommendationEvidence[]): string {
        if (!evidence.length) {
            return "Unknown";
        }

        const sorted = [...evidence].sort((a, b) => b.weight - a.weight);
        return sorted[0].description;
    }

    /**
     * Fixed: same automatic-semicolon-insertion bug as `findRootCause` — every
     * branch here previously returned `undefined` instead of its string.
     */
    private predictConsequence(recommendation: Recommendation): string {
        switch (recommendation.category) {
            case RecommendationCategory.SECURITY:
                return "Security posture may change.";
            case RecommendationCategory.API:
                return "Consumers may observe different behavior.";
            case RecommendationCategory.DATABASE:
                return "Database compatibility should be reviewed.";
            default:
                return "Runtime behavior may differ.";
        }
    }
}

/* =============================================================================
 * Evidence Graph
 * =============================================================================
 */

export enum EvidenceNodeType {
    SEVERITY,
    SEMANTIC,
    IMPACT,
    BEHAVIOR,
    RECOMMENDATION,
    RULE,
    CHANGE,
    TEST,
    REVIEWER
}

export interface EvidenceNode {
    id: string;
    type: EvidenceNodeType;
    title: string;
    description: string;
    confidence: number;
    metadata?: Record<string, unknown>;
}

export interface EvidenceEdge {
    from: string;
    to: string;
    relationship: string;
    confidence: number;
    weight: number;
}

export class EvidenceGraph {

    private readonly nodes = new Map<string, EvidenceNode>();

    private edges: EvidenceEdge[] = [];

    addNode(node: EvidenceNode): void {
        this.nodes.set(node.id, node);
    }

    addEdge(edge: EvidenceEdge): void {
        this.edges.push(edge);
    }

    getNode(id: string): EvidenceNode | undefined {
        return this.nodes.get(id);
    }

    /**
     * Whether a node with this id exists. Lets callers (e.g. a Reasoner's
     * evidence dedup) check without pulling the whole node out.
     */
    has(id: string): boolean {
        return this.nodes.has(id);
    }

    /**
     * Remove a node and any edges that reference it, so callers never end up
     * with a dangling edge pointing at a node that no longer exists.
     */
    removeNode(id: string): boolean {
        this.edges = this.edges.filter(edge => edge.from !== id && edge.to !== id);
        return this.nodes.delete(id);
    }

    /** Wipe the graph back to empty. */
    clear(): void {
        this.nodes.clear();
        this.edges = [];
    }

    /**
     * Every node currently stored in the graph. Relied on by `EvidenceQuery`
     * and `ContradictionEngine.detect()` to enumerate nodes.
     */
    getNodes(): EvidenceNode[] {
        return [...this.nodes.values()];
    }

    /** Every edge currently stored in the graph. */
    getEdges(): EvidenceEdge[] {
        return [...this.edges];
    }

    /**
     * Referential-integrity check: returns edges that point at a node id
     * which is no longer (or never was) present in the graph. Useful for a
     * production health check / diagnostics endpoint rather than trusting the
     * graph is always internally consistent.
     */
    findDanglingEdges(): EvidenceEdge[] {
        return this.edges.filter(edge => !this.nodes.has(edge.from) || !this.nodes.has(edge.to));
    }

    getChildren(id: string): EvidenceNode[] {
        return this.edges
            .filter(edge => edge.from === id)
            .map(edge => this.nodes.get(edge.to))
            .filter((node): node is EvidenceNode => node !== undefined);
    }

    getParents(id: string): EvidenceNode[] {
        return this.edges
            .filter(edge => edge.to === id)
            .map(edge => this.nodes.get(edge.from))
            .filter((node): node is EvidenceNode => node !== undefined);
    }
}

/* =============================================================================
 * Evidence Traversal
 * =============================================================================
 */

export class EvidenceTraversal {

    traceToRoot(graph: EvidenceGraph, nodeId: string): EvidenceNode[] {
        const path: EvidenceNode[] = [];
        const visited = new Set<string>();

        const visit = (id: string): void => {
            if (visited.has(id)) {
                return;
            }
            visited.add(id);

            const node = graph.getNode(id);
            if (!node) {
                return;
            }

            path.push(node);

            for (const parent of graph.getParents(id)) {
                visit(parent.id);
            }
        };

        visit(nodeId);
        return path;
    }
}

/* =============================================================================
 * Evidence Query Engine
 * =============================================================================
 */

export class EvidenceQuery {

    constructor(private readonly graph: EvidenceGraph) {}

    findByType(type: EvidenceNodeType): EvidenceNode[] {
        return this.graph.getNodes().filter(node => node.type === type);
    }

    findByConfidence(minimum: number): EvidenceNode[] {
        return this.graph.getNodes().filter(node => node.confidence >= minimum);
    }

    search(keyword: string): EvidenceNode[] {
        const query = keyword.toLowerCase();
        return this.graph.getNodes().filter(
            node =>
                node.title.toLowerCase().includes(query) ||
                node.description.toLowerCase().includes(query)
        );
    }
}

/* =============================================================================
 * Inference Engine
 * =============================================================================
 */

export interface Inference {
    id: string;
    title: string;
    description: string;
    confidence: number;
    supportingEvidence: EvidenceNode[];
    assumptions: string[];
    risks: string[];
}

/**
 * Groups high-confidence evidence nodes by type and turns each cluster into
 * an Inference. `HypothesisEngine` and `ReasoningPipeline` both call `.infer()`.
 */
export class InferenceEngine {

    constructor(
        private readonly graph: EvidenceGraph,
        private readonly query: EvidenceQuery
    ) {}

    infer(): Inference[] {
        const inferences: Inference[] = [];

        const candidates = this.query.findByConfidence(0.65);
        const grouped = this.groupByType(candidates);

        for (const [type, nodes] of grouped) {
            if (!nodes.length) {
                continue;
            }

            const confidence = this.averageConfidence(nodes);

            inferences.push({
                id: crypto.randomUUID(),
                title: `Pattern detected in ${EvidenceNodeType[type]} evidence`,
                description: this.buildDescription(type, nodes),
                confidence,
                supportingEvidence: nodes,
                assumptions: this.buildAssumptions(type),
                risks: this.buildRisks(type, confidence)
            });
        }

        return inferences;
    }

    private groupByType(nodes: EvidenceNode[]): Map<EvidenceNodeType, EvidenceNode[]> {
        const groups = new Map<EvidenceNodeType, EvidenceNode[]>();

        for (const node of nodes) {
            const existing = groups.get(node.type) ?? [];
            existing.push(node);
            groups.set(node.type, existing);
        }

        return groups;
    }

    private averageConfidence(nodes: EvidenceNode[]): number {
        if (!nodes.length) {
            return 0;
        }
        const total = nodes.reduce((sum, node) => sum + node.confidence, 0);
        return total / nodes.length;
    }

    private buildDescription(type: EvidenceNodeType, nodes: EvidenceNode[]): string {
        const titles = nodes.map(node => node.title).join(", ");
        return `${nodes.length} ${EvidenceNodeType[type]} node(s) support this pattern: ${titles}`;
    }

    private buildAssumptions(type: EvidenceNodeType): string[] {
        switch (type) {
            case EvidenceNodeType.SEVERITY:
                return ["Severity scoring reflects current rule weights."];
            case EvidenceNodeType.SEMANTIC:
                return ["Semantic diffing accurately reflects intent."];
            case EvidenceNodeType.IMPACT:
                return ["Impact analysis covers all downstream consumers."];
            case EvidenceNodeType.BEHAVIOR:
                return ["Runtime behavior sampling is representative."];
            default:
                return ["Evidence is representative of the underlying change."];
        }
    }

    private buildRisks(type: EvidenceNodeType, confidence: number): string[] {
        const risks: string[] = [];

        if (confidence < 0.80) {
            risks.push("Confidence is below the high-certainty threshold.");
        }

        if (type === EvidenceNodeType.BEHAVIOR) {
            risks.push("Behavioral evidence may not cover all code paths.");
        }

        return risks;
    }
}

/* =============================================================================
 * Hypothesis Engine
 * =============================================================================
 */

export interface Hypothesis {
    id: string;
    title: string;
    statement: string;
    confidence: number;
    supportingEvidence: EvidenceNode[];
    opposingEvidence: EvidenceNode[];
    assumptions: string[];
    recommendations: string[];
}

export class HypothesisEngine {

    constructor(
        private readonly graph: EvidenceGraph,
        private readonly query: EvidenceQuery,
        private readonly inference: InferenceEngine
    ) {}

    evaluate(): Hypothesis[] {
        const hypotheses: Hypothesis[] = [];
        const inferences = this.inference.infer();

        for (const inference of inferences) {
            hypotheses.push({
                id: crypto.randomUUID(),
                title: inference.title,
                statement: inference.description,
                confidence: inference.confidence,
                supportingEvidence: inference.supportingEvidence,
                opposingEvidence: this.findOpposingEvidence(inference),
                assumptions: [...inference.assumptions],
                recommendations: this.generateRecommendations(inference)
            });
        }

        return hypotheses;
    }

    private findOpposingEvidence(inference: Inference): EvidenceNode[] {
        return this.graph.getNodes().filter(node => {
            if (inference.supportingEvidence.some(evidence => evidence.id === node.id)) {
                return false;
            }
            return node.confidence < 0.30;
        });
    }

    private generateRecommendations(inference: Inference): string[] {
        const recommendations: string[] = [];

        if (inference.confidence >= 0.90) {
            recommendations.push("Immediate review recommended.");
            recommendations.push("Proceed with high confidence after verification.");
        } else if (inference.confidence >= 0.70) {
            recommendations.push("Validate with additional tests.");
            recommendations.push("Request peer review.");
        } else if (inference.confidence >= 0.50) {
            recommendations.push("Collect additional evidence.");
            recommendations.push("Expand test coverage.");
        } else {
            recommendations.push("Insufficient evidence for a reliable conclusion.");
            recommendations.push("Investigate before making deployment decisions.");
        }

        return recommendations;
    }
}

/* =============================================================================
 * Contradiction Detection
 * =============================================================================
 */

export interface Contradiction {
    id: string;
    nodeA: EvidenceNode;
    nodeB: EvidenceNode;
    description: string;
    severity: RecommendationPriority;
}

export class ContradictionEngine {

    constructor(private readonly graph: EvidenceGraph) {}

    /**
     * Detects contradictory evidence nodes.
     *
     * Nodes are first grouped by (type, title) — `type` is a numeric enum so
     * it's used as a Map key directly, and titles are grouped in a nested Map
     * keyed per type, so there is no string-concatenation key to collide on.
     * Pairwise comparison then only happens *within* a (type, title) bucket
     * instead of across the entire graph, turning a global O(n^2) scan (a
     * real DoS risk once the graph holds thousands of nodes) into O(n^2) only
     * within each — normally small — bucket.
     */
    detect(): Contradiction[] {
        const contradictions: Contradiction[] = [];
        const groups = new Map<EvidenceNodeType, Map<string, EvidenceNode[]>>();

        for (const node of this.graph.getNodes()) {
            let byTitle = groups.get(node.type);
            if (!byTitle) {
                byTitle = new Map();
                groups.set(node.type, byTitle);
            }
            const bucket = byTitle.get(node.title) ?? [];
            bucket.push(node);
            byTitle.set(node.title, bucket);
        }

        for (const byTitle of groups.values()) {
            for (const bucket of byTitle.values()) {
                for (let i = 0; i < bucket.length; i++) {
                    for (let j = i + 1; j < bucket.length; j++) {
                        const a = bucket[i];
                        const b = bucket[j];

                        if (!this.isContradictory(a, b)) {
                            continue;
                        }

                        contradictions.push({
                            id: crypto.randomUUID(),
                            nodeA: a,
                            nodeB: b,
                            description: this.describe(a, b),
                            severity: this.severityFor(a, b)
                        });
                    }
                }
            }
        }

        for (const edge of this.graph.getEdges()) {
            if (edge.relationship !== "contradicts") {
                continue;
            }

            const a = this.graph.getNode(edge.from);
            const b = this.graph.getNode(edge.to);

            if (!a || !b) {
                continue;
            }

            contradictions.push({
                id: crypto.randomUUID(),
                nodeA: a,
                nodeB: b,
                description: `Explicit contradiction edge between '${a.title}' and '${b.title}'.`,
                severity: RecommendationPriority.HIGH
            });
        }

        return contradictions;
    }

    /** Nodes reaching this point are already known to share type and title. */
    private isContradictory(a: EvidenceNode, b: EvidenceNode): boolean {
        return Math.abs(a.confidence - b.confidence) >= 0.40;
    }

    private describe(a: EvidenceNode, b: EvidenceNode): string {
        return `Nodes '${a.title}' disagree in confidence (${(a.confidence * 100).toFixed(0)}% vs ${(b.confidence * 100).toFixed(0)}%).`;
    }

    private severityFor(a: EvidenceNode, b: EvidenceNode): RecommendationPriority {
        const delta = Math.abs(a.confidence - b.confidence);

        if (delta >= 0.70) {
            return RecommendationPriority.CRITICAL;
        }
        if (delta >= 0.55) {
            return RecommendationPriority.HIGH;
        }
        return RecommendationPriority.MEDIUM;
    }
}

/* =============================================================================
 * Reasoning Pipeline
 * =============================================================================
 */

export interface ReasoningResult {
    evidence: EvidenceNode[];
    inferences: Inference[];
    hypotheses: Hypothesis[];
    contradictions: Contradiction[];
    confidence: number;
    summary: string;
}

export class ReasoningPipeline {

    constructor(
        private readonly graph: EvidenceGraph,
        private readonly query: EvidenceQuery,
        private readonly inference: InferenceEngine,
        private readonly hypothesis: HypothesisEngine,
        private readonly contradiction: ContradictionEngine
    ) {}

    execute(): ReasoningResult {
        const evidence = this.graph.getNodes();
        const inferences = this.inference.infer();
        const hypotheses = this.hypothesis.evaluate();
        const contradictions = this.contradiction.detect();

        const confidence = this.calculateConfidence(hypotheses, contradictions);
        const summary = this.buildSummary(evidence, inferences, hypotheses, contradictions, confidence);

        return {
            evidence,
            inferences,
            hypotheses,
            contradictions,
            confidence,
            summary
        };
    }

    private calculateConfidence(hypotheses: Hypothesis[], contradictions: Contradiction[]): number {
        if (hypotheses.length === 0) {
            return 0;
        }

        const total = hypotheses.reduce((sum, hypothesis) => sum + hypothesis.confidence, 0);
        const confidence = total / hypotheses.length - contradictions.length * 0.05;

        return clamp(confidence, 0, 1);
    }

    private buildSummary(
        evidence: EvidenceNode[],
        inferences: Inference[],
        hypotheses: Hypothesis[],
        contradictions: Contradiction[],
        confidence: number
    ): string {
        return [
            `Evidence: ${evidence.length}`,
            `Inferences: ${inferences.length}`,
            `Hypotheses: ${hypotheses.length}`,
            `Contradictions: ${contradictions.length}`,
            `Overall Confidence: ${(confidence * 100).toFixed(1)}%`
        ].join(" | ");
    }
}