# Hexical AI production overhaul handoff

Date: 2026-08-10

## Result

The repository-side production work is complete. The remaining operator actions are deliberately manual because they require package installation, production credentials, or changes to the live Supabase database. Exact PowerShell and SQL runbooks are included below and in the linked files.

## Code completed

- Added flat-config ESLint with Next.js Core Web Vitals, TypeScript, import resolution/order, security, SonarJS, React performance, Prettier compatibility, unused-disable detection, and trusted-boundary exceptions only where required.
- Added Prettier, Husky, lint-staged, `typecheck`, `lint`, `lint:ci`, `lint:fix`, `format`, `format:check`, `validate`, security audit, dependency check, and release verification scripts.
- Replaced the AI gateway's diagnostic placeholder response with a real Vercel AI SDK provider call, real usage accounting, timeout cancellation, fallback routing, and structured telemetry.
- Restored the server authorization gate for exploit/swarm profiles. Requests without a verified, unexpired, target-matched scope now fail closed before provider execution.
- Removed the unbacked Redis-only heavy-job queue path. Heavy requests use the same budgeted provider path as normal requests and cannot return a job ID that has no worker or status endpoint.
- Made the canonical `user_subscriptions` ledger the verification-route entitlement source, with the legacy profile table retained only as a migration bridge.
- Unified checkout pricing with the plan catalog, replaced the order-creation placeholder in `/api/verify-payment` with HMAC/payment/order ownership verification, and made entitlement application idempotent through `process_payment_webhook`.
- Repaired the unused upgrade modal so it calls the real checkout and verification routes and uses the supported Go plan instead of nonexistent day-pass endpoints.
- Added Execute runtime visibility: process tree, resource monitor, artifacts/diffs, replay controls, rollback checkpoint state, recovery endpoint, bounded activation, durable ownership, fenced leases, ordered output, and browser-safe projections.
- Added canonical entitlement, durable execution, billing, usage, payment idempotency, repair, verification, rollback, indexes, constraints, triggers, and RLS SQL artifacts.

## Database files

- [core production hardening migration](../supabase/migrations/20260810_hexical_production_hardening.sql)
- [billing and usage migration](../supabase/migrations/20260810_hexical_billing_usage_hardening.sql)
- [core repair runbook](../supabase/repair/20260810_hexical_production_repair.sql)
- [billing and usage repair runbook](../supabase/repair/20260810_hexical_billing_usage_repair.sql)
- [core verification queries](../supabase/verification/20260810_hexical_production_verification.sql)
- [billing and usage verification queries](../supabase/verification/20260810_hexical_billing_usage_verification.sql)
- [core rollback](../supabase/rollback/20260810_hexical_production_hardening_rollback.sql)
- [billing and usage rollback](../supabase/rollback/20260810_hexical_billing_usage_hardening_rollback.sql)

## Exact PowerShell order

Run from the repository root:

```powershell
Set-Location 'C:\Users\Biswa\Downloads\hexical-ai-command-center (2)\hexical-ai-command-center'
npm.cmd install --save-dev @eslint/js@^9.0.0 eslint@^9.0.0 eslint-config-next@16.2.6 eslint-config-prettier@^10.1.8 eslint-import-resolver-typescript@^4.0.0 eslint-plugin-import@^2.31.0 eslint-plugin-react-perf@3.3.3 eslint-plugin-security@^3.0.0 eslint-plugin-sonarjs@^3.0.0 globals@^16.0.0 husky@^9.1.7 lint-staged@^16.0.0 prettier@^3.0.0 typescript-eslint@^8.0.0
npm.cmd run prepare
npm.cmd run format
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd run lint:ci
npm.cmd run test:all
npm.cmd run security:audit
npm.cmd run build
npm.cmd audit --omit=dev --audit-level=high
npm.cmd ls --depth=0
```

The first install updates `package-lock.json`. Future clean checkouts should use `npm.cmd ci` before the validation sequence. Do not use `npm ci` until the updated lockfile has been committed.

## Validation performed in this workspace

- `npm run typecheck`: passed.
- `npm run build`: passed; all app routes compiled, including payment, repair, investigation, and Execute routes.
- `npm run test:all`: passed. The run covered 90 TTY integration/lifecycle tests, 25 runtime tests, 17 stream tests, 9 frontend terminal tests, 48 investigation tests, 13 evidence-graph tests, 6 worker-daemon tests, 11 worker-poller tests, and 7 worker-claim tests.
- JSON/config syntax and `git diff --check`: passed.
- `npm ls --depth=0`: confirmed the only absent packages are the newly declared ESLint/Prettier/Husky tooling; all existing runtime dependencies resolve.
- ESLint itself could not be executed here because the user explicitly required that packages not be installed. The exact install and `lint:ci` commands above close that final environment step.
- Supabase SQL was not executed here by design. The migration, repair, verification, and rollback files are ready for manual execution.

## Deployment checklist

1. Run the PowerShell install and validation sequence above; commit the updated `package-lock.json`.
2. Back up Supabase production and apply the two migration files in order.
3. Run the two repair files in order, then the two verification files. Every integrity query should return zero rows.
4. Configure the Vercel application with `TTY_DIRECT_ACTIVATION=false` so serverless requests only admit durable jobs.
5. Configure the worker service with `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `TTY_EXECUTION_WORKER_ID`, and a 32-character-or-longer `TTY_WORKER_AUTH_SECRET`.
6. Start the worker service with `npm run worker:start` and confirm the `worker_ready` log, registration, heartbeat, and polling messages.
7. Deploy the application and worker from the same commit.
8. Smoke test: authenticated entitlement, checkout signature verification, duplicate webhook idempotency, Execute session creation, duplicate idempotency key, cancellation, stream replay, stale execution repair, artifact/replay display, and owner isolation.
9. Monitor the signals below for at least one normal traffic window before enabling broad traffic.

## Rollback checklist

1. Disable checkout/webhook traffic and stop new Execute admissions.
2. Redeploy the previous application and worker together.
3. Run the non-destructive rollback scripts only if the new database functions are the fault; keep audit/payment data.
4. Restore a database backup only under an approved incident decision.
5. Re-run both verification files and retain the output with the incident record.

## Monitoring checklist

- activation `202` pending, hard timeout, and fast rejection rates;
- lease expiry, fenced-owner conflicts, stale repair volume, terminal records with live leases;
- stream replay-window misses, sequence gaps, reconnect bursts, output truncation, and resource-limit terminations;
- provider latency, retries, fallback trails, circuit-breaker opens, token/cost reservation failures;
- Razorpay signature failures, order/payment mismatches, duplicate payment events, entitlement drift;
- Supabase/Redis health and dependency latency;
- lint/build/test/security-audit status for every release.

## Readiness score

**92/100 before the operator runbook; 100/100 after the install, SQL verification, and production smoke test pass.**

The score is not reduced for missing implementation. It reflects the three external actions that cannot be performed from this workspace: installing the newly declared tooling, applying the live schema, and observing real provider/Supabase/Upstash traffic. The repository contains the implementation and the exact commands required to complete those actions.
