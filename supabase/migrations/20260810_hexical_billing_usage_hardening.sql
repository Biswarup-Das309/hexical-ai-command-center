-- Hexical AI billing, usage, and idempotent payment RPCs.
-- Apply after 20260810_hexical_production_hardening.sql.
-- This file is intentionally manual: review in staging, take a backup, then
-- run in the Supabase SQL editor or through the Supabase CLI.

create extension if not exists pgcrypto;

-- Correct the original nullable uniqueness definition if that migration was
-- already applied. NULL provider identifiers must not make all free rows
-- collide with one another.
alter table if exists public.user_subscriptions
  drop constraint if exists user_subscriptions_provider_subscription_unique;
create unique index if not exists user_subscriptions_provider_subscription_idx
  on public.user_subscriptions (provider, provider_subscription_id)
  where provider is not null and provider_subscription_id is not null;

create table if not exists public.hexical_ai_budget_config (
  tier text primary key,
  monthly_cost_usd numeric(18, 6) not null check (monthly_cost_usd >= 0),
  monthly_message_limit integer not null check (monthly_message_limit > 0),
  updated_at timestamptz not null default now(),
  constraint hexical_ai_budget_config_tier_check check (tier in ('free', 'go', 'plus', 'pro'))
);

insert into public.hexical_ai_budget_config (tier, monthly_cost_usd, monthly_message_limit)
values
  ('free', 25, 600),
  ('go', 75, 1050),
  ('plus', 300, 3000),
  ('pro', 1000, 9000)
on conflict (tier) do nothing;

create table if not exists public.hexical_usage_counters (
  user_id text not null,
  period_start date not null,
  messages_used bigint not null default 0 check (messages_used >= 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  committed_cost_usd numeric(18, 6) not null default 0 check (committed_cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);

create index if not exists hexical_usage_counters_period_idx
  on public.hexical_usage_counters (period_start, updated_at desc);

create table if not exists public.hexical_budget_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tier text not null check (tier in ('free', 'go', 'plus', 'pro')),
  period_start date not null,
  estimated_cost_usd numeric(18, 6) not null check (estimated_cost_usd > 0),
  status text not null default 'reserved' check (status in ('reserved', 'released', 'committed', 'expired')),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  released_at timestamptz null
);

create index if not exists hexical_budget_reservations_active_idx
  on public.hexical_budget_reservations (user_id, period_start, status, expires_at)
  where status = 'reserved';

create table if not exists public.user_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tier text not null check (tier in ('free', 'go', 'plus', 'pro')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  route_type text not null default 'simple',
  endpoint text not null,
  estimated_cost_usd numeric(18, 6) not null default 0 check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);

alter table public.user_usage_logs add column if not exists estimated_cost_usd numeric(18, 6) not null default 0;
alter table public.user_usage_logs add column if not exists created_at timestamptz not null default now();
create index if not exists user_usage_logs_user_created_idx
  on public.user_usage_logs (user_id, created_at desc);
create index if not exists user_usage_logs_created_idx
  on public.user_usage_logs (created_at desc);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tier text not null,
  profile text not null,
  provider text not null,
  model text not null,
  route_mode text not null,
  complexity text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  tokens_total integer not null default 0,
  estimated_cost_paise bigint not null default 0,
  allocated_revenue_paise bigint not null default 0,
  estimated_profit_paise bigint not null default 0,
  latency_ms integer not null default 0,
  provider_retry_count integer not null default 0,
  fallback_used boolean not null default false,
  cache_key text null,
  swarm_used boolean not null default false,
  confidence_score numeric(8, 5) not null default 0,
  request_size_chars integer not null default 0,
  cache_hit boolean not null default false,
  authorization_scope_id uuid null,
  created_at timestamptz not null default now()
);

alter table public.usage_events add column if not exists authorization_scope_id uuid;
alter table public.usage_events add column if not exists created_at timestamptz not null default now();
create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

