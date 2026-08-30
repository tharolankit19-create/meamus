#!/usr/bin/env node
'use strict';

/**
 * Persistence check. Boots the server, registers an account and generates a
 * game, stops the server, throws the data directory away, boots again, and
 * proves the account, the game and the session token all survived.
 *
 * This is the check that catches "signup stopped working" on an ephemeral
 * host: with the JSON backend it fails, with Supabase it passes.
 *
 *   npm run db:persist-check
 */
const { spawn } = require('child_process');
const fs = require('fs');

const EMAIL = `persist-${Date.now()}@meamus.test`;
const PORT = Number(process.env.PERSIST_PORT || 3210);

function boot(label) {
  return new Promise((resolve, reject) => {
    // A fresh DATA_DIR each time: if anything survives, it came from Postgres.
    const dir = fs.mkdtempSync('/tmp/meamus-persist-');
    const child = spawn('node', ['server/index.js'], {
      cwd: require('path').resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, NODE_ENV: 'production', TEST_MODE: 'false' }
    });
    let out = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      out += d;
      if (settled) return;
      if (/storage {4}(supabase|json)/.test(out)) {
        settled = true;
        const backend = /storage {4}supabase/.test(out) ? 'supabase' : 'json';
        if (backend === 'json') {
          child.kill('SIGTERM');
          reject(new Error(
            'The JSON backend cannot survive a restart with a fresh data dir.\n' +
            '       Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then re-run.'
          ));
          return;
        }
        console.log(`  ${label}: booted on a brand-new data dir (${dir.split('/').pop()})`);
        setTimeout(() => resolve(child), 900);
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error('boot timed out:\n' + out.slice(-500))), 25000);
  });
}

const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  let fail = 0;
  const ok = (m) => console.log('  ok    ' + m);
  const bad = (m) => { fail++; console.log('  FAIL  ' + m); };

  console.log('\nsignup persistence across a restart (live Supabase)\n');

  let server = await boot('run 1');
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: 'supersecret123', name: 'Persist' })
  });
  if (reg.status !== 201) bad('register: ' + reg.status + ' ' + JSON.stringify(reg.body));
  else ok('registered ' + EMAIL);

  const gen = await api('/api/generate', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + reg.body.token },
    body: JSON.stringify({ prompt: 'a space shooter with asteroids' })
  });
  if (gen.status !== 201) bad('generate: ' + gen.status);
  else ok('created the game "' + gen.body.spec.gameConfig.title + '"');

  // Graceful stop so pending writes flush.
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  console.log('  -- server stopped, data dir discarded --');

  server = await boot('run 2');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: 'supersecret123' })
  });
  if (login.status !== 200) bad('login after restart: ' + login.status + ' ' + JSON.stringify(login.body));
  else ok('logged in after the restart — the account survived');

  const games = await api('/api/games', { headers: { authorization: 'Bearer ' + login.body.token } });
  if (games.status !== 200 || !games.body.games.length) bad('games lost: ' + JSON.stringify(games.body));
  else ok(`the game survived too ("${games.body.games[0].title}", ${games.body.games[0].codeLines} lines)`);

  const old = await api('/api/auth/me', { headers: { authorization: 'Bearer ' + reg.body.token } });
  if (old.status !== 200) bad('the pre-restart token stopped working: ' + old.status);
  else ok('the session token from before the restart still works');

  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  console.log(`\n${fail ? fail + ' failed' : 'all good'}\n`);
  process.exit(fail ? 1 : 0);
})();
