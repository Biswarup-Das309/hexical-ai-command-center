/**
 * Trusted worker-plane contracts for the TTY sandbox.
 *
 * These types are server-side contracts. Worker identity is opaque and
 * branded so a user/session identifier cannot be passed accidentally where
 * a trusted worker identifier is required.
 */

import type { TTYExecutionId, TTYSessionId } from './tty-types'

declare const ttyWorkerIdBrand: unique symbol
declare const ttyLeaseIdBrand: unique symbol

export type TTYWorkerId = string & { readonly [ttyWorkerIdBrand]: true }
export type TTYLeaseId = string & { readonly [ttyLeaseIdBrand]: true }

export const TTY_WORKER_CAPABILITIES = ['claim_lease', 'renew_lease', 'execute', 'persistent_pty'] as const

export type TTYWorkerCapability = (typeof TTY_WORKER_CAPABILITIES)[number]

export type TTYWorkerStatus = 'active' | 'offline' | 'inactive'
export type TTYWorkerHealthState = 'online' | 'offline'

export type TTYWorkerMetadataValue = string | number | boolean | null
export type TTYWorkerMetadataMap = Readonly<Record<string, TTYWorkerMetadataValue>>

/** Input used when a worker joins the trusted registry. */
export interface TTYWorkerRegistration {
  readonly workerId: TTYWorkerId
  /** Stable identity supplied by the worker installation, not its process id. */
  readonly identity: string
  readonly version: string
  readonly capabilities: readonly TTYWorkerCapability[]
  readonly metadata?: Readonly<Record<string, string>>
}

/** Canonical worker record persisted in Redis. */
export interface TTYWorkerMetadata {
  readonly workerId: TTYWorkerId
  readonly identity: string
  readonly version: string
  readonly capabilities: readonly TTYWorkerCapability[]
  readonly metadata: Readonly<Record<string, string>>
  readonly registeredAt: string
  readonly updatedAt: string
  readonly status: TTYWorkerStatus
  readonly deactivatedAt: string | null
}

export interface TTYWorkerUpdate {
  readonly version?: string
  readonly capabilities?: readonly TTYWorkerCapability[]
  readonly metadata?: Readonly<Record<string, string>>
}

export interface TTYWorkerHeartbeat {
  readonly workerId: TTYWorkerId
  readonly sequence: number
  readonly sentAt: string
  readonly receivedAt: string
  readonly receivedAtMs: number
  readonly latencyMs: number
}

export interface TTYWorkerHealth {
  readonly workerId: TTYWorkerId
  readonly state: TTYWorkerHealthState
  readonly lastHeartbeatAt: string | null
  readonly heartbeatLatencyMs: number | null
  readonly missedIntervals: number
  readonly healthScore: number
  readonly checkedAt: string
}

/** Context produced only after a worker token has been verified. */
export interface TTYWorkerAuthContext {
  readonly workerId: TTYWorkerId
  readonly capability: TTYWorkerCapability
  readonly tokenId: string
  readonly authenticatedAt: string
  readonly expiresAt: string
}

export type TTYWorkerExecutionState = 'queued' | 'leased' | 'abandoned' | 'expired'

/** Safe worker attribution exposed by the session store. Never includes a lease token. */
export interface TTYWorkerExecutionMetadata {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly workerId: TTYWorkerId | null
  readonly leaseId: TTYLeaseId | null
  readonly claimedAt: string | null
  readonly renewedAt: string | null
  readonly leaseAgeMs: number | null
  readonly executionState: TTYWorkerExecutionState
}

export function isTTYWorkerCapability(value: string): value is TTYWorkerCapability {
  return (TTY_WORKER_CAPABILITIES as readonly string[]).includes(value)
}

export function normalizeTTYWorkerCapabilities(
  capabilities: readonly TTYWorkerCapability[],
): readonly TTYWorkerCapability[] {
  return [...new Set(capabilities)].sort() as TTYWorkerCapability[]
}

export function parseTTYWorkerId(value: string): TTYWorkerId | null {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) return null
  return normalized as TTYWorkerId
}

export function createTTYWorkerId(value: string): TTYWorkerId {
  const workerId = parseTTYWorkerId(value)
  if (workerId === null) throw new Error('Invalid TTY worker identity.')
  return workerId
}

export function createTTYLeaseId(value: string): TTYLeaseId {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 256) throw new Error('Invalid TTY lease identity.')
  return normalized as TTYLeaseId
}
