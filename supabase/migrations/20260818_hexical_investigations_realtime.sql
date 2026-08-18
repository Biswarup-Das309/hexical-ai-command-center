-- Additive Realtime publication for owner-scoped investigation list updates.
-- Initial state remains the authenticated /api/investigations response; this
-- publication only carries changes for the current user's RLS-visible rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.investigations;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;
