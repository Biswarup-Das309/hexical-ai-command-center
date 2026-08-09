# Hexical AI TTY Worker Execution — Phase 2.1 Milestone 3E

Milestone 3E completes the single-execution worker loop around the existing poller, claim service, execution coordinator, streaming bridge, and recovery service. It is additive: the runtime, streaming APIs, coordinator public `run()` contract, lease manager, and browser projections remain unchanged.

## Architecture and ownership

`TTYWorkerExecutor` owns worker lifecycle, single-concurrency admission, execution outcomes, cancellation coordination, and worker-level metrics. It does not own persisted execution state, process handles, output transport, or lease tokens.

The execution authorities remain separated:

1. `TTYWorkerPoller` discovers pending execution IDs and invokes the executor callback. It does not claim, execute, or inspect payloads.
2. `TTYWorkerClaimService` performs the atomic claim and keeps the lease token in its private server-side ownership map. The executor receives a trusted in-process handoff only long enough to invoke the coordinator.
3. `TTYExecutionCoordinator` remains the authority for queued-to-terminal state transitions, process startup and cleanup, stdout/stderr streaming, lease renewal, cancellation, and terminal lease completion.
4. `TTYStreamingOutputStreamManager` persists output before publishing live events through the existing stream broker.
5. `TTYWorkerRecoveryService` owns restart/orphan/expired-lease scans. The executor invokes an immediate scan at startup and a bounded recovery scan after an interruption or lease loss.

The coordinator's existing `run()` method still claims its own lease for callers that use that contract. The additive `runClaimed()` handoff accepts a lease already claimed by the worker claim service, preventing a second claim while preserving the frozen public behavior.

## Lifecycle

```text
executor.start()
    -> recovery.recoverNow()
    -> poller.startPolling()
    -> pending execution ID
        -> claim service atomic claim
        -> verify worker and lease attribution
        -> coordinator.runClaimed()
            -> state transitions and process start
            -> output durable append then live publish
            -> periodic lease renewal
            -> terminal completion
        -> release local ownership
    -> next pending ID

executor.stop()
    -> stop new polling
    -> request idempotent worker cancellation
    -> await active execution and ownership cleanup
    -> stop poller resources
```

One worker has at most one active execution. A repeated callback for the active execution shares the same promise; a different execution is skipped with `worker_busy`. Pending IDs are handled sequentially, so a failed or cancelled execution cannot prevent the worker from returning to polling.

## Ownership and lease behavior

The claim service validates the queue and lease result before returning the trusted job handoff. The executor verifies the worker ID and lease ID again immediately before starting the coordinator. Mismatches fail closed and release the local ownership record.

The coordinator renews the lease using the private token. Successful renewals are reported to the executor for metrics. A renewal failure or expired lease reports ownership loss, stops the process safely, and finalizes the execution as expired according to the existing coordinator rules. The executor does not attempt a duplicate completion after ownership loss; it releases its local ownership record and invokes recovery reconciliation.

Local release is attempted after success, failure, cancellation, ownership loss, and coordinator exceptions. The release path is idempotent and always forgets the in-memory ownership metadata after the authoritative release attempt. Lease tokens are never returned in status, logs, metrics, or browser-facing responses.

## Cancellation and recovery

Cancellation is idempotent at the executor boundary. User cancellation, system timeout, worker shutdown, and recovery interruption are delegated to the coordinator's existing cancellation path. Shutdown waits for the active execution before stopping the poller's resources.

Startup recovery runs before polling so orphaned work is reconciled before new claims are admitted. If a coordinator run fails unexpectedly, or a lease is lost during execution, the executor triggers a recovery scan. The recovery service remains responsible for deciding whether an execution is requeued, expired, deferred, or left authoritative; the executor never guesses persisted state.

## Failure modes

| Failure | Executor behavior | Recovery behavior |
| --- | --- | --- |
| Missing or non-claimable job | Return a secret-free skipped outcome and continue polling. | Existing claim/recovery services retain authoritative state. |
| Worker or lease mismatch | Fail closed, do not start the coordinator, release local ownership. | No duplicate execution is attempted. |
| Runtime or coordinator exception | Record a bounded error code, mark the run failed, release ownership, and continue polling. | Trigger one serialized recovery scan when configured. |
| User/system/shutdown cancellation | Delegate to the coordinator; repeated requests are safe. | Coordinator persists cancellation and completes the lease safely. |
| Lease renewal failure or expiry | Stop the runtime through the coordinator and avoid duplicate completion. | Preserve expired evidence and run recovery reconciliation. |
| Poller failure | Existing poller backoff keeps discovery alive; executor remains single-concurrency. | The next poll retries discovery. |
| Shutdown during claim/start | Stop admission, await the in-flight operation, release ownership, and clear local state. | Restart performs the startup recovery scan. |

## Metrics and observability

`TTYWorkerExecutorStatus.metrics` exposes cumulative, secret-free values for:

- executions started, completed, failed, and cancelled;
- average terminal duration;
- successful lease renewals;
- lease losses; and
- recovery scans requested during an active execution.

Structured lifecycle logs include the worker ID, execution ID, lease ID where safe for server logs, bounded error codes, state, reason, and duration. They do not include command arguments, output payloads, environment values, authentication material, or lease tokens.

## Security considerations

- The executor is server-side and dependency-injected; browser input cannot choose a worker, lease, or coordinator handoff.
- Claim and release remain atomic lease-manager operations.
- The trusted preclaimed job is an in-process boundary only and must not be serialized, returned by an API, or logged.
- Worker and lease attribution is checked both before coordinator admission and by the coordinator before process start.
- Failure and recovery paths fail closed when ownership is uncertain.

## Operational notes

Construct one executor per worker process and inject the existing poller callback, claim service, coordinator, stream bridge, and recovery service. Start it only after worker authentication and registration have completed. Monitor the failed, cancelled, lease-loss, renewal, and recovery counters together; a rising lease-loss rate with repeated recovery deferrals indicates a worker or lease-store health problem.

Milestone 3E intentionally does not add autoscaling, distributed scheduling, work stealing, or parallel execution. Those capabilities require separate contracts and are outside this milestone.
