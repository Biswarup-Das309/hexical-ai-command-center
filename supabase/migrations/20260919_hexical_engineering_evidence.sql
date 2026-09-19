-- Bounded repository evidence and engineering-run persistence.
-- This migration stores metadata/relationships, not submitted source bodies.
-- The application uses the service role and enforces owner_user_id on every read.

create table if not exists public.hexical_repository_contexts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  repository_key text not null,
  root text not null default '/',
  status text not null default 'ready' check (status in ('ready', 'failed', 'deleted')),
  summary jsonb not null default '{}'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  file_count integer not null default 0 check (file_count >= 0),
  node_count integer not null default 0 check (node_count >= 0),
  edge_count integer not null default 0 check (edge_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hexical_repository_contexts_owner_idx
  on public.hexical_repository_contexts (owner_user_id, created_at desc);

create table if not exists public.hexical_repository_nodes (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.hexical_repository_contexts(id) on delete cascade,
  owner_user_id text not null,
  node_id text not null,
  kind text not null,
  node_key text not null,
  name text not null,
  path text null,
  language text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (repository_id, node_id)
);

create index if not exists hexical_repository_nodes_owner_path_idx
  on public.hexical_repository_nodes (owner_user_id, repository_id, path);

create table if not exists public.hexical_repository_edges (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.hexical_repository_contexts(id) on delete cascade,
  owner_user_id text not null,
  edge_id text not null,
  source_node_id text not null,
  target_node_id text not null,
  relation text not null,
  direct boolean not null default true,
  confidence text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (repository_id, edge_id)
);

create index if not exists hexical_repository_edges_owner_source_idx
  on public.hexical_repository_edges (owner_user_id, repository_id, source_node_id);
create index if not exists hexical_repository_edges_owner_target_idx
  on public.hexical_repository_edges (owner_user_id, repository_id, target_node_id);

create table if not exists public.hexical_engineering_runs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  repository_id uuid not null references public.hexical_repository_contexts(id) on delete cascade,
  objective text not null,
  status text not null check (status in ('CREATED', 'ANALYZING', 'PLANNING', 'CHANGING', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED')),
  verification_status text null check (verification_status in ('VERIFIED', 'PARTIALLY_VERIFIED', 'FAILED', 'BLOCKED')),
  errors jsonb not null default '[]'::jsonb,
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hexical_engineering_runs_owner_idx
  on public.hexical_engineering_runs (owner_user_id, created_at desc);

create table if not exists public.hexical_engineering_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.hexical_engineering_runs(id) on delete cascade,
  owner_user_id text not null,
  role text not null,
  objective text not null,
  status text not null check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED')),
  input_context jsonb not null default '{}'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  confidence numeric null check (confidence is null or (confidence >= 0 and confidence <= 100)),
  error text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists hexical_engineering_tasks_owner_run_idx
  on public.hexical_engineering_tasks (owner_user_id, run_id, created_at);

create table if not exists public.hexical_engineering_evidence (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.hexical_engineering_runs(id) on delete cascade,
  owner_user_id text not null,
  evidence_type text not null,
  certainty text not null check (certainty in ('OBSERVED', 'DERIVED', 'INFERRED')),
  title text not null,
  explanation text not null,
  source jsonb null,
  payload jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists hexical_engineering_evidence_owner_run_idx
  on public.hexical_engineering_evidence (owner_user_id, run_id, created_at);

do $$
begin
  if to_regprocedure('public.hexical_set_updated_at()') is not null then
    drop trigger if exists hexical_repository_contexts_updated_at on public.hexical_repository_contexts;
    create trigger hexical_repository_contexts_updated_at
      before update on public.hexical_repository_contexts
      for each row execute function public.hexical_set_updated_at();
    drop trigger if exists hexical_engineering_runs_updated_at on public.hexical_engineering_runs;
    create trigger hexical_engineering_runs_updated_at
      before update on public.hexical_engineering_runs
      for each row execute function public.hexical_set_updated_at();
  end if;
end;
$$;

alter table public.hexical_repository_contexts enable row level security;
alter table public.hexical_repository_nodes enable row level security;
alter table public.hexical_repository_edges enable row level security;
alter table public.hexical_engineering_runs enable row level security;
alter table public.hexical_engineering_tasks enable row level security;
alter table public.hexical_engineering_evidence enable row level security;

drop policy if exists hexical_repository_contexts_service_role on public.hexical_repository_contexts;
create policy hexical_repository_contexts_service_role on public.hexical_repository_contexts
  for all to service_role using (true) with check (true);
drop policy if exists hexical_repository_nodes_service_role on public.hexical_repository_nodes;
create policy hexical_repository_nodes_service_role on public.hexical_repository_nodes
  for all to service_role using (true) with check (true);
drop policy if exists hexical_repository_edges_service_role on public.hexical_repository_edges;
create policy hexical_repository_edges_service_role on public.hexical_repository_edges
  for all to service_role using (true) with check (true);
drop policy if exists hexical_engineering_runs_service_role on public.hexical_engineering_runs;
create policy hexical_engineering_runs_service_role on public.hexical_engineering_runs
  for all to service_role using (true) with check (true);
drop policy if exists hexical_engineering_tasks_service_role on public.hexical_engineering_tasks;
create policy hexical_engineering_tasks_service_role on public.hexical_engineering_tasks
  for all to service_role using (true) with check (true);
drop policy if exists hexical_engineering_evidence_service_role on public.hexical_engineering_evidence;
create policy hexical_engineering_evidence_service_role on public.hexical_engineering_evidence
  for all to service_role using (true) with check (true);
