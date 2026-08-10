# Hexical AI TTY Worker Recovery — Phase 2.1 Milestone 3D

Phase 3D adds restart recovery around the existing worker daemon, runtime recovery manager, coordinator, lease manager, and worker lease observer. It is additive: the execution coordinator, lease manager, authentication contracts, streaming APIs, and browser projections remain unchanged.

## Architecture and ownership

`TTYWorkerRecoveryService` owns recovery scheduling and recovery metrics. It does not claim or execute jobs. It composes three existing authorities:

1. `TTYRecoveryManager` scans the active execution index, validates persisted state, and cleans orphaned process metadata through the injected process runtime.
2. `TTYExecutionCoordinator.recoverExecution` owns the atomic lease recovery and coordinator state transition. A recovered execution is returned to `queued` only after the lease manager has fenced the expired lease.
3. `TTYWorkerLeaseObserver` supplies the global worker lease attribution view. The recovery service uses it to find expired leases without reading lease tokens.

The daemon accepts the recovery service through an optional lifecycle dependency. During startup, registration, authentication, the initial heartbeat, and the immediate recovery scan complete before the daemon reports `running` or installs its signal/heartbeat resources. Shutdown stops recovery before the daemon reports `stopped`.

## Lifecycle

```text
daemon start
    -> register
    -> authenticate
    -> initial heartbeat
    -> recovery.start()
         -> orphan scan and cleanup
         -> expired lease scan
         -> schedule bounded recovery interval
    -> daemon ready

daemon stop / signal
    -> stop recovery timer
    -> await in-flight recovery
    -> remove heartbeat and signal resources
    -> daemon stopped
```

`recoverNow()` is idempotent while a scan is in flight. Concurrent callers share one scan, and scheduled scans never overlap an earlier scan. A recovery service can be restarted after stopping; each start performs a fresh immediate scan.

## Recovery behavior

### Orphaned runtime recovery

The existing active execution index is scanned for `starting`, `running`, and `streaming` records. Persisted runtime metadata is passed to `cleanupOrphan`. State mutation remains delegated to `TTYExecutionCoordinator.recoverExecution`, which calls the atomic lease recovery script and then transitions the coordinator state to `queued` with `worker_crash_recovered` attribution.

### Expired lease recovery

The global `workerId|executionId` lease index is sorted and scanned deterministically. For each valid member, the observer supplies the safe lease observation. Expired work is recoverable only when the authoritative execution state is still `leased` and its session matches the observed lease. Active runtime states are deferred to orphan recovery so a live process cannot be requeued accidentally. Missing, terminal, mismatched, or uncertain state is preserved and recorded as deferred.

The lease manager's existing Redis script remains the single atomic fence. If another worker wins the race, recovery records a conflict/failure and does not create ownership. Retry ceilings can finalize a lease as `expired`; recovery never silently resurrects terminal work.

## Failure modes

| Failure                                                     | Behavior                                                                                  | Recovery                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Redis read failure                                          | The scan records a bounded error and the service remains available for the next interval. | Retry the next scheduled scan after connectivity returns.               |
| Orphan cleanup failure                                      | The candidate is counted as failed; state is not guessed or requeued by this layer.       | The next scan can retry cleanup.                                        |
| Lease already renewed or recovered                          | Atomic coordinator/lease checks return the current safe outcome.                          | Leave the current owner/state authoritative.                            |
| Active or terminal state with an expired lease index member | Recovery is deferred; no process or terminal work is requeued from uncertain state.       | Runtime recovery or operator reconciliation resolves the inconsistency. |
| Malformed lease index member                                | It is counted and ignored; no Redis mutation is attempted.                                | Repair the index from authoritative job records.                        |
| Shutdown during recovery                                    | New scans stop, the current scan is awaited, and timers are cleared.                      | Restart performs a new immediate scan.                                  |

## Metrics and observability

`TTYWorkerRecoveryStatus.metrics` reports cumulative, secret-free counters:

- recovery runs and last run timing;
- orphan candidates scanned, processes cleaned, executions recovered, and failures;
- lease index members scanned and malformed members;
- expired leases observed, requeued, finalized as expired, deferred, and failed.

Lifecycle logs include worker/execution identifiers, lease IDs, counts, timing, and bounded error codes. They never include lease tokens, command payloads, process environment, or raw exception messages.

## Security considerations

- Recovery is server-side and dependency-injected; no browser or user input can select a worker or lease.
- Lease tokens remain inside the existing lease manager and are never returned by recovery status or logs.
- Recovery is fail-closed for malformed attribution and uncertain execution state.
- Redis remains the source of truth for ownership; in-memory maps are used only for lifecycle deduplication and metrics.
- Recovery does not start processes, bypass authorization, or alter browser-safe execution projections.

## Operational notes

Deployments should construct one recovery service per worker process and inject the same Redis client, coordinator, process runtime recovery manager, and worker lease observer used by the worker. Start it through the daemon lifecycle before enabling queue polling. Alert on sustained `recovery_partial_failure`, rising deferred leases, malformed index members, and recovery latency.

The recovery service does not replace the queue poller or claim service. Executions returned to `queued` become eligible for the existing discovery and claim path on a subsequent poll.
