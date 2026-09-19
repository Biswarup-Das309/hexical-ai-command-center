import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRepositoryGraph } from '../../lib/engineering/repository-graph'
import { analyzeEngineeringEvidenceRoles, orchestrateEngineeringEvidence } from '../../lib/engineering/swarm'

test('engineering evidence roles produce durable, bounded findings from the graph', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'swarm-fixture',
    files: [
      {
        path: 'app/api/route.ts',
        content: "import { verify } from '../../src/auth'\nexport async function GET() { return verify() }",
      },
      { path: 'src/auth.ts', content: 'export function verify() { return eval(input) }' },
      { path: 'src/auth.test.ts', content: "import { verify } from './auth'\ntest('auth', verify)" },
      { path: 'package.json', content: '{"dependencies":{"zod":"^4.0.0"}}' },
    ],
  })

  const roles = analyzeEngineeringEvidenceRoles(graph)
  assert.deepEqual(
    roles.map((role) => role.role),
    ['ARCHITECT', 'SECURITY_ENGINEER', 'TEST_ENGINEER'],
  )
  assert.ok(roles.every((role) => role.status === 'COMPLETED'))
  assert.ok(roles.every((role) => role.confidence === null))
  assert.ok(roles[0]?.evidence.some((item) => item.certainty === 'DERIVED'))
  assert.ok(roles[1]?.evidence.some((item) => item.type === 'security_finding'))
  assert.ok(roles[2]?.findings.some((item) => JSON.stringify(item).includes('NOT_RUN')))
})

test('orchestration carries one objective through shared context and emits honest reconciliation limits', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'objective-fixture',
    files: [{ path: 'src/index.ts', content: 'export const ready = true' }],
  })
  const result = orchestrateEngineeringEvidence(graph, 'Safely change the authentication timeout.')

  assert.equal(result.objective, 'Safely change the authentication timeout.')
  assert.equal(result.roles[0]?.inputContext.objective, result.objective)
  assert.deepEqual(result.disagreements, [])
  assert.match(result.limitations[0] ?? '', /deterministic repository graph/i)
  assert.equal(result.synthesis.verificationBoundary, 'CHECKOUT_COMMANDS_NOT_RUN')
})

test('security role does not claim a clean result when no static signal is observed', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'quiet-fixture',
    files: [{ path: 'src/index.ts', content: 'export const ready = true' }],
  })
  const security = analyzeEngineeringEvidenceRoles(graph).find((role) => role.role === 'SECURITY_ENGINEER')
  assert.ok(security)
  assert.match(security.evidence[0]?.explanation ?? '', /dynamic and runtime security remain unverified/i)
})
