#!/usr/bin/env node
'use strict';

/**
 * Renders every bundled template into public/demos/<id>.html so the demo
 * gallery serves real playable files (and so the templates are smoke-tested
 * on every install).
 */

const fs = require('fs');
const path = require('path');
const config = require('../server/config');
const templates = require('../server/services/templates');
const bundler = require('../server/services/bundler');

function main() {
  const outDir = path.join(config.publicDir, 'demos');
  fs.mkdirSync(outDir, { recursive: true });

  const built = [];
  for (const template of templates.loadAll()) {
    const html = bundler.bundle(template.spec);
    const file = path.join(outDir, `${template.id}.html`);
    fs.writeFileSync(file, html);
    built.push({ id: template.id, title: template.spec.gameConfig.title, kb: (html.length / 1024).toFixed(1) });
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(templates.list(), null, 2));

  for (const b of built) console.log(`  built  ${b.id.padEnd(16)} ${b.title.padEnd(18)} ${b.kb} KB`);
  console.log(`\n${built.length} demo${built.length === 1 ? '' : 's'} written to public/demos/`);
}

try {
  main();
} catch (err) {
  console.error('build-demos failed:', err.message);
  process.exitCode = 1;
}