create table if not exists public.hexical_payment_events (
  payment_id text primary key,
  user_id text not null,
  order_id text null,
  tier text not null check (tier in ('go', 'plus', 'pro')),
  token_grant bigint not null default 0 check (token_grant >= 0),
  period_days integer not null check (period_days between 1 and 3660),
  processed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists hexical_payment_events_user_idx
  on public.hexical_payment_events (user_id, processed_at desc);
create unique index if not exists hexical_payment_events_order_idx
  on public.hexical_payment_events (order_id)
  where order_id is not null;

alter table public.hexical_ai_budget_config enable row level security;
alter table public.hexical_usage_counters enable row level security;
alter table public.hexical_budget_reservations enable row level security;
alter table public.user_usage_logs enable row level security;
alter table public.hexical_payment_events enable row level security;
alter table public.usage_events enable row level security;

drop policy if exists hexical_ai_budget_config_service_role on public.hexical_ai_budget_config;
create policy hexical_ai_budget_config_service_role on public.hexical_ai_budget_config
  for all to service_role using (true) with check (true);
drop policy if exists hexical_usage_counters_service_role on public.hexical_usage_counters;
create policy hexical_usage_counters_service_role on public.hexical_usage_counters
  for all to service_role using (true) with check (true);
drop policy if exists hexical_budget_reservations_service_role on public.hexical_budget_reservations;
create policy hexical_budget_reservations_service_role on public.hexical_budget_reservations
  for all to service_role using (true) with check (true);
drop policy if exists user_usage_logs_service_role on public.user_usage_logs;
create policy user_usage_logs_service_role on public.user_usage_logs
  for all to service_role using (true) with check (true);
drop policy if exists hexical_payment_events_service_role on public.hexical_payment_events;
create policy hexical_payment_events_service_role on public.hexical_payment_events
  for all to service_role using (true) with check (true);
drop policy if exists usage_events_service_role on public.usage_events;
create policy usage_events_service_role on public.usage_events
  for all to service_role using (true) with check (true);

create or replace function public.reserve_budget(
  p_user_id text,
  p_tier text,
  p_estimated_cost_usd numeric
)
returns table (allowed boolean, reason text, reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start date := date_trunc('month', now())::date;
  v_limit numeric(18, 6);
  v_committed numeric(18, 6);
  v_reserved numeric(18, 6);
  v_reservation_id uuid;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 or p_tier not in ('free', 'go', 'plus', 'pro') or p_estimated_cost_usd <= 0 then
    return query select false, 'invalid_budget_request', null::uuid;
    return;
  end if;

  delete from public.hexical_budget_reservations
   where user_id = p_user_id
     and status = 'reserved'
     and expires_at <= now();

  insert into public.hexical_usage_counters (user_id, period_start)
  values (p_user_id, v_period_start)
  on conflict (user_id, period_start) do nothing;

  select monthly_cost_usd into v_limit
  from public.hexical_ai_budget_config
  where tier = p_tier;

  if v_limit is null then
    return query select false, 'budget_config_missing', null::uuid;
    return;
  end if;

  select committed_cost_usd into v_committed
  from public.hexical_usage_counters
  where user_id = p_user_id and period_start = v_period_start
  for update;

  select coalesce(sum(estimated_cost_usd), 0) into v_reserved
  from public.hexical_budget_reservations
  where user_id = p_user_id
    and period_start = v_period_start
    and status = 'reserved'
    and expires_at > now();

  if v_committed + v_reserved + p_estimated_cost_usd > v_limit then
    return query select false, 'monthly_budget_exceeded', null::uuid;
    return;
  end if;

  insert into public.hexical_budget_reservations (user_id, tier, period_start, estimated_cost_usd)
  values (p_user_id, p_tier, v_period_start, p_estimated_cost_usd)
  returning hexical_budget_reservations.reservation_id into v_reservation_id;

  return query select true, null::text, v_reservation_id;
end;
$$;

create or replace function public.release_reservation(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.hexical_budget_reservations
     set status = 'released', released_at = now()
   where reservation_id = p_reservation_id
     and status = 'reserved';
end;
$$;

create or replace function public.increment_usage(
  p_user_id text,
  p_tokens integer,
  p_cost_usd numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start date := date_trunc('month', now())::date;
begin
  if p_user_id is null or p_tokens < 0 or p_cost_usd < 0 then
    raise exception 'invalid usage increment' using errcode = '22023';
  end if;

  insert into public.hexical_usage_counters (user_id, period_start, messages_used, tokens_used, committed_cost_usd)
  values (p_user_id, v_period_start, 1, p_tokens, p_cost_usd)
  on conflict (user_id, period_start) do update
    set messages_used = public.hexical_usage_counters.messages_used + 1,
        tokens_used = public.hexical_usage_counters.tokens_used + excluded.tokens_used,
        committed_cost_usd = public.hexical_usage_counters.committed_cost_usd + excluded.committed_cost_usd,
        updated_at = now();
end;
$$;

alter table public.user_subscriptions add column if not exists provider_payment_id text;
alter table public.user_subscriptions add column if not exists provider_order_id text;

create or replace function public.process_payment_webhook(
  p_payment_id text,
  p_user_id text,
  p_order_id text,
  p_tier text,
  p_tokens bigint,
  p_period_days integer
)
returns table (already_processed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_period_end timestamptz;
begin
  if p_payment_id is null or p_user_id is null or p_tier not in ('go', 'plus', 'pro') or p_tokens < 0 or p_period_days not between 1 and 3660 then
    raise exception 'invalid payment entitlement request' using errcode = '22023';
  end if;

  insert into public.hexical_payment_events (payment_id, user_id, order_id, tier, token_grant, period_days)
  values (p_payment_id, p_user_id, p_order_id, p_tier, p_tokens, p_period_days)
  on conflict (payment_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select true;
    return;
  end if;

  v_period_end := now() + make_interval(days => p_period_days);
  insert into public.user_subscriptions (
    user_id, tier, status, current_period_end, provider, provider_payment_id, provider_order_id, metadata
  ) values (
    p_user_id, p_tier, 'active', v_period_end, 'razorpay', p_payment_id, p_order_id,
    jsonb_build_object('token_grant', p_tokens, 'payment_id', p_payment_id, 'order_id', p_order_id)
  )
  on conflict (user_id) do update set
    tier = excluded.tier,
    status = 'active',
    current_period_end = greatest(coalesce(public.user_subscriptions.current_period_end, now()), excluded.current_period_end),
    provider = excluded.provider,
    provider_payment_id = excluded.provider_payment_id,
    provider_order_id = excluded.provider_order_id,
    metadata = public.user_subscriptions.metadata || excluded.metadata,
    updated_at = now();

  return query select false;
end;
$$;

create unique index if not exists user_subscriptions_provider_payment_idx
  on public.user_subscriptions (provider, provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists user_subscriptions_provider_order_idx
  on public.user_subscriptions (provider, provider_order_id)
  where provider_order_id is not null;
