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

let capabilityCache = null;
let capabilityPromise = null;

function staticCapabilities(model) {
  if (KNOWN[model]) return { ...KNOWN[model], source: 'static' };
  // Anthropic and the OpenAI-style majors all take images.
  if (/^(anthropic\/|claude)/.test(model)) return { images: true, structuredOutputs: false, source: 'static' };
  return { images: false, structuredOutputs: false, source: 'assumed' };
}

/**
 * Ask OpenRouter what the configured model can do. Cached for the process
 * lifetime; a failure falls back to the static table rather than throwing,
 * because a catalogue outage must not take generation down with it.
 */
async function capabilities() {
  if (capabilityCache) return capabilityCache;
  if (config.llm.provider !== 'openrouter') {
    capabilityCache = staticCapabilities(config.llm.model);
    return capabilityCache;
  }
  if (capabilityPromise) return capabilityPromise;

  capabilityPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${config.llm.baseUrl}/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`catalogue returned ${response.status}`);

      const { data } = await response.json();
      const entry = (data || []).find((m) => m.id === config.llm.model);
      if (!entry) throw new Error(`model ${config.llm.model} is not in the catalogue`);

      const modalities = (entry.architecture && entry.architecture.input_modalities) || [];
      const params = entry.supported_parameters || [];
      capabilityCache = {
        images: modalities.includes('image'),
        structuredOutputs: params.includes('structured_outputs') && params.includes('response_format'),
        contextLength: entry.context_length,
        maxOutput: entry.top_provider && entry.top_provider.max_completion_tokens,
        source: 'catalogue'
      };
    } catch (err) {
      capabilityCache = staticCapabilities(config.llm.model);
      capabilityCache.detectionError = err.message;
    }
    return capabilityCache;
  })();

  return capabilityPromise;
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

async function post(url, headers, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });
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
function rateLimitMessage(detail) {
  const free = /:free$/.test(config.llm.model);
  if (!free) {
    return `The model is rate limited right now. Wait a minute and try again. (${detail})`;
  }
  return 'The free tier for ' + config.llm.model + ' is rate limited, and this build asked for '
    + 'more than it allows right now. Wait a minute and try again, or switch OPENROUTER_MODEL to '
    + config.llm.model.replace(/:free$/, '') + ' — the same model on the paid tier, at about '
    + `$0.09 per million input tokens. (${detail})`;
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

async function callOpenRouter({ messages, system, maxTokens, jsonSchema }) {
  const payload = {
    model: config.llm.model,
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
  }, payload);

  // Not every deployment of a model honours response_format. One retry without
  // it beats failing the generation outright.
  if (!response.ok && jsonSchema && (response.status === 400 || response.status === 422)) {
    delete payload.response_format;
    response = await post(`${config.llm.baseUrl}/chat/completions`, {
      authorization: `Bearer ${config.llm.apiKey}`,
      'HTTP-Referer': config.llm.referer,
      'X-Title': config.llm.title
    }, payload);
  }

  if (!response.ok) {
    const detail = await readError(response);
    if (response.status === 429) throw new LlmError(rateLimitMessage(detail), 429);
    const status = response.status === 401 || response.status === 403 ? 401
      : response.status >= 500 ? 502 : 400;
    throw new LlmError(`${config.llm.provider} error (${response.status}): ${detail}`, status);
  }

  const payloadBody = await response.json();
  const choice = (payloadBody.choices || [])[0];
  if (!choice) throw new LlmError('The model returned no choices', 502);

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
    model: payloadBody.model || config.llm.model,
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
 * Send a conversation and return the model's reply text.
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.jsonSchema] request schema-constrained output
 */
async function complete({ messages, system = SYSTEM_PROMPT, maxTokens, jsonSchema = false }) {
  if (!config.llm.enabled) {
    throw new LlmError(
      'No model API key is configured. Set OPENROUTER_API_KEY in .env and restart.',
      503
    );
  }
  const caps = await capabilities();
  const useSchema = jsonSchema && caps.structuredOutputs && config.llm.provider === 'openrouter';

  const call = () => (config.llm.provider === 'anthropic'
    ? callAnthropic({ messages, system, maxTokens })
    : callOpenRouter({ messages, system, maxTokens, jsonSchema: useSchema }));

  const result = await withTransportRetries(call);
  return { ...result, structuredOutput: useSchema, provider: config.llm.provider };
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
 * ask again, which is what this does, and it belongs here rather than in the
 * build loop so every agent gets it. A wrong key is not waited out.
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
      const pause = wait + Math.floor(Math.random() * 400);
      console.error(`[llm] ${err.status} on attempt ${attempt}, retrying in ${pause}ms`);
      await new Promise((r) => setTimeout(r, pause));
      wait = Math.min(wait * 2, config.llm.retryMaxMs);
    }
  }
}

/** Test hook: forget any detected capabilities. */
function resetCapabilities() {
  capabilityCache = null;
  capabilityPromise = null;
}

module.exports = {
  complete, buildUserMessage, capabilities, resetCapabilities,
  SYSTEM_PROMPT, LlmError, KNOWN
};
