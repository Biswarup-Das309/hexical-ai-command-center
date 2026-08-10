import {
  investigationBookmarkIndexKey,
  investigationCounterKey,
  investigationExecutionIndexKey,
  investigationExecutionKey,
  investigationOwnerIndexKey,
  investigationRecordKey,
  investigationSessionKey,
  investigationTimelineDedupeKey,
  investigationTimelineKey
} from './investigation-keys'
import type {
  InvestigationBookmark,
  InvestigationCreateInput,
  InvestigationExecution,
  InvestigationExecutionAttachmentInput,
  InvestigationHydration,
  InvestigationId,
  InvestigationNote,
  InvestigationPage,
  InvestigationPatchInput,
  InvestigationRecord,
  InvestigationTimelineEvent,
  InvestigationTimelineEventType
} from './investigation-types'
import { canTransitionInvestigationExecutionState } from './investigation-types'

const MAX_LIST_LIMIT = 50
const MAX_EXECUTION_LIMIT = 50
const MAX_TIMELINE_LIMIT = 100

export interface InvestigationRedis {
  readonly get: <T = unknown>(key: string) => Promise<T | null>
  readonly set: (key: string, value: unknown, options?: { readonly nx?: boolean }) => Promise<unknown>
  readonly del: (...keys: string[]) => Promise<number>
  readonly incr: (key: string) => Promise<number>
  readonly sadd: (key: string, member: string) => Promise<number>
  readonly srem: (key: string, member: string) => Promise<number>
  readonly zadd: (key: string, value: { readonly score: number; readonly member: string }) => Promise<number | null>
  readonly zrange: <T extends unknown[]>(key: string, min: number, max: number, options: { readonly rev?: boolean; readonly offset: number; readonly count: number }) => Promise<T>
  readonly zrem: (key: string, member: string) => Promise<number>
  readonly xadd: (key: string, id: '*', fields: Record<string, string>) => Promise<string>
  readonly xrange: (key: string, start: string, end: string, count?: number) => Promise<unknown>
}

interface StoredTimelineFields {
  readonly eventId: string
  readonly type: string
  readonly occurredAt: string
  readonly executionId: string
  readonly sequence: string
  readonly payload: string
}

export interface InvestigationStoreLogger {
  readonly warn: (message: string, metadata?: Record<string, unknown>) => void
  readonly error: (message: string, metadata?: Record<string, unknown>) => void
}

const NOOP_LOGGER: InvestigationStoreLogger = { warn: () => {}, error: () => {} }

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}

function safeCursor(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER)
}

function safeLimit(value: number | undefined, maximum: number): number {
  if (!Number.isSafeInteger(value) || value === undefined) return Math.min(20, maximum)
  return Math.max(1, Math.min(maximum, value))
}

function counterValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function isTimelineType(value: string): value is InvestigationTimelineEventType {
  return [
    'investigation_created',
    'investigation_renamed',
    'investigation_archived',
    'investigation_unarchived',
    'investigation_deleted',
    'execution_queued',
    'execution_started',
    'stdout',
    'stderr',
    'execution_completed',
    'execution_failed',
    'session_attached',
    'session_terminated',
    'evidence_bookmarked',
    'note_added',
    'note_edited',
    'note_deleted'
  ].includes(value as InvestigationTimelineEventType)
}

function parseTimelineFields(value: unknown): StoredTimelineFields | null {
  if (Array.isArray(value)) {
    const fields: Record<string, string> = {}
    for (let index = 0; index + 1 < value.length; index += 2) {
      if (typeof value[index] !== 'string') return null
      fields[value[index]] = String(value[index + 1])
    }
    return parseTimelineFields(fields)
  }
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.eventId !== 'string' || typeof fields.type !== 'string' || typeof fields.occurredAt !== 'string' || typeof fields.payload !== 'string') return null
  return {
    eventId: fields.eventId,
    type: fields.type,
    occurredAt: fields.occurredAt,
    executionId: typeof fields.executionId === 'string' ? fields.executionId : '',
    sequence: typeof fields.sequence === 'string' ? fields.sequence : '',
    payload: fields.payload
  }
}

