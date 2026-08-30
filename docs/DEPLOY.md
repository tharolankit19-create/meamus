# Deploying

meamus runs two ways from the same code:

| | Entry point | Used by |
|---|---|---|
| **Long-running server** | `server/index.js` (calls `app.listen`) | Render, Railway, Fly, a VPS, Docker |
| **Serverless handler** | `api/index.js` (exports the app) | Vercel, Netlify, Lambda |

`server/index.js` only binds a socket when it is the main module, so the
serverless entry gets the same configured app with nothing listening.

---

## Vercel

`vercel.json` routes `/api/*` and `/play/*` to the function; everything in
`public/` is served statically by the platform.

### Required environment variables

Project → Settings → Environment Variables. Set these for **Production** (and
Preview if you use it).

| Variable | Value | Why |
|---|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` | **Without this, signup silently fails.** |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key | Bypasses RLS. Server-side only. |
| `OPENROUTER_API_KEY` | `sk-or-v1-…` | Without it, prompts fall back to templates. |
| `JWT_SECRET` | 96 random hex chars | Without it every cold start invalidates all sessions. |
| `TEST_MODE` | `false` | `true` lets anyone spend your API credits. |
| `NODE_ENV` | `production` | |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Why the filesystem matters here

Serverless gives you a read-only project directory and a `/tmp` that is
discarded between invocations. meamus detects the platform and moves its
writable paths to `/tmp` automatically, but that only stops it from crashing —
it does not make anything durable. Two consequences:

- **Accounts and games need Supabase.** With the JSON store on Vercel, a signup
  is written to `/tmp` and gone by the next request. `GET /api/status` returns a
  warning saying exactly this when it detects the combination.
- **Attachments do not survive.** Uploaded images and files land in `/tmp`, so a
  reference image may be gone before the generation that uses it. Fine for a
  single request; not durable. Moving them to Supabase Storage is the fix, and
  it is not built yet.

### After deploying

```bash
curl -s https://<your-app>/api/status | jq
```

Check `storage` is `"supabase"`, `mode` is `"ai"`, and `warnings` is empty.

---

## A long-running host (recommended)

Render, Railway, Fly and a plain VPS all run `npm start`, which means:

- the filesystem persists, so the JSON store and local attachments work
- storage is initialised once at boot rather than on the first request
- no cold starts between generations

Same environment variables, minus the serverless caveats. Supabase is still the
better choice for storage once you have more than one instance.

```bash
npm install
npm start          # binds PORT, defaults to 3000
```

---

## Verifying a deployment

Run these against the deployed environment before trusting it:

```bash
npm run db:check           # storage connects and round-trips
npm run db:persist-check   # an account survives a restart
npm run llm:check          # the model key works, end to end
```

And locally, before pushing:

```bash
npm run check              # static rules
npm test                   # 67 checks: API, provider, store, serverless
```

`npm run test:serverless` is the one that would have caught the original
"deployed and every API call 404s" failure: it loads `api/index.js` the way the
platform does, with no `start()` call and a read-only project directory.

---

## Scaling past one instance

Each instance caches every document in memory and refreshes on write. That is
fine for one process and wrong for several — two instances will not see each
other's writes until they restart. Before running a fleet, make the read paths
query Postgres directly instead of the cache.
