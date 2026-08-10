-- HEXICAL AI DEFINITIVE REBUILD
-- Deliberately destructive. Take a Supabase backup and stop the application
-- before running. This touches public only; auth, storage, Clerk, and other
-- schemas are not modified.
begin;

-- Remove every public table, view, and Hexical function. CASCADE removes old
-- policies, triggers, constraints, and dependent legacy objects as well.
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname='public' loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
  for r in select viewname from pg_views where schemaname='public' loop
    execute format('drop view if exists public.%I cascade', r.viewname);
  end loop;
end $$;
drop function if exists public.canonical_entitlement(text) cascade;
drop function if exists public.reserve_budget(text,text,numeric) cascade;
drop function if exists public.release_reservation(uuid) cascade;
drop function if exists public.increment_usage(text,integer,numeric) cascade;
drop function if exists public.process_payment_webhook(text,text,text,text,bigint,integer) cascade;
drop function if exists public.hexical_current_user_id() cascade;
drop function if exists public.hexical_set_updated_at() cascade;
drop function if exists public.hexical_sync_profile_entitlement() cascade;
drop type if exists public.plan_tier cascade;
drop type if exists public.sub_status cascade;
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key default gen_random_uuid(), user_id text not null unique, email text,
  tier text not null default 'free' check(tier in ('free','go','plus','pro','enterprise')),
  status text not null default 'none' check(status in ('none','active','trialing','past_due','paused','canceled','expired','grace')),
  stripe_customer_id text unique, stripe_subscription_id text unique,
  current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean not null default false,
  tier_expires_at timestamptz, subscription_status text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade,
  tier text not null check(tier in ('free','go','plus','pro','enterprise')), status text not null default 'active' check(status in ('active','trialing','past_due','paused','canceled','expired','incomplete','grace')),
  current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean not null default false, grace_period_end timestamptz,
  enterprise_unlimited boolean not null default false, provider text, provider_customer_id text, provider_subscription_id text, provider_payment_id text, provider_order_id text,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index subscriptions_user_entitlement_idx on public.subscriptions(user_id,status,current_period_end desc);
create unique index subscriptions_provider_subscription_uidx on public.subscriptions(provider,provider_subscription_id) where provider_subscription_id is not null;
create unique index subscriptions_provider_payment_uidx on public.subscriptions(provider,provider_payment_id) where provider_payment_id is not null;
create unique index subscriptions_provider_order_uidx on public.subscriptions(provider,provider_order_id) where provider_order_id is not null;

create table public.payments (
  id text primary key, user_id text not null references public.profiles(user_id) on delete restrict, tier text not null check(tier in ('go','plus','pro','enterprise')),
  amount integer not null default 0 check(amount>=0), provider text not null default 'razorpay', order_id text, status text not null default 'paid' check(status in ('created','authorized','paid','failed','refunded')),
  currency text not null default 'INR', metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), processed_at timestamptz
);
create unique index payments_order_uidx on public.payments(provider,order_id) where order_id is not null;
create index payments_user_created_idx on public.payments(user_id,created_at desc);

create table public.tier_limits (
  tier text primary key check(tier in ('free','go','plus','pro','enterprise')), daily_budget_usd numeric(18,6) not null check(daily_budget_usd>=0),
  max_requests_per_day integer check(max_requests_per_day is null or max_requests_per_day>0), monthly_budget_usd numeric(18,6) not null check(monthly_budget_usd>=0),
  monthly_message_limit integer not null check(monthly_message_limit>0), max_concurrent_executions integer not null check(max_concurrent_executions>0), max_execution_seconds integer not null check(max_execution_seconds>0), max_artifact_bytes bigint not null check(max_artifact_bytes>0)
);
insert into public.tier_limits values
 ('free',2,100,25,600,1,120,104857600),('go',5,500,75,1050,2,300,1073741824),('plus',20,2000,300,3000,4,900,10737418240),('pro',50,10000,1000,9000,12,3600,107374182400),('enterprise',1000,null,100000,1000000,100,14400,1099511627776);

