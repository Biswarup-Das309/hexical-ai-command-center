-- Hexical evidence graph: Supabase runtime operations.
--
-- The graph store keeps its replay-safe key/index contract so it can remain
-- independent from the UI and the historical storage implementation. The
-- Supabase runtime evaluator owns TTY/lease operations, however, and must not
-- be asked to interpret graph operation names. This additive RPC mirrors the
-- four graph atomic operations without reintroducing Redis.

create or replace function public.hexical_evidence_graph_eval(
  p_operation text,
  p_keys text[],
  p_args text[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created boolean;
  v_current text;
begin
  if p_operation = 'hexical:evidence-graph:entity-upsert' then
    insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
    values (p_keys[1], to_jsonb(p_args[1]), null, now())
    on conflict (key) do nothing;
    v_created := found;

    if v_created then
      insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
      values (p_keys[2], to_jsonb(p_args[2]), null, now())
      on conflict (key) do nothing;
    end if;

    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[3], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[4], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    return case when v_created then 1 else 0 end;
  elsif p_operation = 'hexical:evidence-graph:investigation-root-upsert' then
    insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
    values (p_keys[1], to_jsonb(p_args[1]), null, now())
    on conflict (key) do nothing;
    v_created := found;

    if v_created then
      insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
      values (p_keys[2], to_jsonb(p_args[2]), null, now())
      on conflict (key) do nothing;
    else
      update public.hexical_runtime_kv
         set value = to_jsonb(p_args[1]), updated_at = now()
       where key = p_keys[1];
    end if;

    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[3], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[4], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    return 1;
  elsif p_operation = 'hexical:evidence-graph:edge-upsert' then
    insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
    values (p_keys[1], to_jsonb(p_args[1]), null, now())
    on conflict (key) do nothing;
    v_created := found;

    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[2], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[3], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[4], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[5], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    insert into public.hexical_runtime_sorted_members(key, member, score)
    values (p_keys[6], p_args[2], p_args[3]::numeric)
    on conflict (key, member) do update set score = excluded.score;
    return case when v_created then 1 else 0 end;
  elsif p_operation = 'hexical:evidence-graph:last-updated-max' then
    select value #>> '{}' into v_current
      from public.hexical_runtime_kv
     where key = p_keys[1]
     for update;
    if v_current is null or p_args[1] > v_current then
      insert into public.hexical_runtime_kv(key, value, expires_at, updated_at)
      values (p_keys[1], to_jsonb(p_args[1]), null, now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
    end if;
    return 1;
  end if;

  raise exception 'Unsupported Hexical evidence graph operation: %', p_operation
    using errcode = '22023';
end;
$$;

revoke all on function public.hexical_evidence_graph_eval(text, text[], text[]) from public, anon, authenticated;
grant execute on function public.hexical_evidence_graph_eval(text, text[], text[]) to service_role;
