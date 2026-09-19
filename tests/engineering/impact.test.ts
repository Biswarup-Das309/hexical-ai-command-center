import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeRepositoryImpact, queryRepositoryGraph } from '../../lib/engineering/impact'
import { buildRepositoryGraph } from '../../lib/engineering/repository-graph'

function fixture() {
  return buildRepositoryGraph({
    repositoryKey: 'impact-fixture',
    files: [
      { path: 'src/auth.ts', content: 'export function verify() { return true }' },
      {
        path: 'src/session.ts',
        content: "import { verify } from './auth'\nexport function session() { return verify() }",
      },
      {
        path: 'app/api/route.ts',
        content: "import { session } from '../../src/session'\nexport async function GET() { return session() }",
      },
      { path: 'src/session.test.ts', content: "import { session } from './session'\ntest('session', session)" },
      { path: 'tsconfig.json', content: '{}' },
    ],
  })
}

test('impact analysis reports direct and transitive dependents with evidence', () => {
  const graph = fixture()
  const report = analyzeRepositoryImpact(graph, 'src/auth.ts')

  assert.equal(report.status, 'VERIFIED')
  assert.ok(report.items.some((item) => item.item === 'src/session.ts' && item.direct))
  assert.ok(report.items.some((item) => item.item === 'app/api/route.ts' && !item.direct))
  assert.ok(report.items.some((item) => item.category === 'security'))
  assert.ok(report.items.every((item) => item.reason.length > 0))
})

test('repository graph query contract exposes reusable dependency and test queries', () => {
  const graph = fixture()
  const query = queryRepositoryGraph(graph)

  assert.deepEqual(query.dependencies('src/session.ts'), ['src/auth.ts'])
  assert.deepEqual(query.dependents('src/auth.ts'), ['src/session.ts'])
  assert.deepEqual(query.callers('src/auth.ts'), ['src/session.ts'])
  assert.deepEqual(query.tests_for('src/session.ts'), ['src/session.test.ts'])
  assert.ok(query.symbols('src/auth.ts').some((symbol) => symbol?.name === 'verify'))
})
