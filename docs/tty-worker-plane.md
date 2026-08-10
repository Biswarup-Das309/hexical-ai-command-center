# Hexical AI TTY Trusted Worker Plane

Phase 1.8 adds a trusted worker control plane around the existing TTY session, admission, and lease subsystems. It does not execute commands. Its responsibility is to establish worker identity, authenticate lease owners, track liveness, expose lease attribution, and retain an append-only audit trail for the future sandbox runtime.

## Architecture

The control plane is Redis-backed and dependency-injected, matching the existing TTY session store and lease manager.

1. A worker registers a stable worker ID, installation identity, semantic version, and capabilities in `TTYWorkerRegistry`.
2. The worker receives an HMAC-signed, time-limited token. `TTYWorkerAuthenticator` verifies token integrity and expiration, then resolves the worker against the registry.
3. Worker API handlers pass requests through `createTTYWorkerMiddleware`; requests without a valid bearer token are rejected.
4. Authenticated workers send monotonic heartbeats. `TTYWorkerHeartbeatService` stores the latest accepted sequence, derives health, and transitions stale workers offline.
5. `TTYExecutionLeaseManager` accepts only an authenticated worker context. Its Redis scripts atomically fence claims, renewals, releases, expiration recovery, and active-lease indexes.
6. `TTYWorkerLeaseObserver` reads the job record as the source of truth and maintains worker-facing lease observations. The session store exposes the same attribution without returning lease tokens.
7. `TTYWorkerAudit` appends immutable structured events to a Redis Stream.

## Worker lifecycle

```text
register -> active -> heartbeat/online
                    |          |
                    |          +--> lease claim / renew / release
                    v
                  offline -- heartbeat recovery --> active

active -- administrative deactivation --> inactive
inactive -- administrative reactivation --> active
```

An inactive worker cannot authenticate or record heartbeats. An offline worker may recover by sending a newer heartbeat, but it cannot claim or renew work while its signed context is expired. Lease expiration is fenced by the Redis job record and is recovered through the existing retry ceiling.

## Redis schema

| Key                                   | Type         | Purpose                                                                                                   |
| ------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `tty:workers:registry`                | Set          | Registered worker IDs.                                                                                    |
| `tty:worker:{workerId}:metadata`      | JSON string  | Identity, version, capabilities, immutable `registeredAt`, current status, and update timestamps.         |
| `tty:worker:{workerId}:heartbeat`     | JSON string  | Latest accepted heartbeat sequence, send/receive timestamps, and latency.                                 |
| `tty:worker:{workerId}:health`        | JSON string  | Derived online/offline state, missed intervals, score, and check time.                                    |
| `tty:worker:{workerId}:active-leases` | Set          | Execution IDs currently attributed to that worker. Stale members are reconciled against job records.      |
| `tty:workers:active-lease-index`      | Set          | Global `workerId                                                                                          | executionId` reconciliation index. |
| `tty:workers:audit`                   | Redis Stream | Append-only structured worker events.                                                                     |
| `tty:job:{executionId}`               | JSON string  | Existing execution job record, now containing authenticated worker lease identity and renewal timestamps. |

Registration, worker state changes, heartbeat acceptance, and lease transitions use Redis scripts or single Redis commands so competing instances cannot overwrite immutable identity or double-claim a job.

## Security model

- Worker IDs are branded and runtime-validated. User IDs and session IDs cannot be passed silently as worker identities.
- Registration identity and `registeredAt` are immutable. Updates can change only version, capabilities, and descriptive metadata.
- Tokens use HMAC-SHA256 over a versioned payload containing worker ID, capability, token ID, issue time, and expiry. The signing secret must be at least 32 characters.
- Authentication fails closed for malformed, tampered, expired, unknown, inactive, offline, or capability-incompatible workers.
- `execute` is the worker runtime capability and authorizes both lease claim and renewal. Narrow `claim_lease` and `renew_lease` capabilities can be used for specialized workers.
- Lease ownership requires a verified `TTYWorkerAuthContext`; anonymous or expired contexts are rejected before the Redis lease script runs.
- Lease tokens never appear in browser-safe job/session projections or worker-aware session metadata.
- Audit events contain complete nullable ID fields for a stable replay shape, but do not contain lease tokens.

## Failure modes and recovery

| Failure                     | Behavior                                                                                          | Recovery                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Duplicate registration      | Atomic registry script returns `duplicate_worker`; existing metadata is unchanged.                | Inspect the existing worker or choose a new ID.                                  |
| Invalid token or capability | Middleware returns a generic authentication failure.                                              | Obtain a new token with the required capability.                                 |
| Missed heartbeats           | Health score decreases deterministically; after `offlineAfterMs`, worker status becomes offline.  | Send a newer heartbeat; status returns active.                                   |
| Worker crash during a lease | Lease remains fenced by expiry; no second worker can claim it before recovery.                    | A recovery worker calls `recover`; retry ceiling prevents infinite resurrection. |
| Redis outage/partition      | Reads return no trusted state and mutations fail closed.                                          | Retry after Redis reconnects; no in-memory state is promoted to authority.       |
| Observer index drift        | Job records remain authoritative. Listing a worker's leases prunes missing or mismatched members. | Reconciliation restores the active-lease index.                                  |
| Audit append failure        | State mutation remains authoritative and callers can replay/retry audit emission.                 | Monitor append failures and repair from the state transition source.             |

## Integration points

- `tty-execution-admission.ts` keeps user admission and worker ownership separate. It exposes `hasAuthenticatedTTYLeaseCapability` as the shared ownership gate.
- `tty-execution-lease.ts` takes an authenticated worker context, adds `leaseId` and `renewedAtMs`, and atomically maintains worker lease indexes.
- `tty-session-store.ts` exposes `getWorkerExecutionMetadata(sessionId, ownerUserId)`, returning safe attribution and no secrets.
- `tty-worker-middleware.ts` is transport-neutral and can be used by worker-only API routes or a future internal gateway.
- No additional server singleton is introduced; deployments inject the existing Redis client, registry, authenticator, heartbeat service, observer, and audit sink into their worker route layer.

## Operational monitoring

Monitor:

- registry size and registration failures;
- authentication failure reasons, without logging tokens;
- heartbeat latency, missed intervals, health score, and offline transitions;
- active lease count by worker and stale-index reconciliation count;
- lease claim/renew/release/expiration rates and retry-ceiling exhaustion;
- audit stream append failures and replay lag.

Use `TTYWorkerAudit.replay()` for bounded event replay. Audit events are append-only through the application API; no update or delete operation is exposed.

## Validation

The worker test suite covers duplicate and concurrent registration, capability/version validation, token integrity and expiration, inactive/unknown workers, middleware rejection, heartbeat ordering and recovery, audit ordering and replay, lease observation and stale detection, 100-worker registration, duplicate heartbeat races, and simulated Redis partitions.

Run the complete TTY suite with:

```text
npm run test:tty-all
```
