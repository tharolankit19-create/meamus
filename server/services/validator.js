'use strict';

/**
 * Parse + normalise a GameSpec.
 *
 * Claude is instructed to answer with raw JSON, but models occasionally wrap it
 * in prose or fences. extractJson() is deliberately forgiving; normaliseSpec()
 * then guarantees every downstream consumer (bundler, UI, APK exporter) sees
 * the same shape.
 */

const vm = require('node:vm');

/**
 * A real Phaser game is thousands of characters. Less means the model returned
 * a stub or a placeholder, which used to ship straight to the preview as a
 * blank frame or a SyntaxError - and still charged for the build.
 *
 * Deliberately NOT a line count: a model writing under a JSON schema will
 * happily put a whole game on one line, and that is still a whole game.
 */
const MIN_CODE_CHARS = 900;

const SPRITE_TYPES = ['player', 'enemy', 'collectible', 'obstacle', 'background', 'ui', 'effect'];
const AUDIO_TYPES = ['bgm', 'sfx', 'ui'];
const STYLES = ['pixel-art', 'vector', 'realistic', 'minimalist', 'cartoon'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

class SpecError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [issues] the spec fields at fault
   * @param {{line?:number, source?:string}} [detail] where in the generated
   *        code the problem is, when that is known. The repair prompt quotes it.
   */
  constructor(message, issues = [], detail = null) {
    super(message);
    this.name = 'SpecError';
    this.status = 422;
    this.issues = issues;
    this.detail = detail;
  }
}

/** Pull the first balanced top-level JSON object out of arbitrary model text. */
function extractJson(text) {
  if (typeof text !== 'string') throw new SpecError('Model response was not text');

  let body = text.trim();

  // Strip a leading ```json fence if present.
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) body = fence[1].trim();

  const start = body.indexOf('{');
  if (start === -1) throw new SpecError('No JSON object found in model response');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = body.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw new SpecError(`Model returned malformed JSON: ${err.message}`);
        }
      }
    }
  }
  throw new SpecError('Model response contained an unterminated JSON object (likely truncated - raise ANTHROPIC_MAX_TOKENS)');
}

/**
 * Parse the generated code without running it.
 *
 * vm.Script compiles and throws on a syntax error, and compiling is not
 * executing - nothing in the code runs here. This is the check that was
 * missing when "Uncaught SyntaxError: Unexpected token ')'" reached a preview.
 */
/* Characters a model reaches for that JavaScript will not accept. Left of the
   arrow is what it writes; right is what it meant. Applied only as a whole set,
   and only if the result then parses. */
const TYPOGRAPHY = [
  [/[\u201C\u201D\u201E\u201F]/g, '"'],    // “ ” „ ‟
  [/[\u2018\u2019\u201A\u201B]/g, "'"],    // ‘ ’ ‚ ‛
  [/[\u2013\u2014\u2212]/g, '-'],          // – — −
  [/\u2026/g, '...'],                       // …
  [/[\u00A0\u2007\u202F\u2009\u200B]/g, ' '],  // non-breaking and thin spaces
  [/\u02DC/g, '~'],
  [/[\u2032\u2033]/g, "'"]                  // ′ ″
];

/**
 * Fix the punctuation a model typed instead of the punctuation JavaScript uses.
 *
 * "Invalid or unexpected token" on line 1 of a one-line file is unactionable
 * and, in production, it was every single attempt. The cause is almost always
 * a smart quote or an em dash where a plain one belongs - a model writing prose
 * and code in the same breath.
 *
 * Mechanical, and verified: the substitution is kept only if the result parses
 * when the original did not. It can change a curly apostrophe inside a piece of
 * on-screen text to a straight one, which is a fair price for a game that runs.
 */
function repairTypography(code) {
  let fixed = code;
  for (const [pattern, replacement] of TYPOGRAPHY) fixed = fixed.replace(pattern, replacement);
  if (fixed === code) return null;

  try {
    new vm.Script(fixed, { filename: 'game.js' });
    return fixed;
  } catch {
    return null;
  }
}

