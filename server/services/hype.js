'use strict';

/**
 * The line the "your game is ready" popup says.
 *
 * A build that finishes while the founder is somewhere else in the product
 * must not yank them into the workspace - that is the single rudest thing a
 * builder can do. It gets a toast instead, and a toast that says "Build
 * complete" is a toast nobody reads. So the line is about the game they asked
 * for: a space shooter and a match-3 do not deserve the same sentence.
 *
 * Picking is deterministic, seeded by the game id, so the same finished build
 * says the same thing every time it is rendered. A line that reshuffles on
 * every poll reads as a bug.
 */

/**
 * Genre buckets, matched against the spec's genre and title together. The
 * first bucket whose pattern matches wins, so the specific ones come first and
 * `arcade` never swallows `space shooter`.
 */
const BUCKETS = [
  {
    match: /space|galax|alien|astro|cosmic|star|orbit|nebula/,
    lines: [
      'Your space shooter is ready — go and ruin some aliens 🤬',
      'Ship armed, aliens unaware. Get in there 🚀',
      'The galaxy is not going to defend itself. Play it 👾'
    ]
  },
  {
    match: /shoot|shmup|blaster|gun|combat|war|battle/,
    lines: [
      'Your shooter is ready — trigger discipline optional 🔫',
      'Loaded and dangerous. Go make a mess 💥',
      'Everything on screen is a target now. Have fun 🎯'
    ]
  },
  {
    match: /zombie|horror|survival|undead|dark/,
    lines: [
      'The horde is ready and they are hungry. Survive it 🧟',
      'Your survival game is live. Try to last a minute 🩸',
      'Nothing out there is friendly. Go anyway 🔦'
    ]
  },
  {
    match: /rac|driv|car|speed|drift|kart/,
    lines: [
      'Your racer is ready — the brake is a suggestion 🏎️',
      'Engine warm, track empty. Send it 🏁',
      'Go set a lap time nobody can beat 🔥'
    ]
  },
  {
    match: /platform|jump|runner|endless|parkour|climb/,
    lines: [
      'Your platformer is ready. Mind the gap 🕹️',
      'Built, tested, and full of things to fall off 🏃',
      'One more jump. Just one more. Go 🎮'
    ]
  },
  {
    match: /puzzle|match|tile|block|sudoku|word|brain/,
    lines: [
      'Your puzzler is ready — go break your own brain 🧩',
      'Built and booted. See how far you get 🧠',
      'Warning: this one is a time sink. Enjoy ⏳'
    ]
  },
  {
    match: /tower|defen[cs]e|strat|rts|command|siege/,
    lines: [
      'Your defence is built. Hold the line 🛡️',
      'The waves are coming. Go stop them ⚔️',
      'Towers up, enemies inbound. Good luck 🗼'
    ]
  },
  {
    match: /snake|pong|breakout|retro|classic|arcade|neon/,
    lines: [
      'Your arcade game is ready — go chase a high score 🕹️',
      'Coin inserted. Play it 🎰',
      'Short, fast, and hard to put down. Go 👾'
    ]
  },
  {
    match: /card|board|chess|ludo|dice|casino|poker/,
    lines: [
      'Your board game is ready. Go beat someone 🎲',
      'Set up and waiting for a first move ♟️',
      'Rules written, board drawn. Play it 🃏'
    ]
  },
  {
    match: /sport|foot|soccer|basket|cricket|golf|tennis/,
    lines: [
      'Your sports game is ready — go score something ⚽',
      'Whistle blown. Get on the pitch 🏆',
      'Built and playable. Show us the highlight 🥅'
    ]
  }
];

/** Used when nothing matches — still specific to the title, never generic. */
const FALLBACK = [
  '{title} is ready. Go play it 🎮',
  '{title} is built, booted and waiting for you 🚀',
  '{title} passed its tests. Your move 🔥'
];

/** Small deterministic hash, so one game always gets one line. */
function seed(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * @param {object} spec the finished GameSpec
 * @param {string} [key] anything stable per game — the id is ideal
 * @returns {string} one line, ready to render
 */
function lineFor(spec, key = '') {
  const cfg = (spec && spec.gameConfig) || {};
  const title = cfg.title || 'Your game';
  const haystack = `${cfg.genre || ''} ${title} ${cfg.description || ''}`.toLowerCase();

  const bucket = BUCKETS.find((b) => b.match.test(haystack));
  const lines = bucket ? bucket.lines : FALLBACK;
  const picked = lines[seed(key || title) % lines.length];

  return picked.replace('{title}', title);
}

module.exports = { lineFor, BUCKETS, FALLBACK };
