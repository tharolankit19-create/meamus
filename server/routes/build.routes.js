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
const agents = require('../services/agents');
const hype = require('../services/hype');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();
const MAX_VERSIONS = 10;
const MAX_MESSAGES = 200;

const message = (role, text, extra = {}) => ({
  id: db.id('msg'), role, text, createdAt: new Date().toISOString(), ...extra
});

const appendMessage = (game, entry) =>
  [...((game && game.messages) || []), entry].slice(-MAX_MESSAGES);

/** A one-line summary of what the build produced, for the chat. */
function describeBuild(spec, meta) {
  const bits = [
    `${spec.gameConfig.genre} · ${spec.gameConfig.difficulty}`,
    `${spec.gameCode.javascript.split('\n').length} lines`,
    `${spec.assets.sprites.length} sprites`,
    `${spec.mechanics.length} mechanics`
  ];
  if (meta.attempts > 1) bits.push(`${meta.attempts} attempts`);
  return bits.join(' · ');
}

/**
 * The assistant turn a finished build leaves in the thread.
 *
 * The crew's own account of what it did is the body, because "what did you
 * actually change?" is the first thing anyone asks and a stats line does not
 * answer it. The stats line survives as a subtitle, and the transcript rides
 * along so re-opening the project replays who did what instead of showing an
 * empty chat above a finished game.
 */
function buildMessage(spec, meta, kind) {
  const stats = describeBuild(spec, meta);
  const body = meta.crew ? agents.summarise(meta) : stats;
  return message('assistant', body, {
    title: spec.gameConfig.title,
    kind,
    mode: meta.mode,
    stats,
    crew: meta.crew === true,
    transcript: meta.transcript || null,
    issues: (meta.issues || []).length ? meta.issues : null
  });
}

/**
 * A readable name for the row that exists before the model has named the game.
 * Replaced by the real title the moment the build lands.
 */
function titleFromPrompt(prompt) {
  const cleaned = String(prompt || '')
    .replace(/^(make|create|build|generate|i want|give me)\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/[^a-zA-Z0-9 '-]/g, ' ')
    .trim();
  if (cleaned.length < 3) return 'New game';
  const words = cleaned.split(/\s+/).slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return words.join(' ') || 'New game';
}

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

  // A new game gets its row NOW, before a single token is spent.
  //
  // It used to be inserted only when the build finished, so closing the tab
  // mid-build lost the game entirely - it never appeared under My games and
  // there was nothing to come back to. The row exists from the start, marked
  // building, and the build fills it in.
  let gameId = plan.gameId;
  if (!gameId) {
    const now = new Date().toISOString();
    const placeholder = db.insert('games', {
      id: db.id('gam'),
      userId: req.user.id,
      prompt: plan.prompt,
      title: titleFromPrompt(plan.prompt),
      status: 'building',
      spec: null,
      meta: null,
      versions: [],
      messages: [message('user', plan.prompt)],
      isPublic: false,
      createdAt: now,
      updatedAt: now
    });
    gameId = placeholder.id;
  }

  const { buildId, build } = builds.start(req.user.id, {
    kind: plan.kind, prompt: plan.prompt, gameId, estimate: plan.estimate
  });

  // The gameId comes back immediately so the browser can open the workspace
  // and watch the build there, rather than waiting on the dashboard.
  res.status(202).json({ buildId, gameId, state: build.state, estimate: plan.estimate });

  run(build, plan, req.user).catch((err) => {
    builds.fail(build, err.message);
  });
}));

/**
 * The ship phase, one line per artifact.
 *
 * Counted off the finished spec, so "6 sprites" means the spec holds six. An
 * artifact with nothing in it is skipped rather than reported as empty.
 */
function shipSteps(build, spec) {
  const say = (detail) => builds.step(build, { phase: 'ship', detail, agent: 'Bundler' });
  const lines = spec.gameCode.javascript.split('\n').length;

  say(`Saving game.js — ${lines} lines`);
  if (spec.assets.sprites.length) {
    say(`Saving ${spec.assets.sprites.length} sprite${spec.assets.sprites.length > 1 ? 's' : ''} — drawn in code`);
  }
  const audio = (spec.assets && spec.assets.audio) || [];
  if (audio.length) say(`Saving ${audio.length} sound cue${audio.length > 1 ? 's' : ''} — synthesised at runtime`);
  say(`Bundling index.html — ${spec.gameConfig.title}`);
}

/**
 * The build itself. Runs after the response has been sent, reporting each
 * phase into the build so the chat can show what is happening.
 */
async function run(build, plan, user) {
  const attachments = uploads.resolve(plan.attachmentIds, user.id);
  const onStep = (s) => {
    if (build.stopRequested) return;
    builds.step(build, {
      phase: s.phase, detail: s.detail, agent: s.agent, attempt: s.attempt, total: s.total
    });
  };

  builds.step(build, { phase: 'analyse', detail: 'Reading the brief' });
  if (build.stopRequested) return builds.fail(build, 'Stopped before the model was called');

  const existing = db.find('games', (g) => g.id === build.gameId);

  let spec;
  let meta;
  try {
    ({ spec, meta } = plan.kind === 'iterate'
      ? await generator.modify(plan.prompt, existing.spec, { attachments, onStep })
      : await generator.generate(plan.prompt, { attachments, onStep }));
  } catch (err) {
    // The row already exists, so it has to say what happened rather than sit
    // in "building" forever.
    if (plan.kind === 'create') {
      db.update('games', build.gameId, { status: 'failed', error: err.message });
    }
    throw err;
  }

  if (build.stopRequested) {
    if (plan.kind === 'create') db.update('games', build.gameId, { status: 'stopped' });
    return builds.fail(build, 'Stopped after the build finished but before it was saved');
  }

  // Name what was actually produced, one line per artifact.
  //
  // "Bundling…" for four seconds tells the founder nothing. These lines are
  // written after the fact, from the finished spec, so every number in them is
  // real - nothing here is a progress bar pretending to know the future.
  shipSteps(build, spec);

  // Charge on real usage, only now that there is a game to charge for.
  const owed = estimator.creditsForUsage(meta.usage, plan.kind);
  const billed = credits.chargeExact(user, owed);

  let game;

  if (plan.kind === 'iterate') {
    const versions = [
      { spec: existing.spec, meta: existing.meta, instruction: null, savedAt: existing.updatedAt },
      ...(existing.versions || [])
    ].slice(0, MAX_VERSIONS);
    game = db.update('games', existing.id, {
      spec,
      meta: { ...meta, lastInstruction: plan.prompt },
      versions,
      status: 'ready',
      messages: appendMessage(existing, buildMessage(spec, meta, 'edit'))
    });
  } else {
    game = db.update('games', build.gameId, {
      spec,
      meta,
      status: 'ready',
      title: spec.gameConfig.title,
      messages: appendMessage(existing, buildMessage(spec, meta, 'build'))
    });
  }

  builds.finish(build, {
    game: { id: game.id, title: spec.gameConfig.title, genre: spec.gameConfig.genre },
    spec,
    meta,
    // The thread as it now stands, so the watching screen shows the same chat
    // a reload would show rather than a version only it knows about.
    messages: game.messages || [],
    // What the popup says if the founder is elsewhere when this lands.
    hype: hype.lineFor(spec, game.id),
    summary: meta.crew ? agents.summarise(meta) : describeBuild(spec, meta),
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
