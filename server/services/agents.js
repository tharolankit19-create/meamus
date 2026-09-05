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
const models = require('./models');
const smoke = require('./smoke');
const { RESPONSE_FORMAT } = require('./schema');
const { extractJson, normaliseSpec, SpecError } = require('./validator');
const { lineDiff } = require('./diff');

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
      'is not one. Assume procedural art only: no downloads, no asset packs.',
      '',
      'Art direction defaults to LIGHT: a soft, light ground with one accent',
      'colour carrying the player and one carrying rewards. Describe a dark or',
      'neon palette ONLY if the request asks for one — "dark", "night", "space",',
      '"horror", "neon". A dark canvas with saturated neon on it is what a',
      'generated game looks like, and it is the look to avoid unless it was',
      'asked for. Name four to six colours in words, and say which is the',
      'player, which is the reward and which is the danger.',
      '',
      'Controls must work with a thumb and with a keyboard. Fill in both.'
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

/* How long a brief may take before it is costing more than it is worth.

   A page of JSON usually comes back in three to twenty seconds. One watched
   build took a hundred and three - half the whole budget - and the game never
   got written. The brief is worth having, but not at the price of the thing it
   is a brief for, so the call is cut off and the build goes on with what the
   founder actually typed. */
const BRIEF_TIMEOUT_MS = 45 * 1000;

/* How much of a rejected answer to quote back when asking for a fix. A whole
   game is 30-40k characters and re-sending all of it every round is what turns
   a repair loop into the most expensive part of a build. */
const MAX_ECHO_CHARS = 48000;

/**
 * The brief to build from when the designer could not produce one.
 *
 * Not a substitute for a designed game - it is the founder's own sentence,
 * shaped so the rest of the crew has the fields it reads. That is enough to
 * build from, and it is what the single-call path has always worked from.
 */
function briefFromPrompt(prompt) {
  const words = String(prompt).trim().split(/\s+/).filter(Boolean);
  return {
    title: words.slice(0, 3).map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean).join(' ') || 'Your Game',
    genre: 'arcade',
    pitch: String(prompt).trim().slice(0, 200),
    coreLoop: 'As described in the request.',
    mechanics: [],
    controls: { keyboard: [], touch: [], mouse: [] },
    art: { palette: 'coherent and readable', style: 'minimalist', sprites: [] },
    difficulty: 'medium',
    progression: 'It gets harder the longer a run lasts.',
    failState: 'As described in the request.'
  };
}

