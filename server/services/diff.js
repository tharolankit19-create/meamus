'use strict';

/**
 * How much of a file actually changed.
 *
 * The chat claims a number of lines added and removed on every rewrite, and a
 * claim like that has to be true or it is decoration. Comparing lengths is not
 * true: a rewrite that swaps twenty lines for twenty others is not "no change",
 * and one that reorders a file is not "everything changed".
 *
 * So this is a real line diff - longest common subsequence, the same shape git
 * uses. Lines in the LCS are unchanged; everything else in the old file was
 * removed and everything else in the new file was added.
 *
 * The cost is O(n*m) in time and memory, which is why there is a ceiling on it.
 * A generated game is 100-800 lines, so the usual case is well under a million
 * cells and finishes in a few milliseconds. Past the ceiling it falls back to
 * counting - a wrong-but-close number is better than a build that stalls
 * computing a progress line nobody asked to wait for.
 */

/** Above this many cells, don't. */
const MAX_CELLS = 4_000_000;

/**
 * @param {string} before
 * @param {string} after
 * @returns {{added:number, removed:number, exact:boolean}}
 */
function lineDiff(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');

  if (!before) return { added: b.length, removed: 0, exact: true };
  if (!after) return { added: 0, removed: a.length, exact: true };

  if (a.length * b.length > MAX_CELLS) {
    /* Too big to diff properly. Say so rather than quietly reporting a number
       that was arrived at differently from every other number on screen. */
    return {
      added: Math.max(0, b.length - a.length),
      removed: Math.max(0, a.length - b.length),
      exact: false
    };
  }

  /* Two rows rather than the whole table: only the previous row is ever read,
     and a full 800x800 table of integers is 5MB for a number we use once. */
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }

  const common = previous[b.length];
  return { added: b.length - common, removed: a.length - common, exact: true };
}

module.exports = { lineDiff, MAX_CELLS };
