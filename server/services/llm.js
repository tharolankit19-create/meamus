'use strict';

/**
 * LLM provider layer.
 *
 * OpenRouter is the default and speaks the OpenAI chat-completions shape.
 * The Anthropic path is kept so an existing key keeps working; nothing above
 * this module knows which one is active.
 *
 * Two things this layer owns that callers should not re-derive:
 *  - model capabilities (can it read images? does it honour a JSON schema?),
 *    detected from the OpenRouter catalogue and cached
 *  - structured outputs, which is what keeps a small model emitting a spec
 *    that parses on the first try
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const models = require('./models');
const { AsyncLocalStorage } = require('node:async_hooks');
const budgets = new AsyncLocalStorage();

function remainingMs() {
  return budgets.getStore() ? budgets.getStore() - Date.now() : config.llm.timeoutMs;
}

function withBudget(work) {
  return budgets.run(Date.now() + config.build.budgetMs, work);
}
const { RESPONSE_FORMAT } = require('./schema');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system.md'), 'utf8');

class LlmError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'LlmError';
    this.status = status || 502;
    this.details = details;
  }
}

/* ------------------------------------------------------------------------ */
/* Capabilities                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Fallback capability table for when the catalogue cannot be reached.
 * Anything unknown is assumed text-only with no schema support, because
 * guessing "yes" produces a hard 400 while guessing "no" merely loses a
 * feature.
 */
const KNOWN = {
  'nvidia/nemotron-3.5-lightning': { images: false, structuredOutputs: true },
  'nvidia/nemotron-3.5-lightning:free': { images: false, structuredOutputs: false },
  'nvidia/nemotron-3-ultra-550b-a55b': { images: false, structuredOutputs: true },
  'nvidia/nemotron-3-super-120b-a12b': { images: false, structuredOutputs: true },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': { images: true, structuredOutputs: false }
};

/**
 * Capabilities, per model.
 *
 * This used to be one cached answer for one configured model, which was fine
 * while there was one model. Routing means asking a different model the moment
 * the first will not serve, and asking it for a JSON schema it does not support
 * is a hard 400 - so the answer has to be per model, and the catalogue is worth
 * fetching once and reading many times.
 */
const capabilityCache = new Map();   // model id -> capabilities
let cataloguePromise = null;

function staticCapabilities(model) {
  if (KNOWN[model]) return { ...KNOWN[model], source: 'static' };
  // Anthropic and the OpenAI-style majors all take images.
  if (/^(anthropic\/|claude)/.test(model)) return { images: true, structuredOutputs: false, source: 'static' };
  // A roster entry carries what the catalogue said when it was written down,
  // which beats assuming "no" and losing the schema for the whole build.
  const listed = [...models.CODER, ...models.BRIEF].find((m) => m.id === model);
  if (listed) return { images: false, structuredOutputs: listed.schema, maxOutput: listed.out, source: 'roster' };
  return { images: false, structuredOutputs: false, source: 'assumed' };
}

