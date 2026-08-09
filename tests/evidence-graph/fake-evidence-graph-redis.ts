interface SetOptions {
  readonly nx?: boolean
}

interface SortedMember {
  readonly score: number
  readonly member: string
}

export class FakeEvidenceGraphRedis {
  private readonly values = new Map<string, string>()
  private readonly sorted = new Map<string, Map<string, number>>()

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) ?? null) as T | null
  }

  async set(key: string, value: unknown, options?: SetOptions): Promise<string | null> {
    if (options?.nx && this.values.has(key)) return null
    this.values.set(key, String(value))
    return 'OK'
  }

  async zadd(key: string, value: SortedMember): Promise<number> {
    const members = this.sorted.get(key) ?? new Map<string, number>()
    const created = members.has(value.member) ? 0 : 1
    members.set(value.member, value.score)
    this.sorted.set(key, members)
    return created
  }

  async zrange<T extends unknown[]>(key: string, _min: number, _max: number, options: { readonly rev?: boolean; readonly offset: number; readonly count: number }): Promise<T> {
    const entries = [...(this.sorted.get(key) ?? new Map<string, number>()).entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((left, right) => options.rev ? right.score - left.score || right.member.localeCompare(left.member) : left.score - right.score || left.member.localeCompare(right.member))
    return entries.slice(options.offset, options.offset + options.count).map(entry => entry.member) as T
  }

  async zcard(key: string): Promise<number> {
    return this.sorted.get(key)?.size ?? 0
  }

  async eval<T = unknown>(script: string, keys: readonly string[], args: readonly string[]): Promise<T> {
    if (script.includes('entity-upsert')) {
      if (this.values.has(keys[0]!)) return 0 as T
      this.values.set(keys[0]!, args[0]!)
      if (!this.values.has(keys[1]!)) this.values.set(keys[1]!, args[1]!)
      await this.zadd(keys[2]!, { score: Number(args[2]), member: args[1]! })
      await this.zadd(keys[3]!, { score: Number(args[2]), member: args[1]! })
      return 1 as T
    }
    if (script.includes('edge-upsert')) {
      if (this.values.has(keys[0]!)) return 0 as T
      this.values.set(keys[0]!, args[0]!)
      for (const key of keys.slice(1)) await this.zadd(key, { score: Number(args[2]), member: args[1]! })
      return 1 as T
    }
  throw new Error('Unknown graph script')
  }
}
