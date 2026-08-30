'use strict';

/**
 * Loads the bundled demo templates from /templates and turns each one into a
 * canonical GameSpec. A template is metadata (template.json) plus its Phaser
 * source (game.js); the shared kit is inlined by the bundler at build time.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { normaliseSpec } = require('./validator');

const SHARED_DIR = path.join(config.templatesDir, '_shared');

let cache = null;

function readKit() {
  return fs.readFileSync(path.join(SHARED_DIR, 'kit.js'), 'utf8');
}

function loadAll() {
  if (cache) return cache;

  const entries = fs.readdirSync(config.templatesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'));

  cache = entries.map((entry) => {
    const dir = path.join(config.templatesDir, entry.name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8'));
    const javascript = fs.readFileSync(path.join(dir, 'game.js'), 'utf8');

    const { spec } = normaliseSpec(
      { ...meta, gameCode: { html: '', css: '', javascript } },
      { source: 'template' }
    );

    return {
      id: meta.id || entry.name,
      slug: meta.slug || entry.name,
      featured: meta.featured !== false,
      keywords: (meta.keywords || []).map((k) => String(k).toLowerCase()),
      spec
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  return cache;
}

function list() {
  return loadAll().map((t) => ({
    id: t.id,
    slug: t.slug,
    featured: t.featured,
    keywords: t.keywords,
    gameConfig: t.spec.gameConfig,
    controls: t.spec.controls,
    mechanics: t.spec.mechanics,
    spriteCount: t.spec.assets.sprites.length,
    demoUrl: `/demos/${t.id}.html`
  }));
}

function get(id) {
  return loadAll().find((t) => t.id === id || t.slug === id) || null;
}

/**
 * Score every template against a free-text prompt.
 * Deterministic keyword matching - no model call, so this works offline and
 * gives the API a sane fallback when no Claude key is configured.
 */
function rank(prompt) {
  const text = String(prompt || '').toLowerCase();
  const words = new Set(text.split(/[^a-z0-9+-]+/).filter(Boolean));

  return loadAll()
    .map((t) => {
      let score = 0;
      const hits = [];
      for (const keyword of t.keywords) {
        // Multi-word keywords match as a phrase, single words as tokens.
        const hit = keyword.includes(' ') || keyword.includes('-')
          ? text.includes(keyword)
          : words.has(keyword);
        if (hit) {
          score += keyword === t.spec.gameConfig.genre ? 3 : 2;
          hits.push(keyword);
        }
      }
      if (text.includes(t.spec.gameConfig.genre)) { score += 4; hits.push(t.spec.gameConfig.genre); }
      return { template: t, score, hits };
    })
    .sort((a, b) => b.score - a.score);
}

function reload() {
  cache = null;
  return loadAll();
}

module.exports = { list, get, rank, loadAll, readKit, reload };
