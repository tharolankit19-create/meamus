# Architecture

## The pipeline

```
POST /api/generate
       │
       ├─ middleware: optionalAuth → rateLimit → requireAuth → enforceQuota
       │
       ├─ services/generator.js
       │     ├─ analysePrompt()      difficulty, visual style, control emphasis
       │     │
       │     ├─ AI path (key present)
       │     │     services/claude.js   → POST /v1/messages with prompts/system.md
       │     │     services/validator.js
       │     │        ├─ extractJson()   balanced-brace scan, tolerates fences/prose
       │     │        └─ normaliseSpec() fills defaults, clamps enums, rejects eval
       │     │
       │     └─ Template path (no key, or the AI call failed)
       │           services/templates.js rank() → keyword scoring over 4 templates
       │           deep-clone the winner, retitle and restyle from the prompt
       │
       ├─ db.insert('games', …) + recordUsage(user)
       └─ 201 { game, spec, meta, quota }

GET /play/:id  →  services/bundler.js  →  one self-contained HTML document
GET …/export/apk → services/apk.js → services/zip.js → Cordova project zip
```

## Layout

```
server/
  config.js            .env parser + defaults; config.aiEnabled is the mode switch
  db.js                JSON store, atomic writes, in-memory cache
  auth.js              scrypt hashing, HMAC-SHA256 tokens
  index.js             Express app, security headers, /play, static frontend
  prompts/system.md    the meamus system prompt, editable without touching code
  middleware/index.js  auth, quota, rate limit, error handler
  routes/              auth · templates · games · billing
  services/
    claude.js          Messages API over fetch
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

public/                index.html · styles.css · app.js · demos/ (generated)
scripts/               build-demos · check · smoke-test
```

## Design decisions

**One runtime dependency.** Express, and nothing else. Auth is `node:crypto`,
the env parser is 15 lines, the ZIP writer is `node:zlib`, the Claude client is
`fetch`. A game generator whose install can break on a transitive dependency is
a bad trade.

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

**Storage is swappable.** `server/db.js` exposes `all/find/filter/insert/update/
remove/flush`. Nothing else in the codebase touches persistence.

## Data shapes

**User** — `id`, `email`, `name`, `passwordHash`, `plan`, `usage: {date, count}`,
timestamps. Quotas reset by date string, so there is no cron to run.

**Game** — `id`, `userId`, `prompt`, `spec`, `meta`, `versions[]` (bounded to 10),
`isPublic`, timestamps.

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

`npm test` — end-to-end: boots the real server on an ephemeral port with a
throwaway data directory and walks register → generate → library → preview →
exports → billing gate → APK → quota → delete. 24 checks, no network required.

The four demo games were additionally driven in headless Chromium: each boots,
transitions scenes, and runs at 47–59 FPS under software rendering with no
console errors.
