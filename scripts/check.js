#!/usr/bin/env node
'use strict';

/**
 * Static checks that run in about a second: syntax on every JS file, template
 * integrity, and the invariants the bundles must hold (no eval, no external
 * assets beyond the pinned Phaser CDN, five scenes, all three input methods).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;

const fail = (msg) => { failed += 1; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'demos', 'data'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('\nmeamus checks\n');

/* --- 1. syntax ----------------------------------------------------------- */
/* The frontend is ES modules and the backend is CommonJS, so each half needs
   its own parser: vm.Script rejects `import`, and `node --check` only treats a
   file as a module when the path ends in .mjs. */
const files = walk(ROOT);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meamus-syntax-'));
let syntaxErrors = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const isModule = /^\s*(import|export)\s/m.test(source);
  try {
    if (isModule) {
      const copy = path.join(tmpDir, `${path.basename(file, '.js')}.mjs`);
      fs.writeFileSync(copy, source);
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } else {
      new vm.Script(source, { filename: file });
    }
  } catch (err) {
    syntaxErrors += 1;
    const detail = err.stderr ? String(err.stderr).split('\n').filter(Boolean).slice(-2).join(' ') : err.message;
    fail(`syntax: ${path.relative(ROOT, file)} - ${detail}`);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
if (!syntaxErrors) ok(`syntax clean across ${files.length} JavaScript files`);

/* --- 2. templates -------------------------------------------------------- */
const templates = require('../server/services/templates');
const bundler = require('../server/services/bundler');

let loaded = [];
try {
  loaded = templates.loadAll();
  if (loaded.length < 4) fail(`expected at least 4 templates, found ${loaded.length}`);
  else ok(`${loaded.length} templates load and normalise`);
} catch (err) {
  fail(`templates failed to load: ${err.message}`);
}

for (const template of loaded) {
  const { spec } = template;
  const js = spec.gameCode.javascript;
  const id = template.id;
  const problems = [];

  // Boot and Preload come from the shared kit when a template opts into it, so
  // the scene check runs against the source that actually ships.
  const shipped = js + (spec.runtime.kit ? templates.readKit() : '');
  for (const scene of ['BootScene', 'PreloadScene', 'MenuScene', 'GameScene', 'GameOverScene']) {
    if (!shipped.includes(scene)) problems.push(`missing ${scene}`);
  }
  if (!/MEAMUS\.boot|new Phaser\.Game/.test(js)) problems.push('never boots a Phaser game');
  if (/\beval\s*\(/.test(js)) problems.push('uses eval()');
  if (/\bnew Function\s*\(/.test(js)) problems.push('uses new Function()');
  if (/\bsetInterval\s*\(/.test(js)) problems.push('uses setInterval for timing');
  if (/\balert\s*\(/.test(js)) problems.push('uses alert()');
  if (!spec.controls.keyboard.length) problems.push('no keyboard controls');
  if (!spec.controls.touch.length) problems.push('no touch controls');
  if (!spec.controls.mouse.length) problems.push('no mouse controls');
  if (!spec.monetizationHooks.length) problems.push('no monetization hooks');
  if (!spec.mobileOptimizations.length) problems.push('no mobile optimisations');
  if (spec.assets.sprites.length < 3) problems.push('fewer than 3 sprite specs');
  if (spec.apkReady !== false) problems.push('apkReady should start false');
  if (js.split('\n').length > 2000) problems.push(`${js.split('\n').length} lines (guideline is <= 2000)`);
  if (!/localStorage|MEAMUS\.storage/.test(js)) problems.push('no score persistence');

  // The bundle must not reach for anything but the pinned Phaser build.
  const html = bundler.bundle(spec);
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const url of external) {
    if (!url.includes('cdn.jsdelivr.net/npm/phaser')) problems.push(`external asset: ${url}`);
  }
  if (!html.includes('viewport-fit=cover')) problems.push('bundle is missing the mobile viewport meta');

  if (problems.length) fail(`template ${id}: ${problems.join('; ')}`);
  else ok(`template ${id} passes all game rules (${js.split('\n').length} lines, ${(html.length / 1024).toFixed(0)} KB bundled)`);
}

/* --- 3. config surface --------------------------------------------------- */
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const required = ['ANTHROPIC_API_KEY', 'PORT', 'JWT_SECRET', 'FREE_DAILY_GENERATIONS', 'BILLING_PROVIDER'];
const missing = required.filter((key) => !envExample.includes(key));
if (missing.length) fail(`.env.example is missing: ${missing.join(', ')}`);
else ok('.env.example documents every setting the server reads');

/* --- 4. no committed secrets --------------------------------------------- */
if (fs.existsSync(path.join(ROOT, '.env'))) {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  if (!gitignore.split('\n').some((line) => line.trim() === '.env')) fail('.env exists but is not gitignored');
  else ok('.env is gitignored');
} else {
  ok('no .env committed');
}

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
