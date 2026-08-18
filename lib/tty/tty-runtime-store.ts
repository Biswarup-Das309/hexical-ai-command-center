import type { Json } from '@/lib/database.types'

export interface TTYRuntimeSetOptions {
  readonly nx?: boolean
  readonly ex?: number
}

export interface TTYRuntimeSortedSetEntry {
  readonly score: number
  readonly member: string
}

export interface TTYRuntimeStreamSubscriptionPayload {
  readonly streamId: string
  readonly fields: unknown
}

export interface TTYRuntimeBroadcastPayload {
  readonly event: string
  readonly payload: unknown
}

export interface TTYRuntimeStore {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, options?: TTYRuntimeSetOptions): Promise<T | string | null>
  del(...keys: string[]): Promise<number>
  exists(key: string): Promise<number>
  incr(key: string): Promise<number>
  decr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  srem(key: string, ...members: string[]): Promise<number>
  zadd(key: string, entry: TTYRuntimeSortedSetEntry): Promise<number | null>
  zrange: (...args: any[]) => Promise<any>
  zrem(key: string, ...members: string[]): Promise<number>
  zremrangebyscore(key: string, min: number, max: number): Promise<number>
  zcard(key: string): Promise<number>
  xadd(key: string, id: '*', fields: Record<string, unknown>): Promise<string>
  xrange: (...args: any[]) => Promise<any>
  xtrim?(
    key: string,
    options: { readonly strategy: 'MAXLEN'; readonly threshold: number; readonly exactness?: '~' | '=' },
  ): Promise<number>
  eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>
  ping(): Promise<string>
  xgroup?(...args: readonly unknown[]): Promise<unknown>
  xautoclaim?(...args: readonly unknown[]): Promise<unknown>
  xreadgroup?(...args: readonly unknown[]): Promise<unknown>
  xack?(...args: readonly unknown[]): Promise<unknown>
  subscribeToStream?(
    streamKey: string,
    callback: (payload: TTYRuntimeStreamSubscriptionPayload) => void,
  ): Promise<() => void>
  /** Low-latency ephemeral transport for interactive PTY stdin. */
  broadcastToChannel?(channel: string, event: string, payload: unknown): Promise<void>
  subscribeToBroadcast?(channel: string, event: string, callback: (payload: unknown) => void): Promise<() => void>
}

export function toRuntimeJson(value: unknown): Json {
  if (value === undefined) return null
  return value as Json
}
