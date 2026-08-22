-- Reversal for 20260822_hexical_investigation_supabase_runtime.sql.
-- The functions are only used by the Supabase-backed Investigation limits
-- adapter; Runtime OS tables and functions remain intact.

drop function if exists public.hexical_investigation_rate_limit(text, integer, integer, bigint, text);
drop function if exists public.hexical_investigation_reserve_budget(text, bigint, bigint, integer);
drop function if exists public.hexical_investigation_reconcile_budget(text, bigint);
