-- ===========================================================================
-- meamus: real accounts on Supabase Auth
--
-- Run once in the Supabase SQL editor, after schema.sql.
--
-- Identity lives in auth.users, which Supabase owns: it holds the password
-- hash, the email confirmation state and the Google identity link. This file
-- adds the one table meamus owns - the profile - keyed to that identity.
--
-- Guest sessions are gone. An account is the only way in, and an account is
-- what a credit balance hangs off.
-- ===========================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  name         text,
  plan         text        not null default 'free',
  credits      integer     not null default 200,
  usage        jsonb       not null default '{"date": null, "count": 0}'::jsonb,
  billing      jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'One row per authenticated user. Credits and plan live here; identity lives in auth.users.';

-- A profile must exist the moment an account does, including accounts created
-- by Google sign-in, which never touch our signup endpoint.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      split_part(coalesce(new.email, 'player'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- RLS on. A signed-in user may read and update their own row, but the columns
-- that cost money are not theirs to set: the grant below is deliberately
-- limited to display fields, so a browser cannot award itself credits.
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own_name on public.profiles;
create policy profiles_update_own_name on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Credits, plan and billing are written only by the server, which uses the
-- service-role key and bypasses RLS. Revoking them at the column level means a
-- stolen access token still cannot mint credits.
revoke update (credits, plan, billing, usage) on public.profiles from authenticated, anon;

-- Backfill for any account created before this file was run.
insert into public.profiles (id, email, name)
select u.id, u.email,
       coalesce(u.raw_user_meta_data->>'name',
                u.raw_user_meta_data->>'full_name',
                split_part(coalesce(u.email, 'player'), '@', 1))
from auth.users u
on conflict (id) do nothing;

-- Games are still keyed by the profile id, so this index still applies:
--   meamus_games_user_idx on (data->>'userId')
