import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRepositoryGraph } from '../../lib/engineering/repository-graph'

test('repository ingestion produces observed files, symbols, routes, tests, and resolved internal imports', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'fixture-repo',
    files: [
      { path: 'src/auth.ts', content: 'export function verifySession() { return true }\n' },
      {
        path: 'src/api/route.ts',
        content: "import { verifySession } from '../auth'\nexport async function GET() { return verifySession() }\n",
      },
      { path: 'src/api/route.test.ts', content: "import { GET } from './route'\ntest('route', GET)\n" },
      { path: 'package.json', content: '{"dependencies":{"zod":"^4.0.0"}}' },
    ],
  })

  assert.equal(graph.summary.fileCount, 4)
  assert.equal(graph.summary.routeCount, 1)
  assert.equal(graph.summary.testCount, 1)
  assert.ok(graph.nodes.some((node) => node.kind === 'symbol' && node.name === 'verifySession'))
  assert.ok(graph.edges.some((edge) => edge.relation === 'imports' && edge.confidence === 'high'))
  assert.ok(graph.edges.some((edge) => edge.relation === 'tests'))
  assert.ok(graph.edges.some((edge) => edge.relation === 'depends_on' && edge.target === 'package:zod'))
})

test('repository ingestion records unresolved relative imports as explicit unknown evidence', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'unknown-import',
    files: [{ path: 'src/index.ts', content: "import './generated/runtime'\nexport const ready = true\n" }],
  })

  assert.equal(graph.summary.unknownDependencyCount, 1)
  const edge = graph.edges.find((candidate) => candidate.relation === 'imports')
  assert.equal(edge?.confidence, 'unknown')
  assert.equal(edge?.evidence.certainty, 'OBSERVED')
  assert.match(edge?.evidence.explanation ?? '', /not resolved/i)
})

test('repository ingestion rejects unsafe paths and does not persist source bodies in graph metadata', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'safe-paths',
    files: [
      { path: '../secret.ts', content: 'const token = "not persisted"' },
      { path: 'src/safe.ts', content: 'const token = "not persisted"' },
    ],
  })

  assert.deepEqual(
    graph.files.map((file) => file.path),
    ['src/safe.ts'],
  )
  assert.equal(
    graph.nodes.some((node) => JSON.stringify(node).includes('not persisted')),
    false,
  )
  assert.equal(
    graph.edges.some((edge) => JSON.stringify(edge).includes('not persisted')),
    false,
  )
})
