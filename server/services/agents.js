'use strict';

/**
 * The Hermes build crew.
 *
 * One model call writing a whole game in one shot is the weakest version of
 * this. It has to decide the design, write six hundred lines, and be its own
 * critic, all inside a single completion — so it rushes the design and never
 * reviews anything.
 *
 * This splits the work between agents that hand off to each other, each with a
 * narrow job and its own system prompt:
 *
 *   DESIGNER   turns the prompt into a brief: genre, core loop, mechanics,
 *              controls, art direction, difficulty curve
 *   CODER      turns that brief into the GameSpec, code included
 *   TESTER     boots it (deterministic, not a model) — the first of two runs
 *   REVIEWER   reads the code as a critic and reports what is actually wrong
 *   IMPROVER   applies the review and any test failure, and returns a new spec
 *   TESTER     boots it again — the second run, and the last word
 *
 * The tester is deliberately not a model. A model asked "does this run?" will
 * cheerfully say yes; smoke.boot() constructs every scene and ticks it, so the
 * answer is a fact rather than an opinion. A review that the tester contradicts
 * loses.
 *
 * Every handoff is reported through onStep, so the chat shows which agent is
 * working and what it just did.
 */

const config = require('./../config');
const llm = require('./llm');
const smoke = require('./smoke');
const { RESPONSE_FORMAT } = require('./schema');
const { extractJson, normaliseSpec, SpecError } = require('./validator');

/** Roles, in the order they run. Labels are what the founder sees. */
const CREW = {
  designer: {
    label: 'Designer',
    system: [
      'You are the game designer on a small team that ships browser games.',
      'You are given a one-line request and you produce the brief the coder builds from.',
      '',
      'Answer with JSON only, in this exact shape:',
      '{',
      '  "title": "short, punchy, no more than 4 words",',
      '  "genre": "shooter | runner | platformer | puzzle | arcade | strategy",',
      '  "pitch": "one sentence a player would understand",',
      '  "coreLoop": "the 5-15 second loop, concretely",',
      '  "mechanics": [{"name": "...", "description": "...", "why": "what it adds"}],',
      '  "controls": {"keyboard": ["..."], "touch": ["..."], "mouse": ["..."]},',
      '  "art": {"palette": "described in words", "style": "pixel-art|vector|minimalist|cartoon", "sprites": ["..."]},',
      '  "difficulty": "easy|medium|hard",',
      '  "progression": "how it gets harder over a run",',
      '  "failState": "exactly how a run ends"',
      '}',
      '',
      'Rules. Three to six mechanics, no more — a game that does four things well',
      'beats one that does nine badly. Every mechanic must be reachable in the',
      'first thirty seconds of play. Name a real fail state; "the player loses"',
      'is not one. Assume procedural art only: no downloads, no asset packs.'
    ].join('\n')
  },

  coder: {
    label: 'Coder',
    system: null   // uses the shared GameSpec system prompt from llm.js
  },

  reviewer: {
    label: 'Reviewer',
    system: [
      'You review Phaser 3 game code before it ships. You are the last person',
      'to look at it, and you are not here to be encouraging.',
      '',
      'Answer with JSON only:',
      '{',
      '  "verdict": "ship" | "fix",',
      '  "findings": [{"severity": "blocker|major|minor", "what": "...", "where": "function or line", "fix": "..."}],',
      '  "summary": "one sentence"',
      '}',
      '',
      'A blocker is something that makes the game unplayable or unwinnable: a',
      'control that does nothing, a collision that never fires, a scene with no',
      'way out, a score that cannot go up, a fail state that cannot be reached.',
      'A major is something a player would call a bug within a minute. A minor is',
      'polish.',
      '',
      'Report at most five findings and rank them. Do not invent problems — if',
      'the code is sound, say verdict "ship" with an empty findings array. Do not',
      'comment on style, naming or formatting; nobody reads this code.'
    ].join('\n')
  },

  improver: {
    label: 'Improver',
    system: null   // also produces a GameSpec, so it shares the coder prompt
  }
};

/** What the founder sees while each agent works. */
const WORKING_COPY = {
  designer: 'Designing the core loop and mechanics',
  coder: 'Writing the game',
  tester: 'Booting every scene',
  reviewer: 'Reading the code as a critic',
  improver: 'Applying the review'
};

