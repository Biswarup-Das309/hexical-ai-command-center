-- Safe rollback: restore policy access boundaries and application compatibility.
-- It does not delete production data. Run only after rolling application code back.
begin;

drop policy if exists conversations_owner on public.conversations;
drop policy if exists messages_owner on public.messages;
drop policy if exists profiles_owner_read on public.profiles;
drop policy if exists authorization_scopes_owner_read on public.hexical_authorization_scopes;
drop policy if exists authorization_scopes_owner_insert on public.hexical_authorization_scopes;

-- Restore the archived entitlement table only if it is needed by the old build.
do $$ begin
  if to_regclass('public.user_subscriptions_legacy_20260810') is not null and to_regclass('public.user_subscriptions') is not null and (select relkind from pg_class where oid='public.user_subscriptions'::regclass)='v' then
    drop view public.user_subscriptions;
    alter table public.user_subscriptions_legacy_20260810 rename to user_subscriptions;
  end if;
end $$;

-- New tables are deliberately retained as inactive forensic evidence. Their RLS
-- remains service-role only, so rolling back code cannot expose them.
commit;
