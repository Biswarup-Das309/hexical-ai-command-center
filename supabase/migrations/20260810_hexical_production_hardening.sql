-- Hexical AI production hardening migration
-- Apply manually in Supabase Production after taking a schema backup.
-- This file is intentionally not executed by the application or test suite.
-- It is safe to re-run: objects are created with IF NOT EXISTS and trigger
-- functions are replaced deterministically.

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------------
-- Canonical entitlement ledger
-- -------------------------------------------------------------------------

create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tier text not null default 'free',
  status text not null default 'active',
  current_period_end timestamptz null,
  provider text null,
  provider_customer_id text null,
  provider_subscription_id text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_subscriptions_user_id_unique unique (user_id),
  constraint user_subscriptions_tier_check check (tier in ('free', 'go', 'plus', 'pro')),
  constraint user_subscriptions_status_check check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired', 'incomplete')),
  constraint user_subscriptions_provider_subscription_unique unique (provider, provider_subscription_id)
);

create index if not exists user_subscriptions_status_period_idx
  on public.user_subscriptions (status, current_period_end);
create index if not exists user_subscriptions_provider_customer_idx
  on public.user_subscriptions (provider, provider_customer_id);

do $$
begin
  if to_regclass('public.profiles') is not null then
    alter table public.profiles add column if not exists subscription_status text;
    alter table public.profiles add column if not exists current_period_end timestamptz;
  end if;
end;
$$;

create or replace function public.hexical_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = greatest(coalesce(old.updated_at, '-infinity'::timestamptz), coalesce(new.updated_at, now()), now());
  return new;
end;
$$;

drop trigger if exists user_subscriptions_set_updated_at on public.user_subscriptions;
create trigger user_subscriptions_set_updated_at
before update on public.user_subscriptions
for each row execute function public.hexical_set_updated_at();

create or replace function public.hexical_sync_legacy_profile_entitlement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regclass('public.profiles') is not null then
    update public.profiles
       set tier = new.tier,
           subscription_status = new.status,
           current_period_end = new.current_period_end
     where user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists user_subscriptions_sync_profile on public.user_subscriptions;
create trigger user_subscriptions_sync_profile
after insert or update of tier, status, current_period_end on public.user_subscriptions
for each row execute function public.hexical_sync_legacy_profile_entitlement();

-- -------------------------------------------------------------------------
-- Durable execution ledger, fencing, idempotency, and ordered events
-- -------------------------------------------------------------------------

create table if not exists public.hexical_execution_records (
  execution_id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  session_id uuid not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  kind text not null,
  state text not null default 'queued',
  attempt integer not null default 0,
  worker_id text null,
  lease_id text null,
  fencing_token bigint not null default 0,
  lease_expires_at timestamptz null,
  max_lease_expires_at timestamptz null,
  queued_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  queue_wait_ms bigint null,
  startup_ms bigint null,
  duration_ms bigint null,
  output_bytes bigint not null default 0,
  stdout_bytes bigint not null default 0,
  stderr_bytes bigint not null default 0,
  failure_code text null,
  completion_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hexical_execution_state_check check (state in ('queued', 'leased', 'starting', 'running', 'streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired')),
  constraint hexical_execution_attempt_check check (attempt >= 0 and attempt <= 100),
  constraint hexical_execution_fencing_check check (fencing_token >= 0),
  constraint hexical_execution_bytes_check check (output_bytes >= 0 and stdout_bytes >= 0 and stderr_bytes >= 0),
  constraint hexical_execution_idempotency_unique unique (owner_user_id, session_id, idempotency_key)
);

create table if not exists public.hexical_execution_leases (
  execution_id uuid primary key references public.hexical_execution_records(execution_id) on delete cascade,
  worker_id text not null,
  lease_id text not null,
  fencing_token bigint not null,
  claimed_at timestamptz not null default now(),
  renewed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_expires_at timestamptz not null,
  constraint hexical_execution_lease_fencing_check check (fencing_token > 0),
  constraint hexical_execution_lease_expiry_check check (max_expires_at >= expires_at)
);

create unique index if not exists hexical_execution_lease_identity_idx
  on public.hexical_execution_leases (execution_id, fencing_token);
create index if not exists hexical_execution_lease_expiry_idx
  on public.hexical_execution_leases (expires_at)
  where expires_at is not null;

create table if not exists public.hexical_execution_events (
  event_id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.hexical_execution_records(execution_id) on delete cascade,
  session_id uuid not null,
  sequence bigint not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint hexical_execution_event_sequence_check check (sequence > 0),
  constraint hexical_execution_event_type_check check (event_type in ('stdout', 'stderr', 'state', 'metric', 'heartbeat', 'completion', 'error')),
  constraint hexical_execution_event_sequence_unique unique (execution_id, sequence)
);

