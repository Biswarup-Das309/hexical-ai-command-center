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

Queue polling, job execution, lease claims, coordinator integration, output streaming, lease renewal, finalization, and recovery remain explicitly out of scope until their own implementation phases.