function parseTimelineEntry(value: unknown, investigationId: InvestigationId): { readonly streamId: string; readonly event: InvestigationTimelineEvent } | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'string') return null
  const fields = parseTimelineFields(value[1])
  if (!fields || !isTimelineType(fields.type)) return null
  let payload: unknown
  try {
    payload = JSON.parse(fields.payload)
  } catch {
    payload = {}
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) payload = {}
  const sequence = fields.sequence === '' ? null : Number(fields.sequence)
  return {
    streamId: value[0],
    event: Object.freeze({
      eventId: fields.eventId,
      investigationId,
      type: fields.type,
      occurredAt: fields.occurredAt,
      executionId: fields.executionId || null,
      sequence: sequence !== null && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null,
      payload: payload as Readonly<Record<string, string | number | boolean | null>>
    })
  }
}

function parseTimelineEntries(raw: unknown, investigationId: InvestigationId): readonly { readonly streamId: string; readonly event: InvestigationTimelineEvent }[] {
  if (!Array.isArray(raw)) return []
  return raw.map(value => parseTimelineEntry(value, investigationId)).filter((value): value is { readonly streamId: string; readonly event: InvestigationTimelineEvent } => value !== null)
}

function toStoredExecution(input: InvestigationExecutionAttachmentInput, now: string): InvestigationExecution {
  return {
    executionId: input.executionId,
    sessionId: input.sessionId,
    state: 'queued',
    attachedAt: input.attachedAt ?? now,
    updatedAt: input.attachedAt ?? now,
    finishedAt: null,
    durationMs: null
  }
}

