-- Hexical AI definitive production reset (expand/contract, data preserving).
-- Run ONLY after taking a Supabase backup and before deploying the matching code.
-- This migration deliberately archives the old user_subscriptions table instead
-- of deleting it; the compatibility object created below is read-only.

begin;

create extension if not exists pgcrypto;

-- Canonical identity is profiles.user_id (the Clerk subject), never auth.users.id.
alter table public.profiles add column if not exists subscription_status text;
alter table public.profiles add column if not exists current_period_start timestamptz;
alter table public.profiles add column if not exists current_period_end timestamptz;
alter table public.profiles add column if not exists cancel_at_period_end boolean not null default false;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
create unique index if not exists profiles_user_id_uidx on public.profiles (user_id);

-- Create missing profiles before adding ownership foreign keys. These are
-- intentionally free/unentitled until a subscription record says otherwise.
insert into public.profiles (user_id)
select distinct user_id
from (
  select user_id from public.conversations where user_id is not null
  union select user_id from public.messages where user_id is not null
  union select user_id from public.chats where user_id is not null
  union select user_id from public.subscriptions where user_id is not null
  union select user_id from public.usage_events where user_id is not null
  union select user_id from public.usage_reservations where user_id is not null
  union select user_id from public.hexical_authorization_scopes where user_id is not null
  union select user_id from public.hexical_authorization_audit where user_id is not null
) ids
on conflict (user_id) do nothing;

-- Normalize the live subscription ledger instead of introducing a second one.
alter table public.subscriptions
  alter column current_period_end type timestamptz using current_period_end at time zone 'UTC';
