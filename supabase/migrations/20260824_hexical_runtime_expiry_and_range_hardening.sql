-- Additive Runtime OS hardening.
--
-- The original Redis-compatible expire function only updated KV rows, while
-- control, timeline, and transcript streams are stored separately. This
-- migration makes stream expiry durable and makes new entries inherit the
-- active stream TTL. It also removes expired rows before appending so an idle
-- stream cannot keep an old sequence alive forever after it resumes.

-- CREATE OR REPLACE cannot create a missing PostgreSQL function. The initial
-- runtime migration predates this RPC, so create a harmless placeholder only
-- when the signature is absent, then replace it with the implementation below.
do $migration$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'hexical_runtime_add_set_members'
      and p.proargtypes = '25 1009'::oidvector
  ) then
    execute $create_function$
      create function public.hexical_runtime_add_set_members(p_key text, p_members text[]) returns integer
      language plpgsql security definer set search_path = public as $function$
      begin
        return 0;
      end;
      $function$
    $create_function$;
  end if;
end;
$migration$;

create or replace function public.hexical_runtime_add_set_members(p_key text, p_members text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_rows integer;
begin
  if p_members is null or cardinality(p_members) = 0 then return 0; end if;
  insert into public.hexical_runtime_set_members(key, member)
    select p_key, distinct_members.member
    from (select distinct member from unnest(p_members) as unpacked(member)) as distinct_members
    on conflict (key, member) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.hexical_runtime_expire_key(p_key text, p_ttl_seconds integer) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_expires timestamptz := now() + make_interval(secs => greatest(1, p_ttl_seconds));
  v_rows integer;
  v_count integer := 0;
begin
  update public.hexical_runtime_kv
    set expires_at = v_expires, updated_at = now()
    where key = p_key and (expires_at is null or expires_at > now());
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  update public.hexical_runtime_hashes
    set expires_at = v_expires, updated_at = now()
    where key = p_key and (expires_at is null or expires_at > now());
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  delete from public.hexical_runtime_stream_entries
    where stream_key = p_key and expires_at is not null and expires_at <= now();
  update public.hexical_runtime_stream_entries
    set expires_at = v_expires
    where stream_key = p_key;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return case when v_count > 0 then 1 else 0 end;
end;
$$;

create or replace function public.hexical_runtime_append_stream(p_stream_key text, p_fields jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_sequence bigint;
  v_id text;
  v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_stream_key, 0));

  delete from public.hexical_runtime_stream_entries
    where stream_key = p_stream_key and expires_at is not null and expires_at <= now();
  select max(expires_at) into v_expires
    from public.hexical_runtime_stream_entries
    where stream_key = p_stream_key;
  select coalesce(max(stream_sequence), 0) + 1 into v_sequence
    from public.hexical_runtime_stream_entries where stream_key = p_stream_key;
  v_id := v_sequence::text || '-0';
  insert into public.hexical_runtime_stream_entries(stream_key, stream_sequence, stream_id, fields, expires_at)
    values (p_stream_key, v_sequence, v_id, p_fields, v_expires);
  return v_id;
end;
$$;

revoke all on function public.hexical_runtime_expire_key(text, integer) from public, anon, authenticated;
revoke all on function public.hexical_runtime_add_set_members(text, text[]) from public, anon, authenticated;
revoke all on function public.hexical_runtime_append_stream(text, jsonb) from public, anon, authenticated;
grant execute on function public.hexical_runtime_expire_key(text, integer) to service_role;
grant execute on function public.hexical_runtime_add_set_members(text, text[]) to service_role;
grant execute on function public.hexical_runtime_append_stream(text, jsonb) to service_role;
