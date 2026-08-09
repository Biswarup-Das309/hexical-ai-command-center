# Phase 2.1 TTY Runtime v1 — Release Hardening

This document is the release-readiness runbook for the Phase 2.1 worker execution platform. It covers the existing worker daemon, poller, claim service, executor, coordinator, stream bridge, and recovery service. It does not change their public contracts or introduce scheduling, autoscaling, or parallel execution.

## Release gate

Run the repository's authoritative release check from a clean checkout:

```text
pnpm install --frozen-lockfile
npm run verify:tty-release
```

The gate must report:

- executor tests passing;
- worker tests passing;
- full TTY regression passing;
- production build passing; and
- repository-wide TypeScript passing.

Do not promote a build when any gate is red. Node modules must be installed from the committed `pnpm-lock.yaml`; do not mix npm- and pnpm-managed dependency trees during release validation.

## Deployment architecture

The worker process starts in this order:

```text
authenticate worker
    -> register worker
    -> heartbeat
    -> immediate recovery scan
    -> start queue polling
    -> execute one claimed job at a time
```

The coordinator remains the authority for process lifecycle, persisted state, output streaming, lease renewal, and terminal completion. The executor owns only worker lifecycle, single-concurrency admission, cancellation coordination, and worker metrics. A deployment must preserve the same Redis lease namespace and stream/event keys across rolling replacement.

There is no data migration in this release. The added executor handoff is additive and the existing coordinator `run()` path remains compatible with callers that claim internally.

## Canary procedure

1. Build from an immutable commit on `phase-2.1-m3-worker` and record the commit ID.
2. Install dependencies with the committed pnpm lockfile and run `npm run verify:tty-release`.
3. Start one canary worker with a unique worker ID and the production capability policy.
4. Confirm registration, authentication, heartbeat, immediate recovery, and polling readiness.
5. Submit a small authorized investigation sample containing success, stderr, cancellation, timeout, and recovery cases.
6. Observe the canary for at least one full lease-renewal interval and one recovery scan interval before expanding rollout.
7. Compare canary and baseline metrics before adding workers.
8. Roll out workers gradually while preserving single execution ownership and the existing lease TTL configuration.

The canary must be stopped before the same worker ID is reused. Never run two processes with the same worker identity or token.

## Rollback procedure

### Rollback triggers

Roll back when any of the following persists beyond the alert window:

- lease losses or renewal failures increase above the baseline;
- executions remain queued while workers report healthy;
- duplicate ownership or unauthorized-worker outcomes appear;
- recovery deferrals or orphan cleanup failures increase;
- stream ordering, durable output, or completion persistence diverges; or
- worker startup cannot complete the immediate recovery scan.

### Procedure

1. Stop admitting new canary workers.
2. Stop affected workers gracefully so polling stops and active executions receive cancellation.
3. Wait for active executions to reach terminal state or for their leases to expire and be reconciled by recovery.
4. Deploy the previous verified worker image/commit without changing Redis keys, lease configuration, or stream retention.
5. Confirm worker registration, heartbeat, recovery, queue progress, and lease ownership.
6. Reconcile any `leased`, `running`, `streaming`, or `expired` records before resuming normal admission.

Rollback is code-only. No database rollback is required for this release. Do not delete lease, execution-state, runtime, or stream records during rollback; they are evidence and recovery inputs.

## Monitoring and alerting

Track these metrics by worker and deployment version:

- worker health and uptime;
- pending queue depth and oldest queue age;
- claim attempts, conflicts, and stale lease observations;
- executions started, completed, failed, cancelled, and expired;
- execution duration and timeout rate;
- lease renewals, lease losses, and release failures;
- recovery runs, duration, orphan cleanup failures, and deferred leases;
- stream append failures, reconnects, ordering gaps, and backpressure; and
- authorization denials.

Alert on sustained queue age, any duplicate-ownership signal, rising lease-loss rate, repeated recovery failure, missing heartbeats, or stream persistence failure. Logs must remain structured and secret-free: IDs, state, timing, bounded error codes, and metrics only.

## Fault-injection checklist

Exercise these scenarios in a non-production environment before promotion:

- Redis unavailable during claim, renewal, completion, and recovery;
- worker termination during claim, process startup, streaming, and completion;
- lease expiry during an active process;
- stream broker failure after durable output append;
- coordinator failure before and after process start;
- shutdown racing with polling and recovery; and
- restart while an execution has active runtime metadata.

For each scenario, verify that no second worker starts the same execution, evidence remains readable, the lease is fenced or released, recovery is observable, and the worker returns to polling after safe cleanup.

## Troubleshooting

### Worker starts but does not claim work

Check worker authentication, registry status, heartbeat freshness, queue depth, poller errors, and whether another worker owns the lease. Do not manually mutate lease state; allow the lease manager and recovery service to reconcile it.

### Execution is expired after a deployment

Check lease-loss and recovery metrics, runtime orphan metadata, and the worker shutdown timeline. Preserve output and state records. Requeue only through the existing recovery/coordinator path.

### Live output is missing

Check durable output events first, then stream broker publication and subscriber authorization. Durable evidence is authoritative; do not infer execution failure from a disconnected browser stream.

### TypeScript or build gate fails

Use the exact locked dependency installation, remove mixed package-manager state, rerun `npm run verify:tty-release`, and inspect the first compiler or build error. Do not bypass the type gate or deploy a partially validated worker image.

## Production readiness decision

Phase 2.1 is ready for merge and deployment only after the release gate, canary, monitoring review, and rollback drill are complete. This document does not authorize merge, tagging, production deployment, or creation of the Phase 2.2 branch.
