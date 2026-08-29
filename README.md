# meamus

**Describe a game in a sentence. Get a complete, playable HTML5 game.**

meamus is a working SaaS: accounts, quotas, a prompt-to-game pipeline backed by
Claude, an in-browser preview, a library, HTML export, a paid tier, and an
Android (Cordova) export that builds without touching a line of code.

Every generated game is a single self-contained HTML file — Phaser 3 from a
pinned CDN, procedural sprites, synthesised audio, keyboard + mouse + touch
controls, a full menu → game → game-over loop, and ad hooks already wired in.

```
prompt ──▶ Claude ──▶ GameSpec JSON ──▶ validator ──▶ bundler ──▶ playable .html
                                                             └──▶ Cordova project (.zip)
```

---

## Quick start

```bash
git clone <this repo> && cd meamus
npm install          # installs express, then builds the demo games
cp .env.example .env # optional - the app runs fine without it
npm start            # http://localhost:3000
```

That is the whole setup. **The only thing left to add is your API key.**

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

Restart, and the badge in the header flips from `TEMPLATE MODE` to
`AI · claude-sonnet-5`. Nothing else changes — the accounts, quotas, library,
preview, exports and billing all work identically either way.

### Template mode (no key)

Without a key, `POST /api/generate` runs a deterministic generator: it scores
your prompt against the four bundled templates' keyword sets, picks the best
match, and retitles/reskins it from the prompt. Prompt analysis (difficulty,
visual style, control emphasis) applies in both modes. This exists so the
product is fully demoable and testable before the key is added — not as a
substitute for generation.

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
  `node:crypto` — no auth library)
- JSON document store with atomic writes (`server/db.js`; swap it for Postgres
  by reimplementing eight methods)
- Claude Messages API client over `fetch`, with a forgiving JSON extractor for
  fenced or prose-wrapped responses
- GameSpec validator that normalises every field and rejects `eval`/`new Function`
- Per-day generation quotas and a fixed-window rate limiter
- HTML bundler, and a ZIP writer built on `node:zlib` for the APK export

**Frontend** (`public/`) — vanilla ES modules, no build step.

Hash-routed SPA: prompt composer with progress, sandboxed preview iframe,
spec browser (code / assets / mechanics / shipping), library, template gallery,
pricing, and an iterate box that sends follow-up instructions to the model.

**Games** (`templates/`) — four complete games plus `_shared/kit.js`, the
runtime they all use: procedural texture bakery, Web Audio synth, virtual
joystick and buttons, reusable Boot/Preload scenes, ad hooks, safe localStorage.

---

## Commands

```bash
npm start           # run the server
npm run dev         # run with --watch
npm run build:demos # re-render public/demos/*.html from templates/
npm run check       # static checks: syntax, template rules, config surface
npm test            # end-to-end smoke test (24 checks, no network needed)
```

`npm run check` enforces the game rules on every template: five scenes, all
three input methods, no `eval`, no `setInterval` game loops, no `alert`, score
persistence, monetization hooks, and **no external asset beyond the pinned
Phaser CDN**.

---

## Configuration

Everything lives in `.env` (see `.env.example`). The values worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(empty)* | The one thing you add. Empty = template mode. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `ANTHROPIC_MAX_TOKENS` | `16000` | Raise it if generations come back truncated. |
| `JWT_SECRET` | *(random)* | Set it, or sessions reset on restart. |
| `FREE_DAILY_GENERATIONS` | `5` | |
| `PRO_DAILY_GENERATIONS` | `200` | |
| `BILLING_PROVIDER` | `stub` | `stub` upgrades instantly so the paid path is testable. |

---

## Documentation

- [docs/API.md](docs/API.md) — every endpoint, with request and response shapes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how a prompt becomes a game
- [docs/APK.md](docs/APK.md) — building and signing the Android export
- [docs/BILLING.md](docs/BILLING.md) — replacing stub billing with Stripe
- [docs/GAME_TEMPLATES.md](docs/GAME_TEMPLATES.md) — writing your own template

---

## Before you take this to production

The parts that are deliberately simple, and what to do about them:

1. **Storage is a JSON file.** Fine for a demo and a few hundred users; move to
   Postgres or SQLite before real traffic. Only `server/db.js` changes.
2. **Billing is a stub.** `BILLING_PROVIDER=stub` upgrades accounts with no
   payment. See `docs/BILLING.md` for the Stripe wiring.
3. **Generated code runs in the user's browser.** Previews are sandboxed
   iframes and the validator blocks `eval`, but generated JavaScript is still
   untrusted code. Serve `/play/*` from a separate origin before opening
   generation to the public.
4. **No email verification or password reset.** Both are account-lifecycle
   features this build does not have.
5. **APKs are not compiled here.** The export is a Cordova project that builds
   with two commands; compiling needs the Android SDK and your signing key,
   neither of which belongs on a web server.

---

## Licence

MIT.
