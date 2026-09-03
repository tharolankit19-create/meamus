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
        }]
      }));
    }

    const parsed = JSON.parse(body || '{}');
    captured.push({ url: req.url, headers: req.headers, body: parsed });
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
