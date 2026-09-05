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
const llm = require('./llm');
const research = require('./research');
const templates = require('./templates');
const { extractJson, normaliseSpec, SpecError } = require('./validator');
const smoke = require('./smoke');
const agents = require('./agents');

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

function templateGenerate(prompt, { reason = 'no-api-key', attachments = [] } = {}) {
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
      attachmentCount: attachments.length,
      issues: [
        ...(chosen.score === 0
          ? ['No template keywords matched this prompt. Add an OPENROUTER_API_KEY for original generation.']
          : []),
        ...(attachments.length
          ? [`${attachments.length} attachment(s) ignored - template mode cannot read reference files. Add an OPENROUTER_API_KEY to use them.`]
          : [])
      ]
    }
  };
}

/* ------------------------------------------------------------------------ */
/* AI mode                                                                   */
/* ------------------------------------------------------------------------ */

function buildUserMessage(prompt, analysis, researchBlock = '') {
  return [
    `Game request: ${prompt}`,
    '',
    'Detected from the request:',
    `- difficulty: ${analysis.difficulty}`,
    `- visual style: ${analysis.style}`,
    `- control emphasis: ${analysis.controls.length ? analysis.controls.join(', ') : 'keyboard + mouse + touch equally'}`,
    researchBlock,
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

/** How many times a failed build is handed back to the model to repair. */
const MAX_BUILD_ATTEMPTS = 3;

/**
 * Generate, then check the result and make the model fix its own mistakes.
 *
 * The validator refuses code that does not parse, is a stub, or never starts a
 * game. Without this loop that refusal was the end of the road - and before the
 * validator had those gates, a two-line stub shipped to the preview as
 * "Uncaught SyntaxError" while still charging for the build. Here the failure
 * is fed back as a review note and the model gets another go.
 *
 * @param {Array} messages the conversation so far
 * @param {string[]} [extraIssues] warnings to carry into meta
 * @param {(step:{attempt:number,total:number,phase:string,detail:string}) => void} [onStep]
 */
async function aiGenerate(messages, extraIssues = [], onStep) {
  const started = Date.now();
  const attempts = [];
  // Accumulated across every attempt, because every attempt cost real tokens.
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let conversation = messages;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
    if (onStep) {
      onStep({
        attempt,
        total: MAX_BUILD_ATTEMPTS,
        phase: attempt === 1 ? 'build' : 'repair',
        detail: attempt === 1 ? 'Writing the game code' : `Fixing: ${lastError.message}`
      });
    }

    // Schema-constrained output where the model supports it; llm.complete()
    // downgrades on its own when it does not.
    let response;
    try {
      response = await llm.complete({ messages: conversation, jsonSchema: true });
      if (response.usage) {
        usage.prompt_tokens += response.usage.prompt_tokens || 0;
        usage.completion_tokens += response.usage.completion_tokens || 0;
        usage.total_tokens += response.usage.total_tokens
          || ((response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0));
      }

      if (onStep) onStep({ attempt, total: MAX_BUILD_ATTEMPTS, phase: 'review', detail: 'Checking the code parses' });
      const raw = extractJson(response.text);
      const { spec, issues } = normaliseSpec(raw, { source: 'ai' });

      // Second check, and the one that matters: actually boot it.
      //
      // Parsing only proves the file is well-formed. A game that parses and
      // then throws in create() is exactly what reached players as a black
      // screen with an error overlay - and they were charged for it. Every
      // scene is constructed and run here before the build is allowed out.
      if (onStep) onStep({ attempt, total: MAX_BUILD_ATTEMPTS, phase: 'test', detail: 'Booting every scene' });
      try {
        const result = smoke.boot(spec.gameCode.javascript);
        issues.push(`Booted ${result.scenes.length} scenes without throwing.`);
      } catch (err) {
        const where = err.detail ? ` (game.js line ${err.detail.line})` : '';
        throw new SpecError(`The game does not run: ${err.message}${where}`, ['gameCode.javascript']);
      }

      if (response.stopReason === 'length') {
        issues.push('The model hit its output limit - raise LLM_MAX_TOKENS if the game feels truncated.');
      }
      if (attempt > 1) {
        issues.push(`Took ${attempt} attempts - the first ${attempt - 1} were rejected and repaired.`);
      }

      return {
        spec,
        meta: {
          mode: 'ai',
          provider: response.provider,
          model: response.model,
          structuredOutput: response.structuredOutput,
          usage,
          stopReason: response.stopReason,
          durationMs: Date.now() - started,
          attempts: attempt,
          rejected: attempts,
          issues: [...extraIssues, ...issues]
        }
      };
    } catch (err) {
      if (!(err instanceof SpecError) && !(err.details && err.details.truncated)) throw err;
      lastError = err;
      attempts.push({ attempt, reason: err.message });

      // Hand the model its own output plus the reason it was refused. Naming
      // the failure is what makes the next attempt different from a re-roll.
      conversation = [
        ...messages,
        ...(response ? [{ role: 'assistant', content: response.text.slice(0, 48000) }] : []),
        {
          role: 'user',
          content: `That build was rejected: ${err.message}\n\n`
            + 'Return the complete corrected GameSpec JSON. The gameCode.javascript field '
            + 'must be a compact complete Phaser 3 game with a playable start, game and restart flow. '
            + 'If the answer was cut off, reduce mechanics and comments so the complete JSON fits. Do not return a stub, a summary, '
            + 'or a partial file.\n\n'
            + 'It is not enough for the code to parse — every scene is constructed and its '
            + 'init/preload/create run, then update() is ticked, and any throw fails the '
            + 'build. So: declare every variable you use, create a texture before drawing '
            + 'with it, guard anything that can be null in update(), and only call MEAMUS '
            + 'helpers that exist. If you are unsure a helper exists, use plain Phaser.'
        }
      ];
    }
  }

  const err = new SpecError(
    `The model could not produce a working game in ${MAX_BUILD_ATTEMPTS} attempts. Last problem: ${lastError.message}`,
    ['gameCode.javascript']
  );
  err.attempts = attempts;
  throw err;
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
    return templateGenerate(prompt, {
      reason: opts.forceTemplate ? 'forced' : 'no-api-key',
      attachments: opts.attachments || []
    });
  }

  const analysis = analysePrompt(prompt);
  const attachments = opts.attachments || [];
  try {
    const caps = await llm.capabilities();

    // Ground the brief in real games from the same genre. Never fatal: a slow
    // or unreachable catalogue just means the model works from the prompt.
    const refs = opts.research === false
      ? { used: false, references: [], categories: [] }
      : await research.referencesFor(prompt);

    // The crew path: a designer briefs a coder, a tester boots it, a reviewer
    // critiques it, an improver applies the review, and the tester has the last
    // word. Every handoff is reported, so the chat shows who did what.
    if (config.build.crew) {
      const result = await agents.buildWithCrew(prompt, {
        researchBlock: research.toPromptBlock(refs),
        // Reference art goes to the coder, in whatever shape this model takes.
        buildCoderMessage: (text) => llm.buildUserMessage(text, attachments, caps),
        onStep: opts.onStep
      });
      result.meta.research = {
        used: refs.used,
        categories: refs.categories,
        count: refs.references.length,
        titles: refs.references.map((r) => r.title),
        source: 'FreeToGame',
        sourceUrl: 'https://www.freetogame.com'
      };
      return result;
    }

    const { message, ignoredImages } = llm.buildUserMessage(
      buildUserMessage(prompt, analysis, research.toPromptBlock(refs)), attachments, caps
    );
    // Never drop a user's reference art silently - say the model cannot see it.
    const issues = ignoredImages.length
      ? [`${config.llm.model} cannot read images, so ${ignoredImages.join(', ')} ` +
         'informed the prompt only. Set OPENROUTER_MODEL to a vision model to use them.']
      : [];
    const result = await aiGenerate([message], issues, opts.onStep);
    result.meta.research = {
      used: refs.used,
      categories: refs.categories,
      count: refs.references.length,
      titles: refs.references.map((r) => r.title),
      source: 'FreeToGame',
      sourceUrl: 'https://www.freetogame.com'
    };
    return result;
  } catch (err) {
    if (!allowFallback) throw err;
    console.error('[generator] AI generation failed:', err.message);

    /* A build must not end with nothing to play.
     *
     * The rule here used to be "never substitute a template", written after a
     * request for Ludo came back as the space-shooter template retitled
     * "A Ludo" - the wrong game, presented as the right one. That rule was
     * about the LIE, not about the template: the problem was that nothing on
     * screen said a substitution had happened.
     *
     * So the substitution is back and the lie is not. When the model cannot
     * produce a game that runs, the closest template ships instead, marked
     * `rescued` with the real reason attached - the chat says what happened,
     * the card says it, and the founder can send the prompt again. A playable
     * game they can see is honestly labelled beats a red error box.
     */
    const rescue = templateGenerate(prompt, { reason: 'ai-failed', attachments });

    // Keep the template's own name. templateGenerate titles a game after the
    // prompt, which is right when a template is what was asked for and wrong
    // here: a space shooter listed as "A Ludo Board" is the original lie in a
    // smaller font. It is called what it is, and the chat says why it is here.
    const original = templates.get(rescue.meta.templateId);
    if (original) rescue.spec.gameConfig.title = original.spec.gameConfig.title;

    rescue.meta.rescued = true;
    rescue.meta.rescuedFrom = err.message;
    rescue.meta.issues = [
      `The model could not produce a game that runs (${err.message}). `
      + `This is the ${rescue.meta.templateId} template adapted to your prompt, so you have `
      + 'something playable - send the prompt again, or reword it, for a fresh attempt.'
    ];
    if (opts.onStep) {
      opts.onStep({
        phase: 'ship',
        agent: 'Rescue',
        detail: `The model could not get one to run — shipping the ${rescue.meta.templateId} template so you have something playable`
      });
    }
    return rescue;
  }
}

