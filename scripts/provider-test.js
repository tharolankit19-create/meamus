#!/usr/bin/env node
'use strict';

/**
 * Provider tests. Runs a stand-in OpenRouter on localhost so the exact request
 * shape can be asserted without a key or a network: endpoint, auth header,
 * attribution headers, model id, system/user ordering, the structured-output
 * schema, and how attachments are handled for a model that cannot read images.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const FAKE_SPEC = {
  gameConfig: {
    title: 'Block Dodge', genre: 'arcade', description: 'Dodge blocks, grab coins.',
    difficulty: 'medium', estimatedPlayTime: '2 minutes per run'
  },
  assets: {
    sprites: [{ name: 'player', type: 'player', description: 'A 32x32 cyan square', size: '32x32', style: 'minimalist' }],
    audio: [{ name: 'coin', type: 'sfx', description: 'Bright ping' }]
  },
  gameCode: {
    html: '', css: '',
    // Valid, parseable JS long enough to clear the stub gate. It used to be one
    // class repeated 20 times, which declared GameScene 20 times and does not
    // parse - the validator's syntax check is what surfaced that.
    javascript: [
      'class GameScene extends Phaser.Scene {',
      '  constructor() { super({ key: "GameScene" }); }',
      '  create() {',
      '    this.score = 0;',
      '    this.best = Number(localStorage.getItem("best") || 0);',
      '    this.player = this.add.rectangle(160, 400, 32, 32, 0x33ddff);',
      '    this.physics.add.existing(this.player);',
      '    this.cursors = this.input.keyboard.createCursorKeys();',
      '    this.blocks = this.physics.add.group();',
      '    this.time.addEvent({ delay: 700, loop: true, callback: () => this.drop() });',
      '    this.label = this.add.text(12, 12, "SCORE 0", { fontSize: "18px" });',
      '  }',
      '  drop() {',
      '    const x = Phaser.Math.Between(20, 300);',
      '    const block = this.blocks.create(x, -20, null);',
      '    block.setVelocityY(180);',
      '  }',
      '  update() {',
      '    const speed = 260;',
      '    let vx = 0;',
      '    if (this.cursors.left.isDown) vx = -speed;',
      '    else if (this.cursors.right.isDown) vx = speed;',
      '    this.player.body.setVelocityX(vx);',
      '    this.blocks.children.each((b) => {',
      '      if (b.y > 520) { b.destroy(); this.bump(); }',
      '    });',
      '  }',
      '  bump() {',
      '    this.score += 1;',
      '    this.label.setText("SCORE " + this.score);',
      '    if (this.score > this.best) localStorage.setItem("best", this.score);',
      '  }',
      '}',
      'new Phaser.Game({',
      '  type: Phaser.AUTO,',
      '  width: 320,',
      '  height: 480,',
      '  parent: "game-container",',
      '  physics: { default: "arcade", arcade: { gravity: { y: 0 } } },',
      '  scene: [GameScene],',
      '  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }',
      '});'
    ].join('\n')
  },
  controls: { keyboard: ['Arrows to move'], touch: ['Drag to move'], mouse: ['Move to steer'] },
  mechanics: [{ name: 'Dodge', description: 'Avoid falling blocks', implementation: 'Arcade overlap' }],
  monetizationHooks: ['Interstitial on game over'],
  mobileOptimizations: ['Phaser.Scale.FIT'],
  apkReady: false
};

const captured = [];
// Flipped by the truncation test: makes the next reply stop at the ceiling.
let truncateNext = false;
// A scripted queue of coder replies, or the string 'always-garbage'. Null means
// "answer every call with the good spec", which is what most tests want.
let replies = null;
let replyAt = 0;
// Number of coder calls to answer with a rate limit before behaving.
let rateLimitFirst = 0;
// Per-model refusals, for the routing tests: model id -> { status, message }.
// A model in here answers with that status instead of a spec, every time.
const refuse = new Map();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');

    if (req.url.endsWith('/models')) {
      // Mirrors the real catalogue entry for Nemotron 3 Super 120B (free tier).
      return res.end(JSON.stringify({
        data: [{
          id: 'nvidia/nemotron-3-super-120b-a12b:free',
          context_length: 262144,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature', 'seed'],
          top_provider: { max_completion_tokens: 235929 }
        }, {
          id: 'dots-studio/dots-3-note-preview:free',
          context_length: 460800,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
          top_provider: { max_completion_tokens: 460800 }
        }, {
          // Deliberately small, so the ceiling clamp has something to bite on.
          id: 'liquid/lfm-2.5-2.6b:free',
          context_length: 32768,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
          top_provider: { max_completion_tokens: 8192 }
        }]
      }));
    }

    const parsed = JSON.parse(body || '{}');
    captured.push({ url: req.url, headers: req.headers, body: parsed });

    // Routing tests: this model has been told to say no.
    const refusal = refuse.get(parsed.model);
    if (refusal) {
      res.statusCode = refusal.status;
      return res.end(JSON.stringify({ error: { message: refusal.message } }));
    }
    // A scripted reply, when a test is driving the coder through failures.
    const sys = ((parsed.messages || []).find((m) => m.role === 'system') || {}).content || '';
    const isCoder = !/you produce the brief|You review Phaser 3/i.test(sys);

    if (isCoder && rateLimitFirst > 0) {
      rateLimitFirst -= 1;
      res.statusCode = 429;
      return res.end(JSON.stringify({ error: { message: 'Provider returned error' } }));
    }
    if (replies && isCoder) {
      if (replies === 'always-garbage') {
        return res.end(JSON.stringify({
          id: 'gen-test', model: parsed.model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'I cannot do that.' } }],
          usage: { prompt_tokens: 900, completion_tokens: 40 }
        }));
      }
      const scripted = replies[Math.min(replyAt, replies.length - 1)];
      replyAt += 1;
      return res.end(JSON.stringify({
        id: 'gen-test', model: parsed.model,
        choices: [{
          finish_reason: scripted.finish || 'stop',
          message: { role: 'assistant', content: scripted.content }
        }],
        usage: { prompt_tokens: 1200, completion_tokens: 4300, total_tokens: 5500 }
      }));
    }
    if (!replies) replyAt = 0;

    const cut = truncateNext;
    res.end(JSON.stringify({
      id: 'gen-test', model: parsed.model,
      choices: [{
        finish_reason: cut ? 'length' : 'stop',
        message: {
          role: 'assistant',
          content: cut ? JSON.stringify(FAKE_SPEC).slice(0, 400) : JSON.stringify(FAKE_SPEC)
        }
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 4300, total_tokens: 5500 }
    }));
  });
});

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

(async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'meamus-provider-'));
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.DATA_DIR = tmpData;
  delete process.env.ANTHROPIC_API_KEY;

  const llm = require('../server/services/llm');
  const config = require('../server/config');
  const generator = require('../server/services/generator');

  console.log(`\nmeamus provider test  (mock OpenRouter on :${port})\n`);

  // The wire-shape checks below are about the call that produces a GameSpec.
  // The crew wraps that call in a designer before it and a reviewer after, so
  // they run with the crew off and get asserted on again, as a crew, at the end
  // of this file. Testing the shape through the crew would mean every
  // assertion had to guess which of four calls it meant.
  const crewDefault = config.build.crew;
  config.build.crew = false;

  await check('capabilities come from the live catalogue', async () => {
    const caps = await llm.capabilities();
    assert.strictEqual(caps.source, 'catalogue');
    assert.strictEqual(caps.images, false, 'Nemotron 3 Super takes text only');
    assert.strictEqual(caps.structuredOutputs, true);
    assert.strictEqual(caps.maxOutput, 235929);
  });

  await check('generation posts an OpenAI-shaped chat completion', async () => {
    captured.length = 0;
    await generator.generate('a game where you dodge falling blocks', { allowFallback: false });
    const [req] = captured;
    assert.ok(req.url.endsWith('/chat/completions'), `wrong path: ${req.url}`);
    assert.strictEqual(req.headers.authorization, 'Bearer sk-or-test-key');
    assert.strictEqual(req.headers['x-title'], 'meamus');
    assert.ok(req.headers['http-referer'], 'missing the OpenRouter attribution header');
    assert.strictEqual(req.body.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.strictEqual(req.body.messages[0].role, 'system');
    assert.ok(req.body.messages[0].content.includes('meamus'), 'system prompt was not sent');
    assert.strictEqual(req.body.messages[1].role, 'user');
    assert.strictEqual(req.body.max_tokens, 32000);
  });

  await check('structured outputs carry the full GameSpec schema', async () => {
    const [req] = captured;
    assert.ok(req.body.response_format, 'response_format is missing');
    assert.strictEqual(req.body.response_format.type, 'json_schema');
    assert.strictEqual(req.body.response_format.json_schema.name, 'game_spec');
    assert.strictEqual(req.body.response_format.json_schema.strict, true);
    const props = req.body.response_format.json_schema.schema.properties;
    assert.ok(props.gameCode.properties.javascript, 'the schema does not require game code');
    assert.ok(props.controls.properties.touch, 'the schema does not require touch controls');
  });

  await check('the reply is normalised and usage is recorded', async () => {
    captured.length = 0;
    const { spec, meta } = await generator.generate('dodge blocks', { allowFallback: false });
    assert.strictEqual(spec.gameConfig.title, 'Block Dodge');
    assert.strictEqual(meta.mode, 'ai');
    assert.strictEqual(meta.provider, 'openrouter');
    assert.strictEqual(meta.structuredOutput, true);
    assert.strictEqual(meta.usage.total_tokens, 5500);
    assert.strictEqual(spec.apkReady, false, 'apkReady must start false');
  });

  await check('an image on a text-only model is reported, not dropped', async () => {
    captured.length = 0;
    const { meta } = await generator.generate('a game in this art style', {
      allowFallback: false,
      attachments: [{ kind: 'image', mime: 'image/png', base64: 'AAAA', name: 'mood.png' }]
    });
    assert.ok(
      meta.issues.some((i) => /cannot read images/i.test(i) && /mood\.png/.test(i)),
      `the ignored image was not surfaced: ${JSON.stringify(meta.issues)}`
    );
    // A text-only model must never be sent image parts.
    assert.strictEqual(typeof captured[0].body.messages[1].content, 'string');
    assert.ok(captured[0].body.messages[1].content.includes('mood.png'));
  });

  await check('text attachments are folded into the prompt', async () => {
    captured.length = 0;
    await generator.generate('build from these notes', {
      allowFallback: false,
      attachments: [{ kind: 'text', name: 'plan.md', text: '- boss at wave 4' }]
    });
    const content = captured[0].body.messages[1].content;
    assert.ok(content.includes('plan.md'));
    assert.ok(content.includes('boss at wave 4'));
  });

  await check('a vision-capable model gets native image parts', async () => {
    const { message, ignoredImages } = llm.buildUserMessage('style reference', [
      { kind: 'image', mime: 'image/png', base64: 'QUJD', name: 'a.png' }
    ], { images: true });
    assert.ok(Array.isArray(message.content));
    assert.strictEqual(message.content[0].type, 'image_url');
    assert.strictEqual(message.content[0].image_url.url, 'data:image/png;base64,QUJD');
    assert.strictEqual(message.content[1].type, 'text');
    assert.strictEqual(ignoredImages.length, 0);
  });

  /* --- the crew ---------------------------------------------------------- */

  await check('the crew runs designer, coder and reviewer against the provider', async () => {
    config.build.crew = true;
    captured.length = 0;
    const { meta } = await generator.generate('a game where you dodge falling blocks', { allowFallback: false });

    assert.strictEqual(meta.crew, true, 'the crew path did not run');
    assert.ok(captured.length >= 3, `expected at least 3 model calls, got ${captured.length}`);

    const systems = captured.map((c) => c.body.messages[0].content);
    assert.ok(/game designer/i.test(systems[0]), 'the designer did not go first');
    assert.ok(/meamus/.test(systems[1]), 'the coder did not follow the designer');
    assert.ok(
      systems.some((sys) => /You review Phaser 3 game code/.test(sys)),
      'the reviewer never ran'
    );

    // The coder must be told to build the designer's brief, not to start over.
    const coderPrompt = captured[1].body.messages[1].content;
    assert.ok(/do not\s*\n?substitute your own game/i.test(coderPrompt.replace(/\s+/g, ' ')),
      'the coder was not held to the brief');
  });

  await check('progress carries the numbers, not just a sentence', async () => {
    config.build.crew = true;
    captured.length = 0;
    const steps = [];
    await generator.generate('dodge falling blocks', {
      allowFallback: false, onStep: (s) => steps.push(s)
    });

    // Which agent is working. "Building your game" for two minutes is what a
    // hang looks like; a named agent is what work looks like.
    const agents = new Set(steps.map((s) => s.agent).filter(Boolean));
    for (const who of ['Designer', 'Coder', 'Tester']) {
      assert.ok(agents.has(who), `${who} never reported in`);
    }

    // How much code, and into which file.
    const wrote = steps.find((s) => s.lines);
    assert.ok(wrote, 'no step reported how many lines were written');
    assert.strictEqual(wrote.file, 'game.js', 'the file written was not named');
    assert.ok(wrote.lines > 10, `${wrote.lines} lines is not a game`);
    assert.ok(wrote.bytes > 0, 'the size was not reported');

    // Which model answered, so a slow build can be told apart from a refused one.
    const named = steps.filter((s) => s.model);
    assert.ok(named.length >= 2, 'the model doing the work was never named');
    assert.ok(named.every((s) => typeof s.model === 'string' && s.model.includes('/')),
      'a model was reported without its provider');

    // Every step is timed, so the panel can say how long each agent took.
    assert.ok(steps.every((s) => typeof s.at === 'number'), 'a step arrived without a timestamp');
  });

  await check('a build records which model wrote it, all the way to the row', async () => {
    config.build.crew = true;
    captured.length = 0;
    const { meta } = await generator.generate('dodge blocks', { allowFallback: false });
    assert.ok(meta.model, 'the finished game does not say which model wrote it');
    assert.ok(meta.transcript && meta.transcript.some((t) => t.lines),
      'the saved transcript lost the line count, so a reload shows less than the build did');
  });

  await check('the chat summary states facts, not compliments', async () => {
    const agents = require('../server/services/agents');
    const text = agents.summarise({
      model: 'z-ai/glm-5.2:free',
      attempts: 2,
      brief: {
        title: 'Block Dodge',
        pitch: 'Dodge falling blocks, grab coins.',
        coreLoop: 'Move, dodge, collect.',
        mechanics: [{ name: 'Dodge' }, { name: 'Combo' }]
      },
      review: {
        summary: 'A polished and engaging arcade experience that players will love.',
        findings: [{ severity: 'major', what: 'the jump never fired' }]
      },
      transcript: [{ scenes: 2 }],
      issues: []
    });

    // The reviewer marking its own homework is where the slop came from.
    assert.ok(!text.includes('polished'), `the model's self-praise reached the chat:\n${text}`);
    assert.ok(!/nothing blocking|looks sound|solid/i.test(text),
      `an evaluative claim survived:\n${text}`);

    // What is left has to be checkable against the file that shipped.
    assert.ok(text.includes('Block Dodge'), 'the game is not named');
    assert.ok(/2 scenes booted/.test(text), 'the test result is missing');
    assert.ok(/2 attempts/.test(text), 'the attempt count is missing');
    assert.ok(text.includes('the jump never fired'),
      'a fix that was actually made is a fact and should be reported');
  });

  await check('crew usage is summed across every agent, not just the coder', async () => {
    captured.length = 0;
    const { meta } = await generator.generate('dodge blocks', { allowFallback: false });
    // Each mocked call reports 5500 tokens, so anything that only counted one
    // agent would under-bill the founder by the cost of the other two.
    assert.strictEqual(meta.usage.total_tokens, 5500 * captured.length,
      `usage ${meta.usage.total_tokens} does not cover ${captured.length} calls`);
  });

  await check('the crew coder receives the founder attachments', async () => {
    captured.length = 0;
    const { meta } = await generator.generate('build from these notes', {
      allowFallback: false,
      attachments: [
        { kind: 'text', name: 'plan.md', text: '- boss at wave 4' },
        { kind: 'image', mime: 'image/png', base64: 'AAAA', name: 'mood.png' }
      ]
    });
    const coderPrompt = captured[1].body.messages[1].content;
    assert.ok(coderPrompt.includes('plan.md'), 'the attached file never reached the coder');
    assert.ok(coderPrompt.includes('boss at wave 4'), 'the attached file body was dropped');
    assert.ok(
      meta.issues.some((i) => /cannot read images/i.test(i) && /mood\.png/.test(i)),
      `an unreadable image was not surfaced: ${JSON.stringify(meta.issues)}`
    );
    // The designer works from the sentence alone - it must not be billed for
    // the attachments the coder needs.
    assert.ok(!captured[0].body.messages[1].content.includes('boss at wave 4'),
      'the designer was sent the attachments too');
    config.build.crew = crewDefault;
  });

  await check('reasoning is switched off, so it cannot eat the answer', async () => {
    captured.length = 0;
    await generator.generate('dodge blocks', { allowFallback: false });
    for (const call of captured) {
      assert.deepStrictEqual(call.body.reasoning, { enabled: false },
        'a reasoning model would spend max_tokens thinking before writing a word');
    }
  });

  await check('a truncated reply says so instead of failing as bad JSON', async () => {
    // Three production builds died on this: a reply cut off at the token
    // ceiling surfaced as "unterminated JSON object" and "does not parse:
    // Unexpected end of input", which both point at the model rather than at
    // max_tokens.
    truncateNext = true;
    let message = '';
    try {
      await generator.generate('dodge blocks', { allowFallback: false });
      assert.fail('a truncated reply was accepted');
    } catch (err) {
      message = err.message;
    } finally {
      truncateNext = false;
    }
    assert.ok(/ran out of room|cut off/i.test(message), `unhelpful truncation error: ${message}`);
    assert.ok(/LLM_MAX_TOKENS/.test(message), 'the error does not name the setting to change');
  });

  await check('every way a build can fail is retried, not just a boot failure', async () => {
    // Production died at 56 seconds on "does not parse: Invalid or unexpected
    // token" having tried exactly once, because only a BOOT failure was
    // retried. A bad token, malformed JSON or a truncated answer all threw
    // straight out of the build. Each of those now feeds back and tries again.
    const good = require('../server/services/templates').get('space-shooter').spec;
    const withCode = (js) => {
      const copy = JSON.parse(JSON.stringify(good));
      copy.gameCode.javascript = js;
      return JSON.stringify(copy);
    };
    const syntaxError = (() => {
      // Structurally broken, not just typographically: smart quotes are
      // repaired mechanically now, so they no longer exercise the retry path.
      const lines = good.gameCode.javascript.split('\n');
      lines[142] = 'function ready( { return 1;';
      return lines.join('\n');
    })();

    replies = [
      { content: '{"gameConfig":{"title":"Half', finish: 'length' },  // cut off
      { content: 'Sure! Here is your game.' },                          // no JSON
      { content: withCode(syntaxError) },                               // will not parse
      { content: withCode('const boom = NOT_DEFINED;\n' + good.gameCode.javascript) }, // throws on boot
      { content: withCode(good.gameCode.javascript) }                   // finally good
    ];

    const { spec, meta } = await generator.generate('a space shooter', { allowFallback: false });
    assert.ok(spec.gameCode.javascript.length > 1000, 'no game came back');
    assert.strictEqual(meta.attempts, 5, `expected 5 coder attempts, got ${meta.attempts}`);
    replies = null;
  });

  await check('a parse failure names the line so the fix is possible', async () => {
    const { normaliseSpec, SpecError } = require('../server/services/validator');
    const good = require('../server/services/templates').get('space-shooter').spec;
    const copy = JSON.parse(JSON.stringify(good));
    const lines = copy.gameCode.javascript.split('\n');
    lines[142] = 'function ready( { return 1;';
    copy.gameCode.javascript = lines.join('\n');

    try {
      normaliseSpec(copy, { source: 'ai' });
      assert.fail('a syntax error was accepted');
    } catch (err) {
      assert.ok(err instanceof SpecError, `wrong error type: ${err.name}`);
      assert.strictEqual(err.detail && err.detail.line, 143, `wrong line: ${JSON.stringify(err.detail)}`);
      assert.ok(/game\.js line 143/.test(err.message), `line missing from message: ${err.message}`);
    }
  });

  await check('a whole game written on one line is not a stub', async () => {
    // Seven attempts in a row died on this in production: "The model returned
    // 1 lines of code, which is a stub rather than a playable game" - thrown at
    // a 22,000-character game that had already passed the parser. A model
    // answering under a JSON schema often emits no newlines at all, and the
    // stub gate counted lines.
    const { normaliseSpec } = require('../server/services/validator');
    const smoke = require('../server/services/smoke');
    const good = require('../server/services/templates').get('space-shooter').spec;

    const oneLine = good.gameCode.javascript
      .split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).join(' ');
    assert.strictEqual(oneLine.split('\n').length, 1, 'the fixture is not actually one line');
    assert.ok(oneLine.length > 10000, 'the fixture is not a whole game');

    const input = JSON.parse(JSON.stringify(good));
    input.gameCode.javascript = oneLine;
    const { spec } = normaliseSpec(input, { source: 'ai' });

    // Accepted, and given its newlines back so the Code tab is readable.
    assert.ok(spec.gameCode.javascript.split('\n').length > 100,
      'a one-line game was accepted but left unreadable');
    // And it still runs after the reformatting.
    const booted = smoke.boot(spec.gameCode.javascript);
    assert.ok(booted.scenes.length >= 3, `only ${booted.scenes.length} scenes booted`);

    // A genuine stub is still refused.
    const stub = JSON.parse(JSON.stringify(good));
    stub.gameCode.javascript = 'new Phaser.Game({});';
    assert.throws(() => normaliseSpec(stub, { source: 'ai' }), /stub/i, 'a real stub was accepted');
  });

  await check('smart quotes in the code are repaired, not rejected', async () => {
    // Every attempt of three consecutive production builds died on this:
    //   "does not parse: Invalid or unexpected token
    //    at game.js line 1: const CONFIG = { PLAYER_SPEED: 300,"
    // A model writing prose and code in one breath slips into typographic
    // punctuation. It is a mechanical fault with a mechanical fix.
    const { normaliseSpec } = require('../server/services/validator');
    const smoke = require('../server/services/smoke');
    const vm = require('node:vm');
    const good = require('../server/services/templates').get('space-shooter').spec;

    const oneLine = good.gameCode.javascript.split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).join(' ');
    const target = oneLine.match(/'([A-Za-z][A-Za-z0-9 _-]{2,20})'/);
    assert.ok(target, 'no quoted string to corrupt');
    const broken = oneLine.replace(target[0], `\u201C${target[1]}\u201D`);

    assert.throws(() => new vm.Script(broken, { filename: 'x' }), SyntaxError,
      'the fixture is not actually broken');

    const input = JSON.parse(JSON.stringify(good));
    input.gameCode.javascript = broken;
    const { spec, issues } = normaliseSpec(input, { source: 'ai' });

    assert.ok(issues.some((i) => /smart quotes/i.test(i)), 'the repair was not reported');
    assert.ok(smoke.boot(spec.gameCode.javascript).scenes.length >= 3, 'the repaired game does not boot');

    // Something genuinely broken is still refused, and the error now names the
    // characters instead of just saying the code is bad.
    const hopeless = JSON.parse(JSON.stringify(good));
    hopeless.gameCode.javascript = good.gameCode.javascript + '\nfunction oops( {';
    assert.throws(() => normaliseSpec(hopeless, { source: 'ai' }), /does not parse/);
  });

  await check('a syntax error in a one-line game is located, not guessed at', async () => {
    // V8 gives up on locating an error in a very long line: on a 22,000
    // character one-liner it prints a caret row of a thousand spaces and no
    // caret. Three production builds reported "at game.js line 1: const CONFIG
    // = { PLAYER_SPEED: 300," on every attempt - the first forty characters of
    // the file, not the error. The code is split into lines before parsing so
    // there is a real line and column to report.
    const { normaliseSpec } = require('../server/services/validator');
    const good = require('../server/services/templates').get('space-shooter').spec;

    const oneLine = good.gameCode.javascript.split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).join(' ');
    const broken = `${oneLine.slice(0, 9000)} const oops = 5 @ 3; ${oneLine.slice(9000)}`;

    const input = JSON.parse(JSON.stringify(good));
    input.gameCode.javascript = broken;

    try {
      normaliseSpec(input, { source: 'ai' });
      assert.fail('broken code was accepted');
    } catch (err) {
      assert.ok(err.detail && err.detail.line > 1,
        `no usable line number: ${JSON.stringify(err.detail)}`);
      assert.ok(err.detail.column > 0, 'no column');
      assert.ok(/const oops = 5 @ 3/.test(err.message),
        `the error does not quote the offending code: ${err.message}`);
      // And it does not blame innocent characters elsewhere in the file.
      assert.ok(!/\u2665/.test(err.message), 'blamed a heart in a score label');
    }
  });

  await check('reformatting never breaks a string, a comment or a regex', async () => {
    // Six consecutive production attempts died on
    //   "Invalid or unexpected token at this.load.image('loadingBar', 'data"
    // and the error was ours: the reformatter split after every semicolon,
    // including the one inside 'data:image/png;base64,...', turning valid code
    // into an unterminated string and then blaming the model for it.
    const { normaliseSpec } = require('../server/services/validator');
    const smoke = require('../server/services/smoke');
    const templates = require('../server/services/templates');
    const vm = require('node:vm');

    // The exact shape that broke: a semicolon inside a string literal.
    const dataUri = "class S extends Phaser.Scene { preload(){ "
      + "this.load.image('bar', 'data:image/png;base64,iVBORw0KGgo='); } } "
      + "const re = /a;b/g; const t = `x;y${1}`; // a; comment\n"
      + "new Phaser.Game({ scene: [S] });";
    const good = templates.get('space-shooter').spec;
    // Padded with real statements: trailing whitespace is trimmed away and the
    // size gate would then call this a stub.
    const filler = Array.from({ length: 90 }, (_, i) => `const pad${i} = ${i} * 2;`).join(' ');
    const padded = `${dataUri}\n${filler}`;
    new vm.Script(padded, { filename: 'f' });   // the fixture must be valid

    const input = JSON.parse(JSON.stringify(good));
    input.gameCode.javascript = padded;
    const { spec } = normaliseSpec(input, { source: 'ai' });
    assert.ok(/data:image\/png;base64,iVBORw0KGgo=/.test(spec.gameCode.javascript),
      'the data URI was split apart');
    assert.ok(/\/a;b\/g/.test(spec.gameCode.javascript), 'the regex was split apart');

    /* The sharper case, and the one production actually hit. A valid file is
       protected by the fall-back either way, so the damage a naive split does
       is not to the code but to the DIAGNOSIS: when the file is broken
       somewhere else, the error gets reported at the string the splitter tore
       in half. Six attempts were spent being told the problem was a data URI
       that was written perfectly. */
    const brokenElsewhere = JSON.parse(JSON.stringify(good));
    brokenElsewhere.gameCode.javascript = `${dataUri}\n${filler}\nfunction oops( { return 1;`;
    try {
      normaliseSpec(brokenElsewhere, { source: 'ai' });
      assert.fail('broken code was accepted');
    } catch (err) {
      // The fault is the last thing in the file; the data URI is the third
      // line. Which one the error names is the whole point.
      assert.ok(!/data:image/.test(err.message),
        `the error blames a data URI the model wrote correctly: ${err.message}`);
      assert.ok(err.detail && err.detail.line > 50,
        `the error points at line ${err.detail && err.detail.line}, not at the real fault near the end`);
    }

    // And a whole real game survives the round trip and still boots.
    const src = good.gameCode.javascript;
    let flat = '';
    let quote = null;
    let comment = null;
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      const n = src[i + 1];
      if (comment === 'line') { if (c === '\n') { comment = null; flat += ' '; } continue; }
      if (comment === 'block') { if (c === '*' && n === '/') { comment = null; i += 1; } continue; }
      if (quote) { flat += c; if (c === '\\') { flat += n; i += 1; continue; } if (c === quote) quote = null; continue; }
      if (c === '/' && n === '/') { comment = 'line'; i += 1; continue; }
      if (c === '/' && n === '*') { comment = 'block'; i += 1; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; flat += c; continue; }
      flat += c === '\n' ? ' ' : c;
    }
    const oneLine = flat.replace(/\s+/g, ' ').trim();
    new vm.Script(oneLine, { filename: 'f' });   // still a valid game

    const whole = JSON.parse(JSON.stringify(good));
    whole.gameCode.javascript = oneLine;
    const { spec: rebuilt } = normaliseSpec(whole, { source: 'ai' });
    assert.ok(rebuilt.gameCode.javascript.split('\n').length > 300, 'it was not reformatted');
    assert.ok(smoke.boot(rebuilt.gameCode.javascript).scenes.length >= 5,
      'a real game did not survive the round trip');
  });

  await check('HTML tags leaked into the code are stripped, not rejected', async () => {
    // Production: "Unexpected token '<' at line 5, column 1:
    //              <br>class BootScene extends P"
    // The model writes for a web page by reflex. A line break is what it meant.
    const { normaliseSpec } = require('../server/services/validator');
    const smoke = require('../server/services/smoke');
    const vm = require('node:vm');
    const good = require('../server/services/templates').get('space-shooter').spec;

    const broken = good.gameCode.javascript.split('\n').join('<br>');
    assert.throws(() => new vm.Script(broken, { filename: 'x' }), SyntaxError,
      'the fixture is not actually broken');

    const input = JSON.parse(JSON.stringify(good));
    input.gameCode.javascript = broken;
    const { spec, issues } = normaliseSpec(input, { source: 'ai' });

    assert.ok(issues.some((i) => /HTML tags/i.test(i)), 'the repair was not reported');
    assert.ok(smoke.boot(spec.gameCode.javascript).scenes.length >= 5,
      'the repaired game does not boot');
  });

  await check('a loader call gets told to draw the sprite instead', async () => {
    // The model keeps reaching for this.load.spritesheet with a data: URI -
    // forbidden, enormous, and what its answer runs out of room writing. The
    // generic "check your punctuation" correction did nothing about it.
    const agentsSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'services', 'agents.js'), 'utf8'
    );
    const body = agentsSrc.slice(
      agentsSrc.indexOf('const SHRINK_STEPS'),
      agentsSrc.indexOf('/**\n * Write the game')
    );
    // eslint-disable-next-line no-new-func
    const correctionFor = new Function(`return (()=>{${body}; return correctionFor;})()`)();

    const loader = correctionFor({
      message: 'The generated code does not parse: Invalid or unexpected token',
      detail: { line: 82, column: 40, source: "this.load.spritesheet('asteroid', 'data:image/png;base64," }
    }, 0);
    assert.ok(/generateTexture/.test(loader), 'the correction does not show how to draw it');
    assert.ok(/this\.load/.test(loader), 'the correction does not name the loader');

    // A plain syntax error elsewhere still gets the punctuation advice.
    const plain = correctionFor({
      message: 'The generated code does not parse: Invalid or unexpected token',
      detail: { line: 12, column: 4, source: 'const x = 5 @ 3;' }
    }, 0);
    assert.ok(!/generateTexture/.test(plain), 'unrelated errors got the loader advice');
  });

  await check('a build that cannot be generated still ships something playable', async () => {
    // The founder gets a game, and is told plainly that it is not the one they
    // asked for. A red error box is not a product.
    replies = 'always-garbage';
    const { spec, meta } = await generator.generate('a ludo board for four players');
    replies = null;

    assert.ok(spec.gameCode.javascript.split('\n').length > 100, 'the rescue is not a real game');
    assert.strictEqual(meta.rescued, true, 'the rescue was not flagged');
    assert.ok(meta.rescuedFrom, 'the reason was not recorded');
    assert.ok((meta.issues || []).some((i) => /could not produce a game that runs/i.test(i)),
      'the founder is not told what happened');
    // And it does not pretend to be the game they asked for.
    assert.ok(!/ludo/i.test(spec.gameConfig.title), `the rescue lies about itself: ${spec.gameConfig.title}`);
  });

  await check('a rate limit is waited out, not treated as a dead build', async () => {
    // On a free tier a 429 is the common path, not an exception - the cap is
    // per minute and one build is several calls. A production build gave up
    // after a single 429 and shipped a fallback, because any transport error
    // ended the build. Now it waits and asks again.
    const previous = { retries: config.llm.retries, base: config.llm.retryBaseMs, max: config.llm.retryMaxMs };
    config.llm.retryBaseMs = 50;
    config.llm.retryMaxMs = 120;
    rateLimitFirst = 3;

    try {
      const { spec, meta } = await generator.generate('a space shooter', { allowFallback: false });
      assert.ok(spec.gameCode.javascript.length > 1000, 'no game came back');
      assert.ok(!meta.rescued, 'a rate limit should not force the fallback');
      assert.strictEqual(rateLimitFirst, 0, 'the rate limits were not all consumed');
    } finally {
      rateLimitFirst = 0;
      config.llm.retries = previous.retries;
      config.llm.retryBaseMs = previous.base;
      config.llm.retryMaxMs = previous.max;
    }
  });

  await check('a daily cap is not waited out like a per-minute one', async () => {
    // Both arrive as 429 and the advice for them is opposite. Production hit
    // the daily cap and was told to wait sixty seconds for something that
    // resets at midnight - and then burned four backoff retries on it.
    const llmSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'services', 'llm.js'), 'utf8'
    );
    const body = llmSrc.slice(llmSrc.indexOf('function isDailyCap'), llmSrc.indexOf('async function readError'));
    // eslint-disable-next-line no-new-func
    const built = new Function('config', `${body}; return { isDailyCap, rateLimitMessage };`)(
      { llm: { model: 'nvidia/nemotron-3-super-120b-a12b:free' } }
    );

    const daily = 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day';
    assert.ok(built.isDailyCap(daily), 'a daily cap was not recognised');
    assert.ok(!built.isDailyCap('Rate limit exceeded: 20 requests per minute'), 'a per-minute cap was misread as daily');

    const message = built.rateLimitMessage(daily);
    assert.ok(/daily cap/i.test(message), 'the message does not say it is a daily cap');
    assert.ok(!/wait a minute/i.test(message), 'the message still tells them to wait a minute');
    assert.ok(/openrouter\.com\/credits|openrouter\.ai\/credits/.test(message), 'no way forward is offered');

    // And the per-minute case keeps its own, correct advice.
    assert.ok(/wait a minute/i.test(built.rateLimitMessage('Rate limit exceeded: 20 requests per minute')),
      'the per-minute message lost its advice');
  });

  await check('a rejected key is not waited out', async () => {
    // The opposite case: an error that will still be true in ten seconds must
    // end the build immediately rather than burning the founder's time.
    const key = process.env.OPENROUTER_API_KEY;
    const started = Date.now();
    let message = '';
    try {
      config.llm.apiKey = '';
      config.llm.enabled = false;
      await generator.generate('a space shooter', { allowFallback: false });
      assert.fail('a missing key was accepted');
    } catch (err) {
      message = err.message;
    } finally {
      config.llm.apiKey = key;
      config.llm.enabled = true;
    }
    assert.ok(/API key/i.test(message), `unhelpful error: ${message}`);
    assert.ok(Date.now() - started < 3000, 'a hopeless call was retried anyway');
  });

  /* --- routing ----------------------------------------------------------- */

  const modelRouter = require('../server/services/models');
  const ask = (opts = {}) => llm.complete({
    messages: [{ role: 'user', content: 'make a game' }], jsonSchema: true, ...opts
  });

  await check('a model that will not answer hands the job to the next one', async () => {
    modelRouter.reset();
    refuse.clear();
    refuse.set('nvidia/nemotron-3-super-120b-a12b:free', { status: 429, message: 'rate limit exceeded' });

    const result = await ask();
    assert.strictEqual(result.model, 'dots-studio/dots-3-note-preview:free',
      'the second model on the roster should have answered');
    assert.strictEqual(result.attempts.length, 2, 'both attempts should be recorded');
    assert.strictEqual(result.attempts[0].ok, false);
    assert.strictEqual(result.attempts[0].reason, 'rate');
    assert.strictEqual(result.attempts[1].ok, true);
    refuse.clear();
  });

  await check('a rate-limited model is skipped, not re-asked, on the next call', async () => {
    modelRouter.reset();
    refuse.clear();
    refuse.set('nvidia/nemotron-3-super-120b-a12b:free', { status: 429, message: 'rate limit exceeded' });
    await ask();
    refuse.clear();

    // Second call: nemotron would now answer, but it is benched, so the router
    // must not spend a request finding that out.
    const before = captured.length;
    const result = await ask();
    assert.strictEqual(result.model, 'dots-studio/dots-3-note-preview:free');
    assert.strictEqual(captured.length - before, 1, 'a benched model was asked again anyway');
    const benched = modelRouter.benchedNow().map((b) => b.id);
    assert.ok(benched.includes('nvidia/nemotron-3-super-120b-a12b:free'));
  });

  await check('a daily cap benches a model for the day, a rate limit for minutes', async () => {
    modelRouter.reset();
    refuse.clear();
    refuse.set('nvidia/nemotron-3-super-120b-a12b:free',
      { status: 429, message: 'Rate limit exceeded: free-models-per-day' });
    refuse.set('dots-studio/dots-3-note-preview:free',
      { status: 429, message: 'rate limit exceeded' });

    await ask();
    const held = Object.fromEntries(modelRouter.benchedNow().map((b) => [b.id, b.forMs]));
    assert.ok(held['nvidia/nemotron-3-super-120b-a12b:free'] > 20 * 60 * 60 * 1000,
      'a daily cap should be remembered for the rest of the day, not a few minutes');
    assert.ok(held['dots-studio/dots-3-note-preview:free'] < 10 * 60 * 1000,
      'a per-minute limit should clear on its own, not be held for a day');
    refuse.clear();
  });

  await check('a rejected key stops at the first model instead of burning the roster', async () => {
    modelRouter.reset();
    refuse.clear();
    for (const m of modelRouter.CODER) refuse.set(m.id, { status: 401, message: 'invalid api key' });

    const before = captured.length;
    let message = '';
    try { await ask(); } catch (err) { message = err.message; }
    assert.strictEqual(captured.length - before, 1,
      'a wrong key is wrong on every model; asking six of them wastes the founder’s time');
    assert.ok(/api key/i.test(message), `unhelpful error: ${message}`);
    assert.strictEqual(modelRouter.benchedNow().length, 0, 'a key problem is not the model’s fault');
    refuse.clear();
  });

  await check('a cut-off answer is shortened, not handed to another model', async () => {
    modelRouter.reset();
    refuse.clear();
    truncateNext = true;
    const before = captured.length;
    let status = null;
    try { await ask(); } catch (err) { status = err.status; }
    truncateNext = false;
    assert.strictEqual(status, 422, 'truncation is about the answer, not the provider');
    assert.strictEqual(captured.length - before, 1,
      'the same over-long request put to a second model gets the same over-long answer');
  });

  await check('every model refusing says so plainly, with what each one said', async () => {
    modelRouter.reset();
    refuse.clear();
    for (const m of modelRouter.CODER) refuse.set(m.id, { status: 503, message: 'no instances available' });

    let err = null;
    try { await ask(); } catch (e) { err = e; }
    assert.ok(err, 'it should have failed');
    assert.ok(/All \d+ models were unavailable/.test(err.message),
      `an exhausted roster should say so: ${err.message}`);
    const tried = [...new Set(err.attempts.map((a) => a.model))];
    assert.strictEqual(tried.length, modelRouter.CODER.length,
      'every model tried should be listed');
    for (const m of modelRouter.CODER) {
      assert.ok(err.message.includes(m.id), `${m.id} is missing from the report`);
    }
    refuse.clear();
  });

  await check('a pinned OPENROUTER_MODEL is asked first, with the roster behind it', async () => {
    modelRouter.reset();
    refuse.clear();
    const original = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL = 'dots-studio/dots-3-note-preview:free';

    const first = await ask();
    assert.strictEqual(first.model, 'dots-studio/dots-3-note-preview:free',
      'an explicit setting is an instruction, not a suggestion');

    // ...and being pinned does not mean being the only option.
    refuse.set('dots-studio/dots-3-note-preview:free', { status: 502, message: 'upstream error' });
    modelRouter.reset();
    const second = await ask();
    assert.notStrictEqual(second.model, 'dots-studio/dots-3-note-preview:free',
      '"the model you chose is down" is not a reason to have no product');

    refuse.clear();
    if (original) process.env.OPENROUTER_MODEL = original; else delete process.env.OPENROUTER_MODEL;
  });

  await check('the brief roster is used for briefs, and the coder roster for code', async () => {
    modelRouter.reset();
    refuse.clear();
    // Bench everything the two rosters share, so what is left tells them apart:
    // a brief must fall to a brief-only model, not to a coder-only one.
    const shared = modelRouter.BRIEF.filter((b) => modelRouter.CODER.some((c) => c.id === b.id));
    assert.ok(shared.length, 'the rosters no longer overlap; this test needs rewriting');
    for (const m of shared) modelRouter.bench(m.id, 'rate');

    const before = captured.length;
    await ask({ role: 'brief', maxTokens: 8000 });
    const used = captured[before].body.model;
    assert.ok(modelRouter.BRIEF.some((m) => m.id === used),
      `a brief went to ${used}, which is not on the brief roster`);
    assert.ok(!modelRouter.CODER.some((m) => m.id === used),
      `a brief went to ${used}, which is a coder model - the roles are not actually separate`);
    modelRouter.reset();
  });

  await check('a model is never asked for more room than it has', async () => {
    modelRouter.reset();
    refuse.clear();
    const original = process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL = 'liquid/lfm-2.5-2.6b:free';   // 8192 ceiling

    const before = captured.length;
    await ask({ maxTokens: 32000 });
    const sent = captured[before].body.max_tokens;
    assert.strictEqual(sent, 8192,
      'asking a small model for 32k is a 400 from some providers and a silent cut-off from others');

    if (original) process.env.OPENROUTER_MODEL = original; else delete process.env.OPENROUTER_MODEL;
    modelRouter.reset();
  });

  await check('the build is told which model is being asked, before it answers', async () => {
    modelRouter.reset();
    refuse.clear();
    refuse.set('nvidia/nemotron-3-super-120b-a12b:free', { status: 502, message: 'upstream error' });

    const seen = [];
    await ask({ onModel: (info) => seen.push(info) });
    assert.strictEqual(seen.length, 2, 'both models tried should have been announced');
    assert.strictEqual(seen[0].model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.strictEqual(seen[0].index, 1);
    assert.ok(seen[0].of >= 2, 'the founder should be able to see how many are left to try');
    refuse.clear();
    modelRouter.reset();
  });

  await check('an unknown model falls back to safe assumptions', async () => {
    llm.resetCapabilities();
    const original = process.env.OPENROUTER_MODEL;
    // Restart the module graph so the new model name is picked up.
    for (const key of Object.keys(require.cache)) {
      if (key.includes('/server/')) delete require.cache[key];
    }
    process.env.OPENROUTER_MODEL = 'someone/unlisted-model';
    const freshLlm = require('../server/services/llm');
    const caps = await freshLlm.capabilities();
    assert.strictEqual(caps.images, false, 'an unknown model must not be assumed to read images');
    assert.strictEqual(caps.structuredOutputs, false, 'an unknown model must not be assumed to honour a schema');
    assert.ok(caps.detectionError, 'the failed lookup should be recorded');
    if (original) process.env.OPENROUTER_MODEL = original; else delete process.env.OPENROUTER_MODEL;
  });

  server.close();
  fs.rmSync(tmpData, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nprovider test crashed:', err);
  process.exit(2);
});
