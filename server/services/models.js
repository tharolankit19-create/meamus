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
 * Every free model OpenRouter carries, in the order they should be asked.
 *
 * Checked against the live catalogue by `npm run models:check`, which fails if
 * a model has disappeared, changed its output ceiling or schema support, or if
 * a new free model has shown up that is not listed here. The lists are static
 * rather than fetched at boot on purpose: routing has to be the same on every
 * instance and testable without a network, and a catalogue that changes under
 * the product is how you get a build that behaves differently each time.
 *
 * Ordering, and what it is based on:
 *
 *  1. Schema support first. Without it the spec has to be scraped out of prose,
 *     which is where malformed games come from - a model that cannot be held to
 *     the schema is not cheaper, it just fails later.
 *  2. Among those, measurement beats reputation. Across nine watched production
 *     builds:
 *
 *       dots-3-note-preview   4 complete games (726, 536, 500, 477 lines)
 *       nemotron-3-super      0 complete games in ~18 attempts, cut off at
 *                             roughly line 150 every time
 *
 *     so dots-3 leads and nemotron sits behind the other schema model. nemotron
 *     still leads BRIEF, where the job is a page of JSON in a few seconds and
 *     the thing it is bad at is never asked for.
 *  3. Then the code-named models. `north-mini-code` and the `laguna` pair are
 *     the ones whose vendor and name say they are built for code - that is a
 *     weaker signal than a measurement and it is ranked as such, above general
 *     models of similar size and below anything actually observed working.
 *  4. Then general models by output ceiling, because running out of room is the
 *     failure this pipeline sees most.
 *  5. Small models last. 8k of output can still hold a short game, so they are
 *     a real fallback rather than filler - but they are asked last.
 *
 *  One model is deliberately not here: `nvidia/nemotron-3.5-content-safety` is
 *  a safety classifier, not a writer. Asking it for a Phaser game spends a
 *  request to be told no. Every other free model is on one of these lists.
 */
const CODER = [
  // Schema, and the only model measured finishing games.
  { id: 'dots-studio/dots-3-note-preview:free', schema: true, out: 460800, why: 'schema, 461k output, four complete games' },
  { id: 'z-ai/glm-5.2:free', schema: true, out: 230400, why: 'schema + 230k output' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', schema: true, out: 235929, why: 'schema, but has never finished a game' },

  // Built for code, by name and vendor - a weaker signal than a measurement.
  { id: 'cohere/north-mini-code:free', schema: false, out: 64000, why: 'a code model' },
  { id: 'poolside/laguna-s-2.1:free', schema: false, out: 32768, why: 'a code model' },
  { id: 'poolside/laguna-xs-2.1:free', schema: false, out: 32768, why: 'a code model, smaller' },

  // General models, most output room first.
  { id: 'minimax/minimax-m3:free', schema: false, out: 943718, why: '944k output' },
  { id: 'thinkingmachines/inkling:free', schema: false, out: 262144, why: '262k output' },
  { id: 'thinkingmachines/inkling-small:free', schema: false, out: 262144, why: '262k output, smaller' },
  { id: 'minimax/minimax-m2.7:free', schema: false, out: 176947, why: '177k output' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', schema: false, out: 65536, why: '1M context' },
  { id: 'nvidia/nemotron-3.5-lightning:free', schema: false, out: 65536, why: '1M context, quick' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', schema: false, out: 65536, why: 'reasoning' },
  { id: 'google/gemma-4-31b-it:free', schema: false, out: 32768, why: 'general' },
  { id: 'google/gemma-4-26b-a4b-it:free', schema: false, out: 32768, why: 'general, smaller' },
  { id: 'inclusionai/ling-3.0-flash-fin:free', schema: false, out: 32768, why: 'general, finance-tuned' },
  { id: 'inclusionai/ling-3.0-flash-sante:free', schema: false, out: 32768, why: 'general, health-tuned' },

  // 8k of output is a short game, not no game.
  { id: 'liquid/lfm-2.5-2.6b:free', schema: true, out: 8192, why: 'schema, but only 8k output' }
];

/* A brief is a page of JSON. Output ceiling is irrelevant and turnaround is
   everything, so this is ordered by how fast the answer comes back and whether
   it can be held to a schema - the opposite priorities to CODER, which is why
   it is a separate list rather than the same one reused. */
const BRIEF = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', schema: true, out: 235929, why: 'schema, answers a brief in seconds' },
  { id: 'z-ai/glm-5.2:free', schema: true, out: 230400, why: 'schema' },
  { id: 'liquid/lfm-2.5-2.6b:free', schema: true, out: 8192, why: 'schema, small and quick' },
  { id: 'dots-studio/dots-3-note-preview:free', schema: true, out: 460800, why: 'schema, but slow' },
  { id: 'nvidia/nemotron-3.5-lightning:free', schema: false, out: 65536, why: 'quick' },
  { id: 'google/gemma-4-26b-a4b-it:free', schema: false, out: 32768, why: 'small' },
  { id: 'google/gemma-4-31b-it:free', schema: false, out: 32768, why: 'small' },
  { id: 'inclusionai/ling-3.0-flash-fin:free', schema: false, out: 32768, why: 'flash' },
  { id: 'inclusionai/ling-3.0-flash-sante:free', schema: false, out: 32768, why: 'flash' },
  { id: 'cohere/north-mini-code:free', schema: false, out: 64000, why: 'fallback' },
  { id: 'poolside/laguna-xs-2.1:free', schema: false, out: 32768, why: 'fallback' },
  { id: 'poolside/laguna-s-2.1:free', schema: false, out: 32768, why: 'fallback' },
  { id: 'minimax/minimax-m2.7:free', schema: false, out: 176947, why: 'fallback' },
  { id: 'thinkingmachines/inkling-small:free', schema: false, out: 262144, why: 'fallback' },
  { id: 'thinkingmachines/inkling:free', schema: false, out: 262144, why: 'fallback' },
  { id: 'minimax/minimax-m3:free', schema: false, out: 943718, why: 'fallback' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', schema: false, out: 65536, why: 'fallback' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', schema: false, out: 65536, why: 'fallback' }
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
