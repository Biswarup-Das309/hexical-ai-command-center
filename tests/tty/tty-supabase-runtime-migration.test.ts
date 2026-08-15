import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

const initialMigration = resolve(process.cwd(), 'supabase/migrations/20260815_hexical_runtime_supabase_backend.sql')
const repairMigration = resolve(process.cwd(), 'supabase/migrations/20260815_fix_runtime_lease_worker_identity.sql')

test('Supabase lease SQL persists worker identity for claim and persistent adoption', async () => {
  const source = await readFile(initialMigration, 'utf8')

  assert.match(source, /jsonb_build_object\('workerId',p_args\[1\]\) \|\| \(p_args\[2\]::jsonb\)/)
  assert.match(source, /jsonb_build_object\('workerId',p_args\[3\]\)\|\|\(p_args\[4\]::jsonb\)/)
})

test('Supabase lease identity repair is additive and fails closed on unexpected function text', async () => {
  const source = await readFile(repairMigration, 'utf8')

  assert.match(source, /pg_get_functiondef\(p\.oid\)/)
  assert.match(source, /position\('jsonb_build_object\(''workerId'',p_args\[1\]\)' in v_source\)/)
  assert.match(source, /return;/)
  assert.match(source, /expected stale lease construction was not found/)
  assert.match(source, /jsonb_build_object\(''workerId'',p_args\[1\]\)/)
  assert.match(source, /jsonb_build_object\(''workerId'',p_args\[3\]\)/)
})
