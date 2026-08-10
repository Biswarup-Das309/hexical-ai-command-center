/**
 * =============================================================================
 * Hexical AI
 * reasoner.ts
 * =============================================================================
 *
 * Central Reasoning Orchestrator
 *
 * PURPOSE
 * -----------------------------------------------------------------------------
 *
 * The Reasoner coordinates every reasoning component used by Hexical.
 *
 * It owns the reasoning session, manages evidence, executes the reasoning
 * pipeline, and exposes explainable APIs.
 *
 * Unlike recommendation.ts, this file does NOT implement inference,
 * hypothesis generation, contradiction detection, or recommendation logic.
 *
 * Instead, it orchestrates those engines.
 *
 * =============================================================================
 */

import { randomUUID } from 'node:crypto'
import {
  EvidenceGraph,
  EvidenceNode,
  EvidenceQuery,
  InferenceEngine,
  HypothesisEngine,
  ContradictionEngine,
  ReasoningPipeline,
  ReasoningResult,
  Inference,
  Hypothesis,
  Contradiction,
} from './recommendation'

/* =============================================================================
 * Limits & internal guards
 * =============================================================================
 *
 * NOTE: these defaults are conservative and configurable via the Reasoner
 * constructor. Without them, a caller (or a bug upstream) can push unbounded
 * amounts of evidence/metadata into a session and exhaust process memory.
 */

const DEFAULT_MAX_EVIDENCE_NODES = 10_000
const DEFAULT_MAX_METADATA_BYTES = 64 * 1024 // 64 KB

