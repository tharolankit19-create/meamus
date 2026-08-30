#!/usr/bin/env node
'use strict';

/**
 * Verifies the model key end to end: capabilities, a tiny round trip, then a
 * real game generation through the full pipeline. Run this first when a key
 * is added, so a bad key or model name fails here rather than in the UI.
 *
 *   npm run llm:check
 */

const config = require('../server/config');
const llm = require('../server/services/llm');
const generator = require('../server/services/generator');

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

(async function run() {
  console.log('\nmeamus model check\n');
  console.log(`  provider   ${config.llm.provider}`);
  console.log(`  model      ${config.llm.model}`);
  console.log(`  base url   ${config.llm.baseUrl}`);
  console.log(`  max tokens ${config.llm.maxTokens}`);
  console.log('');

  if (!config.llm.enabled) {
    bad(`no API key. Set ${config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'} in .env`);
    process.exit(1);
  }
  ok('API key is present');

  const caps = await llm.capabilities();
  console.log(`\n  capabilities (${caps.source})`);
  console.log(`    reads images       ${caps.images ? 'yes' : 'no'}`);
  console.log(`    structured output  ${caps.structuredOutputs ? 'yes' : 'no'}`);
  if (caps.contextLength) console.log(`    context            ${caps.contextLength.toLocaleString()} tokens`);
  if (caps.maxOutput) console.log(`    max output         ${caps.maxOutput.toLocaleString()} tokens`);
  if (caps.detectionError) console.log(`    (catalogue lookup failed: ${caps.detectionError})`);
  if (!caps.images) {
    console.log('    note: image attachments will inform the prompt as text only.');
  }
  console.log('');

  try {
    const pong = await llm.complete({
      system: 'Reply with exactly one word.',
      messages: [{ role: 'user', content: 'Say READY.' }],
      maxTokens: 16
    });
    ok(`round trip works (replied "${pong.text.trim().slice(0, 24)}")`);
  } catch (err) {
    bad(`round trip failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\n  generating a real game (this takes a while)…\n');
  const started = Date.now();
  try {
    const { spec, meta } = await generator.generate(
      'a small arcade game where you dodge falling blocks and collect coins',
      { allowFallback: false }
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    ok(`generated "${spec.gameConfig.title}" in ${seconds}s`);
    console.log(`        genre      ${spec.gameConfig.genre} · ${spec.gameConfig.difficulty}`);
    console.log(`        code       ${spec.gameCode.javascript.split('\n').length} lines`);
    console.log(`        assets     ${spec.assets.sprites.length} sprites · ${spec.assets.audio.length} sounds`);
    console.log(`        mechanics  ${spec.mechanics.length}`);
    console.log(`        schema     ${meta.structuredOutput ? 'enforced' : 'prompt-only'}`);
    if (meta.usage) {
      console.log(`        tokens     ${JSON.stringify(meta.usage)}`);
    }
    if (meta.issues.length) {
      console.log('\n  notes:');
      meta.issues.forEach((issue) => console.log(`        - ${issue}`));
    }
    console.log('\nall good — the key and model are working.\n');
  } catch (err) {
    bad(`generation failed: ${err.message}`);
    if (err.issues) err.issues.forEach((i) => console.log(`        - ${i}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\nmodel check crashed:', err.message);
  process.exit(2);
});
