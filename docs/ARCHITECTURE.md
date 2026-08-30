# Architecture

## The pipeline

```
POST /api/uploads   images + text files → services/uploads.js → data/uploads/
       │            (base64 data URLs in the JSON body: no multipart parser)
       ▼
POST /api/generate
       │
       ├─ middleware: optionalAuth → rateLimit → requireAuth → enforceQuota
       │
       ├─ uploads.resolve(ids)   images → base64 blocks, text → prompt context
       │
       ├─ services/generator.js
       │     ├─ analysePrompt()      difficulty, visual style, control emphasis
       │     │
       │     ├─ AI path (key present)
       │     │     services/llm.js
       │     │        ├─ capabilities()     reads OpenRouter's catalogue once:
       │     │        │                     can this model see images? honour a schema?
       │     │        ├─ buildUserMessage() images as native parts only if readable,
       │     │        │                     otherwise named in the text + reported
       │     │        └─ complete()         POST /chat/completions with the GameSpec
       │     │                              JSON Schema in response_format
       │     │     services/validator.js
       │     │        ├─ extractJson()   balanced-brace scan, tolerates fences/prose
       │     │        └─ normaliseSpec() fills defaults, clamps enums, rejects eval
       │     │
       │     └─ Template path (no key, or the AI call failed)
       │           services/templates.js rank() → keyword scoring over 4 templates
       │           deep-clone the winner, retitle and restyle from the prompt
       │
       ├─ db.insert('games', …) with a seeded chat thread + recordUsage(user)
       └─ 201 { game, spec, meta, messages, quota }

POST /api/games/:id/modify   the same path, plus the current spec, appending
                             both turns to the thread and pushing the old spec
                             onto a 10-deep version history

GET /play/:id  →  services/bundler.js  →  one self-contained HTML document
GET …/export/apk → services/apk.js → services/zip.js → Cordova project zip
```

## Layout

```
server/
  config.js            .env parser + defaults; config.aiEnabled is the mode switch
  db.js                storage facade: picks a backend once at boot
  store/json.js        JSON file, atomic writes, in-memory cache (default)
  store/supabase.js    Postgres over PostgREST, same interface
  auth.js              scrypt hashing, HMAC-SHA256 tokens
  index.js             Express app, security headers, /play, static frontend
  prompts/system.md    the meamus system prompt, editable without touching code
  middleware/index.js  auth, quota, rate limit, error handler
  routes/              auth · templates · games · billing
  services/
    llm.js             provider layer: OpenRouter (default) or Anthropic,
                       capability detection, structured outputs
    schema.js          the GameSpec JSON Schema used for structured outputs
    uploads.js         attachment store: type + size validation, disk-backed
    validator.js       extractJson + normaliseSpec (the trust boundary)
    generator.js       AI path, template path, prompt analysis
    templates.js       loads templates/, ranks them against a prompt
    bundler.js         GameSpec → single-file HTML
    apk.js             GameSpec → Cordova project
    zip.js             minimal ZIP writer on node:zlib

templates/
  _shared/kit.js       the runtime every template game uses
  <id>/template.json   metadata: gameConfig, assets, controls, mechanics, hooks
  <id>/game.js         the Phaser code

public/
  index.html           shell; everything else is rendered by the router
  styles.css           the whole design system as custom properties
  js/app.js            hash router + boot
  js/api.js            state, fetch wrapper, session
  js/ui.js             el() builder, icon set, toasts, modals
  js/composer.js       the prompt control (attachments, drag-drop, paste)
  js/landing.js        signed-out marketing page
  js/dashboard.js      sidebar, project grid, templates, pricing
  js/workspace.js      chat thread + live preview + publish
  demos/               generated at install time
scripts/               build-demos · check · smoke-test
```

## Design decisions

**One runtime dependency.** Express, and nothing else. Auth is `node:crypto`,
the env parser is 15 lines, the ZIP writer is `node:zlib`, the Claude client is
`fetch`. A game generator whose install can break on a transitive dependency is
a bad trade.

**The model layer owns model facts.** Whether a model reads images or honours a
JSON schema is read from OpenRouter's catalogue at first use and cached, with a
static table as the offline fallback. Unknown models are assumed to do neither,
because guessing "yes" produces a hard 400 while guessing "no" only loses a
feature. Nothing above `services/llm.js` branches on the provider.

**Structured outputs over hope.** The default model has 3B active parameters;
asking it politely for JSON is not a plan. The GameSpec JSON Schema goes into
`response_format` when the model supports it, with one retry without it if the
deployment rejects the parameter, and `extractJson()` still standing behind
that for models that support neither.

**A guest is a real account.** Test mode mints an ordinary user record with
`isGuest: true` rather than adding an anonymous code path. Ownership, quotas,
exports and the chat thread all work unchanged, and registering while holding a
guest token upgrades that same record so the session's games survive. The only
guest-specific rules are two refusals: no APK export, no plan purchase.