/** The OpenRouter catalogue, fetched at most once per process. */
async function catalogue() {
  if (cataloguePromise) return cataloguePromise;
  cataloguePromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${config.llm.baseUrl}/models`, { signal: controller.signal });
      if (!response.ok) throw new Error(`catalogue returned ${response.status}`);
      const { data } = await response.json();
      return data || [];
    } finally {
      clearTimeout(timer);
    }
  })().catch((err) => {
    // One failed fetch must not make every later lookup wait on a dead promise,
    // and it must not take generation down either: fall back to the table.
    cataloguePromise = null;
    return { error: err.message };
  });
  return cataloguePromise;
}

/**
 * What a model can do. Defaults to the configured model so existing callers -
 * and /api/status - keep working unchanged.
 *
 * A catalogue outage falls back to the static table rather than throwing,
 * because not knowing whether a model reads images must not stop it writing a
 * game.
 */
async function capabilities(model = config.llm.model) {
  if (capabilityCache.has(model)) return capabilityCache.get(model);

  if (config.llm.provider !== 'openrouter') {
    const caps = staticCapabilities(model);
    capabilityCache.set(model, caps);
    return caps;
  }

  const list = await catalogue();
  let caps;
  if (Array.isArray(list)) {
    const entry = list.find((m) => m.id === model);
    if (entry) {
      const modalities = (entry.architecture && entry.architecture.input_modalities) || [];
      const params = entry.supported_parameters || [];
      caps = {
        images: modalities.includes('image'),
        structuredOutputs: params.includes('structured_outputs') && params.includes('response_format'),
        contextLength: entry.context_length,
        maxOutput: entry.top_provider && entry.top_provider.max_completion_tokens,
        source: 'catalogue'
      };
    } else {
      caps = staticCapabilities(model);
      caps.detectionError = `model ${model} is not in the catalogue`;
    }
  } else {
    caps = staticCapabilities(model);
    caps.detectionError = list.error;
  }

  capabilityCache.set(model, caps);
  return caps;
}

/* ------------------------------------------------------------------------ */
/* Message construction                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Build a user message from text plus resolved attachments.
 *
 * Text files are always folded into the prompt. Images become native image
 * parts only when the model can read them; otherwise they are named in the
 * text and reported back through `ignoredImages` so the caller can tell the
 * user rather than silently dropping their reference art.
 *
 * @param {string} text
 * @param {Array<{kind:string, mime:string, base64:string, text:string, name:string}>} [attachments]
 * @param {{images:boolean}} caps
 */
function buildUserMessage(text, attachments = [], caps = { images: false }) {
  const images = attachments.filter((a) => a.kind === 'image' && a.base64);
  const files = attachments.filter((a) => a.kind === 'text' && a.text);

  let body = text;

  if (files.length) {
    body += `\n\nAttached files:\n${files.map((f) => `--- ${f.name} ---\n${f.text}`).join('\n\n')}`;
  }

  if (images.length && caps.images) {
    body += `\n\n${images.length} reference image${images.length === 1 ? ' is' : 's are'} attached. ` +
      'Match the art direction, palette, layout and mood they show in the procedural graphics you generate.';
  } else if (images.length) {
    body += `\n\nThe user attached ${images.length} reference image${images.length === 1 ? '' : 's'} ` +
      `(${images.map((i) => i.name).join(', ')}) that this model cannot read. ` +
      'Infer the art direction from the written prompt alone and keep the palette coherent.';
  }

  const ignoredImages = caps.images ? [] : images.map((i) => i.name);

  if (config.llm.provider === 'anthropic') {
    const content = [
      ...(caps.images ? images.map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mime, data: image.base64 }
      })) : []),
      { type: 'text', text: body }
    ];
    return { message: { role: 'user', content }, ignoredImages };
  }

  // OpenAI / OpenRouter shape.
  if (!caps.images || !images.length) {
    return { message: { role: 'user', content: body }, ignoredImages };
  }
  return {
    message: {
      role: 'user',
      content: [
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.base64}` }
        })),
        { type: 'text', text: body }
      ]
    },
    ignoredImages
  };
}

/* ------------------------------------------------------------------------ */
/* Requests                                                                  */
/* ------------------------------------------------------------------------ */

async function post(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const remaining = Math.min(remainingMs(), timeoutMs || Infinity);
  if (remaining <= 0) {
    /* Not this model's fault, and not fixable by asking a different one - the
       whole build is out of time. Marked so the roster walk stops here instead
       of spending what is left discovering the same thing five more times. */
    throw new LlmError('The build time limit was reached. Try a simpler game prompt.', 504,
      { budgetExhausted: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.min(config.llm.timeoutMs, remaining));
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });
    // Keep the abort timer alive through OpenRouter's delayed response body.
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError('The model took too long to answer', 504);
    throw new LlmError(`Could not reach ${config.llm.provider}: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a rate limit should say.
 *
 * On a `:free` model this is not an edge case, it is the failure. OpenRouter
 * caps the free tier per minute and per day, and a build is three to five calls
 * deep, so a founder can hit it halfway through their second game. "openrouter
 * error (429): rate limit exceeded" tells them nothing they can act on, so this
 * names the tier they are on and the two ways out.
 */
/** A daily cap does not clear by waiting, so it is worth telling apart. */
function isDailyCap(detail) {
  return /per-?day|daily limit|free-models-per-day/i.test(String(detail));
}

/* With a roster, one model refusing is no longer the end of the build - the
   next one is asked - so this text only reaches the founder when every model
   said the same thing. It names which model refused (the attempt list names
   them all) and keeps the one instruction that changes the outcome: on a daily
   cap, credit raises the free tier from 50 requests a day to 1000. */
function rateLimitMessage(detail, model = config.llm.model) {
  if (isDailyCap(detail)) {
    return `${model} has used up today's free requests - a daily cap, not a short pause, `
      + 'so waiting will not clear it until it resets. $10 of credit at '
      + 'https://openrouter.ai/credits raises the free tier from 50 requests a day to 1000 '
      + `and still costs nothing per request. (${detail})`;
  }
  return `${model} is rate limited right now - please try again shortly. (${detail})`;
}

