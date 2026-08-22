import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SupabaseRuntimeStore } from '../../lib/tty/supabase-runtime-store'

type RpcCall = { readonly name: string; readonly args: Record<string, unknown> }

function fakeClient(calls: RpcCall[], result: unknown) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: result, error: null }
    },
  }
}

test('routes evidence graph operations to the dedicated Supabase RPC', async () => {
  const calls: RpcCall[] = []
  const store = new SupabaseRuntimeStore(fakeClient(calls, 1) as never)

  const result = await store.eval<number>(
    '-- hexical:evidence-graph:entity-upsert\nreturn 0',
    ['entity', 'lookup'],
    ['{"id":"entity_1234567890abcdef"}', 'entity_1234567890abcdef', '1'],
  )

  assert.equal(result, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'hexical_evidence_graph_eval')
  assert.equal(calls[0]?.args.p_operation, 'hexical:evidence-graph:entity-upsert')
})

test('keeps TTY operations on the existing runtime evaluator', async () => {
  const calls: RpcCall[] = []
  const store = new SupabaseRuntimeStore(fakeClient(calls, [1, 'ok']) as never)

  await store.eval('-- tty-worker-update\nreturn 0', ['worker'], ['{}'])

  assert.equal(calls[0]?.name, 'hexical_runtime_eval')
})
