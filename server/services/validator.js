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
 * A real Phaser game is hundreds of lines. A handful means the model returned a
 * stub or a placeholder, which used to ship straight to the preview as a blank
 * frame or a SyntaxError - and still charged for the build.
 */
const MIN_CODE_LINES = 40;
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
      throw new SpecError(
        `The generated code does not parse: ${err.message}${where.text}`,
        ['gameCode.javascript'],
        { line: where.line, source: where.source }
      );
    }
    throw err;
  }
}

/**
 * Pull the offending line out of a V8 SyntaxError.
 *
 * The stack's first frame reads `game.js:143`, and the frames above it repeat
 * the source line and a caret. Both are useful, and neither is on the error
 * object as a field.
 */
function syntaxErrorSite(err, code) {
  const match = /game\.js:(\d+)/.exec(err.stack || '');
  if (!match) return { text: '', line: null, source: null };

  const line = Number(match[1]);
  const source = (code.split('\n')[line - 1] || '').trim().slice(0, 200);
  return {
    line,
    source,
    text: `\n  at game.js line ${line}: ${source}`
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
  const javascript = str(code.javascript);

  if (!javascript) throw new SpecError('gameCode.javascript is empty - the model produced no game code', ['gameCode.javascript']);
  if (/\beval\s*\(/.test(javascript) || /new\s+Function\s*\(/.test(javascript)) {
    throw new SpecError('Generated code uses eval()/new Function() - rejected', ['gameCode.javascript']);
  }

  // Hard gates. Anything that fails these is not a game, and shipping it means
  // a broken preview the player still paid for.
  assertParses(javascript);

  const lineCount = javascript.split('\n').length;
  if (lineCount < MIN_CODE_LINES || javascript.length < MIN_CODE_CHARS) {
    throw new SpecError(
      `The model returned ${lineCount} lines of code, which is a stub rather than a playable game.`,
      ['gameCode.javascript']
    );
  }
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
