-- Bridge the actual runtime-KV investigation source of truth into an
-- owner-scoped Supabase Realtime table. The application intentionally keeps
-- its existing InvestigationStore/KV contract; this additive table is only a
-- delivery journal for browser synchronization.

create table if not exists public.hexical_investigation_realtime_events (
  event_id bigint generated always as identity primary key,
  owner_user_id text not null,
  investigation_id uuid not null,
  event_type text not null check (event_type in ('INSERT', 'UPDATE')),
  record jsonb not null,
  occurred_at timestamptz not null default now()
);

create index if not exists hexical_investigation_realtime_owner_idx
  on public.hexical_investigation_realtime_events (owner_user_id, event_id);

alter table public.hexical_investigation_realtime_events enable row level security;

drop policy if exists hexical_investigation_realtime_service_role
  on public.hexical_investigation_realtime_events;
create policy hexical_investigation_realtime_service_role
  on public.hexical_investigation_realtime_events
  for all to service_role using (true) with check (true);

drop policy if exists hexical_investigation_realtime_owner_read
  on public.hexical_investigation_realtime_events;
create policy hexical_investigation_realtime_owner_read
  on public.hexical_investigation_realtime_events
  for select to authenticated
  using (owner_user_id = public.hexical_current_user_id());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime
        add table public.hexical_investigation_realtime_events;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

create or replace function public.hexical_publish_investigation_realtime()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record jsonb;
  v_investigation_id text;
  v_owner_user_id text;
begin
  -- InvestigationStore preserves its existing Redis-compatible contract and
  -- writes JSON strings into the generic JSONB KV value column.
  v_record := case
    when jsonb_typeof(new.value) = 'string' then (new.value #>> '{}')::jsonb
    else new.value
  end;
  v_investigation_id := v_record->>'investigationId';
  v_owner_user_id := v_record->>'ownerUserId';

  if new.key not like 'hexical:investigations:record:%'
    or v_investigation_id is null
    or v_owner_user_id is null
    or v_record->>'title' is null
    or v_record->>'description' is null
    or v_record->>'status' is null
    or v_record->>'createdAt' is null
    or v_record->>'updatedAt' is null then
    return new;
  end if;

  insert into public.hexical_investigation_realtime_events (
    owner_user_id,
    investigation_id,
    event_type,
    record
  ) values (
    v_owner_user_id,
    v_investigation_id::uuid,
    case when tg_op = 'INSERT' then 'INSERT' else 'UPDATE' end,
    v_record
  );

  return new;
exception when invalid_text_representation then
  -- A malformed runtime key must never break the runtime KV write path.
  return new;
end;
$$;

drop trigger if exists hexical_investigation_realtime_bridge
  on public.hexical_runtime_kv;
create trigger hexical_investigation_realtime_bridge
after insert or update of value on public.hexical_runtime_kv
for each row execute function public.hexical_publish_investigation_realtime();
