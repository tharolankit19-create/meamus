'use strict';

/**
 * Claude API client.
 *
 * Uses plain fetch against the Messages API so the project has no SDK
 * dependency. When ANTHROPIC_API_KEY is absent the caller falls back to
 * templateGenerator - see services/generator.js.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system.md'), 'utf8');

class ClaudeError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status || 502;
    this.details = details;
  }
}

/**
 * Send one message to Claude and return the raw text of the first content block.
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} [opts.system]
 * @param {number} [opts.maxTokens]
 */
async function complete({ messages, system = SYSTEM_PROMPT, maxTokens }) {
  if (!config.aiEnabled) {
    throw new ClaudeError('ANTHROPIC_API_KEY is not configured', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.anthropic.timeoutMs);

  let response;
  try {
    response = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': config.anthropic.version
      },
      body: JSON.stringify({
        model: config.anthropic.model,
        max_tokens: maxTokens || config.anthropic.maxTokens,
        system,
        messages
      })
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ClaudeError('Claude request timed out', 504);
    }
    throw new ClaudeError(`Claude request failed: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();

  if (!response.ok) {
    let details = bodyText.slice(0, 800);
    try {
      details = JSON.parse(bodyText).error?.message || details;
    } catch { /* keep raw text */ }
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw new ClaudeError(`Claude API error (${response.status}): ${details}`, status);
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new ClaudeError('Claude returned a non-JSON envelope', 502);
  }

  const text = (payload.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (!text.trim()) throw new ClaudeError('Claude returned an empty response', 502);

  return {
    text,
    usage: payload.usage || null,
    model: payload.model || config.anthropic.model,
    stopReason: payload.stop_reason || null
  };
}

module.exports = { complete, SYSTEM_PROMPT, ClaudeError };
