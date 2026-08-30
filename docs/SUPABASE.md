# Supabase storage

By default meamus stores users, games and upload metadata in a JSON file under
`server/data/`. That is fine locally. On a serverless or ephemeral host the
filesystem is thrown away on every restart, and the symptom is that **signup
stops working** — accounts are created, then vanish.

Pointing meamus at Supabase Postgres fixes that.

## Setup

**1. Create the tables.** Open your project → SQL Editor → New query, paste
[`supabase/schema.sql`](../supabase/schema.sql), and run it. It creates three
tables, the indexes the app actually queries, `updated_at` triggers, and turns
on Row Level Security with **no policies** — so the anon key can read nothing.

**2. Add two values to `.env`.** Both are in Dashboard → Project Settings → API.

```bash
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

Use the **`service_role`** key, not `anon`. The tables deny everything by
default and `service_role` is what bypasses RLS. This key is a full-access
credential: it belongs in server environment variables only and must never
reach a browser. If it ever appears in a client bundle, a log, or a chat, treat
it as compromised and rotate it.

**3. Verify.**

```bash
npm run db:check
```

It connects, writes a probe row, reads it back, updates it, deletes it, and
tells you which backend is live. A missing table or a wrong key fails here
rather than on a real user's first signup.

## How it stores things

Each collection is a table of `{ id text primary key, data jsonb }`, so the
document shape can change without a migration every time. The indexes cover the
two lookups the app actually performs — login by email, and a user's own games:

```sql
create unique index meamus_users_email_idx on public.meamus_users ((data->>'email'));
create index meamus_games_user_idx on public.meamus_games ((data->>'userId'));
```

The adapter talks to PostgREST over `fetch` rather than a Postgres driver. No
dependency, and no pooled TCP connection to leak on a serverless host.

Every document is read once at boot into memory, so the route handlers stay
synchronous; writes go straight through and update the cache. That is a
deliberate trade: it suits a single instance well, and **it does not suit
multiple instances** — two servers will not see each other's writes until they
restart. Before scaling past one instance, make the reads hit Postgres directly
or put the cache in Redis.

## Rolling back

Clear `SUPABASE_URL` and restart. meamus goes back to the JSON file. Nothing
migrates automatically between the two.

## What is *not* used

meamus does not use Supabase Auth, Storage or Realtime — only Postgres.
Accounts are handled in-process with scrypt and HMAC tokens, and attachments
are written to local disk. Moving attachments to Supabase Storage is the
obvious next step if you deploy somewhere with no persistent disk.
