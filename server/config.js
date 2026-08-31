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
    // NVIDIA Nemotron 3.5 Lightning: 262k context, 131k max output, cheap, and
    // it honours structured outputs - which is what keeps a 3B-active model
    // emitting a spec that parses first try.
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    maxTokens: positive('LLM_MAX_TOKENS', process.env.LLM_MAX_TOKENS, 32000),
    temperature: num(process.env.LLM_TEMPERATURE, 0.6),
    timeoutMs: positive('LLM_TIMEOUT_MS', process.env.LLM_TIMEOUT_MS, 300000),
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
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return SERVERLESS ? '/tmp/meamus-data' : './server/data';
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
    // How many times the review loop hands a rejected build back to the model.
    maxAttempts: positive('BUILD_MAX_ATTEMPTS', process.env.BUILD_MAX_ATTEMPTS, 3),
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
