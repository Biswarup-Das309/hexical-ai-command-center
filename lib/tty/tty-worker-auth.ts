import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendTTYWorkerAuditEvent, type TTYWorkerAuditSink } from './tty-worker-audit'
import type { TTYWorkerRegistry } from './tty-worker-registry'
import {
  parseTTYWorkerId,
  isTTYWorkerCapability,
  type TTYWorkerAuthContext,
  type TTYWorkerCapability,
  type TTYWorkerId,
} from './tty-worker-types'

const TOKEN_VERSION = 'v1'
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000
const MIN_SECRET_LENGTH = 32

interface WorkerTokenPayload {
  readonly version: typeof TOKEN_VERSION
  readonly workerId: string
  readonly capability: TTYWorkerCapability
  readonly tokenId: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}

export type TTYWorkerAuthFailureReason =
  | 'invalid_token'
  | 'expired_token'
  | 'unknown_worker'
  | 'inactive_worker'
  | 'offline_worker'
  | 'capability_mismatch'

export type TTYWorkerAuthResult =
  | { readonly authenticated: true; readonly context: TTYWorkerAuthContext }
  | { readonly authenticated: false; readonly reason: TTYWorkerAuthFailureReason }

interface WorkerTokenOptions {
  readonly now?: () => number
  readonly ttlMs?: number
  readonly tokenId?: string
}

interface AuthDependencies {
  readonly now?: () => Date
  readonly audit?: TTYWorkerAuditSink
}

export function issueTTYWorkerToken(
  workerId: TTYWorkerId,
  capability: TTYWorkerCapability,
  secret: string,
  options: WorkerTokenOptions = {},
): string {
  assertSecret(secret)
  if (parseTTYWorkerId(workerId) === null || !isTTYWorkerCapability(capability))
    throw new Error('Invalid TTY worker token subject.')
  const nowMs = options.now?.() ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 365 * 24 * 60 * 60 * 1000)
    throw new Error('Invalid TTY worker token lifetime.')
  const payload: WorkerTokenPayload = {
    version: TOKEN_VERSION,
    workerId,
    capability,
    tokenId: options.tokenId ?? crypto.randomUUID(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  }
  const encodedPayload = encode(JSON.stringify(payload))
  return `${encodedPayload}.${sign(encodedPayload, secret)}`
}

export type TTYWorkerTokenVerification =
  | {
      readonly valid: true
      readonly workerId: TTYWorkerId
      readonly capability: TTYWorkerCapability
      readonly tokenId: string
      readonly issuedAtMs: number
      readonly expiresAtMs: number
    }
  | { readonly valid: false; readonly reason: 'invalid_token' | 'expired_token' }

export function verifyWorkerToken(
  token: string,
  secret: string,
  now: () => number = () => Date.now(),
): TTYWorkerTokenVerification {
  try {
    assertSecret(secret)
    const parts = token.split('.')
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) return { valid: false, reason: 'invalid_token' }
    const [encodedPayload, suppliedSignature] = parts
    const expectedSignature = sign(encodedPayload, secret)
    const supplied = Buffer.from(suppliedSignature)
    const expected = Buffer.from(expectedSignature)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return { valid: false, reason: 'invalid_token' }
    const parsed: unknown = JSON.parse(decode(encodedPayload))
    if (typeof parsed !== 'object' || parsed === null) return { valid: false, reason: 'invalid_token' }
    const record = parsed as Record<string, unknown>
    const workerId = typeof record.workerId === 'string' ? parseTTYWorkerId(record.workerId) : null
    const capability =
      typeof record.capability === 'string' && isTTYWorkerCapability(record.capability) ? record.capability : null
    const issuedAtMs = typeof record.issuedAtMs === 'number' ? record.issuedAtMs : null
    const expiresAtMs = typeof record.expiresAtMs === 'number' ? record.expiresAtMs : null
    if (
      record.version !== TOKEN_VERSION ||
      workerId === null ||
      capability === null ||
      typeof record.tokenId !== 'string' ||
      issuedAtMs === null ||
      expiresAtMs === null ||
      !Number.isSafeInteger(issuedAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= issuedAtMs
    )
      return { valid: false, reason: 'invalid_token' }
    const nowMs = now()
    if (!Number.isSafeInteger(nowMs)) return { valid: false, reason: 'invalid_token' }
    if (nowMs >= expiresAtMs) return { valid: false, reason: 'expired_token' }
    return {
      valid: true,
      workerId,
      capability,
      tokenId: record.tokenId,
      issuedAtMs,
      expiresAtMs,
    }
  } catch {
    return { valid: false, reason: 'invalid_token' }
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
    throw new Error('TTY worker token secret is too short.')
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function rejectInactiveWorker(status: 'active' | 'offline' | 'inactive'): TTYWorkerAuthFailureReason | null {
  if (status === 'inactive') return 'inactive_worker'
  if (status === 'offline') return 'offline_worker'
  return null
}

export class TTYWorkerAuthenticator {
  private readonly now: () => Date

  constructor(
    private readonly registry: Pick<TTYWorkerRegistry, 'getWorker'>,
    private readonly secret: string,
    private readonly options: AuthDependencies = {},
  ) {
    assertSecret(secret)
    this.now = options.now ?? (() => new Date())
  }

  async authenticateWorker(token: string, requiredCapability?: TTYWorkerCapability): Promise<TTYWorkerAuthResult> {
    const verification = verifyWorkerToken(token, this.secret, () => this.now().getTime())
    if (!verification.valid) return { authenticated: false, reason: verification.reason }
    const context = await this.resolveWorkerContext(verification, requiredCapability)
    if (!context.authenticated) return context
    await this.emitAuthenticated(context.context)
    return context
  }

  async resolveWorkerContext(
    verification: Extract<TTYWorkerTokenVerification, { valid: true }>,
    requiredCapability?: TTYWorkerCapability,
  ): Promise<TTYWorkerAuthResult> {
    const worker = await this.registry.getWorker(verification.workerId)
    if (worker === null) return { authenticated: false, reason: 'unknown_worker' }
    const inactiveReason = rejectInactiveWorker(worker.status)
    if (inactiveReason !== null) return { authenticated: false, reason: inactiveReason }
    if (
      !worker.capabilities.includes(verification.capability) ||
      (requiredCapability !== undefined &&
        verification.capability !== requiredCapability &&
        verification.capability !== 'execute')
    ) {
      return { authenticated: false, reason: 'capability_mismatch' }
    }
    const authenticatedAt = this.now().toISOString()
    return {
      authenticated: true,
      context: {
        workerId: verification.workerId,
        capability: verification.capability,
        tokenId: verification.tokenId,
        authenticatedAt,
        expiresAt: new Date(verification.expiresAtMs).toISOString(),
      },
    }
  }

  async rejectUnknownWorker(workerId: TTYWorkerId): Promise<TTYWorkerAuthResult | null> {
    return (await this.registry.getWorker(workerId)) === null
      ? { authenticated: false, reason: 'unknown_worker' }
      : null
  }

  private async emitAuthenticated(context: TTYWorkerAuthContext): Promise<void> {
    if (!this.options.audit) return
    try {
      await appendTTYWorkerAuditEvent(this.options.audit, {
        eventType: 'worker_authenticated',
        timestamp: context.authenticatedAt,
        workerId: context.workerId,
        metadata: { capability: context.capability, tokenId: context.tokenId },
      })
    } catch {
      // Authentication state is derived from the signed token and registry;
      // audit failure never turns a valid authentication into a fail-open one.
    }
  }
}
