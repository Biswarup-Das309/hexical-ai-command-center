-- Every query below should return zero rows unless an exception is documented.

select tier, count(*)
from public.hexical_ai_budget_config
group by tier
having count(*) <> 1;

select reservation_id, user_id, status, expires_at
from public.hexical_budget_reservations
where status = 'reserved' and expires_at <= now();

select r.reservation_id
from public.hexical_budget_reservations r
left join public.hexical_usage_counters c
  on c.user_id = r.user_id and c.period_start = r.period_start
where c.user_id is null;

select user_id, period_start, messages_used, tokens_used, committed_cost_usd
from public.hexical_usage_counters
where messages_used < 0 or tokens_used < 0 or committed_cost_usd < 0;

select payment_id, count(*)
from public.hexical_payment_events
group by payment_id
having count(*) <> 1;

select payment_id, user_id, tier, processed_at
from public.hexical_payment_events
where tier not in ('go', 'plus', 'pro')
   or token_grant < 0
   or period_days not between 1 and 3660;

select routine_name, routine_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('reserve_budget', 'release_reservation', 'increment_usage', 'process_payment_webhook')
  and routine_type <> 'FUNCTION';

select required.table_name
from (values
  ('hexical_ai_budget_config'),
  ('hexical_usage_counters'),
  ('hexical_budget_reservations'),
  ('user_usage_logs'),
  ('usage_events'),
  ('hexical_payment_events')
) as required(table_name)
where to_regclass('public.' || required.table_name) is null;

select c.user_id, c.period_start, c.messages_used, coalesce(x.message_count, 0) as logged_messages
from public.hexical_usage_counters c
left join (
  select user_id, date_trunc('month', created_at)::date as period_start, count(*)::bigint as message_count
  from public.user_usage_logs
  group by user_id, date_trunc('month', created_at)::date
) x using (user_id, period_start)
where c.period_start = date_trunc('month', now())::date
  and c.messages_used < coalesce(x.message_count, 0);

select relname as table_name, relrowsecurity
from pg_class
where relname in ('hexical_ai_budget_config', 'hexical_usage_counters', 'hexical_budget_reservations', 'user_usage_logs', 'usage_events', 'hexical_payment_events')
  and not relrowsecurity;

