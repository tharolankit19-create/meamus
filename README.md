# meamus

**Describe a game in a sentence. Get a complete, playable HTML5 game.**

meamus is a working SaaS: accounts, quotas, a prompt-to-game pipeline backed by
Claude, a chat workspace with a live preview, image and file attachments, a
project library, HTML export, a paid tier, and an Android (Cordova) export that
builds without touching a line of code.

Every generated game is a single self-contained HTML file — Phaser 3 from a
pinned CDN, procedural sprites, synthesised audio, keyboard + mouse + touch
controls, a full menu → game → game-over loop, and ad hooks already wired in.

```
prompt + images/files ──▶ Claude ──▶ GameSpec JSON ──▶ validator ──▶ bundler ──▶ playable .html
        ▲                                                                  └──▶ Cordova project (.zip)
        └── chat: "make it harder", "add a boss" ── each turn rebuilds the game
```

## The interface

Three screens, white and orange, no dark mode:

- **Landing** — hero prompt box, a **live demo game playing itself** in a loop
  (the real game in an iframe, not a video — click it and you take over), and
  the template strip. In test mode there is no signup step at all.
- **Templates, Pricing, Docs** — real pages, reachable signed-out. The
  showcase game is playable by anyone; the rest of the library needs a free
  account.
- **Dashboard** — sidebar, greeting, the same prompt box, and a grid of your
  games. Every tile is a **live thumbnail**: the real game running in an iframe,
  not a screenshot.
- **Workspace** — chat thread on the left, the running game on the right.
  Each build appears as a card with Details and Preview. Keep talking to it:
  *"make it harder"*, *"add a boss every 5 waves"*, *"use this palette"* with an
  image attached. Tabs switch the right pane between the live game, its source,
  and the full spec. Publish gives you a share link, the standalone HTML, or the
  Android project.

### Design research

