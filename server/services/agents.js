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

/* Headroom for the two agents that answer with a small JSON document.

   These were 2000, which is generous for a brief of a dozen fields - until the
   default model became one that thinks first. Reasoning is off now (see
   llm.js), but a tight ceiling has exactly one failure mode and it is a
   truncated document that reads as the model being incapable, so there is no
   reason to sail close to it for a few hundred tokens. */
const BRIEF_TOKENS = 8000;

/* How much of a rejected answer to quote back when asking for a fix. A whole
   game is 30-40k characters and re-sending all of it every round is what turns
   a repair loop into the most expensive part of a build. */
const MAX_ECHO_CHARS = 48000;

/** A JSON-answering agent. Returns the parsed object plus its usage. */
async function ask(role, userContent, { maxTokens, onModel } = {}) {
  const agent = CREW[role];
  const response = await llm.complete({
    system: agent.system,
    messages: [{ role: 'user', content: userContent }],
    maxTokens,
    // A brief is a page of JSON; it does not need the model with the biggest
    // output ceiling, it needs one that answers.
    role: 'brief',
    onModel
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
async function askForSpec(messages, { onModel } = {}) {
  const response = await llm.complete({ messages, jsonSchema: true, role: 'coder', onModel });
  const raw = extractJson(response.text);
  const { spec, issues } = normaliseSpec(raw, { source: 'ai' });
  return { spec, issues, response };
}

/* How short to ask for, once it is clear the model cannot finish a longer one.
   Each successive cut-off drops a step. The floor is deliberately tiny: a
   150-line game that runs is a product, and a 500-line one that stops halfway
   is nothing at all. */
const SHRINK_STEPS = [320, 220, 150, 110];

function shrinkTarget(cutoffs) {
  return SHRINK_STEPS[Math.min(cutoffs, SHRINK_STEPS.length - 1)];
}

/**
 * Describe a failure to the model in terms it can act on.
 *
 * The difference between "the code does not parse" and "line 253, column 18,
 * here is the character" is the difference between a fix and another guess.
 *
 * @param {Error} err what went wrong
 * @param {number} [cutoffs] how many times this build has already been cut off
 */
function correctionFor(err, cutoffs = 0) {
  const site = err.detail && err.detail.line
    ? `\n\nThe problem is at game.js line ${err.detail.line}`
      + `${err.detail.column ? `, column ${err.detail.column}` : ''}:\n    ${err.detail.source}`
    : '';

  /* Truncation is checked BEFORE the general parse failure, because it arrives
     wearing its clothes: "Unexpected end of input" IS a parse error, and the
     advice for one is useless for the other. Three production attempts in a row
     stopped at the same line - the model had run out of room - and each was
     told to check its quotation marks. */
  const truncated = /Unexpected end of input|unterminated|ran out of room|cut off/i.test(err.message);
  if (truncated) {
    const lines = shrinkTarget(cutoffs);
    return 'Your last answer stopped before the game was finished - the file ends '
      + `mid-way${err.detail && err.detail.line ? ` (around line ${err.detail.line})` : ''}.\n\n`
      + `You do not have room for a game that size. Write one of about ${lines} lines `
      + 'and FINISH it. Cut scenes, cut mechanics, cut comments - keep one thing that '
      + 'plays well. The `new Phaser.Game(...)` call is the last thing in the file and '
      + 'you must reach it. Return the complete GameSpec JSON.';
  }

  // The model reaching for a loader is its own failure mode, and the generic
  // "check your punctuation" advice does nothing about it.
  if (err.detail && /this\.load\.|data:[a-z]+\//i.test(err.detail.source || '')) {
    return `That code is not valid JavaScript: ${err.message}${site}\n\n`
      + 'The problem is the asset loader. There is nothing to load from - no server, '
      + 'no files - and a data: URI is what your answer runs out of room writing. '
      + 'Delete every this.load.* call and draw the sprite instead:\n\n'
      + '    const g = this.make.graphics({ x: 0, y: 0, add: false });\n'
      + '    g.fillStyle(0x4fa3d1, 1).fillRoundedRect(0, 0, 32, 24, 6);\n'
      + "    g.generateTexture('ship', 32, 24);\n"
      + '    g.destroy();\n\n'
      + 'Return the complete corrected GameSpec JSON.';
  }

  if (/does not parse/i.test(err.message)) {
    return `That code is not valid JavaScript: ${err.message}${site}\n\n`
      + 'Return the complete corrected GameSpec JSON. Write plain ASCII JavaScript: '
      + 'straight quotes only (no “ ” ‘ ’), no smart dashes, no stray backticks, and '
      + 'no markdown fences inside the code string. Every brace, bracket and paren '
      + 'must close.';
  }

  if (/never (called|starts)|never reaches|stub rather than/i.test(err.message)) {
    const lines = shrinkTarget(cutoffs);
    return `That answer did not get to the end of the game: ${err.message}\n\n`
      + `Write a game of about ${lines} lines and finish it. Two scenes is enough, one `
      + 'solid mechanic is enough. The `new Phaser.Game(...)` call is the last thing in '
      + 'the file and it must be there. Return the complete GameSpec JSON.';
  }

  if (/ran out of room|cut off/i.test(err.message)) {
    return 'Your last answer was cut off before it finished. Return the complete '
      + 'GameSpec JSON again, but write a SHORTER game - fewer scenes, fewer '
      + 'mechanics, tighter code - so the whole thing fits in one answer. A small '
      + 'game that runs beats a large one that arrives half-written.';
  }

  if (/JSON|unterminated|usable/i.test(err.message)) {
    return `Your last answer could not be read as JSON: ${err.message}\n\n`
      + 'Return ONLY the GameSpec JSON object. No prose before or after it, no '
      + 'markdown fences, no trailing commas.';
  }

  // A boot failure: the code parsed, but running it threw.
  return `That build does not run. Booting it threw: ${err.message}${site}\n\n`
    + 'Return the complete corrected GameSpec JSON. Every scene is constructed and '
    + 'its create() run, then update() is ticked, and any throw fails the build - so '
    + 'declare every variable, create a texture before drawing with it, guard '
    + 'anything nullable in update(), and only call MEAMUS helpers that exist.';
}

/**
 * Write the game, and keep writing until it actually runs.
 *
 * Bounded by a deadline rather than a small attempt count. "Three tries" is an
 * arbitrary number that has nothing to do with whether the next try would have
 * worked; the real limit is how long the founder is willing to wait and how
 * long the platform will keep the request alive. So it retries as often as it
 * can inside that window and stops when the window closes.
 *
 * Every attempt ends in one of two places: a spec whose code parses AND boots
 * every scene, or a failure fed back to the model verbatim.
 */
async function writeUntilItRuns({ coderMessage, coderText, say, usage, deadline }) {
  const until = deadline || (Date.now() + config.build.budgetMs);
  const issues = [];
  let last = null;
  let attemptNo = 0;
  // Each answer that stopped short makes the next request smaller.
  let cutoffs = 0;

  while (attemptNo < config.build.maxAttempts) {
    attemptNo += 1;

    // Only start an attempt there is time to finish. Being cut off mid-call
    // wastes the tokens and tells the founder nothing.
    if (attemptNo > 1 && Date.now() > until - config.build.attemptReserveMs) {
      say('coder', 'build', `Out of time after ${attemptNo - 1} attempts`);
      break;
    }

    say('coder', 'build', attemptNo === 1
      ? WORKING_COPY.coder
      : `Rewriting it (attempt ${attemptNo})`, { attempt: attemptNo });

    let answer = null;
    try {
      const messages = attemptNo === 1 || !last
        ? [coderMessage.message]
        : [
          { role: 'user', content: coderText },
          { role: 'assistant', content: last.text },
          { role: 'user', content: correctionFor(last.error, cutoffs) }
        ];

      const response = await llm.complete({
        messages, jsonSchema: true, role: 'coder',
        onModel: (info) => say('coder', 'build',
          info.index === 1
            ? `Asking ${info.model}`
            : `${info.model} instead (model ${info.index} of ${info.of})`,
          { model: info.model, modelIndex: info.index, modelCount: info.of, attempt: attemptNo })
      });
      usage.add(response.usage);
      answer = response.text;

      // Each of these can throw, and each throw is a retry with the reason.
      const raw = extractJson(response.text);
      const { spec, issues: specIssues } = normaliseSpec(raw, { source: 'ai' });
      const lines = spec.gameCode.javascript.split('\n').length;
      const chars = spec.gameCode.javascript.length;
      say('coder', 'build', `Wrote game.js — ${lines} lines, ${Math.round(chars / 1024)} KB`,
        { file: 'game.js', lines, bytes: chars, model: response.model, attempt: attemptNo });

      say('tester', 'test', `${WORKING_COPY.tester} (run 1 of 2)`);
      const booted = smoke.boot(spec.gameCode.javascript);

      issues.push(...specIssues);
      return {
        spec, issues, response, repairs: attemptNo - 1, scenes: booted.scenes.length
      };
    } catch (err) {
      /* Only a failure that will still be true next time ends the build.
         A missing or rejected key is one of those; a rate limit is not, and
         treating it as one is what made a production build give up after a
         single call. Transport failures are already waited out a layer down,
         so reaching here means the provider stayed unhappy - which the time
         budget, not this line, decides how long to keep trying. */
      // 402 is the daily free-tier cap: it does not clear before midnight, so
      // spending the rest of the budget on it only delays the rescue.
      const fatal = err && err.name === 'LlmError'
        && (err.status === 401 || err.status === 402 || err.status === 503);
      if (fatal) throw err;

      // Quote what it actually wrote, so the next attempt is an edit rather
      // than a restart from nothing. Capped, because a rejected answer is
      // still most of a game and re-sending all of it every round is what
      // makes a repair loop cost more than the build.
      if (/Unexpected end of input|unterminated|ran out of room|cut off|never (called|starts)|stub rather than/i.test(err.message)) {
        cutoffs += 1;
      }
      last = { error: err, text: (answer || '(your previous answer)').slice(0, MAX_ECHO_CHARS) };
      const where = err.detail && err.detail.line ? ` (game.js line ${err.detail.line})` : '';
      say('improver', 'repair', `Attempt ${attemptNo} failed: ${err.message.slice(0, 120)}${where}`);
    }
  }

  const reason = last ? last.error.message : 'no attempt produced a game';
  const failure = new SpecError(`The game does not run after ${attemptNo} attempts: ${reason}`);
  failure.attempts = attemptNo;
  throw failure;
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

  /* Progress is structured, not just a sentence.
     
     "Coder: writing the game" for ninety seconds looks identical to a hang.
     What separates the two is the detail underneath it - which model is being
     asked, which attempt this is, how many lines came back, which file they
     went into - so every step carries those as fields the browser can render,
     rather than folding them into prose it would have to parse back out. */
  const say = (agent, phase, detail, meta = {}) => {
    const entry = {
      agent: CREW[agent] ? CREW[agent].label : 'Tester',
      phase,
      detail,
      at: Date.now() - started,
      ...meta
    };
    transcript.push(entry);
    onStep(entry);
  };

  /* Which model each agent is being put to, as it happens. A founder watching
     "Coder · glm-5.2 (2 of 6)" understands a slow build; "Coder: writing the
     game" tells them nothing and looks broken. */
  const watchModels = (agent, phase) => (info) => {
    say(agent, phase,
      info.index === 1
        ? `Asking ${info.model}`
        : `${info.model} instead (model ${info.index} of ${info.of})`,
      { model: info.model, modelIndex: info.index, modelCount: info.of });
  };

  /* --- 1. Designer -------------------------------------------------------- */
  say('designer', 'design', WORKING_COPY.designer);
  const design = await ask('designer', `Request: ${prompt}`, {
    maxTokens: BRIEF_TOKENS, onModel: watchModels('designer', 'design')
  });
  usage.add(design.usage);
  const brief = design.parsed;
  say('designer', 'design', `Brief ready: ${brief.title} — ${brief.pitch}`,
    { model: design.model, mechanics: (brief.mechanics || []).length });

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

  /* --- 2b. Write it, and keep writing until it runs ----------------------
     Every way a build can fail comes back here, not just one of them.

     This used to retry only a game that failed to BOOT. A game whose code did
     not parse, or whose JSON came back malformed, threw straight out of the
     build with zero retries - which is what a real production run did: three
     agent steps, then dead at 56 seconds on "does not parse: Invalid or
     unexpected token", never having tried a second time. The model gets one
     bad token and the founder gets nothing.

     Now there is one loop over the whole chain - parse the JSON, validate the
     spec, compile the code, boot every scene - and whichever of those fails,
     the exact failure goes back to the model and it tries again. */
  const attempt = await writeUntilItRuns({
    coderMessage, coderText, say, usage, deadline: opts.deadline
  });
  let spec = attempt.spec;
  issues.push(...attempt.issues);
  const response = attempt.response;
  const repairs = attempt.repairs;
  say('tester', 'test', `Run 1 passed — ${attempt.scenes} scenes booted`,
    { scenes: attempt.scenes, attempts: attempt.repairs + 1 });

  /* --- 4. Reviewer -------------------------------------------------------- */
  let review = { verdict: 'ship', findings: [], summary: 'Not reviewed.' };
  try {
    say('reviewer', 'review', WORKING_COPY.reviewer);
    const reviewed = await ask('reviewer', reviewPrompt(brief, spec), {
      maxTokens: BRIEF_TOKENS, onModel: watchModels('reviewer', 'review')
    });
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
    ], { onModel: watchModels('improver', 'improve') });
    usage.add(improved.response.usage);
    {
      const lines = improved.spec.gameCode.javascript.split('\n').length;
      say('improver', 'improve', `Rewrote game.js — ${lines} lines`,
        { file: 'game.js', lines, model: improved.response.model });
    }

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
