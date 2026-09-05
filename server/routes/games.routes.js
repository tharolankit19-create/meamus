'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const generator = require('../services/generator');
const uploads = require('../services/uploads');
const bundler = require('../services/bundler');
const apk = require('../services/apk');
const credits = require('../credits');
const intent = require('../services/intent');
const { requireAuth, requirePlan, enforceQuota, recordUsage, asyncRoute } = require('../middleware');

/**
 * Tags the request so enforceQuota charges the right price. A change costs
 * less than a game built from nothing.
 */
const costs = (kind) => (req, res, next) => { req.creditKind = kind; next(); };

const router = express.Router();

const MAX_PROMPT = 2000;
const MAX_VERSIONS = 10;
const MAX_MESSAGES = 60;

/**
 * One turn in a project's chat thread. Assistant turns carry a snapshot of the
 * spec summary so the UI can label each card without re-reading the game.
 */
function message(role, text, extra = {}) {
  return {
    id: db.id('msg'),
    role,
    text,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function appendMessages(game, ...entries) {
  const messages = [...(game.messages || []), ...entries].slice(-MAX_MESSAGES);
  return messages;
}

/**
 * A build in memory does not survive the process, and on a serverless host the
 * process goes away between requests. So a row left saying "building" long
 * after anything could still be running is not building - it is a build whose
 * server went away, and it has to say so rather than spinning forever.
 */
const BUILD_STALE_MS = 15 * 60 * 1000;

function staleBuild(game) {
  if (game.status !== 'building') return false;
  const at = Date.parse(game.updatedAt || game.createdAt || '');
  return Number.isFinite(at) && Date.now() - at > BUILD_STALE_MS;
}

/** List view - the full spec is heavy, so summaries omit gameCode. */
/**
 * The card shape.
 *
 * A row now exists from the moment a build starts, so this has to describe a
 * game that has no spec yet. Without that, closing the tab mid-build lost the
 * game entirely; with it, the row is listed as building and fills itself in.
 */
function summarise(game) {
  const spec = game.spec;
  const status = staleBuild(game)
    ? 'failed'
    : (game.status || (spec ? 'ready' : 'building'));

  const base = {
    id: game.id,
    status,
    prompt: game.prompt,
    isPublic: game.isPublic === true,
    messageCount: (game.messages || []).length,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt
  };

  if (!spec) {
    return {
      ...base,
      title: game.title || 'New game',
      genre: null,
      description: status === 'failed'
        ? (game.error || (staleBuild(game)
          ? 'That build stopped when the server restarted. Send the prompt again.'
          : 'That build did not finish.'))
        : 'Building…',
      difficulty: null,
      estimatedPlayTime: null,
      mode: null,
      versionCount: 0,
      codeLines: 0,
      spriteCount: 0
    };
  }

  // Defensive reads rather than spec.gameConfig.title. A spec is written by a
  // model, and a half-written one that got past the validator - or one stored
  // by an older version of this code - must not be able to throw here: this
  // function runs inside a .map() over the whole library, so one bad row used
  // to take out every game the founder owns and leave them a red box where
  // their dashboard should be.
  const cfg = spec.gameConfig || {};
  const code = (spec.gameCode && spec.gameCode.javascript) || '';
  const sprites = (spec.assets && spec.assets.sprites) || [];

  return {
    ...base,
    title: cfg.title || game.title || 'Untitled game',
    genre: cfg.genre || null,
    description: cfg.description || '',
    difficulty: cfg.difficulty || null,
    estimatedPlayTime: cfg.estimatedPlayTime || null,
    mode: (game.meta && game.meta.mode) || null,
    versionCount: (game.versions || []).length + 1,
    codeLines: code ? code.split('\n').length : 0,
    spriteCount: sprites.length
  };
}

/**
 * summarise() for a list, where one unreadable row must not cost the founder
 * every other game they own. Whatever is wrong with that row, it becomes a card
 * that says so and the rest of the library still loads.
 */
function summariseSafely(game) {
  try {
    return summarise(game);
  } catch (err) {
    console.error(`[games] could not summarise ${game && game.id}: ${err.message}`);
    return {
      id: (game && game.id) || 'unknown',
      status: 'failed',
      prompt: (game && game.prompt) || '',
      isPublic: false,
      messageCount: 0,
      createdAt: game && game.createdAt,
      updatedAt: game && game.updatedAt,
      title: (game && game.title) || 'Unreadable game',
      genre: null,
      description: 'This game could not be read. Delete it, or open it to see what is there.',
      difficulty: null,
      estimatedPlayTime: null,
      mode: null,
      versionCount: 0,
      codeLines: 0,
      spriteCount: 0
    };
  }
}

/** The one-line summary an assistant turn shows in the chat thread. */
function describeBuild(spec, meta) {
  const bits = [
    `${spec.gameConfig.genre} · ${spec.gameConfig.difficulty}`,
    `${spec.gameCode.javascript.split('\n').length} lines`,
    `${spec.assets.sprites.length} sprites`,
    `${spec.mechanics.length} mechanics`
  ];
  if (meta.mode === 'template') bits.push(`from the ${meta.templateId} template`);
  return bits.join(' · ');
}

function ownedGame(req, res) {
  const game = db.find('games', (g) => g.id === req.params.id);
  if (!game) { res.status(404).json({ error: 'Game not found', code: 'not_found' }); return null; }
  if (game.userId !== req.user.id) { res.status(403).json({ error: 'Not your game', code: 'forbidden' }); return null; }
  return game;
}

/* --- generate ----------------------------------------------------------- */
router.post('/generate', requireAuth, costs('create'), enforceQuota, asyncRoute(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim();
  if (prompt.length < 4) {
    return res.status(400).json({ error: 'Describe the game you want in a sentence or two', code: 'prompt_too_short' });
  }
  if (prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `Prompt is too long (max ${MAX_PROMPT} characters)`, code: 'prompt_too_long' });
  }

  const attachments = uploads.resolve(req.body.attachmentIds, req.user.id);

  const { spec, meta } = await generator.generate(prompt, {
    forceTemplate: req.body.forceTemplate === true,
    allowFallback: false,
    attachments
  });

  const now = new Date().toISOString();
  const game = db.insert('games', {
    id: db.id('gam'),
    userId: req.user.id,
    prompt,
    spec,
    meta,
    versions: [],
    messages: [
      message('user', prompt, { attachments: attachments.map(uploads.publicView) }),
      message('assistant', describeBuild(spec, meta), {
        title: spec.gameConfig.title,
        kind: 'build',
        mode: meta.mode
      })
    ],
    isPublic: false,
    createdAt: now,
    updatedAt: now
  });

  const used = recordUsage(req.user);
  // Charged here, not before the model call: a generation that threw must not
  // cost the player anything.
  const billed = credits.charge(req.user, 'create');

  res.status(201).json({
    game: summarise(game),
    spec,
    meta,
    messages: game.messages,
    credits: { charged: billed.charged, balance: billed.balance },
    quota: { used, limit: config.quotas.unlimited ? null : (config.quotas[req.user.plan] || config.quotas.free) }
  });
}));

