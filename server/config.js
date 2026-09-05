'use strict';

/**
 * Central configuration. Reads .env (no dotenv dependency - tiny parser below)
 * then falls back to sane defaults so the app boots with zero setup.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

/**
 * Read a numeric setting.
 *
 * An env var that exists but is empty means "not set". Number('') is 0 and
 * Number.isFinite(0) is true, so the obvious implementation silently turns an
 * unfilled variable into a hard zero - a rate limit of 0 blocks every request,
 * a token TTL of 0 expires every session instantly, a quota of 0 forbids all
 * generation. Empty and whitespace both fall back.
 */
const num = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Settings collected here are surfaced by /api/status instead of failing quietly. */
const configProblems = [];

/**
 * A setting that is meaningless at or below zero. Falls back rather than
 * locking the product, and records why so an operator can see it.
 */
const positive = (name, value, fallback) => {
  const parsed = num(value, fallback);
  if (parsed > 0) return parsed;
  configProblems.push(`${name} is set to "${value}", which would disable the feature. Using ${fallback}.`);
  return fallback;
};

/**
 * Model provider. OpenRouter is the default; an Anthropic key still works if
 * that is all that is set. Whichever key is present wins, so a fresh clone
 * needs exactly one line in .env.
 */
function buildLlmConfig() {
  const openrouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const explicit = (process.env.LLM_PROVIDER || '').trim().toLowerCase();

  const provider = explicit
    || (openrouterKey ? 'openrouter' : anthropicKey ? 'anthropic' : 'openrouter');

  if (provider === 'anthropic') {
    return {
      provider,
      apiKey: anthropicKey,
      enabled: Boolean(anthropicKey),
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      maxTokens: positive('LLM_MAX_TOKENS', process.env.LLM_MAX_TOKENS, 16000),
      temperature: num(process.env.LLM_TEMPERATURE, 1),
      timeoutMs: positive('LLM_TIMEOUT_MS', process.env.LLM_TIMEOUT_MS, 300000),
      referer: '',
      title: ''
    };
  }

  return {
    provider: 'openrouter',
    apiKey: openrouterKey,
    enabled: Boolean(openrouterKey),
    // NVIDIA Nemotron 3 Super 120B, free tier: 262k context, 235k max output,
    // and - the reason it is the default rather than one of the other free
    // NVIDIA models - it is the only free NVIDIA model that honours structured
    // outputs. Without a schema the model answers with prose around the JSON
    // and the spec has to be scraped back out of it, which is where malformed
    // games come from. A free model that cannot be held to the schema is not
    // cheaper; it just fails later.
    //
    // The free tier is rate limited (see OPENROUTER_MODEL in .env.example), so
    // a busy deployment should point this at the paid twin, which is the same
    // model without the :free suffix.
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    maxTokens: positive('LLM_MAX_TOKENS', process.env.LLM_MAX_TOKENS, 32000),
    temperature: num(process.env.LLM_TEMPERATURE, 0.6),
    /**
     * Reasoning, on models that have it. Off by default, because reasoning
     * tokens come out of max_tokens before the answer is written and these
     * calls return a schema-pinned JSON document whose thinking is thrown
     * away - so it buys nothing and costs the end of the game.
     * Set LLM_REASONING to low, medium or high to turn it back on.
     */
    reasoning: (() => {
      const raw = (process.env.LLM_REASONING || '').trim().toLowerCase();
      return ['low', 'medium', 'high'].includes(raw) ? raw : false;
    })(),
    timeoutMs: positive('LLM_TIMEOUT_MS', process.env.LLM_TIMEOUT_MS, 300000),
    /**
     * How many times to ride out a provider-side failure - a rate limit, a 502,
     * a timeout. These say nothing about the answer, so there is nothing to
     * feed back to the model: the only sane response is to wait and ask again.
     * On a free tier this is the common path, not the exception.
     */
    retries: positive('LLM_RETRIES', process.env.LLM_RETRIES, 4),
    retryBaseMs: positive('LLM_RETRY_BASE_MS', process.env.LLM_RETRY_BASE_MS, 4000),
    retryMaxMs: positive('LLM_RETRY_MAX_MS', process.env.LLM_RETRY_MAX_MS, 20000),
    referer: process.env.OPENROUTER_REFERER || 'https://meamus.app',
    title: process.env.OPENROUTER_TITLE || 'meamus'
  };
}

