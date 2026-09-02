'use strict';

const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const credits = require('../credits');
const profiles = require('../profiles');
const supabaseAuth = require('../services/supabase-auth');

/** Public shape of a user - never leaks the password hash. */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    createdAt: user.createdAt,
    usage: usageToday(user),
    // null means no cap. The UI renders that as "unlimited".
    quota: config.quotas.unlimited ? null : (config.quotas[user.plan] || config.quotas.free),
    // The balance is authoritative here. The client only ever displays it.
    credits: credits.balanceOf(user),
    creditCosts: { create: credits.COSTS.create, iterate: credits.COSTS.iterate },
    creditsEnabled: config.credits.enabled
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function usageToday(user) {
  if (!user.usage || user.usage.date !== todayKey()) return 0;
  return user.usage.count;
}

/** Records one generation against the daily quota. Returns the new count. */
function recordUsage(user) {
  const date = todayKey();
  const count = (user.usage && user.usage.date === date ? user.usage.count : 0) + 1;
  user.usage = { date, count };
  // Fire and forget: a lost usage counter must never fail a build the player
  // has already paid for. The credit ledger is the one that has to be exact.
  Promise.resolve(profiles.update(user.id, { usage: { date, count } }))
    .catch((err) => console.error('[usage] could not record:', err.message));
  return count;
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

/**
 * Attaches req.user when a valid token is present; never rejects.
 *
 * With Supabase Auth on, the token is a Supabase access token and is verified
 * by asking Supabase who it belongs to. The profile is then loaded (and created
 * on first sight, which is how a Google sign-in gets a profile without ever
 * touching our signup endpoint).
 */
async function optionalAuth(req, res, next) {
  const token = tokenFrom(req);
  if (!token) return next();

  try {
    if (config.auth.provider === 'supabase') {
      const authUser = await supabaseAuth.getUser(token);
      if (authUser && authUser.id) req.user = await profiles.ensure(authUser);
    } else {
      const payload = auth.verify(token);
      if (payload && payload.sub) {
        req.user = db.find('users', (u) => u.id === payload.sub) || null;
      }
    }
  } catch (err) {
    // A sign-in service that is down must not read as "signed out", or every
    // request silently becomes anonymous and the app looks broken instead of
    // degraded. Surface it.
    if (err.code === 'auth_unreachable' || err.status >= 500) {
      return res.status(503).json({
        error: 'The sign-in service is unavailable. Try again in a moment.',
        code: 'auth_unavailable'
      });
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: config.testMode ? 'Session expired - reload to start a new one' : 'Sign in to continue',
      code: 'unauthorized'
    });
  }
  next();
}

function requirePlan(plan) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue', code: 'unauthorized' });
    if (req.user.plan !== plan) {
      return res.status(402).json({
        error: `This feature needs the ${plan} plan`,
        code: 'upgrade_required',
        requiredPlan: plan
      });
    }
    next();
  };
}

function enforceQuota(req, res, next) {
  // Credits are checked first: they are the real meter, and a player who
  // cannot pay for the work should be told before the model is called.
  if (config.credits.enabled) {
    const kind = req.creditKind || 'create';
    if (!credits.canAfford(req.user, kind)) {
      return res.status(402).json({
        error: `You need ${credits.costOf(kind)} credits for this and have ${credits.balanceOf(req.user)}. Pick a plan to top up.`,
        code: 'insufficient_credits',
        balance: credits.balanceOf(req.user),
        required: credits.costOf(kind)
      });
    }
  }

  if (config.quotas.unlimited) return next();
  const quota = config.quotas[req.user.plan] || config.quotas.free;
  const used = usageToday(req.user);
  if (used >= quota) {
    const nudge = req.user.plan === 'free' ? 'Upgrade for more.' : 'Try again tomorrow.';
    return res.status(429).json({
      error: `Daily limit reached (${used}/${quota} generations). ${nudge}`,
      code: 'quota_exceeded',
      used,
      quota
    });
  }
  next();
}

/** Fixed-window in-memory rate limiter, keyed by user id or client IP. */
function rateLimit() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, config.rateLimit.windowMs).unref();

  return (req, res, next) => {
    const key = (req.user && req.user.id) || req.ip || 'anon';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + config.rateLimit.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.set('X-RateLimit-Limit', String(config.rateLimit.max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, config.rateLimit.max - entry.count)));
    if (entry.count > config.rateLimit.max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests, slow down.', code: 'rate_limited' });
    }
    next();
  };
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', code: 'not_found', path: req.path });
}

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  // Deliberate application errors (a missing API key, an unparseable spec)
  // carry a name and a status; only unexpected failures deserve a stack.
  const expected = ['SpecError', 'ClaudeError'].includes(err.name);
  if (status >= 500 && !expected) console.error('[error]', err);
  else if (status >= 500) console.error(`[error] ${err.name}: ${err.message}`);
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code || (status === 500 ? 'internal_error' : 'request_failed'),
    ...(err.issues ? { issues: err.issues } : {})
  });
}

/** Wraps an async handler so rejections reach errorHandler. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  publicUser, usageToday, recordUsage, optionalAuth, requireAuth,
  requirePlan, enforceQuota, rateLimit, notFound, errorHandler, asyncRoute
};
