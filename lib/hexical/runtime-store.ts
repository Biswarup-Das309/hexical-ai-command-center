import type { TTYRuntimeStore } from '@/lib/tty/tty-runtime-store'

export interface RuntimeWindowResult {
  readonly allowed: boolean
  readonly remaining: number
  readonly resetMs: number
}

/**
 * The Investigation API uses the same Supabase/Postgres runtime store as
 * Runtime OS. Keeping this boundary small makes it impossible for a normal
 * Investigation message to silently reintroduce a Redis-only dependency.
 */
export type HexicalRuntimeStore = Pick<TTYRuntimeStore, 'get' | 'set' | 'del' | 'incr' | 'expire'> & {
  incrby(key: string, delta: number): Promise<number>
  rateLimit(key: string, capacity: number, windowSecs: number): Promise<RuntimeWindowResult>
  reserveBudget(key: string, amount: number, cap: number, ttlSecs: number): Promise<[number, number, number]>
  reconcileBudget(key: string, delta: number): Promise<number>
}