function isTerminalState(state: InvestigationExecution['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out' || state === 'expired'
}

export class InvestigationStore {
  private readonly logger: InvestigationStoreLogger

  constructor(private readonly redis: InvestigationRedis, options?: { readonly logger?: InvestigationStoreLogger }) {
    this.logger = options?.logger ?? NOOP_LOGGER
  }

  async create(ownerUserId: string, input: InvestigationCreateInput, now = new Date().toISOString()): Promise<InvestigationRecord> {
    const investigationId = crypto.randomUUID() as InvestigationId
    const record: InvestigationRecord = {
      investigationId,
      ownerUserId,
      title: input.title,
      description: input.description,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ttySessionId: null,
      executionCount: 0,
      evidenceCount: 0,
      findingCount: 0
    }

    const created = await this.redis.set(investigationRecordKey(investigationId), JSON.stringify(record), { nx: true })
    if (created === null) throw new Error('Investigation identifier collision.')
    try {
      await Promise.all([
        this.redis.zadd(investigationOwnerIndexKey(ownerUserId), { score: Date.parse(now), member: investigationId }),
        this.redis.set(investigationCounterKey(investigationId, 'executions'), '0'),
        this.redis.set(investigationCounterKey(investigationId, 'evidence'), '0'),
        this.redis.set(investigationCounterKey(investigationId, 'findings'), '0')
      ])
      await this.appendTimeline(investigationId, 'investigation_created', { title: input.title }, { dedupeKey: `created:${investigationId}`, occurredAt: now })
      return record
    } catch (error) {
      await this.removeInvestigationKeys(investigationId, ownerUserId)
      throw error
    }
  }

  async list(ownerUserId: string, options: { readonly cursor?: string | null; readonly limit?: number } = {}): Promise<InvestigationPage> {
    const offset = safeCursor(options.cursor)
    const limit = safeLimit(options.limit, MAX_LIST_LIMIT)
    const visible: InvestigationRecord[] = []
    let scanOffset = offset
    let pageEndCursor: number | null = null
    let hasMore = false

    while (true) {
      const ids = await this.redis.zrange<string[]>(investigationOwnerIndexKey(ownerUserId), 0, -1, { rev: true, offset: scanOffset, count: limit + 1 })
      if (ids.length === 0) break
      let retainedEntries = 0

      for (let index = 0; index < ids.length; index += 1) {
        const investigationId = ids[index]! as InvestigationId
        const record = await this.readRecord(investigationId, ownerUserId)
        if (!record || record.status === 'deleted') {
          await this.redis.zrem(investigationOwnerIndexKey(ownerUserId), investigationId)
          continue
        }
        retainedEntries += 1
        if (visible.length < limit) {
          visible.push(record)
          if (visible.length === limit) pageEndCursor = scanOffset + retainedEntries
          continue
        }
        hasMore = true
        break
      }

      if (hasMore) break
      scanOffset += retainedEntries
      if (ids.length < limit + 1) break
    }

    return { investigations: visible, nextCursor: hasMore && pageEndCursor !== null ? String(pageEndCursor) : null }
  }

  async get(ownerUserId: string, investigationId: InvestigationId, options: { readonly timelineCursor?: string | null; readonly timelineLimit?: number; readonly executionCursor?: string | null; readonly executionLimit?: number } = {}): Promise<InvestigationHydration | null> {
    const investigation = await this.readRecord(investigationId, ownerUserId)
    if (!investigation || investigation.status === 'deleted') return null

    const executionOffset = safeCursor(options.executionCursor)
    const executionLimit = safeLimit(options.executionLimit, MAX_EXECUTION_LIMIT)
    const timelineLimit = safeLimit(options.timelineLimit, MAX_TIMELINE_LIMIT)
    const [executionIds, timelineRaw, bookmarkRaw] = await Promise.all([
      this.redis.zrange<string[]>(investigationExecutionIndexKey(investigationId), 0, -1, { rev: true, offset: executionOffset, count: executionLimit + 1 }),
      this.redis.xrange(investigationTimelineKey(investigationId), options.timelineCursor ? `(${options.timelineCursor}` : '-', '+', timelineLimit + 1),
      this.redis.zrange<string[]>(investigationBookmarkIndexKey(investigationId), 0, -1, { rev: true, offset: 0, count: 500 })
    ])
    const executions = await Promise.all(executionIds.map(executionId => this.readExecution(investigationId, executionId)))
    const parsedTimeline = parseTimelineEntries(timelineRaw, investigationId)
    const visibleExecutions = executions.filter((execution): execution is InvestigationExecution => execution !== null).slice(0, executionLimit)
    const hasMoreExecutions = executionIds.length > executionLimit
    const hasMoreTimeline = parsedTimeline.length > timelineLimit
    const timeline = parsedTimeline.slice(0, timelineLimit)
    return {
      investigation,
      executions: visibleExecutions,
      timeline: timeline.map(entry => entry.event),
      bookmarks: bookmarkRaw.map(value => parseJson<InvestigationBookmark>(value)).filter((value): value is InvestigationBookmark => value !== null),
      notes: this.notesFromTimeline(timeline.map(entry => entry.event)),
      nextTimelineCursor: hasMoreTimeline ? timeline.at(-1)?.streamId ?? null : null,
      nextExecutionCursor: hasMoreExecutions ? String(executionOffset + executionLimit) : null
    }
  }

  async patch(ownerUserId: string, investigationId: InvestigationId, input: InvestigationPatchInput, now = new Date().toISOString()): Promise<InvestigationRecord | null> {
    const current = await this.readRecord(investigationId, ownerUserId)
    if (!current || current.status === 'deleted') return null
    const nextStatus = input.status ?? current.status
    const next: InvestigationRecord = {
      ...current,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      status: nextStatus,
      updatedAt: now,
      archivedAt: nextStatus === 'archived' ? current.archivedAt ?? now : null
    }
    await this.redis.set(investigationRecordKey(investigationId), JSON.stringify(next))
    if (next.title !== current.title) {
      await this.appendTimeline(investigationId, 'investigation_renamed', { title: next.title }, { dedupeKey: `rename:${now}:${next.title}`, occurredAt: now })
    }
    if (next.status !== current.status) {
      await this.appendTimeline(investigationId, next.status === 'archived' ? 'investigation_archived' : 'investigation_unarchived', {}, { dedupeKey: `status:${now}:${next.status}`, occurredAt: now })
    }
    return this.readRecord(investigationId, ownerUserId)
  }

  async delete(ownerUserId: string, investigationId: InvestigationId, now = new Date().toISOString()): Promise<boolean> {
    const current = await this.readRecord(investigationId, ownerUserId)
    if (!current || current.status === 'deleted') return false
    const deleted: InvestigationRecord = { ...current, status: 'deleted', updatedAt: now, archivedAt: current.archivedAt ?? now }
    await this.redis.set(investigationRecordKey(investigationId), JSON.stringify(deleted))
    await this.appendTimeline(investigationId, 'investigation_deleted', {}, { dedupeKey: `deleted:${now}`, occurredAt: now })
    await this.redis.zrem(investigationOwnerIndexKey(ownerUserId), investigationId)
    await this.redis.del(investigationSessionKey(investigationId))
    return true
  }

  async attachSession(ownerUserId: string, investigationId: InvestigationId, sessionId: string, now = new Date().toISOString()): Promise<InvestigationRecord | null> {
    const current = await this.readRecord(investigationId, ownerUserId)
    if (!current || current.status === 'deleted') return null
    if (current.ttySessionId) return current

    const sessionKey = investigationSessionKey(investigationId)
    const inserted = await this.redis.set(sessionKey, sessionId, { nx: true })
    const persistedSessionId = inserted === null ? await this.redis.get<string>(sessionKey) : sessionId
    if (!persistedSessionId) return null
    if (current.ttySessionId === persistedSessionId) return current

    const next: InvestigationRecord = { ...current, ttySessionId: persistedSessionId, updatedAt: now }
    await this.redis.set(investigationRecordKey(investigationId), JSON.stringify(next))
    await this.appendTimeline(investigationId, 'session_attached', { sessionId: persistedSessionId }, { dedupeKey: `session-attached:${persistedSessionId}`, occurredAt: now })
    return next
  }

  async clearSession(ownerUserId: string, investigationId: InvestigationId, now = new Date().toISOString()): Promise<InvestigationRecord | null> {
    const current = await this.readRecord(investigationId, ownerUserId)
    if (!current || current.status === 'deleted') return null
    if (!current.ttySessionId) return current
    const sessionId = current.ttySessionId
    const next: InvestigationRecord = { ...current, ttySessionId: null, updatedAt: now }
    await Promise.all([
      this.redis.set(investigationRecordKey(investigationId), JSON.stringify(next)),
      this.redis.del(investigationSessionKey(investigationId))
    ])
    await this.appendTimeline(investigationId, 'session_terminated', { sessionId }, { dedupeKey: `session-terminated:${sessionId}`, occurredAt: now })
    return next
  }

  async attachExecution(ownerUserId: string, investigationId: InvestigationId, input: InvestigationExecutionAttachmentInput): Promise<InvestigationExecution | null> {
    const investigation = await this.readRecord(investigationId, ownerUserId)
    if (!investigation || investigation.status === 'deleted') return null
    const now = input.attachedAt ?? new Date().toISOString()
    const execution = toStoredExecution(input, now)
    const created = await this.redis.set(investigationExecutionKey(investigationId, input.executionId), JSON.stringify(execution), { nx: true })
    if (created === null) return this.readExecution(investigationId, input.executionId)
    await Promise.all([
      this.redis.zadd(investigationExecutionIndexKey(investigationId), { score: Date.parse(now), member: input.executionId }),
      this.redis.incr(investigationCounterKey(investigationId, 'executions'))
    ])
    await this.refreshCounts(investigationId, ownerUserId)
    await this.appendTimeline(investigationId, 'execution_queued', { sessionId: input.sessionId }, { executionId: input.executionId, dedupeKey: `execution-queued:${input.executionId}`, occurredAt: now })
    return execution
  }

  async updateExecution(ownerUserId: string, investigationId: InvestigationId, executionId: string, state: InvestigationExecution['state'], fields: { readonly updatedAt?: string; readonly finishedAt?: string | null; readonly durationMs?: number | null; readonly sessionId?: string } = {}): Promise<InvestigationExecution | null> {
    const investigation = await this.readRecord(investigationId, ownerUserId)
    if (!investigation || investigation.status === 'deleted') return null
    const current = await this.readExecution(investigationId, executionId)
    if (!current) return null
    if (!canTransitionInvestigationExecutionState(current.state, state)) return current
    const updatedAt = fields.updatedAt ?? new Date().toISOString()
    const next: InvestigationExecution = {
      ...current,
      sessionId: fields.sessionId ?? current.sessionId,
      state,
      updatedAt,
      finishedAt: fields.finishedAt === undefined ? (isTerminalState(state) ? current.finishedAt ?? updatedAt : current.finishedAt) : fields.finishedAt,
      durationMs: fields.durationMs === undefined ? current.durationMs : fields.durationMs
    }
    await this.redis.set(investigationExecutionKey(investigationId, executionId), JSON.stringify(next))
    const eventType: InvestigationTimelineEventType = state === 'running' || state === 'streaming' ? 'execution_started' : isTerminalState(state) ? state === 'succeeded' ? 'execution_completed' : 'execution_failed' : 'execution_queued'
    const dedupeKey = eventType === 'execution_started' ? `execution-started:${executionId}` : eventType === 'execution_completed' || eventType === 'execution_failed' ? `execution-terminal:${executionId}:${state}` : state === 'queued' ? `execution-queued:${executionId}` : `execution-state:${executionId}:${state}:${updatedAt}`
    await this.appendTimeline(investigationId, eventType, { state }, { executionId, dedupeKey, occurredAt: updatedAt })
    return next
  }

  async recordBookmark(ownerUserId: string, investigationId: InvestigationId, bookmark: Omit<InvestigationBookmark, 'bookmarkId' | 'createdAt'>, now = new Date().toISOString()): Promise<InvestigationTimelineEvent | null> {
    if (!(await this.readRecord(investigationId, ownerUserId))) return null
    const bookmarkId = crypto.randomUUID()
    const event = await this.appendTimeline(investigationId, 'evidence_bookmarked', { bookmarkId, ...bookmark, createdAt: now }, { executionId: bookmark.executionId, dedupeKey: `bookmark:${bookmark.executionId}:${bookmark.sequence}:${bookmark.kind}`, occurredAt: now })
    if (event) {
      await this.redis.zadd(investigationBookmarkIndexKey(investigationId), { score: Date.parse(now), member: JSON.stringify({ bookmarkId, ...bookmark, createdAt: now }) })
      await this.redis.incr(investigationCounterKey(investigationId, 'evidence'))
      await this.refreshCounts(investigationId, ownerUserId)
    }
    return event
  }

  async recordNote(ownerUserId: string, investigationId: InvestigationId, body: string, now = new Date().toISOString()): Promise<InvestigationTimelineEvent | null> {
    if (!(await this.readRecord(investigationId, ownerUserId))) return null
    const noteId = crypto.randomUUID()
    return this.appendTimeline(investigationId, 'note_added', { noteId, body }, { dedupeKey: `note:${noteId}`, occurredAt: now })
  }

  async updateNote(ownerUserId: string, investigationId: InvestigationId, noteId: string, body: string, now = new Date().toISOString()): Promise<InvestigationTimelineEvent | null> {
    if (!(await this.findNote(ownerUserId, investigationId, noteId))) return null
    return this.appendTimeline(investigationId, 'note_edited', { noteId, body }, { dedupeKey: `note-edit:${noteId}:${now}:${body}`, occurredAt: now })
  }

  async deleteNote(ownerUserId: string, investigationId: InvestigationId, noteId: string, now = new Date().toISOString()): Promise<InvestigationTimelineEvent | null> {
    if (!(await this.findNote(ownerUserId, investigationId, noteId))) return null
    return this.appendTimeline(investigationId, 'note_deleted', { noteId }, { dedupeKey: `note-delete:${noteId}:${now}`, occurredAt: now })
  }

  async recordExecutionEvent(ownerUserId: string, investigationId: InvestigationId, event: { readonly type: Extract<InvestigationTimelineEventType, 'execution_started' | 'stdout' | 'stderr' | 'execution_completed' | 'execution_failed'>; readonly executionId: string; readonly sequence?: number; readonly occurredAt?: string; readonly payload?: Readonly<Record<string, string | number | boolean | null>> }): Promise<InvestigationTimelineEvent | null> {
    if (!(await this.readRecord(investigationId, ownerUserId))) return null
    const occurredAt = event.occurredAt ?? new Date().toISOString()
    const dedupeKey = event.type === 'execution_started' ? `execution-started:${event.executionId}` : event.type === 'execution_completed' || event.type === 'execution_failed' ? `execution-terminal:${event.executionId}:${String(event.payload?.state ?? event.type)}` : `execution-event:${event.executionId}:${event.sequence ?? occurredAt}:${event.type}`
    return this.appendTimeline(investigationId, event.type, event.payload ?? {}, { executionId: event.executionId, sequence: event.sequence, dedupeKey, occurredAt })
  }

  private async appendTimeline(investigationId: InvestigationId, type: InvestigationTimelineEventType, payload: Readonly<Record<string, string | number | boolean | null>>, options: { readonly dedupeKey: string; readonly occurredAt?: string; readonly executionId?: string; readonly sequence?: number }): Promise<InvestigationTimelineEvent | null> {
    const inserted = await this.redis.sadd(investigationTimelineDedupeKey(investigationId), options.dedupeKey)
    if (inserted === 0) return null
    const event: InvestigationTimelineEvent = Object.freeze({
      eventId: crypto.randomUUID(),
      investigationId,
      type,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      executionId: options.executionId ?? null,
      sequence: options.sequence ?? null,
      payload: Object.freeze({ ...payload })
    })
    try {
      await this.redis.xadd(investigationTimelineKey(investigationId), '*', {
        eventId: event.eventId,
        type: event.type,
        occurredAt: event.occurredAt,
        executionId: event.executionId ?? '',
        sequence: event.sequence === null ? '' : String(event.sequence),
        payload: JSON.stringify(event.payload)
      })
      return event
    } catch (error) {
      await this.redis.srem(investigationTimelineDedupeKey(investigationId), options.dedupeKey).catch(() => {})
      this.logger.error('investigation.timeline_append_failed', { investigationId, type })
      throw error
    }
  }

  private async readRecord(investigationId: InvestigationId, ownerUserId: string): Promise<InvestigationRecord | null> {
    const raw = parseJson<InvestigationRecord>(await this.redis.get(investigationRecordKey(investigationId)))
    if (!raw || raw.ownerUserId !== ownerUserId) return null
    const [executions, evidence, findings] = await Promise.all([
      this.redis.get(investigationCounterKey(investigationId, 'executions')),
      this.redis.get(investigationCounterKey(investigationId, 'evidence')),
      this.redis.get(investigationCounterKey(investigationId, 'findings'))
    ])
    return Object.freeze({ ...raw, ttySessionId: typeof raw.ttySessionId === 'string' ? raw.ttySessionId : null, executionCount: counterValue(executions ?? raw.executionCount), evidenceCount: counterValue(evidence ?? raw.evidenceCount), findingCount: counterValue(findings ?? raw.findingCount) })
  }

  private async readExecution(investigationId: InvestigationId, executionId: string): Promise<InvestigationExecution | null> {
    return parseJson<InvestigationExecution>(await this.redis.get(investigationExecutionKey(investigationId, executionId)))
  }

  private async refreshCounts(investigationId: InvestigationId, ownerUserId: string): Promise<void> {
    const current = await this.readRecord(investigationId, ownerUserId)
    if (!current) return
    await this.redis.set(investigationRecordKey(investigationId), JSON.stringify(current))
  }

  private async removeInvestigationKeys(investigationId: InvestigationId, ownerUserId: string): Promise<void> {
    await Promise.all([
      this.redis.del(investigationRecordKey(investigationId)),
      this.redis.zrem(investigationOwnerIndexKey(ownerUserId), investigationId),
      this.redis.del(
        investigationCounterKey(investigationId, 'executions'),
        investigationCounterKey(investigationId, 'evidence'),
        investigationCounterKey(investigationId, 'findings'),
        investigationTimelineKey(investigationId),
        investigationTimelineDedupeKey(investigationId),
        investigationBookmarkIndexKey(investigationId),
        investigationSessionKey(investigationId)
      )
    ])
  }

  private notesFromTimeline(events: readonly InvestigationTimelineEvent[]): readonly InvestigationNote[] {
    const notes = new Map<string, InvestigationNote>()
    for (const event of events) {
      const noteId = String(event.payload.noteId ?? '')
      if (!noteId) continue
      if (event.type === 'note_added') {
        notes.set(noteId, { noteId, body: String(event.payload.body ?? ''), createdAt: event.occurredAt })
      } else if (event.type === 'note_edited') {
        const current = notes.get(noteId)
        if (current) notes.set(noteId, { ...current, body: String(event.payload.body ?? '') })
      } else if (event.type === 'note_deleted') {
        notes.delete(noteId)
      }
    }
    return [...notes.values()]
  }

  private async findNote(ownerUserId: string, investigationId: InvestigationId, noteId: string): Promise<InvestigationNote | null> {
    const investigation = await this.readRecord(investigationId, ownerUserId)
    if (!investigation || investigation.status === 'deleted') return null
    const raw = await this.redis.xrange(investigationTimelineKey(investigationId), '-', '+')
    return this.notesFromTimeline(parseTimelineEntries(raw, investigationId).map(entry => entry.event)).find(note => note.noteId === noteId) ?? null
  }

  /**
   * Diagnostic-only read that bypasses the owner filter. Never used for authorization
   * or returned to a client — its only purpose is to let a 404 be categorized in logs
   * as absent / owned-by-someone-else / deleted / present-but-unresolved, so a resolver
   * failure that has no innocent explanation (present, owned, active, still not resolved)
   * is distinguishable in production from the explained cases.
   */
  async diagnoseAbsence(investigationId: InvestigationId, ownerUserId: string): Promise<{ readonly present: boolean; readonly ownerMatches: boolean; readonly status: InvestigationRecord['status'] | null }> {
    const raw = parseJson<InvestigationRecord>(await this.redis.get(investigationRecordKey(investigationId)))
    return raw ? { present: true, ownerMatches: raw.ownerUserId === ownerUserId, status: raw.status } : { present: false, ownerMatches: false, status: null }
  }
}
