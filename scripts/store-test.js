#!/usr/bin/env node
'use strict';

/**
 * Supabase backend test. Runs a stand-in PostgREST on localhost and asserts the
 * exact wire format the adapter produces — table names, the apikey and bearer
 * headers, the id=eq. filter syntax, and that a write really lands before it is
 * read back through a fresh hydrate.
 */

const assert = require('assert');
const http = require('http');

const tables = { meamus_users: [], meamus_games: [], meamus_uploads: [], meamus_build_plans: [] };
const seen = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const table = url.pathname.replace('/rest/v1/', '');
    seen.push({ method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });

    if (!tables[table]) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ message: `relation "${table}" does not exist` }));
    }

    const idFilter = url.searchParams.get('id');
    const id = idFilter ? idFilter.replace('eq.', '') : null;
    const matches = (row) => (!id || row.id === id) && [...url.searchParams].every(([key, value]) => {
      const fields = { user_id: row.user_id, 'data->build->>buildId': row.data?.build?.buildId, 'data->>userId': row.data?.userId, 'data->build->>claimed': row.data?.build?.claimed, 'data->build->>state': row.data?.build?.state };
      return !(key in fields) || String(fields[key]) === value.slice(3);
    });
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET') {
      const rows = tables[table].filter(matches);
      return res.end(JSON.stringify(rows.map((r) => ({ id: r.id, data: r.data, stop_requested: r.stop_requested }))));
    }
    if (req.method === 'POST') {
      tables[table].push(JSON.parse(body));
      res.statusCode = 201;
      return res.end('');
    }
    if (req.method === 'PATCH') {
      const row = tables[table].find(matches);
      if (row) Object.assign(row, JSON.parse(body));
      if (req.headers.prefer === 'return=representation') return res.end(JSON.stringify(row ? [row] : []));
      res.statusCode = 204;
      return res.end('');
    }
    if (req.method === 'DELETE') {
      const index = tables[table].findIndex(matches);
      const removed = index > -1 ? tables[table].splice(index, 1) : [];
      if (req.headers.prefer === 'return=representation') return res.end(JSON.stringify(removed));
      res.statusCode = 204;
      return res.end('');
    }
    res.statusCode = 405;
    res.end('');
  });
});

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

