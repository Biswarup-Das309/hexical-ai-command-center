-- Hexical Runtime OS: additive Supabase/Postgres runtime backend.
--
-- This migration is intentionally independent of the historical rebuild/reset
-- migrations. It stores the existing runtime key/stream contract in Postgres
-- rows and exposes the atomic multi-key operations through SECURITY DEFINER
-- functions. Runtime code no longer calls Upstash or any Redis endpoint.
--
-- Rollback: revoke the runtime policies, drop the Realtime publication entry,
-- then drop the functions/tables in reverse dependency order. No existing
-- application table is altered by this migration.

create table if not exists public.hexical_runtime_kv (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.hexical_runtime_hashes (
  key text not null,
  field text not null,
  value text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (key, field)
);

create table if not exists public.hexical_runtime_set_members (
  key text not null,
  member text not null,
  created_at timestamptz not null default now(),
  primary key (key, member)
);

create table if not exists public.hexical_runtime_sorted_members (
  key text not null,
  member text not null,
  score numeric not null,
  created_at timestamptz not null default now(),
  primary key (key, member)
);

create table if not exists public.hexical_runtime_stream_entries (
  stream_key text not null,
  stream_sequence bigint not null,
  stream_id text not null,
  fields jsonb not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (stream_key, stream_sequence),
  unique (stream_key, stream_id)
);

alter table public.hexical_runtime_hashes
  add column if not exists expires_at timestamptz;
alter table public.hexical_runtime_stream_entries
  add column if not exists expires_at timestamptz;

create index if not exists hexical_runtime_kv_expiry_idx
  on public.hexical_runtime_kv (expires_at)
  where expires_at is not null;
create index if not exists hexical_runtime_stream_lookup_idx
  on public.hexical_runtime_stream_entries (stream_key, stream_sequence);
create index if not exists hexical_runtime_stream_expiry_idx
  on public.hexical_runtime_stream_entries (expires_at)
  where expires_at is not null;
create index if not exists hexical_runtime_hash_expiry_idx
  on public.hexical_runtime_hashes (expires_at)
  where expires_at is not null;
create index if not exists hexical_runtime_set_lookup_idx
  on public.hexical_runtime_set_members (key, member);
create index if not exists hexical_runtime_sorted_lookup_idx
  on public.hexical_runtime_sorted_members (key, score, member);

alter table public.hexical_runtime_kv enable row level security;
alter table public.hexical_runtime_hashes enable row level security;
alter table public.hexical_runtime_set_members enable row level security;
alter table public.hexical_runtime_sorted_members enable row level security;
alter table public.hexical_runtime_stream_entries enable row level security;

drop policy if exists hexical_runtime_kv_service_role on public.hexical_runtime_kv;
create policy hexical_runtime_kv_service_role on public.hexical_runtime_kv
  for all to service_role using (true) with check (true);
drop policy if exists hexical_runtime_hashes_service_role on public.hexical_runtime_hashes;
create policy hexical_runtime_hashes_service_role on public.hexical_runtime_hashes
  for all to service_role using (true) with check (true);
drop policy if exists hexical_runtime_sets_service_role on public.hexical_runtime_set_members;
create policy hexical_runtime_sets_service_role on public.hexical_runtime_set_members
  for all to service_role using (true) with check (true);
drop policy if exists hexical_runtime_sorted_service_role on public.hexical_runtime_sorted_members;
create policy hexical_runtime_sorted_service_role on public.hexical_runtime_sorted_members
  for all to service_role using (true) with check (true);
drop policy if exists hexical_runtime_stream_service_role on public.hexical_runtime_stream_entries;
create policy hexical_runtime_stream_service_role on public.hexical_runtime_stream_entries
  for all to service_role using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.hexical_runtime_stream_entries;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

create or replace function public.hexical_runtime_set_value(
  p_key text,
  p_value jsonb,
  p_ttl_seconds integer default null,
  p_nx boolean default false
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.hexical_runtime_kv%rowtype;
  v_expires timestamptz;
begin
  select * into v_existing from public.hexical_runtime_kv where key = p_key for update;
  if v_existing.key is not null and v_existing.expires_at is not null and v_existing.expires_at <= now() then
    delete from public.hexical_runtime_kv where key = p_key;
    v_existing.key := null;
  end if;
  if p_nx and v_existing.key is not null then return null; end if;
  v_expires := case when p_ttl_seconds is null then null else now() + make_interval(secs => greatest(1, p_ttl_seconds)) end;
  insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
  values (p_key, p_value, v_expires, now())
  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at, updated_at = now();
  return 'OK';
end;
$$;

create or replace function public.hexical_runtime_delete_keys(p_keys text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer := 0; v_rows integer;
begin
  delete from public.hexical_runtime_kv where key = any(p_keys); get diagnostics v_rows = row_count; v_count := v_count + v_rows;
  delete from public.hexical_runtime_hashes where key = any(p_keys); get diagnostics v_rows = row_count; v_count := v_count + v_rows;
  delete from public.hexical_runtime_set_members where key = any(p_keys); get diagnostics v_rows = row_count; v_count := v_count + v_rows;
  delete from public.hexical_runtime_sorted_members where key = any(p_keys); get diagnostics v_rows = row_count; v_count := v_count + v_rows;
  delete from public.hexical_runtime_stream_entries where stream_key = any(p_keys); get diagnostics v_rows = row_count; v_count := v_count + v_rows;
  return v_count;
end;
$$;

create or replace function public.hexical_runtime_increment_value(p_key text, p_delta integer) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_value public.hexical_runtime_kv.value%type; v_next bigint; v_expires timestamptz;
begin
  select value, expires_at into v_value, v_expires from public.hexical_runtime_kv where key = p_key for update;
  if v_expires is not null and v_expires <= now() then v_value := null; v_expires := null; end if;
  v_next := coalesce(nullif(v_value #>> '{}', '')::bigint, 0) + p_delta;
  insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
  values (p_key, to_jsonb(v_next), v_expires, now())
  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at, updated_at = now();
  return v_next;
exception when invalid_text_representation then
  raise exception 'Runtime value for % is not an integer', p_key using errcode = '22023';
end;
$$;

create or replace function public.hexical_runtime_expire_key(p_key text, p_ttl_seconds integer) returns integer
language plpgsql security definer set search_path = public as $$
begin
  update public.hexical_runtime_kv set expires_at = now() + make_interval(secs => greatest(1, p_ttl_seconds)), updated_at = now()
    where key = p_key and (expires_at is null or expires_at > now());
  return case when found then 1 else 0 end;
end;
$$;

create or replace function public.hexical_runtime_append_stream(p_stream_key text, p_fields jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_sequence bigint; v_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_stream_key, 0));
  select coalesce(max(stream_sequence), 0) + 1 into v_sequence
    from public.hexical_runtime_stream_entries where stream_key = p_stream_key;
  v_id := v_sequence::text || '-0';
  insert into public.hexical_runtime_stream_entries(stream_key, stream_sequence, stream_id, fields)
    values (p_stream_key, v_sequence, v_id, p_fields);
  return v_id;
end;
$$;

create or replace function public.hexical_runtime_eval(
  p_operation text,
  p_keys text[],
  p_args text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value jsonb; v_existing text; v_json jsonb; v_update jsonb; v_worker jsonb; v_lease jsonb;
  v_now bigint; v_number bigint; v_sequence bigint; v_cursor text; v_member text; v_count integer;
  v_row public.hexical_runtime_kv%rowtype; v_expired_worker text; v_expired_token text;
  v_heartbeat jsonb; v_health jsonb; v_job jsonb; v_active jsonb; v_session_id text;
begin
  -- Worker registration and heartbeat are serialized by the same row locks as
  -- lease operations, so a health result cannot observe a half-registration.
  if p_operation = 'tty-worker-register' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is not null then
      if v_value->>'status' = 'inactive' then return jsonb_build_array(0, 'duplicate_worker'); end if;
      v_existing := (select value #>> '{}' from public.hexical_runtime_kv where key = p_keys[3]);
      if v_existing is not null and p_args[3]::bigint - (v_existing::jsonb->>'receivedAtMs')::bigint <= p_args[4]::bigint then
        return jsonb_build_array(0, 'duplicate_worker');
      end if;
      perform public.hexical_runtime_delete_keys(array[p_keys[3], p_keys[4]]);
    end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[1]::jsonb, null, false);
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[2], p_args[2]) on conflict do nothing;
    return jsonb_build_array(1, p_args[1]);
  elsif p_operation = 'tty-worker-update' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_worker := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_worker is null then return jsonb_build_array(0, 'unknown_worker'); end if;
    v_update := p_args[1]::jsonb;
    if p_args[2] = '1' then v_worker := jsonb_set(v_worker, '{version}', v_update->'version', true); end if;
    if p_args[3] = '1' then v_worker := jsonb_set(v_worker, '{capabilities}', v_update->'capabilities', true); end if;
    if p_args[4] = '1' then v_worker := jsonb_set(v_worker, '{metadata}', v_update->'metadata', true); end if;
    v_worker := jsonb_set(v_worker, '{updatedAt}', to_jsonb(p_args[5]), true);
    perform public.hexical_runtime_set_value(p_keys[1], v_worker, null, false);
    return jsonb_build_array(1, v_worker);
  elsif p_operation = 'tty-worker-deactivate' or p_operation = 'tty-worker-reactivate' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_worker := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_worker is null then return jsonb_build_array(0, 'unknown_worker'); end if;
    if p_operation = 'tty-worker-deactivate' then
      v_worker := v_worker || jsonb_build_object('status', 'inactive', 'deactivatedAt', p_args[1], 'updatedAt', p_args[1]);
    else
      v_worker := v_worker || jsonb_build_object('status', 'active', 'deactivatedAt', null, 'updatedAt', p_args[1]);
    end if;
    perform public.hexical_runtime_set_value(p_keys[1], v_worker, null, false);
    return jsonb_build_array(1, v_worker);
  elsif p_operation = 'tty-worker-record-heartbeat' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_worker := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_worker is null then return jsonb_build_array(0, 'unknown_worker'); end if;
    if v_worker->>'status' = 'inactive' then return jsonb_build_array(0, 'inactive_worker'); end if;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[2]);
    if v_value is not null and (v_value->>'sequence')::bigint >= p_args[3]::bigint then return jsonb_build_array(0, 'duplicate_heartbeat'); end if;
    perform public.hexical_runtime_set_value(p_keys[2], p_args[1]::jsonb, null, false);
    perform public.hexical_runtime_set_value(p_keys[3], p_args[2]::jsonb, null, false);
    if v_worker->>'status' = 'offline' then
      v_worker := v_worker || jsonb_build_object('status','active','deactivatedAt',null,'updatedAt',p_args[4]);
      perform public.hexical_runtime_set_value(p_keys[1], v_worker, null, false);
    end if;
    return jsonb_build_array(1, p_args[1] || '|' || p_args[2]);
  elsif p_operation = 'tty-worker-mark-offline' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_worker := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_worker is null then return jsonb_build_array(0, 'unknown_worker'); end if;
    if v_worker->>'status' = 'inactive' then return jsonb_build_array(0, 'inactive_worker'); end if;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[2]);
    if v_value is not null and p_args[1]::bigint - (v_value->>'receivedAtMs')::bigint <= p_args[2]::bigint then return jsonb_build_array(0, 'not_stale'); end if;
    perform public.hexical_runtime_set_value(p_keys[3], p_args[3]::jsonb, null, false);
    v_worker := v_worker || jsonb_build_object('status','offline','updatedAt',p_args[4]);
    perform public.hexical_runtime_set_value(p_keys[1], v_worker, null, false);
    return jsonb_build_array(1, p_args[3]);
  elsif p_operation = 'tty-session:create-with-cap' then
    if exists (select 1 from public.hexical_runtime_kv where key = p_keys[1] and (expires_at is null or expires_at > now())) then
      return jsonb_build_array(0, 'session_id_conflict');
    end if;
    v_count := 0;
    for v_member in select member from public.hexical_runtime_set_members where key = p_keys[3] loop
      if exists (select 1 from public.hexical_runtime_kv where key = 'tty:session:'||v_member||':core' and (expires_at is null or expires_at > now()))
         and exists (select 1 from public.hexical_runtime_kv where key = 'tty:session:'||v_member||':status' and (expires_at is null or expires_at > now()))
         and not exists (select 1 from public.hexical_runtime_kv where key = 'tty:session:'||v_member||':terminal' and (expires_at is null or expires_at > now())) then
        v_count := v_count + 1;
      else
        delete from public.hexical_runtime_set_members where key = p_keys[3] and member = v_member;
      end if;
    end loop;
    if v_count >= p_args[6]::integer then return jsonb_build_array(0, 'concurrency_limit_exceeded'); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[2]::jsonb, p_args[4]::integer, false);
    perform public.hexical_runtime_set_value(p_keys[2], p_args[3]::jsonb, p_args[5]::integer, false);
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[3], p_args[1]) on conflict do nothing;
    return jsonb_build_array(1, p_args[1]);
  elsif p_operation = 'hexical:tty-execution-admission-reserve' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is not null and (select expires_at is null or expires_at > now() from public.hexical_runtime_kv where key = p_keys[1]) then
      return jsonb_build_array(2, v_value);
    end if;
    if exists (select 1 from public.hexical_runtime_kv where key = p_keys[6] and (expires_at is null or expires_at > now()))
       or not exists (select 1 from public.hexical_runtime_kv where key = p_keys[7] and (expires_at is null or expires_at > now()))
       or not exists (select 1 from public.hexical_runtime_kv where key = p_keys[8] and (expires_at is null or expires_at > now())) then
      return jsonb_build_array(0, 'session_terminated');
    end if;
    delete from public.hexical_runtime_sorted_members where key = p_keys[5] and score <= p_args[3]::numeric - 60000;
    v_count := (select count(*) from public.hexical_runtime_sorted_members where key = p_keys[5]);
    v_number := coalesce((select (value #>> '{}')::bigint from public.hexical_runtime_kv where key = p_keys[3]), 0);
    if v_number >= p_args[4]::bigint then return jsonb_build_array(0, 'queue_full'); end if;
    v_number := coalesce((select (value #>> '{}')::bigint from public.hexical_runtime_kv where key = p_keys[4]), 0);
    if v_number >= p_args[5]::bigint then return jsonb_build_array(0, 'concurrency_limit_exceeded'); end if;
    if v_count >= p_args[6]::bigint then return jsonb_build_array(0, 'rate_limited'); end if;
    perform public.hexical_runtime_increment_value(p_keys[3], 1);
    perform public.hexical_runtime_increment_value(p_keys[4], 1);
    perform public.hexical_runtime_expire_key(p_keys[3], p_args[2]::integer);
    perform public.hexical_runtime_expire_key(p_keys[4], p_args[2]::integer);
    insert into public.hexical_runtime_sorted_members(key, member, score) values (p_keys[5], p_args[1], p_args[3]::numeric)
      on conflict (key, member) do update set score = excluded.score;
    perform public.hexical_runtime_set_value(p_keys[2], p_args[7]::jsonb, p_args[2]::integer, false);
    perform public.hexical_runtime_set_value(p_keys[1], p_args[8]::jsonb, p_args[9]::integer, false);
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[9], p_args[1]) on conflict do nothing;
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[10], p_keys[1]) on conflict do nothing;
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[11], p_args[1]) on conflict do nothing;
    perform public.hexical_runtime_append_stream('tty:executions:pending-events', jsonb_build_object('executionId', p_args[1]));
    perform public.hexical_runtime_set_value(p_keys[12], p_args[10]::jsonb, p_args[14]::integer, false);
    delete from public.hexical_runtime_set_members where key = p_keys[13] and member = p_args[1];
    v_sequence := public.hexical_runtime_increment_value(p_keys[15], 1);
    insert into public.hexical_runtime_stream_entries(stream_key, stream_sequence, stream_id, fields)
      values (p_keys[14], v_sequence, v_sequence::text||'-0', jsonb_build_object('eventId',p_args[11],'sequence',v_sequence::text,'timestamp',p_args[12],'executionId',p_args[1],'sessionId',p_args[13],'type','state','data','{"state":"queued"}'::jsonb::text));
    return jsonb_build_array(1, p_args[7]);
  elsif p_operation = 'tty-execution-state-transition' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if p_args[1] = '__missing__' then
      if v_value is not null then return jsonb_build_array(0, v_value); end if;
      perform public.hexical_runtime_set_value(p_keys[1], p_args[3]::jsonb, p_args[6]::integer, false);
      return jsonb_build_array(1, p_args[3]);
    end if;
    if v_value is null then return jsonb_build_array(0, 'missing'); end if;
    if (v_value->>'state') <> p_args[1] then return jsonb_build_array(0, v_value); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[3]::jsonb, p_args[6]::integer, false);
    if p_args[4] = '1' then insert into public.hexical_runtime_set_members(key, member) values (p_keys[2], p_args[5]) on conflict do nothing;
    else delete from public.hexical_runtime_set_members where key = p_keys[2] and member = p_args[5]; end if;
    return jsonb_build_array(1, p_args[3]);
  elsif p_operation = 'hexical:tty-output-append' then
    delete from public.hexical_runtime_stream_entries where stream_key = p_keys[1] and expires_at is not null and expires_at <= now();
    delete from public.hexical_runtime_hashes where key = p_keys[3] and expires_at is not null and expires_at <= now();
    v_existing := (
      select h.value
      from public.hexical_runtime_hashes as h
      where h.key = p_keys[3] and h.field = p_args[1]
    );
    if v_existing is not null then return to_jsonb(v_existing); end if;
    v_sequence := public.hexical_runtime_increment_value(p_keys[2], 1);
    insert into public.hexical_runtime_stream_entries(stream_key, stream_sequence, stream_id, fields)
      values (p_keys[1], v_sequence, v_sequence::text||'-0', jsonb_build_object('eventId',p_args[1],'sequence',v_sequence::text,'timestamp',p_args[2],'executionId',p_args[3],'sessionId',p_args[4],'type',p_args[5],'data',p_args[6])::jsonb);
    update public.hexical_runtime_stream_entries
      set expires_at = now() + make_interval(secs => p_args[7]::integer)
      where stream_key = p_keys[1] and stream_sequence = v_sequence;
    insert into public.hexical_runtime_hashes(key,field,value,expires_at)
      values (p_keys[3],p_args[1],v_sequence::text,now() + make_interval(secs => p_args[7]::integer)) on conflict do nothing;
    perform public.hexical_runtime_expire_key(p_keys[2], p_args[7]::integer);
    return to_jsonb(v_sequence::text);
  elsif p_operation = 'hexical:tty-session-transcript-append' then
    delete from public.hexical_runtime_stream_entries where stream_key = p_keys[1] and expires_at is not null and expires_at <= now();
    delete from public.hexical_runtime_hashes where key = p_keys[3] and expires_at is not null and expires_at <= now();
    v_existing := (
      select h.value
      from public.hexical_runtime_hashes as h
      where h.key = p_keys[3] and h.field = p_args[1]
    );
    if v_existing is not null then return jsonb_build_array(split_part(v_existing,'|',1), split_part(v_existing,'|',2)); end if;
    v_sequence := public.hexical_runtime_increment_value(p_keys[2], 1);
    v_cursor := public.hexical_runtime_append_stream(p_keys[1], jsonb_build_object('eventId',p_args[1],'sequence',v_sequence::text,'timestamp',p_args[2],'sessionId',p_args[3],'type',p_args[4],'data',p_args[5]));
    update public.hexical_runtime_stream_entries
      set expires_at = now() + make_interval(secs => p_args[6]::integer)
      where stream_key = p_keys[1] and stream_id = v_cursor;
    insert into public.hexical_runtime_hashes(key,field,value,expires_at)
      values (p_keys[3],p_args[1],v_sequence::text||'|'||v_cursor,now() + make_interval(secs => p_args[6]::integer)) on conflict do nothing;
    perform public.hexical_runtime_expire_key(p_keys[2], p_args[6]::integer);
    return jsonb_build_array(v_sequence, v_cursor);
  elsif p_operation = 'hexical:tty-live-publish' then
    v_sequence := public.hexical_runtime_increment_value(p_keys[2], 1);
    v_cursor := public.hexical_runtime_append_stream(p_keys[1], jsonb_build_object('eventId',p_args[1],'sequence',v_sequence::text,'timestamp',p_args[2],'executionId',p_args[3],'sessionId',p_args[4],'type',p_args[5],'payload',p_args[6]));
    return to_jsonb(v_sequence);
  elsif p_operation = 'hexical:tty-session-runtime-claim' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is not null then return jsonb_build_array(0, v_value); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[1]::jsonb, ceil(p_args[2]::numeric/1000)::integer, false);
    return jsonb_build_array(1, p_args[1]);
  elsif p_operation = 'hexical:tty-session-runtime-promote' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is null or v_value->>'runtimeId' <> p_args[1] then return to_jsonb(0); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[2]::jsonb, ceil(p_args[3]::numeric/1000)::integer, false);
    perform public.hexical_runtime_set_value(p_keys[2], p_args[4]::jsonb, p_args[5]::integer, false);
    return to_jsonb(1);
  elsif p_operation = 'hexical:tty-session-runtime-renew' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is null or v_value->>'runtimeId' <> p_args[1] then return to_jsonb(0); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[2]::jsonb, ceil(p_args[3]::numeric/1000)::integer, false);
    return to_jsonb(1);
  elsif p_operation = 'hexical:tty-session-runtime-release' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is null then return to_jsonb(1); end if;
    if v_value->>'runtimeId' <> p_args[1] then return to_jsonb(0); end if;
    delete from public.hexical_runtime_kv where key = p_keys[1]; return to_jsonb(1);
  elsif p_operation = 'hexical:tty-session-active-execution-claim' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is not null then return jsonb_build_array(0, v_value); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[1]::jsonb, p_args[2]::integer, false);
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[2], p_args[3]) on conflict do nothing;
    return jsonb_build_array(1, p_args[1]);
  elsif p_operation = 'hexical:tty-session-active-execution-update' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is null or v_value->>'sessionId' <> p_args[1] or v_value->>'executionId' <> p_args[2] or v_value->>'token' <> p_args[3] then return to_jsonb(0); end if;
    perform public.hexical_runtime_set_value(p_keys[1], p_args[4]::jsonb, p_args[5]::integer, false);
    insert into public.hexical_runtime_set_members(key, member) values (p_keys[2], p_args[1]) on conflict do nothing;
    return to_jsonb(1);
  elsif p_operation = 'hexical:tty-session-active-execution-release' then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_value := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_value is null then delete from public.hexical_runtime_set_members where key = p_keys[2] and member = p_args[1]; return to_jsonb(1); end if;
    if v_value->>'sessionId' <> p_args[1] or v_value->>'executionId' <> p_args[2] then return to_jsonb(0); end if;
    delete from public.hexical_runtime_kv where key = p_keys[1]; delete from public.hexical_runtime_set_members where key = p_keys[2] and member = p_args[1]; return to_jsonb(1);
  end if;

  -- Lease operations use row locks on the job and update all indexes in one
  -- transaction. This is the Postgres equivalent of the former Lua scripts.
  if p_operation in ('tty-lease-claim','tty-lease-renew','tty-lease-release','tty-lease-recover','tty-lease-adopt-persistent','tty-lease-complete') then
    perform 1 from public.hexical_runtime_kv where key = p_keys[1] for update;
    v_job := (select value from public.hexical_runtime_kv where key = p_keys[1]);
    if v_job is null then return jsonb_build_array(0, 'missing_job'); end if;
    if p_operation = 'tty-lease-claim' then
      if v_job->>'status' <> 'queued' then return jsonb_build_array(0, 'not_queued'); end if;
      if v_job->>'sessionId' <> p_args[8] then return jsonb_build_array(0, 'session_terminated'); end if;
      if exists(select 1 from public.hexical_runtime_kv where key=p_keys[4] and expires_at > now()) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[2] and (expires_at is null or expires_at > now())) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[3] and (expires_at is null or expires_at > now())) then return jsonb_build_array(0,'session_terminated'); end if;
      v_number := coalesce((v_job->>'attempt')::bigint,0) + 1;
      if v_number > p_args[4]::bigint then return jsonb_build_array(0,'attempts_exhausted'); end if;
      v_lease := jsonb_build_object('workerId',p_args[1]) || (p_args[2]::jsonb) || jsonb_build_object('claimedAtMs',p_args[3]::bigint,'renewedAtMs',p_args[3]::bigint,'expiresAtMs',p_args[3]::bigint+p_args[5]::bigint,'maxExpiresAtMs',p_args[3]::bigint+p_args[6]::bigint);
      v_job := v_job || jsonb_build_object('status','leased','attempt',v_number,'lease',v_lease);
      perform public.hexical_runtime_increment_value(p_keys[5],-1); perform public.hexical_runtime_expire_key(p_keys[5],p_args[7]::integer);
      perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[7]::integer,false);
      insert into public.hexical_runtime_set_members(key,member) values(p_keys[7],v_job->>'executionId') on conflict do nothing;
      insert into public.hexical_runtime_set_members(key,member) values(p_keys[8],p_args[1]||'|'||(v_job->>'executionId')) on conflict do nothing;
      delete from public.hexical_runtime_set_members where key=p_keys[10] and member=v_job->>'executionId';
      return jsonb_build_array(1,v_job);
    elsif p_operation = 'tty-lease-renew' then
      if v_job->>'status' <> 'leased' or v_job->'lease' is null or v_job->'lease'->>'workerId' <> p_args[1] or v_job->'lease'->>'token' <> p_args[2] or v_job->>'sessionId' <> p_args[6] then return jsonb_build_array(0,'not_owner'); end if;
      if (v_job->'lease'->>'expiresAtMs')::bigint <= p_args[3]::bigint or (v_job->'lease'->>'maxExpiresAtMs')::bigint <= p_args[3]::bigint then return jsonb_build_array(0,'lease_expired'); end if;
      if exists(select 1 from public.hexical_runtime_kv where key=p_keys[4] and expires_at > now()) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[2] and (expires_at is null or expires_at > now())) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[3] and (expires_at is null or expires_at > now())) then return jsonb_build_array(0,'session_terminated'); end if;
      v_now := least(p_args[3]::bigint+p_args[4]::bigint,(v_job->'lease'->>'maxExpiresAtMs')::bigint);
      v_job := jsonb_set(v_job,'{lease,expiresAtMs}',to_jsonb(v_now),true); v_job := jsonb_set(v_job,'{lease,renewedAtMs}',to_jsonb(p_args[3]::bigint),true);
      perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[5]::integer,false); return jsonb_build_array(1,v_job);
    elsif p_operation = 'tty-lease-complete' then
      if v_job->>'status' <> 'leased' or v_job->'lease' is null or v_job->'lease'->>'workerId' <> p_args[1] or v_job->'lease'->>'token' <> p_args[2] or v_job->>'sessionId' <> p_args[5] then return jsonb_build_array(0,'not_owner'); end if;
      if (v_job->'lease'->>'expiresAtMs')::bigint <= p_args[3]::bigint then return jsonb_build_array(0,'lease_expired'); end if;
      if exists(select 1 from public.hexical_runtime_kv where key=p_keys[4] and expires_at > now()) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[2] and (expires_at is null or expires_at > now())) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[3] and (expires_at is null or expires_at > now())) then return jsonb_build_array(0,'session_terminated'); end if;
      perform public.hexical_runtime_increment_value(p_keys[5],-1); perform public.hexical_runtime_expire_key(p_keys[5],86400);
      delete from public.hexical_runtime_set_members where (key=p_keys[6] and member=p_args[4]) or (key=p_keys[7] and member=p_args[1]||'|'||p_args[4]) or (key=p_keys[8] and member=p_args[4]) or (key=p_keys[9] and member=p_args[4]);
      delete from public.hexical_runtime_kv where key=p_keys[1]; return jsonb_build_array(1,v_job);
    elsif p_operation = 'tty-lease-release' then
      if v_job->>'status' <> 'leased' or v_job->'lease' is null or v_job->'lease'->>'workerId' <> p_args[1] or v_job->'lease'->>'token' <> p_args[2] or v_job->>'sessionId' <> p_args[7] then return jsonb_build_array(0,'not_owner'); end if;
      if (v_job->'lease'->>'expiresAtMs')::bigint <= p_args[3]::bigint then return jsonb_build_array(0,'lease_expired'); end if;
      if (v_job->>'attempt')::bigint >= p_args[6]::bigint then
        perform public.hexical_runtime_increment_value(p_keys[6],-1); perform public.hexical_runtime_expire_key(p_keys[6],p_args[4]::integer);
        v_job := (v_job - 'lease') || jsonb_build_object('status','abandoned'); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[4]::integer,false);
        delete from public.hexical_runtime_set_members where (key=p_keys[7] and member=p_args[5]) or (key=p_keys[8] and member=p_args[1]||'|'||p_args[5]) or (key=p_keys[9] and member=p_args[5]) or (key=p_keys[10] and member=p_args[5]);
        return jsonb_build_array(0,'attempts_exhausted');
      end if;
      v_job := (v_job - 'lease') || jsonb_build_object('status','queued','attempt',(v_job->>'attempt')::bigint+1);
      perform public.hexical_runtime_increment_value(p_keys[5],1); perform public.hexical_runtime_expire_key(p_keys[5],p_args[4]::integer); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[4]::integer,false);
      delete from public.hexical_runtime_set_members where (key=p_keys[7] and member=p_args[5]) or (key=p_keys[8] and member=p_args[1]||'|'||p_args[5]); insert into public.hexical_runtime_set_members(key,member) values(p_keys[10],p_args[5]) on conflict do nothing;
      return jsonb_build_array(1,v_job);
    elsif p_operation = 'tty-lease-recover' then
      if v_job->>'status' <> 'leased' or v_job->'lease' is null then return jsonb_build_array(0,'not_leased'); end if;
      if v_job->>'sessionId' <> p_args[6] then return jsonb_build_array(0,'session_terminated'); end if;
      if (v_job->'lease'->>'expiresAtMs')::bigint > p_args[3]::bigint then return jsonb_build_array(0,'not_expired'); end if;
      v_expired_worker := v_job->'lease'->>'workerId'; v_expired_token := v_job->'lease'->>'token';
      if exists(select 1 from public.hexical_runtime_kv where key=p_keys[4] and expires_at > now()) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[2] and (expires_at is null or expires_at > now())) or not exists(select 1 from public.hexical_runtime_kv where key=p_keys[3] and (expires_at is null or expires_at > now())) then
        perform public.hexical_runtime_increment_value(p_keys[5],-1); delete from public.hexical_runtime_kv where key=p_keys[1]; delete from public.hexical_runtime_set_members where (key='tty:worker:'||v_expired_worker||':active-leases' and member=v_job->>'executionId') or (key=p_keys[8] and member=v_expired_worker||'|'||v_job->>'executionId') or (key=p_keys[9] and member=v_job->>'executionId'); return jsonb_build_array(0,'session_terminated',v_expired_worker||'|'||v_job->>'executionId'||'|'||v_expired_token);
      end if;
      if coalesce((v_job->>'attempt')::bigint,0) >= p_args[4]::bigint then
        perform public.hexical_runtime_increment_value(p_keys[5],-1); v_job := (v_job-'lease')||jsonb_build_object('status','abandoned'); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[5]::integer,false); delete from public.hexical_runtime_set_members where (key=p_keys[8] and member=v_expired_worker||'|'||v_job->>'executionId') or (key=p_keys[9] and member=v_job->>'executionId'); return jsonb_build_array(0,'attempts_exhausted',v_expired_worker||'|'||v_job->>'executionId'||'|'||v_expired_token);
      end if;
      v_job := (v_job-'lease')||jsonb_build_object('status','queued'); perform public.hexical_runtime_increment_value(p_keys[5],1); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[5]::integer,false); delete from public.hexical_runtime_set_members where (key='tty:worker:'||v_expired_worker||':active-leases' and member=v_job->>'executionId') or (key=p_keys[8] and member=v_expired_worker||'|'||v_job->>'executionId'); insert into public.hexical_runtime_set_members(key,member) values(p_keys[9],v_job->>'executionId') on conflict do nothing; return jsonb_build_array(1,v_job,v_expired_worker||'|'||v_job->>'executionId'||'|'||v_expired_token);
    elsif p_operation = 'tty-lease-adopt-persistent' then
      if v_job->>'status' <> 'leased' or v_job->'lease' is null then return jsonb_build_array(0,'not_leased'); end if;
      if v_job->>'executionId' <> p_args[1] or v_job->>'sessionId' <> p_args[2] then return jsonb_build_array(0,'session_terminated'); end if;
      if (v_job->'lease'->>'expiresAtMs')::bigint > p_args[5]::bigint then return jsonb_build_array(0,'not_expired'); end if;
      v_active := (select value from public.hexical_runtime_kv where key=p_keys[8]); if v_active is null or v_active->>'sessionId' <> v_job->>'sessionId' or v_active->>'executionId' <> v_job->>'executionId' or v_active->>'ownerUserId' <> v_job->>'ownerUserId' then return jsonb_build_array(0,'no_persistent_execution'); end if;
      v_expired_worker := v_job->'lease'->>'workerId'; v_expired_token := v_job->'lease'->>'token'; v_lease := jsonb_build_object('workerId',p_args[3])||(p_args[4]::jsonb)||jsonb_build_object('claimedAtMs',p_args[5]::bigint,'renewedAtMs',p_args[5]::bigint,'expiresAtMs',p_args[5]::bigint+p_args[6]::bigint,'maxExpiresAtMs',p_args[5]::bigint+p_args[7]::bigint); v_job := jsonb_set(v_job,'{lease}',v_lease,true); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[8]::integer,false);
      delete from public.hexical_runtime_set_members where (key='tty:worker:'||v_expired_worker||':active-leases' and member=v_job->>'executionId') or (key=p_keys[7] and member=v_expired_worker||'|'||v_job->>'executionId'); insert into public.hexical_runtime_set_members(key,member) values(p_keys[6],v_job->>'executionId') on conflict do nothing; insert into public.hexical_runtime_set_members(key,member) values(p_keys[7],p_args[3]||'|'||v_job->>'executionId') on conflict do nothing; return jsonb_build_array(1,v_job,v_expired_worker||'|'||v_job->>'executionId'||'|'||v_expired_token);
    end if;
  end if;
  raise exception 'Unsupported Hexical runtime operation: %', p_operation using errcode = '22023';
end;
$$;

revoke all on function public.hexical_runtime_set_value(text, jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function public.hexical_runtime_delete_keys(text[]) from public, anon, authenticated;
revoke all on function public.hexical_runtime_increment_value(text, integer) from public, anon, authenticated;
revoke all on function public.hexical_runtime_expire_key(text, integer) from public, anon, authenticated;
revoke all on function public.hexical_runtime_append_stream(text, jsonb) from public, anon, authenticated;
revoke all on function public.hexical_runtime_eval(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.hexical_runtime_set_value(text, jsonb, integer, boolean) to service_role;
grant execute on function public.hexical_runtime_delete_keys(text[]) to service_role;
grant execute on function public.hexical_runtime_increment_value(text, integer) to service_role;
grant execute on function public.hexical_runtime_expire_key(text, integer) to service_role;
grant execute on function public.hexical_runtime_append_stream(text, jsonb) to service_role;
grant execute on function public.hexical_runtime_eval(text, text[], text[]) to service_role;
