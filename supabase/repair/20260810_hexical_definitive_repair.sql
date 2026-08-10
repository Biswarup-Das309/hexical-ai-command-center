-- Run after the definitive rebuild when the verification query reports rows.
-- The repair is idempotent and preserves payment/usage evidence.
begin;

update public.usage_reservations set status='expired',released_at=coalesce(released_at,now()) where status='reserved' and expires_at<=now();
update public.subscriptions set status='expired',updated_at=now() where status in('active','trialing','grace') and current_period_end is not null and current_period_end<now() and coalesce(grace_period_end,'-infinity'::timestamptz)<now();
update public.investigation_sessions set status='expired',updated_at=now() where status='active' and lease_expires_at is not null and lease_expires_at<now();
update public.tty_executions set state='expired',finished_at=coalesce(finished_at,now()),failure_code=coalesce(failure_code,'lease_expired'),updated_at=now() where state in('leased','starting','running','streaming') and lease_expires_at is not null and lease_expires_at<now();
update public.investigations i set tty_session_id=null,updated_at=now() where tty_session_id is not null and not exists(select 1 from public.investigation_sessions s where s.id=i.tty_session_id and s.status='active');

-- Historical usage logs are the immutable source for repairing monthly summaries.
insert into public.user_usage_summary(user_id,period_start,messages_used,tokens_used,committed_cost_usd)
select user_id,date_trunc('month',created_at)::date,count(*),coalesce(sum(input_tokens+output_tokens),0),coalesce(sum(estimated_cost_usd),0)
from public.user_usage_logs group by user_id,date_trunc('month',created_at)::date
on conflict(user_id,period_start) do update set messages_used=excluded.messages_used,tokens_used=excluded.tokens_used,committed_cost_usd=excluded.committed_cost_usd,updated_at=now();
insert into public.user_usage_daily(user_id,usage_date,messages_used,tokens_used,committed_cost_usd)
select user_id,created_at::date,count(*),coalesce(sum(input_tokens+output_tokens),0),coalesce(sum(estimated_cost_usd),0)
from public.user_usage_logs group by user_id,created_at::date
on conflict(user_id,usage_date) do update set messages_used=excluded.messages_used,tokens_used=excluded.tokens_used,committed_cost_usd=excluded.committed_cost_usd,updated_at=now();

commit;