/** Some providers say when to come back. Believe them over a fixed guess. */
function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(value) - Date.now()) || 0;
}

async function readError(response) {
  const text = await response.text();
  let detail = text.slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || detail;
  } catch { /* keep the raw body */ }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

async function callOpenRouter({ messages, system, maxTokens, jsonSchema, model = config.llm.model, timeoutMs }) {
  const payload = {
    model,
    max_tokens: maxTokens || config.llm.maxTokens,
    temperature: config.llm.temperature,
    messages: [{ role: 'system', content: system }, ...messages]
  };
  if (jsonSchema) payload.response_format = RESPONSE_FORMAT;

  /* Reasoning tokens are spent out of max_tokens, before a single character of
     the answer is written.

     This cost three failed builds in production the day the default model
     changed to a reasoning one: the designer's 2000-token budget went entirely
     on thinking and returned an unterminated JSON object, and the coder's game
     was cut off mid-function with "does not parse: Unexpected end of input".
     Neither error mentions reasoning, which is what made it worth a comment.

     These calls do not benefit from it. The answer is a JSON document whose
     shape is already pinned by a schema, and the thinking is discarded. So it
     is off unless someone deliberately turns it back on. */
  if (config.llm.reasoning === false) payload.reasoning = { enabled: false };
  else if (config.llm.reasoning) payload.reasoning = { effort: config.llm.reasoning };

  let response = await post(`${config.llm.baseUrl}/chat/completions`, {
    authorization: `Bearer ${config.llm.apiKey}`,
    // OpenRouter uses these for attribution on its dashboard and leaderboards.
    'HTTP-Referer': config.llm.referer,
    'X-Title': config.llm.title
  }, payload, timeoutMs);

  // Not every deployment of a model honours response_format. One retry without
  // it beats failing the generation outright.
  if (!response.ok && jsonSchema && (response.status === 400 || response.status === 422)) {
    delete payload.response_format;
    response = await post(`${config.llm.baseUrl}/chat/completions`, {
      authorization: `Bearer ${config.llm.apiKey}`,
      'HTTP-Referer': config.llm.referer,
      'X-Title': config.llm.title
    }, payload, timeoutMs);
  }

  if (!response.ok) {
    const detail = await readError(response);
    if (response.status === 429) {
      // 429s are retried a layer up, which is right for a per-minute cap and
      // pointless for a per-day one: it burns the founder's remaining time
      // waiting for something that resets tomorrow. 402 marks it as final.
      throw new LlmError(rateLimitMessage(detail, model), isDailyCap(detail) ? 402 : 429,
        { retryAfterMs: retryAfterMs(response) });
    }
    const status = response.status === 402 ? 402 : response.status === 401 || response.status === 403 ? 401
      : response.status >= 500 ? 502 : 400;
    throw new LlmError(`${model} returned ${response.status}: ${detail}`, status);
  }

  const payloadBody = await response.json();
  if (payloadBody.error) {
    const code = Number(payloadBody.error.code) || 502;
    const detail = String(payloadBody.error.message || 'Provider failed');
    throw new LlmError(code === 429 ? rateLimitMessage(detail, model) : `${model}: ${detail}`,
      code === 429 && isDailyCap(detail) ? 402 : code >= 500 ? 502 : code);
  }
  const choice = (payloadBody.choices || [])[0];
  if (!choice || !choice.message) throw new LlmError('The model returned no choices', 502);

  const text = typeof choice.message.content === 'string'
    ? choice.message.content
    : (choice.message.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');

  if (!text.trim()) throw new LlmError('The model returned an empty response', 502);

  /* A reply that hit the ceiling is a truncated one, and every error it causes
     downstream is a lie about the real problem: half a JSON document reads as
     "unterminated JSON object", and half a game reads as "does not parse:
     Unexpected end of input". Both send you looking at the model's competence
     instead of at max_tokens. Say it here, where it is still a fact. */
  if (choice.finish_reason === 'length') {
    const asked = payload.max_tokens;
    const used = (payloadBody.usage && payloadBody.usage.completion_tokens) || asked;
    /* 422, not 502, and the distinction matters: this is a problem with the
       ANSWER, not with reaching the provider. Asking again with the same
       prompt gets the same over-long answer, so the transport retries below
       must not swallow it - the build loop has to see it and tell the model to
       write something shorter. */
    throw new LlmError(
      `The model ran out of room and its answer was cut off (${used} of ${asked} output tokens used). `
      + 'Raise LLM_MAX_TOKENS, or use a model with more output room.',
      422,
      { truncated: true, maxTokens: asked }
    );
  }

  return {
    text,
    usage: payloadBody.usage || null,
    model: payloadBody.model || model,
    // What was actually sent, not what was asked for: the schema is dropped on
    // a 400 retry above, and reporting it as used would be a lie.
    structuredOutput: Boolean(payload.response_format),
    stopReason: choice.finish_reason || null
  };
}

async function callAnthropic({ messages, system, maxTokens }) {
  const response = await post(`${config.llm.baseUrl}/v1/messages`, {
    'x-api-key': config.llm.apiKey,
    'anthropic-version': '2023-06-01'
  }, {
    model: config.llm.model,
    max_tokens: maxTokens || config.llm.maxTokens,
    system,
    messages
  });

  if (!response.ok) {
    const detail = await readError(response);
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw new LlmError(`anthropic error (${response.status}): ${detail}`, status);
  }

  const body = await response.json();
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new LlmError('The model returned an empty response', 502);

  return {
    text,
    usage: body.usage || null,
    model: body.model || config.llm.model,
    stopReason: body.stop_reason || null
  };
}

/**
 * Why a model was given up on, and whether another one is worth trying.
 *
 * The distinction that matters is transport versus answer. "This model will not
 * serve you" - rate limited, capped for the day, 500ing, refusing the schema -
 * says nothing about the request, so the same request put to a different model
 * is likely to work. "Your answer was too long" or "your key is wrong" is not
 * about the model at all, and walking the whole roster to hear it five more
 * times just spends the founder's time.
 *
 * @returns {null|'daily'|'rate'|'error'} bench reason, or null to stop here
 */
function benchReasonFor(err) {
  if (!(err instanceof LlmError)) return 'error';
  if (err.details && err.details.budgetExhausted) return null;   // the build is out of time
  if (err.status === 401) return null;        // the key is wrong everywhere
  if (err.status === 422) return null;        // truncated: shorten, do not reshuffle
  if (err.status === 402) return 'daily';     // free quota gone until midnight
  if (err.status === 429) return 'rate';      // clears on its own in a minute
  if (err.status === 502 || err.status === 504) return 'error';
  if (err.status === 400) return 'error';     // usually the schema, sometimes the payload
  return 'error';
}

/**
 * Send a conversation and return the model's reply text.
 *
 * With OpenRouter this walks a roster rather than asking one model: the first
 * that answers wins, and one that will not serve is benched so the rest of the
 * build does not keep knocking on the same closed door. A single model was a
 * single point of failure - when its free tier ran out the product stopped, and
 * every founder got the fallback game.
 *
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.jsonSchema] request schema-constrained output
 * @param {'coder'|'brief'} [opts.role] which roster to walk
 * @param {number} [opts.timeoutMs] a ceiling for this call alone. The build
 *        budget still applies; this is for a step that must not be allowed to
 *        eat it - a brief taking a hundred seconds leaves no time for the game.
 * @param {string} [opts.only] ask exactly this model and no other. For a caller
 *        running several models against each other at once, where the point is
 *        that each request goes somewhere different - falling through a shared
 *        roster would have them all land on the same model.
 * @param {string[]} [opts.skip] models the caller has given up on. Transport
 *        failures are this layer's business; a model that keeps answering with
 *        an unfinished file is the caller's, and only the caller can tell.
 * @param {(info:{model:string, index:number, of:number, why:string}) => void} [opts.onModel]
 *        called before each attempt, so the build can say who is being asked
 */
async function complete({
  messages, system = SYSTEM_PROMPT, maxTokens, jsonSchema = false, role = 'coder',
  skip = [], only, timeoutMs, onModel
} = {}) {
  if (!config.llm.enabled) {
    throw new LlmError(
      'No model API key is configured. Set OPENROUTER_API_KEY in .env and restart.',
      503
    );
  }

  if (config.llm.provider === 'anthropic') {
    const result = await withTransportRetries(() => callAnthropic({ messages, system, maxTokens }));
    return { ...result, structuredOutput: false, provider: 'anthropic', attempts: [] };
  }

  /* Two passes, and the order matters.
     
     A pass is one try at each model on the roster, with no waiting: when the
     first model is rate limited, asking the second one costs nothing and
     answers now, whereas waiting a second and re-asking the first costs a
     second and may well fail again. Switching beats waiting.
     
     Waiting is what is left when every model has said no. Then, and only then,
     this backs off and goes round again, because "the whole free tier is busy
     this minute" is a real thing that clears - and the alternative is telling
     the founder their game cannot be built because of a sixty-second blip.
     
     Twice, though, not five times. LLM_RETRIES was written when there was one
     model and re-asking it was the only move available; the roster is that
     redundancy now, and a third full round is twenty more seconds off a build
     budget of five minutes for a failure that has already repeated twelve
     times. One retry catches a blip. More is just a slower way to fail. */
  const ROUNDS = Math.min(config.llm.retries, 1);
  /* The floor for "is there time to ask anybody else". Below this a call can
     only time out. */
  const MIN_CALL_MS = 1000;
  const attempts = [];
  let lastError = null;
  let wait = config.llm.retryBaseMs;

  for (let round = 0; round <= ROUNDS; round += 1) {
    if (round > 0) {
      const pause = wait + Math.floor(Math.random() * 400);
      console.error(`[llm] every model refused; waiting ${pause}ms before round ${round + 1}`);
      await new Promise((r) => setTimeout(r, pause));
      wait = Math.min(wait * 2, config.llm.retryMaxMs);
    }

    /* A model the caller has written off is skipped - unless writing them all
       off would leave nothing, in which case the last one is still better than
       refusing to try. */
    const all = models.candidates(role);
    const named = only && all.find((m) => m.id === only);
    const roster = only
      ? [named || { id: only, schema: true, out: 0, why: 'named by the caller' }]
      : (all.filter((m) => !skip.includes(m.id)).length
        ? all.filter((m) => !skip.includes(m.id))
        : all);
    let worthWaitingFor = false;

    for (let i = 0; i < roster.length; i += 1) {
      const candidate = roster[i];
      const caps = await capabilities(candidate.id);
      const useSchema = Boolean(jsonSchema && caps.structuredOutputs);

      /* Never ask for more room than the model has. Asking for 32k from a model
         that tops out at 8k is a 400 from some providers and a silent clamp from
         others, and the silent one is worse: the answer comes back cut off and
         the error downstream blames the model's competence. */
      const ceiling = caps.maxOutput || candidate.out || 0;
      const want = maxTokens || config.llm.maxTokens;
      const room = ceiling ? Math.min(want, ceiling) : want;

      /* A call needs seconds. Once one attempt has been made, starting another
         with a fraction of a second left does not produce an answer, it
         produces a second identical timeout - so the walk stops while there is
         still time to ship the rescue template. The first attempt always runs:
         post() aborts it if the deadline really has passed. */
      if (attempts.length && remainingMs() < MIN_CALL_MS) throw lastError;

      if (onModel) {
        onModel({ model: candidate.id, index: i + 1, of: roster.length, round: round + 1, why: candidate.why || '' });
      }

      try {
        const result = await callOpenRouter({
          messages, system, maxTokens: room, jsonSchema: useSchema, model: candidate.id, timeoutMs
        });
        attempts.push({ model: candidate.id, ok: true });
        return {
          ...result,
          structuredOutput: result.structuredOutput ?? useSchema,
          provider: 'openrouter',
          attempts,
          // Worth surfacing: "the model you configured did not answer, this one
          // did" is a different story from "it worked".
          routedFrom: attempts.length > 1 ? attempts[0].model : null
        };
      } catch (err) {
        const reason = benchReasonFor(err);
        attempts.push({
          model: candidate.id, ok: false, status: err.status || null, error: err.message, reason
        });
        lastError = err;

        // Nothing another model can fix. Hand it up while it still says what it is.
        if (!reason) throw err;

        // A daily cap will still be a daily cap in four seconds; the rest might not.
        if (reason !== 'daily') worthWaitingFor = true;

        models.bench(candidate.id, reason,
          err.details && err.details.retryAfterMs);
        console.error(`[llm] ${candidate.id} out (${reason}): ${String(err.message).slice(0, 160)}`);
      }
    }

    if (!worthWaitingFor) break;
  }

  /* Every model refused, and waiting did not change that. Say it plainly, with
     what each one said: "the model is rate limited" while six were tried reads
     as one flaky call rather than an exhausted free tier, and the founder makes
     a different decision about the two. */
  const tried = [...new Set(attempts.map((a) => a.model))];
  const summary = tried
    .map((id) => {
      const last = [...attempts].reverse().find((a) => a.model === id);
      return `${id}: ${last.status || 'failed'} (${last.reason})`;
    })
    .join('; ');

  // One model tried is not "the roster is exhausted" - it is that model's
  // error, and dressing it up as a roster failure hides what went wrong.
  if (tried.length < 2 && lastError) throw lastError;

  const error = new LlmError(
    `All ${tried.length} models were unavailable. ${summary}\n\n${lastError ? lastError.message : ''}`,
    lastError && lastError.status === 402 ? 402 : 503,
    { attempts }
  );
  error.attempts = attempts;
  throw error;
}

/**
 * Ride out the failures that are about the provider, not the answer.
 *
 * A rate limit is not an error on a free tier, it is Tuesday: the cap is per
 * minute, and one build is three to five calls. A production build died on
 * exactly this - one call, a 429, and the whole build gave up and shipped a
 * fallback, because the layer above treats any transport error as fatal and
 * there was nothing to feed back to the model.
 *
 * There genuinely is nothing to feed back. The right response is to wait and
 * ask again. A wrong key is not waited out.
 *
 * This is the Anthropic path only. OpenRouter has a roster, and there the same
 * failure is better answered by asking a different model than by waiting for
 * this one - so complete() does the waiting itself, once every model has said
 * no rather than after each one.
 */
async function withTransportRetries(call) {
  let wait = config.llm.retryBaseMs;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const transient = err instanceof LlmError
        && (err.status === 429 || err.status === 502 || err.status === 504);
      if (!transient || attempt > config.llm.retries) throw err;

      // Jittered, so a burst of builds does not come back in lockstep.
      const pause = Math.max(wait + Math.floor(Math.random() * 400), (err.details && err.details.retryAfterMs) || 0);
      if (remainingMs() <= pause + 1000) throw err;
      console.error(`[llm] ${err.status} on attempt ${attempt}, retrying in ${pause}ms`);
      await new Promise((r) => setTimeout(r, pause));
      wait = Math.min(wait * 2, config.llm.retryMaxMs);
    }
  }
}

/** Test hook: forget any detected capabilities. */
function resetCapabilities() {
  capabilityCache.clear();
  cataloguePromise = null;
  models.reset();
}

module.exports = {
  complete, withBudget, buildUserMessage, capabilities, resetCapabilities,
  benchReasonFor, SYSTEM_PROMPT, LlmError, KNOWN
};