/* --- library ------------------------------------------------------------ */
router.get('/games', requireAuth, (req, res) => {
  const games = db.filter('games', (g) => g.userId === req.user.id)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(summariseSafely);
  res.json({ games, count: games.length });
});

router.get('/games/:id', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  res.json({ game: summariseSafely(game), spec: game.spec, meta: game.meta, messages: game.messages || [] });
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
router.post('/games/:id/modify', requireAuth, costs('iterate'), enforceQuota, asyncRoute(async (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;

  const instruction = String(req.body.instruction || '').trim();
  if (instruction.length < 3) {
    return res.status(400).json({ error: 'Describe the change you want', code: 'instruction_too_short' });
  }

  const attachments = uploads.resolve(req.body.attachmentIds, req.user.id);
  const { spec, meta } = await generator.modify(instruction, game.spec, { attachments });

  // Keep a bounded history so a bad edit can be rolled back.
  const versions = [
    { spec: game.spec, meta: game.meta, instruction: null, savedAt: game.updatedAt },
    ...(game.versions || [])
  ].slice(0, MAX_VERSIONS);

  const updated = db.update('games', game.id, {
    spec,
    meta: { ...meta, lastInstruction: instruction },
    versions,
    messages: appendMessages(game,
      message('user', instruction, { attachments: attachments.map(uploads.publicView) }),
      message('assistant', describeBuild(spec, meta), {
        title: spec.gameConfig.title,
        kind: 'edit',
        mode: meta.mode
      }))
  });
  const used = recordUsage(req.user);
  const billed = credits.charge(req.user, 'iterate');

  res.json({
    game: summarise(updated),
    spec,
    meta: updated.meta,
    messages: updated.messages,
    credits: { charged: billed.charged, balance: billed.balance },
    quota: { used, limit: config.quotas.unlimited ? null : (config.quotas[req.user.plan] || config.quotas.free) }
  });
}));

/**
 * A chat turn.
 *
 * Not every message is a build order. A question about the game is answered
 * and costs nothing; a request too vague to act on gets a question back rather
 * than a guessed rewrite that the player then has to undo; anything else falls
 * through to a real modify, which is what costs credits.
 */
router.post('/games/:id/chat', requireAuth, asyncRoute(async (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;

  const text = String(req.body.message || req.body.instruction || '').trim();
  if (!text) return res.status(400).json({ error: 'Say something first', code: 'empty_message' });

  const verdict = intent.classify(text);

  if (verdict.kind === 'clarify') {
    const reply = intent.clarifyingQuestion(game.spec);
    const updated = db.update('games', game.id, {
      messages: appendMessages(game,
        message('user', text),
        message('assistant', reply, { kind: 'clarify', mode: 'chat' }))
    });
    return res.json({
      kind: 'clarify', reply, messages: updated.messages,
      credits: { charged: 0, balance: credits.balanceOf(req.user) }
    });
  }

  if (verdict.kind === 'question') {
    const { text: reply, meta } = await generator.answer(text, game.spec);
    const updated = db.update('games', game.id, {
      messages: appendMessages(game,
        message('user', text),
        message('assistant', reply, { kind: 'answer', mode: meta.mode }))
    });
    return res.json({
      kind: 'answer', reply, messages: updated.messages,
      credits: { charged: 0, balance: credits.balanceOf(req.user) }
    });
  }

  // A real change is a build, and a build is quoted and approved before it
  // runs. Saying so here and letting the client take it through /build/plan
  // keeps one build path instead of two that can drift apart.
  return res.json({
    kind: 'change',
    instruction: text,
    balance: credits.balanceOf(req.user)
  });
}));

/** The chat thread for a project. */
router.get('/games/:id/messages', requireAuth, (req, res) => {
  const game = ownedGame(req, res);
  if (!game) return;
  res.json({ messages: game.messages || [] });
});

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
