-- Run after the complete reset migration. It is idempotent and preserves evidence.
begin;

-- Quarantine expired reservations rather than deleting financial evidence.
update public.usage_reservations set status='expired', released_at=coalesce(released_at,now()) where status='reserved' and expires_at <= now();

-- Normalize malformed entitlement rows and expire completed periods.
update public.subscriptions set status='expired', updated_at=now() where status in ('active','trialing','grace') and current_period_end is not null and current_period_end < now() and coalesce(grace_period_end,'-infinity'::timestamptz) < now();

-- Repair duplicate active subscriptions by retaining the newest record.
with ranked as (select id,row_number() over (partition by user_id order by enterprise_unlimited desc,current_period_end desc nulls last,updated_at desc,id desc) as n from public.subscriptions where status in ('active','trialing','grace'))
update public.subscriptions s set status='expired',updated_at=now(),metadata=s.metadata||jsonb_build_object('repair','duplicate_active_subscription') from ranked r where s.id=r.id and r.n>1;

-- Rebuild canonical usage summaries from immutable usage logs for the current month.
insert into public.user_usage_summary(user_id,period_start,messages_used,tokens_used,committed_cost_usd)
select user_id,date_trunc('month',created_at)::date,count(*),coalesce(sum(input_tokens+output_tokens),0),coalesce(sum(estimated_cost_usd),0)
from public.user_usage_logs where created_at >= date_trunc('month',now()) group by user_id,date_trunc('month',created_at)::date
on conflict(user_id,period_start) do update set messages_used=excluded.messages_used,tokens_used=excluded.tokens_used,committed_cost_usd=excluded.committed_cost_usd,updated_at=now();

-- Terminal/session recovery: stale active sessions and orphaned executions become
-- explicitly recoverable/expired, never silently disappear.
update public.investigation_sessions set status='expired',updated_at=now() where status='active' and lease_expires_at is not null and lease_expires_at < now();
update public.tty_executions set state='expired',finished_at=coalesce(finished_at,now()),failure_code=coalesce(failure_code,'lease_expired'),updated_at=now() where state in ('leased','starting','running','streaming') and lease_expires_at is not null and lease_expires_at < now();
update public.investigations i set tty_session_id=null,updated_at=now() where tty_session_id is not null and not exists(select 1 from public.investigation_sessions s where s.id=i.tty_session_id and s.status='active');

-- Backfill profiles from every surviving owner ledger before enforcing new FKs.
insert into public.profiles(user_id)
select distinct owner_user_id from public.investigations
on conflict(user_id) do nothing;

commit;