/** The non-ASCII characters in a string, named, so an error can point at them. */
function oddCharacters(code) {
  const seen = new Map();
  for (const ch of code) {
    const point = ch.codePointAt(0);
    if (point < 0x20 || point > 0x7e) {
      if (ch === '\n' || ch === '\t' || ch === '\r') continue;
      seen.set(ch, (seen.get(ch) || 0) + 1);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ch, n]) => `${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})${n > 1 ? ` x${n}` : ''}`);
}

function assertParses(code) {
  try {
    new vm.Script(code, { filename: 'game.js' });
  } catch (err) {
    if (err instanceof SyntaxError) {
      // "does not parse: Invalid or unexpected token" is unactionable - for a
      // person reading it and for the model being asked to fix it. V8 puts the
      // position in the stack, so dig it out and quote the line: a repair
      // prompt that names line 143 and shows it gets a fix; one that says the
      // code is broken somewhere gets another guess.
      const where = syntaxErrorSite(err, code);
      // Only the characters near the failure. Listing every non-ASCII character
      // in the file points at the heart in a score label and sends the next
      // attempt chasing something that was never wrong.
      const odd = oddCharacters(where.source || '');
      const named = odd.length ? `\n  non-ASCII characters near it: ${odd.join(', ')}` : '';
      throw new SpecError(
        `The generated code does not parse: ${err.message}${where.text}${named}`,
        ['gameCode.javascript'],
        { line: where.line, column: where.column, source: where.source, odd }
      );
    }
    throw err;
  }
}

/**
 * Split a file into lines at statement boundaries.
 *
 * Only at real boundaries. The obvious version - replace every `;` with `;\n` -
 * also splits the semicolon inside `'data:image/png;base64,...'`, which turns a
 * perfectly good file into an unterminated string. That is not hypothetical: it
 * was six consecutive production attempts, all reported as
 * "Invalid or unexpected token at this.load.image('loadingBar', 'data" - an
 * error this function had itself created, in code the model had written
 * correctly.
 *
 * So this walks the source and only breaks when it is actually in code: not in
 * a string, a template literal, a comment or a regex.
 */