/** Accumulates token usage across the whole crew, because every call costs. */
function tally() {
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    total,
    add(usage) {
      if (!usage) return;
      total.prompt_tokens += usage.prompt_tokens || 0;
      total.completion_tokens += usage.completion_tokens || 0;
      total.total_tokens += usage.total_tokens
        || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
    }
  };
}

/** A JSON-answering agent. Returns the parsed object plus its usage. */
async function ask(role, userContent, { maxTokens } = {}) {
  const agent = CREW[role];
  const response = await llm.complete({
    system: agent.system,
    messages: [{ role: 'user', content: userContent }],
    maxTokens
  });
  let parsed;
  try {
    parsed = extractJson(response.text);
  } catch (err) {
    throw new SpecError(`${agent.label} did not answer with usable JSON: ${err.message}`);
  }
  return { parsed, usage: response.usage, model: response.model };
}

/** A GameSpec-producing agent, schema-constrained where the model supports it. */
async function askForSpec(messages) {
  const response = await llm.complete({ messages, jsonSchema: true });
  const raw = extractJson(response.text);
  const { spec, issues } = normaliseSpec(raw, { source: 'ai' });
  return { spec, issues, response };
}

/** The deterministic gate. Not a model, on purpose. */
function runTest(spec, round) {
  try {
    const result = smoke.boot(spec.gameCode.javascript);
    return { ok: true, round, scenes: result.scenes.length };
  } catch (err) {
    const where = err.detail ? ` (game.js line ${err.detail.line})` : '';
    return { ok: false, round, reason: `${err.message}${where}` };
  }
}

/** Turn the designer's brief into the sentence the coder actually reads. */
function briefToPrompt(brief, original, researchBlock) {
  const mechanics = (brief.mechanics || [])
    .map((m, i) => `${i + 1}. ${m.name} — ${m.description}${m.why ? ` (${m.why})` : ''}`)
    .join('\n');
  const sprites = ((brief.art && brief.art.sprites) || []).join(', ');

  return [
    `Original request: ${original}`,
    '',
    'The designer has already made these decisions. Build exactly this — do not',
    'substitute your own game.',
    '',
    `TITLE       ${brief.title}`,
    `GENRE       ${brief.genre}`,
    `PITCH       ${brief.pitch}`,
    `CORE LOOP   ${brief.coreLoop}`,
    `DIFFICULTY  ${brief.difficulty}`,
    `PROGRESSION ${brief.progression}`,
    `FAIL STATE  ${brief.failState}`,
    '',
    'MECHANICS',
    mechanics || '(none specified — choose three that fit the pitch)',
    '',
    'CONTROLS',
    `  keyboard: ${((brief.controls || {}).keyboard || []).join(', ') || 'arrows/WASD'}`,
    `  touch:    ${((brief.controls || {}).touch || []).join(', ') || 'tap and drag'}`,
    `  mouse:    ${((brief.controls || {}).mouse || []).join(', ') || 'move and click'}`,
    '',
    'ART',
    `  style:   ${(brief.art || {}).style || 'minimalist'}`,
    `  palette: ${(brief.art || {}).palette || 'light, warm, high contrast'}`,
    `  sprites: ${sprites || 'player, enemy, collectible, obstacle'}`,
    researchBlock || '',
    '',
    'Produce the complete GameSpec JSON now. Raw JSON, no prose, no fences.'
  ].join('\n');
}

/** The reviewer only needs the code and what it was supposed to be. */
function reviewPrompt(brief, spec) {
  return [
    'This game was built to the following brief.',
    '',
    `TITLE      ${brief.title}`,
    `CORE LOOP  ${brief.coreLoop}`,
    `FAIL STATE ${brief.failState}`,
    `MECHANICS  ${(brief.mechanics || []).map((m) => m.name).join(', ')}`,
    '',
    'Here is the code that was written. Review it against that brief.',
    '',
    '```javascript',
    spec.gameCode.javascript,
    '```'
  ].join('\n');
}

/**
 * Run the crew.
 *
 * @param {string} prompt what the founder asked for
 * @param {object} opts
 * @param {string}   [opts.researchBlock]
 * @param {function} [opts.buildCoderMessage] wraps the coder's prompt so
 *        reference art reaches the model in whatever shape it accepts
 * @param {function} [opts.onStep] progress, one call per handoff
 * @returns {{spec:object, meta:object}}
 */
