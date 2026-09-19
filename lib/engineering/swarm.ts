import type { Json } from '@/lib/database.types'
import type {
  EngineeringEvidenceOrchestration,
  EngineeringRoleAnalysis,
  EngineeringRoleEvidence,
  RepositoryGraph,
} from './types'

const SWARM_ROLES = ['ARCHITECT', 'SECURITY_ENGINEER', 'TEST_ENGINEER'] as const

function asJson(value: unknown): Json {
  return value as Json
}

function pathsForKind(graph: RepositoryGraph, kind: string): string[] {
  return graph.nodes
    .filter((node) => node.kind === kind && node.path)
    .map((node) => node.path as string)
    .sort()
}

function evidence(input: Omit<EngineeringRoleEvidence, 'runId'>): EngineeringRoleEvidence {
  return input
}

function commonContext(graph: RepositoryGraph, objective: string): Readonly<Record<string, Json>> {
  return {
    repositoryKey: graph.repositoryKey,
    graphGeneratedAt: graph.generatedAt,
    objective,
    summary: asJson(graph.summary),
    limitations: asJson(graph.limitations),
    analysisMode: 'static_repository_evidence',
  }
}

export function analyzeEngineeringEvidenceRoles(
  graph: RepositoryGraph,
  objective = 'Analyze the submitted repository and define a safe verification plan.',
): readonly EngineeringRoleAnalysis[] {
  const routes = pathsForKind(graph, 'route')
  const configurations = pathsForKind(graph, 'configuration')
  const runtimeBoundaries = graph.files
    .filter(
      (file) =>
        file.securitySignals.length > 0 || /(^|\/)(tty|runtime|worker|tmux|execution)(\/|\.|$)/i.test(file.path),
    )
    .map((file) => ({ path: file.path, signals: file.securitySignals }))
  const dependencies = graph.nodes
    .filter((node) => node.kind === 'package' || node.kind === 'external_dependency')
    .map((node) => node.name)
    .sort()
  const testFiles = pathsForKind(graph, 'test')
  const testEdges = graph.edges.filter((edge) => edge.relation === 'tests')
  const securityFiles = graph.files.filter((file) => file.securitySignals.length > 0)
  const context = commonContext(graph, objective)

  const architectEvidence = evidence({
    type: 'graph_relationship',
    certainty: 'DERIVED',
    title: 'Architectural boundaries mapped',
    explanation:
      'Route, configuration, dependency, and runtime-boundary relationships were derived from the persisted repository graph.',
    payload: {
      routeCount: routes.length,
      configurationCount: configurations.length,
      dependencyCount: dependencies.length,
      runtimeBoundaryCount: runtimeBoundaries.length,
    },
  })

  const securityEvidence = securityFiles.length
    ? securityFiles.map((file) =>
        evidence({
          type: 'security_finding',
          certainty: 'OBSERVED',
          title: `Static security signal in ${file.path}`,
          explanation: `The submitted source contained the configured static signal(s): ${file.securitySignals.join(
            ', ',
          )}. This is a review signal, not a confirmed vulnerability.`,
          source: { path: file.path },
          payload: { signals: asJson(file.securitySignals) },
        }),
      )
    : [
        evidence({
          type: 'source_file',
          certainty: 'OBSERVED',
          title: 'Static security scan completed',
          explanation:
            'No configured static security signal was observed in the submitted snapshot; dynamic and runtime security remain unverified.',
          payload: { scannedFileCount: graph.files.length },
        }),
      ]

  const testEvidence = evidence({
    type: 'test_result',
    certainty: 'DERIVED',
    title: 'Test relationship map created',
    explanation: `Mapped ${testEdges.length} conventional test relationship(s) across ${testFiles.length} test file(s). No test command was executed by this role.`,
    payload: { testFileCount: testFiles.length, mappedRelationshipCount: testEdges.length, execution: 'NOT_RUN' },
  })

  return [
    {
      role: SWARM_ROLES[0],
      objective: 'Map architecture boundaries and dependency structure from persisted repository evidence.',
      status: 'COMPLETED',
      inputContext: context,
      findings: [
        asJson({ kind: 'architecture_boundaries', routes, configurations, runtimeBoundaries }),
        asJson({ kind: 'dependencies', packages: dependencies }),
      ],
      evidence: [architectEvidence],
      confidence: null,
    },
    {
      role: SWARM_ROLES[1],
      objective: 'Review configured static security signals and record the limits of source-only analysis.',
      status: 'COMPLETED',
      inputContext: { ...context, scan: 'configured_static_signals_only' },
      findings: [
        asJson({
          kind: 'static_security_signals',
          files: securityFiles.map((file) => ({ path: file.path, signals: file.securitySignals })),
        }),
        asJson({ kind: 'analysis_limit', result: 'DYNAMIC_AND_RUNTIME_SECURITY_UNVERIFIED' }),
      ],
      evidence: securityEvidence,
      confidence: null,
    },
    {
      role: SWARM_ROLES[2],
      objective: 'Map test files and relationships without claiming that tests were executed.',
      status: 'COMPLETED',
      inputContext: { ...context, execution: 'NOT_RUN' },
      findings: [
        asJson({ kind: 'test_relationships', testFiles, mappedTargets: testEdges.length }),
        asJson({
          kind: 'execution_status',
          status: 'NOT_RUN',
          reason: 'A submitted snapshot is not a connected checkout.',
        }),
      ],
      evidence: [testEvidence],
      confidence: null,
    },
  ]
}

export function orchestrateEngineeringEvidence(
  graph: RepositoryGraph,
  objective: string,
): EngineeringEvidenceOrchestration {
  const roles = analyzeEngineeringEvidenceRoles(graph, objective)
  const roleStatuses = roles.map((role) => ({ role: role.role, status: role.status }))
  return {
    objective,
    roles,
    disagreements: [],
    synthesis: {
      kind: 'shared_graph_reconciliation',
      roleStatuses: asJson(roleStatuses),
      evidenceRecordCount: roles.reduce((total, role) => total + role.evidence.length, 0),
      verificationBoundary: 'CHECKOUT_COMMANDS_NOT_RUN',
    },
    limitations: [
      'All roles consumed one deterministic repository graph; independent provider opinions were not requested, so model disagreement analysis is not applicable.',
      'A connected checkout is still required for implementation changes and command-backed verification.',
    ],
  }
}
