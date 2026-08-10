-- Expected result: every query returns zero rows unless the deployment has a
-- documented exception. Run manually after migration and repair.

-- Canonical subscription duplicates / invalid values.
select user_id, count(*) as rows
from public.user_subscriptions
group by user_id
having count(*) <> 1;

select user_id, tier, status
from public.user_subscriptions
where tier not in ('free', 'go', 'plus', 'pro')
   or status not in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete');

-- Legacy mirror drift. This should be empty after the repair script.
select p.user_id, p.tier as profile_tier, s.tier as canonical_tier,
       p.subscription_status as profile_status, s.status as canonical_status,
       p.current_period_end as profile_period_end, s.current_period_end as canonical_period_end
from public.profiles p
join public.user_subscriptions s on s.user_id = p.user_id
where p.tier is distinct from s.tier
   or p.subscription_status is distinct from s.status
   or p.current_period_end is distinct from s.current_period_end;

-- Active lease ownership must be one-to-one and must not be expired.
select e.execution_id, e.state, e.fencing_token, l.fencing_token, l.expires_at
from public.hexical_execution_records e
left join public.hexical_execution_leases l using (execution_id)
where e.state in ('leased', 'starting', 'running', 'streaming')
  and (l.execution_id is null or l.fencing_token <> e.fencing_token or l.expires_at <= now());

-- No lease row may outlive its execution record.
select l.execution_id
from public.hexical_execution_leases l
left join public.hexical_execution_records e using (execution_id)
where e.execution_id is null;

-- Event sequences must be positive, unique, and tied to the same session.
select event_id, execution_id, sequence
from public.hexical_execution_events
where sequence <= 0;

select e.event_id, e.execution_id, e.session_id as event_session_id, r.session_id as record_session_id
from public.hexical_execution_events e
join public.hexical_execution_records r using (execution_id)
where e.session_id <> r.session_id;

-- Terminal records must be complete and may not have a live lease.
select execution_id, state, finished_at
from public.hexical_execution_records
where state in ('succeeded', 'failed', 'cancelled', 'timed_out', 'expired')
  and finished_at is null;

select execution_id
from public.hexical_execution_records
where state in ('succeeded', 'failed', 'cancelled', 'timed_out', 'expired')
  and exists (select 1 from public.hexical_execution_leases l where l.execution_id = hexical_execution_records.execution_id);

-- RLS must be enabled on every new ledger table.
select relname as table_name, relrowsecurity
from pg_class
where relname in ('user_subscriptions', 'hexical_execution_records', 'hexical_execution_leases', 'hexical_execution_events', 'hexical_execution_repair_log')
  and not relrowsecurity;

-- Required triggers must exist. This query intentionally returns missing names only.
select required.trigger_name
from (values
  ('hexical_execution_transition_guard'),
  ('user_subscriptions_sync_profile'),
  ('user_subscriptions_set_updated_at')
) as required(trigger_name)
where not exists (
  select 1
  from pg_trigger t
  where t.tgname = required.trigger_name
    and not t.tgisinternal
);
