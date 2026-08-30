# meamus API

Base URL: `http://localhost:3000/api`

Authentication is a bearer token from `/auth/register` or `/auth/login`:

```
Authorization: Bearer <token>
```

Errors are always JSON: `{ "error": "human message", "code": "machine_code" }`.

| Code | Meaning |
|---|---|
| `unauthorized` | No or invalid token |
| `forbidden` | The resource belongs to another account |
| `quota_exceeded` | Daily generation limit reached |
| `rate_limited` | Too many requests in the window |
| `upgrade_required` | The Pro plan is needed (HTTP 402) |
| `not_found` | No such resource |

---

## Status

### `GET /status`

No auth. The operator's health check.

```json
{
  "service": "meamus",
  "version": "1.0.0",
  "aiEnabled": false,
  "mode": "template",
  "model": null,
  "templates": 4,
  "quotas": { "free": 5, "pro": 200 },
  "billingProvider": "stub",
  "warnings": ["ANTHROPIC_API_KEY is not set - generation runs in template mode."]
}
```

---

## Auth

### `POST /auth/register`

```json
{ "email": "you@studio.com", "password": "at least 8 chars", "name": "optional" }
```

`201` → `{ "token": "...", "user": { ... } }`.
`409` if the email is taken, `400` for a bad email or a weak password.

### `POST /auth/login`

Same body minus `name`. `401` on bad credentials — the message is identical for
an unknown email and a wrong password, so the endpoint cannot be used to
enumerate accounts.

### `GET /auth/me`

Returns the current user and `aiEnabled`. The user object never contains the
password hash.

```json
{
  "user": { "id": "usr_...", "email": "...", "name": "...", "plan": "free",
            "usage": 2, "quota": 5, "createdAt": "..." },
  "aiEnabled": true
}
```

### `PATCH /auth/me`

`{ "name": "New name" }`.

---

## Generation

### `POST /generate`

Auth required. Counts against the daily quota.

```json
{
  "prompt": "a space shooter where I tap to blast asteroids",
  "attachmentIds": ["upl_..."],
  "forceTemplate": false
}
```

`attachmentIds` come from `POST /uploads`. Images are sent to Claude as image
content blocks so the generated art direction matches them; text files are
folded into the prompt as context. Ids that do not exist, or belong to another
account, are dropped rather than failing the request. Template mode cannot read
attachments and reports that in `meta.issues` instead of ignoring them silently.

`201`:

```json
{
  "game": { "id": "gam_...", "title": "Astro Salvage", "genre": "shooter", "...": "..." },
  "spec": { "gameConfig": {}, "assets": {}, "gameCode": {}, "controls": {},
            "mechanics": [], "monetizationHooks": [], "mobileOptimizations": [],
            "apkReady": false, "runtime": { "kit": true, "phaserVersion": "3.60.0" } },
  "meta": { "mode": "ai", "model": "claude-sonnet-5", "usage": { "input_tokens": 0, "output_tokens": 0 },
            "durationMs": 41203, "issues": [] },
  "quota": { "used": 1, "limit": 5 }
}
```

`meta.mode` is `"ai"` or `"template"`. In template mode it also carries
`templateId`, `matchScore`, `matchedKeywords` and `alternatives`.

The response also carries `messages`: the project's chat thread, seeded with
the user's prompt and an assistant turn summarising the build.

`meta.issues` lists non-fatal problems found by the validator (missing touch
controls, an over-long file). The spec is still returned — these are warnings,
not rejections.

Errors: `400` prompt too short or too long, `429` quota exceeded, `422` the
model returned an unusable spec, `502`/`504` upstream failure. If the Claude
call fails, the request falls back to template mode and reports `meta.aiError`
rather than failing outright.

### `POST /games/:id/modify`

Auth required. Needs a Claude API key — template mode cannot rewrite code and
returns `503` saying so. Counts against the quota.

```json
{ "instruction": "add a boss fight every 5 waves", "attachmentIds": ["upl_..."] }
```

The previous version is pushed onto a bounded history (10 entries) and both
turns are appended to the chat thread, which is returned as `messages`.

### `POST /games/:id/revert`

Restores the most recent saved version. `400` if there is no history.

---

## Attachments

### `POST /uploads`

Auth required. Accepts one `{ name, dataUrl }` or `{ files: [...] }`, up to six
per request. `dataUrl` is a base64 data URL.

| Kind | Types | Limit |
|---|---|---|
| Image | png, jpeg, webp, gif | 5 MB each |
| Text | txt, md, csv, json, js, html, css | 512 KB each |

`201` → `{ "files": [{ "id", "name", "kind", "mime", "bytes", "url" }] }`.
`400` for an unsupported type or an oversized file.

### `GET /uploads/:id`

Serves the file back to its owner. `404` for anyone else — the same status as a
missing id, so the endpoint cannot be used to probe for other people's files.

---

## Library

| Endpoint | Description |
|---|---|
| `GET /games` | Your games, newest first. Summaries only — no game code. |
| `GET /games/:id` | One game with its full spec and chat thread. `403` if it is not yours. |
| `GET /games/:id/messages` | The chat thread on its own. |
| `PATCH /games/:id` | `{ "title": "...", "isPublic": true }` |
| `DELETE /games/:id` | Permanent. |

---

## Play

### `GET /play/:id`

Not under `/api`. Returns the complete playable HTML document.

Public games play for anyone. A private game needs the owner's token, either as
a bearer header or `?token=<token>` — the query form is what the preview iframe
uses.

---

## Export

### `GET /games/:id/export/html`

The standalone single-file game, as an attachment.

### `GET /games/:id/export/spec`

The GameSpec JSON.

### `GET /games/:id/export/apk`

**Pro plan only** — `402` with `code: "upgrade_required"` otherwise.

Returns a zip containing a ready-to-build Cordova project. Optional query
parameters: `packageId` (defaults to `com.meamus.<slug>`) and `orientation`
(defaults to `portrait` for puzzles, `landscape` otherwise). Setting the export
flips `spec.apkReady` to `true`. See [APK.md](APK.md).

---

## Templates

| Endpoint | Description |
|---|---|
| `GET /templates` | The bundled demo games with their mechanics and demo URLs. |
| `GET /templates/:id` | One template with its full spec. |
| `GET /templates/:id/play` | Playable HTML, served inline. |

No auth on any of these.

---

## Billing

| Endpoint | Description |
|---|---|
| `GET /billing/plans` | Plans, prices and features, plus the active provider. |
| `POST /billing/checkout` | `{ "plan": "pro" }`. Stub provider upgrades instantly and returns the updated user; Stripe would return `checkoutUrl`. |
| `POST /billing/downgrade` | Back to free. |
| `POST /billing/webhook` | Stripe target. `501` until signature verification is implemented. |

---

## Limits

- Rate limit: 60 requests per minute per account or IP (`RATE_LIMIT_MAX`).
  Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
- Prompt length: 2000 characters.
- Attachments: 6 per message, 5 MB per image, 512 KB per text file.
- Request body: 44 MB (base64 attachments inflate by about a third).
- Chat thread: the most recent 60 turns per project.
- Version history: 10 entries per game.