create index if not exists hexical_execution_events_replay_idx
  on public.hexical_execution_events (execution_id, sequence);
create index if not exists hexical_execution_events_session_idx
  on public.hexical_execution_events (session_id, occurred_at);
create index if not exists hexical_execution_records_owner_idx
  on public.hexical_execution_records (owner_user_id, created_at desc);
create index if not exists hexical_execution_records_session_state_idx
  on public.hexical_execution_records (session_id, state, updated_at desc);
create index if not exists hexical_execution_records_recovery_idx
  on public.hexical_execution_records (state, lease_expires_at)
  where state in ('leased', 'starting', 'running', 'streaming');

create table if not exists public.hexical_execution_repair_log (
  repair_id uuid primary key default gen_random_uuid(),
  execution_id uuid null,
  session_id uuid null,
  action text not null,
  previous_state text null,
  next_state text null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hexical_execution_repair_log_execution_idx
  on public.hexical_execution_repair_log (execution_id, created_at desc);

create or replace function public.hexical_guard_execution_transition()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.updated_at < old.updated_at then
    raise exception 'execution updated_at is not monotonic for %', old.execution_id using errcode = '22000';
  end if;
  if new.attempt < old.attempt then
    raise exception 'execution attempt is not monotonic for %', old.execution_id using errcode = '22000';
  end if;
  if old.state in ('succeeded', 'failed', 'cancelled', 'timed_out', 'expired') and new.state <> old.state then
    raise exception 'terminal execution % cannot transition from % to %', old.execution_id, old.state, new.state using errcode = '55000';
  end if;
  if old.state = 'queued' and new.state not in ('queued', 'leased', 'failed', 'cancelled', 'expired') then
    raise exception 'illegal execution transition % -> %', old.state, new.state using errcode = '55000';
  elsif old.state = 'leased' and new.state not in ('leased', 'starting', 'failed', 'cancelled', 'expired') then
    raise exception 'illegal execution transition % -> %', old.state, new.state using errcode = '55000';
  elsif old.state = 'starting' and new.state not in ('starting', 'running', 'failed', 'cancelled', 'timed_out', 'expired') then
    raise exception 'illegal execution transition % -> %', old.state, new.state using errcode = '55000';
  elsif old.state = 'running' and new.state not in ('running', 'streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired') then
    raise exception 'illegal execution transition % -> %', old.state, new.state using errcode = '55000';
  elsif old.state = 'streaming' and new.state not in ('streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired') then
    raise exception 'illegal execution transition % -> %', old.state, new.state using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists hexical_execution_transition_guard on public.hexical_execution_records;
create trigger hexical_execution_transition_guard
before update on public.hexical_execution_records
for each row execute function public.hexical_guard_execution_transition();

drop trigger if exists hexical_execution_updated_at on public.hexical_execution_records;
create trigger hexical_execution_updated_at
before update on public.hexical_execution_records
for each row execute function public.hexical_set_updated_at();

-- -------------------------------------------------------------------------
-- RLS: application server uses the service role; direct client reads are
-- denied unless a deployment adds an explicit owner mapping policy.
-- -------------------------------------------------------------------------

alter table public.user_subscriptions enable row level security;
alter table public.hexical_execution_records enable row level security;
alter table public.hexical_execution_leases enable row level security;
alter table public.hexical_execution_events enable row level security;
alter table public.hexical_execution_repair_log enable row level security;

drop policy if exists user_subscriptions_service_role on public.user_subscriptions;
create policy user_subscriptions_service_role on public.user_subscriptions
  for all to service_role using (true) with check (true);
drop policy if exists hexical_execution_records_service_role on public.hexical_execution_records;
create policy hexical_execution_records_service_role on public.hexical_execution_records
  for all to service_role using (true) with check (true);
drop policy if exists hexical_execution_leases_service_role on public.hexical_execution_leases;
create policy hexical_execution_leases_service_role on public.hexical_execution_leases
  for all to service_role using (true) with check (true);
drop policy if exists hexical_execution_events_service_role on public.hexical_execution_events;
create policy hexical_execution_events_service_role on public.hexical_execution_events
  for all to service_role using (true) with check (true);
drop policy if exists hexical_execution_repair_log_service_role on public.hexical_execution_repair_log;
create policy hexical_execution_repair_log_service_role on public.hexical_execution_repair_log
  for all to service_role using (true) with check (true);

comment on table public.user_subscriptions is 'Canonical Hexical entitlement source. profiles is a synchronized legacy projection only.';
comment on table public.hexical_execution_records is 'Durable execution state, ownership, fencing, idempotency, and recovery ledger.';
comment on table public.hexical_execution_events is 'Ordered, replayable execution event history.';
