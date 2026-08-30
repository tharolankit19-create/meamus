-- ===========================================================================
-- meamus schema for Supabase
--
-- Run this once in the Supabase SQL editor:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
--
-- Documents live in a jsonb column so the app's shape can evolve without a
-- migration every time. Row Level Security is ON with no policies, which means
-- the anon key can read nothing: the server reaches these tables only with the
-- service-role key, and that key must never be sent to a browser.
-- ===========================================================================

create table if not exists public.meamus_users (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.meamus_games (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.meamus_uploads (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Lookups the app actually performs: login by email, and a user's own games.
create unique index if not exists meamus_users_email_idx
  on public.meamus_users ((data->>'email'));

create index if not exists meamus_games_user_idx
  on public.meamus_games ((data->>'userId'));

create index if not exists meamus_uploads_user_idx
  on public.meamus_uploads ((data->>'userId'));

-- Keep updated_at honest without the application having to remember.
create or replace function public.meamus_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['meamus_users', 'meamus_games', 'meamus_uploads'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format(
      'create trigger %I before update on public.%I
       for each row execute function public.meamus_touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end;
$$;

-- Deny-by-default. No policies are created, so only the service-role key
-- (which bypasses RLS) can read or write. Do not add permissive policies
-- unless you intend the anon key to see other people's games.
alter table public.meamus_users   enable row level security;
alter table public.meamus_games   enable row level security;
alter table public.meamus_uploads enable row level security;
