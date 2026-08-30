#!/usr/bin/env node
'use strict';

/**
 * Verifies the storage backend end to end: connect, write, read back, update,
 * delete. Run it after pointing SUPABASE_URL at a project so a bad key or a
 * missing table fails here rather than on someone's first signup.
 *
 *   npm run db:check
 */

const config = require('../server/config');
const db = require('../server/db');

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

(async function run() {
  console.log('\nmeamus storage check\n');
  console.log(`  backend    ${db.kind}`);
  if (db.kind === 'supabase') {
    console.log(`  url        ${config.supabase.url}`);
    console.log(`  key        service-role (${config.supabase.serviceKey.slice(0, 8)}…)`);
  } else {
    console.log(`  directory  ${config.dataDir}`);
    console.log('\n  Note: this is the local JSON backend. On an ephemeral or serverless');
    console.log('  host it is wiped on every restart, which looks like accounts vanishing.');
    console.log('  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use Postgres.');
  }
  console.log('');

  try {
    const ping = await db.ping();
    ok(`reachable (${ping.ms}ms)`);
  } catch (err) {
    bad(`cannot reach the store: ${err.message}`);
    if (db.kind === 'supabase') {
      console.log('\n  Check that supabase/schema.sql has been run in the SQL editor,');
      console.log('  and that SUPABASE_SERVICE_ROLE_KEY is the service_role key');
      console.log('  (not the anon key - anon cannot see these tables by design).\n');
    }
    process.exit(1);
  }

  if (db.init) await db.init();

  const id = db.id('chk');
  const probe = { id, email: `${id}@check.meamus.local`, name: 'storage check', createdAt: new Date().toISOString() };

  try {
    db.insert('users', probe);
    await db.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    ok('write accepted');

    const found = db.find('users', (u) => u.id === id);
    if (!found) throw new Error('the row was not readable after writing');
    ok('read back');

    const updated = db.update('users', id, { name: 'storage check (updated)' });
    if (!updated || updated.name !== 'storage check (updated)') throw new Error('update did not apply');
    ok('update applied');

    if (!db.remove('users', id)) throw new Error('delete reported no row');
    await db.flush();
    // Confirm from the server, not the cache - a dropped DELETE would leave
    // the probe row behind and still look fine locally.
    if (db.reload) {
      await db.reload();
      if (db.find('users', (u) => u.id === id)) throw new Error('the probe row survived the delete');
    }
    ok('delete applied and confirmed');
  } catch (err) {
    bad(err.message);
    try { db.remove('users', id); } catch { /* best effort */ }
    process.exit(1);
  }

  console.log(`\nstorage is working (${db.kind}).\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\nstorage check crashed:', err.message);
  process.exit(2);
});