Every generation is grounded in real games. meamus maps the prompt to genres,
pulls matching titles from the [FreeToGame](https://www.freetogame.com)
catalogue, and puts their names, genres and one-line summaries into the model's
brief so it writes to genre conventions instead of inventing a category from
memory. The reference titles are shown in the spec pane of every build.

Being precise about what that is: FreeToGame returns **metadata and prose** —
not code, not physics constants, not assets. It makes the *design* more
specific; every line of the game is still written by the model. No key or
account is needed, and attribution is rendered in the footer as their terms
require. If the catalogue is slow or down, generation proceeds without it.

**Attachments** work everywhere the composer does — click `+`, drag files onto
the box, or paste a screenshot. Text files (md/txt/json/csv/js/html/css, 512 KB)
are folded into the prompt as design notes. Images (png/jpg/webp/gif, 5 MB) are
sent as native vision input **when the configured model can read them** — the
default Nemotron cannot, so their filenames go into the prompt and the response
says so plainly. Six files per message.

---

## Quick start

```bash
git clone <this repo> && cd meamus
npm install          # installs express, then builds the demo games
cp .env.example .env
npm start            # http://localhost:3000
```

**The only thing left to add is your OpenRouter key.**

```bash
# .env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=nvidia/nemotron-3.5-lightning   # already the default
```

Then verify it before touching the UI:

```bash
npm run llm:check
```

That prints the model's real capabilities, does a round trip, and generates a
whole game through the live pipeline. If the key or the model name is wrong it
fails there instead of halfway through a prompt.

Restart and the header badge flips from `TEMPLATE MODE` to
`AI · nvidia/nemotron-3.5-lightning`.

### Open access — no signup, no limits

By default a visitor opens the page, types a prompt, and plays the game. No
account, no dialog, no daily cap, and every template in the library is
playable. A guest session is minted silently and owns its games exactly like a
real account, so there is no second code path. Signing up later **upgrades that
guest in place** and the games made during the session come with it.

| Setting | Default | Turns off by |
|---|---|---|
| `OPEN_ACCESS` | `true` | `false` — puts the signup wall back |
| `TEMPLATE_ACCESS` | `open` | `gated` — library needs an account |
| `UNLIMITED_GENERATIONS` | `true` | `false` — enforces the per-plan quotas |

**With a model key set, unlimited access lets anyone on the internet spend your
API credits.** That is the trade for a fully open demo; set
`UNLIMITED_GENERATIONS=false` before this is public.

### Signup needs durable storage

Signup is **refused with a clear message** when the deployment cannot keep the
account — a serverless host with the local JSON store writes to `/tmp` and
discards it, so issuing a token would mean the user signs up and is then told
they never did. Building and playing still work; only persistence is off.
Setting `SUPABASE_URL` turns signup back on.

### The model

Default is **`nvidia/nemotron-3.5-lightning`** via OpenRouter:

| | |
|---|---|
| Context | 262,144 tokens |
| Max output | 131,072 tokens |
| Price | ~$0.08/M in · $0.20/M out |
| Images | **No** — text input only |
| Structured outputs | **Yes** |

Structured outputs matter here: it is a 3B-active MoE model, and pushing the
GameSpec JSON Schema into `response_format` is what keeps it emitting a spec
that parses on the first try instead of drifting. meamus detects this from
OpenRouter's catalogue at runtime and downgrades to prompt-only instructions
for models that do not support it.

Because the model is text-only, **image attachments cannot be read by it**.
meamus does not pretend otherwise: the filenames go into the prompt and the
response carries an explicit note saying the images informed the prompt only.
Point `OPENROUTER_MODEL` at a vision model and native image parts turn on
automatically. `nvidia/nemotron-3.5-lightning:free` also works (1M context,
64k output, no structured outputs, rate limited).

An `ANTHROPIC_API_KEY` still works if that is the key you have — whichever key
is present wins, OpenRouter first.

### Template mode (no key)

Without a key, `POST /api/generate` runs a deterministic generator: it scores
your prompt against the four bundled templates' keyword sets, picks the best
match, and retitles/reskins it from the prompt. Prompt analysis (difficulty,
visual style, control emphasis) applies in both modes. This exists so the
product is fully demoable and testable before the key is added — not as a
substitute for generation.

---

## Deploying

Two entry points from the same code: `server/index.js` for a long-running host
(Render, Railway, Fly, a VPS) and `api/index.js` for serverless (Vercel,
Netlify, Lambda). `vercel.json` is included.

On a serverless host the project directory is read-only and `/tmp` is discarded
between invocations. meamus moves its writable paths to `/tmp` automatically,
but **you must set `SUPABASE_URL` there or signup will silently fail** — the
account is written and then thrown away. `GET /api/status` warns when it detects
that combination.

Full walkthrough, including the exact environment variables:
[docs/DEPLOY.md](docs/DEPLOY.md).

---

## Storage — read this before deploying

The default backend writes to a JSON file under `server/data/`. On a serverless
or ephemeral host that filesystem is discarded on every restart, and the
symptom is **signup appearing to break**: accounts are created, then vanish.

Point meamus at Supabase Postgres instead:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor first, then
`npm run db:check` and `npm run db:persist-check` to confirm — the second boots
the server, signs up, discards the data directory, reboots, and proves the
account survived. Full walkthrough in
[docs/SUPABASE.md](docs/SUPABASE.md). The server prints a warning at boot if it
is storing to local disk in production.

---

## Not built yet

Named here so the gap is obvious rather than assumed:

- **Firecrawl** — genre grounding comes from FreeToGame; there is no crawler.
- **Component/UI libraries for generated games** — games use the bundled
  procedural kit only.
- **3D / WebGL beyond Phaser's renderer** — everything generated is 2D.
- **Managed hosting** — publishing means a share link on this server.
- **Supabase Auth / Storage / Realtime** — only Postgres is used. Accounts are
  handled in-process; attachments are written to local disk.

Each of these is an integration point, not a rewrite: research would slot in
front of `services/generator.js`.

---

## The four demo games

All four ship playable at `/templates` and as standalone files in
`public/demos/`. They are the reference implementation for their genre and the
match targets in template mode.

| Game | Genre | What it demonstrates |
|---|---|---|
| **Astro Salvage** | shooter | Object pooling, splitting asteroids, combo multipliers, timed power-ups, wave escalation, invulnerability windows |
| **Neon Dash** | endless runner | Double jump, timed slide, swipe detection, four-layer parallax, speed ramp with reactive obstacle spacing, one-hit shield |
| **Crystal Caves** | platformer | ASCII level maps, coyote time + jump buffering, one-way platforms, stomp combat, ledge-aware enemy AI, gated exit, persistent level unlocks |
| **Gem Cascade** | puzzle | 8×8 grid, run detection, cascade chains, deadlock reshuffle, idle hints, guaranteed-fair opening deal |

Each is ~550–750 lines, five scenes, under 60 KB bundled including the shared
runtime.

---

## What is actually built

**Backend** (`server/`) — Express, one runtime dependency.

- Email/password accounts (scrypt hashing, HMAC-SHA256 session tokens via
  `node:crypto` — no auth library), plus guest sessions that upgrade in place
- Attachment store with type and size validation; images become Claude vision
  blocks, text files become prompt context (no multipart parser needed)
- A chat thread per project, bounded at 60 turns, with a 10-deep version history
- JSON document store with atomic writes (`server/db.js`; swap it for Postgres
  by reimplementing eight methods)
- Provider layer over `fetch` (OpenRouter by default, Anthropic optional) that
  detects model capabilities from the catalogue and enforces the GameSpec JSON
  Schema where the model supports it
- A forgiving JSON extractor for fenced or prose-wrapped responses, for models
  that do not
- GameSpec validator that normalises every field and rejects `eval`/`new Function`
- Per-day generation quotas and a fixed-window rate limiter
- HTML bundler, and a ZIP writer built on `node:zlib` for the APK export

**Frontend** (`public/`) — vanilla ES modules, no build step, no framework.

`js/composer.js` is the one prompt control used by all three screens (upload
batching, drag-drop, paste, chips, autosize). `js/workspace.js` is the chat +
preview split view. `js/dashboard.js`, `js/landing.js` and `js/app.js` cover the
rest. The design system lives entirely in `styles.css` as custom properties —
change `--orange` and the whole product follows.

**Games** (`templates/`) — four complete games plus `_shared/kit.js`, the
runtime they all use: procedural texture bakery, Web Audio synth, virtual
joystick and buttons, reusable Boot/Preload scenes, ad hooks, safe localStorage.

---

## Commands

```bash
npm start             # run the server
npm run dev           # run with --watch
npm run llm:check     # verify the model key end to end (needs a key)
npm run db:check      # verify storage: connect, write, read, update, delete
npm run db:persist-check  # prove an account survives a restart (needs Supabase)
npm run build:demos   # re-render public/demos/*.html from templates/
npm run check         # static checks: syntax, template rules, config surface
npm test              # all six suites (96 checks, no network or keys needed)
npm run test:api      # API suite
npm run test:provider # OpenRouter wire-format suite
npm run test:store    # Supabase backend suite
npm run test:serverless   # loads api/index.js the way Vercel does
npm run test:config   # env-var parsing, where an empty value must not mean 0
npm run test:research # FreeToGame genre routing and graceful degradation
```

`npm run check` enforces the game rules on every template: five scenes, all
three input methods, no `eval`, no `setInterval` game loops, no `alert`, score
persistence, monetization hooks, and **no external asset beyond the pinned
Phaser CDN**. It parses the ES-module frontend and the CommonJS backend with
the right parser for each.

---

## Configuration

Everything lives in `.env` (see `.env.example`). The values worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | *(empty)* | The one thing you add. Empty = template mode. |
| `OPENROUTER_MODEL` | `nvidia/nemotron-3.5-lightning` | Any OpenRouter model id. |
| `LLM_MAX_TOKENS` | `32000` | Raise it if generations come back truncated. |
| `LLM_TEMPERATURE` | `0.6` | |
| `TEST_MODE` | `true` outside production | Generation without signup. |
| `SUPABASE_URL` | *(empty)* | Empty = JSON file on disk. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | `service_role`, never `anon`. |
| `SHOWCASE_TEMPLATE` | `space-shooter` | The one template playable signed-out. |
| `JWT_SECRET` | *(random)* | Set it, or sessions reset on restart. |
| `GUEST_DAILY_GENERATIONS` | `20` | |
| `FREE_DAILY_GENERATIONS` | `5` | |
| `PRO_DAILY_GENERATIONS` | `200` | |
| `BILLING_PROVIDER` | `stub` | `stub` upgrades instantly so the paid path is testable. |

---

## Documentation

- [docs/API.md](docs/API.md) — every endpoint, with request and response shapes
- [docs/DEPLOY.md](docs/DEPLOY.md) — Vercel and long-running hosts, with the env vars
- [docs/SUPABASE.md](docs/SUPABASE.md) — moving storage to Postgres
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how a prompt becomes a game
- [docs/APK.md](docs/APK.md) — building and signing the Android export
- [docs/BILLING.md](docs/BILLING.md) — replacing stub billing with Stripe
- [docs/GAME_TEMPLATES.md](docs/GAME_TEMPLATES.md) — writing your own template

---

## Before you take this to production

The parts that are deliberately simple, and what to do about them:

1. **Storage defaults to a JSON file.** Set `SUPABASE_URL` for Postgres. Even
   then, documents are cached in memory per instance, so two servers will not
   see each other's writes — fine for one instance, not for a fleet.
2. **Billing is a stub.** `BILLING_PROVIDER=stub` upgrades accounts with no
   payment. See `docs/BILLING.md` for the Stripe wiring.
3. **Generated code runs in the user's browser.** Previews are sandboxed
   iframes and the validator blocks `eval`, but generated JavaScript is still
   untrusted code. Serve `/play/*` from a separate origin before opening
   generation to the public.
4. **No email verification or password reset.** Both are account-lifecycle
   features this build does not have.
5. **Attachments are stored on local disk** under `server/data/uploads/` and
   never cleaned up. Move them to object storage and add a retention policy
   before real traffic.
6. **APKs are not compiled here.** The export is a Cordova project that builds
   with two commands; compiling needs the Android SDK and your signing key,
   neither of which belongs on a web server.

---

## Licence

MIT.
