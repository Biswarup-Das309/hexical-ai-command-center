# Phase 2.1 Milestone 3 — execution worker

## Goal

Execute queued TTY jobs automatically through authenticated workers.

## Phase A — worker daemon

* daemon startup

* worker authentication

* worker registration

* heartbeat loop

* graceful shutdown

## Phase B — queue polling

* poll pending executions

* backoff

* jitter

* queue metrics

## Phase C — lease execution

* claim lease

* start coordinator

* stream output

* renew lease

* finalize

* release lease

## Phase D — recovery

* worker restart

* orphan recovery

* lease expiration

* metrics

## Milestone 3 scope checkpoint

This first implementation delivers only the Phase A daemon skeleton in `lib/tty/tty-worker-daemon.ts`. It registers one configured worker, authenticates its signed token, records an immediate heartbeat followed by a five-second heartbeat loop, emits structured lifecycle events, and removes timers and signal listeners during shutdown.

Job execution, lease claims, coordinator integration, output streaming, lease renewal, finalization, and recovery remain explicitly out of scope until their own implementation phases.

## Phase B scope checkpoint

Milestone 3B adds `TTYWorkerPoller` as a discovery-only service. It performs an immediate queue read, applies bounded exponential idle backoff with configurable jitter, exposes polling metrics, catches queue errors without terminating the service, and shuts down without leaving timers or active polling loops. The queue adapter returns only pending execution IDs; no execution payload is inspected and no lease or runtime operation is invoked.

## Phase C scope checkpoint

Milestone 3C adds `TTYWorkerClaimService` on top of the existing atomic lease manager and worker lease observer. It claims each discovered execution at most once, tracks secret-free ownership metadata, records conflicts and stale leases, recovers expired leases without an immediate re-claim, and exposes the claim layer to the poller through its pending-ID callback. Job execution and coordinator integration remain out of scope.

## Phase D scope checkpoint

Milestone 3D adds `TTYWorkerRecoveryService` as an additive, lifecycle-managed recovery layer. The daemon can start it after registration, authentication, and the initial heartbeat; the immediate scan must complete before the daemon reports ready, and shutdown awaits any in-flight scan before releasing resources.

The service composes the existing `TTYRecoveryManager`, `TTYExecutionCoordinator.recoverExecution`, and `TTYWorkerLeaseObserver`. It cleans orphaned runtime processes, reconciles active execution state after worker restart, scans the global worker lease index for expired leases, and exposes cumulative secret-free recovery metrics. Expired leases are requeued only when the authoritative state is still `leased`; active runtime states are left to orphan recovery and uncertain or terminal states are deferred. Scans are serialized, deterministic, retryable, and bounded by an injected interval.

Phase D does not execute jobs, change lease or coordinator contracts, add distributed scheduling, or expose lease tokens. Queue polling and claim services remain responsible for discovering and claiming executions returned to `queued`.

See [`tty-worker-recovery.md`](./tty-worker-recovery.md) for architecture, lifecycle, ownership, failure modes, recovery behavior, metrics, security, and operational guidance.

## Phase E scope checkpoint

Milestone 3E adds `TTYWorkerExecutor` as the single-concurrency execution loop. The executor consumes the poller's pending-ID callback, claims through the worker claim service, hands the already-owned lease to the coordinator, and releases local ownership in every terminal path. The coordinator remains the authority for state transitions, process lifecycle, output streaming, lease renewal, and terminal completion; the executor observes trusted renewal/loss hooks for metrics and recovery.

Startup performs one recovery scan before polling. Shutdown stops discovery, requests idempotent worker cancellation, waits for the active run, and then releases polling resources. A lease loss stops the coordinator runtime and preserves the coordinator's expired state for recovery; coordinator/runtime failures are recorded without exposing payloads or lease tokens. No autoscaling, distributed scheduling, or parallel execution is introduced.

See [`tty-worker-execution.md`](./tty-worker-execution.md) for architecture, lifecycle, ownership, failure modes, recovery behavior, metrics, security, and operational guidance.
