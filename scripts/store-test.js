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

const tables = { meamus_users: [], meamus_games: [], meamus_uploads: [] };
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
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET') {
      const rows = id ? tables[table].filter((r) => r.id === id) : tables[table];
      return res.end(JSON.stringify(rows.map((r) => ({ id: r.id, data: r.data }))));
    }
    if (req.method === 'POST') {
      tables[table].push({ id: JSON.parse(body).id, data: JSON.parse(body).data });
      res.statusCode = 201;
      return res.end('');
    }
    if (req.method === 'PATCH') {
      const row = tables[table].find((r) => r.id === id);
      if (row) row.data = JSON.parse(body).data;
      res.statusCode = 204;
      return res.end('');
    }
    if (req.method === 'DELETE') {
      const index = tables[table].findIndex((r) => r.id === id);
      if (index > -1) tables[table].splice(index, 1);
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

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nstore test crashed:', err);
  process.exit(2);
});