const DANGEROUS_METADATA_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface SessionLimits {
  maxEvidenceNodes?: number
  maxMetadataBytes?: number
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`)
  }
}

/**
 * Validates and sanitizes a metadata payload before it's merged into a
 * session. Strips prototype-pollution-style keys defensively (object spread
 * itself is safe, but this metadata often gets re-serialized or merged
 * downstream with less careful code) and enforces a size ceiling.
 */
function sanitizeMetadata(metadata: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  assertPlainObject(metadata, 'metadata')

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (DANGEROUS_METADATA_KEYS.has(key)) {
      continue
    }
    sanitized[key] = value
  }

  let serializedSize: number
  try {
    serializedSize = JSON.stringify(sanitized).length
  } catch {
    throw new TypeError('metadata must be JSON-serializable.')
  }

  if (serializedSize > maxBytes) {
    throw new RangeError(`metadata payload too large (${serializedSize} bytes, limit ${maxBytes}).`)
  }

  return sanitized
}

/**
 * Structural check for evidence nodes. We only assert on the minimal shape
 * this file relies on (a non-empty string `id`, since removeEvidence(id)
 * keys on it) rather than trying to fully re-validate EvidenceNode, whose
 * complete shape lives in recommendation.ts.
 */
function assertValidEvidenceNode(node: unknown): asserts node is EvidenceNode {
  if (typeof node !== 'object' || node === null) {
    throw new TypeError('Evidence node must be a non-null object.')
  }
  const id = (node as { id?: unknown }).id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError("Evidence node must include a non-empty string 'id'.")
  }
}

/**
 * Deep copy helper used anywhere we hand internal state back to a caller.
 * Prefers structuredClone (safe for dates, maps, sets, etc.); falls back to
 * JSON round-tripping in older runtimes.
 */
function deepCopy<T>(value: T): T {
  const globalStructuredClone = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone
  if (typeof globalStructuredClone === 'function') {
    return globalStructuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

/* =============================================================================
 * Reasoning Context
 * =============================================================================
 */

export interface ReasoningContext {
  graph: EvidenceGraph
  query: EvidenceQuery
  inference: InferenceEngine
  hypothesis: HypothesisEngine
  contradiction: ContradictionEngine
  pipeline: ReasoningPipeline
}

/* =============================================================================
 * Reasoning Request
 * =============================================================================
 */

export interface ReasoningRequest {
  evidence?: EvidenceNode[]
  metadata?: Record<string, unknown>
}

/* =============================================================================
 * Reasoning Response
 * =============================================================================
 */

export interface ReasoningResponse {
  session: ReasoningSession
  result: ReasoningResult
}

/* =============================================================================
 * Session Statistics
 * =============================================================================
 */

export interface SessionStatistics {
  evidenceCount: number
  executionCount: number
  createdAt: number
  updatedAt: number
}

/* =============================================================================
 * Reasoning Session
 * =============================================================================
 */

export class ReasoningSession {
  readonly id: string = randomUUID()
  readonly graph = new EvidenceGraph()
  readonly createdAt = Date.now()

  private updatedAt = this.createdAt
  private executionCount = 0
  private metadata: Record<string, unknown> = {}
  private executing = false

  constructor(private readonly limits: SessionLimits = {}) {}

  private get maxEvidenceNodes(): number {
    return this.limits.maxEvidenceNodes ?? DEFAULT_MAX_EVIDENCE_NODES
  }

  private get maxMetadataBytes(): number {
    return this.limits.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES
  }

  /**
   * Add a single evidence node.
   */
  addEvidence(node: EvidenceNode): void {
    assertValidEvidenceNode(node)

    if (this.graph.getNodes().length >= this.maxEvidenceNodes) {
      throw new RangeError(`Evidence limit reached (${this.maxEvidenceNodes} nodes max).`)
    }

    this.graph.addNode(node)
    this.touch()
  }

  /**
   * Add multiple evidence nodes.
   */
  addEvidenceBatch(nodes: EvidenceNode[]): void {
    if (!Array.isArray(nodes)) {
      throw new TypeError('addEvidenceBatch expects an array of evidence nodes.')
    }

    for (const node of nodes) {
      assertValidEvidenceNode(node)
    }

    const projectedCount = this.graph.getNodes().length + nodes.length
    if (projectedCount > this.maxEvidenceNodes) {
      throw new RangeError(
        `Adding ${nodes.length} node(s) would exceed the evidence limit ` +
          `(${this.maxEvidenceNodes} max, currently ${this.graph.getNodes().length}).`,
      )
    }

    for (const node of nodes) {
      this.graph.addNode(node)
    }
    this.touch()
  }

  /**
   * Remove evidence.
   */
  removeEvidence(id: string): boolean {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('removeEvidence requires a non-empty string id.')
    }

    const removed = this.graph.removeNode(id)
    if (removed) {
      this.touch()
    }
    return removed
  }

  /**
   * Clear all evidence.
   */
  clear(): void {
    this.graph.clear()
    this.touch()
  }

  /**
   * Current evidence. Returns a defensive copy so callers can't mutate the
   * session's internal graph state by mutating the returned array.
   */
  getEvidence(): EvidenceNode[] {
    return [...this.graph.getNodes()]
  }

  /**
   * Merge new metadata into the session. Validated and size-capped — see
   * sanitizeMetadata for details.
   */
  setMetadata(metadata: Record<string, unknown>): void {
    const sanitized = sanitizeMetadata(metadata, this.maxMetadataBytes)
    this.metadata = { ...this.metadata, ...sanitized }
    this.touch()
  }

  /**
   * Returns a deep copy of the session's metadata. A shallow copy would
   * still let callers mutate nested objects and corrupt internal state.
   */
  getMetadata(): Record<string, unknown> {
    return deepCopy(this.metadata)
  }

  /**
   * Increment execution count.
   */
  markExecuted(): void {
    this.executionCount++
    this.touch()
  }

  /**
   * Marks the session as mid-execution. Throws if a run is already in
   * flight, since two concurrent pipeline executions sharing one
   * EvidenceGraph could interleave and corrupt state.
   */
  beginExecution(): void {
    if (this.executing) {
      throw new Error(
        `Session ${this.id} is already executing; concurrent executions on ` + `the same session are not supported.`,
      )
    }
    this.executing = true
  }

  /**
   * Releases the execution lock. Always call from a finally block.
   */
  endExecution(): void {
    this.executing = false
  }

  /**
   * Session statistics.
   */
  getStatistics(): SessionStatistics {
    return {
      evidenceCount: this.graph.getNodes().length,
      executionCount: this.executionCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  /**
   * Update timestamp.
   */
  private touch(): void {
    this.updatedAt = Date.now()
  }
}

/* =============================================================================
 * Reasoner Builder
 * =============================================================================
 */

export class ReasonerBuilder {
  /**
   * Build a reasoning context for a session.
   */
  build(session: ReasoningSession): ReasoningContext {
    const query = new EvidenceQuery(session.graph)
    const inference = new InferenceEngine(session.graph, query)
    const hypothesis = new HypothesisEngine(session.graph, query, inference)
    const contradiction = new ContradictionEngine(session.graph)
    const pipeline = new ReasoningPipeline(session.graph, query, inference, hypothesis, contradiction)

    return { graph: session.graph, query, inference, hypothesis, contradiction, pipeline }
  }

  /**
   * Rebuild a context after the session changes.
   */
  rebuild(session: ReasoningSession): ReasoningContext {
    return this.build(session)
  }

  /**
   * Create a completely new session.
   */
  createSession(limits: SessionLimits = {}): ReasoningSession {
    return new ReasoningSession(limits)
  }
}

/* =============================================================================
 * Reasoner
 * =============================================================================
 */

export class Reasoner {
  private readonly builder = new ReasonerBuilder()
  private readonly explainer = new ReasoningExplainer()

  constructor(private readonly limits: SessionLimits = {}) {}

  /**
   * Create a new reasoning session.
   */
  createSession(): ReasoningSession {
    return this.builder.createSession(this.limits)
  }

  /**
   * Execute reasoning using an existing session.
   */
  executeSession(session: ReasoningSession): ReasoningResponse {
    session.beginExecution()
    try {
      const context = this.builder.build(session)
      const result = context.pipeline.execute()
      session.markExecuted()
      return { session, result }
    } catch (error) {
      throw new Error(
        `Reasoning execution failed for session ${session.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      session.endExecution()
    }
  }

  /**
   * Create a temporary session and execute immediately.
   */
  execute(request?: ReasoningRequest): ReasoningResponse {
    const session = this.createSession()

    if (request?.evidence) {
      session.addEvidenceBatch(request.evidence)
    }

    if (request?.metadata) {
      session.setMetadata(request.metadata)
    }

    return this.executeSession(session)
  }

  /**
   * Execute a session and immediately produce an explanation + report,
   * so callers don't have to manually rebuild a context afterward.
   */
  executeWithExplanation(session: ReasoningSession): {
    response: ReasoningResponse
    explanation: Explanation
    report: ReasoningReport
  } {
    const response = this.executeSession(session)
    const context = this.builder.build(session)
    const explanation = this.explainer.explain(context, response.result)
    const report = this.explainer.buildReport(session, explanation)
    return { response, explanation, report }
  }

  /**
   * Explain an already-computed result without re-executing the pipeline.
   */
  explain(session: ReasoningSession, result: ReasoningResult): Explanation {
    const context = this.builder.rebuild(session)
    return this.explainer.explain(context, result)
  }

  /**
   * Reset a session.
   */
  resetSession(session: ReasoningSession): void {
    session.clear()
  }

  /**
   * Clone a session. Evidence and metadata are deep-copied so the clone is
   * fully independent of the source session.
   */
  cloneSession(session: ReasoningSession): ReasoningSession {
    const clone = this.createSession()
    clone.addEvidenceBatch(deepCopy(session.getEvidence()))
    clone.setMetadata(session.getMetadata())
    return clone
  }

  /**
   * Get statistics for a session.
   */
  getStatistics(session: ReasoningSession): SessionStatistics {
    return session.getStatistics()
  }

  /**
   * Get all evidence currently stored.
   */
  getEvidence(session: ReasoningSession): EvidenceNode[] {
    return session.getEvidence()
  }

  /**
   * Add evidence.
   */
  addEvidence(session: ReasoningSession, node: EvidenceNode): void {
    session.addEvidence(node)
  }

  /**
   * Add multiple evidence nodes.
   */
  addEvidenceBatch(session: ReasoningSession, nodes: EvidenceNode[]): void {
    session.addEvidenceBatch(nodes)
  }

  /**
   * Remove evidence.
   */
  removeEvidence(session: ReasoningSession, id: string): boolean {
    return session.removeEvidence(id)
  }

  /**
   * Clear all evidence.
   */
  clearEvidence(session: ReasoningSession): void {
    session.clear()
  }

  /**
   * Rebuild the reasoning context.
   */
  rebuildContext(session: ReasoningSession): ReasoningContext {
    return this.builder.rebuild(session)
  }
}