create table public.model_pricing (
  id uuid primary key default gen_random_uuid(), model text not null, input_price_per_million numeric(18,6) not null check(input_price_per_million>=0), output_price_per_million numeric(18,6) not null check(output_price_per_million>=0), effective_from timestamptz not null default now(), effective_to timestamptz, check(effective_to is null or effective_to>effective_from)
);
create unique index model_pricing_active_uidx on public.model_pricing(model) where effective_to is null;
insert into public.model_pricing(model,input_price_per_million,output_price_per_million) values('groq',1,1),('deepseek',1,1),('openai',15,15),('anthropic',20,20);

create table public.conversations (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade, title text not null default 'New Chat', pinned boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index conversations_owner_created_idx on public.conversations(user_id,created_at desc);
create table public.messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.conversations(id) on delete cascade, user_id text not null references public.profiles(user_id) on delete cascade, content text not null, role text not null check(role in ('user','assistant','hexical','system','error')), created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages(conversation_id,created_at);
create index messages_owner_created_idx on public.messages(user_id,created_at desc);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade, tier text not null, profile text not null, provider text not null, model text not null, route_mode text not null, complexity text not null,
  tokens_in integer not null default 0 check(tokens_in>=0), tokens_out integer not null default 0 check(tokens_out>=0), tokens_total integer not null default 0 check(tokens_total>=0), estimated_cost_paise bigint not null default 0 check(estimated_cost_paise>=0), allocated_revenue_paise bigint not null default 0, estimated_profit_paise bigint not null default 0,
  latency_ms integer not null default 0, response_time_ms integer not null default 0, provider_retry_count integer not null default 0, fallback_used boolean not null default false, cache_key text, queue_time_ms integer, swarm_used boolean not null default false, confidence_score numeric(8,5) not null default 0, request_size_chars integer not null default 0, cache_hit boolean not null default false, authorization_scope_id uuid, created_at timestamptz not null default now()
);
create index usage_events_owner_created_idx on public.usage_events(user_id,created_at desc);

create table public.usage_reservations (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade, tier text not null, estimated_cost_usd numeric(18,6) not null check(estimated_cost_usd>0), period_start date not null, status text not null default 'reserved' check(status in ('reserved','released','committed','expired')), expires_at timestamptz not null default(now()+interval '15 minutes'), released_at timestamptz, created_at timestamptz not null default now()
);
create index usage_reservations_active_idx on public.usage_reservations(user_id,period_start,expires_at) where status='reserved';
create table public.user_usage_daily (
  user_id text not null references public.profiles(user_id) on delete cascade, usage_date date not null, messages_used bigint not null default 0 check(messages_used>=0), tokens_used bigint not null default 0 check(tokens_used>=0), committed_cost_usd numeric(18,6) not null default 0 check(committed_cost_usd>=0), updated_at timestamptz not null default now(), primary key(user_id,usage_date)
);
create table public.user_usage_summary (
  user_id text not null references public.profiles(user_id) on delete cascade, period_start date not null, messages_used bigint not null default 0 check(messages_used>=0), tokens_used bigint not null default 0 check(tokens_used>=0), committed_cost_usd numeric(18,6) not null default 0 check(committed_cost_usd>=0), updated_at timestamptz not null default now(), primary key(user_id,period_start)
);
create index user_usage_summary_period_idx on public.user_usage_summary(period_start,updated_at desc);
create table public.user_usage_logs (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade, tier text not null check(tier in ('free','go','plus','pro','enterprise')), model text not null, input_tokens integer not null default 0 check(input_tokens>=0), output_tokens integer not null default 0 check(output_tokens>=0), route_type text not null, endpoint text not null, estimated_cost_usd numeric(18,6) not null default 0 check(estimated_cost_usd>=0), created_at timestamptz not null default now()
);
create index user_usage_logs_owner_created_idx on public.user_usage_logs(user_id,created_at desc);

