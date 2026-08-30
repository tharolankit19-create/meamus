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
  assert.deepStrictEqual(config.quotas, { guest: 20, free: 5, pro: 200 });
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
