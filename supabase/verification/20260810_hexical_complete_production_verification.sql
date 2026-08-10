-- All queries must return zero rows unless explicitly marked informational.

-- Required tables, indexes, functions, views, triggers and RLS.
select v.object_name from (values ('profiles'),('subscriptions'),('conversations'),('messages'),('investigations'),('investigation_sessions'),('tty_executions'),('tty_execution_events'),('tty_execution_artifacts'),('tty_execution_metrics'),('user_usage_daily'),('user_usage_summary'),('user_usage_logs')) v(object_name) left join pg_class c on c.oid=to_regclass('public.'||v.object_name) where c.oid is null;
select v.index_name from (values ('profiles_user_id_uidx'),('subscriptions_user_entitlement_idx'),('conversations_owner_created_idx'),('messages_conversation_created_idx'),('tty_executions_recovery_idx'),('tty_execution_events_replay_idx')) v(index_name) left join pg_indexes i on i.schemaname='public' and i.indexname=v.index_name where i.indexname is null;
select v.function_name from (values ('canonical_entitlement'),('reserve_budget'),('release_reservation'),('increment_usage'),('process_payment_webhook'),('hexical_current_user_id')) v(function_name) left join pg_proc p on p.proname=v.function_name and p.pronamespace='public'::regnamespace where p.oid is null;
select tablename from pg_tables where schemaname='public' and tablename in ('profiles','subscriptions','conversations','messages','investigations','tty_executions','usage_events') and rowsecurity=false;

-- Every user-owned row must have a canonical profile.
select 'conversations' source,c.user_id from public.conversations c left join public.profiles p on p.user_id=c.user_id where p.user_id is null
union all select 'messages',m.user_id from public.messages m left join public.profiles p on p.user_id=m.user_id where p.user_id is null
union all select 'subscriptions',s.user_id from public.subscriptions s left join public.profiles p on p.user_id=s.user_id where p.user_id is null
union all select 'usage_events',u.user_id from public.usage_events u left join public.profiles p on p.user_id=u.user_id where p.user_id is null;

-- Exactly one live entitlement per identity and no stale terminal work.
select user_id,count(*) from public.subscriptions where status in ('active','trialing','grace') group by user_id having count(*)>1;
select e.user_id,e.tier,e.status,e.current_period_end,e.active from public.profiles p cross join lateral public.canonical_entitlement(p.user_id) e where e.active and e.tier='free';
select id,state,lease_expires_at from public.tty_executions where state in ('leased','starting','running','streaming') and lease_expires_at < now();

-- Ensure no policy is accidentally granted to public/anon.
select tablename,policyname,roles,cmd from pg_policies where schemaname='public' and tablename in ('conversations','messages','profiles','subscriptions','payments','usage_events','investigations','tty_executions') and ('public'=any(roles) or 'anon'=any(roles));

-- Informational final snapshot: retain with the deployment evidence.
select (select count(*) from public.profiles) profiles,(select count(*) from public.subscriptions) subscriptions,(select count(*) from public.investigations) investigations,(select count(*) from public.tty_executions) tty_executions,(select count(*) from public.usage_events) usage_events;
