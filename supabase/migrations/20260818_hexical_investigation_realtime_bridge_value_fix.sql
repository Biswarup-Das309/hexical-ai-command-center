-- Repair the bridge for the existing runtime KV contract. InvestigationStore
-- stores serialized JSON as a JSONB string, while other runtime values may be
-- native JSONB. Keep both representations supported.

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
  return new;
end;
$$;
