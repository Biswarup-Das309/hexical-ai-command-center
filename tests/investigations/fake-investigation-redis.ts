interface SetOptions {
  readonly nx?: boolean
}

interface SortedMember {
  readonly score: number
  readonly member: string
}

interface StreamEntry {
  readonly id: string
  readonly fields: Record<string, string>
}

export class FakeInvestigationRedis {
  private readonly values = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly sorted = new Map<string, Map<string, number>>()
  private readonly streams = new Map<string, StreamEntry[]>()
  private streamSequence = 0

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) ?? null) as T | null
  }

  async set(key: string, value: unknown, options?: SetOptions): Promise<string | null> {
    if (options?.nx && this.values.has(key)) return null
    this.values.set(key, String(value))
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      if (this.values.delete(key)) count += 1
      if (this.sets.delete(key)) count += 1
      if (this.sorted.delete(key)) count += 1
      if (this.streams.delete(key)) count += 1
    }
    return count
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + 1
    this.values.set(key, String(next))
    return next
  }

  async sadd(key: string, member: string): Promise<number> {
    const members = this.sets.get(key) ?? new Set<string>()
    const before = members.size
    members.add(member)
    this.sets.set(key, members)
    return members.size - before
  }

  async srem(key: string, member: string): Promise<number> {
    const members = this.sets.get(key) ?? new Set<string>()
    const removed = members.delete(member) ? 1 : 0
    this.sets.set(key, members)
    return removed
  }

  async zadd(key: string, input: SortedMember): Promise<number | null> {
    const members = this.sorted.get(key) ?? new Map<string, number>()
    const added = members.has(input.member) ? 0 : 1
    members.set(input.member, input.score)
    this.sorted.set(key, members)
    return added
  }

  async zrem(key: string, member: string): Promise<number> {
    const members = this.sorted.get(key) ?? new Map<string, number>()
    const removed = members.delete(member) ? 1 : 0
    this.sorted.set(key, members)
    return removed
  }

  async zrange<T extends unknown[]>(key: string, _min: number, _max: number, options: { readonly rev?: boolean; readonly offset: number; readonly count: number }): Promise<T> {
    const members = [...(this.sorted.get(key) ?? new Map<string, number>())].sort((left, right) => options?.rev ? right[1] - left[1] : left[1] - right[1]).map(([member]) => member)
    const offset = options.offset
    const count = options.count
    return members.slice(offset, offset + count) as T
  }

  async xadd(key: string, _id: '*', fields: Record<string, string>): Promise<string> {
    const id = `${++this.streamSequence}-0`
    const stream = this.streams.get(key) ?? []
    stream.push({ id, fields: { ...fields } })
    this.streams.set(key, stream)
    return id
  }

  async xrange(key: string, start: string, _end: string, count?: number): Promise<unknown[]> {
    const exclusive = start.startsWith('(')
    const startId = (exclusive ? start.slice(1) : start).split('-')[0]
    const minimum = startId === '-' ? 0 : Number(startId)
    const entries = (this.streams.get(key) ?? []).filter(entry => exclusive ? Number(entry.id.split('-')[0]) > minimum : Number(entry.id.split('-')[0]) >= minimum)
    return entries.slice(0, count ?? entries.length).map(entry => [entry.id, Object.entries(entry.fields).flat()])
  }
}
