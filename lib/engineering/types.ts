import type { Json } from '@/lib/database.types'

export const REPOSITORY_MAX_FILES = 500
export const REPOSITORY_MAX_FILE_BYTES = 250_000
export const REPOSITORY_MAX_TOTAL_BYTES = 4_000_000
export const REPOSITORY_MAX_NODES = 10_000
export const REPOSITORY_MAX_EDGES = 25_000

export type EvidenceCertainty = 'OBSERVED' | 'DERIVED' | 'INFERRED'
export type EvidenceType =
  | 'source_file'
  | 'source_range'
  | 'graph_relationship'
  | 'command_execution'
  | 'test_result'
  | 'security_finding'
  | 'diff'
  | 'model_inference'
  | 'external_provider_result'
  | 'runtime_output'

export type RepositoryNodeKind =
  | 'repository'
  | 'directory'
  | 'file'
  | 'symbol'
  | 'route'
  | 'test'
  | 'configuration'
  | 'package'
  | 'external_dependency'
  | 'unknown_dependency'

export type RepositoryRelation =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'tests'
  | 'routes_to'
  | 'configures'
  | 'depends_on'

export type EngineeringRunStatus =
  | 'CREATED'
  | 'ANALYZING'
  | 'PLANNING'
  | 'CHANGING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'

export type EngineeringTaskStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'CANCELLED'
export type EngineeringRole =
  | 'REPOSITORY_ANALYST'
  | 'ARCHITECT'
  | 'SECURITY_ENGINEER'
  | 'TEST_ENGINEER'
  | 'VERIFICATION_ENGINEER'
export type VerificationStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'FAILED' | 'BLOCKED'

export interface SourceReference {
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
  readonly excerpt?: string
}

export interface RepositoryFileInput {
  readonly path: string
  readonly content: string
}

export interface RepositorySnapshotInput {
  readonly repositoryKey: string
  readonly root?: string
  readonly files: readonly RepositoryFileInput[]
}

export interface RepositoryNode {
  readonly id: string
  readonly kind: RepositoryNodeKind
  readonly key: string
  readonly name: string
  readonly path: string | null
  readonly language?: string
  readonly metadata: Readonly<Record<string, Json>>
}

export interface RepositoryEdgeEvidence {
  readonly type: EvidenceType
  readonly certainty: EvidenceCertainty
  readonly source?: SourceReference
  readonly explanation: string
}

export interface RepositoryEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly relation: RepositoryRelation
  readonly direct: boolean
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown'
  readonly evidence: RepositoryEdgeEvidence
}

export interface RepositoryGraphSummary {
  readonly fileCount: number
  readonly directoryCount: number
  readonly symbolCount: number
  readonly routeCount: number
  readonly testCount: number
  readonly configurationCount: number
  readonly externalDependencyCount: number
  readonly unknownDependencyCount: number
  readonly internalRelationshipCount: number
  readonly securityBoundaryCount: number
  readonly languages: readonly string[]
}

export interface RepositoryGraph {
  readonly repositoryKey: string
  readonly root: string
  readonly generatedAt: string
  readonly files: readonly {
    readonly path: string
    readonly language: string
    readonly bytes: number
    readonly digest: string
    readonly securitySignals: readonly string[]
  }[]
  readonly nodes: readonly RepositoryNode[]
  readonly edges: readonly RepositoryEdge[]
  readonly summary: RepositoryGraphSummary
  readonly limitations: readonly string[]
}

export interface EvidenceRecord {
  readonly id?: string
  readonly runId: string
  readonly type: EvidenceType
  readonly certainty: EvidenceCertainty
  readonly title: string
  readonly explanation: string
  readonly source?: SourceReference
  readonly payload?: Readonly<Record<string, Json>>
}

export type EngineeringRoleEvidence = Omit<EvidenceRecord, 'id' | 'runId'>

export interface EngineeringRoleAnalysis {
  readonly role: EngineeringRole
  readonly objective: string
  readonly status: EngineeringTaskStatus
  readonly inputContext: Readonly<Record<string, Json>>
  readonly findings: readonly Json[]
  readonly evidence: readonly EngineeringRoleEvidence[]
  /** Null means this static analysis has no calibrated confidence score. */
  readonly confidence: number | null
}

export interface EngineeringEvidenceOrchestration {
  readonly objective: string
  readonly roles: readonly EngineeringRoleAnalysis[]
  readonly disagreements: readonly string[]
  readonly synthesis: Readonly<Record<string, Json>>
  readonly limitations: readonly string[]
}

export interface ImpactItem {
  readonly item: string
  readonly reason: string
  readonly evidence: readonly RepositoryEdgeEvidence[]
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown'
  readonly direct: boolean
  readonly category: 'dependency' | 'dependent' | 'test' | 'route' | 'configuration' | 'security' | 'runtime'
}

export interface RepositoryImpactReport {
  readonly target: string
  readonly status: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNKNOWN'
  readonly items: readonly ImpactItem[]
  readonly limitations: readonly string[]
}

export interface VerificationCheckResult {
  readonly check: 'diff' | 'graph_consistency' | 'security' | 'tests' | 'typecheck' | 'lint' | 'build'
  readonly status: VerificationStatus
  readonly summary: string
  readonly evidence: readonly EvidenceRecord[]
  readonly blockedReason?: string
  readonly durationMs: number
}

export interface EngineeringVerificationResult {
  readonly status: VerificationStatus
  readonly checks: readonly VerificationCheckResult[]
  readonly impact: readonly RepositoryImpactReport[]
  readonly errors: readonly string[]
  readonly correlationId: string
  readonly startedAt: string
  readonly completedAt: string
}

export interface EngineeringRunView {
  readonly run: {
    readonly id: string
    readonly ownerUserId: string
    readonly repositoryId: string
    readonly objective: string
    readonly status: EngineeringRunStatus
    readonly verificationStatus: VerificationStatus | null
    readonly correlationId: string
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly tasks: readonly Record<string, unknown>[]
  readonly evidence: readonly Record<string, unknown>[]
  readonly repository: RepositoryGraph | null
}
