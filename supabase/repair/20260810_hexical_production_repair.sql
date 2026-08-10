-- Manual production repair runbook.
-- Review every result in a transaction before COMMIT. Do not run blindly.
-- The migration must be applied first.

begin;

-- 1. Backfill the canonical entitlement ledger from the legacy profile mirror
-- only when an account has no canonical row. Existing canonical rows win.
insert into public.user_subscriptions (user_id, tier, status, current_period_end, provider, metadata)
select
  p.user_id,
  case when p.tier in ('free', 'go', 'plus', 'pro') then p.tier else 'free' end,
  case when coalesce(p.subscription_status, 'active') in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete') then coalesce(p.subscription_status, 'active') else 'active' end,
  p.current_period_end,
  'legacy_profiles',
  jsonb_build_object('backfilled_at', now(), 'source', 'profiles')
from public.profiles p
where not exists (
  select 1 from public.user_subscriptions s where s.user_id = p.user_id
);

-- 2. Re-apply the canonical ledger to the legacy mirror so the old source
-- cannot silently win during a rolling deploy.
update public.profiles p
set tier = s.tier,
    subscription_status = s.status,
    current_period_end = s.current_period_end
from public.user_subscriptions s
where s.user_id = p.user_id
  and (
    p.tier is distinct from s.tier
    or p.subscription_status is distinct from s.status
    or p.current_period_end is distinct from s.current_period_end
  );

-- 3. Clamp stale counters without resurrecting work. The durable execution
-- ledger is authoritative; only executions with an active state count.
update public.hexical_execution_records e
set state = 'expired',
    failure_code = coalesce(e.failure_code, 'REPAIR_LEASE_EXPIRED'),
    completion_reason = coalesce(e.completion_reason, 'manual_repair'),
    finished_at = coalesce(e.finished_at, now()),
    updated_at = now()
where e.state in ('leased', 'starting', 'running', 'streaming')
  and e.lease_expires_at is not null
  and e.lease_expires_at < now();

delete from public.hexical_execution_leases l
where not exists (
  select 1 from public.hexical_execution_records e
  where e.execution_id = l.execution_id
    and e.state in ('leased', 'starting', 'running', 'streaming')
    and e.fencing_token = l.fencing_token
);

-- 4. Remove orphaned idempotency rows while retaining a bounded audit trail.
-- If a separate idempotency table exists in the deployment, reconcile it to
-- hexical_execution_records with the same owner/session/fingerprint tuple.

insert into public.hexical_execution_repair_log (execution_id, action, previous_state, next_state, reason, metadata)
select execution_id, 'expire_stale_lease', state, 'expired', 'lease_expired_at_repair', jsonb_build_object('repaired_at', now())
from public.hexical_execution_records e
where e.state = 'expired' and e.failure_code = 'REPAIR_LEASE_EXPIRED'
  and not exists (
    select 1
    from public.hexical_execution_repair_log r
    where r.execution_id = e.execution_id
      and r.action = 'expire_stale_lease'
      and r.reason = 'lease_expired_at_repair'
  );

commit;

-- After the transaction, run the verification file and retain its output with
-- the deployment record. If a check is non-zero, restore from backup and do
-- not continue the rollout.
