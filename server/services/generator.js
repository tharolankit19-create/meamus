'use strict';

/**
 * The generation pipeline.
 *
 *   prompt -> Claude -> JSON -> validate/normalise -> GameSpec
 *
 * When no ANTHROPIC_API_KEY is set (or a call fails and fallback is allowed)
 * the same call is served by templateGenerate(): a deterministic generator
 * that picks the closest bundled template and retitles/reskins it from the
 * prompt. That keeps the whole product exercisable before the key is added.
 */

const config = require('../config');
const claude = require('./claude');
const templates = require('./templates');
const { extractJson, normaliseSpec, SpecError } = require('./validator');

/* ------------------------------------------------------------------------ */
/* Prompt analysis (shared by both paths)                                    */
/* ------------------------------------------------------------------------ */

const DIFFICULTY_HINTS = [
  { level: 'hard', words: ['hard', 'brutal', 'difficult', 'hardcore', 'punishing', 'roguelike', 'permadeath'] },
  { level: 'easy', words: ['easy', 'casual', 'relaxing', 'simple', 'chill', 'kids', 'beginner'] }
];

const STYLE_HINTS = [
  { style: 'pixel-art', words: ['retro', 'pixel', '8-bit', '8bit', '16-bit', 'arcade'] },
  { style: 'minimalist', words: ['minimal', 'clean', 'flat', 'simple', 'geometric', 'neon'] },
  { style: 'cartoon', words: ['cartoon', 'cute', 'kawaii', 'silly', 'funny', 'kids'] },
  { style: 'realistic', words: ['realistic', 'gritty', 'photo', 'sim'] }
];

function analysePrompt(prompt) {
  const text = String(prompt || '').toLowerCase();

  let difficulty = 'medium';
  for (const hint of DIFFICULTY_HINTS) {
    if (hint.words.some((w) => text.includes(w))) { difficulty = hint.level; break; }
  }

  let style = 'pixel-art';
  for (const hint of STYLE_HINTS) {
    if (hint.words.some((w) => text.includes(w))) { style = hint.style; break; }
  }

  const controls = [];
  if (/\btap|touch|swipe|mobile|phone|one[- ]?thumb\b/.test(text)) controls.push('touch-first');
  if (/\bclick|mouse|aim\b/.test(text)) controls.push('mouse');
  if (/\bkeyboard|wasd|arrow\b/.test(text)) controls.push('keyboard');

  return { difficulty, style, controls, text };
}