/**
 * Apply a natural-language change to an existing spec.
 * Template mode cannot rewrite code, so it reports that honestly instead of
 * silently returning the unchanged game.
 */
async function modify(instruction, currentSpec, opts = {}) {
  if (!config.aiEnabled) {
    const err = new SpecError('Modifying a game needs a model API key. Add OPENROUTER_API_KEY to .env and restart.');
    err.status = 503;
    throw err;
  }
  if (opts.forceTemplate) throw new SpecError('Template mode cannot modify generated code');
  const caps = await llm.capabilities();
  const { message, ignoredImages } = llm.buildUserMessage(
    buildModifyMessage(instruction, currentSpec), opts.attachments || [], caps
  );
  const issues = ignoredImages.length
    ? [`${config.llm.model} cannot read images, so ${ignoredImages.join(', ')} informed the prompt only.`]
    : [];
  return aiGenerate([message], issues, opts.onStep);
}

/**
 * Answer a question about the player's own game.
 *
 * No schema and no rebuild: the spec goes in as context and plain prose comes
 * back. This is what makes the workspace a conversation rather than a build
 * queue, and it is why a question costs no credits.
 */
async function answer(question, currentSpec) {
  if (!config.aiEnabled) {
    const err = new SpecError('Answering questions needs a model API key. Add OPENROUTER_API_KEY to .env and restart.');
    err.status = 503;
    throw err;
  }
  const summary = {
    title: currentSpec.gameConfig.title,
    genre: currentSpec.gameConfig.genre,
    difficulty: currentSpec.gameConfig.difficulty,
    description: currentSpec.gameConfig.description,
    controls: currentSpec.controls,
    mechanics: currentSpec.mechanics,
    sprites: (currentSpec.assets.sprites || []).map((s) => s.name || s.key || s.id)
  };
  const result = await llm.complete({
    system: 'You answer questions about a Phaser 3 game the person you are talking to already owns. '
      + 'Be brief - a few sentences. Use the spec you are given; if it does not cover something, say so '
      + 'rather than inventing it. When a change would answer the question better than an explanation, '
      + 'say what you would change and ask them to confirm. Never return code or JSON.',
    messages: [{
      role: 'user',
      content: `Here is the current game spec:\n\n${JSON.stringify(summary, null, 2)}\n\n`
        + `Their question: ${question}`
    }],
    maxTokens: 700
  });
  return { text: String(result.text || '').trim(), meta: { mode: 'chat', provider: result.provider } };
}

module.exports = {
  generate: (...args) => llm.withBudget(() => generate(...args)),
  modify: (...args) => llm.withBudget(() => modify(...args)),
  answer, templateGenerate, analysePrompt, titleFromPrompt
};