function statementBoundaries(code) {
  let out = '';
  let i = 0;
  let quote = null;          // ' " or ` when inside a string
  let templateDepth = 0;     // ${ } nesting inside a template literal
  let comment = null;        // 'line' or 'block'
  let regex = false;
  let lastCode = '';         // last significant character seen in code

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (comment) {
      out += ch;
      if (comment === 'line' && ch === '\n') comment = null;
      else if (comment === 'block' && ch === '*' && next === '/') { out += next; i += 1; comment = null; }
      i += 1;
      continue;
    }

    if (quote) {
      out += ch;
      if (ch === '\\') { out += next === undefined ? '' : next; i += 2; continue; }
      if (ch === quote && !(quote === '`' && templateDepth > 0)) quote = null;
      else if (quote === '`' && ch === '$' && next === '{') { out += next; i += 1; templateDepth += 1; }
      else if (quote === '`' && ch === '}' && templateDepth > 0) templateDepth -= 1;
      i += 1;
      continue;
    }

    if (regex) {
      out += ch;
      if (ch === '\\') { out += next === undefined ? '' : next; i += 2; continue; }
      if (ch === '/') regex = false;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') { out += '//'; i += 2; comment = 'line'; continue; }
    if (ch === '/' && next === '*') { out += '/*'; i += 2; comment = 'block'; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { out += ch; quote = ch; i += 1; continue; }

    // A slash is a regex only where a value could start.
    if (ch === '/' && (lastCode === '' || '(,=:[!&|?{};+-*%~^<>'.includes(lastCode))) {
      out += ch; regex = true; i += 1; continue;
    }

    out += ch;
    if (ch === ';' || ch === '{') out += '\n';
    else if (ch === '}') out = `${out.slice(0, -1)}\n}\n`;
    if (!/\s/.test(ch)) lastCode = ch;
    i += 1;
  }

  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Put newlines back into a file that arrived without any.
 *
 * A model answering under a JSON schema will happily write a whole game on one
 * line. That is valid JavaScript, but it is unreadable in the Code tab, and -
 * more importantly - V8 refuses to locate an error inside a line that long, so
 * every syntax failure becomes unfixable.
 *
 * Verified rather than trusted: if the split will not compile and the original
 * would have, the original is kept.
 */
function breakUpOneLiner(code) {
  const lines = code.split('\n').length;
  if (lines > 5 || code.length < 2000) return code;

  const spaced = statementBoundaries(code);

  try {
    new vm.Script(spaced, { filename: 'game.js' });
    return spaced;
  } catch {
    try {
      new vm.Script(code, { filename: 'game.js' });
      return code;          // the original was fine; the split was not
    } catch {
      return spaced;        // both broken: keep the one that can be located
    }
  }
}

/**
 * Pull the offending line out of a V8 SyntaxError.
 *
 * The stack's first frame reads `game.js:143`. Neither the line number nor the
 * source line is on the error object as a field.
 */
function syntaxErrorSite(err, code) {
  const stack = String(err.stack || '');
  const match = /game\.js:(\d+)/.exec(stack);
  if (!match) return { text: '', line: null, source: null, column: null };

  const line = Number(match[1]);
  const full = code.split('\n')[line - 1] || '';

  /* V8 prints the offending source line and a caret under it. The caret is the
     only thing that says WHERE, and for a one-line file it is everything: this
     used to quote `source.slice(0, 200)`, which on a game written without
     newlines showed the first 200 characters of the file every single time -
     "at game.js line 1: const CONFIG = { PLAYER_SPEED: 300," on three separate
     production builds, pointing at code that was perfectly fine. */
  const lines = stack.split('\n');
  const caretAt = lines.findIndex((l) => /^\s*\^\s*$/.test(l));
  const column = caretAt > 0 ? lines[caretAt].indexOf('^') : -1;

  if (column < 0) {
    const source = full.trim().slice(0, 200);
    return { line, column: null, source, text: `\n  at game.js line ${line}: ${source}` };
  }

  // A window around the caret, not the start of the file.
  const from = Math.max(0, column - 60);
  const to = Math.min(full.length, column + 60);
  const excerpt = (from > 0 ? '…' : '') + full.slice(from, to) + (to < full.length ? '…' : '');
  const pointer = ' '.repeat((from > 0 ? 1 : 0) + (column - from)) + '^';

  return {
    line,
    column: column + 1,
    source: full.slice(from, to),
    text: `\n  at game.js line ${line}, column ${column + 1}:\n    ${excerpt}\n    ${pointer}`
  };
}

const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const strArray = (v) => arr(v).map((x) => str(x)).filter(Boolean);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

function normaliseSpec(input, { source = 'ai' } = {}) {
  if (!input || typeof input !== 'object') throw new SpecError('Spec must be an object');

  const issues = [];
  const gc = input.gameConfig && typeof input.gameConfig === 'object' ? input.gameConfig : {};
  const code = input.gameCode && typeof input.gameCode === 'object' ? input.gameCode : {};
  const assets = input.assets && typeof input.assets === 'object' ? input.assets : {};
  const controls = input.controls && typeof input.controls === 'object' ? input.controls : {};

  const title = str(gc.title, 'Untitled Game');
  let javascript = str(code.javascript);

  if (!javascript) throw new SpecError('gameCode.javascript is empty - the model produced no game code', ['gameCode.javascript']);
  if (/\beval\s*\(/.test(javascript) || /new\s+Function\s*\(/.test(javascript)) {
    throw new SpecError('Generated code uses eval()/new Function() - rejected', ['gameCode.javascript']);
  }

  /* Hard gates. Anything that fails these is not a game, and shipping it means
     a broken preview the player still paid for.

     Order matters here. The file is reformatted BEFORE it is parsed, because
     V8 gives up on locating an error in a very long line: on a 22,000-character
     one-liner it prints a caret line of a thousand spaces and no caret at all.
     Three production builds reported "at game.js line 1: const CONFIG = {
     PLAYER_SPEED: 300," on every attempt - which was not the error site, just
     the first forty characters of the file, because there was no error site to
     be had. Split into lines first and the failure gets a real line and column,
     which is the difference between a repair prompt that can work and one that
     is guessing. */
  javascript = breakUpOneLiner(javascript);

  // A mechanical fault with a mechanical fix, tried before giving up.
  const detyped = repairTypography(javascript);
  if (detyped) {
    javascript = detyped;
    issues.push('The model used smart quotes or dashes in the code; they were replaced with plain ASCII.');
  }
  assertParses(javascript);

  /* Size is measured in characters, not lines.

     It used to be both, and the line half threw away working games. A model
     answering under a JSON schema often writes the whole file on ONE line -
     no newlines anywhere - and that is still perfectly good JavaScript.
     Production failed seven attempts in a row on "1 lines of code, which is a
     stub", rejecting a game that had already passed the parser each time.

     A stub is short. That is what short means here now, and the boot test is
     what decides whether the thing actually runs. */
  if (javascript.length < MIN_CODE_CHARS) {
    throw new SpecError(
      `The model returned ${javascript.length} characters of code, which is a stub rather than a playable game.`,
      ['gameCode.javascript']
    );
  }

  const lineCount = javascript.split('\n').length;
  if (!/new\s+Phaser\.Game/.test(javascript) && !/MEAMUS\.boot\s*\(/.test(javascript)) {
    throw new SpecError('The generated code never starts a Phaser game.', ['gameCode.javascript']);
  }
  if (!/GameScene/.test(javascript)) issues.push('no GameScene found in gameCode.javascript');
  if (lineCount > 2600) issues.push(`gameCode.javascript is ${lineCount} lines (guideline is <= 2000)`);

  const spec = {
    gameConfig: {
      title,
      genre: str(gc.genre, 'arcade').toLowerCase(),
      description: str(gc.description, `${title} - generated by meamus.`),
      difficulty: oneOf(str(gc.difficulty).toLowerCase(), DIFFICULTIES, 'medium'),
      estimatedPlayTime: str(gc.estimatedPlayTime, '2-5 minutes per session')
    },
    assets: {
      sprites: arr(assets.sprites).map((s, i) => ({
        name: str(s && s.name, `sprite_${i + 1}`),
        type: oneOf(str(s && s.type).toLowerCase(), SPRITE_TYPES, 'effect'),
        description: str(s && s.description, 'Procedural placeholder sprite.'),
        size: str(s && s.size, '32x32'),
        style: oneOf(str(s && s.style).toLowerCase(), STYLES, 'pixel-art')
      })),
      audio: arr(assets.audio).map((a, i) => ({
        name: str(a && a.name, `sound_${i + 1}`),
        type: oneOf(str(a && a.type).toLowerCase(), AUDIO_TYPES, 'sfx'),
        description: str(a && a.description, 'Placeholder sound.')
      }))
    },
    gameCode: {
      html: str(code.html),
      javascript,
      css: str(code.css)
    },
    controls: {
      keyboard: strArray(controls.keyboard),
      touch: strArray(controls.touch),
      mouse: strArray(controls.mouse)
    },
    mechanics: arr(input.mechanics)
      .map((m, i) => ({
        name: str(m && m.name, `Mechanic ${i + 1}`),
        description: str(m && m.description),
        implementation: str(m && m.implementation)
      }))
      .filter((m) => m.description || m.implementation),
    monetizationHooks: strArray(input.monetizationHooks),
    mobileOptimizations: strArray(input.mobileOptimizations),
    apkReady: input.apkReady === true
  };

  // Runtime metadata drives the bundler (templates opt into the shared kit).
  spec.runtime = {
    kit: input.runtime && input.runtime.kit === true,
    phaserVersion: str(input.runtime && input.runtime.phaserVersion, '3.60.0'),
    source
  };

  if (!spec.controls.keyboard.length) issues.push('no keyboard controls documented');
  if (!spec.controls.touch.length) issues.push('no touch controls documented');
  if (!spec.assets.sprites.length) issues.push('no sprite descriptions - asset pipeline has nothing to generate');
  if (!spec.monetizationHooks.length) issues.push('no monetization hooks declared');

  return { spec, issues };
}

module.exports = { extractJson, normaliseSpec, SpecError, SPRITE_TYPES, AUDIO_TYPES, STYLES, DIFFICULTIES };
