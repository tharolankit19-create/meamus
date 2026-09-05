'use strict';

/**
 * In-flight builds.
 *
 * A build is not a request/response any more. The founder approves a plan, the
 * agents work through build -> review -> repair -> ship, and the browser polls
 * for progress so it can show what has been done and offer a stop button.
 *
 * State used to live only in memory, on the reasoning that a build outliving
 * its process was never going to finish anyway. That reasoning is true of one
 * long-lived server and false of this one. On a serverless host there is no
 * single process: the poll that follows a start can land on a different
 * instance, which has never heard of the build and answers 404, and the founder
 * watches a game that is finishing somewhere they cannot see. That is exactly
 * what production did - a real build stuck at "building" fifteen seconds in,
 * with the browser being told the build did not exist.
 *
 * So the memory map is now a cache in front of the game row, which is durable
 * and is the same row the founder's library reads. Whichever instance answers
 * the poll, it can see the build.
 */

const crypto = require('node:crypto');
const config = require('./../config');
const db = require('./../db');

/* Progress is written through to storage, but not on every single step: a
   build emits a couple of dozen and each one is a round trip. A step is
   flushed when the phase changes, when the build ends, or when this long has
   passed - which keeps the browser's picture within a poll of the truth. */
const FLUSH_MS = 1200;

const plans = new Map();   // planId  -> approved brief awaiting a start
const builds = new Map();  // buildId -> live build

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/* --- plans ---------------------------------------------------------------- */

/** Park an approved brief so start() cannot be called with different terms. */
function savePlan(userId, plan) {
  const planId = id('pln');
  plans.set(planId, { ...plan, planId, userId, createdAt: Date.now() });
  sweep();
  return planId;
}

function takePlan(planId, userId) {
  const plan = plans.get(planId);
  if (!plan) return null;
  if (plan.userId !== userId) return null;
  if (Date.now() - plan.createdAt > config.build.planTtlMs) {
    plans.delete(planId);
    return null;
  }
  plans.delete(planId);   // single use: an approval buys exactly one build
  return plan;
}

/* --- builds --------------------------------------------------------------- */

/**
 * @returns {{buildId:string, build:object}}
 */
function start(userId, { kind, prompt, gameId, estimate, plan }) {
  const buildId = id('bld');
  const build = {
    buildId,
    userId,
    kind,
    prompt,
    gameId: gameId || null,
    estimate,
    // The approved terms, so the request that actually does the work can pick
    // them up on any instance.
    plan: plan || null,
    claimed: false,
    state: 'running',
    steps: [],
    startedAt: Date.now(),
    finishedAt: null,
    stopRequested: false,
    result: null,
    error: null,
    lastFlush: 0
  };
  builds.set(buildId, build);
  flush(build, true);
  sweep();
  return { buildId, build };
}

/**
 * Write the build's progress onto its game row.
 *
 * Everything the browser polls for lives here, so any instance can answer.
 * The finished spec is deliberately NOT included - it is written to the row's
 * own `spec` field when the build lands, and copying a whole game into a
 * progress record would double the size of every write.
 */
function flush(build, force = false) {
  if (!build.gameId) return;
  const now = Date.now();
  if (!force && now - build.lastFlush < FLUSH_MS) return;
  build.lastFlush = now;

  try {
    db.update('games', build.gameId, {
      build: {
        buildId: build.buildId,
        state: build.state,
        kind: build.kind,
        steps: build.steps,
        startedAt: build.startedAt,
        finishedAt: build.finishedAt,
        estimate: build.estimate,
        stopRequested: build.stopRequested,
        error: build.error,
        plan: build.plan,
        claimed: build.claimed
      }
    });
  } catch (err) {
    // Losing progress is not worth losing the build over.
    console.error('[builds] could not persist progress:', err.message);
  }
}

/**
 * The build behind an id, from memory or from storage.
 *
 * The fallback is the whole point: on a serverless host the instance answering
 * this poll is usually not the one running the build.
 */
async function get(buildId, userId) {
  const build = builds.get(buildId);
  if (build) return build.userId === userId ? build : null;

  /* Straight from storage, not from this instance's cache.
     The cache is filled once at boot, so a build another instance created
     seconds ago is simply not in it - which is what "Build not found" was on a
     build that was running perfectly well somewhere else. */
  const game = await db.findFresh('games', `data->build->>buildId=eq.${encodeURIComponent(buildId)}`);
  if (!game || game.userId !== userId) return null;

  return {
    ...game.build,
    userId: game.userId,
    gameId: game.id,
    prompt: game.prompt,
    // A build nobody is running any more cannot still be running. The row is
    // the last thing the working instance managed to say.
    result: game.spec
      ? { game: { id: game.id, title: game.spec.gameConfig.title, genre: game.spec.gameConfig.genre },
        spec: game.spec, meta: game.meta, messages: game.messages || [] }
      : null,
    fromStorage: true
  };
}

