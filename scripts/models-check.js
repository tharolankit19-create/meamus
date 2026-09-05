#!/usr/bin/env node
'use strict';

/**
 * Check the roster against OpenRouter's live catalogue.
 *
 * server/services/models.js lists the free models by hand, on purpose: routing
 * has to behave the same on every instance and be testable without a network.
 * The cost of that choice is drift - a model retired, an output ceiling
 * changed, schema support added or dropped, a new free model nobody noticed -
 * and a hand-written list nobody checks is worse than a fetched one.
 *
 * So this is the check. It needs the network and nothing else: no key, no
 * database, no build.
 *
 *   npm run models:check
 *
 * Exit 0 when the roster matches, 1 when it does not, with the difference
 * spelled out rather than a diff to interpret.
 */

const models = require('../server/services/models');

const CATALOGUE = 'https://openrouter.ai/api/v1/models';

/* A classifier is not a writer. Asking it for a Phaser game spends a request to
   be told no, so it is left off the roster deliberately - and named here, so
   the check reports it as an exclusion rather than as a model gone missing. */
const EXCLUDED = new Set(['nvidia/nemotron-3.5-content-safety:free']);

function describe(entry) {
  const params = entry.supported_parameters || [];
  return {
    id: entry.id,
    out: (entry.top_provider && entry.top_provider.max_completion_tokens) || 0,
    schema: params.includes('structured_outputs') && params.includes('response_format')
  };
}

(async () => {
  let live;
  try {
    const response = await fetch(CATALOGUE);
    if (!response.ok) throw new Error(`catalogue returned ${response.status}`);
    ({ data: live } = await response.json());
  } catch (err) {
    console.error(`Could not reach OpenRouter: ${err.message}`);
    process.exit(2);
  }

  const free = new Map(
    live.filter((m) => /:free$/.test(m.id)).map((m) => [m.id, describe(m)])
  );

  const problems = [];
  const listed = new Set();

  for (const [role, roster] of Object.entries({ coder: models.CODER, brief: models.BRIEF })) {
    for (const entry of roster) {
      listed.add(entry.id);

      if (!/:free$/.test(entry.id)) {
        problems.push(`${role}: ${entry.id} is not a free model`);
        continue;
      }

      const actual = free.get(entry.id);
      if (!actual) {
        problems.push(`${role}: ${entry.id} is no longer in the catalogue`);
        continue;
      }
      if (actual.schema !== entry.schema) {
        problems.push(
          `${role}: ${entry.id} schema support is ${actual.schema}, roster says ${entry.schema}`
          + (actual.schema ? ' - it could be held to the spec shape and is not being'
            : ' - it is being asked for a schema it cannot honour')
        );
      }
      if (actual.out !== entry.out) {
        problems.push(`${role}: ${entry.id} output ceiling is ${actual.out}, roster says ${entry.out}`);
      }
    }
  }

  for (const id of free.keys()) {
    if (listed.has(id) || EXCLUDED.has(id)) continue;
    const m = free.get(id);
    problems.push(
      `new free model not on any roster: ${id} (${m.out} output${m.schema ? ', schema' : ''})`
    );
  }

  console.log(`catalogue: ${free.size} free models`);
  console.log(`roster   : ${listed.size} listed, ${EXCLUDED.size} deliberately excluded`);

  if (!problems.length) {
    console.log('\nThe roster matches the catalogue.\n');
    process.exit(0);
  }

  console.log(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:\n`);
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log('\nUpdate server/services/models.js to match.\n');
  process.exit(1);
})();
