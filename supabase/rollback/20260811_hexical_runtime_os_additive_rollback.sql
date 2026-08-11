-- Emergency rollback for the additive Runtime OS migration. This does not
-- delete source subscriptions, profiles, executions, or user data. Stop the
-- application first, deploy the prior app version, then run this script only
-- if the canonical bridge itself is confirmed as the fault.
begin;
do $$ begin
  if to_regclass('public.subscriptions') is not null then
    execute 'drop trigger if exists subscriptions_sync_canonical_entitlement on public.subscriptions';
  end if;
  if to_regclass('public.user_subscriptions') is not null then
    execute 'drop trigger if exists user_subscriptions_sync_canonical_entitlement on public.user_subscriptions';
  end if;
end $$;
drop function if exists public.hexical_sync_canonical_entitlement();
-- Keep the additive ledger tables as forensic evidence. Their contents are
-- intentionally not deleted by rollback.
commit;