/**
 * Fields a step may carry beyond its sentence.
 *
 * A whitelist, not a spread, for two reasons: every step is written onto the
 * game row, so an agent that started attaching a whole spec to its progress
 * would double the size of every write; and the browser renders these by name,
 * so what is allowed through is worth being able to read in one place.
 */
const STEP_FIELDS = [
  'agent',        // who is working - Designer, Coder, Tester, Reviewer, Improver
  'attempt',      // which try this is
  'total',        // out of how many
  'model',        // which model was asked
  'modelIndex',   // and where it sits on the roster, when the first one refused
  'modelCount',
  'file',         // what was written
  'lines',        // and how much of it
  'bytes',
  'scenes',       // what the tester booted
  'attempts',
  'mechanics'     // what the designer specified
];

/**
 * Append a progress line. This is what the chat renders while it works.
 *
 * `agent` is who is speaking - Designer, Coder, Tester, Reviewer, Improver.
 * The crew reports it; the single-model path does not, and those lines fall
 * back to the phase name.
 *
 * The numbers matter as much as the sentence. "Coder: writing the game" for
 * ninety seconds is indistinguishable from a hang, and a founder watching that
 * reasonably concludes the product is broken. The same ninety seconds shown as
 * "Coder · nemotron-3-super · attempt 2 · game.js, 340 lines" is a machine
 * working. So the fields go through rather than being flattened into prose.
 */
function step(build, fields = {}) {
  if (!build) return;
  const previous = build.steps[build.steps.length - 1];

  const entry = { at: Date.now() - build.startedAt, phase: fields.phase, detail: fields.detail };
  for (const key of STEP_FIELDS) {
    if (fields[key] !== undefined && fields[key] !== null) entry[key] = fields[key];
  }
  build.steps.push(entry);

  // A new phase is worth a write immediately; more of the same can wait.
  flush(build, !previous || previous.phase !== fields.phase);
}

function finish(build, result) {
  build.state = 'done';
  build.result = result;
  build.finishedAt = Date.now();
  flush(build, true);
}

function fail(build, error) {
  build.state = build.stopRequested ? 'stopped' : 'failed';
  build.error = error;
  build.finishedAt = Date.now();
  flush(build, true);
}

/**
 * Take ownership of a build's work, once.
 *
 * Two tabs, a retry, or a double-fired request must not build the same game
 * twice - each attempt costs the founder credits. The claim is written through
 * before the work starts, so the second caller sees it whichever instance it
 * lands on.
 *
 * @returns {boolean} true if this caller may do the work
 */
function claim(build) {
  if (!build || build.claimed) return false;
  build.claimed = true;
  flush(build, true);
  return true;
}

/**
 * Ask a build to stop.
 *
 * Cooperative: the model call in flight cannot be pulled back, so the loop
 * checks this flag between attempts and refuses to start another one. Saying
 * "stopping" and meaning it at the next boundary is honest; claiming the
 * current request was cancelled would not be.
 */
async function requestStop(buildId, userId) {
  const build = await get(buildId, userId);
  if (!build) return null;
  if (build.state !== 'running') return build;
  build.stopRequested = true;
  step(build, { phase: 'stopping', detail: 'Stopping after the current step' });
  flush(build, true);
  return build;
}

/** The shape the browser polls for. */
function view(build) {
  return {
    buildId: build.buildId,
    state: build.state,
    kind: build.kind,
    steps: build.steps,
    elapsedMs: (build.finishedAt || Date.now()) - build.startedAt,
    estimate: build.estimate,
    stopRequested: build.stopRequested,
    error: build.error,
    ...(build.result || {})
  };
}

/** Drop plans past their TTL and builds that finished over an hour ago. */
function sweep() {
  const now = Date.now();
  for (const [key, plan] of plans) {
    if (now - plan.createdAt > config.build.planTtlMs) plans.delete(key);
  }
  for (const [key, build] of builds) {
    if (build.finishedAt && now - build.finishedAt > 60 * 60 * 1000) builds.delete(key);
  }
}

/** Test hook. */
function reset() { plans.clear(); builds.clear(); }

module.exports = {
  savePlan, takePlan, start, get, claim, step, finish, fail, requestStop, view, flush, reset,
  STEP_FIELDS
};
