#!/usr/bin/env node
'use strict';

/**
 * Research tests. Runs a stand-in FreeToGame so genre routing, the prompt
 * block and the failure paths are covered without hitting their servers.
 */

const assert = require('assert');
const http = require('http');

const CATALOGUE = {
  shooter: [
    { id: 1, title: 'Overwatch', genre: 'Shooter', developer: 'Blizzard', release_date: '2016-05-24',
      short_description: 'A hero-focused first-person team shooter. Six players a side, objective control points, ultimate abilities on a charge meter.',
      freetogame_profile_url: 'https://www.freetogame.com/overwatch' },
    { id: 2, title: 'Warframe', genre: 'Shooter', developer: 'Digital Extremes', release_date: '2013-03-25',
      short_description: 'A third-person co-op shooter with movement tech, warframe abilities and deep loot.',
      freetogame_profile_url: 'https://www.freetogame.com/warframe' }
  ],
  racing: [
    { id: 3, title: 'Trackmania', genre: 'Racing', developer: 'Ubisoft', release_date: '2020-07-01',
      short_description: 'Arcade racing built on time trials and community-made tracks.',
      freetogame_profile_url: 'https://www.freetogame.com/trackmania' }
  ]
};

let requests = 0;
const server = http.createServer((req, res) => {
  requests += 1;
  const url = new URL(req.url, 'http://x');
  const category = url.searchParams.get('category');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(CATALOGUE[category] || []));
});

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

(async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  // Point the module at the stand-in.
  const researchPath = require.resolve('../server/services/research');
  const source = require('fs').readFileSync(researchPath, 'utf8')
    .replace("const BASE = 'https://www.freetogame.com/api';", `const BASE = 'http://127.0.0.1:${port}/api';`);
  const Module = require('module');
  const research = new Module(researchPath, null);
  research._compile(source, researchPath);
  const api = research.exports;

  console.log(`\nmeamus research test  (stand-in FreeToGame on :${port})\n`);

  await check('a prompt maps to the right catalogue categories', () => {
    assert.deepStrictEqual(api.categoriesFor('a space shooter with asteroids'), ['shooter']);
    assert.deepStrictEqual(api.categoriesFor('a kart racing game'), ['racing']);
    assert.strictEqual(api.categoriesFor('quantum accounting ledger').length, 0);
  });

  await check('a multi-word genre outweighs a stray token', () => {
    // "battle royale" as a phrase must beat an incidental "card" or "race".
    const cats = api.categoriesFor('a battle royale where you race to the centre');
    assert.strictEqual(cats[0], 'battle-royale', `got ${cats.join(',')}`);
  });

  await check('references come back for a matched genre', async () => {
    const res = await api.referencesFor('a first person shooter');
    assert.strictEqual(res.used, true);
    assert.ok(res.references.length >= 2);
    assert.strictEqual(res.references[0].title, 'Overwatch');
    assert.ok(res.references[0].summary.includes('hero-focused'));
  });

  await check('an unmatched prompt degrades to no research, not an error', async () => {
    const res = await api.referencesFor('quantum accounting ledger');
    assert.strictEqual(res.used, false);
    assert.deepStrictEqual(res.references, []);
    assert.ok(res.note);
  });

  await check('results are cached rather than re-fetched', async () => {
    api.clearCache();
    requests = 0;
    await api.referencesFor('a shooter');
    const first = requests;
    await api.referencesFor('a shooter');
    assert.strictEqual(requests, first, `re-fetched: ${first} -> ${requests}`);
  });

  await check('the prompt block names the games and forbids copying them', async () => {
    const res = await api.referencesFor('a team shooter');
    const block = api.toPromptBlock(res);
    assert.ok(block.includes('Overwatch'), 'reference titles missing');
    assert.ok(/do not copy their names/i.test(block), 'no anti-plagiarism instruction');
    assert.ok(/single-file Phaser 3/i.test(block), 'the output constraint was dropped');
  });

  await check('no research produces an empty block, not a stray heading', () => {
    assert.strictEqual(api.toPromptBlock({ used: false, references: [] }), '');
    assert.strictEqual(api.toPromptBlock(null), '');
  });

  await check('a dead catalogue does not fail the generation', async () => {
    api.clearCache();
    const realFetch = global.fetch;
    global.fetch = () => Promise.reject(new Error('network down'));
    try {
      const res = await api.referencesFor('a shooter');
      assert.strictEqual(res.used, false);
      assert.ok(res.error, 'the failure was not recorded');
    } finally {
      global.fetch = realFetch;
    }
  });

  await check('long descriptions are condensed on a sentence boundary', () => {
    const long = `${'First sentence here. '.repeat(30)}`;
    const out = api.condense(long, 200);
    assert.ok(out.length <= 210, `too long: ${out.length}`);
    assert.ok(out.endsWith('.') || out.endsWith('…'));
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('research test crashed:', err); process.exit(2); });
