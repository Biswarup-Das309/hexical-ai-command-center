/**
 * Normalizes Redis Stream responses across Redis clients.
 *
 * Redis itself returns XRANGE entries as `[id, fields]` tuples. The Upstash
 * REST client deserializes the same response into an object keyed by stream
 * ID (`{ [id]: fields }`) and JSON-decodes field values when possible. TTY
 * readers must accept both representations or production replay silently
 * becomes empty while the worker has actually persisted the events.
 */

export type TTYRedisStreamEntry = readonly [id: string, fields: unknown]

export function normalizeTTYRedisStreamEntries(value: unknown): readonly TTYRedisStreamEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry): TTYRedisStreamEntry[] => {
      if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') return []
      return [[entry[0], entry[1]]]
    })
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).map(([id, fields]) => [id, fields] as const)
}

export function normalizeTTYRedisStreamFields(value: unknown): Readonly<Record<string, unknown>> | null {
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) return null
    const fields: Record<string, unknown> = {}
    for (let index = 0; index < value.length; index += 2) {
      const key = value[index]
      if (typeof key !== 'string') return null
      fields[key] = value[index + 1]
    }
    return fields
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}
