-- Run after 20260811_hexical_runtime_os_additive.sql. Each failure query is
-- expected to return zero rows; the final two queries are informational.
select required.table_name from (values
  ('hexical_entitlements'), ('hexical_runtime_execution_ledger'), ('hexical_runtime_execution_events')
) required(table_name)
left join pg_tables t on t.schemaname = 'public' and t.tablename = required.table_name
where t.tablename is null;

select required.function_name from (values ('canonical_entitlement'), ('hexical_ensure_profile')) required(function_name)
left join pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = required.function_name
where p.oid is null;

select relname from pg_class where relnamespace = 'public'::regnamespace
  and relname in ('hexical_entitlements', 'hexical_runtime_execution_ledger', 'hexical_runtime_execution_events')
  and relrowsecurity is false;

select user_id, count(*) from public.hexical_entitlements group by user_id having count(*) <> 1;
select user_id, tier, status from public.hexical_entitlements
where tier not in ('free', 'go', 'plus', 'pro', 'enterprise')
   or status not in ('none', 'active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete', 'grace');

select l.execution_id, l.state from public.hexical_runtime_execution_ledger l
where l.state in ('leased', 'starting', 'running', 'streaming') and l.updated_at < now() - interval '1 hour';
select execution_id, sequence, count(*) from public.hexical_runtime_execution_events
group by execution_id, sequence having count(*) <> 1;

select * from public.canonical_entitlement('<known Clerk user id>');
select count(*) as canonical_entitlements, count(*) filter (where status in ('active', 'trialing', 'grace')) as active_entitlements
from public.hexical_entitlements;
