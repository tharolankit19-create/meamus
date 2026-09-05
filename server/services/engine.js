'use strict';

/**
 * 2D or 3D, decided from what the founder asked for.
 *
 * Deterministic keyword matching rather than a model call. Two reasons: it is
 * the first decision in the build and a round trip to make it costs a tenth of
 * the budget before a line of code exists; and a wrong answer here is
 * expensive in a way a wrong answer later is not - the engine decides the
 * entire shape of the file, so a game that starts down the wrong one has to be
 * written twice.
 *
 * The bias is deliberate and it is toward 2D. A 2D game that runs beats a 3D
 * one that does not, most requests do not mention dimension at all, and asking
 * a free model for a 3D game it did not need is the surest way to spend a whole
 * build getting nothing. So 3D happens when it is asked for - by name, or by
 * naming a game that only exists in 3D.
 */

/** Said outright. */
const EXPLICIT_3D = [
  '3d', 'three d', 'three-d', 'threejs', 'three.js', 'webgl',
  'first person', 'first-person', 'fps game', 'third person', 'third-person',
  'voxel', 'isometric 3d', 'open world', 'open-world'
];

/* Named games that have no 2D reading. Minecraft is voxels, PUBG and Free Fire
   are 3D shooters - somebody asking for "a game like Minecraft" is asking for
   blocks in a world they can walk around, and answering with a 2D platformer
   is answering a different question. */
const GAMES_THAT_ARE_3D = [
  'minecraft', 'pubg', 'free fire', 'freefire', 'fortnite', 'call of duty',
  'cod mobile', 'battle royale', 'battlegrounds', 'gta', 'roblox',
  'among us 3d', 'valorant', 'counter strike', 'counter-strike', 'csgo',
  'flight sim', 'racing sim', 'driving sim'
];

/** Said outright the other way, and it wins over everything above. */
const EXPLICIT_2D = ['2d', 'two d', 'two-d', 'side scroller', 'side-scroller', 'top down 2d', 'pixel art', 'retro 2d'];

/**
 * @param {string} prompt what the founder typed
 * @returns {{engine:'phaser'|'three', dimension:'2d'|'3d', why:string}}
 */
function pickEngine(prompt) {
  const text = ` ${String(prompt || '').toLowerCase()} `;
  const has = (word) => text.includes(` ${word} `) || text.includes(`${word} `) || text.includes(` ${word}`);

  const said2d = EXPLICIT_2D.find(has);
  if (said2d) return { engine: 'phaser', dimension: '2d', why: `asked for ${said2d}` };

  const said3d = EXPLICIT_3D.find(has);
  if (said3d) return { engine: 'three', dimension: '3d', why: `asked for ${said3d}` };

  const named = GAMES_THAT_ARE_3D.find((g) => text.includes(g));
  if (named) return { engine: 'three', dimension: '3d', why: `${named} is a 3D game` };

  return { engine: 'phaser', dimension: '2d', why: 'no dimension asked for, and 2D is the safer default' };
}

/**
 * Which engine a piece of code is actually written against.
 *
 * Read from the code, never from what the spec claims or what the build asked
 * for. A production build asked for 3D, gave the model the three.js
 * instructions, got a Phaser game back, and then stamped `engine: "three"` on
 * it because that was the intent - so the page loaded three.js and served it to
 * code that needed Phaser. A blank screen, produced by a label.
 *
 * The code is the only thing that knows. Everything else is a hope.
 *
 * @param {string} code
 * @returns {'three'|'phaser'|null} null when it is neither, which is its own bug
 */
function detectEngine(code) {
  const text = String(code || '');
  const three = /\bTHREE\s*\./.test(text) || /\bnew\s+THREE\b/.test(text);
  const phaser = /\bPhaser\s*\./.test(text) || /\bnew\s+Phaser\.Game\b/.test(text);

  if (three && !phaser) return 'three';
  if (phaser && !three) return 'phaser';
  /* Both, or neither. Both is a game that will not run under either engine;
     neither is not a game at all. Refusing to guess is what keeps the label
     honest - the caller decides what to do about it. */
  return null;
}

module.exports = { pickEngine, detectEngine, EXPLICIT_2D, EXPLICIT_3D, GAMES_THAT_ARE_3D };