**The validator is the trust boundary.** Everything downstream — bundler, APK
exporter, frontend — assumes a normalised spec. `normaliseSpec()` fills every
default, clamps every enum, and throws on `eval`/`new Function` or absent game
code. Model output is never used raw.

**Template mode is a real mode, not a stub.** It is what makes "everything works
except the key" true. It shares prompt analysis with the AI path and produces
the same spec shape, so every downstream feature is exercised on a fresh clone.

**Games are single files.** No bundler, no asset server, no build step. The only
external request is the pinned Phaser CDN. That is what makes the same artifact
work as a preview iframe, a download, and a Cordova `www/` payload.

**The shared kit is inlined, not linked.** Templates set `runtime.kit: true` and
the bundler pastes `_shared/kit.js` in ahead of the game. AI-generated games are
standalone by default, since the model is told to emit self-contained code.

**Storage is swappable.** `server/db.js` picks a backend from env and re-exports
it; both implement the same `all/find/filter/insert/update/remove/flush/ping`
surface. Nothing else in the codebase touches persistence, which is why moving
to Postgres is two environment variables rather than a refactor.

**One composer, three screens.** The landing hero, the dashboard box and the
workspace chat are the same `createComposer()` control with different padding
and callbacks. Attachment handling, autosize, drag-drop, paste and the upload
batching exist once.

**Attachments avoid multipart.** Files arrive as base64 data URLs inside the
normal JSON body, so there is no parser dependency and no temp-file dance. The
cost is a 33% size premium on the wire, which is why the body limit is 44 MB
for a 6 × 5 MB ceiling.

## Data shapes

**User** — `id`, `email`, `name`, `passwordHash` (null for a guest), `plan`
(`guest` | `free` | `pro`), `isGuest`, `usage: {date, count}`, timestamps.
Quotas reset by date string, so there is no cron to run.

**Game** — `id`, `userId`, `prompt`, `spec`, `meta`, `versions[]` (bounded to 10),
`messages[]` (bounded to 60), `isPublic`, timestamps.

**Message** — `id`, `role` (`user` | `assistant`), `text`, `createdAt`. User turns
carry `attachments[]`; assistant turns carry `title`, `kind` (`build` | `edit`)
and `mode`.

**Upload** — `id`, `userId`, `name`, `mime`, `kind` (`image` | `text`), `bytes`,
`file`. The bytes live on disk; only metadata is in the store.

**GameSpec** — the contract from the system prompt: `gameConfig`, `assets`,
`gameCode`, `controls`, `mechanics`, `monetizationHooks`, `mobileOptimizations`,
`apkReady`, plus a `runtime` block meamus adds (`kit`, `phaserVersion`, `source`).

## Security posture

- Passwords: scrypt with a per-user salt; comparison via `timingSafeEqual`.
- Tokens: HMAC-SHA256, signature-verified before the payload is parsed.
- Generated code: `eval` and `new Function` are rejected at validation;
  previews run in a sandboxed iframe.
- Headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  and `X-Frame-Options: SAMEORIGIN` everywhere except the play routes, which the
  app frames itself.
- Login does not distinguish an unknown email from a wrong password.

**The known gap:** `/play/*` is served from the same origin as the app, so a
generated game shares that origin. The validator blocks the obvious escapes, but
before opening generation to untrusted users, serve `/play/*` from a separate
domain.

## Testing

`npm run check` — static: syntax across every JS file, and the game rules
enforced per template (five scenes, three input methods, no `eval`, no
`setInterval` loops, no `alert`, score persistence, monetization hooks, no
external assets beyond Phaser).

`npm test` — two suites, 43 checks, no network required.

*API* (`scripts/smoke-test.js`, 35): boots the real server on an ephemeral port
with a throwaway data directory and walks guest session → generate → play →
guest export limits → guest-to-account upgrade → register → upload → generate
with attachments → chat thread → library → preview → exports → billing gate →
APK → quota → delete.

*Store* (`scripts/store-test.js`, 9): runs a stand-in PostgREST on localhost and
asserts the Supabase adapter's wire format — table names, both auth headers,
the `id=eq.` filter syntax, that a write survives a fresh hydrate, and that a
missing table fails loudly rather than reading as an empty database.

*Provider* (`scripts/provider-test.js`, 8): runs a stand-in OpenRouter on
localhost and asserts the exact wire format — endpoint, auth and attribution
headers, model id, system/user ordering, the structured-output schema, how a
text-only model is handed attachments, and that an unknown model falls back to
safe assumptions.

`npm run llm:check` — the only test that needs a real key. Prints the model's
detected capabilities, does a round trip, then generates a whole game through
the live pipeline and reports tokens and timing.

The four demo games were additionally driven in headless Chromium: each boots,
transitions scenes, and runs at 46–59 FPS under software rendering with no
console errors. The frontend was driven the same way across 17 flows — landing,
sign-up mid-prompt, workspace tabs, phone toggle, publish popover, attachment
upload and removal, dashboard, templates, pricing upgrade, and a 390px mobile
viewport with no horizontal overflow.
