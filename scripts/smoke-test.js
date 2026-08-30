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
  let guestToken = null;
  let guestGameId = null;

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
    assert.ok(html.includes('phaser@3.60.0'), 'Phaser CDN is not pinned');
    assert.ok(html.includes('meamus kit - shared runtime'), 'the shared kit was not inlined');
    assert.ok(html.includes('MEAMUS.gfx'), 'the kit body is incomplete');
  });

  await check('generation still requires a session token', async () => {
    const { status } = await request('/api/generate', { method: 'POST', body: { prompt: 'a space shooter' } });
    assert.strictEqual(status, 401);
  });

  await check('test mode mints a guest session with no signup', async () => {
    const { status, body } = await request('/api/auth/guest', { method: 'POST' });
    assert.strictEqual(status, 201);
    assert.ok(body.token);
    assert.strictEqual(body.user.isGuest, true);
    assert.strictEqual(body.user.plan, 'guest');
    assert.ok(body.user.quota >= 1, 'a guest needs a usable quota');
    guestToken = body.token;
  });

  await check('a guest can generate and play without an account', async () => {
    const gen = await request('/api/generate', {
      method: 'POST', token: guestToken, body: { prompt: 'a fast arcade space shooter' }
    });
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    assert.ok(gen.body.spec.gameCode.javascript.length > 1000);
    guestGameId = gen.body.game.id;

    const play = await request(`/play/${guestGameId}?token=${guestToken}`, { raw: true });
    assert.strictEqual(play.status, 200);
    const html = await play.text();
    assert.ok(html.includes('game-container'), 'the guest game did not render');
  });

  await check('a guest can export HTML but not an APK', async () => {
    const html = await request(`/api/games/${guestGameId}/export/html`, { token: guestToken, raw: true });
    assert.strictEqual(html.status, 200);

    const apk = await request(`/api/games/${guestGameId}/export/apk`, { token: guestToken });
    assert.strictEqual(apk.status, 402);
    assert.strictEqual(apk.body.code, 'signup_required');

    const upgrade = await request('/api/billing/checkout', { method: 'POST', token: guestToken, body: { plan: 'pro' } });
    assert.strictEqual(upgrade.status, 402, 'a throwaway guest must not be able to buy a plan');
  });

  await check('registering from a guest session keeps that session\'s games', async () => {
    const { status, body } = await request('/api/auth/register', {
      method: 'POST', token: guestToken,
      body: { email: 'upgraded@meamus.test', password: 'supersecret123', name: 'Upgraded' }
    });
    assert.strictEqual(status, 201, JSON.stringify(body));
    assert.strictEqual(body.upgradedFromGuest, true);
    assert.strictEqual(body.user.isGuest, false);
    assert.strictEqual(body.user.plan, 'free');

    const games = await request('/api/games', { token: body.token });
    assert.ok(games.body.games.some((g) => g.id === guestGameId),
      'the game made as a guest did not survive the upgrade');
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

  await check('guest sessions are refused when test mode is off', async () => {
    // The route reads config at call time, so flipping the flag is enough.
    const config = require('../server/config');
    const previous = config.testMode;
    config.testMode = false;
    try {
      const { status, body } = await request('/api/auth/guest', { method: 'POST' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.code, 'guest_disabled');
    } finally {
      config.testMode = previous;
    }
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

  await check('the daily quota is enforced', async () => {
    const quotaUser = await request('/api/auth/register', {
      method: 'POST', body: { email: 'quota@meamus.test', password: 'supersecret123' }
    });
    const t = quotaUser.body.token;
    const limit = quotaUser.body.user.quota;
    for (let i = 0; i < limit; i += 1) {
      const r = await request('/api/generate', { method: 'POST', token: t, body: { prompt: 'a platformer with gems' } });
      assert.strictEqual(r.status, 201, `generation ${i + 1} failed`);
    }
    const over = await request('/api/generate', { method: 'POST', token: t, body: { prompt: 'a platformer with gems' } });
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.body.code, 'quota_exceeded');
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
