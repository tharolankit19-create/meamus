'use strict';

/**
 * What configuration this process can actually see, and what looks like a
 * mistake.
 *
 * "I set the variable and nothing happened" has a small number of causes, and
 * almost all of them are invisible from the outside: the name is misspelled,
 * it went to a different environment, or it went in after the last deploy. A
 * plain "SUPABASE_URL is not set" cannot tell those apart.
 *
 * So this reports names - never values - and, crucially, flags names that look
 * like a near miss for one the app reads. SUPERBASE_URL and SUPBASE_URL are
 * both perfectly plausible typos that no substring search would ever catch.
 */

/** Everything the app reads, and whether the product works without it. */
const KNOWN = [
  'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_BASE_URL',
  'OPENROUTER_REFERER', 'OPENROUTER_TITLE',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET', 'JWT_TTL_HOURS',
  'OPEN_ACCESS', 'TEMPLATE_ACCESS', 'UNLIMITED_GENERATIONS',
  'CREDITS', 'SIGNUP_CREDITS', 'CREDITS_PER_MTOK', 'CREDITS_PER_GAME', 'CREDITS_PER_EDIT',
  'BUILD_MAX_ATTEMPTS', 'AUTH_PROVIDER', 'DATA_DIR', 'SHOWCASE_TEMPLATE',
  'BILLING_PROVIDER', 'NODE_ENV', 'PORT', 'HOST', 'TEST_MODE'
];

/** Names the platform sets itself; never a user mistake. */
const PLATFORM = /^(VERCEL|AWS|LAMBDA|NETLIFY|CI|npm_|NODE_|PATH$|HOME$|PWD$|LANG|LC_|TERM|SHELL|USER$|HOSTNAME$|TZ$|_$)/i;

/** Levenshtein distance, capped - we only care about "close". */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The known name this one was probably meant to be, or null.
 *
 * Distance alone is not enough: SUPABASE_URL and SUPABASE_ANON_KEY differ by
 * more than a typo but mean different things. A shared prefix plus a small
 * distance is what actually indicates a slip of the fingers.
 */
function didYouMean(name) {
  let best = null;
  let bestScore = Infinity;
  for (const known of KNOWN) {
    if (known === name) return null;
    const d = distance(name, known);
    if (d < bestScore) { bestScore = d; best = known; }
  }
  if (bestScore <= 3 && best) return best;

  // A different shape of mistake: the right idea, the wrong words. Anything
  // that clearly refers to the database or the model provider but matches no
  // known name is worth surfacing even when it is nowhere near one.
  if (/^(SUPER|SUPA|SUPB|SUPP)?BASE|SUPER.?BASE|SUPA.?BASE/i.test(name)) return 'SUPABASE_URL';
  if (/OPEN.?ROUTER|OPENROUTE/i.test(name)) return 'OPENROUTER_API_KEY';
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{seen:string[], suspicious:Array<{name:string,didYouMean:string}>, count:number}}
 */
function audit(env = process.env) {
  const names = Object.keys(env);
  const seen = KNOWN.filter((name) => String(env[name] || '').trim().length > 0);

  const suspicious = names
    .filter((name) => !KNOWN.includes(name))
    .filter((name) => !PLATFORM.test(name))
    .filter((name) => String(env[name] || '').trim().length > 0)
    .map((name) => ({ name, didYouMean: didYouMean(name) }))
    .filter((entry) => entry.didYouMean !== null);

  return { seen, suspicious, count: names.length };
}

module.exports = { audit, didYouMean, KNOWN };
