import { randomUUID } from 'node:crypto'
import { analyzeRepositoryImpact } from './impact'
import type {
  EngineeringVerificationResult,
  EvidenceRecord,
  RepositoryGraph,
  VerificationCheckResult,
  VerificationStatus,
} from './types'

type SupportedCheck = 'diff' | 'graph_consistency' | 'security' | 'tests' | 'typecheck' | 'lint' | 'build'

function check(
  name: SupportedCheck,
  status: VerificationStatus,
  summary: string,
  startedAt: number,
  evidence: EvidenceRecord[] = [],
  blockedReason?: string,
): VerificationCheckResult {
  return { check: name, status, summary, evidence, blockedReason, durationMs: Math.max(0, Date.now() - startedAt) }
}

function sourceEvidence(runId: string, path: string, title: string, explanation: string): EvidenceRecord {
  return { runId, type: 'source_file', certainty: 'OBSERVED', title, explanation, source: { path } }
}

export function runRepositoryVerification(
  graph: RepositoryGraph,
  runId: string,
  changedPaths: readonly string[],
  requestedChecks: readonly SupportedCheck[],
): EngineeringVerificationResult {
  const startedAt = new Date().toISOString()
  const checks: VerificationCheckResult[] = []
  const errors: string[] = []
  const normalizedPaths = [...new Set(changedPaths.map((path) => path.trim()).filter(Boolean))]

  const checksToRun: SupportedCheck[] =
    requestedChecks.length > 0 ? [...requestedChecks] : ['graph_consistency', 'security']
  for (const requested of checksToRun) {
    const started = Date.now()
    if (requested === 'diff') {
      if (normalizedPaths.length === 0) {
        checks.push(
          check(
            requested,
            'BLOCKED',
            'No changed files were supplied for diff verification.',
            started,
            [],
            'A proposed change or commit diff is required.',
          ),
        )
      } else {
        const missing = normalizedPaths.filter((path) => !graph.files.some((file) => file.path === path))
        const evidence = normalizedPaths.map((path) =>
          sourceEvidence(
            runId,
            path,
            'Changed path in submitted snapshot',
            'The path was explicitly supplied for verification.',
          ),
        )
        checks.push(
          missing.length === 0
            ? check(
                requested,
                'VERIFIED',
                `All ${normalizedPaths.length} changed paths exist in the submitted repository snapshot.`,
                started,
                evidence,
              )
            : check(requested, 'FAILED', `Unknown changed paths: ${missing.join(', ')}`, started, evidence),
        )
      }
      continue
    }

    if (requested === 'graph_consistency') {
      const nodeIds = new Set(graph.nodes.map((node) => node.id))
      const broken = graph.edges.filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
      checks.push(
        broken.length === 0
          ? check(
              requested,
              'VERIFIED',
              `All ${graph.edges.length} graph relationships resolve to known nodes.`,
              started,
              [
                {
                  runId,
                  type: 'graph_relationship',
                  certainty: 'OBSERVED',
                  title: 'Graph consistency',
                  explanation: 'Every persisted relationship references nodes in the same normalized snapshot.',
                },
              ],
            )
          : check(requested, 'FAILED', `${broken.length} graph relationships reference missing nodes.`, started),
      )
      continue
    }

    if (requested === 'security') {
      const signals = graph.files.flatMap((file) => file.securitySignals.map((signal) => ({ file, signal })))
      checks.push(
        check(
          requested,
          signals.length === 0 ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
          signals.length === 0
            ? 'No configured static security signals were observed in the submitted files.'
            : `${signals.length} static security signal(s) require engineer review.`,
          started,
          signals.map(({ file, signal }) => ({
            runId,
            type: 'security_finding',
            certainty: 'OBSERVED',
            title: signal,
            explanation: `Static signal observed in ${file.path}; this is not a confirmed vulnerability.`,
            source: { path: file.path },
          })),
        ),
      )
      continue
    }

    if (requested === 'tests') {
      const impacts =
        normalizedPaths.length > 0 ? normalizedPaths.map((path) => analyzeRepositoryImpact(graph, path)) : []
      const testCount = impacts.reduce(
        (total, impact) => total + impact.items.filter((item) => item.category === 'test').length,
        0,
      )
      checks.push(
        testCount > 0
          ? check(
              requested,
              'VERIFIED',
              `${testCount} affected test relationship(s) were identified from the repository graph.`,
              started,
            )
          : check(
              requested,
              'PARTIALLY_VERIFIED',
              'No affected test relationship was found; test execution was not run.',
              started,
              [],
              'The submitted snapshot does not provide a runnable checkout.',
            ),
      )
      continue
    }

    checks.push(
      check(
        requested,
        'BLOCKED',
        `${requested} was not executed against a checkout.`,
        started,
        [],
        'The hosted repository context is a bounded source snapshot and is not connected to a command worker.',
      ),
    )
  }

  const impact = normalizedPaths.map((path) => analyzeRepositoryImpact(graph, path))
  const statuses = checks.map((result) => result.status)
  const status: VerificationStatus = statuses.includes('FAILED')
    ? 'FAILED'
    : statuses.includes('BLOCKED')
    ? 'BLOCKED'
    : statuses.includes('PARTIALLY_VERIFIED')
    ? 'PARTIALLY_VERIFIED'
    : 'VERIFIED'

  return {
    status,
    checks,
    impact,
    errors,
    correlationId: randomUUID(),
    startedAt,
    completedAt: new Date().toISOString(),
  }
}
