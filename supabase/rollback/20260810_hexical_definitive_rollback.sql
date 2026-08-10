-- Rollback for the deliberate rebuild. This restores the previous schema only
-- when a pre-reset SQL backup is available. Do not invent a rollback from this
-- file: data restoration must come from the Supabase backup/PITR snapshot.
-- 1) Stop the application and restore the backup snapshot in Supabase.
-- 2) Re-run the old migration set in its original order.
-- 3) Deploy the previous application commit.
-- 4) Run the old verification script and smoke test Clerk, billing, usage,
--    investigations, and TTY execution before reopening traffic.

begin;
drop function if exists public.canonical_entitlement(text) cascade;
drop function if exists public.reserve_budget(text,text,numeric) cascade;
drop function if exists public.release_reservation(uuid) cascade;
drop function if exists public.increment_usage(text,integer,numeric) cascade;
drop function if exists public.process_payment_webhook(text,text,text,text,bigint,integer) cascade;
commit;

-- The destructive portion is intentionally not automated here. The only safe
-- rollback of a destructive reset is the operator-selected backup snapshot.
