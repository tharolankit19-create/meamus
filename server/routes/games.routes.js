'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const generator = require('../services/generator');
const bundler = require('../services/bundler');
const apk = require('../services/apk');
const { requireAuth, requirePlan, enforceQuota, recordUsage, asyncRoute } = require('../middleware');

const router = express.Router();

const MAX_PROMPT = 2000;
const MAX_VERSIONS = 10;

/** List view - the full spec is heavy, so summaries omit gameCode. */
function summarise(game) {
  return {
    id: game.id,
    title: game.spec.gameConfig.title,
    genre: game.spec.gameConfig.genre,
    description: game.spec.gameConfig.description,
    difficulty: game.spec.gameConfig.difficulty,
    estimatedPlayTime: game.spec.gameConfig.estimatedPlayTime,
    prompt: game.prompt,
    mode: game.meta.mode,
    isPublic: game.isPublic === true,
    versionCount: (game.versions || []).length + 1,
    codeLines: game.spec.gameCode.javascript.split('\n').length,
    spriteCount: game.spec.assets.sprites.length,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt
  };
}

function ownedGame(req, res) {
  const game = db.find('games', (g) => g.id === req.params.id);
  if (!game) { res.status(404).json({ error: 'Game not found', code: 'not_found' }); return null; }
  if (game.userId !== req.user.id) { res.status(403).json({ error: 'Not your game', code: 'forbidden' }); return null; }
  return game;
}

/* --- generate ----------------------------------------------------------- */
router.post('/generate', requireAuth, enforceQuota, asyncRoute(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim();
  if (prompt.length < 4) {
    return res.status(400).json({ error: 'Describe the game you want in a sentence or two', code: 'prompt_too_short' });
  }
  if (prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `Prompt is too long (max ${MAX_PROMPT} characters)`, code: 'prompt_too_long' });
  }

  const { spec, meta } = await generator.generate(prompt, {
    forceTemplate: req.body.forceTemplate === true
  });

  const now = new Date().toISOString();
  const game = db.insert('games', {
    id: db.id('gam'),
    userId: req.user.id,
    prompt,
    spec,
    meta,
    versions: [],
    isPublic: false,
    createdAt: now,
    updatedAt: now
  });

  const used = recordUsage(req.user);

  res.status(201).json({
    game: summarise(game),
    spec,
    meta,
    quota: { used, limit: config.quotas[req.user.plan] || config.quotas.free }
  });
}));

/* --- library ------------------------------------------------------------ */
router.get('/games', requireAuth, (req, res) => {
  const games = db.filter('games', (g) => g.userId === req.user.id)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(summarise);
  res.json({ games, count: games.length });
});

router.get('/games/:id', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  res.json({ game: summarise(game), spec: game.spec, meta: game.meta });
});

router.patch('/games/:id', requireAuth, asyncRoute(async (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;

  const patch = {};
  if (typeof req.body.title === 'string' && req.body.title.trim()) {
    patch.spec = { ...game.spec, gameConfig: { ...game.spec.gameConfig, title: req.body.title.trim().slice(0, 80) } };
  }
  if (typeof req.body.isPublic === 'boolean') patch.isPublic = req.body.isPublic;

  const updated = db.update('games', game.id, patch);
  res.json({ game: summarise(updated) });
}));

router.delete('/games/:id', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  db.remove('games', game.id);
  res.json({ deleted: true, id: game.id });
});

/* --- iterate ------------------------------------------------------------ */
router.post('/games/:id/modify', requireAuth, enforceQuota, asyncRoute(async (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;

  const instruction = String(req.body.instruction || '').trim();
  if (instruction.length < 3) {
    return res.status(400).json({ error: 'Describe the change you want', code: 'instruction_too_short' });
  }

  const { spec, meta } = await generator.modify(instruction, game.spec);

  // Keep a bounded history so a bad edit can be rolled back.
  const versions = [
    { spec: game.spec, meta: game.meta, instruction: null, savedAt: game.updatedAt },
    ...(game.versions || [])
  ].slice(0, MAX_VERSIONS);

  const updated = db.update('games', game.id, {
    spec,
    meta: { ...meta, lastInstruction: instruction },
    versions
  });
  const used = recordUsage(req.user);

  res.json({
    game: summarise(updated),
    spec,
    meta: updated.meta,
    quota: { used, limit: config.quotas[req.user.plan] || config.quotas.free }
  });
}));

router.post('/games/:id/revert', requireAuth, asyncRoute(async (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  const versions = game.versions || [];
  if (!versions.length) {
    return res.status(400).json({ error: 'No earlier version to revert to', code: 'no_history' });
  }
  const [previous, ...rest] = versions;
  const updated = db.update('games', game.id, {
    spec: previous.spec,
    meta: previous.meta,
    versions: rest
  });
  res.json({ game: summarise(updated), spec: updated.spec, meta: updated.meta });
}));

/* --- export -------------------------------------------------------------- */
router.get('/games/:id/export/html', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  const html = bundler.bundle(game.spec);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${apk.slugify(game.spec.gameConfig.title)}.html"`);
  res.send(html);
});

router.get('/games/:id/export/spec', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  res.set('Content-Disposition', `attachment; filename="${apk.slugify(game.spec.gameConfig.title)}.json"`);
  res.json(game.spec);
});

// Paid gate: apkReady stays false until the account is on the Pro plan.
router.get('/games/:id/export/apk', requireAuth, requirePlan('pro'), (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;

  const project = apk.buildProject({ ...game.spec, apkReady: true }, {
    packageId: typeof req.query.packageId === 'string' ? req.query.packageId : undefined,
    orientation: typeof req.query.orientation === 'string' ? req.query.orientation : undefined
  });

  db.update('games', game.id, { spec: { ...game.spec, apkReady: true } });

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${project.filename}"`);
  res.send(project.buffer);
});

module.exports = router;
