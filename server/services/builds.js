'use strict';

/**
 * In-flight builds.
 *
 * A build is not a request/response any more. The founder approves a plan, the
 * agents work through build -> review -> repair -> ship, and the browser polls
 * for progress so it can show what has been done and offer a stop button.
 *
 * State lives in memory on purpose. A build that outlives the process was
 * never going to finish anyway, and the finished game is written to storage the
 * moment it exists, so nothing durable is lost when a build is dropped.
 */

const crypto = require('node:crypto');
const config = require('./../config');

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
function start(userId, { kind, prompt, gameId, estimate }) {
  const buildId = id('bld');
  const build = {
    buildId,
    userId,
    kind,
    prompt,
    gameId: gameId || null,
    estimate,
    state: 'running',
    steps: [],
    startedAt: Date.now(),
    finishedAt: null,
    stopRequested: false,
    result: null,
    error: null
  };
  builds.set(buildId, build);
  sweep();
  return { buildId, build };
}

function get(buildId, userId) {
  const build = builds.get(buildId);
  if (!build || build.userId !== userId) return null;
  return build;
}

/**
 * Append a progress line. This is what the chat renders while it works.
 *
 * `agent` is who is speaking - Designer, Coder, Tester, Reviewer, Improver.
 * The crew reports it; the single-model path does not, and those lines fall
 * back to the phase name.
 */
function step(build, { phase, detail, attempt, total, agent }) {
  if (!build) return;
  build.steps.push({
    at: Date.now() - build.startedAt,
    phase,
    detail,
    agent: agent || null,
    attempt: attempt || null,
    total: total || null
  });
}

function finish(build, result) {
  build.state = 'done';
  build.result = result;
  build.finishedAt = Date.now();
}

function fail(build, error) {
  build.state = build.stopRequested ? 'stopped' : 'failed';
  build.error = error;
  build.finishedAt = Date.now();
}

/**
 * Ask a build to stop.
 *
 * Cooperative: the model call in flight cannot be pulled back, so the loop
 * checks this flag between attempts and refuses to start another one. Saying
 * "stopping" and meaning it at the next boundary is honest; claiming the
 * current request was cancelled would not be.
 */
function requestStop(buildId, userId) {
  const build = get(buildId, userId);
  if (!build) return null;
  if (build.state !== 'running') return build;
  build.stopRequested = true;
  step(build, { phase: 'stopping', detail: 'Stopping after the current step' });
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

module.exports = { savePlan, takePlan, start, get, step, finish, fail, requestStop, view, reset };
