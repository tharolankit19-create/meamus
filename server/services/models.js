'use strict';

/**
 * Which model does which job, and what to do when one will not answer.
 *
 * A single model was a single point of failure. When its free tier ran out for
 * the day the whole product stopped: the designer could not write a brief, so
 * no build got as far as the coder, and every founder got the fallback game.
 * OpenRouter carries a dozen free models and there is no reason to sit on one.
 *
 * Two jobs, two different shapes of model:
 *
 *   coder   writes a whole game in one answer. Wants the largest output
 *           capacity available, and a JSON schema so the spec comes back in
 *           the right shape rather than being scraped out of prose.
 *   brief   the designer and the reviewer. A page of JSON, so output capacity
 *           is irrelevant and turnaround matters more.
 *
 * The order below is by capability that can actually be checked - output
 * ceiling and schema support, read from OpenRouter's own catalogue - not by
 * anybody's opinion of which model writes nicer code. Where two are close, the
 * one with more room to finish a long file goes first, because running out of
 * room is the failure this pipeline sees most.
 */

const config = require('./../config');

/**
 * @typedef {object} Candidate
 * @property {string} id      OpenRouter model id
 * @property {boolean} schema does it honour response_format + structured_outputs
 * @property {number} out     max completion tokens
 * @property {string} why     why it is in this position
 */

/**
 * Verified against the live OpenRouter catalogue. See scripts/models-check.js.
 *
 * Ordering, and the reasoning behind it:
 *
 *  1. Schema support first. Without it the spec has to be scraped out of prose,
 *     which is where malformed games come from - a model that cannot be held to
 *     the schema is not cheaper, it just fails later.
 *  2. Among those, the one we have actually watched write a running game goes
 *     first. That is nemotron-3-super: it is what production has been using, it
 *     produces games, and its failure mode has been the daily cap rather than
 *     bad code. The others are ranked on output ceiling, which is measurable,
 *     because running out of room is the failure this pipeline sees most.
 *  3. Non-schema models last, largest output first. They need the JSON scraping
 *     back out, so they are a fallback, not a peer - but a game scraped out of
 *     prose beats no game.
 */
const CODER = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', schema: true, out: 235929, why: 'schema, 236k output, proven in production' },
  { id: 'dots-studio/dots-3-note-preview:free', schema: true, out: 460800, why: 'schema + 461k output' },
  { id: 'z-ai/glm-5.2:free', schema: true, out: 230400, why: 'schema + 230k output' },
  { id: 'minimax/minimax-m3:free', schema: false, out: 943718, why: 'no schema, very large output' },
  { id: 'thinkingmachines/inkling:free', schema: false, out: 262144, why: 'no schema, 262k output' },
  { id: 'minimax/minimax-m2.7:free', schema: false, out: 176947, why: 'no schema, 177k output' }
];

/** A brief is a page of JSON. Anything that answers reliably will do. */
const BRIEF = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', schema: true, out: 235929, why: 'schema' },
  { id: 'z-ai/glm-5.2:free', schema: true, out: 230400, why: 'schema' },
  { id: 'liquid/lfm-2.5-2.6b:free', schema: true, out: 8192, why: 'small and quick' },
  { id: 'minimax/minimax-m2.7:free', schema: false, out: 176947, why: 'fallback' }
];

const ROSTER = { coder: CODER, brief: BRIEF };

/**
 * Models that have told us to go away, and until when.
 *
 * A daily cap is worth remembering across builds - re-discovering it costs a
 * request the founder does not have - while a per-minute limit clears on its
 * own and is only worth skipping for the rest of this build.
 */
const benched = new Map();   // model id -> timestamp it becomes usable again

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Bench a model that will not serve.
 *
 * @param {string} id
 * @param {'daily'|'rate'|'error'} reason
 * @param {number} [forMs] the provider's own Retry-After, when it sent one.
 *        Believe it over the default: a provider saying "come back in 12
 *        seconds" knows something this table is only guessing at. It is capped
 *        at an hour so a bad header cannot bench a model for a week, and it
 *        does not override a daily cap, which is measured in hours whatever
 *        the header says.
 */
function bench(id, reason, forMs) {
  const fallback = reason === 'daily' ? DAY_MS : reason === 'rate' ? 5 * MINUTE_MS : MINUTE_MS;
  const wait = reason !== 'daily' && forMs > 0 ? Math.min(forMs, 60 * MINUTE_MS) : fallback;
  const until = Date.now() + wait;
  const existing = benched.get(id) || 0;
  if (until > existing) benched.set(id, until);
}

function available(id) {
  const until = benched.get(id);
  if (!until) return true;
  if (Date.now() >= until) { benched.delete(id); return true; }
  return false;
}

/**
 * The models to try for a job, best first, skipping anything benched.
 *
 * A model the operator pinned with OPENROUTER_MODEL always goes first: an
 * explicit setting is an instruction, not a suggestion. The rest of the roster
 * still follows it as fallback, because "the model you chose is rate limited"
 * is not a reason to have no product.
 *
 * @param {'coder'|'brief'} role
 * @returns {Candidate[]} never empty - if everything is benched, the roster is
 *          returned anyway, because trying and failing beats refusing to try
 */
function candidates(role) {
  const roster = ROSTER[role] || CODER;
  const pinned = (process.env.OPENROUTER_MODEL || '').trim();

  const list = pinned
    ? [
      { id: pinned, schema: true, out: 0, why: 'set by OPENROUTER_MODEL' },
      ...roster.filter((m) => m.id !== pinned)
    ]
    : roster.slice();

  const usable = list.filter((m) => available(m.id));
  return usable.length ? usable : list;
}

/** What is currently benched, for /api/status and for the tests. */
function benchedNow() {
  const now = Date.now();
  return [...benched.entries()]
    .filter(([, until]) => until > now)
    .map(([id, until]) => ({ id, forMs: until - now }));
}

/** Test hook. */
function reset() { benched.clear(); }

module.exports = {
  candidates, bench, available, benchedNow, reset, ROSTER, CODER, BRIEF, DAY_MS
};
