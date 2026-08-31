#!/usr/bin/env node
'use strict';

/**
 * Serverless-mode test.
 *
 * Loads the app exactly the way Vercel does - `require('../api/index')`, with
 * no start() call, VERCEL set, and a read-only project directory - then walks
 * the paths that were 404ing in production. This is the suite that catches
 * "deployed and nothing works".
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VERCEL = '1';                 // what the platform sets
process.env.NODE_ENV = 'production';
process.env.TEST_MODE = 'true';
// Left unset on purpose: serverless with the JSON store has no durable
// storage, so the app should open access on its own. That is the behaviour
// under test.
process.env.JWT_SECRET = 'serverless-test-secret-0123456789';
// Production had these present but empty, which is what took the site down.
// Leaving them empty here proves the fallback holds under the real conditions.
process.env.RATE_LIMIT_MAX = '';
process.env.JWT_TTL_HOURS = '';
process.env.FREE_DAILY_GENERATIONS = '';
delete process.env.DATA_DIR;              // must fall back to /tmp on its own
// Blank rather than deleted: config.js reads .env and would refill a missing
// key. SERVERLESS_USE_SUPABASE=1 opts into a real database on purpose.
if (process.env.SERVERLESS_USE_SUPABASE !== '1') {
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
}

// The handler, required the way the platform requires it.
const handler = require('../api/index');
const config = require('../server/config');

let base = '';
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const req = (p, o = {}) => {
  const headers = {};
  if (o.body) headers['content-type'] = 'application/json';
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  return fetch(base + p, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined })
    .then(async (r) => (o.raw ? r : { status: r.status, body: await r.json().catch(() => null) }));
};

(async function run() {
  const server = handler.listen(0);       // the platform binds it for us
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nmeamus serverless test  (${base})\n`);

  await check('the handler is a usable Express app', () => {
    assert.strictEqual(typeof handler, 'function');
    assert.strictEqual(typeof handler.listen, 'function');
  });

  await check('empty env vars do not disable the app', () => {
    // The production outage: RATE_LIMIT_MAX was set but empty, Number('') is 0,
    // and the limiter rejected every request including /api/status.
    assert.strictEqual(config.rateLimit.max, 60, 'the rate limit collapsed to zero again');
    assert.strictEqual(config.auth.ttlHours, 168);
    assert.strictEqual(config.quotas.free, 5);
  });

  await check('repeated requests are not rate limited into a lockout', async () => {
    for (let i = 0; i < 12; i += 1) {
      const { status } = await req('/api/status');
      assert.strictEqual(status, 200, `request ${i + 1} returned ${status}`);
    }
    const res = await req('/api/status', { raw: true });
    assert.notStrictEqual(res.headers.get('x-ratelimit-limit'), '0',
      'the limit header is 0, which is the production failure');
  });

  await check('writable paths move to /tmp on their own', () => {
    assert.strictEqual(config.serverless, true, 'serverless was not detected');
    assert.ok(config.dataDir.startsWith(os.tmpdir()) || config.dataDir.startsWith('/tmp'),
      `dataDir is ${config.dataDir}, which is read-only on this platform`);
  });

  await check('GET /api/status answers (was 404 in production)', async () => {
    const { status, body } = await req('/api/status');
    assert.strictEqual(status, 200, `got ${status}`);
    assert.strictEqual(body.service, 'meamus');
    assert.strictEqual(body.serverless, true);
  });

  await check('storage reports itself, and warns when it cannot persist', async () => {
    const { body } = await req('/api/status');
    if (process.env.SERVERLESS_USE_SUPABASE === '1') {
      assert.strictEqual(body.storage, 'supabase', 'lazy init did not reach Postgres');
      assert.ok(!body.warnings.some((w) => /will not persist/i.test(w)),
        'warned about persistence while on Postgres');
    } else {
      assert.strictEqual(body.storage, 'json');
      assert.strictEqual(body.storageDurable, false, 'a /tmp store must not claim to be durable');
      assert.ok(body.warnings.some((w) => /SUPABASE_URL/.test(w)),
        `no persistence warning: ${JSON.stringify(body.warnings)}`);
      // The product used to open itself to everyone here. That produced a
      // sign-up form offering free credits that errored on submit, and left
      // the model key reachable without an account. It now reports itself as
      // unconfigured and shows the operator what to set.
      assert.strictEqual(body.openAccess, false, 'an unconfigured deployment opened itself up');
      assert.strictEqual(body.setupRequired, true, 'the deployment does not admit it is unconfigured');
      assert.strictEqual(body.accountsAvailable, false);
      // Gated, like everything else on an unconfigured deployment. Only the
      // showcase template stays public, because it is the landing demo.
      assert.strictEqual(body.templateAccess, 'gated');
    }
  });

  await check('GET /api/templates answers (was "could not load the demo games")', async () => {
    const { status, body } = await req('/api/templates');
    assert.strictEqual(status, 200, `got ${status}`);
    assert.strictEqual(body.templates.length, 4);
    assert.ok(body.templates.some((t) => t.showcase), 'no showcase template');
  });

  await check('the showcase template plays without an account', async () => {
    const res = await req(`/api/templates/${config.showcaseTemplate}/play?attract=1`, { raw: true });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('MEAMUS.boot'), 'the bundle has no game in it');
  });

  let token = null;
  await check('signup is refused rather than silently losing the account', async () => {
    // /tmp does not survive between invocations, so handing out a token here
    // is what produced "you never signed up" on the next request.
    const { status, body } = await req('/api/auth/register', {
      method: 'POST',
      body: { email: `sl-${Date.now()}@meamus.test`, password: 'supersecret123', name: 'Serverless' }
    });
    if (process.env.SERVERLESS_USE_SUPABASE === '1') {
      assert.strictEqual(status, 201, `durable storage should accept signup: ${JSON.stringify(body)}`);
      token = body.token;
    } else {
      assert.strictEqual(status, 503, `got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.code, 'storage_not_durable');
    }
  });

  await check('an unconfigured deployment hands out nothing, not everything', async () => {
    // The inverse of the old rule. When accounts cannot exist, the answer is
    // to say so - not to unlock the whole library to anyone who finds the URL.
    const list = await req('/api/templates');
    assert.strictEqual(list.body.gated, true, 'the library is open on an unconfigured deployment');
    assert.ok(list.body.templates.every((t) => !t.playable || t.showcase),
      'templates other than the showcase are playable without an account');
  });

  await check('a deployment with no accounts says so loudly', async () => {
    // With guest sessions gone, a non-durable deployment is genuinely unusable
    // rather than degraded. The status endpoint has to make that obvious, and
    // name the fix, or the operator sees a working-looking site nobody can use.
    const { body } = await req('/api/status');
    assert.strictEqual(body.storageDurable, false);
    const warnings = (body.warnings || []).join(' ');
    assert.match(warnings, /SUPABASE_URL/, 'the warnings never name the variable to set');
    assert.match(warnings, /SUPABASE_SERVICE_ROLE_KEY/);
  });

  await check('a misspelled variable is named, not silently ignored', async () => {
    const { audit, didYouMean } = require('../server/env-audit');

    // The one cause of "I set it and nothing happened" that no substring
    // search can find. SUPERBASE does not contain SUPABASE.
    for (const [typo, meant] of [
      ['SUPERBASE_URL', 'SUPABASE_URL'],
      ['SUPABSE_URL', 'SUPABASE_URL'],
      ['SUPERBASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
      ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
      ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
      ['JWT_SECRETT', 'JWT_SECRET']
    ]) {
      assert.strictEqual(didYouMean(typo), meant, `${typo} was not recognised as a typo`);
    }

    // A correct name is not a typo, and unrelated names are left alone.
    assert.strictEqual(didYouMean('SUPABASE_URL'), null);
    assert.strictEqual(didYouMean('MY_UNRELATED_THING'), null);

    const result = audit({ SUPERBASE_URL: 'https://x.example', SUPABASE_URL: '', PATH: '/usr/bin' });
    assert.deepStrictEqual(result.suspicious.map((x) => x.name), ['SUPERBASE_URL']);
    assert.ok(!result.seen.includes('SUPABASE_URL'), 'an empty variable must not count as set');
  });

  await check('an unconfigured deployment refuses to pretend', async () => {
    // It used to open the anonymous path instead, which produced a sign-up
    // dialog offering free credits that errored on submit.
    const { body } = await req('/api/status');
    assert.strictEqual(body.setupRequired, true, 'the deployment claims to be ready');
    assert.strictEqual(body.openAccess, false, 'an unconfigured deployment opened itself to everyone');
    const keys = (body.setupMissing || []).map((m) => m.key);
    assert.ok(keys.includes('SUPABASE_URL'), 'the fix is not named');
    assert.ok(keys.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(body.deployment, 'no deployment identity, so an operator cannot tell which one to fix');
    assert.ok(typeof body.deployment.envCount === 'number');
  });

  await check('registering is refused while the deployment is unconfigured', async () => {
    const { status, body } = await req('/api/auth/register', {
      method: 'POST',
      body: { email: `nope-${Date.now()}@example.com`, password: 'hunter2hunter2' }
    });
    assert.strictEqual(status, 503);
    assert.strictEqual(body.code, 'storage_not_durable');
  });

  await check('an unknown API route returns JSON, not a platform 404', async () => {
    const { status, body } = await req('/api/nope');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.code, 'not_found');
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nserverless test crashed:', err);
  process.exit(2);
});