/**
 * Serverless platforms give you a read-only filesystem apart from /tmp, and no
 * boot hook. Detecting that up front lets the writable paths and the lazy
 * storage init pick sane defaults instead of crashing on the first upload.
 */
const SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
);

function defaultDataDir() {
  const configured = (process.env.DATA_DIR || '').trim();
  if (!configured) return SERVERLESS ? '/tmp/meamus-data' : './server/data';

  // A serverless filesystem is read-only apart from /tmp. DATA_DIR=./server/data
  // is the .env.example default, and honouring it on Vercel means every write
  // fails with EROFS. The configured value is ignored rather than obeyed into a
  // crash, and config.problems records that it happened.
  if (SERVERLESS && !path.isAbsolute(configured)) {
    configProblems.push(
      `DATA_DIR is "${configured}", which is read-only on a serverless host. Using /tmp/meamus-data instead.`
    );
    return '/tmp/meamus-data';
  }
  return configured;
}

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  serverless: SERVERLESS,
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  dataDir: path.resolve(ROOT, defaultDataDir()),
  templatesDir: path.join(ROOT, 'templates'),

  /**
   * The one template anyone may play without an account. It runs the landing
   * page's attract loop, so it has to stay public; the rest of the library is
   * behind sign-in.
   */
  showcaseTemplate: process.env.SHOWCASE_TEMPLATE || 'space-shooter',
  publicDir: path.join(ROOT, 'public'),

  llm: buildLlmConfig(),

  auth: {
    /**
     * Where accounts live.
     *
     * 'supabase' means real identity - password hashes, email confirmation and
     * Google sign-in are Supabase's job. 'local' is the offline path a fresh
     * clone and the test suite take. AUTH_PROVIDER forces either.
     */
    get provider() {
      const forced = (process.env.AUTH_PROVIDER || '').trim().toLowerCase();
      if (forced === 'supabase' || forced === 'local') return forced;
      return module.exports.supabase.enabled ? 'supabase' : 'local';
    },
    secret: (process.env.JWT_SECRET || '').trim() || crypto.randomBytes(48).toString('hex'),
    secretIsEphemeral: !(process.env.JWT_SECRET || '').trim(),
    ttlHours: positive('JWT_TTL_HOURS', process.env.JWT_TTL_HOURS, 168)
  },

  /**
   * Credits.
   *
   * The meter that replaces "unlimited". A new account gets a grant that buys
   * roughly ten games, and a plan tops it up. Set CREDITS=false to turn the
   * whole system off and fall back to the daily quotas below.
   */
  credits: {
    enabled: (process.env.CREDITS || 'true').trim() !== 'false',
    signupGrant: positive('SIGNUP_CREDITS', process.env.SIGNUP_CREDITS, 200),
    // Credits are metered on tokens, which is what the model provider actually
    // bills for. The flat per-game numbers below are the floor when a build
    // reports no usage.
    perMillionTokens: positive('CREDITS_PER_MTOK', process.env.CREDITS_PER_MTOK, 100),
    costCreate: positive('CREDITS_PER_GAME', process.env.CREDITS_PER_GAME, 20),
    costIterate: positive('CREDITS_PER_EDIT', process.env.CREDITS_PER_EDIT, 10)
  },

  build: {
    /**
     * The Hermes crew: designer -> coder -> tester -> reviewer -> improver ->
     * tester. More model calls than a single-shot build, and better games,
     * because no one agent has to design, write and critique in one breath.
     *
     * This used to be off for `:free` models, on the reasoning that the crew
     * costs three to five calls and a free tier is capped. Two things make that
     * wrong now.
     *
     * The cap is no longer one model's cap: a refusal moves to the next model on
     * the roster, so the calls are spread rather than stacked on one quota.
     *
     * And the two paths are not equivalent. Everything that makes a build
     * survive a bad answer lives in the crew: recognising a cut-off file and
     * asking for a shorter game, shrinking the target on each successive
     * cut-off, the correction that stops the model reaching for an asset
     * loader, booting every scene before shipping, and a retry loop bounded by
     * the time budget rather than by three. The single-call path has none of
     * it - it asks three times and gives up.
     *
     * A free model is the one that most needs that help, and it was the one not
     * getting it. Production proved it: three attempts, all cut off at line
     * 129, each told to check its punctuation, sixty-one seconds, no game.
     *
     * AGENT_CREW=false still forces the old single-call path.
     */
    crew: process.env.AGENT_CREW && process.env.AGENT_CREW.trim()
      ? process.env.AGENT_CREW.trim() === 'true'
      : true,
    // How many times the review loop hands a rejected build back to the model.
    /**
     * How many times the coder may be sent back.
     *
     * This was 3, which is an arbitrary number with nothing to do with whether
     * the next attempt would have worked. A build that fails is worth almost
     * nothing to the founder, so the ceiling should be whatever fits in the
     * time they are already waiting - see budgetMs, which is the real limit.
     */
    maxAttempts: positive('BUILD_MAX_ATTEMPTS', process.env.BUILD_MAX_ATTEMPTS, 12),

    /**
     * The wall clock a build gets to produce something that runs.
     *
     * vercel.json gives the function 300s. Leaving room for the designer, the
     * reviewer and the response itself puts the useful ceiling near 210s.
     */
    budgetMs: positive('BUILD_BUDGET_MS', process.env.BUILD_BUDGET_MS, 210 * 1000),

    /**
     * Do not begin an attempt with less than this left. Being killed halfway
     * through a call spends the tokens and returns nothing.
     */
    attemptReserveMs: positive('BUILD_ATTEMPT_RESERVE_MS', process.env.BUILD_ATTEMPT_RESERVE_MS, 45 * 1000),

    // A build the founder has approved but never started is dropped after this.
    planTtlMs: positive('BUILD_PLAN_TTL_MS', process.env.BUILD_PLAN_TTL_MS, 30 * 60 * 1000)
  },

  quotas: {
    // Unlimited for anyone with an account. There is no anonymous path to
    // generation, so this is a benefit of signing in rather than an open door.
    // Set UNLIMITED_GENERATIONS=false to enforce the per-plan numbers below.
    unlimited: (process.env.UNLIMITED_GENERATIONS || 'true').trim() !== 'false',
    guest: positive('GUEST_DAILY_GENERATIONS', process.env.GUEST_DAILY_GENERATIONS, 20),
    free: positive('FREE_DAILY_GENERATIONS', process.env.FREE_DAILY_GENERATIONS, 5),
    pro: positive('PRO_DAILY_GENERATIONS', process.env.PRO_DAILY_GENERATIONS, 200)
  },

  /**
   * Anonymous guest sessions.
   *
   * null means "decide at runtime": an account is required when storage can
   * hold one, and the anonymous path opens automatically when it cannot.
   * Requiring a login that is impossible to complete leaves a dead site, so
   * the product degrades to usable-without-accounts instead. Resolved in
   * server/access.js. OPEN_ACCESS=true/false forces it either way.
   */
  openAccessSetting: process.env.OPEN_ACCESS
    ? process.env.OPEN_ACCESS.trim() === 'true'
    : null,

  /**
   * Template library access. null follows the access model above: gated when
   * accounts work, open when they cannot. TEMPLATE_ACCESS=open|gated forces it.
   */
  templateAccessSetting: (process.env.TEMPLATE_ACCESS || '').trim() || null,

  /**
   * Test mode: anyone can generate and play without signing up. A guest
   * session is minted automatically and owns its games like a real account,
   * so every route behaves identically. Off by default in production - it is
   * an open door to a paid API key.
   */
  testMode: process.env.TEST_MODE
    ? process.env.TEST_MODE === 'true'
    : (process.env.NODE_ENV || 'development') !== 'production',

  rateLimit: {
    windowMs: positive('RATE_LIMIT_WINDOW_MS', process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: positive('RATE_LIMIT_MAX', process.env.RATE_LIMIT_MAX, 60)
  },

  /**
   * Supabase Postgres, used when both values are present. Without it storage
   * falls back to a JSON file on local disk, which does not survive a restart
   * on an ephemeral host.
   */
  supabase: {
    url: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    serviceKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    get enabled() { return Boolean(this.url && this.serviceKey); }
  },

  billing: {
    provider: process.env.BILLING_PROVIDER || 'stub',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripePriceId: process.env.STRIPE_PRICE_ID || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  }
};

/** True when a model API key is configured. */
config.aiEnabled = config.llm.enabled;

/** Misconfigured settings that were corrected, reported by /api/status. */
config.problems = configProblems;

module.exports = config;
