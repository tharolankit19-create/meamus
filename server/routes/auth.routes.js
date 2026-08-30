'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { publicUser, requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function issue(user) {
  return { token: auth.sign({ sub: user.id, email: user.email }), user: publicUser(user) };
}

/**
 * Test-mode guest session.
 *
 * Mints a throwaway account so a visitor can prompt, generate and play with no
 * signup. It is a real user record, so ownership, quotas and every downstream
 * route behave exactly as they will for a signed-up account - there is no
 * second code path to keep in sync.
 */
router.post('/guest', asyncRoute(async (req, res) => {
  if (!config.testMode) {
    return res.status(403).json({
      error: 'Guest sessions are disabled. Create an account to continue.',
      code: 'guest_disabled'
    });
  }

  const now = new Date().toISOString();
  const suffix = db.id('g').slice(-8);
  const user = db.insert('users', {
    id: db.id('usr'),
    email: `guest-${suffix}@guest.meamus.local`,
    name: 'Guest',
    passwordHash: null,
    plan: 'guest',
    isGuest: true,
    usage: { date: null, count: 0 },
    createdAt: now,
    updatedAt: now
  });

  res.status(201).json(issue(user));
}));

router.post('/register', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 60);

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address', code: 'invalid_email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters', code: 'weak_password' });
  if (db.find('users', (u) => u.email === email)) {
    return res.status(409).json({ error: 'That email is already registered', code: 'email_taken' });
  }

  // Registering while holding a guest token upgrades that guest in place, so
  // the games made during a test session survive the signup.
  if (req.user && req.user.isGuest) {
    const upgraded = db.update('users', req.user.id, {
      email,
      name: name || email.split('@')[0],
      passwordHash: auth.hashPassword(password),
      plan: 'free',
      isGuest: false
    });
    return res.status(201).json({ ...issue(upgraded), upgradedFromGuest: true });
  }

  const now = new Date().toISOString();
  const user = db.insert('users', {
    id: db.id('usr'),
    email,
    name: name || email.split('@')[0],
    passwordHash: auth.hashPassword(password),
    plan: 'free',
    usage: { date: null, count: 0 },
    createdAt: now,
    updatedAt: now
  });

  res.status(201).json(issue(user));
}));

router.post('/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.find('users', (u) => u.email === email);

  // Same message either way so the endpoint cannot be used to enumerate emails.
  if (!user || !auth.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password', code: 'bad_credentials' });
  }
  res.json(issue(user));
}));

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), aiEnabled: config.aiEnabled });
});

router.patch('/me', requireAuth, asyncRoute(async (req, res) => {
  const patch = {};
  if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 60);
  const updated = db.update('users', req.user.id, patch);
  res.json({ user: publicUser(updated) });
}));

module.exports = router;