/** A JSON-answering agent. Returns the parsed object plus its usage. */
async function ask(role, userContent, { maxTokens, onModel, timeoutMs } = {}) {
  const agent = CREW[role];
  const response = await llm.complete({
    system: agent.system,
    messages: [{ role: 'user', content: userContent }],
    maxTokens,
    timeoutMs,
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

/* The floor. Below this there is no game left to cut down to, and asking for
   40 lines gets an apology rather than something smaller. */
const SHRINK_FLOOR = 90;

/**
 * How long a game to ask for next.
 *
 * The ladder alone starts at 320 lines, which is a guess about the model made
 * before it had written anything. A watched production build showed what that
 * guess costs: the model ran out of room at line 147, and the correction asked
 * it for a 320-line game - more than twice what it had just failed to finish -
 * so it ran out of room again at line 151, and again.
 *
 * The length it actually reached is the one real measurement available, and it
 * beats any ladder. Ask for a third less than it managed, so there is room to
 * finish rather than just room to stop in a different place. The ladder still
 * applies as a ceiling, so repeated cut-offs keep pulling the target down even
 * when the model reaches roughly the same length each time.
 *
 * @param {number} cutoffs how many answers have been cut off so far
 * @param {number} [reached] lines the last cut-off answer got to
 */
function shrinkTarget(cutoffs, reached) {
  const ladder = SHRINK_STEPS[Math.min(cutoffs, SHRINK_STEPS.length - 1)];
  if (!reached) return ladder;
  return Math.max(SHRINK_FLOOR, Math.min(ladder, Math.round(reached * 0.66)));
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
  const named = /Unexpected end of input|unterminated|ran out of room|cut off/i.test(err.message);

  /* A parse error at the end of the file is a cut-off file, whatever V8 chose
     to call it. "Missing catch or finally after try" is a real mistake in the
     middle of a program and an unfinished `try {` at the last line - and only
     the position tells them apart. Production hit the second one four times
     running and was told to check its punctuation every time, because the
     message did not contain any of the words above.

     Within three lines of the end, because the failure is often reported at the
     closing brace rather than the last character written. */
  const atTheEnd = err.detail && err.detail.totalLines && err.detail.line
    && err.detail.totalLines - err.detail.line <= 3;

  if (named || atTheEnd) {
    // How far it actually got, when the parse failure could say.
    const reached = (err.detail && err.detail.totalLines) || null;
    const lines = shrinkTarget(cutoffs, reached);
    return 'Your last answer stopped before the game was finished - the file ends '
      + `mid-way${err.detail && err.detail.line ? ` (around line ${err.detail.line})` : ''}.\n\n`
      + `You do not have room for a game that size.${reached ? ` You reached line ${reached} `
        + 'and stopped.' : ''} Write one of about ${lines} lines `
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

  /* A method Phaser does not have. The boot test names the real one, so the
     correction's job is to make sure that lands rather than being buried under
     the generic "declare every variable" advice. */
  if (/is not a function - Phaser has no such method/.test(err.message)) {
    return `That build does not run: ${err.message}\n\n`
      + 'You called a Phaser method that does not exist. Use only the real API. For '
      + 'keyboard input that is:\n\n'
      + '    this.cursors = this.input.keyboard.createCursorKeys();   // arrows + space + shift\n'
      + "    this.wasd = this.input.keyboard.addKeys('W,A,S,D');\n"
      + "    this.fire = this.input.keyboard.addKey('SPACE');\n\n"
      + 'Return the complete corrected GameSpec JSON.';
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
 *
 * And if one model keeps failing in the same way, it is replaced. A rate limit
 * is a transport failure and llm.js handles it; a model that answers with a
 * 143-character stub three times and then an unfinished file six more is not
 * refusing to serve, it is serving badly, and no amount of rephrasing fixes
 * that. Only this layer can see it, because only this layer knows whether the
 * answer was any good.
 */

/* How many failures from one model before trying a different one.
   
   Two is too eager - the first correction is often the one that lands, and
   switching discards the conversation that was about to work. Beyond three the
   evidence is in: production asked the same model nine times in a row, got nine
   unusable answers, spent 182 seconds and shipped nothing, while five other
   models sat untried. */
const FAILURES_BEFORE_SWITCHING = 3;

/* ...unless the failures are expensive. A later build spent 75, 65 and 50
   seconds on three attempts from one model and ran out of time on the third -
   it reached the switch and had nothing left to switch to. Three strikes is a
   sensible rule when a strike costs twenty seconds and a bad one when it costs
   seventy, so past this share of the budget two failures are enough. */
const IMPATIENT_AFTER = 0.4;

function shouldSwitch(failures, startedAt, until) {
  if (failures >= FAILURES_BEFORE_SWITCHING) return true;
  const budget = until - startedAt;
  const spent = Date.now() - startedAt;
  return failures >= 2 && budget > 0 && spent / budget > IMPATIENT_AFTER;
}
/* How many models write the game at the same time on the first go.

   Three, and the number is a trade rather than a preference. One model writing
   alone is the slowest and worst version of this: a watched build spent
   seventy-five seconds on an answer that arrived cut off, and the next model
   was not asked until that had happened three times. Free models are slow and
   unreliable in different ways from each other, so asking three at once and
   keeping whichever finishes first is faster AND better - it is a best-of-three
   on quality and a race on latency, for the price of two requests that get
   thrown away.

   Not more than three, because the free tier is a shared resource and a build
   that fires eighteen requests to win one game is how a roster gets rate
   limited for everybody, including its own later attempts. */
const RACERS = 3;

/**
 * Several coders writing the same game at once. First one that RUNS wins.
 *
 * "Runs" is the whole point - not first to answer, not longest, not the one
 * from the model with the best reputation. Each racer's answer is parsed,
 * validated and booted here, and only a spec that survives all three counts as
 * finishing. A model that returns instantly with an unfinished file has not won
 * anything.
 *
 * The losers are not cancelled - there is nothing to cancel, the requests are
 * already in flight and the tokens already spent - but their answers are kept:
 * if nobody produces a running game, the one that got furthest becomes the
 * draft the repair loop works from, which is a better starting point than
 * asking a fourth model to begin again from nothing.
 *
 * @returns {{spec?:object, issues?:string[], response?:object, model?:string,
 *            scenes?:number, best?:{error:Error, text:string, model:string}}}
 */
async function raceCoders({ messages, say, usage, skip = [] }) {
  const roster = models.candidates('coder')
    .filter((m) => !skip.includes(m.id))
    .slice(0, RACERS);

  if (roster.length < 2) return null;   // nothing to race against

  say('coder', 'build', `${roster.length} models writing it at the same time — first one that runs wins`,
    { artifact: 'game.js', artifactState: 'writing', modelCount: roster.length });

  const attempts = roster.map(async (candidate) => {
    const startedAt = Date.now();
    let answer = '';
    try {
      const response = await llm.complete({
        messages, jsonSchema: true, role: 'coder', only: candidate.id
      });
      usage.add(response.usage);
      answer = response.text;

      const raw = extractJson(response.text);
      const { spec, issues } = normaliseSpec(raw, { source: 'ai' });
      const booted = smoke.boot(spec.gameCode.javascript);

      return {
        spec, issues, response, scenes: booted.scenes.length,
        model: candidate.id, tookMs: Date.now() - startedAt
      };
    } catch (err) {
      /* Carry the answer on the failure. A racer that wrote four hundred lines
         and stopped has produced something worth repairing, and without this
         the only thing that survives the rejection is the error message. */
      err.answerText = answer;
      throw err;
    }
  });

  /* Promise.any resolves on the first success and only rejects if every one of
     them fails - which is exactly the semantics wanted here, and the reason the
     failures have to be collected separately: an AggregateError does not say
     which model produced which failure, and the repair loop needs the text. */
  const failures = [];
  const watched = attempts.map((p, i) => p.catch((err) => {
    failures.push({ error: err, model: roster[i].id, text: err.answerText || '' });
    say('improver', 'repair', `${roster[i].id.split('/').pop()} did not get there: ${String(err.message).slice(0, 90)}`,
      { model: roster[i].id });
    throw err;
  }));

  try {
    const winner = await Promise.any(watched);
    say('coder', 'build',
      `${winner.spec.gameCode.javascript.split('\n').length} lines, `
      + `${Math.round(winner.spec.gameCode.javascript.length / 1024)} KB`,
      {
        artifact: 'game.js', artifactState: 'done',
        lines: winner.spec.gameCode.javascript.split('\n').length,
        bytes: winner.spec.gameCode.javascript.length,
        added: winner.spec.gameCode.javascript.split('\n').length,
        removed: 0, exactDiff: true,
        model: winner.response.model, tookMs: winner.tookMs
      });
    return winner;
  } catch {
    /* Everybody failed. Hand back whoever wrote the most, because a long
       answer that stopped short is a better draft to repair than a short one
       that never started. */
    const best = failures
      .filter((f) => f.text)
      .sort((a, b) => b.text.length - a.text.length)[0];
    return { best: best || failures[0] || null, failures };
  }
}

async function writeUntilItRuns({ coderMessage, coderText, say, usage, deadline }) {
  const startedAt = Date.now();
  const until = deadline || (startedAt + config.build.budgetMs);
  const issues = [];
  let last = null;
  let attemptNo = 0;
  // Each answer that stopped short makes the next request smaller.
  let cutoffs = 0;
  /* Which model wrote the last answer, how many times running it has failed,
     and who has been written off. */
  let currentModel = null;
  let failuresInARow = 0;
  const givenUp = [];
  // The last code that got far enough to be worth diffing the next one against.
  let lastCode = '';

  /* First move: several models at once, and keep whichever runs.
  
     This is where a build is won or lost. Every watched production failure had
     the same shape - one model, one slow answer, one unusable result, repeat
     until the clock ran out - and the fix is not a better model, it is not
     betting the whole build on one. */
  const raced = await raceCoders({ messages: [coderMessage.message], say, usage, skip: givenUp });
  if (raced && raced.spec) {
    lastCode = raced.spec.gameCode.javascript;
    say('tester', 'test', `Run 1 passed — ${raced.scenes} scenes booted`,
      { scenes: raced.scenes, model: raced.response.model });
    return {
      spec: raced.spec,
      issues: raced.issues,
      response: raced.response,
      repairs: 0,
      scenes: raced.scenes
    };
  }

  /* Nobody won. The longest answer becomes the draft to repair, because a game
     that stopped short is a better starting point than a blank page - and the
     model that wrote it is the one being corrected, so the loop below carries
     on the conversation rather than starting a new one. */
  if (raced && raced.best) {
    last = { error: raced.best.error, text: String(raced.best.text || '').slice(0, MAX_ECHO_CHARS) };
    currentModel = raced.best.model;
    if (/Unexpected end of input|unterminated|ran out of room|cut off|stub rather than/i.test(raced.best.error.message)) {
      cutoffs += 1;
    }
    attemptNo = 1;   // the race was the first attempt
  }

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
      : `Rewriting it (attempt ${attemptNo})`,
    { attempt: attemptNo, artifact: 'game.js', artifactState: 'writing' });

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
        messages, jsonSchema: true, role: 'coder', skip: givenUp,
        onModel: (info) => say('coder', 'build',
          info.index === 1
            ? `Asking ${info.model}`
            : `${info.model} instead (model ${info.index} of ${info.of})`,
          { model: info.model, modelIndex: info.index, modelCount: info.of, attempt: attemptNo })
      });
      usage.add(response.usage);
      answer = response.text;

      // A different model answered, so its failures start from zero.
      if (response.model !== currentModel) { currentModel = response.model; failuresInARow = 0; }

      // Each of these can throw, and each throw is a retry with the reason.
      const raw = extractJson(response.text);
      const { spec, issues: specIssues } = normaliseSpec(raw, { source: 'ai' });
      const code = spec.gameCode.javascript;
      const lines = code.split('\n').length;

      /* What actually changed since the last attempt. On the first attempt
         everything is new; on a rewrite this is a real line diff, because a
         number on screen that was not measured is decoration. */
      const change = lineDiff(lastCode, code);
      lastCode = code;

      say('coder', 'build',
        `${lines} lines, ${Math.round(code.length / 1024)} KB`,
        {
          artifact: 'game.js',
          artifactState: 'done',
          lines,
          bytes: code.length,
          added: change.added,
          removed: change.removed,
          exactDiff: change.exact,
          model: response.model,
          attempt: attemptNo
        });

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

      /* Out of time is not a failure to feed back, it is the end.
      
         The llm layer's budget starts when the build does and this loop's
         deadline starts later, so the layer below can know the time is gone
         while this one still thinks there is some - and then every retry fails
         instantly with the same sentence. A watched build did that nine times
         in the same second, turning "out of time" into twelve attempts and an
         error that blamed the prompt. */
      if (err && err.details && err.details.budgetExhausted) {
        say('coder', 'build', `Out of time after ${attemptNo} attempts`);
        throw err;
      }

      /* Say what went wrong first, then decide what to do about it. Reporting
         only the switch loses the attempt that caused it - a watched build
         showed "has failed 3 times" with no third failure above it, which is
         the log telling a story with a page missing. */
      const site = err.detail && err.detail.line ? ` (game.js line ${err.detail.line})` : '';
      say('improver', 'repair', `Attempt ${attemptNo} failed: ${err.message.slice(0, 120)}${site}`);

      /* A model that wrote a complete, parseable game and tripped on one call
         is not the problem - it is one correction away, and that correction is
         a precise one. Switching there throws away the best candidate in the
         build and starts over with a model that has written nothing. A watched
         build did exactly that: dots-3 produced 523 lines and was dropped for
         a single wrong method name. So a boot failure does not count towards
         giving up on a model; only answers that never became a game do. */
      const wroteAGame = err && err.name === 'SmokeError';
      if (wroteAGame) failuresInARow = 0;

      /* If the same model has now produced several unusable answers in a row,
         stop rephrasing the question and change who is being asked - the next
         attempt starts fresh with a different model rather than carrying on a
         conversation that is not converging. */
      if (currentModel && err.name !== 'LlmError' && !wroteAGame) {
        failuresInARow += 1;
        if (shouldSwitch(failuresInARow, startedAt, until) && givenUp.length < models.CODER.length - 1) {
          givenUp.push(currentModel);
          say('coder', 'build',
            `${currentModel} has failed ${failuresInARow} times - trying a different model`,
            { model: currentModel, attempt: attemptNo });
          currentModel = null;
          failuresInARow = 0;
          // A fresh model should not be handed the last one's broken draft.
          last = null;
          cutoffs = 0;
          continue;
        }
      }

      // Quote what it actually wrote, so the next attempt is an edit rather
      // than a restart from nothing. Capped, because a rejected answer is
      // still most of a game and re-sending all of it every round is what
      // makes a repair loop cost more than the build.
      if (/Unexpected end of input|unterminated|ran out of room|cut off|never (called|starts)|stub rather than/i.test(err.message)) {
        cutoffs += 1;
      }
      last = { error: err, text: (answer || '(your previous answer)').slice(0, MAX_ECHO_CHARS) };
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
  say('designer', 'design', WORKING_COPY.designer,
    { artifact: 'brief.json', artifactState: 'writing' });
  let design;
  try {
    design = await ask('designer', `Request: ${prompt}`, {
      maxTokens: BRIEF_TOKENS, timeoutMs: BRIEF_TIMEOUT_MS,
      onModel: watchModels('designer', 'design')
    });
  } catch (err) {
    /* No brief is a worse build, not a failed one. The coder's own prompt
       already describes the game; losing the designer costs polish, and
       spending the budget waiting for it costs the game. */
    issues.push(`The designer did not answer in time (${err.message}), so the game was built `
      + 'straight from the prompt.');
    say('designer', 'design', 'No brief in time — building straight from your prompt');
    design = { parsed: null, usage: null, model: null };
  }
  usage.add(design.usage);
  const brief = design.parsed || briefFromPrompt(prompt);
  if (design.parsed) {
    const doc = JSON.stringify(brief, null, 2);
    say('designer', 'design', `${brief.title} — ${brief.pitch}`, {
      artifact: 'brief.json',
      artifactState: 'done',
      lines: doc.split('\n').length,
      bytes: doc.length,
      added: doc.split('\n').length,
      removed: 0,
      exactDiff: true,
      model: design.model,
      mechanics: (brief.mechanics || []).length
    });
  }

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
    say('improver', 'improve', WORKING_COPY.improver,
      { artifact: 'game.js', artifactState: 'writing' });
    try {
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
        const before = spec.gameCode.javascript;
        const afterCode = improved.spec.gameCode.javascript;
        const change = lineDiff(before, afterCode);
        say('improver', 'improve',
          `${afterCode.split('\n').length} lines after the review`,
          {
            artifact: 'game.js',
            artifactState: 'done',
              lines: afterCode.split('\n').length,
            bytes: afterCode.length,
            added: change.added,
            removed: change.removed,
            exactDiff: change.exact,
            model: improved.response.model
          });
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
    } catch (err) {
      issues.push(`Review fixes could not be completed (${err.message}); kept the tested version.`);
      say('improver', 'improve', 'Kept the tested version; review fixes could not be completed');
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
 *
 * It used to end on "Booted and ticked twice before shipping" and repeat the
 * reviewer's own verdict on its own work - "the reviewer found nothing blocking
 * — this is a solid arcade experience". Both are the house style of a machine
 * congratulating itself, and a founder reading it learns nothing they could
 * check. So the evaluative half is gone and what is left is countable: what the
 * game is, what is in it, what the test did, and what went wrong on the way.
 *
 * The one judgement kept is the reviewer's list of problems it FOUND, because a
 * named fix is a fact about the code. Its summary sentence is not.
 */
function summarise(meta) {
  const brief = meta.brief || {};
  const review = meta.review || {};
  const lines = [];

  // What it is. The pitch is the designer describing the game, not the crew
  // describing its own work, so it stays.
  if (brief.pitch) lines.push(`**${brief.title}** — ${brief.pitch}`);
  if (brief.coreLoop) lines.push(`Core loop: ${brief.coreLoop}`);
  if ((brief.mechanics || []).length) {
    lines.push(`Mechanics: ${brief.mechanics.map((m) => m.name).join(', ')}`);
  }

  /* What happened, as numbers. Every one of these is either true of the file
     that shipped or of a test that ran, which is the difference between a
     report and a press release. */
  const facts = [];
  const scenes = (meta.transcript || []).reduce((n, t) => Math.max(n, t.scenes || 0), 0);
  if (scenes) facts.push(`${scenes} scene${scenes > 1 ? 's' : ''} booted and ticked`);
  if (meta.attempts > 1) facts.push(`${meta.attempts} attempts to get it running`);

  /* Which model wrote it, when it was not the first one asked. Silent on the
     happy path - naming the model every time is noise - but a build that took
     two minutes because three models refused is a different story from a slow
     one, and the founder is owed the difference. */
  const switched = (meta.transcript || []).some((t) => t.modelIndex > 1);
  if (switched && meta.model) facts.push(`written by ${meta.model} after earlier models declined`);

  const fixes = (review.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  if (fixes.length) {
    lines.push(`Fixed before shipping: ${fixes.map((f) => f.what).join('; ')}`);
  }

  if (facts.length) lines.push(facts.join(' · '));

  /* Anything that did not go to plan. A build that quietly dropped a reference
     image or shipped the second-best version should say so here rather than
     leave the founder to notice on their own. */
  for (const issue of (meta.issues || []).slice(0, 3)) lines.push(issue);

  /* And the sentence they were actually waiting for.
  
     Everything above is a report on work that is already finished; none of it
     says the one thing a founder wants to know, which is whether they can
     press play. It lives here rather than only in the live panel because the
     panel is gone after a reload and this is not. */
  lines.push('It is running on the right — play it, then tell me what to change.');

  return lines.join('\n');
}

module.exports = {
  buildWithCrew, summarise, correctionFor, CREW, WORKING_COPY,
  FAILURES_BEFORE_SWITCHING, RACERS
};
