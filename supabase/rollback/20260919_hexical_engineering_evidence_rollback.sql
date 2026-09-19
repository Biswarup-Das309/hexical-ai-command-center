-- Reverts 20260919_hexical_engineering_evidence.sql.
-- Apply only as an explicitly approved rollback; this removes engineering evidence runs.

drop table if exists public.hexical_engineering_evidence cascade;
drop table if exists public.hexical_engineering_tasks cascade;
drop table if exists public.hexical_engineering_runs cascade;
drop table if exists public.hexical_repository_edges cascade;
drop table if exists public.hexical_repository_nodes cascade;
drop table if exists public.hexical_repository_contexts cascade;