create table public.investigations (
  id uuid primary key default gen_random_uuid(), owner_user_id text not null references public.profiles(user_id) on delete cascade, title text not null check(char_length(title) between 1 and 200), description text not null default '', status text not null default 'active' check(status in ('active','archived','deleted')), tty_session_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create index investigations_owner_updated_idx on public.investigations(owner_user_id,updated_at desc) where status<>'deleted';
create table public.investigation_sessions (
  id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade, owner_user_id text not null references public.profiles(user_id) on delete cascade, status text not null default 'active' check(status in ('active','terminated','expired','repairing')), runtime jsonb not null default '{}', lease_expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index investigation_sessions_active_uidx on public.investigation_sessions(investigation_id) where status='active';
create table public.tty_executions (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.investigation_sessions(id) on delete cascade, investigation_id uuid not null references public.investigations(id) on delete cascade, owner_user_id text not null references public.profiles(user_id) on delete cascade, idempotency_key text not null, request_fingerprint text not null, command text not null, state text not null default 'queued' check(state in ('queued','leased','starting','running','streaming','succeeded','failed','cancelled','timed_out','expired')), attempt integer not null default 0 check(attempt between 0 and 100), worker_id text, lease_id text, fencing_token bigint not null default 0 check(fencing_token>=0), lease_expires_at timestamptz, queued_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz, exit_code integer, failure_code text, diagnostics jsonb not null default '{}', checkpoint jsonb not null default '{}', replay_of uuid references public.tty_executions(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_user_id,session_id,idempotency_key)
);
create index tty_executions_owner_created_idx on public.tty_executions(owner_user_id,created_at desc);
create index tty_executions_recovery_idx on public.tty_executions(state,lease_expires_at) where state in('leased','starting','running','streaming');
create table public.investigation_executions (investigation_id uuid not null references public.investigations(id) on delete cascade, execution_id uuid not null references public.tty_executions(id) on delete cascade, attached_at timestamptz not null default now(), primary key(investigation_id,execution_id));
create table public.investigation_graph_nodes (id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade, node_type text not null, label text not null, payload jsonb not null default '{}', created_at timestamptz not null default now());
create index investigation_graph_nodes_investigation_idx on public.investigation_graph_nodes(investigation_id,created_at);
create table public.investigation_graph_edges (id uuid primary key default gen_random_uuid(), investigation_id uuid not null references public.investigations(id) on delete cascade, source_node_id uuid not null references public.investigation_graph_nodes(id) on delete cascade, target_node_id uuid not null references public.investigation_graph_nodes(id) on delete cascade, edge_type text not null, payload jsonb not null default '{}', created_at timestamptz not null default now(), check(source_node_id<>target_node_id));
create index investigation_graph_edges_investigation_idx on public.investigation_graph_edges(investigation_id,created_at);
create table public.tty_execution_events (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade, sequence bigint not null check(sequence>0), stream text not null check(stream in('stdout','stderr','state','metric','heartbeat','completion','error')), payload jsonb not null default '{}', occurred_at timestamptz not null default now(), unique(execution_id,sequence)
);
create index tty_execution_events_replay_idx on public.tty_execution_events(execution_id,sequence);
create table public.tty_execution_artifacts (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade, owner_user_id text not null references public.profiles(user_id) on delete cascade, path text not null, content_type text, byte_size bigint not null default 0 check(byte_size>=0), storage_key text not null, sha256 text, created_at timestamptz not null default now(), unique(execution_id,path)
);
create index tty_execution_artifacts_owner_idx on public.tty_execution_artifacts(owner_user_id,created_at desc);
create table public.tty_execution_metrics (
  id uuid primary key default gen_random_uuid(), execution_id uuid not null references public.tty_executions(id) on delete cascade, sampled_at timestamptz not null default now(), cpu_pct numeric(6,2) check(cpu_pct>=0), memory_bytes bigint check(memory_bytes>=0), network_rx_bytes bigint check(network_rx_bytes>=0), network_tx_bytes bigint check(network_tx_bytes>=0), process_count integer check(process_count>=0)
);
create index tty_execution_metrics_series_idx on public.tty_execution_metrics(execution_id,sampled_at);

create table public.hexical_authorization_scopes (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete cascade, platform text not null check(platform in('hackerone','bugcrowd','intigriti','custom')), target_pattern text not null, program_ref text, proof_url text, status text not null default 'pending' check(status in('pending','verified','rejected','expired')), verified_by text, verified_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now()
);
create index authorization_scopes_owner_status_idx on public.hexical_authorization_scopes(user_id,status,expires_at);
create table public.hexical_authorization_audit (
  id uuid primary key default gen_random_uuid(), user_id text not null references public.profiles(user_id) on delete restrict, scope_id uuid references public.hexical_authorization_scopes(id) on delete set null, target_submitted text not null, profile text not null, decision text not null check(decision in('allow','deny','review')), reason text not null, created_at timestamptz not null default now()
);
create index authorization_audit_owner_created_idx on public.hexical_authorization_audit(user_id,created_at desc);
alter table public.usage_events add constraint usage_events_authorization_scope_fkey foreign key(authorization_scope_id) references public.hexical_authorization_scopes(id) on delete set null;
alter table public.investigations add constraint investigations_tty_session_fkey foreign key(tty_session_id) references public.investigation_sessions(id) on delete set null;

create or replace function public.hexical_set_updated_at() returns trigger language plpgsql security invoker set search_path=public as $$ begin new.updated_at=now(); return new; end $$;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.hexical_set_updated_at();
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.hexical_set_updated_at();
create trigger conversations_updated_at before update on public.conversations for each row execute function public.hexical_set_updated_at();
create trigger investigations_updated_at before update on public.investigations for each row execute function public.hexical_set_updated_at();
create trigger sessions_updated_at before update on public.investigation_sessions for each row execute function public.hexical_set_updated_at();
create trigger executions_updated_at before update on public.tty_executions for each row execute function public.hexical_set_updated_at();

create or replace function public.hexical_sync_profile_entitlement() returns trigger language plpgsql security definer set search_path=public as $$ begin update public.profiles set tier=new.tier,status=new.status,subscription_status=new.status,current_period_start=new.current_period_start,current_period_end=new.current_period_end,cancel_at_period_end=new.cancel_at_period_end,tier_expires_at=new.current_period_end where user_id=new.user_id; return new; end $$;
create trigger subscriptions_sync_profile after insert or update of tier,status,current_period_start,current_period_end,cancel_at_period_end on public.subscriptions for each row execute function public.hexical_sync_profile_entitlement();

create or replace function public.hexical_current_user_id() returns text language sql stable security invoker as $$ select nullif(coalesce(auth.jwt()->>'sub',auth.jwt()->>'user_id',auth.uid()::text),'') $$;
create or replace function public.hexical_ensure_profile(p_user_id text) returns void language plpgsql security definer set search_path=public as $$ begin if p_user_id is null or length(trim(p_user_id))=0 then raise exception 'invalid profile identity' using errcode='22023'; end if; insert into public.profiles(user_id,tier,status) values(p_user_id,'free','none') on conflict(user_id) do nothing; end $$;
create or replace function public.canonical_entitlement(p_user_id text)
returns table(user_id text,tier text,status text,current_period_start timestamptz,current_period_end timestamptz,enterprise_unlimited boolean,active boolean)
language sql stable security definer set search_path=public as $$
select p_user_id,coalesce(s.tier,'free'),coalesce(s.status,'none'),s.current_period_start,s.current_period_end,coalesce(s.enterprise_unlimited,false),coalesce(s.enterprise_unlimited,false) or (s.status in('active','trialing','grace') and (s.current_period_end is null or s.current_period_end>now() or coalesce(s.grace_period_end,'-infinity'::timestamptz)>now())) from (select 1) x left join lateral(select * from public.subscriptions where user_id=p_user_id order by enterprise_unlimited desc,(status in('active','trialing','grace')) desc,current_period_end desc nulls last,updated_at desc limit 1) s on true;
$$;

create or replace function public.reserve_budget(p_user_id text,p_tier text,p_estimated_cost_usd numeric) returns table(allowed boolean,reason text,reservation_id uuid) language plpgsql security definer set search_path=public as $$ declare v_period date:=date_trunc('month',now())::date; v_limit numeric; v_committed numeric; v_reserved numeric; v_id uuid; begin perform public.hexical_ensure_profile(p_user_id); if p_estimated_cost_usd<=0 then return query select false,'invalid_budget_request',null::uuid; return; end if; insert into public.user_usage_summary(user_id,period_start) values(p_user_id,v_period) on conflict do nothing; select monthly_budget_usd into v_limit from public.tier_limits where tier=p_tier; if v_limit is null then return query select false,'budget_config_missing',null::uuid; return; end if; select committed_cost_usd into v_committed from public.user_usage_summary where user_id=p_user_id and period_start=v_period for update; select coalesce(sum(estimated_cost_usd),0) into v_reserved from public.usage_reservations where user_id=p_user_id and period_start=v_period and status='reserved' and expires_at>now(); if v_committed+v_reserved+p_estimated_cost_usd>v_limit then return query select false,'monthly_budget_exceeded',null::uuid; return; end if; insert into public.usage_reservations(user_id,tier,estimated_cost_usd,period_start) values(p_user_id,p_tier,p_estimated_cost_usd,v_period) returning id into v_id; return query select true,null::text,v_id; end $$;
create or replace function public.release_reservation(p_reservation_id uuid) returns void language plpgsql security definer set search_path=public as $$ begin update public.usage_reservations set status='released',released_at=now() where id=p_reservation_id and status='reserved'; end $$;
create or replace function public.increment_usage(p_user_id text,p_tokens integer,p_cost_usd numeric default 0) returns void language plpgsql security definer set search_path=public as $$ declare v_period date:=date_trunc('month',now())::date; begin perform public.hexical_ensure_profile(p_user_id); if p_tokens<0 or p_cost_usd<0 then raise exception 'invalid usage increment' using errcode='22023'; end if; insert into public.user_usage_summary(user_id,period_start,messages_used,tokens_used,committed_cost_usd) values(p_user_id,v_period,1,p_tokens,p_cost_usd) on conflict(user_id,period_start) do update set messages_used=public.user_usage_summary.messages_used+1,tokens_used=public.user_usage_summary.tokens_used+excluded.tokens_used,committed_cost_usd=public.user_usage_summary.committed_cost_usd+excluded.committed_cost_usd,updated_at=now(); insert into public.user_usage_daily(user_id,usage_date,messages_used,tokens_used,committed_cost_usd) values(p_user_id,current_date,1,p_tokens,p_cost_usd) on conflict(user_id,usage_date) do update set messages_used=public.user_usage_daily.messages_used+1,tokens_used=public.user_usage_daily.tokens_used+excluded.tokens_used,committed_cost_usd=public.user_usage_daily.committed_cost_usd+excluded.committed_cost_usd,updated_at=now(); end $$;
create or replace function public.process_payment_webhook(p_payment_id text,p_user_id text,p_order_id text,p_tier text,p_tokens bigint,p_period_days integer) returns table(already_processed boolean) language plpgsql security definer set search_path=public as $$ declare v_end timestamptz; begin perform public.hexical_ensure_profile(p_user_id); if p_payment_id is null or p_user_id is null or p_tier not in('go','plus','pro','enterprise') or p_period_days not between 1 and 3660 then raise exception 'invalid payment entitlement request' using errcode='22023'; end if; if exists(select 1 from public.payments where id=p_payment_id) then return query select true; return; end if; v_end:=now()+make_interval(days=>p_period_days); insert into public.payments(id,user_id,tier,amount,provider,order_id,metadata,processed_at) values(p_payment_id,p_user_id,p_tier,0,'razorpay',p_order_id,jsonb_build_object('token_grant',p_tokens),now()); insert into public.subscriptions(user_id,tier,status,current_period_start,current_period_end,provider,provider_payment_id,provider_order_id,metadata) values(p_user_id,p_tier,'active',now(),v_end,'razorpay',p_payment_id,p_order_id,jsonb_build_object('token_grant',p_tokens)); return query select false; end $$;

-- Every table is protected. Browser ownership is limited to authenticated
-- Clerk subjects; billing and usage are server-owned service-role ledgers.
do $$ declare t text; begin foreach t in array array['profiles','subscriptions','payments','tier_limits','model_pricing','usage_events','usage_reservations','user_usage_daily','user_usage_logs','user_usage_summary','conversations','messages','investigations','investigation_sessions','investigation_executions','investigation_graph_nodes','investigation_graph_edges','tty_executions','tty_execution_events','tty_execution_artifacts','tty_execution_metrics','hexical_authorization_scopes','hexical_authorization_audit'] loop execute format('alter table public.%I enable row level security',t); execute format('create policy %I on public.%I for all to service_role using(true) with check(true)',t||'_service_role',t); end loop; end $$;
create policy profiles_owner_read on public.profiles for select to authenticated using(user_id=public.hexical_current_user_id());
create policy conversations_owner on public.conversations for all to authenticated using(user_id=public.hexical_current_user_id()) with check(user_id=public.hexical_current_user_id());
create policy messages_owner on public.messages for all to authenticated using(user_id=public.hexical_current_user_id()) with check(user_id=public.hexical_current_user_id());
create policy investigations_owner on public.investigations for all to authenticated using(owner_user_id=public.hexical_current_user_id()) with check(owner_user_id=public.hexical_current_user_id());
create policy sessions_owner on public.investigation_sessions for all to authenticated using(owner_user_id=public.hexical_current_user_id()) with check(owner_user_id=public.hexical_current_user_id());
create policy executions_owner on public.tty_executions for all to authenticated using(owner_user_id=public.hexical_current_user_id()) with check(owner_user_id=public.hexical_current_user_id());
create policy execution_events_owner on public.tty_execution_events for select to authenticated using(exists(select 1 from public.tty_executions e where e.id=execution_id and e.owner_user_id=public.hexical_current_user_id()));
create policy execution_artifacts_owner on public.tty_execution_artifacts for all to authenticated using(owner_user_id=public.hexical_current_user_id()) with check(owner_user_id=public.hexical_current_user_id());
create policy execution_metrics_owner on public.tty_execution_metrics for select to authenticated using(exists(select 1 from public.tty_executions e where e.id=execution_id and e.owner_user_id=public.hexical_current_user_id()));
create policy graph_nodes_owner on public.investigation_graph_nodes for all to authenticated using(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id())) with check(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id()));
create policy graph_edges_owner on public.investigation_graph_edges for all to authenticated using(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id())) with check(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id()));
create policy investigation_executions_owner on public.investigation_executions for all to authenticated using(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id())) with check(exists(select 1 from public.investigations i where i.id=investigation_id and i.owner_user_id=public.hexical_current_user_id()));
create policy authorization_scopes_owner on public.hexical_authorization_scopes for select to authenticated using(user_id=public.hexical_current_user_id());
create policy authorization_scopes_pending_insert on public.hexical_authorization_scopes for insert to authenticated with check(user_id=public.hexical_current_user_id() and status='pending');
create policy authorization_audit_owner on public.hexical_authorization_audit for select to authenticated using(user_id=public.hexical_current_user_id());

comment on table public.subscriptions is 'Single canonical entitlement source for every Clerk user.';
comment on table public.tty_executions is 'Durable execution ledger with idempotency, fencing, recovery, replay checkpoints, and ownership.';
commit;
