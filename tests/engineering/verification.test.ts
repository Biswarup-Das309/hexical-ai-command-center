import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRepositoryGraph } from '../../lib/engineering/repository-graph'
import { runRepositoryVerification } from '../../lib/engineering/verification'

test('verification executes graph and static security checks and records explicit evidence', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'verification-fixture',
    files: [
      { path: 'src/auth.ts', content: 'export function verify() { return eval(input) }' },
      { path: 'src/auth.test.ts', content: "import { verify } from './auth'\ntest('auth', verify)" },
    ],
  })
  const result = runRepositoryVerification(
    graph,
    'run-1',
    ['src/auth.ts'],
    ['diff', 'graph_consistency', 'security', 'tests', 'typecheck'],
  )

  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.checks.find((check) => check.check === 'diff')?.status, 'VERIFIED')
  assert.equal(result.checks.find((check) => check.check === 'graph_consistency')?.status, 'VERIFIED')
  assert.equal(result.checks.find((check) => check.check === 'security')?.status, 'PARTIALLY_VERIFIED')
  assert.equal(result.checks.find((check) => check.check === 'typecheck')?.status, 'BLOCKED')
  assert.ok(
    result.checks
      .find((check) => check.check === 'security')
      ?.evidence.some((item) => item.type === 'security_finding'),
  )
  assert.ok(result.impact[0]?.items.some((item) => item.category === 'test'))
})

test('verification fails unknown changed paths instead of claiming a pass', () => {
  const graph = buildRepositoryGraph({
    repositoryKey: 'missing-path',
    files: [{ path: 'src/index.ts', content: 'export const ok = true' }],
  })
  const result = runRepositoryVerification(graph, 'run-2', ['src/missing.ts'], ['diff'])

  assert.equal(result.status, 'FAILED')
  assert.equal(result.checks[0]?.status, 'FAILED')
  assert.match(result.checks[0]?.summary ?? '', /Unknown changed paths/)
})
