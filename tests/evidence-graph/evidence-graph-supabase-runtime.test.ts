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

test('adds set members atomically through the Supabase runtime RPC', async () => {
  const calls: RpcCall[] = []
  const store = new SupabaseRuntimeStore(fakeClient(calls, 2) as never)

  const result = await store.sadd('tty:active', 'execution-a', 'execution-b')

  assert.equal(result, 2)
  assert.deepEqual(calls, [
    {
      name: 'hexical_runtime_add_set_members',
      args: { p_key: 'tty:active', p_members: ['execution-a', 'execution-b'] },
    },
  ])
})

test('uses database pagination for sorted indexes instead of loading the full key', async () => {
  const ranges: Array<[number, number]> = []
  const query = {
    select() {
      return this
    },
    eq() {
      return this
    },
    order() {
      return this
    },
    range(start: number, end: number) {
      ranges.push([start, end])
      return Promise.resolve({
        data: [
          { member: 'member-2', score: 2 },
          { member: 'member-1', score: 1 },
        ],
        error: null,
      })
    },
  }
  const store = new SupabaseRuntimeStore({ from: () => query } as never)

  const result = await store.zrange<string[]>('graph:index', 0, 3, { offset: 2, count: 2, rev: true })

  assert.deepEqual(result, ['member-2', 'member-1'])
  assert.deepEqual(ranges, [[2, 3]])
})

test('filters expired stream rows before applying the replay limit', async () => {
  const filters: string[] = []
  const query = {
    select() {
      return this
    },
    eq() {
      return this
    },
    order() {
      return this
    },
    limit() {
      return this
    },
    gte() {
      return this
    },
    lte() {
      return this
    },
    gt() {
      return this
    },
    or(value: string) {
      filters.push(value)
      return Promise.resolve({
        data: [{ stream_id: '2-0', fields: { text: 'live' }, expires_at: null }],
        error: null,
      })
    },
  }
  const store = new SupabaseRuntimeStore({ from: () => query } as never)

  const result = await store.xrange<unknown[]>('tty:stream', '-', '+', 1)

  assert.deepEqual(result, [['2-0', { text: 'live' }]])
  assert.equal(filters.length, 1)
  assert.match(filters[0] ?? '', /^expires_at\.is\.null,expires_at\.gt\.\d{4}-/)
})
