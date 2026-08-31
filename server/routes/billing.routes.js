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
const credits = require('../credits');
const { requireAuth, publicUser, asyncRoute } = require('../middleware');

const router = express.Router();

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'USD',
    interval: 'month',
    credits: 0,
    apk: false,
    features: [
      `${config.credits.signupGrant} credits when you sign up`,
      `${config.credits.costCreate} credits per new game, ${config.credits.costIterate} per change`,
      'The full template library, playable and remixable',
      'Unlimited plays and edits of saved games',
      'Standalone HTML export'
    ]
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 29,
    currency: 'USD',
    interval: 'month',
    credits: 1000,
    apk: false,
    features: [
      '1,000 credits every month',
      'Roughly 50 new games, or 100 changes',
      'Credits roll over while your plan is active',
      'Priority generation queue',
      'Standalone HTML and GameSpec JSON export'
    ]
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 59,
    currency: 'USD',
    interval: 'month',
    credits: 2500,
    apk: true,
    features: [
      '2,500 credits every month',
      'Android APK export (signed Cordova project)',
      'Roughly 125 new games, or 250 changes',
      'Priority generation queue',
      'Commercial use licence'
    ]
  }
];

router.get('/billing/plans', (req, res) => {
  res.json({ plans: PLANS, provider: config.billing.provider });
});

router.post('/billing/checkout', requireAuth, asyncRoute(async (req, res) => {
  if (req.user.isGuest) {
    return res.status(402).json({
      error: 'Create an account before upgrading',
      code: 'signup_required'
    });
  }
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
  // Credits accumulate. Someone who upgrades mid-month keeps what they had.
  if (plan.credits) credits.grant(updated, plan.credits);

  res.json({
    checkoutUrl: null,
    upgraded: true,
    provider: 'stub',
    granted: plan.credits || 0,
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
