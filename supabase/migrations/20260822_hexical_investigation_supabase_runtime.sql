-- Hexical Investigation API: move rate limits and budget ledgers onto the
-- already-deployed Supabase runtime store.
--
-- This migration is additive and reversible. It does not alter or drop any
-- existing application table. Runtime OS and Investigation messages now use
-- the same Postgres-backed store, so the Investigation path remains healthy
-- when Upstash is disabled.

create or replace function public.hexical_investigation_rate_limit(
  p_key text,
  p_capacity integer,
  p_window_seconds integer,
  p_now_ms bigint,
  p_member text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity integer := greatest(1, p_capacity);
  v_window_ms bigint := greatest(1, p_window_seconds)::bigint * 1000;
  v_now_ms bigint := greatest(0, p_now_ms);
  v_count bigint;
  v_reset_ms bigint;
begin
  -- Serialize callers for this key. This is the Postgres equivalent of the
  -- atomic sliding-window operation previously supplied by Upstash.
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));

  delete from public.hexical_runtime_sorted_members
   where key = p_key and score <= v_now_ms;

  select count(*), coalesce(min(score), v_now_ms + v_window_ms)
    into v_count, v_reset_ms
    from public.hexical_runtime_sorted_members
   where key = p_key;

  if v_count >= v_capacity then
    return jsonb_build_array(false, 0, v_reset_ms);
  end if;

  insert into public.hexical_runtime_sorted_members(key, member, score)
  values (p_key, p_member, v_now_ms + v_window_ms)
  on conflict (key, member) do update set score = excluded.score;

  select count(*), coalesce(min(score), v_now_ms + v_window_ms)
    into v_count, v_reset_ms
    from public.hexical_runtime_sorted_members
   where key = p_key;

  return jsonb_build_array(true, greatest(0, v_capacity - v_count), v_reset_ms);
end;
$$;

create or replace function public.hexical_investigation_reserve_budget(
  p_key text,
  p_amount bigint,
  p_cap bigint,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value jsonb;
  v_expires timestamptz;
  v_current bigint := 0;
  v_updated bigint;
begin
  select value, expires_at into v_value, v_expires
    from public.hexical_runtime_kv where key = p_key for update;

  if v_expires is not null and v_expires <= now() then
    delete from public.hexical_runtime_kv where key = p_key;
    v_value := null;
    v_expires := null;
  end if;

  v_current := coalesce(nullif(v_value #>> '{}', '')::bigint, 0);
  if v_current + greatest(1, p_amount) > greatest(0, p_cap) then
    return jsonb_build_array(0, v_current, greatest(0, p_cap - v_current));
  end if;

  v_updated := v_current + greatest(1, p_amount);
  if v_expires is null then
    v_expires := now() + make_interval(secs => greatest(1, p_ttl_seconds));
  end if;
  insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
  values (p_key, to_jsonb(v_updated), v_expires, now())
  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at, updated_at = now();

  return jsonb_build_array(1, v_updated, greatest(0, p_cap - v_updated));
end;
$$;

create or replace function public.hexical_investigation_reconcile_budget(
  p_key text,
  p_delta bigint
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value jsonb;
  v_expires timestamptz;
  v_updated bigint;
begin
  select value, expires_at into v_value, v_expires
    from public.hexical_runtime_kv where key = p_key for update;
  if v_expires is not null and v_expires <= now() then
    delete from public.hexical_runtime_kv where key = p_key;
    return 0;
  end if;

  v_updated := greatest(0, coalesce(nullif(v_value #>> '{}', '')::bigint, 0) + p_delta);
  insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
  values (p_key, to_jsonb(v_updated), v_expires, now())
  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at, updated_at = now();
  return v_updated;
end;
$$;

revoke all on function public.hexical_investigation_rate_limit(text, integer, integer, bigint, text) from public;
revoke all on function public.hexical_investigation_reserve_budget(text, bigint, bigint, integer) from public;
revoke all on function public.hexical_investigation_reconcile_budget(text, bigint) from public;
grant execute on function public.hexical_investigation_rate_limit(text, integer, integer, bigint, text) to service_role;
grant execute on function public.hexical_investigation_reserve_budget(text, bigint, bigint, integer) to service_role;
grant execute on function public.hexical_investigation_reconcile_budget(text, bigint) to service_role;

