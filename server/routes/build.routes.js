'use strict';

/**
 * The build pipeline the founder actually sees.
 *
 *   POST /build/plan        analyse the prompt, quote credits and time
 *   POST /build/start       spend the approval, begin work
 *   GET  /build/:id         poll progress (steps, elapsed, result)
 *   POST /build/:id/stop    ask it to stop at the next boundary
 *
 * A build used to be one blocking request that either returned a game or an
 * error, with nothing in between. Splitting it means the founder approves a
 * cost before it is spent, watches the work, and can call it off.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const credits = require('../credits');
const builds = require('../services/builds');
const estimator = require('../services/estimate');
const generator = require('../services/generator');
const uploads = require('../services/uploads');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();
const MAX_VERSIONS = 10;

/* --- plan ----------------------------------------------------------------- */

router.post('/build/plan', requireAuth, asyncRoute(async (req, res) => {
  const prompt = String(req.body.prompt || req.body.instruction || '').trim();
  if (prompt.length < 3) {
    return res.status(400).json({ error: 'Describe the game you want', code: 'prompt_too_short' });
  }

  const gameId = req.body.gameId ? String(req.body.gameId) : null;
  const kind = gameId ? 'iterate' : 'create';

  if (gameId) {
    const game = db.find('games', (g) => g.id === gameId);
    if (!game || game.userId !== req.user.id) {
      return res.status(404).json({ error: 'Game not found', code: 'not_found' });
    }
  }

  const attachmentIds = Array.isArray(req.body.attachmentIds) ? req.body.attachmentIds : [];
  const estimate = estimator.estimate(kind, {
    attachments: attachmentIds.length,
    promptChars: prompt.length
  });

  // Refuse before quoting rather than after approving.
  if (config.credits.enabled && credits.balanceOf(req.user) < estimate.credits.expected) {
    return res.status(402).json({
      error: `This build needs about ${estimate.credits.expected} credits and you have ${credits.balanceOf(req.user)}.`,
      code: 'insufficient_credits',
      balance: credits.balanceOf(req.user),
      required: estimate.credits.expected
    });
  }

  const planId = builds.savePlan(req.user.id, { kind, prompt, gameId, attachmentIds, estimate });

  res.json({
    planId,
    kind,
    prompt,
    estimate,
    balance: credits.balanceOf(req.user),
    expiresInMs: config.build.planTtlMs,
    // What the agents will do, in the order they will do it.
    plan: [
      { phase: 'analyse', label: 'Read the brief and pick the genre, mechanics and controls' },
      { phase: 'build', label: 'Write the complete Phaser 3 game' },
      { phase: 'review', label: 'Check it parses, starts a game and is not a stub' },
      { phase: 'test', label: 'Boot every scene and tick it — a game that throws is sent back' },
      { phase: 'repair', label: `Fix and re-test, up to ${estimate.attempts} attempts` },
      { phase: 'ship', label: 'Bundle it and open the preview' }
    ]
  });
}));

/* --- start ---------------------------------------------------------------- */

router.post('/build/start', requireAuth, asyncRoute(async (req, res) => {
  const plan = builds.takePlan(String(req.body.planId || ''), req.user.id);
  if (!plan) {
    return res.status(410).json({
      error: 'That estimate has expired. Send the prompt again for a fresh one.',
      code: 'plan_expired'
    });
  }

  const { buildId, build } = builds.start(req.user.id, {
    kind: plan.kind, prompt: plan.prompt, gameId: plan.gameId, estimate: plan.estimate
  });

  // Answer immediately; the work continues and the browser polls for it.
  res.status(202).json({ buildId, state: build.state, estimate: plan.estimate });

  run(build, plan, req.user).catch((err) => {
    builds.fail(build, err.message);
  });
}));

/**
 * The build itself. Runs after the response has been sent, reporting each
 * phase into the build so the chat can show what is happening.
 */
async function run(build, plan, user) {
  const attachments = uploads.resolve(plan.attachmentIds, user.id);
  const onStep = (s) => {
    if (build.stopRequested) return;
    builds.step(build, { phase: s.phase, detail: s.detail, attempt: s.attempt, total: s.total });
  };

  builds.step(build, { phase: 'analyse', detail: 'Reading the brief' });
  if (build.stopRequested) return builds.fail(build, 'Stopped before the model was called');

  const existing = plan.gameId ? db.find('games', (g) => g.id === plan.gameId) : null;

  const { spec, meta } = plan.kind === 'iterate'
    ? await generator.modify(plan.prompt, existing.spec, { attachments, onStep })
    : await generator.generate(plan.prompt, { attachments, onStep });

  if (build.stopRequested) return builds.fail(build, 'Stopped after the build finished but before it was saved');

  builds.step(build, { phase: 'ship', detail: `Bundling ${spec.gameConfig.title}` });

  // Charge on real usage, only now that there is a game to charge for.
  const owed = estimator.creditsForUsage(meta.usage, plan.kind);
  const billed = credits.chargeExact(user, owed);

  const now = new Date().toISOString();
  let game;

  if (plan.kind === 'iterate') {
    const versions = [
      { spec: existing.spec, meta: existing.meta, instruction: null, savedAt: existing.updatedAt },
      ...(existing.versions || [])
    ].slice(0, MAX_VERSIONS);
    game = db.update('games', existing.id, {
      spec, meta: { ...meta, lastInstruction: plan.prompt }, versions
    });
  } else {
    game = db.insert('games', {
      id: db.id('gam'),
      userId: user.id,
      prompt: plan.prompt,
      spec,
      meta,
      versions: [],
      messages: [],
      isPublic: false,
      createdAt: now,
      updatedAt: now
    });
  }

  builds.finish(build, {
    game: { id: game.id, title: spec.gameConfig.title, genre: spec.gameConfig.genre },
    spec,
    meta,
    credits: { charged: billed.charged, balance: billed.balance }
  });
}

/* --- poll + stop ---------------------------------------------------------- */

router.get('/build/:id', requireAuth, (req, res) => {
  const build = builds.get(req.params.id, req.user.id);
  if (!build) return res.status(404).json({ error: 'Build not found', code: 'not_found' });
  res.json(builds.view(build));
});

router.post('/build/:id/stop', requireAuth, (req, res) => {
  const build = builds.requestStop(req.params.id, req.user.id);
  if (!build) return res.status(404).json({ error: 'Build not found', code: 'not_found' });
  res.json(builds.view(build));
});

module.exports = router;
