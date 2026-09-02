'use strict';

/**
 * Accounts.
 *
 * An account is the only way into meamus. There is no guest path: a guest had
 * no durable home for its games, no way to buy credits, and produced the
 * confusing half-state where the product looked signed-in but could not keep
 * anything.
 *
 * With Supabase Auth configured, email and password are proxied to Supabase so
 * the browser never holds a key, and Google is a redirect the browser makes
 * itself. Without it, the local scrypt path still works so a fresh clone and
 * the test suite run offline.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const profiles = require('../profiles');
const supabaseAuth = require('../services/supabase-auth');
const { requireAuth, publicUser, asyncRoute } = require('../middleware');

const router = express.Router();

const usingSupabase = () => config.auth.provider === 'supabase';

const clean = (v) => String(v || '').trim();
const cleanEmail = (v) => clean(v).toLowerCase();

function badEmail(email) {
  return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/** The session shape the browser stores. */
function session(user, token, extra = {}) {
  return { token, user: publicUser(user), ...extra };
}

/* --- register ------------------------------------------------------------- */

router.post('/register', asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const name = clean(req.body.name);

  if (badEmail(email)) return res.status(400).json({ error: 'Enter a valid email address', code: 'bad_email' });
  if (password.length < 8) {
    return res.status(400).json({ error: 'Use a password of at least 8 characters', code: 'weak_password' });
  }

  if (usingSupabase()) {
    const { user, session: s } = await supabaseAuth.signUp({ email, password, name });

    // Whether a session comes back depends on the project's email-confirmation
    // setting. Saying "check your inbox" when no session was issued is the
    // honest branch; pretending to be signed in is not.
    if (!s || !s.access_token) {
      return res.status(201).json({
        token: null,
        user: null,
        confirmationRequired: true,
        message: 'Account created. Check your email to confirm it, then sign in.'
      });
    }
    const profile = await profiles.ensure(user);
    return res.status(201).json(session(profile, s.access_token, { refreshToken: s.refresh_token }));
  }

  // Local path. An account that cannot outlive the request is worse than no
  // account: the player signs up, builds, and loses everything on the next
  // cold start. Refuse, and name the two variables that fix it.
  if (db.durable === false) {
    return res.status(503).json({
      error: 'This deployment has no durable storage, so an account would be lost on the next restart. '
        + 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable accounts.',
      code: 'storage_not_durable'
    });
  }
  if (db.find('users', (u) => u.email === email)) {
    return res.status(409).json({ error: 'That email already has an account. Sign in instead.', code: 'email_taken' });
  }
  const now = new Date().toISOString();
  const user = db.insert('users', {
    id: db.id('usr'),
    email,
    name: name || email.split('@')[0],
    passwordHash: auth.hashPassword(password),
    plan: 'free',
    credits: config.credits.signupGrant,
    usage: { date: null, count: 0 },
    createdAt: now,
    updatedAt: now
  });
  res.status(201).json(session(user, auth.sign({ sub: user.id })));
}));

/* --- login ---------------------------------------------------------------- */

router.post('/login', asyncRoute(async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are both required', code: 'missing_fields' });
  }

  if (usingSupabase()) {
    const { user, session: s } = await supabaseAuth.signIn({ email, password });
    const profile = await profiles.ensure(user);
    return res.json(session(profile, s.access_token, { refreshToken: s.refresh_token }));
  }

  const user = db.find('users', (u) => u.email === email);
  if (!user || !user.passwordHash || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'That email and password do not match.', code: 'bad_credentials' });
  }
  res.json(session(user, auth.sign({ sub: user.id })));
}));

/* --- Google --------------------------------------------------------------- */

/**
 * Where to send the browser for Google sign-in.
 *
 * The browser goes to Supabase, Supabase talks to Google, and the browser
 * returns to `redirect` with the session in the URL fragment - which never
 * reaches a server. This endpoint only hands out the address.
 */
router.get('/oauth/google', (req, res) => {
  if (!usingSupabase()) {
    return res.status(503).json({
      error: 'Google sign-in needs Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      code: 'oauth_unavailable'
    });
  }
  const redirect = clean(req.query.redirect) || `${req.protocol}://${req.get('host')}/#/auth/callback`;
  res.json({ url: supabaseAuth.oauthUrl('google', redirect) });
});

/* --- session -------------------------------------------------------------- */

router.post('/refresh', asyncRoute(async (req, res) => {
  if (!usingSupabase()) return res.status(404).json({ error: 'Not available', code: 'not_found' });
  const refreshToken = clean(req.body.refreshToken);
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token', code: 'missing_fields' });
  const { user, session: s } = await supabaseAuth.refresh(refreshToken);
  const profile = await profiles.ensure(user);
  res.json(session(profile, s.access_token, { refreshToken: s.refresh_token }));
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/** Which sign-in methods this deployment actually offers. */
router.get('/methods', (req, res) => {
  res.json({
    password: true,
    google: usingSupabase(),
    provider: config.auth.provider
  });
});

module.exports = router;
