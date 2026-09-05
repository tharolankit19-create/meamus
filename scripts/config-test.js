#!/usr/bin/env node
'use strict';

/**
 * Config tests.
 *
 * These exist because of a production outage: RATE_LIMIT_MAX was present but
 * empty, Number('') is 0, Number.isFinite(0) is true, and the limiter happily
 * configured itself to reject every request. The site answered 429 to
 * everything, including its own /api/status, so the UI just said it could not
 * reach the API.
 *
 * An env var that exists but is empty means "not set". Every numeric setting
 * has to honour that, and anything meaningless at zero has to refuse zero.
 */

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

/** Load config fresh with a given environment. */
function loadConfig(env) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key];
  }
  const saved = { ...process.env };
  // A blank .env-derived value must not leak between cases.
  for (const key of Object.keys(env)) process.env[key] = env[key];
  try {
    return require('../server/config');
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

console.log('\nmeamus config test\n');

check('an empty RATE_LIMIT_MAX falls back instead of blocking everything', () => {
  const config = loadConfig({ RATE_LIMIT_MAX: '' });
  assert.strictEqual(config.rateLimit.max, 60,
    'this is the production bug: an empty value became 0 and 429d every request');
});

check('an empty JWT_TTL_HOURS falls back instead of expiring every token', () => {
  assert.strictEqual(loadConfig({ JWT_TTL_HOURS: '' }).auth.ttlHours, 168);
});

check('empty quotas fall back instead of forbidding all generation', () => {
  const config = loadConfig({
    GUEST_DAILY_GENERATIONS: '', FREE_DAILY_GENERATIONS: '', PRO_DAILY_GENERATIONS: ''
  });
  assert.strictEqual(config.quotas.guest, 20);
  assert.strictEqual(config.quotas.free, 5);
  assert.strictEqual(config.quotas.pro, 200);
});

check('generation is unlimited unless explicitly switched off', () => {
  assert.strictEqual(loadConfig({}).quotas.unlimited, true);
  assert.strictEqual(loadConfig({ UNLIMITED_GENERATIONS: 'false' }).quotas.unlimited, false);
  // Anything that is not the literal "false" leaves it open, including blank.
  assert.strictEqual(loadConfig({ UNLIMITED_GENERATIONS: '' }).quotas.unlimited, true);
});

check('the access model is automatic unless it is forced', () => {
  const config = loadConfig({});
  assert.strictEqual(config.openAccessSetting, null, 'the default should resolve at runtime');
  assert.strictEqual(config.templateAccessSetting, null);
  assert.strictEqual(config.quotas.unlimited, true, 'members should have no cap');
  assert.strictEqual(loadConfig({ OPEN_ACCESS: 'true' }).openAccessSetting, true);
  assert.strictEqual(loadConfig({ OPEN_ACCESS: 'false' }).openAccessSetting, false);
  assert.strictEqual(loadConfig({ TEMPLATE_ACCESS: 'open' }).templateAccessSetting, 'open');
});

check('durable storage means an account is required', () => {
  loadConfig({});
  const db = require('../server/db');
  const access = require('../server/access');
  const original = Object.getOwnPropertyDescriptor(db, 'durable');
  Object.defineProperty(db, 'durable', { value: true, configurable: true });
  try {
    assert.strictEqual(access.openAccess(), false, 'login should be required when accounts work');
    assert.strictEqual(access.templateAccess(), 'gated');
    assert.strictEqual(access.accountsAvailable(), true);
  } finally {
    if (original) Object.defineProperty(db, 'durable', original); else delete db.durable;
  }
});

check('no durable storage reports itself unconfigured rather than opening up', () => {
  // This used to open the anonymous path so the site was not dead. That turned
  // out worse than dead: a sign-up dialog offering free credits that errored on
  // submit, and a model key anyone could spend. It now says what is missing.
  loadConfig({});
  const db = require('../server/db');
  const access = require('../server/access');
  const original = Object.getOwnPropertyDescriptor(db, 'durable');
  Object.defineProperty(db, 'durable', { value: false, configurable: true });
  try {
    assert.strictEqual(access.openAccess(), false, 'an unconfigured deployment opened itself up');
    assert.strictEqual(access.templateAccess(), 'gated');
    assert.strictEqual(access.accountsAvailable(), false);

    const described = access.describe();
    assert.strictEqual(described.setupRequired, true, 'the deployment does not admit it is unconfigured');
    const keys = described.setupMissing.map((m) => m.key);
    assert.ok(keys.includes('SUPABASE_URL'), 'the fix is not named');
    assert.ok(keys.includes('SUPABASE_SERVICE_ROLE_KEY'));
  } finally {
    if (original) Object.defineProperty(db, 'durable', original); else delete db.durable;
  }
});

check('an explicit OPEN_ACCESS beats the automatic choice', () => {
  loadConfig({ OPEN_ACCESS: 'false' });
  const db = require('../server/db');
  const access = require('../server/access');
  const original = Object.getOwnPropertyDescriptor(db, 'durable');
  Object.defineProperty(db, 'durable', { value: false, configurable: true });
  try {
    assert.strictEqual(access.openAccess(), false, 'an explicit setting must win');
    assert.strictEqual(access.describe().auto, false);
  } finally {
    if (original) Object.defineProperty(db, 'durable', original); else delete db.durable;
  }
});

check('an empty LLM_MAX_TOKENS falls back instead of truncating to nothing', () => {
  assert.strictEqual(loadConfig({ LLM_MAX_TOKENS: '', OPENROUTER_API_KEY: 'k' }).llm.maxTokens, 32000);
});

check('an empty LLM_TEMPERATURE falls back rather than becoming 0', () => {
  assert.strictEqual(loadConfig({ LLM_TEMPERATURE: '', OPENROUTER_API_KEY: 'k' }).llm.temperature, 0.6);
});

check('whitespace is treated the same as empty', () => {
  assert.strictEqual(loadConfig({ RATE_LIMIT_MAX: '   ' }).rateLimit.max, 60);
});

check('a real value is still honoured', () => {
  assert.strictEqual(loadConfig({ RATE_LIMIT_MAX: '120' }).rateLimit.max, 120);
  assert.strictEqual(loadConfig({ FREE_DAILY_GENERATIONS: '3' }).quotas.free, 3);
});

check('garbage falls back', () => {
  assert.strictEqual(loadConfig({ RATE_LIMIT_MAX: 'lots' }).rateLimit.max, 60);
});

check('an explicit zero is refused and reported, not silently obeyed', () => {
  const config = loadConfig({ RATE_LIMIT_MAX: '0' });
  assert.strictEqual(config.rateLimit.max, 60, 'a limit of 0 would block every request');
  assert.ok(config.problems.some((p) => p.includes('RATE_LIMIT_MAX')),
    `the correction was not reported: ${JSON.stringify(config.problems)}`);
});

check('a negative value is refused and reported', () => {
  const config = loadConfig({ PRO_DAILY_GENERATIONS: '-5' });
  assert.strictEqual(config.quotas.pro, 200);
  assert.ok(config.problems.some((p) => p.includes('PRO_DAILY_GENERATIONS')));
});

check('a healthy config reports no problems', () => {
  assert.deepStrictEqual(loadConfig({ RATE_LIMIT_MAX: '90' }).problems, []);
});

check('empty string settings are treated as unset, not as a value', () => {
  // SHOWCASE_TEMPLATE and DATA_DIR read with || and truthiness; confirm those
  // stay correct too, since the same class of mistake applies.
  const config = loadConfig({ SHOWCASE_TEMPLATE: '' });
  assert.strictEqual(config.showcaseTemplate, 'space-shooter');
});

check('a free model gets the crew, which is where every repair lives', () => {
  /* The carve-out that cost a real production build: `:free` models took the
     single-call path, which asks three times and gives up, while every repair
     worth having - recognising a cut-off file, shrinking the target, the
     loader correction, booting each scene - lives in the crew. Three attempts,
     all cut off at line 129, each told to check its punctuation. */
  const free = loadConfig({ OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'vendor/model:free' });
  assert.strictEqual(free.build.crew, true, 'a free model was sent down the path with no repairs');

  const paid = loadConfig({ OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'vendor/model' });
  assert.strictEqual(paid.build.crew, true);

  // And an operator can still turn it off.
  assert.strictEqual(
    loadConfig({ OPENROUTER_API_KEY: 'k', AGENT_CREW: 'false' }).build.crew, false,
    'AGENT_CREW=false must still force the single-call path'
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
