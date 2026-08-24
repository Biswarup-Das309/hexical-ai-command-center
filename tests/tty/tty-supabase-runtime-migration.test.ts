import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

const initialMigration = resolve(process.cwd(), 'supabase/migrations/20260815_hexical_runtime_supabase_backend.sql')
const repairMigration = resolve(process.cwd(), 'supabase/migrations/20260815_fix_runtime_lease_worker_identity.sql')
const hardeningMigration = resolve(
  process.cwd(),
  'supabase/migrations/20260824_hexical_runtime_expiry_and_range_hardening.sql',
)

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

test('Supabase runtime hardening propagates stream TTLs and removes expired rows before append', async () => {
  const source = await readFile(hardeningMigration, 'utf8')

  assert.match(source, /update public\.hexical_runtime_stream_entries\s+set expires_at = v_expires/)
  assert.match(
    source,
    /delete from public\.hexical_runtime_stream_entries\s+where stream_key = p_stream_key and expires_at is not null and expires_at <= now\(\)/,
  )
  assert.match(
    source,
    /insert into public\.hexical_runtime_stream_entries\(stream_key, stream_sequence, stream_id, fields, expires_at\)/,
  )
})

test('Supabase runtime set insertion is a single conflict-safe operation', async () => {
  const source = await readFile(hardeningMigration, 'utf8')

  assert.match(source, /create function public\.hexical_runtime_add_set_members\(p_key text, p_members text\[\]\)/)
  assert.match(
    source,
    /create or replace function public\.hexical_runtime_add_set_members\(p_key text, p_members text\[\]\)/,
  )
  assert.match(source, /select distinct member from unnest\(p_members\)/)
  assert.match(source, /on conflict \(key, member\) do nothing/)
})