/** Pull a plausible title out of the prompt when the model is not involved. */
function titleFromPrompt(prompt, fallback) {
  const cleaned = String(prompt || '')
    .replace(/^(make|create|build|generate|i want|give me)\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/\b(game|clone|where|that|which|with|for)\b.*$/i, '')
    .replace(/[^a-zA-Z0-9 '-]/g, ' ')
    .trim();

  if (cleaned.length < 3) return fallback;
  const words = cleaned.split(/\s+/).slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return words.join(' ') || fallback;
}

/* ------------------------------------------------------------------------ */
/* Template mode (no API key required)                                       */
/* ------------------------------------------------------------------------ */

function templateGenerate(prompt, { reason = 'no-api-key' } = {}) {
  const ranked = templates.rank(prompt);
  const best = ranked[0];
  const analysis = analysePrompt(prompt);

  // No keyword hit at all: fall back to the featured shooter rather than
  // pretending the prompt matched something.
  const chosen = best && best.score > 0 ? best : { template: templates.get('space-shooter') || ranked[0].template, score: 0, hits: [] };

  const source = chosen.template.spec;
  const spec = JSON.parse(JSON.stringify(source));

  spec.gameConfig.title = titleFromPrompt(prompt, source.gameConfig.title);
  spec.gameConfig.difficulty = analysis.difficulty;
  spec.gameConfig.description =
    `${source.gameConfig.description} Built from the ${source.gameConfig.title} template to match: "${String(prompt).slice(0, 140)}".`;
  spec.assets.sprites = spec.assets.sprites.map((s) => ({ ...s, style: analysis.style }));
  spec.runtime.source = 'template';

  return {
    spec,
    meta: {
      mode: 'template',
      reason,
      templateId: chosen.template.id,
      matchScore: chosen.score,
      matchedKeywords: chosen.hits,
      alternatives: ranked.slice(1, 4).map((r) => ({ id: r.template.id, score: r.score })),
      model: null,
      usage: null,
      issues: chosen.score === 0
        ? ['No template keywords matched this prompt. Add an ANTHROPIC_API_KEY for original generation.']
        : []
    }
  };
}

/* ------------------------------------------------------------------------ */
/* AI mode                                                                   */
/* ------------------------------------------------------------------------ */

function buildUserMessage(prompt, analysis) {
  return [
    `Game request: ${prompt}`,
    '',
    'Detected from the request:',
    `- difficulty: ${analysis.difficulty}`,
    `- visual style: ${analysis.style}`,
    `- control emphasis: ${analysis.controls.length ? analysis.controls.join(', ') : 'keyboard + mouse + touch equally'}`,
    '',
    'Produce the complete GameSpec JSON now. The game must be fully playable',
    'from the returned gameCode.javascript alone, using only procedural',
    'graphics and the Phaser 3 CDN build. Raw JSON, no prose, no fences.'
  ].join('\n');
}

function buildModifyMessage(instruction, currentSpec) {
  return [
    `Modification request: ${instruction}`,
    '',
    'Here is the current game spec. Apply the request, change only what it',
    'affects, keep everything else byte-identical, and return the complete',
    'updated JSON object.',
    '',
    '```json',
    JSON.stringify(currentSpec, null, 2),
    '```'
  ].join('\n');
}

async function aiGenerate(messages) {
  const started = Date.now();
  const response = await claude.complete({ messages });
  const raw = extractJson(response.text);
  const { spec, issues } = normaliseSpec(raw, { source: 'ai' });

  return {
    spec,
    meta: {
      mode: 'ai',
      model: response.model,
      usage: response.usage,
      stopReason: response.stopReason,
      durationMs: Date.now() - started,
      issues
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * @param {string} prompt
 * @param {object} [opts]
 * @param {boolean} [opts.allowFallback=true] serve a template if the AI call fails
 * @param {boolean} [opts.forceTemplate=false] skip the AI entirely
 */
async function generate(prompt, opts = {}) {
  const allowFallback = opts.allowFallback !== false;

  if (opts.forceTemplate || !config.aiEnabled) {
    return templateGenerate(prompt, { reason: opts.forceTemplate ? 'forced' : 'no-api-key' });
  }

  const analysis = analysePrompt(prompt);
  try {
    return await aiGenerate([{ role: 'user', content: buildUserMessage(prompt, analysis) }]);
  } catch (err) {
    if (!allowFallback) throw err;
    console.error('[generator] AI generation failed, serving a template:', err.message);
    const result = templateGenerate(prompt, { reason: `ai-failed: ${err.message}` });
    result.meta.aiError = err.message;
    return result;
  }
}

/**
 * Apply a natural-language change to an existing spec.
 * Template mode cannot rewrite code, so it reports that honestly instead of
 * silently returning the unchanged game.
 */
async function modify(instruction, currentSpec, opts = {}) {
  if (!config.aiEnabled) {
    const err = new SpecError('Modifying a game needs a Claude API key. Add ANTHROPIC_API_KEY to .env and restart.');
    err.status = 503;
    throw err;
  }
  if (opts.forceTemplate) throw new SpecError('Template mode cannot modify generated code');
  return aiGenerate([{ role: 'user', content: buildModifyMessage(instruction, currentSpec) }]);
}

module.exports = { generate, modify, templateGenerate, analysePrompt, titleFromPrompt };
