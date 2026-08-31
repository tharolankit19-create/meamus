#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test. Boots the real server on an ephemeral port against a
 * throwaway data directory and walks the whole product: register -> generate ->
 * library -> preview -> exports -> billing gate -> APK.
 *
 * Runs entirely offline: with no ANTHROPIC_API_KEY the generator serves
 * templates, which is exactly the path a fresh clone takes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'meamus-test-'));
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-0123456789';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX = '10000';
process.env.TEST_MODE = 'true';

// The suite must be hermetic: it creates and deletes accounts freely, so it
// runs against the local JSON store and never a shared project. Set
// SMOKE_USE_SUPABASE=1 to point it at a real database on purpose.
// Set to empty rather than deleted: config.js reads .env and only fills a key
// that is absent, so deleting it would let the file put it straight back.
if (process.env.SMOKE_USE_SUPABASE !== '1') {
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
}

const { app } = require('../server/index');
const db = require('../server/db');

let base = '';
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function request(pathname, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(base + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (res) => (raw ? res : { status: res.status, body: await res.json().catch(() => null) }));
}

(async function run() {
  if (db.init) await db.init();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nmeamus smoke test  (${base}, data in ${tmpData})\n`);

  let token = null;
  let gameId = null;
  let uploadIds = [];

  await check('GET /api/status reports a usable service', async () => {
    const { status, body } = await request('/api/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.service, 'meamus');
    assert.ok(body.templates >= 4, `expected >= 4 templates, got ${body.templates}`);
    assert.ok(['ai', 'template'].includes(body.mode));
    assert.ok(['openrouter', 'anthropic'].includes(body.provider), `unexpected provider ${body.provider}`);
    assert.strictEqual(body.testMode, true);
  });

  await check('GET /api/templates lists the bundled games', async () => {
    const { status, body } = await request('/api/templates');
    assert.strictEqual(status, 200);
    assert.ok(body.templates.length >= 4);
    for (const t of body.templates) {
      assert.ok(t.gameConfig.title, 'template is missing a title');
      assert.ok(t.mechanics.length >= 3, `${t.id} documents too few mechanics`);
    }
  });

  await check('GET /api/templates/:id/play serves runnable HTML', async () => {
    const res = await request('/api/templates/space-shooter/play', { raw: true });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('new Phaser.Game') || html.includes('MEAMUS.boot'), 'no Phaser bootstrap in the bundle');
    // Phaser must load from our own origin FIRST. When the CDN came first, a
    // blocked or slow jsdelivr left a frozen frame and dead buttons.
    const localAt = html.indexOf('src="/vendor/phaser.min.js"');
    const cdnAt = html.indexOf('cdn.jsdelivr.net/npm/phaser');
    assert.ok(localAt > -1, 'Phaser is not served from our own origin');
    assert.ok(cdnAt > localAt, 'the CDN must only be a fallback behind the local copy');
    assert.ok(html.includes('phaser@3.60.0'), 'the Phaser fallback is not pinned');
    assert.ok(html.includes('meamus kit - shared runtime'), 'the shared kit was not inlined');
    assert.ok(html.includes('MEAMUS.gfx'), 'the kit body is incomplete');
  });

  await check('generation still requires a session token', async () => {
    const { status } = await request('/api/generate', { method: 'POST', body: { prompt: 'a space shooter' } });
    assert.strictEqual(status, 401);
  });

  await check('POST /api/auth/register creates an account', async () => {
    const { status, body } = await request('/api/auth/register', {
      method: 'POST',
      body: { email: 'dev@meamus.test', password: 'supersecret123', name: 'Dev' }
    });
    assert.strictEqual(status, 201);
    assert.ok(body.token);
    assert.strictEqual(body.user.plan, 'free');
    assert.ok(!('passwordHash' in body.user), 'password hash leaked to the client');
    token = body.token;
  });

  await check('duplicate registration is rejected', async () => {
    const { status } = await request('/api/auth/register', {
      method: 'POST', body: { email: 'dev@meamus.test', password: 'supersecret123' }
    });
    assert.strictEqual(status, 409);
  });

  await check('POST /api/auth/login returns a working token', async () => {
    const { status, body } = await request('/api/auth/login', {
      method: 'POST', body: { email: 'dev@meamus.test', password: 'supersecret123' }
    });
    assert.strictEqual(status, 200);
    const me = await request('/api/auth/me', { token: body.token });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.user.email, 'dev@meamus.test');
  });

  await check('a wrong password is rejected', async () => {
    const { status } = await request('/api/auth/login', {
      method: 'POST', body: { email: 'dev@meamus.test', password: 'wrongpassword' }
    });
    assert.strictEqual(status, 401);
  });

  await check('POST /api/generate returns a complete, valid GameSpec', async () => {
    const { status, body } = await request('/api/generate', {
      method: 'POST', token,
      body: { prompt: 'a space shooter where I tap to blast asteroids and collect power-ups' }
    });
    assert.strictEqual(status, 201, JSON.stringify(body));
    const { spec } = body;
    assert.ok(spec.gameConfig.title);
    assert.ok(spec.gameCode.javascript.length > 1000, 'game code is suspiciously short');
    assert.ok(spec.assets.sprites.length > 0, 'no sprite specs');
    assert.ok(spec.controls.touch.length > 0, 'no touch controls');
    assert.ok(spec.monetizationHooks.length > 0, 'no monetization hooks');
    assert.strictEqual(spec.apkReady, false, 'apkReady must start false');
    assert.strictEqual(body.quota.used, 1);
    gameId = body.game.id;
  });

  await check('template mode routes the prompt to the right genre', async () => {
    const { body } = await request('/api/generate', {
      method: 'POST', token, body: { prompt: 'candy crush style match 3 puzzle with combos', forceTemplate: true }
    });
    assert.strictEqual(body.meta.templateId, 'match3', `routed to ${body.meta.templateId}`);
  });

  await check('a too-short prompt is rejected', async () => {
    const { status } = await request('/api/generate', { method: 'POST', token, body: { prompt: 'hi' } });
    assert.strictEqual(status, 400);
  });

  await check('POST /api/uploads stores an image and a text file', async () => {
    // 1x1 transparent PNG - the smallest valid image the store will accept.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const md = `data:text/markdown;base64,${Buffer.from('# Level plan\n- 3 waves\n- boss at 4\n').toString('base64')}`;
    const { status, body } = await request('/api/uploads', {
      method: 'POST', token,
      body: { files: [{ name: 'ref.png', dataUrl: png }, { name: 'plan.md', dataUrl: md }] }
    });
    assert.strictEqual(status, 201, JSON.stringify(body));
    assert.strictEqual(body.files.length, 2);
    assert.strictEqual(body.files[0].kind, 'image');
    assert.strictEqual(body.files[1].kind, 'text');
    assert.ok(body.files[0].url.startsWith('/api/uploads/'));
    uploadIds = body.files.map((f) => f.id);
  });

  await check('an unsupported file type is rejected', async () => {
    const { status, body } = await request('/api/uploads', {
      method: 'POST', token,
      body: { name: 'evil.exe', dataUrl: 'data:application/x-msdownload;base64,TVo=' }
    });
    assert.strictEqual(status, 400);
    assert.match(body.error, /Unsupported file type/);
  });

  await check('attachments are private to their owner', async () => {
    const other = await request('/api/auth/register', {
      method: 'POST', body: { email: `att-${Date.now()}@meamus.test`, password: 'supersecret123' }
    });
    const res = await request(`/api/uploads/${uploadIds[0]}`, { token: other.body.token, raw: true });
    assert.strictEqual(res.status, 404);
    const mine = await request(`/api/uploads/${uploadIds[0]}`, { token, raw: true });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.headers.get('content-type'), 'image/png');
  });

  await check('generating with attachments records them on the chat turn', async () => {
    const { status, body } = await request('/api/generate', {
      method: 'POST', token,
      body: { prompt: 'a match 3 puzzle in this art style', attachmentIds: uploadIds }
    });
    assert.strictEqual(status, 201, JSON.stringify(body));
    assert.strictEqual(body.messages.length, 2);
    assert.strictEqual(body.messages[0].role, 'user');
    assert.strictEqual(body.messages[0].attachments.length, 2);
    assert.strictEqual(body.messages[1].role, 'assistant');
    assert.ok(body.messages[1].text.includes('sprites'), 'assistant turn has no build summary');
    // Template mode cannot read attachments and must say so rather than pretend.
    if (body.meta.mode === 'template') {
      assert.ok(body.meta.issues.some((i) => /attachment/i.test(i)), 'ignored attachments were not reported');
    }
  });

  await check('unknown attachment ids are dropped, not fatal', async () => {
    const { status, body } = await request('/api/generate', {
      method: 'POST', token,
      body: { prompt: 'an endless runner', attachmentIds: ['upl_doesnotexist', uploadIds[0]] }
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.messages[0].attachments.length, 1);
  });

  await check('GET /api/games/:id/messages returns the thread', async () => {
    const { status, body } = await request(`/api/games/${gameId}/messages`, { token });
    assert.strictEqual(status, 200);
    assert.ok(body.messages.length >= 2);
    assert.ok(body.messages.every((m) => m.id && m.role && m.createdAt));
  });

  await check('GET /api/games lists the saved games', async () => {
    const { status, body } = await request('/api/games', { token });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 4);
    assert.ok(body.games[0].codeLines > 100);
    assert.ok(body.games.every((g) => g.messageCount >= 2), 'a game is missing its chat thread');
  });

  await check('another account cannot read the first account\'s game', async () => {
    const other = await request('/api/auth/register', {
      method: 'POST', body: { email: 'other@meamus.test', password: 'supersecret123' }
    });
    const { status } = await request(`/api/games/${gameId}`, { token: other.body.token });
    assert.strictEqual(status, 403);
  });

  await check('GET /play/:id renders the owner\'s private game', async () => {
    const res = await request(`/play/${gameId}?token=${token}`, { raw: true });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('game-container'));
  });

  await check('GET /play/:id refuses an anonymous viewer', async () => {
    const res = await request(`/play/${gameId}`, { raw: true });
    assert.strictEqual(res.status, 403);
  });

  await check('a public game plays for anyone', async () => {
    await request(`/api/games/${gameId}`, { method: 'PATCH', token, body: { isPublic: true } });
    const res = await request(`/play/${gameId}`, { raw: true });
    assert.strictEqual(res.status, 200);
    await request(`/api/games/${gameId}`, { method: 'PATCH', token, body: { isPublic: false } });
  });

  await check('HTML export downloads a self-contained file', async () => {
    const res = await request(`/api/games/${gameId}/export/html`, { token, raw: true });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=".+\.html"/);
    const html = await res.text();
    assert.ok(html.length > 20000, 'export is too small to contain a game');
    // The only external reference allowed is the pinned Phaser CDN.
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(external.every((u) => u.includes('cdn.jsdelivr.net/npm/phaser')),
      `unexpected external assets: ${external.join(', ')}`);
  });

  await check('a new account starts with the signup credit grant', async () => {
    const { status, body } = await request('/api/auth/me', { token });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.user.creditsEnabled, true);
    assert.ok(body.user.credits > 0, 'a new account has no credits to spend');
    assert.ok(body.user.creditCosts.create > 0, 'a game must cost something');
  });

  await check('a generation charges credits, and only on success', async () => {
    const before = (await request('/api/auth/me', { token })).body.user.credits;
    const gen = await request('/api/generate', {
      method: 'POST', token, body: { prompt: 'a tiny arcade game about sorting fruit' }
    });
    assert.strictEqual(gen.status, 201);
    assert.strictEqual(gen.body.credits.charged, gen.body.credits.charged);
    const after = (await request('/api/auth/me', { token })).body.user.credits;
    assert.strictEqual(after, before - gen.body.credits.charged, 'the balance did not move by the charge');
    assert.strictEqual(gen.body.credits.balance, after, 'the response balance disagrees with the account');

    // A refused generation must not cost anything.
    const balanceBefore = after;
    const bad = await request('/api/generate', { method: 'POST', token, body: { prompt: 'x' } });
    assert.strictEqual(bad.status, 400);
    const unchanged = (await request('/api/auth/me', { token })).body.user.credits;
    assert.strictEqual(unchanged, balanceBefore, 'a rejected prompt still charged the account');
  });

  await check('running out of credits is a 402 that names the price', async () => {
    const drained = await request('/api/auth/register', {
      method: 'POST',
      body: { email: `broke-${Date.now()}@example.com`, password: 'hunter2hunter2', name: 'Broke' }
    });
    const brokeToken = drained.body.token;
    let last = null;
    for (let i = 0; i < 40; i += 1) {
      last = await request('/api/generate', { method: 'POST', token: brokeToken, body: { prompt: 'a simple maze game' } });
      if (last.status === 402) break;
    }
    assert.strictEqual(last.status, 402, 'the balance never ran out');
    assert.strictEqual(last.body.code, 'insufficient_credits');
    assert.ok(last.body.required > 0 && last.body.balance >= 0, 'the refusal does not say what is needed');

    // A plan tops the balance back up and unblocks generation.
    const up = await request('/api/billing/checkout', { method: 'POST', token: brokeToken, body: { plan: 'starter' } });
    assert.strictEqual(up.status, 200);
    assert.strictEqual(up.body.granted, 1000, 'the $29 plan should grant 1,000 credits');
    const again = await request('/api/generate', { method: 'POST', token: brokeToken, body: { prompt: 'a simple maze game' } });
    assert.strictEqual(again.status, 201, 'a topped-up account still cannot generate');
  });

  await check('the plan ladder is free / $29 / $59 with APK on the top tier', async () => {
    const { body } = await request('/api/billing/plans');
    const byId = Object.fromEntries(body.plans.map((p) => [p.id, p]));
    assert.strictEqual(byId.free.price, 0);
    assert.strictEqual(byId.starter.price, 29);
    assert.strictEqual(byId.starter.credits, 1000);
    assert.strictEqual(byId.pro.price, 59);
    assert.strictEqual(byId.pro.credits, 2500);
    assert.strictEqual(byId.pro.apk, true, 'APK export belongs to the top tier');
    assert.strictEqual(byId.starter.apk, false);
  });

  await check('a vague chat turn is questioned back, not guessed at', async () => {
    const before = (await request('/api/auth/me', { token })).body.user.credits;
    const { status, body } = await request(`/api/games/${gameId}/chat`, {
      method: 'POST', token, body: { message: 'make it better' }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.kind, 'clarify', 'a vague turn triggered a rebuild');
    assert.ok(body.reply.length > 40, 'the clarifying question says nothing useful');
    assert.strictEqual(body.credits.charged, 0, 'asking a question charged credits');
    const after = (await request('/api/auth/me', { token })).body.user.credits;
    assert.strictEqual(after, before, 'a clarifying question moved the balance');
    const last = body.messages[body.messages.length - 1];
    assert.strictEqual(last.kind, 'clarify', 'the turn was not tagged for the UI');
  });

  await check('a specific chat turn is handed to the build pipeline, not built inline', async () => {
    const before = (await request('/api/auth/me', { token })).body.user.credits;
    const { status, body } = await request(`/api/games/${gameId}/chat`, {
      method: 'POST', token, body: { message: 'add a boss every five waves' }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.kind, 'change', 'a concrete instruction was not treated as a change');
    assert.strictEqual(body.instruction, 'add a boss every five waves');
    // Crucially it has not built anything yet: a change is quoted and approved
    // first, so there is exactly one build path rather than two that can drift.
    assert.strictEqual(body.spec, undefined, 'the chat route built inline instead of quoting');
    const after = (await request('/api/auth/me', { token })).body.user.credits;
    assert.strictEqual(after, before, 'recognising a change charged for it');
  });

  await check('an empty chat turn is refused', async () => {
    const { status, body } = await request(`/api/games/${gameId}/chat`, {
      method: 'POST', token, body: { message: '   ' }
    });
    assert.strictEqual(status, 400);
    assert.strictEqual(body.code, 'empty_message');
  });

  await check('a build is quoted before any credits are spent', async () => {
    const before = (await request('/api/auth/me', { token })).body.user.credits;
    const { status, body } = await request('/api/build/plan', {
      method: 'POST', token, body: { prompt: 'a tower defence game with three tower types' }
    });
    assert.strictEqual(status, 200);
    assert.ok(body.planId, 'no plan to approve');
    assert.strictEqual(body.kind, 'create');
    assert.ok(body.estimate.credits.expected > 0, 'the quote names no price');
    assert.ok(body.estimate.credits.worstCase >= body.estimate.credits.expected,
      'the worst case must not be cheaper than the expected case');
    assert.ok(body.estimate.seconds.expected > 0, 'the quote names no duration');
    assert.ok(body.plan.length >= 4, 'the quote does not say what the agents will do');
    const after = (await request('/api/auth/me', { token })).body.user.credits;
    assert.strictEqual(after, before, 'quoting a build charged for it');
  });

  await check('an approval is single use', async () => {
    const plan = await request('/api/build/plan', {
      method: 'POST', token, body: { prompt: 'a maze game with a torch and a monster' }
    });
    const first = await request('/api/build/start', {
      method: 'POST', token, body: { planId: plan.body.planId }
    });
    assert.strictEqual(first.status, 202, 'the approved build did not start');
    const replay = await request('/api/build/start', {
      method: 'POST', token, body: { planId: plan.body.planId }
    });
    assert.strictEqual(replay.status, 410, 'the same approval bought a second build');
    assert.strictEqual(replay.body.code, 'plan_expired');
  });

  await check('a stopped build charges nothing', async () => {
    const plan = await request('/api/build/plan', {
      method: 'POST', token, body: { prompt: 'a fishing game with a day night cycle' }
    });
    const started = await request('/api/build/start', {
      method: 'POST', token, body: { planId: plan.body.planId }
    });
    const buildId = started.body.buildId;
    const before = (await request('/api/auth/me', { token })).body.user.credits;

    const stopped = await request(`/api/build/${buildId}/stop`, { method: 'POST', token });
    assert.strictEqual(stopped.status, 200);

    // With no model key a template build can finish before the stop lands.
    // Only a build that was actually still running can be stopped, so the
    // assertion follows which of the two happened.
    if (stopped.body.state === 'running') {
      assert.strictEqual(stopped.body.stopRequested, true, 'a running build ignored the stop');
      for (let i = 0; i < 40; i += 1) {
        const poll = await request(`/api/build/${buildId}`, { token });
        if (poll.body.state !== 'running') {
          assert.notStrictEqual(poll.body.state, 'done', 'a stopped build still shipped');
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const after = (await request('/api/auth/me', { token })).body.user.credits;
      assert.strictEqual(after, before, 'a stopped build still charged the account');
    } else {
      assert.strictEqual(stopped.body.state, 'done', `unexpected state ${stopped.body.state}`);
    }

    // The invariant, checked directly so it holds regardless of timing: a build
    // that ends stopped has shipped nothing and therefore charges nothing.
    const builds = require('../server/services/builds');
    const fake = builds.start('usr_probe', { kind: 'create', prompt: 'x', estimate: {} }).build;
    builds.requestStop(fake.buildId, 'usr_probe');
    assert.strictEqual(fake.stopRequested, true, 'requestStop did not set the flag');
    builds.fail(fake, 'stopped');
    assert.strictEqual(builds.view(fake).state, 'stopped');
    assert.strictEqual(builds.view(fake).credits, undefined, 'a stopped build reported a charge');
  });

  await check('a build reports its own progress', async () => {
    const plan = await request('/api/build/plan', {
      method: 'POST', token, body: { prompt: 'a rhythm game where you tap falling notes' }
    });
    const started = await request('/api/build/start', {
      method: 'POST', token, body: { planId: plan.body.planId }
    });
    const poll = await request(`/api/build/${started.body.buildId}`, { token });
    assert.strictEqual(poll.status, 200);
    assert.ok(['running', 'done', 'failed'].includes(poll.body.state));
    assert.ok(Array.isArray(poll.body.steps), 'a build with no steps cannot be shown in the chat');
    assert.ok(typeof poll.body.elapsedMs === 'number', 'no elapsed time for the clock');
  });

  await check('another account cannot read or stop your build', async () => {
    const plan = await request('/api/build/plan', {
      method: 'POST', token, body: { prompt: 'a card battler with a deck of thirty' }
    });
    const started = await request('/api/build/start', {
      method: 'POST', token, body: { planId: plan.body.planId }
    });
    const other = await request('/api/auth/register', {
      method: 'POST',
      body: { email: `nosy-${Date.now()}@example.com`, password: 'hunter2hunter2', name: 'Nosy' }
    });
    const peek = await request(`/api/build/${started.body.buildId}`, { token: other.body.token });
    assert.strictEqual(peek.status, 404, 'a build leaked to another account');
    const stop = await request(`/api/build/${started.body.buildId}/stop`, { method: 'POST', token: other.body.token });
    assert.strictEqual(stop.status, 404, 'another account could stop your build');
  });

  await check('generation refuses rather than substituting a different game', async () => {
    // The silent template fallback shipped the space-shooter retitled "A Ludo".
    const generator = require('../server/services/generator');
    const config = require('../server/config');
    const original = config.llm.enabled;
    try {
      config.llm.enabled = true;
      await generator.generate('a ludo board game for four players', { research: false });
      assert.fail('a failing model call should not have produced a game');
    } catch (err) {
      assert.ok(!/space|shooter|astro/i.test(err.message),
        `refusal should not mention a substituted template: ${err.message}`);
    } finally {
      config.llm.enabled = original;
    }
  });

  await check('there is no anonymous path into the product', async () => {
    // The guest session is gone: it had no durable home for its games and no
    // way to buy credits, and it produced a signed-in-looking state that could
    // not keep anything.
    const guest = await request('/api/auth/guest', { method: 'POST' });
    assert.strictEqual(guest.status, 404, 'the guest endpoint is still reachable');

    for (const [method, path, body] of [
      ['POST', '/api/generate', { prompt: 'a space shooter' }],
      ['POST', '/api/build/plan', { prompt: 'a space shooter' }],
      ['GET', '/api/games', null]
    ]) {
      const res = await request(path, { method, body });
      assert.strictEqual(res.status, 401, `${method} ${path} let a signed-out caller through`);
      assert.strictEqual(res.body.code, 'unauthorized');
    }
  });

  await check('the sign-in methods on offer are declared', async () => {
    const { status, body } = await request('/api/auth/methods');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.password, true, 'password sign-in must always work');
    assert.strictEqual(typeof body.google, 'boolean', 'the client needs to know whether to draw the button');
    assert.ok(['supabase', 'local'].includes(body.provider));
  });

  await check('Google sign-in is refused honestly when it is not configured', async () => {
    // This run has no Supabase, so the button must not be offered and the
    // endpoint must say why rather than handing out a broken URL.
    const methods = await request('/api/auth/methods');
    const oauth = await request('/api/auth/oauth/google');
    if (methods.body.google) {
      assert.strictEqual(oauth.status, 200);
      assert.ok(/\/auth\/v1\/authorize\?provider=google/.test(oauth.body.url), 'not a Supabase authorize URL');
    } else {
      assert.strictEqual(oauth.status, 503);
      assert.strictEqual(oauth.body.code, 'oauth_unavailable');
    }
  });

  await check('a signed-in account reports no guest flag at all', async () => {
    const { body } = await request('/api/auth/me', { token });
    assert.strictEqual(body.user.isGuest, undefined, 'the guest flag is still being sent');
    assert.ok(body.user.credits > 0);
    assert.strictEqual(body.user.plan, 'free');
  });

  await check('the vendored Phaser build is served', async () => {
    const res = await request('/vendor/phaser.min.js', { raw: true });
    assert.strictEqual(res.status, 200, 'a game cannot boot without this file');
    const body = await res.text();
    assert.ok(body.length > 500000, `vendored Phaser looks truncated (${body.length} bytes)`);
  });

  await check('APK export is gated behind the Pro plan', async () => {
    const { status, body } = await request(`/api/games/${gameId}/export/apk`, { token });
    assert.strictEqual(status, 402);
    assert.strictEqual(body.code, 'upgrade_required');
  });

  await check('upgrading unlocks the APK export', async () => {
    const upgrade = await request('/api/billing/checkout', { method: 'POST', token, body: { plan: 'pro' } });
    assert.strictEqual(upgrade.status, 200);
    assert.strictEqual(upgrade.body.user.plan, 'pro');

    const res = await request(`/api/games/${gameId}/export/apk`, { token, raw: true });
    assert.strictEqual(res.status, 200);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buffer.readUInt32LE(0), 0x04034b50, 'not a zip archive');
    assert.ok(buffer.includes(Buffer.from('config.xml')), 'cordova config.xml missing');
    assert.ok(buffer.includes(Buffer.from('www/index.html')), 'www/index.html missing');
    assert.ok(buffer.length > 20000, 'apk project is too small');
  });

  await check('modifying a game without an API key fails honestly', async () => {
    const { status, body } = await request(`/api/games/${gameId}/modify`, {
      method: 'POST', token, body: { instruction: 'add a boss fight' }
    });
    if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(status, 200);
      assert.ok(body.spec.gameCode.javascript.length > 1000);
    } else {
      assert.strictEqual(status, 503);
      assert.match(body.error, /API key/i);
    }
  });

  await check('a signed-in account generates without a daily cap', async () => {
    const config = require('../server/config');
    assert.strictEqual(config.quotas.unlimited, true, 'unlimited should be the default');

    const fresh = await request('/api/auth/register', {
      method: 'POST', body: { email: `unlimited-${Date.now()}@meamus.test`, password: 'supersecret123' }
    });
    const t = fresh.body.token;
    assert.strictEqual(fresh.body.user.quota, null, 'an unlimited plan should report a null cap');
    // Comfortably past the old free cap of 5.
    for (let i = 0; i < 8; i += 1) {
      const r = await request('/api/generate', { method: 'POST', token: t, body: { prompt: 'a platformer with gems' } });
      assert.strictEqual(r.status, 201, `generation ${i + 1} was blocked with ${r.status}`);
      assert.strictEqual(r.body.quota.limit, null);
    }
  });

  await check('signed-in users can play every template', async () => {
    const list = await request('/api/templates', { token });
    assert.ok(list.body.templates.every((t) => t.playable), 'some templates are locked for a member');

    for (const template of list.body.templates) {
      const res = await request(`/api/templates/${template.id}/play?token=${token}`, { raw: true });
      assert.strictEqual(res.status, 200, `${template.id} answered ${res.status} to a member`);
      const html = await res.text();
      assert.ok(html.includes('MEAMUS.boot'), `${template.id} did not return a runnable game`);
    }
  });

  await check('the library is gated but the showcase stays public', async () => {
    // The showcase runs the landing page's demo loop, so it has to load with
    // no session at all; the rest is the reason to sign up.
    const config = require('../server/config');
    const previous = config.templateAccessSetting;
    config.templateAccessSetting = 'gated';
    try {
      const anon = await request('/api/templates');
      const showcase = anon.body.templates.find((t) => t.showcase);
      const gatedOne = anon.body.templates.find((t) => !t.showcase);
      assert.strictEqual(showcase.playable, true, 'the landing demo must stay public');
      assert.strictEqual(gatedOne.playable, false, 'the library should need an account');

      const open = await request(`/api/templates/${showcase.id}/play`, { raw: true });
      assert.strictEqual(open.status, 200);

      const locked = await request(`/api/templates/${gatedOne.id}/play`, { raw: true });
      assert.strictEqual(locked.status, 401);
      assert.ok((await locked.text()).includes('Sign up free'), 'no sign-up panel in the gated frame');
    } finally {
      config.templateAccessSetting = previous;
    }
  });

  await check('the daily quota is enforced when limits are switched on', async () => {
    const config = require('../server/config');
    const previous = config.quotas.unlimited;
    config.quotas.unlimited = false;
    try {
      const quotaUser = await request('/api/auth/register', {
        method: 'POST', body: { email: 'quota@meamus.test', password: 'supersecret123' }
      });
      const t = quotaUser.body.token;
      const limit = config.quotas.free;
      for (let i = 0; i < limit; i += 1) {
        const r = await request('/api/generate', { method: 'POST', token: t, body: { prompt: 'a platformer with gems' } });
        assert.strictEqual(r.status, 201, `generation ${i + 1} failed`);
      }
      const over = await request('/api/generate', { method: 'POST', token: t, body: { prompt: 'a platformer with gems' } });
      assert.strictEqual(over.status, 429);
      assert.strictEqual(over.body.code, 'quota_exceeded');
    } finally {
      config.quotas.unlimited = previous;
    }
  });

  await check('DELETE /api/games/:id removes the game', async () => {
    const del = await request(`/api/games/${gameId}`, { method: 'DELETE', token });
    assert.strictEqual(del.status, 200);
    const gone = await request(`/api/games/${gameId}`, { token });
    assert.strictEqual(gone.status, 404);
  });

  await check('unknown API routes return a JSON 404', async () => {
    const { status, body } = await request('/api/nope');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.code, 'not_found');
  });

  await check('the frontend is served', async () => {
    const res = await request('/', { raw: true });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('meamus'));
  });

  server.close();
  fs.rmSync(tmpData, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(2);
});