alter table public.subscriptions add column if not exists current_period_start timestamptz;
alter table public.subscriptions add column if not exists provider text;
alter table public.subscriptions add column if not exists provider_customer_id text;
alter table public.subscriptions add column if not exists provider_subscription_id text;
alter table public.subscriptions add column if not exists provider_payment_id text;
alter table public.subscriptions add column if not exists provider_order_id text;
alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.subscriptions add column if not exists grace_period_end timestamptz;
alter table public.subscriptions add column if not exists enterprise_unlimited boolean not null default false;
alter table public.subscriptions add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.subscriptions add column if not exists updated_at timestamptz not null default now();
alter table public.subscriptions drop constraint if exists subscriptions_tier_check;
alter table public.subscriptions add constraint subscriptions_tier_check check (tier in ('free','go','plus','pro','enterprise')) not valid;
alter table public.subscriptions validate constraint subscriptions_tier_check;
alter table public.subscriptions drop constraint if exists subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check check (status in ('active','trialing','past_due','paused','canceled','expired','incomplete','grace')) not valid;
alter table public.subscriptions validate constraint subscriptions_status_check;
create index if not exists subscriptions_user_entitlement_idx on public.subscriptions (user_id, status, current_period_end desc);
create unique index if not exists subscriptions_provider_subscription_uidx on public.subscriptions (provider, provider_subscription_id) where provider_subscription_id is not null;
create unique index if not exists subscriptions_provider_payment_uidx on public.subscriptions (provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists subscriptions_provider_order_uidx on public.subscriptions (provider, provider_order_id) where provider_order_id is not null;

-- Archive a previously-created duplicate entitlement table and replace it with
-- a compatibility view. No data is deleted; all rows are copied first.
do $$
begin
  if to_regclass('public.user_subscriptions') is not null
     and (select relkind from pg_class where oid = 'public.user_subscriptions'::regclass) = 'r' then
    insert into public.subscriptions (user_id, tier, status, current_period_end, provider, provider_customer_id, provider_subscription_id, provider_payment_id, provider_order_id, metadata)
    select user_id, tier, status, current_period_end, provider, provider_customer_id, provider_subscription_id,
           provider_payment_id, provider_order_id, coalesce(metadata, '{}'::jsonb)
    from public.user_subscriptions
    on conflict do nothing;
    alter table public.user_subscriptions rename to user_subscriptions_legacy_20260810;
  end if;
  if to_regclass('public.user_subscriptions') is null then
    execute 'create view public.user_subscriptions with (security_barrier = true) as select id, user_id, tier, status, current_period_end, provider, provider_customer_id, provider_subscription_id, provider_payment_id, provider_order_id, metadata, created_at, updated_at from public.subscriptions';
  end if;
end $$;

-- Canonical usage tables. The exported usage_reservations table is retained
-- and upgraded, so outstanding work remains recoverable.
create table if not exists public.user_usage_daily (
  user_id text not null references public.profiles(user_id) on delete cascade,
  usage_date date not null,
  messages_used bigint not null default 0 check (messages_used >= 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  committed_cost_usd numeric(18,6) not null default 0 check (committed_cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);
create table if not exists public.user_usage_summary (
  user_id text not null references public.profiles(user_id) on delete cascade,
  period_start date not null,
  messages_used bigint not null default 0 check (messages_used >= 0),
  tokens_used bigint not null default 0 check (tokens_used >= 0),
  committed_cost_usd numeric(18,6) not null default 0 check (committed_cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);
alter table public.usage_reservations add column if not exists period_start date not null default date_trunc('month', now())::date;
alter table public.usage_reservations add column if not exists status text not null default 'reserved';
alter table public.usage_reservations add column if not exists expires_at timestamptz not null default (now() + interval '15 minutes');
alter table public.usage_reservations add column if not exists released_at timestamptz;
alter table public.usage_reservations add constraint usage_reservations_status_check check (status in ('reserved','released','committed','expired')) not valid;
alter table public.usage_reservations validate constraint usage_reservations_status_check;
create index if not exists usage_reservations_active_idx on public.usage_reservations (user_id, period_start, expires_at) where status = 'reserved';
create table if not exists public.user_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(user_id) on delete cascade,
  tier text not null check (tier in ('free','go','plus','pro','enterprise')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  route_type text not null default 'simple', endpoint text not null,
  estimated_cost_usd numeric(18,6) not null default 0 check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index if not exists user_usage_logs_owner_idx on public.user_usage_logs (user_id, created_at desc);
create index if not exists user_usage_summary_period_idx on public.user_usage_summary (period_start, updated_at desc);

alter table public.tier_limits add column if not exists monthly_budget_usd numeric(18,6) not null default 0;
alter table public.tier_limits add column if not exists monthly_message_limit integer not null default 0;
alter table public.tier_limits add column if not exists max_concurrent_executions integer not null default 1;
alter table public.tier_limits add column if not exists max_execution_seconds integer not null default 60;
alter table public.tier_limits add column if not exists max_artifact_bytes bigint not null default 10485760;
insert into public.tier_limits (tier, daily_budget_usd, max_requests_per_day, monthly_budget_usd, monthly_message_limit, max_concurrent_executions, max_execution_seconds, max_artifact_bytes)
values ('free', 2, 100, 25, 600, 1, 120, 104857600), ('go', 5, 500, 75, 1050, 2, 300, 1073741824), ('plus', 20, 2000, 300, 3000, 4, 900, 10737418240), ('pro', 50, 10000, 1000, 9000, 12, 3600, 107374182400), ('enterprise', 1000, null, 100000, 1000000, 100, 14400, 1099511627776)
on conflict (tier) do update set daily_budget_usd = excluded.daily_budget_usd, max_requests_per_day = excluded.max_requests_per_day, monthly_budget_usd = excluded.monthly_budget_usd, monthly_message_limit = excluded.monthly_message_limit, max_concurrent_executions = excluded.max_concurrent_executions, max_execution_seconds = excluded.max_execution_seconds, max_artifact_bytes = excluded.max_artifact_bytes;

-- Conversations and security/usage ownership columns and indexes.
alter table public.usage_events add column if not exists authorization_scope_id uuid references public.hexical_authorization_scopes(id) on delete set null;
create index if not exists conversations_owner_created_idx on public.conversations (user_id, created_at desc);
create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index if not exists usage_events_owner_created_idx on public.usage_events (user_id, created_at desc);
create index if not exists authorization_scopes_owner_status_idx on public.hexical_authorization_scopes (user_id, status, expires_at);
create index if not exists authorization_audit_owner_created_idx on public.hexical_authorization_audit (user_id, created_at desc);

-- Every legacy user-owned table now points to the canonical Clerk identity.
do $$
begin
  if not exists(select 1 from pg_constraint where conname='conversations_user_profile_fkey') then alter table public.conversations add constraint conversations_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='messages_user_profile_fkey') then alter table public.messages add constraint messages_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='chats_user_profile_fkey') then alter table public.chats add constraint chats_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='subscriptions_user_profile_fkey') then alter table public.subscriptions add constraint subscriptions_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='usage_events_user_profile_fkey') then alter table public.usage_events add constraint usage_events_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='usage_reservations_user_profile_fkey') then alter table public.usage_reservations add constraint usage_reservations_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='authorization_scopes_user_profile_fkey') then alter table public.hexical_authorization_scopes add constraint authorization_scopes_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete cascade; end if;
  if not exists(select 1 from pg_constraint where conname='authorization_audit_user_profile_fkey') then alter table public.hexical_authorization_audit add constraint authorization_audit_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete restrict; end if;
  if not exists(select 1 from pg_constraint where conname='payments_user_profile_fkey') then alter table public.payments add constraint payments_user_profile_fkey foreign key(user_id) references public.profiles(user_id) on delete restrict; end if;
