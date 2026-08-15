-- Preserve the deployed function history while repairing the lease identity
-- fields that were omitted by the initial Supabase runtime migration.
--
-- The migration is idempotent: it reads the existing function definition,
-- replaces only the two affected lease-construction expressions, and fails
-- closed if the expected old implementation is not present.
do $migration$
declare
  v_source text;
  v_replaced text;
begin
  select pg_get_functiondef(p.oid)
    into v_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'hexical_runtime_eval'
    and p.pronargs = 3;

  if v_source is null then
    raise exception 'public.hexical_runtime_eval(text,text[],text[]) is missing';
  end if;

  if position('jsonb_build_object(''workerId'',p_args[1])' in v_source) > 0
     and position('jsonb_build_object(''workerId'',p_args[3])' in v_source) > 0 then
    return;
  end if;

  v_replaced := replace(
    v_source,
    'v_lease := (p_args[2]::jsonb) || jsonb_build_object(''claimedAtMs'',p_args[3]::bigint,''renewedAtMs'',p_args[3]::bigint,''expiresAtMs'',p_args[3]::bigint+p_args[5]::bigint,''maxExpiresAtMs'',p_args[3]::bigint+p_args[6]::bigint);',
    'v_lease := jsonb_build_object(''workerId'',p_args[1]) || (p_args[2]::jsonb) || jsonb_build_object(''claimedAtMs'',p_args[3]::bigint,''renewedAtMs'',p_args[3]::bigint,''expiresAtMs'',p_args[3]::bigint+p_args[5]::bigint,''maxExpiresAtMs'',p_args[3]::bigint+p_args[6]::bigint);'
  );
  v_replaced := replace(
    v_replaced,
    'v_expired_worker := v_job->''lease''->>''workerId''; v_expired_token := v_job->''lease''->>''token''; v_lease := (p_args[4]::jsonb)||jsonb_build_object(''claimedAtMs'',p_args[5]::bigint,''renewedAtMs'',p_args[5]::bigint,''expiresAtMs'',p_args[5]::bigint+p_args[6]::bigint,''maxExpiresAtMs'',p_args[5]::bigint+p_args[7]::bigint); v_job := jsonb_set(v_job,''{lease}'',v_lease,true); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[8]::integer,false);',
    'v_expired_worker := v_job->''lease''->>''workerId''; v_expired_token := v_job->''lease''->>''token''; v_lease := jsonb_build_object(''workerId'',p_args[3])||(p_args[4]::jsonb)||jsonb_build_object(''claimedAtMs'',p_args[5]::bigint,''renewedAtMs'',p_args[5]::bigint,''expiresAtMs'',p_args[5]::bigint+p_args[6]::bigint,''maxExpiresAtMs'',p_args[5]::bigint+p_args[7]::bigint); v_job := jsonb_set(v_job,''{lease}'',v_lease,true); perform public.hexical_runtime_set_value(p_keys[1],v_job,p_args[8]::integer,false);'
  );

  if v_replaced = v_source then
    raise exception 'expected stale lease construction was not found in public.hexical_runtime_eval';
  end if;

  execute v_replaced;
end
$migration$;
