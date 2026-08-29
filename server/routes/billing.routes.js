'use strict';

/**
 * Billing.
 *
 * The stub provider flips the plan immediately so the whole paid path
 * (APK export, higher quota) is testable with no payment account. Swapping in
 * Stripe means implementing createCheckoutSession() and the webhook handler -
 * the rest of the app only ever reads user.plan. See docs/BILLING.md.
 */

const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth, publicUser, asyncRoute } = require('../middleware');

const router = express.Router();

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'USD',
    interval: 'month',
    features: [
      `${config.quotas.free} generations per day`,
      'Unlimited plays and edits of saved games',
      'Standalone HTML export',
      'GameSpec JSON export'
    ]
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 19,
    currency: 'USD',
    interval: 'month',
    features: [
      `${config.quotas.pro} generations per day`,
      'Android APK export (signed Cordova project)',
      'Priority generation queue',
      'Commercial use licence'
    ]
  }
];

router.get('/billing/plans', (req, res) => {
  res.json({ plans: PLANS, provider: config.billing.provider });
});

router.post('/billing/checkout', requireAuth, asyncRoute(async (req, res) => {
  const planId = String(req.body.plan || 'pro');
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Unknown plan', code: 'unknown_plan' });

  if (config.billing.provider === 'stripe') {
    // Wire-up point: create a Stripe Checkout session and return its url.
    // The webhook below is what actually upgrades the account.
    if (!config.billing.stripeSecretKey || !config.billing.stripePriceId) {
      return res.status(503).json({
        error: 'Stripe is selected but STRIPE_SECRET_KEY / STRIPE_PRICE_ID are not set',
        code: 'billing_misconfigured'
      });
    }
    return res.status(501).json({
      error: 'Stripe checkout is not implemented in this build. See docs/BILLING.md.',
      code: 'not_implemented'
    });
  }

  // Stub provider: upgrade immediately so the paid features can be exercised.
  const updated = db.update('users', req.user.id, {
    plan: plan.id,
    billing: { provider: 'stub', plan: plan.id, since: new Date().toISOString() }
  });

  res.json({
    checkoutUrl: null,
    upgraded: true,
    provider: 'stub',
    user: publicUser(updated),
    note: 'Stub billing upgraded this account instantly. Set BILLING_PROVIDER=stripe for real payments.'
  });
}));

router.post('/billing/downgrade', requireAuth, asyncRoute(async (req, res) => {
  const updated = db.update('users', req.user.id, { plan: 'free' });
  res.json({ user: publicUser(updated) });
}));

/**
 * Stripe webhook target. Left unimplemented on purpose: verifying the
 * signature needs the stripe SDK, and a half-verified webhook is worse than
 * an absent one. The handler shape is here so the wiring is obvious.
 */
router.post('/billing/webhook', (req, res) => {
  if (config.billing.provider !== 'stripe') {
    return res.status(404).json({ error: 'Stripe is not the active billing provider', code: 'not_found' });
  }
  res.status(501).json({
    error: 'Implement signature verification before enabling this endpoint. See docs/BILLING.md.',
    code: 'not_implemented'
  });
});

module.exports = { router, PLANS };
