# Hexical AI billion-scale production audit — 2026-08-24

## Scope and evidence

This audit covers the Next.js application, Clerk request boundary, Supabase
Postgres/Realtime runtime store, WSL worker, node-pty, tmux, Runtime OS
sessions, execution leases, transcripts, investigations, Evidence Graph, AI
provider boundary, billing/entitlements, and browser surfaces.

Evidence collected locally:

- 365 application tests passed after the changes in this audit.
- Typecheck, scoped lint, formatting, production build, and dependency audit passed.
- Windows and Linux node-pty smoke/stress checks passed.
- WSL tmux persistence passed for shell, worker handoff, cwd, environment, and background-job continuity.
- Local Runtime OS E2E passed with queued-to-completed execution, PTY attachment, persisted output, replay, and zero duplicate replay events.
- Brave production baseline was authenticated and hydrated five owner-scoped investigations; `/api/health` reported healthy, Supabase runtime backend, Redis disabled, queue pending `0`, and one online worker.

The new migration and application changes are local in this checkout. They are
not production evidence until the additive migration is applied and the bundle
is deployed.

## Findings

### P1 — Supabase sorted-index reads loaded entire keys into application memory — fixed locally

Evidence: `SupabaseRuntimeStore.zrange` selected every member and sliced in
JavaScript. Evidence Graph processed-event indexes request up to 100,000
members, and investigation/graph pages were therefore exposed to avoidable
memory and response-size pressure.

Fix: database-side `.range()` pagination with bounded reads and exact count only
when negative Redis indexes require it. Regression coverage asserts the range
window is sent to the database.

Release requirement: deploy the application change before treating this as
fixed in production.

### P1 — Supabase `sadd` was a read-then-insert race — fixed locally

Evidence: concurrent writers could both observe a missing `(key, member)` and
one would fail on the composite primary key instead of converging.

Fix: additive `hexical_runtime_add_set_members` SECURITY DEFINER RPC using
`INSERT ... ON CONFLICT DO NOTHING`; the adapter now performs one atomic call.
Regression coverage asserts the RPC contract.

Release requirement: apply the additive migration and deploy the application
change together.

### P1 — Redis-compatible stream expiry was not preserved by the Postgres store — fixed locally

Evidence: the original `hexical_runtime_expire_key` updated only KV rows, while
control, timeline, and transcript streams are stored in
`hexical_runtime_stream_entries`. Generic stream appends also did not inherit a
stream TTL, and expired rows were filtered after `LIMIT`, allowing stale rows
to hide newer replay events.

Fix: the additive migration expires stream/hash rows, removes expired stream
rows before append, propagates the active stream expiry to new entries, and the
adapter filters expiry in Postgres before applying the replay limit. Regression
coverage checks the migration contract and replay filter.

Release requirement: apply the migration before enabling the new application
bundle. A scheduled physical-retention janitor remains a scale roadmap item;
logical expiry and replay correctness are enforced now.

## Security and ownership

The document proxy protects `/dashboard` and descendants through Clerk with a
return URL. Server factories authenticate requests and owner-scope sessions,
executions, investigations, graph hydration, and transcript replay. The graph
identifier is deterministic per investigation, but every public access path
checks the owner-bound investigation before reading or mutating graph state.
Server Supabase service-role access remains behind the server-only admin
boundary. The automated authorization suite passed.

An independent second authenticated account was not available in this audit,
so cross-account browser isolation is not claimed as production-proven.

## Reliability and UX

The WSL worker is supervised by systemd, uses the Supabase runtime backend,
keeps tmux ownership separate from worker process lifetime, and passed the
Linux handoff/restart checks. Local PTY E2E proved first-byte output,
persistence, replay, completion, and duplicate-free replay. Brave production
baseline health and hydration were verified; the newly changed bundle still
needs deployment for a production verification of the fixes above.

The Runtime OS remains terminal-first, while investigation/workspace surfaces
retain investigation-first graph and timeline behavior. Realtime is the live
path with durable replay as recovery; bounded reconciliation remains for
lease/index state that has no event.

## Open P2 risks and evidence gaps

- Several generic `SMEMBERS` call sites still materialize a whole runtime set;
  current session/lease sets are bounded by product limits, but global pending
  and persistent-session indexes need cursor-based scans before internet-scale
  operation.
- No independent multi-user browser account was available for live IDOR proof.
- Provider timeout, 429, 500, malformed-response, and interrupted-stream
  failure-injection coverage is incomplete.
- Production component latency percentiles and exact production transcript
  duplicate-ID counts were not available through the authenticated diagnostics
  surface.
- Formal contrast, focus-trap, reduced-motion, and mobile accessibility audits
  remain incomplete.
- The strict release wrapper still fails its zero-warning ESLint gate because
  of pre-existing warnings; scoped lint has zero errors. This is recorded as
  P3 debt, not waived as an application correctness result.

## Release decision

Current production state is not release-clear for this audit change because
the three P1 fixes are not deployed and the additive migration is not applied.
After migration application, deployment, authenticated two-user checks, and
provider/accessibility failure gates, rerun the full matrix and update this
decision with production evidence.

**Current verdict: `HEXICAL — NOT RELEASE CLEAR`**
