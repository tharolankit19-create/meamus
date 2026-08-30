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

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
      maxTokens: num(process.env.LLM_MAX_TOKENS, 16000),
      temperature: Number(process.env.LLM_TEMPERATURE ?? 1),
      timeoutMs: num(process.env.LLM_TIMEOUT_MS, 300000),
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
    maxTokens: num(process.env.LLM_MAX_TOKENS, 32000),
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.6),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 300000),
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
    ttlHours: num(process.env.JWT_TTL_HOURS, 168)
  },

  quotas: {
    guest: num(process.env.GUEST_DAILY_GENERATIONS, 20),
    free: num(process.env.FREE_DAILY_GENERATIONS, 5),
    pro: num(process.env.PRO_DAILY_GENERATIONS, 200)
  },

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
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: num(process.env.RATE_LIMIT_MAX, 60)
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

module.exports = config;
