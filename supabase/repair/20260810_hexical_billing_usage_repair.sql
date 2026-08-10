-- Billing and usage repair. Apply only after the billing migration.
-- Review the preflight selects in the SQL editor, then run the transaction.

begin;

-- Expired in-flight reservations must not continue blocking a user's budget.
update public.hexical_budget_reservations
set status = 'expired', released_at = now()
where status = 'reserved'
  and expires_at <= now();

-- Ensure every existing entitlement has a usage counter for the current month.
insert into public.hexical_usage_counters (user_id, period_start)
select s.user_id, date_trunc('month', now())::date
from public.user_subscriptions s
where not exists (
  select 1
  from public.hexical_usage_counters c
  where c.user_id = s.user_id
    and c.period_start = date_trunc('month', now())::date
);

-- Rebuild the gateway usage projection only for users that have no counter yet.
-- Existing counters remain authoritative because the main verification route
-- and the gateway can record through different telemetry tables.
insert into public.hexical_usage_counters (user_id, period_start, messages_used, tokens_used, committed_cost_usd)
select
  l.user_id,
  date_trunc('month', now())::date,
  count(*)::bigint,
  coalesce(sum(l.input_tokens + l.output_tokens), 0)::bigint,
  coalesce(sum(l.estimated_cost_usd), 0)::numeric
from public.user_usage_logs l
where l.created_at >= date_trunc('month', now())
group by l.user_id
on conflict (user_id, period_start) do nothing;

-- Re-assert profile projections from the canonical subscription ledger.
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

commit;

