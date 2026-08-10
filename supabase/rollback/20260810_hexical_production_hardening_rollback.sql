-- Rollback for 20260810_hexical_production_hardening.sql.
-- Review carefully: dropping the execution tables is destructive. The
-- default rollback below removes enforcement objects and preserves ledger
-- data. Only run the final DROP TABLE block if a backup and explicit rollback
-- approval exist.

begin;

drop trigger if exists hexical_execution_transition_guard on public.hexical_execution_records;
drop trigger if exists hexical_execution_updated_at on public.hexical_execution_records;
drop trigger if exists user_subscriptions_sync_profile on public.user_subscriptions;
drop trigger if exists user_subscriptions_set_updated_at on public.user_subscriptions;

drop function if exists public.hexical_guard_execution_transition();
drop function if exists public.hexical_sync_legacy_profile_entitlement();
drop function if exists public.hexical_set_updated_at();

drop policy if exists user_subscriptions_service_role on public.user_subscriptions;
drop policy if exists hexical_execution_records_service_role on public.hexical_execution_records;
drop policy if exists hexical_execution_leases_service_role on public.hexical_execution_leases;
drop policy if exists hexical_execution_events_service_role on public.hexical_execution_events;
drop policy if exists hexical_execution_repair_log_service_role on public.hexical_execution_repair_log;

commit;

-- Destructive full rollback (manual, separate review):
-- begin;
-- drop table if exists public.hexical_execution_repair_log;
-- drop table if exists public.hexical_execution_events;
-- drop table if exists public.hexical_execution_leases;
-- drop table if exists public.hexical_execution_records;
-- drop table if exists public.user_subscriptions;
-- commit;
