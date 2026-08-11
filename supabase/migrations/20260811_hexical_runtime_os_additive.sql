-- Hexical Runtime OS additive production migration.
-- This migration is deliberately non-destructive: it creates new canonical
-- runtime/entitlement objects and never drops or rebuilds application data.
begin;

create table if not exists public.hexical_entitlements (
  user_id text primary key,
  tier text not null default 'free' check (tier in ('free', 'go', 'plus', 'pro', 'enterprise')),
  status text not null default 'none' check (status in ('none', 'active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete', 'grace')),
  current_period_end timestamptz,
  enterprise_unlimited boolean not null default false,
  source text not null default 'bootstrap',
  updated_at timestamptz not null default now()
);
create index if not exists hexical_entitlements_active_idx on public.hexical_entitlements (status, current_period_end);

create table if not exists public.hexical_runtime_execution_ledger (
  execution_id uuid primary key,
  owner_user_id text not null,
  session_id uuid not null,
  state text not null check (state in ('queued', 'leased', 'starting', 'running', 'streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_id text,
  lease_id text,
  queued_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  diagnostics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists hexical_runtime_execution_recovery_idx on public.hexical_runtime_execution_ledger (state, updated_at)
  where state in ('leased', 'starting', 'running', 'streaming');

create table if not exists public.hexical_runtime_execution_events (
  execution_id uuid not null references public.hexical_runtime_execution_ledger(execution_id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in ('stdout', 'stderr', 'state', 'metric', 'heartbeat', 'completion', 'error')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  primary key (execution_id, sequence)
);
create index if not exists hexical_runtime_execution_events_replay_idx on public.hexical_runtime_execution_events (execution_id, sequence);

alter table public.hexical_entitlements enable row level security;
alter table public.hexical_runtime_execution_ledger enable row level security;
alter table public.hexical_runtime_execution_events enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'hexical_entitlements' and policyname = 'hexical_entitlements_service_role') then
    create policy hexical_entitlements_service_role on public.hexical_entitlements for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'hexical_runtime_execution_ledger' and policyname = 'hexical_runtime_ledger_service_role') then
    create policy hexical_runtime_ledger_service_role on public.hexical_runtime_execution_ledger for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'hexical_runtime_execution_events' and policyname = 'hexical_runtime_events_service_role') then
    create policy hexical_runtime_events_service_role on public.hexical_runtime_execution_events for all to service_role using (true) with check (true);
  end if;
end $$;

create or replace function public.hexical_sync_canonical_entitlement()
returns trigger language plpgsql security definer set search_path = public as $$
declare row_data jsonb := to_jsonb(new);
begin
  insert into public.hexical_entitlements (user_id, tier, status, current_period_end, enterprise_unlimited, source, updated_at)
  values (
    row_data->>'user_id',
    case when row_data->>'tier' in ('free', 'go', 'plus', 'pro', 'enterprise') then row_data->>'tier' else 'free' end,
    case when row_data->>'status' in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete', 'grace') then row_data->>'status' else 'none' end,
    nullif(row_data->>'current_period_end', '')::timestamptz,
    coalesce((row_data->>'enterprise_unlimited')::boolean, false),
    tg_table_name,
    now()
  ) on conflict (user_id) do update set
    tier = excluded.tier, status = excluded.status, current_period_end = excluded.current_period_end,
    enterprise_unlimited = excluded.enterprise_unlimited, source = excluded.source, updated_at = excluded.updated_at;
  return new;
end $$;

do $$ begin
  if to_regclass('public.user_subscriptions') is not null then
    execute 'insert into public.hexical_entitlements (user_id, tier, status, current_period_end, source) select user_id, case when tier in (''free'', ''go'', ''plus'', ''pro'', ''enterprise'') then tier else ''free'' end, case when status in (''active'', ''trialing'', ''past_due'', ''paused'', ''canceled'', ''expired'', ''incomplete'', ''grace'') then status else ''none'' end, current_period_end, ''user_subscriptions'' from public.user_subscriptions on conflict (user_id) do update set tier = excluded.tier, status = excluded.status, current_period_end = excluded.current_period_end, source = excluded.source, updated_at = now()';
    if not exists (select 1 from pg_trigger where tgname = 'user_subscriptions_sync_canonical_entitlement') then
      execute 'create trigger user_subscriptions_sync_canonical_entitlement after insert or update of tier, status, current_period_end on public.user_subscriptions for each row execute function public.hexical_sync_canonical_entitlement()';
    end if;
  end if;
  if to_regclass('public.subscriptions') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'enterprise_unlimited') then
      execute 'insert into public.hexical_entitlements (user_id, tier, status, current_period_end, enterprise_unlimited, source) select user_id, case when tier in (''free'', ''go'', ''plus'', ''pro'', ''enterprise'') then tier else ''free'' end, case when status in (''active'', ''trialing'', ''past_due'', ''paused'', ''canceled'', ''expired'', ''incomplete'', ''grace'') then status else ''none'' end, current_period_end, coalesce(enterprise_unlimited, false), ''subscriptions'' from public.subscriptions on conflict (user_id) do update set tier = excluded.tier, status = excluded.status, current_period_end = excluded.current_period_end, enterprise_unlimited = excluded.enterprise_unlimited, source = excluded.source, updated_at = now()';
      if not exists (select 1 from pg_trigger where tgname = 'subscriptions_sync_canonical_entitlement') then
        execute 'create trigger subscriptions_sync_canonical_entitlement after insert or update of tier, status, current_period_end, enterprise_unlimited on public.subscriptions for each row execute function public.hexical_sync_canonical_entitlement()';
      end if;
    else
      execute 'insert into public.hexical_entitlements (user_id, tier, status, current_period_end, source) select user_id, case when tier in (''free'', ''go'', ''plus'', ''pro'', ''enterprise'') then tier else ''free'' end, case when status in (''active'', ''trialing'', ''past_due'', ''paused'', ''canceled'', ''expired'', ''incomplete'', ''grace'') then status else ''none'' end, current_period_end, ''subscriptions'' from public.subscriptions on conflict (user_id) do update set tier = excluded.tier, status = excluded.status, current_period_end = excluded.current_period_end, source = excluded.source, updated_at = now()';
      if not exists (select 1 from pg_trigger where tgname = 'subscriptions_sync_canonical_entitlement') then
        execute 'create trigger subscriptions_sync_canonical_entitlement after insert or update of tier, status, current_period_end on public.subscriptions for each row execute function public.hexical_sync_canonical_entitlement()';
      end if;
    end if;
  end if;
end $$;

create or replace function public.hexical_ensure_profile(p_user_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then raise exception 'invalid profile identity' using errcode = '22023'; end if;
  insert into public.hexical_entitlements (user_id) values (p_user_id) on conflict (user_id) do nothing;
end $$;

create or replace function public.canonical_entitlement(p_user_id text)
returns table(user_id text, tier text, status text, current_period_end timestamptz, enterprise_unlimited boolean, active boolean)
language sql stable security definer set search_path = public as $$
  select e.user_id, e.tier, e.status, e.current_period_end, e.enterprise_unlimited,
    e.enterprise_unlimited or (e.status in ('active', 'trialing', 'grace') and (e.current_period_end is null or e.current_period_end >= now()))
  from public.hexical_entitlements e where e.user_id = p_user_id
$$;

revoke all on function public.hexical_ensure_profile(text) from public, anon, authenticated;
revoke all on function public.canonical_entitlement(text) from public, anon, authenticated;
grant execute on function public.hexical_ensure_profile(text) to service_role;
grant execute on function public.canonical_entitlement(text) to service_role;
commit;