end $$;

-- Durable workspace and execution architecture.
create table if not exists public.investigations (
  id uuid primary key default gen_random_uuid(), owner_user_id text not null references public.profiles(user_id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200), description text not null default '', status text not null default 'active' check (status in ('active','archived','deleted')),
  tty_session_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create index if not exists investigations_owner_updated_idx on public.investigations (owner_user_id, updated_at desc) where status <> 'deleted';
create table if not exists public.investigation_sessions (
  id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade,
  owner_user_id text not null references public.profiles(user_id) on delete cascade, status text not null default 'active' check (status in ('active','terminated','expired','repairing')),
  runtime jsonb not null default '{}'::jsonb, lease_expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists investigation_sessions_active_uidx on public.investigation_sessions(investigation_id) where status = 'active';
create table if not exists public.tty_executions (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.investigation_sessions(id) on delete cascade,
  investigation_id uuid not null references public.investigations(id) on delete cascade, owner_user_id text not null references public.profiles(user_id) on delete cascade,
  idempotency_key text not null, request_fingerprint text not null, command text not null, state text not null default 'queued' check (state in ('queued','leased','starting','running','streaming','succeeded','failed','cancelled','timed_out','expired')),
  attempt integer not null default 0 check (attempt between 0 and 100), worker_id text, lease_id text, fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_expires_at timestamptz, queued_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz, exit_code integer, failure_code text, diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_user_id, session_id, idempotency_key)
);
create index if not exists tty_executions_recovery_idx on public.tty_executions (state, lease_expires_at) where state in ('leased','starting','running','streaming');
create index if not exists tty_executions_owner_created_idx on public.tty_executions (owner_user_id, created_at desc);
create table if not exists public.tty_execution_events (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade,
  sequence bigint not null check (sequence > 0), stream text not null check (stream in ('stdout','stderr','state','metric','heartbeat','completion','error')),
  payload jsonb not null default '{}'::jsonb, occurred_at timestamptz not null default now(), unique(execution_id, sequence)
);
create index if not exists tty_execution_events_replay_idx on public.tty_execution_events(execution_id, sequence);
create table if not exists public.tty_execution_artifacts (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade,
  owner_user_id text not null references public.profiles(user_id) on delete cascade, path text not null, content_type text, byte_size bigint not null default 0 check(byte_size >= 0), storage_key text not null, sha256 text, created_at timestamptz not null default now(), unique(execution_id, path)
);
create table if not exists public.tty_execution_metrics (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade,
  sampled_at timestamptz not null default now(), cpu_pct numeric(6,2) check(cpu_pct >= 0), memory_bytes bigint check(memory_bytes >= 0), network_rx_bytes bigint check(network_rx_bytes >= 0), network_tx_bytes bigint check(network_tx_bytes >= 0), process_count integer check(process_count >= 0)
);
create index if not exists tty_execution_metrics_series_idx on public.tty_execution_metrics(execution_id, sampled_at);
create table if not exists public.investigation_executions (investigation_id uuid not null references public.investigations(id) on delete cascade, execution_id uuid not null references public.tty_executions(id) on delete cascade, attached_at timestamptz not null default now(), primary key(investigation_id, execution_id));
create table if not exists public.investigation_graph_nodes (id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade, node_type text not null, label text not null, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table if not exists public.investigation_graph_edges (id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade, source_node_id uuid not null references public.investigation_graph_nodes(id) on delete cascade, target_node_id uuid not null references public.investigation_graph_nodes(id) on delete cascade, edge_type text not null, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), check(source_node_id <> target_node_id));

create or replace function public.hexical_set_updated_at() returns trigger language plpgsql security invoker set search_path = public as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists profiles_set_updated_at on public.profiles; create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.hexical_set_updated_at();
drop trigger if exists subscriptions_set_updated_at on public.subscriptions; create trigger subscriptions_set_updated_at before update on public.subscriptions for each row execute function public.hexical_set_updated_at();
drop trigger if exists investigations_set_updated_at on public.investigations; create trigger investigations_set_updated_at before update on public.investigations for each row execute function public.hexical_set_updated_at();
drop trigger if exists investigation_sessions_set_updated_at on public.investigation_sessions; create trigger investigation_sessions_set_updated_at before update on public.investigation_sessions for each row execute function public.hexical_set_updated_at();
drop trigger if exists tty_executions_set_updated_at on public.tty_executions; create trigger tty_executions_set_updated_at before update on public.tty_executions for each row execute function public.hexical_set_updated_at();

create or replace function public.hexical_sync_profile_entitlement() returns trigger language plpgsql security definer set search_path = public as $$ begin update public.profiles set subscription_status = new.status, current_period_start = new.current_period_start, current_period_end = new.current_period_end, cancel_at_period_end = new.cancel_at_period_end where user_id = new.user_id; return new; end $$;
drop trigger if exists subscriptions_sync_profile on public.subscriptions; create trigger subscriptions_sync_profile after insert or update of status, current_period_start, current_period_end, cancel_at_period_end on public.subscriptions for each row execute function public.hexical_sync_profile_entitlement();

create or replace function public.canonical_entitlement(p_user_id text)
returns table(user_id text, tier text, status text, current_period_start timestamptz, current_period_end timestamptz, enterprise_unlimited boolean, active boolean)
language sql stable security definer set search_path = public as $$
  select p_user_id, coalesce(s.tier, 'free'), coalesce(s.status, 'none'), s.current_period_start, s.current_period_end, coalesce(s.enterprise_unlimited,false),
    coalesce(s.enterprise_unlimited,false) or (s.status in ('active','trialing','grace') and (s.current_period_end is null or s.current_period_end > now() or coalesce(s.grace_period_end, '-infinity'::timestamptz) > now()))
  from (select 1) x left join lateral (select * from public.subscriptions where user_id = p_user_id order by enterprise_unlimited desc, current_period_end desc nulls last, updated_at desc limit 1) s on true;
$$;

create or replace function public.reserve_budget(p_user_id text, p_tier text, p_estimated_cost_usd numeric)
returns table(allowed boolean, reason text, reservation_id uuid) language plpgsql security definer set search_path = public as $$
declare v_period date := date_trunc('month', now())::date; v_limit numeric; v_committed numeric; v_reserved numeric; v_id uuid;
begin
  if p_user_id is null or p_estimated_cost_usd <= 0 then return query select false, 'invalid_budget_request', null::uuid; return; end if;
  insert into public.user_usage_summary(user_id,period_start) values(p_user_id,v_period) on conflict do nothing;
  select monthly_budget_usd into v_limit from public.tier_limits where tier=p_tier;
  if v_limit is null then return query select false,'budget_config_missing',null::uuid; return; end if;
  select committed_cost_usd into v_committed from public.user_usage_summary where user_id=p_user_id and period_start=v_period for update;
  select coalesce(sum(estimated_cost_usd),0) into v_reserved from public.usage_reservations where user_id=p_user_id and period_start=v_period and status='reserved' and expires_at>now();
  if v_committed + v_reserved + p_estimated_cost_usd > v_limit then return query select false,'monthly_budget_exceeded',null::uuid; return; end if;
  insert into public.usage_reservations(user_id,tier,estimated_cost_usd,period_start) values(p_user_id,p_tier,p_estimated_cost_usd,v_period) returning id into v_id;
  return query select true,null::text,v_id;
end $$;
create or replace function public.release_reservation(p_reservation_id uuid) returns void language plpgsql security definer set search_path=public as $$ begin update public.usage_reservations set status='released',released_at=now() where id=p_reservation_id and status='reserved'; end $$;
create or replace function public.increment_usage(p_user_id text, p_tokens integer, p_cost_usd numeric default 0) returns void language plpgsql security definer set search_path=public as $$ declare v_period date := date_trunc('month',now())::date; begin if p_tokens < 0 or p_cost_usd < 0 then raise exception 'invalid usage increment' using errcode='22023'; end if; insert into public.user_usage_summary(user_id,period_start,messages_used,tokens_used,committed_cost_usd) values(p_user_id,v_period,1,p_tokens,p_cost_usd) on conflict(user_id,period_start) do update set messages_used=public.user_usage_summary.messages_used+1,tokens_used=public.user_usage_summary.tokens_used+excluded.tokens_used,committed_cost_usd=public.user_usage_summary.committed_cost_usd+excluded.committed_cost_usd,updated_at=now(); insert into public.user_usage_daily(user_id,usage_date,messages_used,tokens_used,committed_cost_usd) values(p_user_id,current_date,1,p_tokens,p_cost_usd) on conflict(user_id,usage_date) do update set messages_used=public.user_usage_daily.messages_used+1,tokens_used=public.user_usage_daily.tokens_used+excluded.tokens_used,committed_cost_usd=public.user_usage_daily.committed_cost_usd+excluded.committed_cost_usd,updated_at=now(); end $$;
create or replace function public.process_payment_webhook(p_payment_id text,p_user_id text,p_order_id text,p_tier text,p_tokens bigint,p_period_days integer) returns table(already_processed boolean) language plpgsql security definer set search_path=public as $$ declare v_exists boolean; v_end timestamptz; begin if p_payment_id is null or p_user_id is null or p_tier not in ('go','plus','pro','enterprise') then raise exception 'invalid payment entitlement request' using errcode='22023'; end if; select exists(select 1 from public.payments where id=p_payment_id) into v_exists; if v_exists then return query select true; return; end if; v_end:=now()+make_interval(days=>p_period_days); insert into public.payments(id,user_id,tier,amount,created_at) values(p_payment_id,p_user_id,p_tier,0,now()); insert into public.subscriptions(user_id,tier,status,current_period_start,current_period_end,provider,provider_payment_id,provider_order_id,metadata) values(p_user_id,p_tier,'active',now(),v_end,'razorpay',p_payment_id,p_order_id,jsonb_build_object('token_grant',p_tokens)) ; return query select false; end $$;

-- Replace the unsafe/duplicated public policies from the exported database.
do $$ declare p record; begin for p in select policyname, tablename from pg_policies where schemaname='public' and tablename in ('chats','conversations','messages','profiles','subscriptions','payments','tier_limits','model_pricing','usage_events','usage_reservations','user_usage_daily','user_usage_summary','user_usage_logs','hexical_authorization_scopes','hexical_authorization_audit','investigations','investigation_sessions','tty_executions','tty_execution_events','tty_execution_artifacts','tty_execution_metrics','investigation_executions','investigation_graph_nodes','investigation_graph_edges') loop execute format('drop policy if exists %I on public.%I',p.policyname,p.tablename); end loop; end $$;
alter table public.chats enable row level security; alter table public.conversations enable row level security; alter table public.messages enable row level security; alter table public.profiles enable row level security; alter table public.subscriptions enable row level security; alter table public.payments enable row level security; alter table public.tier_limits enable row level security; alter table public.model_pricing enable row level security; alter table public.usage_events enable row level security; alter table public.usage_reservations enable row level security; alter table public.user_usage_daily enable row level security; alter table public.user_usage_summary enable row level security; alter table public.user_usage_logs enable row level security; alter table public.hexical_authorization_scopes enable row level security; alter table public.hexical_authorization_audit enable row level security; alter table public.investigations enable row level security; alter table public.investigation_sessions enable row level security; alter table public.tty_executions enable row level security; alter table public.tty_execution_events enable row level security; alter table public.tty_execution_artifacts enable row level security; alter table public.tty_execution_metrics enable row level security; alter table public.investigation_executions enable row level security; alter table public.investigation_graph_nodes enable row level security; alter table public.investigation_graph_edges enable row level security;
create or replace function public.hexical_current_user_id() returns text language sql stable security invoker as $$ select nullif(coalesce(auth.jwt()->>'sub',auth.jwt()->>'user_id'),'') $$;
create policy conversations_owner on public.conversations for all to authenticated using (user_id=public.hexical_current_user_id()) with check(user_id=public.hexical_current_user_id());
create policy messages_owner on public.messages for all to authenticated using (user_id=public.hexical_current_user_id()) with check(user_id=public.hexical_current_user_id());
create policy profiles_owner_read on public.profiles for select to authenticated using(user_id=public.hexical_current_user_id());
create policy authorization_scopes_owner_read on public.hexical_authorization_scopes for select to authenticated using(user_id=public.hexical_current_user_id());
create policy authorization_scopes_owner_insert on public.hexical_authorization_scopes for insert to authenticated with check(user_id=public.hexical_current_user_id() and status='pending');
-- Server-owned ledgers intentionally have no browser mutation policy.
do $$ declare t text; begin foreach t in array array['chats','conversations','messages','profiles','subscriptions','payments','tier_limits','model_pricing','usage_events','usage_reservations','user_usage_daily','user_usage_summary','user_usage_logs','hexical_authorization_scopes','hexical_authorization_audit','investigations','investigation_sessions','tty_executions','tty_execution_events','tty_execution_artifacts','tty_execution_metrics','investigation_executions','investigation_graph_nodes','investigation_graph_edges'] loop execute format('create policy %I on public.%I for all to service_role using (true) with check (true)',t||'_service_role',t); end loop; end $$;

-- Safe default pricing rows; prices are configuration, not a billing source.
insert into public.model_pricing(model,input_price_per_million,output_price_per_million,effective_from) select v.model,v.input_price,v.output_price,now() from (values ('groq',1::numeric,1::numeric),('deepseek',1::numeric,1::numeric),('openai',15::numeric,15::numeric),('anthropic',20::numeric,20::numeric)) as v(model,input_price,output_price) where not exists(select 1 from public.model_pricing mp where mp.model=v.model and mp.effective_to is null);

commit;