async function buildWithCrew(prompt, opts = {}) {
  const started = Date.now();
  const onStep = opts.onStep || (() => {});
  const usage = tally();
  const transcript = [];
  const issues = [];

  const say = (agent, phase, detail) => {
    transcript.push({ agent: CREW[agent] ? CREW[agent].label : 'Tester', phase, detail, at: Date.now() - started });
    onStep({ phase, detail, agent: CREW[agent] ? CREW[agent].label : 'Tester' });
  };

  /* --- 1. Designer -------------------------------------------------------- */
  say('designer', 'design', WORKING_COPY.designer);
  const design = await ask('designer', `Request: ${prompt}`, { maxTokens: 2000 });
  usage.add(design.usage);
  const brief = design.parsed;
  say('designer', 'design', `Brief ready: ${brief.title} — ${brief.pitch}`);

  /* --- 2. Coder ----------------------------------------------------------- */
  //
  // The coder is the only agent that sees the founder's attachments. The
  // designer works from the sentence they typed, and neither the reviewer nor
  // the improver needs the reference art to do its job - they are reading code
  // that already exists. Sending a megabyte of base64 to all four would cost
  // four times over for one agent's benefit.
  const coderMessage = opts.buildCoderMessage
    ? opts.buildCoderMessage(briefToPrompt(brief, prompt, opts.researchBlock))
    : { message: { role: 'user', content: briefToPrompt(brief, prompt, opts.researchBlock) }, ignoredImages: [] };
  if ((coderMessage.ignoredImages || []).length) {
    issues.push(`${config.llm.model} cannot read images, so ${coderMessage.ignoredImages.join(', ')} `
      + 'informed the prompt only. Set OPENROUTER_MODEL to a vision model to use them.');
  }

  // The same brief without the base64. A repair and a review fix both re-send
  // the spec they are correcting, which already carries every art decision the
  // images informed - so re-uploading the images each round would triple the
  // bill for nothing. Attached text survives, because a design doc is context
  // the model still has to read.
  const coderText = typeof coderMessage.message.content === 'string'
    ? coderMessage.message.content
    : ((coderMessage.message.content || []).find((part) => part.type === 'text') || {}).text
      || briefToPrompt(brief, prompt, opts.researchBlock);

  say('coder', 'build', WORKING_COPY.coder);
  let { spec, issues: specIssues, response } = await askForSpec([coderMessage.message]);
  usage.add(response.usage);
  issues.push(...specIssues);
  say('coder', 'build', `Wrote ${spec.gameCode.javascript.split('\n').length} lines`);

  /* --- 3. Tester, first run ---------------------------------------------- */
  say('tester', 'test', `${WORKING_COPY.tester} (run 1 of 2)`);
  let test = runTest(spec, 1);

  // A game that will not boot is fixed before anyone reviews its design.
  let repairs = 0;
  while (!test.ok && repairs < config.build.maxAttempts - 1) {
    repairs += 1;
    say('improver', 'repair', `Run 1 failed: ${test.reason}`);
    const fixed = await askForSpec([
      { role: 'user', content: coderText },
      { role: 'assistant', content: JSON.stringify(spec) },
      {
        role: 'user',
        content: `That build does not run. Booting it threw: ${test.reason}\n\n`
          + 'Return the complete corrected GameSpec JSON. Every scene is constructed '
          + 'and its create() run, then update() is ticked, and any throw fails the '
          + 'build — so declare every variable, create a texture before drawing with '
          + 'it, guard anything nullable in update(), and only call MEAMUS helpers '
          + 'that exist.'
      }
    ]);
    usage.add(fixed.response.usage);
    spec = fixed.spec;
    issues.push(...fixed.issues);
    say('tester', 'test', `${WORKING_COPY.tester} (retry ${repairs})`);
    test = runTest(spec, 1);
  }
  if (!test.ok) {
    throw new SpecError(`The game does not run after ${repairs + 1} attempts: ${test.reason}`);
  }
  say('tester', 'test', `Run 1 passed — ${test.scenes} scenes booted`);

  /* --- 4. Reviewer -------------------------------------------------------- */
  let review = { verdict: 'ship', findings: [], summary: 'Not reviewed.' };
  try {
    say('reviewer', 'review', WORKING_COPY.reviewer);
    const reviewed = await ask('reviewer', reviewPrompt(brief, spec), { maxTokens: 2000 });
    usage.add(reviewed.usage);
    review = reviewed.parsed || review;
  } catch (err) {
    // A review that fails to parse is not worth failing a working game over.
    issues.push(`The reviewer could not be read (${err.message}), so the game shipped on the test alone.`);
    say('reviewer', 'review', 'Review unavailable — shipping on the boot test');
  }

  const actionable = (review.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  say('reviewer', 'review', actionable.length
    ? `${actionable.length} issue${actionable.length > 1 ? 's' : ''} to fix: ${actionable.map((f) => f.what).join('; ').slice(0, 120)}`
    : `No blocking issues — ${review.summary || 'looks sound'}`);

  /* --- 5. Improver -------------------------------------------------------- */
  if (actionable.length) {
    say('improver', 'improve', WORKING_COPY.improver);
    const improved = await askForSpec([
      { role: 'user', content: coderText },
      { role: 'assistant', content: JSON.stringify(spec) },
      {
        role: 'user',
        content: 'A reviewer found these problems. Fix all of them and change nothing else.\n\n'
          + actionable.map((f, i) =>
            `${i + 1}. [${f.severity}] ${f.what}${f.where ? ` (in ${f.where})` : ''}\n   Suggested fix: ${f.fix || 'use your judgement'}`
          ).join('\n')
          + '\n\nReturn the complete corrected GameSpec JSON.'
      }
    ]);
    usage.add(improved.response.usage);

    // The improver's work only counts if it still boots. If the fix broke the
    // game, the version that passed is the one that ships.
    say('tester', 'test', `${WORKING_COPY.tester} (run 2 of 2)`);
    const after = runTest(improved.spec, 2);
    if (after.ok) {
      spec = improved.spec;
      issues.push(...improved.issues);
      say('improver', 'improve', `Applied ${actionable.length} fix${actionable.length > 1 ? 'es' : ''}, still boots`);
    } else {
      issues.push(`The review fixes broke the build (${after.reason}), so the version that passed was shipped instead.`);
      say('improver', 'improve', 'Fixes broke the build — kept the version that passed');
    }
  } else {
    /* --- 6. Tester, second run ------------------------------------------- */
    say('tester', 'test', `${WORKING_COPY.tester} (run 2 of 2)`);
    const second = runTest(spec, 2);
    if (!second.ok) throw new SpecError(`The game failed its second boot: ${second.reason}`);
    say('tester', 'test', `Run 2 passed — ready to ship`);
  }

  return {
    spec,
    meta: {
      mode: 'ai',
      crew: true,
      provider: response.provider,
      model: response.model,
      structuredOutput: response.structuredOutput,
      usage: usage.total,
      durationMs: Date.now() - started,
      attempts: repairs + 1,
      brief,
      review: { verdict: review.verdict, summary: review.summary, findings: review.findings || [] },
      transcript,
      issues
    }
  };
}

/**
 * A short account of what the crew did, for the chat.
 *
 * Written from the transcript rather than asked for, so it cannot claim
 * anything that did not happen.
 */
function summarise(meta) {
  const brief = meta.brief || {};
  const review = meta.review || {};
  const lines = [];

  if (brief.pitch) lines.push(`**${brief.title}** — ${brief.pitch}`);
  if (brief.coreLoop) lines.push(`Core loop: ${brief.coreLoop}`);
  if ((brief.mechanics || []).length) {
    lines.push(`Mechanics: ${brief.mechanics.map((m) => m.name).join(', ')}`);
  }

  const fixes = (review.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  lines.push(fixes.length
    ? `The reviewer found ${fixes.length} issue${fixes.length > 1 ? 's' : ''} and they were fixed: ${fixes.map((f) => f.what).join('; ')}`
    : `The reviewer found nothing blocking${review.summary ? ` — ${review.summary}` : ''}.`);

  lines.push('Booted and ticked twice before shipping.');
  if (meta.attempts > 1) lines.push(`Took ${meta.attempts} attempts to get it running.`);

  return lines.join('\n');
}

module.exports = { buildWithCrew, summarise, CREW, WORKING_COPY };
