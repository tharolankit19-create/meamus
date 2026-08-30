'use strict';

/**
 * Design research via the FreeToGame API.
 *
 * What this actually provides, so nobody over-reads it: FreeToGame returns
 * metadata and prose — title, genre, developer, and a description that
 * usually names a game's modes and core loop. It does not return code,
 * physics constants, or asset files, and no amount of prompting will make it.
 *
 * What that is good for: grounding the design brief. Telling the model "here
 * is what six real shooters in this space actually do" produces a more
 * specific game than asking it to invent a genre from memory. It is retrieval
 * for the design, not a substitute for the code the model still has to write.
 *
 * Attribution to FreeToGame is required by their terms and is rendered in the
 * UI wherever this data is used.
 */

const BASE = 'https://www.freetogame.com/api';
const TTL_MS = 6 * 60 * 60 * 1000;          // their catalogue moves slowly
const MAX_REFERENCES = 6;
const TIMEOUT_MS = 12000;

/** Prompt vocabulary -> FreeToGame category slugs. */
const CATEGORY_MAP = [
  ['shooter', ['shooter', 'shoot', 'fps', 'gun', 'blast', 'bullet', 'space shooter', 'shmup']],
  ['battle-royale', ['battle royale', 'br', 'last one standing']],
  ['racing', ['racing', 'race', 'car', 'kart', 'drift', 'driving']],
  ['fighting', ['fighting', 'fighter', 'brawler', 'versus', 'combat']],
  ['strategy', ['strategy', 'rts', 'tower defense', 'tactics', 'base building']],
  ['card', ['card', 'deck', 'tcg', 'ccg']],
  ['mmorpg', ['mmorpg', 'rpg', 'quest', 'loot', 'dungeon', 'adventure']],
  ['sports', ['sports', 'football', 'soccer', 'basketball', 'cricket']],
  ['social', ['social', 'party', 'ludo', 'board game', 'multiplayer party']],
  ['fantasy', ['fantasy', 'magic', 'wizard', 'dragon']],
  ['horror', ['horror', 'scary', 'zombie', 'survival horror']],
  ['pixel', ['pixel', 'retro', '8-bit', '16-bit']],
  ['sandbox', ['sandbox', 'open world', 'build', 'craft']],
  ['survival', ['survival', 'craft', 'hunger']],
  ['moba', ['moba', 'lane', 'hero brawl']],
  ['flight', ['flight', 'plane', 'flying', 'aircraft']]
];

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  cache.delete(key);
  return null;
}

async function getJson(path) {
  const key = path;
  const hit = cached(key);
  if (hit) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`FreeToGame returned ${response.status}`);
    const value = await response.json();
    cache.set(key, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Which FreeToGame categories a prompt is asking about, best match first. */
function categoriesFor(prompt) {
  const text = String(prompt || '').toLowerCase();
  const scored = [];
  for (const [category, words] of CATEGORY_MAP) {
    let score = 0;
    for (const word of words) {
      if (!text.includes(word)) continue;
      // A multi-word phrase is a much stronger signal than a bare token.
      score += word.includes(' ') ? 3 : 1;
    }
    if (score) scored.push({ category, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((entry) => entry.category);
}

/** Trim a FreeToGame description to the part that describes how it plays. */
function condense(text, limit = 320) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastStop = cut.lastIndexOf('. ');
  return `${lastStop > limit * 0.5 ? cut.slice(0, lastStop + 1) : cut}…`;
}

/**
 * Build a reference brief for a prompt.
 *
 * Never throws: research is an enhancement, and a game must still generate
 * when FreeToGame is slow or down.
 *
 * @param {string} prompt
 * @param {{limit?:number}} [opts]
 * @returns {Promise<{used:boolean, categories:string[], references:Array, note:string, error?:string}>}
 */
async function referencesFor(prompt, opts = {}) {
  const limit = Math.min(opts.limit || MAX_REFERENCES, MAX_REFERENCES);
  const categories = categoriesFor(prompt);

  if (!categories.length) {
    return { used: false, categories: [], references: [], note: 'no matching genre in the catalogue' };
  }

  try {
    // Per-category failures are tolerated so one bad genre cannot lose the
    // other, but they are recorded - a silent degrade that never surfaces is
    // how an outage stays invisible for weeks.
    const failures = [];
    const lists = await Promise.all(categories.map((category) =>
      getJson(`/games?category=${encodeURIComponent(category)}`)
        .catch((err) => { failures.push(`${category}: ${err.message}`); return []; })));

    const seen = new Set();
    const picked = [];
    // Interleave categories so a two-genre prompt gets both represented.
    for (let i = 0; picked.length < limit && i < 40; i += 1) {
      for (const list of lists) {
        const game = list[i];
        if (!game || seen.has(game.id)) continue;
        seen.add(game.id);
        picked.push(game);
        if (picked.length >= limit) break;
      }
    }

    if (!picked.length) {
      return failures.length
        ? { used: false, categories, references: [], note: 'lookup failed', error: failures.join('; ') }
        : { used: false, categories, references: [], note: 'the catalogue returned nothing for these genres' };
    }

    return {
      used: true,
      categories,
      references: picked.map((game) => ({
        title: game.title,
        genre: game.genre,
        developer: game.developer,
        released: game.release_date,
        summary: condense(game.short_description),
        url: game.freetogame_profile_url
      })),
      note: 'design context only - FreeToGame supplies metadata and prose, not code or physics',
      ...(failures.length ? { partial: failures.join('; ') } : {})
    };
  } catch (err) {
    return { used: false, categories, references: [], note: 'lookup failed', error: err.message };
  }
}

/** Render the brief as the block that goes into the model prompt. */
function toPromptBlock(research) {
  if (!research || !research.used || !research.references.length) return '';
  const lines = research.references.map(
    (r) => `- ${r.title} (${r.genre}, ${r.developer}): ${r.summary}`
  );
  return [
    '',
    `Reference games in this space (${research.categories.join(', ')}), from the FreeToGame catalogue:`,
    ...lines,
    '',
    'Use these to ground the design: match the genre conventions players expect,',
    'name mechanics the way this genre names them, and pick a core loop that sits',
    'alongside these rather than reinventing the category. Do not copy their names,',
    'characters or art. They are metadata only - every line of code is still yours',
    'to write, and the game must remain a single-file Phaser 3 build.'
  ].join('\n');
}

/** Test seam. */
function clearCache() { cache.clear(); }

module.exports = { referencesFor, toPromptBlock, categoriesFor, condense, clearCache, BASE };
