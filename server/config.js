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

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './server/data'),
  templatesDir: path.join(ROOT, 'templates'),
  publicDir: path.join(ROOT, 'public'),

  anthropic: {
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    maxTokens: num(process.env.ANTHROPIC_MAX_TOKENS, 16000),
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    version: '2023-06-01',
    timeoutMs: num(process.env.ANTHROPIC_TIMEOUT_MS, 300000)
  },

  auth: {
    secret: (process.env.JWT_SECRET || '').trim() || crypto.randomBytes(48).toString('hex'),
    secretIsEphemeral: !(process.env.JWT_SECRET || '').trim(),
    ttlHours: num(process.env.JWT_TTL_HOURS, 168)
  },

  quotas: {
    free: num(process.env.FREE_DAILY_GENERATIONS, 5),
    pro: num(process.env.PRO_DAILY_GENERATIONS, 200)
  },

  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    max: num(process.env.RATE_LIMIT_MAX, 60)
  },

  billing: {
    provider: process.env.BILLING_PROVIDER || 'stub',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripePriceId: process.env.STRIPE_PRICE_ID || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  }
};

/** True when a real Claude API key is configured. */
config.aiEnabled = Boolean(config.anthropic.apiKey);

module.exports = config;
