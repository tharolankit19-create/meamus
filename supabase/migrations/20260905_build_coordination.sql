-- Durable, single-use build approvals. Re-run this schema before deploying.
create table if not exists public.meamus_build_plans (
  id text primary key,
  user_id text not null,
  expires_at timestamptz not null,
  data jsonb not null
);
alter table public.meamus_build_plans enable row level security;
create index if not exists meamus_build_plans_expiry_idx on public.meamus_build_plans(expires_at);

-- Keep cancellation separate so progress updates cannot overwrite a stop request.
alter table public.meamus_games add column if not exists stop_requested boolean not null default false;
