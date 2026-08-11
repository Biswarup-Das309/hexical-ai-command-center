interface SetOptions {
  readonly nx?: boolean
}

interface StreamEntry {
  readonly id: string
  readonly fields: Record<string, string>
}

function compareStreamIds(left: string, right: string): number {
  const parse = (value: string): [number, number] => {
    const [milliseconds, sequence] = value.split('-').map(Number)
    return [milliseconds ?? 0, sequence ?? 0]
  }
  const [leftMilliseconds, leftSequence] = parse(left)
  const [rightMilliseconds, rightSequence] = parse(right)
  if (leftMilliseconds !== rightMilliseconds) return leftMilliseconds - rightMilliseconds
  return leftSequence - rightSequence
}

export class WorkerRedisMock {
  readonly values = new Map<string, string>()
  readonly sets = new Map<string, Set<string>>()
  readonly streams = new Map<string, StreamEntry[]>()
  private streamSequence = 0
  private readonly counters = new Map<string, number>()

  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key)
    return value === undefined ? null : (value as T)
  }

  async set(key: string, value: unknown, options?: SetOptions): Promise<string | null> {
    if (options?.nx && this.values.has(key)) return null
    this.values.set(key, String(value))
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1
      if (this.sets.delete(key)) deleted += 1
      if (this.streams.delete(key)) deleted += 1
      if (this.counters.delete(key)) deleted += 1
    }
    return deleted
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())]
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>()
    const before = set.size
    members.forEach((member) => set.add(member))
    this.sets.set(key, set)
    return set.size - before
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>()
    const before = set.size
    members.forEach((member) => set.delete(member))
    this.sets.set(key, set)
    return before - set.size
  }

  async incr(key: string): Promise<number> {
    const value = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, value)
    return value
  }

  async xadd(key: string, _id: '*', fields: Record<string, unknown>): Promise<string> {
    const id = `${Date.now()}-${++this.streamSequence}`
    const stream = this.streams.get(key) ?? []
    stream.push({
      id,
      fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, String(value)])),
    })
    this.streams.set(key, stream)
    return id
  }

  async xrange(key: string, start: string, end: string, count?: number): Promise<unknown[]> {
    const stream = this.streams.get(key) ?? []
    const exclusiveStart = start.startsWith('(')
    const normalizedStart = exclusiveStart ? start.slice(1) : start
    const filtered = stream.filter((entry) => {
      if (normalizedStart !== '-') {
        const comparison = compareStreamIds(entry.id, normalizedStart)
        if (exclusiveStart ? comparison <= 0 : comparison < 0) return false
      }
      if (end !== '+' && compareStreamIds(entry.id, end) > 0) return false
      return true
    })
    return filtered.slice(0, count).map((entry) => [entry.id, Object.entries(entry.fields).flat()])
  }

  async xtrim(
    key: string,
    options: { readonly strategy: 'MAXLEN'; readonly threshold: number; readonly exactness?: '~' | '=' },
  ): Promise<number> {
    if (options.strategy !== 'MAXLEN') return 0
    const stream = this.streams.get(key) ?? []
    const removeCount = Math.max(0, stream.length - Math.max(0, Math.floor(options.threshold)))
    if (removeCount > 0) stream.splice(0, removeCount)
    return removeCount
  }

  async eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
    const script = _script
    if (script.includes('tty-session-runtime-claim')) {
      const existing = this.values.get(keys[0]!)
      if (existing !== undefined) return [0, existing]
      this.values.set(keys[0]!, args[0]!)
      return [1, args[0]!]
    }
    if (script.includes('tty-session-runtime-promote')) {
      const current = this.values.get(keys[0]!)
      if (!current) return 0
      if ((JSON.parse(current) as { runtimeId?: unknown }).runtimeId !== args[0]) return 0
      this.values.set(keys[0]!, args[1]!)
      this.values.set(keys[1]!, args[3]!)
      return 1
    }
    if (script.includes('tty-session-runtime-renew')) {
      const current = this.values.get(keys[0]!)
      if (!current) return 0
      if ((JSON.parse(current) as { runtimeId?: unknown }).runtimeId !== args[0]) return 0
      this.values.set(keys[0]!, args[1]!)
      return 1
    }
    if (script.includes('tty-session-runtime-release')) {
      const current = this.values.get(keys[0]!)
      if (!current) return 1
      if ((JSON.parse(current) as { runtimeId?: unknown }).runtimeId !== args[0]) return 0
      this.values.delete(keys[0]!)
      return 1
    }
    if (script.includes('tty-session-active-execution-claim')) {
      const existing = this.values.get(keys[0]!)
      if (existing !== undefined) return [0, existing]
      this.values.set(keys[0]!, args[0]!)
      await this.sadd(keys[1]!, args[2]!)
      return [1, args[0]!]
    }
    if (script.includes('tty-session-active-execution-update')) {
      const current = this.values.get(keys[0]!)
      if (!current) return 0
      const parsed = JSON.parse(current) as { sessionId?: unknown; executionId?: unknown; token?: unknown }
      if (parsed.sessionId !== args[0] || parsed.executionId !== args[1] || parsed.token !== args[2]) return 0
      this.values.set(keys[0]!, args[3]!)
      await this.sadd(keys[1]!, args[0]!)
      return 1
    }
    if (script.includes('tty-session-active-execution-release')) {
      const current = this.values.get(keys[0]!)
      if (!current) {
        await this.srem(keys[1]!, args[0]!)
        return 1
      }
      const parsed = JSON.parse(current) as { sessionId?: unknown; executionId?: unknown }
      if (parsed.sessionId !== args[0] || parsed.executionId !== args[1]) return 0
      this.values.delete(keys[0]!)
      await this.srem(keys[1]!, args[0]!)
      return 1
    }
    if (script.includes('tty-live-publish')) {
      const sequence = await this.incr(keys[1]!)
      await this.xadd(keys[0]!, '*', {
        eventId: args[0]!,
        sequence: String(sequence),
        timestamp: args[1]!,
        executionId: args[2]!,
        sessionId: args[3]!,
        type: args[4]!,
        payload: args[5]!,
      })
      return sequence
    }
    if (script.includes('tty-output-append')) {
      const dedupKey = `${keys[2]}:${args[0]}`
      const existing = this.values.get(dedupKey)
      if (existing !== undefined) return Number(existing)
      const sequence = await this.incr(keys[1]!)
      await this.xadd(keys[0]!, '*', {
        eventId: args[0]!,
        sequence: String(sequence),
        timestamp: args[1]!,
        executionId: args[2]!,
        sessionId: args[3]!,
        type: args[4]!,
        data: args[5]!,
      })
      this.values.set(dedupKey, String(sequence))
      return sequence
    }
    if (script.includes('tty-session-transcript-append')) {
      const dedupKey = `${keys[2]}:${args[0]}`
      const existing = this.values.get(dedupKey)
      if (existing !== undefined) {
        const [sequence, cursor] = existing.split('|')
        return [Number(sequence), cursor]
      }
      const sequence = await this.incr(keys[1]!)
      const cursor = await this.xadd(keys[0]!, '*', {
        eventId: args[0]!,
        sequence: String(sequence),
        timestamp: args[1]!,
        sessionId: args[2]!,
        type: args[3]!,
        data: args[4]!,
      })
      this.values.set(dedupKey, `${sequence}|${cursor}`)
      return [sequence, cursor]
    }
    if (script.includes('tty-execution-state-transition')) {
      const raw = this.values.get(keys[0])
      if (args[0] === '__missing__') {
        if (raw) return [0, raw]
        this.values.set(keys[0], args[2])
        return [1, args[2]]
      }
      if (!raw) return [0, 'missing']
      const state = JSON.parse(raw) as { state: string }
      if (state.state !== args[0]) return [0, raw]
      this.values.set(keys[0], args[2])
      const active = this.sets.get(keys[1]) ?? new Set<string>()
      if (args[3] === '1') active.add(args[4])
      else active.delete(args[4])
      this.sets.set(keys[1], active)
      return [1, args[2]]
    }
    if (script.includes('tty-worker-register')) {
      if (this.values.has(keys[0])) return [0, 'duplicate_worker']
      this.values.set(keys[0], args[0])
      await this.sadd(keys[1], args[1])
      return [1, args[0]]
    }
    if (script.includes('tty-worker-update')) {
      const raw = this.values.get(keys[0])
      if (!raw) return [0, 'unknown_worker']
      const worker = JSON.parse(raw) as Record<string, unknown>
      const update = JSON.parse(args[0]) as Record<string, unknown>
      if (args[1] === '1') worker.version = update.version
      if (args[2] === '1') worker.capabilities = update.capabilities
      if (args[3] === '1') worker.metadata = update.metadata
      worker.updatedAt = args[4]
      const serialized = JSON.stringify(worker)
      this.values.set(keys[0], serialized)
      return [1, serialized]
    }
    if (script.includes('tty-worker-deactivate') || script.includes('tty-worker-reactivate')) {
      const raw = this.values.get(keys[0])
      if (!raw) return [0, 'unknown_worker']
      const worker = JSON.parse(raw) as Record<string, unknown>
      worker.updatedAt = args[0]
      if (script.includes('tty-worker-deactivate')) {
        worker.status = 'inactive'
        worker.deactivatedAt = args[0]
      } else {
        worker.status = 'active'
        worker.deactivatedAt = null
      }
      const serialized = JSON.stringify(worker)
      this.values.set(keys[0], serialized)
      return [1, serialized]
    }
    if (script.includes('tty-worker-record-heartbeat')) {
      const rawWorker = this.values.get(keys[0])
      if (!rawWorker) return [0, 'unknown_worker']
      const worker = JSON.parse(rawWorker) as Record<string, unknown>
      if (worker.status === 'inactive') return [0, 'inactive_worker']
      const oldRaw = this.values.get(keys[1])
      if (oldRaw && (JSON.parse(oldRaw) as { sequence: number }).sequence >= Number(args[2]))
        return [0, 'duplicate_heartbeat']
      this.values.set(keys[1], args[0])
      this.values.set(keys[2], args[1])
      if (worker.status === 'offline') {
        worker.status = 'active'
        worker.updatedAt = args[3]
        worker.deactivatedAt = null
        this.values.set(keys[0], JSON.stringify(worker))
      }
      return [1, `${args[0]}|${args[1]}`]
    }
    if (script.includes('tty-worker-mark-offline')) {
      const rawWorker = this.values.get(keys[0])
      if (!rawWorker) return [0, 'unknown_worker']
      const worker = JSON.parse(rawWorker) as Record<string, unknown>
      if (worker.status === 'inactive') return [0, 'inactive_worker']
      const heartbeatRaw = this.values.get(keys[1])
      if (
        heartbeatRaw &&
        Number(args[0]) - (JSON.parse(heartbeatRaw) as { receivedAtMs: number }).receivedAtMs <= Number(args[1])
      )
        return [0, 'not_stale']
      this.values.set(keys[2], args[2])
      worker.status = 'offline'
      worker.updatedAt = args[3]
      this.values.set(keys[0], JSON.stringify(worker))
      return [1, args[2]]
    }
    throw new Error(`Unsupported script: ${script.slice(0, 80)}`)
  }
}