(async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';

  const config = require('../server/config');
  const { createSupabaseStore } = require('../server/store/supabase');

  console.log(`\nmeamus store test  (mock PostgREST on :${port})\n`);

  const store = createSupabaseStore(config);

  await check('the facade selects Supabase when both values are set', () => {
    assert.strictEqual(config.supabase.enabled, true);
    assert.strictEqual(store.kind, 'supabase');
  });

  await check('init hydrates every collection', async () => {
    await store.init();
    assert.deepStrictEqual(store.all('users'), []);
    assert.deepStrictEqual(store.all('games'), []);
    assert.deepStrictEqual(store.all('uploads'), []);
    const paths = seen.filter((r) => r.method === 'GET').map((r) => r.path);
    assert.ok(paths.some((p) => p.includes('meamus_users')), 'users table was not read');
    assert.ok(paths.some((p) => p.includes('meamus_games')), 'games table was not read');
  });

  await check('requests carry both Supabase auth headers', () => {
    const [first] = seen;
    assert.strictEqual(first.headers.apikey, 'service-role-test-key');
    assert.strictEqual(first.headers.authorization, 'Bearer service-role-test-key');
  });

  await check('insert writes an { id, data } row', async () => {
    seen.length = 0;
    const user = { id: store.id('usr'), email: 'a@b.test', plan: 'free' };
    store.insert('users', user);
    await new Promise((r) => setTimeout(r, 200));
    const post = seen.find((r) => r.method === 'POST');
    assert.ok(post, 'no POST was issued');
    assert.ok(post.path.includes('meamus_users'));
    assert.strictEqual(post.body.id, user.id);
    assert.strictEqual(post.body.data.email, 'a@b.test');
    assert.strictEqual(post.headers.prefer, 'return=minimal');
  });

  await check('a fresh store sees what the previous one wrote', async () => {
    const second = createSupabaseStore(config);
    await second.init();
    const user = second.find('users', (u) => u.email === 'a@b.test');
    assert.ok(user, 'the row did not survive a rehydrate');
    assert.strictEqual(user.plan, 'free');
  });

  await check('update patches by id=eq. and stamps updatedAt', async () => {
    seen.length = 0;
    const user = store.find('users', (u) => u.email === 'a@b.test');
    const updated = store.update('users', user.id, { plan: 'pro' });
    assert.strictEqual(updated.plan, 'pro');
    assert.ok(updated.updatedAt, 'updatedAt was not stamped');
    await new Promise((r) => setTimeout(r, 200));
    const patch = seen.find((r) => r.method === 'PATCH');
    assert.ok(patch.path.includes(`id=eq.${user.id}`), `wrong filter: ${patch.path}`);
    assert.strictEqual(patch.body.data.plan, 'pro');
  });

  await check('remove deletes by id and drops it from the cache', async () => {
    seen.length = 0;
    const user = store.find('users', (u) => u.email === 'a@b.test');
    assert.strictEqual(store.remove('users', user.id), true);
    assert.strictEqual(store.find('users', (u) => u.id === user.id), null);
    await new Promise((r) => setTimeout(r, 200));
    const del = seen.find((r) => r.method === 'DELETE');
    assert.ok(del.path.includes(`id=eq.${user.id}`));
  });

  await check('a missing table fails loudly instead of silently', async () => {
    const broken = createSupabaseStore({
      supabase: { url: `http://127.0.0.1:${port}/wrong`, serviceKey: 'service-role-test-key' }
    });
    await assert.rejects(() => broken.init(), /failed \(404\)|does not exist/);
  });

  await check('reads before init refuse rather than return empty', () => {
    const cold = createSupabaseStore(config);
    assert.throws(() => cold.all('users'), /not ready/);
  });

  await check('flush waits for in-flight writes', async () => {
    // Regression: writes are issued without blocking the caller, so a process
    // exiting straight after one used to lose it. flush() must await them.
    const fresh = createSupabaseStore(config);
    await fresh.init();
    const doc = { id: fresh.id('usr'), email: 'flush@b.test' };
    fresh.insert('users', doc);
    assert.strictEqual(fresh.pendingWrites, 1, 'the write was not tracked');
    await fresh.flush();
    assert.strictEqual(fresh.pendingWrites, 0, 'flush returned with writes still pending');

    const after = createSupabaseStore(config);
    await after.init();
    assert.ok(after.find('users', (u) => u.id === doc.id), 'the flushed write never landed');
  });

  await check('a delete is durable across a reload', async () => {
    const fresh = createSupabaseStore(config);
    await fresh.init();
    const doc = fresh.find('users', (u) => u.email === 'flush@b.test');
    fresh.remove('users', doc.id);
    await fresh.flush();
    await fresh.reload();
    assert.strictEqual(fresh.find('users', (u) => u.id === doc.id), null,
      'the row came back after a reload');
  });

  await check('a plan is consumed once across two store instances', async () => {
    const other = createSupabaseStore(config);
    await other.init();
    const plan = { planId: 'plan-1', userId: 'owner', createdAt: Date.now(), prompt: 'runner' };
    await store.saveBuildPlan(plan);
    assert.strictEqual(await other.takeBuildPlan('plan-1', 'stranger'), null);
    const results = await Promise.all([store.takeBuildPlan('plan-1', 'owner'), other.takeBuildPlan('plan-1', 'owner')]);
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual(results.find(Boolean).prompt, 'runner');
    await store.saveBuildPlan({ ...plan, planId: 'expired', createdAt: 0 });
    assert.strictEqual(await other.takeBuildPlan('expired', 'owner'), null);
  });

  await check('a build has one owner across instances and fresh progress reads', async () => {
    const other = createSupabaseStore(config);
    await other.init();
    const game = { id: 'game-build', userId: 'owner', build: { buildId: 'build-1', state: 'running', claimed: false } };
    store.insert('games', game);
    store.update('games', game.id, { title: 'Latest title' });
    await store.flush();
    const fresh = await other.gameForBuild('build-1', 'owner');
    assert.strictEqual(fresh.title, 'Latest title', 'insert/update order must be preserved');
    assert.strictEqual(await other.gameForBuild('build-1', 'stranger'), null);
    const claims = await Promise.all([store.claimBuild(fresh), other.claimBuild(fresh)]);
    assert.strictEqual(claims.filter(Boolean).length, 1);
    assert.strictEqual((await other.gameForBuild('build-1', 'owner')).build.claimed, true);
    await other.stopBuild('build-1', 'owner');
    store.update('games', game.id, { title: 'Progress after stop' });
    await store.flush();
    assert.strictEqual((await store.gameForBuild('build-1', 'owner')).build.stopRequested, true, 'progress must not erase cancellation');
  });

  await check('a failed write is reported before a successful response can be sent', async () => {
    // A dead database must not reject inside a request handler, but it must
    // also never fail silently or leave a write pending forever.
    const flaky = createSupabaseStore(config);
    await flaky.init();

    const captured = [];
    const originalError = console.error;
    const originalFetch = global.fetch;
    console.error = (msg) => captured.push(String(msg));
    global.fetch = () => Promise.reject(new Error('network is down'));
    try {
      flaky.insert('users', { id: flaky.id('usr'), email: 'doomed@b.test' });
      await assert.rejects(flaky.flush(), /network is down/);
    } finally {
      global.fetch = originalFetch;
      console.error = originalError;
    }

    assert.strictEqual(flaky.pendingWrites, 0, 'a failed write stayed pending forever');
    assert.ok(captured.some((m) => /insert into users failed/.test(m)),
      `the failure was not logged: ${JSON.stringify(captured)}`);
  });

  await check('a build step keeps its numbers, and drops what it should not', async () => {
    // The route hands builds.step() whatever an agent reported. What survives
    // is this whitelist's decision, and it used to be five fields - so adding a
    // line count to the coder's progress changed nothing on screen, because it
    // was dropped one layer below where it was written.
    const builds = require('../server/services/builds');
    builds.reset();
    const { build } = builds.start('user_1', { kind: 'create', prompt: 'x', estimate: {} });

    builds.step(build, {
      phase: 'build',
      detail: 'Wrote game.js',
      agent: 'Coder',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      modelIndex: 2,
      modelCount: 6,
      file: 'game.js',
      lines: 341,
      bytes: 18220,
      spec: { enormous: 'x'.repeat(50000) }   // must not reach the row
    });

    const [step] = build.steps;
    assert.strictEqual(step.lines, 341, 'the line count was dropped');
    assert.strictEqual(step.file, 'game.js', 'the file name was dropped');
    assert.strictEqual(step.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.strictEqual(step.modelIndex, 2);
    assert.strictEqual(step.agent, 'Coder');
    assert.ok(typeof step.at === 'number', 'a step arrived without a timestamp');
    assert.strictEqual(step.spec, undefined,
      'a whole spec on a progress line would be written onto the row on every step');
    builds.reset();
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nstore test crashed:', err);
  process.exit(2);
});
