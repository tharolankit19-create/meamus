'use strict';

/**
 * What a build will cost, and roughly how long it will take, before it runs.
 *
 * The founder confirms a build once, with a number in front of them. That
 * number has to come from the same arithmetic the charge uses, or the
 * confirmation is theatre.
 *
 * Pricing: CREDITS_PER_MTOK credits per million tokens, input and output
 * counted the same. A build is not one model call - the review loop can send
 * the work back up to MAX_BUILD_ATTEMPTS times - so the estimate quotes a
 * range, and the charge is taken on real usage afterwards.
 */

const config = require('./../config');

/** Token shapes measured from real builds of the bundled templates. */
const SHAPE = {
  // The brief, the schema, the research block and the system prompt.
  promptTokens: 3200,
  // A complete 600-800 line game plus its spec envelope.
  completionTokens: 14000,
  // A change re-sends the current spec and returns a whole new one.
  editPromptTokens: 9000,
  editCompletionTokens: 12000
};

/** Output tokens per second, measured against Nemotron 3.5 Lightning. */
const TOKENS_PER_SECOND = 95;

/**
 * Token cost, floored at the flat per-job price.
 *
 * A short build can come in under a credit on tokens alone, which would make
 * the product free by accident. The floor is what the plans are priced around;
 * the token rate is what a large build actually costs.
 */
function creditsFor(tokens, kind) {
  const byTokens = Math.round((tokens / 1e6) * config.credits.perMillionTokens);
  const floor = kind === 'iterate' ? config.credits.costIterate : config.credits.costCreate;
  return Math.max(floor, byTokens);
}

/**
 * @param {'create'|'iterate'} kind
 * @param {object} [opts]
 * @param {number} [opts.attachments] each attachment adds to the prompt
 * @param {number} [opts.promptChars] length of what the founder typed
 * @returns {object} the shape the confirmation dialog renders
 */
function estimate(kind, opts = {}) {
  const isEdit = kind === 'iterate';
  const attachmentTokens = (opts.attachments || 0) * 700;
  const typedTokens = Math.ceil((opts.promptChars || 0) / 4);

  const promptTokens = (isEdit ? SHAPE.editPromptTokens : SHAPE.promptTokens) + attachmentTokens + typedTokens;
  const completionTokens = isEdit ? SHAPE.editCompletionTokens : SHAPE.completionTokens;
  const oneAttempt = promptTokens + completionTokens;

  // Best case is one clean attempt. Worst case is the review loop using its
  // full budget, which is what the founder is really agreeing to.
  const attempts = Math.max(1, config.build.maxAttempts);
  const worstTokens = oneAttempt * attempts;

  const seconds = Math.round(completionTokens / TOKENS_PER_SECOND);

  return {
    kind,
    pricePerMillionTokens: config.credits.perMillionTokens,
    tokens: { expected: oneAttempt, worstCase: worstTokens, prompt: promptTokens, completion: completionTokens },
    credits: { expected: creditsFor(oneAttempt, kind), worstCase: creditsFor(worstTokens, kind) },
    floor: isEdit ? config.credits.costIterate : config.credits.costCreate,
    seconds: { expected: seconds, worstCase: seconds * attempts },
    attempts,
    note: `${config.credits.perMillionTokens} credits per million tokens, with a `
      + `${isEdit ? config.credits.costIterate : config.credits.costCreate}-credit minimum. `
      + `You are charged on what the build actually uses. The worst case is the review loop needing all ${attempts} attempts.`
  };
}

/** Credits actually owed for a finished build, from the reported usage. */
function creditsForUsage(usage, kind) {
  const total = usage
    ? (usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
    : 0;
  return creditsFor(total, kind);
}

module.exports = { estimate, creditsForUsage, creditsFor, SHAPE, TOKENS_PER_SECOND };