/* =============================================================================
 * Explanation
 * =============================================================================
 */

export interface Explanation {
  summary: string
  confidence: number
  evidence: EvidenceNode[]
  inferences: Inference[]
  hypotheses: Hypothesis[]
  contradictions: Contradiction[]
}

/* =============================================================================
 * Reasoning Trace
 * =============================================================================
 */

export interface ReasoningTrace {
  sessionId: string
  timestamp: number
  explanation: Explanation
}

/* =============================================================================
 * Reasoning Report
 * =============================================================================
 */

export interface ReasoningReport {
  trace: ReasoningTrace
  statistics: SessionStatistics
}

/**
 * Shape of the fields we read off ReasoningResult when building an
 * explanation. These are assumed to be produced by ReasoningPipeline in
 * recommendation.ts — adjust here if the real field names differ.
 */
interface ExplainableResult {
  summary?: string
  confidence?: number
  inferences?: Inference[]
  hypotheses?: Hypothesis[]
  contradictions?: Contradiction[]
}

/* =============================================================================
 * Reasoning Explainer
 * =============================================================================
 */

export class ReasoningExplainer {
  /**
   * Build a full Explanation from a reasoning context + the result of
   * running its pipeline.
   */
  explain(context: ReasoningContext, result: ReasoningResult): Explanation {
    const explainable = result as ReasoningResult & ExplainableResult

    const inferences = [...(explainable.inferences ?? [])]
    const hypotheses = [...(explainable.hypotheses ?? [])]
    const contradictions = [...(explainable.contradictions ?? [])]
    const confidence = this.resolveConfidence(explainable.confidence)
    const evidence = [...context.graph.getNodes()]

    const summary =
      typeof explainable.summary === 'string' && explainable.summary.trim() !== ''
        ? explainable.summary
        : this.buildFallbackSummary(evidence.length, inferences, hypotheses, contradictions)

    return { summary, confidence, evidence, inferences, hypotheses, contradictions }
  }

  /**
   * Wrap an Explanation with session identity + a timestamp.
   */
  buildTrace(sessionId: string, explanation: Explanation): ReasoningTrace {
    return { sessionId, timestamp: Date.now(), explanation }
  }

  /**
   * Combine a trace with session statistics into a full report.
   */
  buildReport(session: ReasoningSession, explanation: Explanation): ReasoningReport {
    return {
      trace: this.buildTrace(session.id, explanation),
      statistics: session.getStatistics(),
    }
  }

  private resolveConfidence(value: unknown): number {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
    return Math.min(1, Math.max(0, numeric))
  }

  private buildFallbackSummary(
    evidenceCount: number,
    inferences: Inference[],
    hypotheses: Hypothesis[],
    contradictions: Contradiction[],
  ): string {
    return (
      `Evaluated ${evidenceCount} evidence node(s): ` +
      `${inferences.length} inference(s), ${hypotheses.length} hypothesis/es, ` +
      `${contradictions.length} contradiction(s) found.`
    )
  }
}
