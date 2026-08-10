import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeterministicExtractionEngine } from '../../lib/evidence-graph/deterministic-extractor'

const EXECUTION_ID = '00000000-0000-4000-8000-000000001001'

function collect(lines: readonly string[]) {
  const engine = new DeterministicExtractionEngine()
  engine.reset(EXECUTION_ID)
  const results = lines.map((text, index) =>
    engine.extract(EXECUTION_ID, {
      type: 'stdout' as const,
      text,
      sequence: index + 1,
      timestamp: `2026-08-09T12:00:0${index}.000Z`,
    }),
  )
  return [...results, engine.flush(EXECUTION_ID)]
}

test('extracts Nmap hosts, IPs, ports, services, and versions deterministically', () => {
  const results = collect([
    'Nmap scan report for app.example.com (192.0.2.10)\n',
    '80/tcp open http Apache httpd 2.4.58\n',
  ])
  const entities = results.flatMap((result) => result.entities)
  const relationships = results.flatMap((result) => result.relationships)
  assert.ok(entities.some((entity) => entity.type === 'host' && entity.canonicalKey === 'app.example.com'))
  assert.ok(entities.some((entity) => entity.type === 'ip' && entity.canonicalKey === '192.0.2.10'))
  assert.ok(entities.some((entity) => entity.type === 'port' && entity.canonicalKey === 'tcp/80'))
  assert.ok(entities.some((entity) => entity.type === 'service' && entity.canonicalKey === 'tcp:http'))
  assert.ok(entities.some((entity) => entity.type === 'technology' && entity.canonicalKey.includes('apache httpd')))
  assert.ok(relationships.some((edge) => edge.relationship === 'EXPOSES'))
  assert.ok(relationships.some((edge) => edge.relationship === 'RUNS'))
})

test('extracts HTTP, directory, generic indicators, and redacts credential values', () => {
  const results = collect([
    'https://portal.example.com/admin\n',
    'HTTP/1.1 200 OK\n<title>Admin Console</title>\nServer: nginx\n',
    'Found: /backup.zip [Status: 200]\npassword=super-secret-token CVE-2024-12345 analyst@example.com 2001:db8::1\n',
  ])
  const entities = results.flatMap((result) => result.entities)
  assert.ok(entities.some((entity) => entity.type === 'url' && entity.value === 'https://portal.example.com/admin'))
  assert.ok(entities.some((entity) => entity.type === 'evidence' && entity.label === 'HTTP 200'))
  assert.ok(entities.some((entity) => entity.type === 'technology' && entity.label === 'nginx'))
  assert.ok(entities.some((entity) => entity.type === 'file' && entity.value === '/backup.zip'))
  assert.ok(entities.some((entity) => entity.type === 'vulnerability' && entity.label === 'CVE-2024-12345'))
  const credential = entities.find((entity) => entity.type === 'credential')
  assert.ok(credential)
  assert.equal(credential.value, null)
  assert.equal(JSON.stringify(credential).includes('super-secret-token'), false)
  assert.ok(entities.some((entity) => entity.type === 'ip' && entity.metadata?.version === 6))
})

test('handles malformed and partial output without throwing or producing unstable duplicates', () => {
  const engine = new DeterministicExtractionEngine()
  engine.reset(EXECUTION_ID)
  assert.doesNotThrow(() =>
    engine.extract(EXECUTION_ID, {
      type: 'stderr',
      text: '\u0000\u0001 not structured output',
      sequence: 1,
      timestamp: '2026-08-09T12:00:00.000Z',
    }),
  )
  const first = engine.extract(EXECUTION_ID, {
    type: 'stdout',
    text: 'Nmap scan report for partial.example.com',
    sequence: 2,
    timestamp: '2026-08-09T12:00:01.000Z',
  })
  assert.equal(first.entities.length, 0)
  const second = engine.extract(EXECUTION_ID, {
    type: 'stdout',
    text: ' (192.0.2.11)\n',
    sequence: 3,
    timestamp: '2026-08-09T12:00:02.000Z',
  })
  assert.ok(second.entities.some((entity) => entity.type === 'host'))
  const replay = engine.extract(EXECUTION_ID, {
    type: 'stdout',
    text: 'CVE-2024-12345\n',
    sequence: 4,
    timestamp: '2026-08-09T12:00:03.000Z',
  })
  assert.equal(replay.entities.filter((entity) => entity.type === 'vulnerability').length, 1)
})
