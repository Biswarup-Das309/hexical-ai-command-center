-- Run after 20260810_hexical_definitive_rebuild.sql.
-- Expected failure queries return zero rows. The final query is informational.

select required.table_name from (values
 ('profiles'),('subscriptions'),('payments'),('tier_limits'),('model_pricing'),('usage_events'),('usage_reservations'),('user_usage_daily'),('user_usage_logs'),('user_usage_summary'),('conversations'),('messages'),('investigations'),('investigation_sessions'),('investigation_executions'),('investigation_graph_nodes'),('investigation_graph_edges'),('tty_executions'),('tty_execution_events'),('tty_execution_artifacts'),('tty_execution_metrics'),('hexical_authorization_scopes'),('hexical_authorization_audit')
) required(table_name) left join pg_tables t on t.schemaname='public' and t.tablename=required.table_name where t.tablename is null;

select required.column_name from (values
 ('profiles','user_id'),('subscriptions','user_id'),('conversations','user_id'),('messages','conversation_id'),('investigations','owner_user_id'),('investigation_sessions','investigation_id'),('tty_executions','session_id'),('tty_execution_events','execution_id'),('tty_execution_artifacts','execution_id'),('tty_execution_metrics','execution_id'),('usage_events','authorization_scope_id')
) required(table_name,column_name) left join information_schema.columns c on c.table_schema='public' and c.table_name=required.table_name and c.column_name=required.column_name where c.column_name is null;

select required.index_name from (values ('profiles_user_id_key'),('subscriptions_user_entitlement_idx'),('conversations_owner_created_idx'),('messages_conversation_created_idx'),('tty_executions_recovery_idx'),('tty_execution_events_replay_idx'),('tty_execution_metrics_series_idx')) required(index_name) left join pg_indexes i on i.schemaname='public' and i.indexname=required.index_name where i.indexname is null;
select c.conname from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and c.contype='f' and c.conname in ('subscriptions_user_id_fkey','conversations_user_id_fkey','messages_user_id_fkey','investigations_owner_user_id_fkey','tty_executions_owner_user_id_fkey');
select required.trigger_name from (values ('profiles_updated_at'),('subscriptions_updated_at'),('subscriptions_sync_profile'),('executions_updated_at')) required(trigger_name) left join pg_trigger t on t.tgname=required.trigger_name and not t.tgisinternal where t.oid is null;
select required.function_name from (values ('canonical_entitlement'),('hexical_current_user_id'),('reserve_budget'),('release_reservation'),('increment_usage'),('process_payment_webhook')) required(function_name) left join pg_proc p on p.pronamespace='public'::regnamespace and p.proname=required.function_name where p.oid is null;

select tablename from pg_tables where schemaname='public' and tablename in ('profiles','subscriptions','payments','usage_events','conversations','messages','investigations','tty_executions') and rowsecurity is false;
select tablename,policyname,roles from pg_policies where schemaname='public' and ('public'=any(roles) or 'anon'=any(roles));

select 'orphan_profiles' issue, count(*) value from public.conversations c left join public.profiles p on p.user_id=c.user_id where p.user_id is null
union all select 'orphan_conversations',count(*) from public.messages m left join public.conversations c on c.id=m.conversation_id where c.id is null
union all select 'orphan_execution_owner',count(*) from public.tty_executions e left join public.profiles p on p.user_id=e.owner_user_id where p.user_id is null
union all select 'stale_running_executions',count(*) from public.tty_executions where state in('leased','starting','running','streaming') and lease_expires_at<now();

select e.user_id,e.tier,e.status,e.active from public.profiles p cross join lateral public.canonical_entitlement(p.user_id) e order by e.user_id;
select (select count(*) from public.profiles) profiles,(select count(*) from public.subscriptions) subscriptions,(select count(*) from public.investigations) investigations,(select count(*) from public.tty_executions) tty_executions,(select count(*) from public.usage_events) usage_events;
