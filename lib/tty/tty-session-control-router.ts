/** Durable worker-affinity router for persistent PTY control commands. */

import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import type { TTYSessionControlEntry, TTYSessionControlHandler } from './tty-session-control'
import { ttySessionRuntimeKey, ttyWorkerSessionControlStreamKey } from './tty-worker-keys'
import { parseTTYWorkerId, type TTYWorkerId } from './tty-worker-types'

const CONTROL_STREAM_RETENTION_SECONDS = 7 * 24 * 60 * 60

export interface TTYSessionControlRouterLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
}

interface RuntimeAssignment {
  readonly sessionId: string
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly state: 'provisioning' | 'active'
}

const NOOP_LOGGER: TTYSessionControlRouterLogger = { info: () => {}, warn: () => {} }

function parseAssignment(value: unknown): RuntimeAssignment | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const workerId = typeof record.workerId === 'string' ? parseTTYWorkerId(record.workerId) : null
    if (
      typeof record.sessionId !== 'string' ||
      typeof record.ownerUserId !== 'string' ||
      workerId === null ||
      (record.state !== 'provisioning' && record.state !== 'active')
    )
      return null
    return {
      sessionId: record.sessionId,
      ownerUserId: record.ownerUserId,
      workerId,
      state: record.state,
    }
  } catch {
    return null
  }
}

function fieldsFor(command: TTYSessionControlEntry): Record<string, string> {
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    ownerUserId: command.ownerUserId,
    type: command.type,
    timestamp: command.timestamp,
    ...(command.data !== undefined ? { data: command.data } : {}),
    ...(command.columns !== undefined ? { columns: String(command.columns) } : {}),
    ...(command.rows !== undefined ? { rows: String(command.rows) } : {}),
  }
}

/**
 * The global stream is the admission boundary. Once a runtime lease exists,
 * commands are durably forwarded to that worker's stream before the global
 * entry is acknowledged by its consumer.
 */
export class TTYSessionControlRouter implements TTYSessionControlHandler {
  private readonly logger: TTYSessionControlRouterLogger

  constructor(
    private readonly redis: Redis,
    private readonly workerId: TTYWorkerId,
    private readonly local: TTYSessionControlHandler,
    options: { readonly logger?: TTYSessionControlRouterLogger } = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER
  }

  async handle(command: TTYSessionControlEntry): Promise<void> {
    const assignment = parseAssignment(await this.redis.get<unknown>(ttySessionRuntimeKey(command.sessionId)))
    if (
      assignment !== null &&
      assignment.sessionId === command.sessionId &&
      assignment.ownerUserId === command.ownerUserId &&
      assignment.workerId !== this.workerId
    ) {
      const targetStream = ttyWorkerSessionControlStreamKey(assignment.workerId)
      await this.redis.xadd(targetStream, '*', fieldsFor(command))
      await this.redis.expire(targetStream, CONTROL_STREAM_RETENTION_SECONDS)
      this.logger.info('session_control_forwarded', {
        sessionId: command.sessionId,
        targetWorkerId: assignment.workerId,
        commandType: command.type,
      })
      return
    }
    await this.local.handle(command)
  }
}

export function parseTTYSessionRuntimeAssignment(value: unknown): {
  readonly workerId: TTYWorkerId
  readonly state: RuntimeAssignment['state']
} | null {
  const assignment = parseAssignment(value)
  return assignment === null ? null : { workerId: assignment.workerId, state: assignment.state }
}
