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
 * So this reports names - never values - and distinguishes three states that
 * look identical from the outside:
 *
 *   set        the name is there and carries a value
 *   EMPTY      the name is there and the value is blank
 *   missing    the name is not there at all
 *
 * The middle one is the trap. Bulk-importing a .env.example into a host
 * creates every name in it, and the secrets in that file are deliberately
 * blank - so the dashboard shows a full, correct-looking list while the server
 * sees nothing. Reporting only "not set" makes that indistinguishable from
 * never having added it, which is how an operator ends up certain they
 * configured something that was never configured.
 *
 * It also flags names that look like a near miss for one the app reads.
 * SUPERBASE_URL and SUPBASE_URL are both plausible typos that no substring
 * search would catch.
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

/** Values that are almost certainly a .env.example default left in place. */
const DANGEROUS_DEFAULTS = [
  { name: 'TEST_MODE', when: (v) => v === 'true',
    why: 'Test mode lets anyone generate without an account. Set it to false in production.' },
  { name: 'NODE_ENV', when: (v) => v === 'development',
    why: 'This deployment is serving production traffic as development.' },
  { name: 'DATA_DIR', when: (v) => v.startsWith('.') || v.startsWith('./'),
    why: 'A relative data directory is read-only on a serverless host. Remove it and let the server choose.' }
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{seen:string[], empty:string[], suspicious:Array<{name:string,didYouMean:string}>,
 *            risky:Array<{name:string,why:string}>, count:number}}
 */
function audit(env = process.env) {
  const names = Object.keys(env);
  const has = (name) => Object.prototype.hasOwnProperty.call(env, name);
  const value = (name) => String(env[name] === undefined || env[name] === null ? '' : env[name]).trim();

  const seen = KNOWN.filter((name) => value(name).length > 0);

  // Present but blank. The name exists, so the dashboard looks right and the
  // server still gets nothing.
  const empty = KNOWN.filter((name) => has(name) && value(name).length === 0);

  const risky = DANGEROUS_DEFAULTS
    .filter((rule) => value(rule.name) && rule.when(value(rule.name)))
    .map((rule) => ({ name: rule.name, why: rule.why }));

  const suspicious = names
    .filter((name) => !KNOWN.includes(name))
    .filter((name) => !PLATFORM.test(name))
    .filter((name) => String(env[name] || '').trim().length > 0)
    .map((name) => ({ name, didYouMean: didYouMean(name) }))
    .filter((entry) => entry.didYouMean !== null);

  return { seen, empty, suspicious, risky, count: names.length };
}

module.exports = { audit, didYouMean, KNOWN, DANGEROUS_DEFAULTS };
