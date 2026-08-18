import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  toRuntimeJson,
  type TTYRuntimeSetOptions,
  type TTYRuntimeSortedSetEntry,
  type TTYRuntimeStore,
} from './tty-runtime-store'

const GLOBAL_RUNTIME_KEY = '__hexical_runtime_supabase_client__'
const GLOBAL_BROADCAST_CHANNELS_KEY = '__hexical_runtime_supabase_broadcast_channels__'
const MAX_STREAM_READ = 10_000

type RuntimeClient = SupabaseClient<Database>
type RuntimeStreamRow = Database['public']['Tables']['hexical_runtime_stream_entries']['Row']
type BroadcastChannelState = {
  readonly channel: RealtimeChannel
  readonly ready: Promise<void>
}

function subscribeRealtimeChannel(channel: RealtimeChannel, channelName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve()
      else if (error) reject(error)
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
        reject(new Error(`Supabase realtime channel ${channelName} returned ${status}.`))
    })
  })
}

function requiredRuntimeEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required Supabase runtime environment variable: ${name}`)
  return value
}

export function createSupabaseRuntimeClient(): RuntimeClient {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY]
  if (existing) return existing as RuntimeClient
  const client = createClient<Database>(
    requiredRuntimeEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredRuntimeEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 100 } },
    },
  )
  ;(globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = client
  return client
}

function broadcastChannels(): Map<string, BroadcastChannelState> {
  const global = globalThis as Record<string, unknown>
  const existing = global[GLOBAL_BROADCAST_CHANNELS_KEY]
  if (existing instanceof Map) return existing as Map<string, BroadcastChannelState>
  const channels = new Map<string, BroadcastChannelState>()
  global[GLOBAL_BROADCAST_CHANNELS_KEY] = channels
  return channels
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function streamSequence(value: string): number {
  if (value === '-' || value === '+') return value === '-' ? 0 : Number.MAX_SAFE_INTEGER
  const match = /^\(?([0-9]+)(?:-[0-9]+)?$/.exec(value.trim())
  return match ? Math.max(0, Number(match[1])) : 0
}

function realtimeFilterValue(value: string): string {
  return value.replace(/[,()]/g, '')
}

function operationName(script: string): string {
  const marker = script.match(/--\s*([A-Za-z0-9:_-]+)/)
  if (marker) return marker[1] as string
  if (script.includes("redis.call('ZREMRANGEBYSCORE'")) return 'hexical:tty-execution-admission-reserve'
  return 'unknown'
}

export class SupabaseRuntimeStore implements TTYRuntimeStore {
  constructor(private readonly client: RuntimeClient = createSupabaseRuntimeClient()) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const { data, error } = await this.client
      .from('hexical_runtime_kv')
      .select('value,expires_at')
      .eq('key', key)
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    if (data.expires_at !== null && Date.parse(data.expires_at) <= Date.now()) {
      await this.del(key)
      return null
    }
    return data.value as T
  }

  async set<T = unknown>(key: string, value: T, options: TTYRuntimeSetOptions = {}): Promise<string | null> {
    const { data, error } = await this.client.rpc('hexical_runtime_set_value', {
      p_key: key,
      p_value: toRuntimeJson(value),
      p_ttl_seconds: options.ex === undefined ? null : Math.max(1, Math.floor(options.ex)),
      p_nx: options.nx === true,
    })
    if (error) throw error
    return data === null ? null : 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0
    const { data, error } = await this.client.rpc('hexical_runtime_delete_keys', { p_keys: keys })
    if (error) throw error
    return asNumber(data)
  }

  async exists(key: string): Promise<number> {
    return (await this.get(key)) === null ? 0 : 1
  }

  async incr(key: string): Promise<number> {
    return this.increment(key, 1)
  }

  async decr(key: string): Promise<number> {
    return this.increment(key, -1)
  }

  private async increment(key: string, delta: number): Promise<number> {
    const { data, error } = await this.client.rpc('hexical_runtime_increment_value', { p_key: key, p_delta: delta })
    if (error) throw error
    return asNumber(data)
  }

  async expire(key: string, seconds: number): Promise<number> {
    const { data, error } = await this.client.rpc('hexical_runtime_expire_key', {
      p_key: key,
      p_ttl_seconds: Math.max(1, Math.floor(seconds)),
    })
    if (error) throw error
    return asNumber(data)
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0
    const rows = members.map((member) => ({ key, member }))
    const { data: existing, error: existingError } = await this.client
      .from('hexical_runtime_set_members')
      .select('member')
      .eq('key', key)
      .in('member', members)
    if (existingError) throw existingError
    const existingMembers = new Set((existing ?? []).map((row) => row.member))
    const inserts = rows.filter((row) => !existingMembers.has(row.member))
    if (inserts.length > 0) {
      const { error } = await this.client.from('hexical_runtime_set_members').insert(inserts)
      if (error) throw error
    }
    return inserts.length
  }

  async smembers(key: string): Promise<string[]> {
    const { data, error } = await this.client.from('hexical_runtime_set_members').select('member').eq('key', key)
    if (error) throw error
    return (data ?? []).map((row) => row.member)
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0
    const { count, error } = await this.client
      .from('hexical_runtime_set_members')
      .delete({ count: 'exact' })
      .eq('key', key)
      .in('member', members)
    if (error) throw error
    return count ?? 0
  }

  async zadd(key: string, entry: TTYRuntimeSortedSetEntry): Promise<number> {
    const { data: existing, error: existingError } = await this.client
      .from('hexical_runtime_sorted_members')
      .select('member')
      .eq('key', key)
      .eq('member', entry.member)
      .maybeSingle()
    if (existingError) throw existingError
    const { error } = await this.client.from('hexical_runtime_sorted_members').upsert({
      key,
      member: entry.member,
      score: entry.score,
    })
    if (error) throw error
    return existing ? 0 : 1
  }

  async zrange<T = unknown[]>(
    key: string,
    min: number,
    max: number,
    options: { readonly rev?: boolean; readonly offset?: number; readonly count?: number } = {},
  ): Promise<T> {
    const { data, error } = await this.client
      .from('hexical_runtime_sorted_members')
      .select('member,score')
      .eq('key', key)
      .order('score', { ascending: options.rev !== true })
      .order('member', { ascending: options.rev !== true })
    if (error) throw error
    const offset = Math.max(0, options.offset ?? 0)
    const requestedCount = options.count === undefined ? undefined : Math.max(0, options.count)
    const rowCount = data?.length ?? 0
    const start = min < 0 ? Math.max(0, rowCount + min) : min
    const end = max < 0 ? rowCount : max + 1
    const selected = (data ?? []).slice(start, end)
    const window = selected.slice(offset, requestedCount === undefined ? undefined : offset + requestedCount)
    return window.map((row) => row.member) as T
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0
    const { count, error } = await this.client
      .from('hexical_runtime_sorted_members')
      .delete({ count: 'exact' })
      .eq('key', key)
      .in('member', members)
    if (error) throw error
    return count ?? 0
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const { count, error } = await this.client
      .from('hexical_runtime_sorted_members')
      .delete({ count: 'exact' })
      .eq('key', key)
      .gte('score', min)
      .lte('score', max)
    if (error) throw error
    return count ?? 0
  }

  async zcard(key: string): Promise<number> {
    const { count, error } = await this.client
      .from('hexical_runtime_sorted_members')
      .select('member', { count: 'exact', head: true })
      .eq('key', key)
    if (error) throw error
    return count ?? 0
  }

  async xadd(key: string, _id: '*', fields: Record<string, unknown>): Promise<string> {
    const { data, error } = await this.client.rpc('hexical_runtime_append_stream', {
      p_stream_key: key,
      p_fields: toRuntimeJson(fields),
    })
    if (error) throw error
    if (typeof data !== 'string') throw new Error('Supabase stream append returned an invalid cursor.')
    return data
  }

  async xrange<T = unknown>(key: string, start: string, end: string, count?: number): Promise<T> {
    let query = this.client
      .from('hexical_runtime_stream_entries')
      .select('stream_id,fields,stream_sequence,expires_at')
      .eq('stream_key', key)
      .order('stream_sequence', { ascending: true })
      .limit(Math.max(1, Math.min(MAX_STREAM_READ, count ?? MAX_STREAM_READ)))
    const startSequence = streamSequence(start)
    const endSequence = streamSequence(end)
    if (start.startsWith('(')) query = query.gt('stream_sequence', startSequence)
    else if (start !== '-') query = query.gte('stream_sequence', startSequence)
    if (end !== '+') query = query.lte('stream_sequence', endSequence)
    const { data, error } = await query
    if (error) throw error
    const now = Date.now()
    return (data ?? [])
      .filter((row) => row.expires_at === null || Date.parse(row.expires_at) > now)
      .map((row) => [row.stream_id, row.fields]) as T
  }

  async xtrim(
    key: string,
    options: { readonly strategy: 'MAXLEN'; readonly threshold: number; readonly exactness?: '~' | '=' },
  ): Promise<number> {
    const { data: rows, error: readError } = await this.client
      .from('hexical_runtime_stream_entries')
      .select('stream_sequence')
      .eq('stream_key', key)
      .order('stream_sequence', { ascending: false })
      .range(Math.max(0, options.threshold), MAX_STREAM_READ)
    if (readError) throw readError
    const sequences = (rows ?? []).map((row) => row.stream_sequence)
    if (sequences.length === 0) return 0
    const { count, error } = await this.client
      .from('hexical_runtime_stream_entries')
      .delete({ count: 'exact' })
      .eq('stream_key', key)
      .in('stream_sequence', sequences)
    if (error) throw error
    return count ?? 0
  }

  async eval<T = unknown>(script: string, keys: readonly string[], args: readonly string[]): Promise<T> {
    const { data, error } = await this.client.rpc('hexical_runtime_eval', {
      p_operation: operationName(script),
      p_keys: [...keys],
      p_args: [...args],
    })
    if (error) throw error
    return data as T
  }

  async ping(): Promise<string> {
    const { error } = await this.client.from('hexical_runtime_kv').select('key', { head: true }).limit(1)
    if (error) throw error
    return 'PONG'
  }

  async subscribeToStream(
    streamKey: string,
    callback: (payload: { readonly streamId: string; readonly fields: unknown }) => void,
  ): Promise<() => void> {
    const channelName = `hexical-runtime-stream-${crypto.randomUUID()}`
    const channel: RealtimeChannel = this.client.channel(channelName).on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'hexical_runtime_stream_entries',
        filter: `stream_key=eq.${realtimeFilterValue(streamKey)}`,
      },
      (payload) => {
        const row = payload.new as RuntimeStreamRow
        callback({ streamId: row.stream_id, fields: row.fields })
      },
    )
    await channel.subscribe()
    return () => {
      void this.client.removeChannel(channel)
    }
  }

  async broadcastToChannel(channelName: string, event: string, payload: unknown): Promise<void> {
    const channels = broadcastChannels()
    let state = channels.get(channelName)
    if (!state) {
      const channel = this.client.channel(channelName)
      const ready = subscribeRealtimeChannel(channel, channelName)
      state = { channel, ready }
      channels.set(channelName, state)
      void ready.catch(() => {
        if (channels.get(channelName) === state) channels.delete(channelName)
      })
    }
    await state.ready
    const status = await state.channel.send({ type: 'broadcast', event, payload })
    if (status !== 'ok') throw new Error(`Supabase broadcast send failed for ${channelName}: ${status}`)
  }

  async subscribeToBroadcast(
    channelName: string,
    event: string,
    callback: (payload: unknown) => void,
  ): Promise<() => void> {
    const channel = this.client.channel(channelName).on('broadcast', { event }, ({ payload }) => callback(payload))
    try {
      await subscribeRealtimeChannel(channel, channelName)
    } catch (error) {
      await this.client.removeChannel(channel)
      throw error
    }
    return () => {
      void this.client.removeChannel(channel)
    }
  }
}

export function createSupabaseRuntimeStore(): SupabaseRuntimeStore {
  return new SupabaseRuntimeStore()
}
