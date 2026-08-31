'use strict';

/**
 * Credits.
 *
 * A generation costs the operator real money at the model provider, so the
 * product meters it. Every account starts with a grant that is enough to build
 * a handful of real games before a plan is needed; plans top the balance up.
 *
 * Two rules the rest of the app depends on:
 *  - a charge is only ever taken for work that succeeded. Callers reserve
 *    nothing: they do the work, then call charge(). A failed generation must
 *    not cost the player anything.
 *  - a balance is authoritative on the server. The client displays it and
 *    never computes it.
 */

const config = require('./config');
const db = require('./db');

/** What each kind of work costs. Chat that produces no game is free. */
const COSTS = {
  create: config.credits.costCreate,
  iterate: config.credits.costIterate,
  chat: 0
};

/**
 * Current balance.
 *
 * An account created before credits existed has no `credits` field. Reading it
 * as the signup grant rather than 0 means the feature does not retroactively
 * lock people out of their own accounts.
 */
function balanceOf(user) {
  if (!user) return 0;
  return Number.isFinite(user.credits) ? user.credits : config.credits.signupGrant;
}

function costOf(kind) {
  return COSTS[kind] === undefined ? COSTS.create : COSTS[kind];
}

/** Whether this account can afford one unit of work of this kind. */
function canAfford(user, kind) {
  if (!config.credits.enabled) return true;
  return balanceOf(user) >= costOf(kind);
}

/**
 * Take payment for completed work.
 * @returns {{charged:number, balance:number}}
 */
function charge(user, kind) {
  const cost = costOf(kind);
  if (!config.credits.enabled || cost === 0) {
    return { charged: 0, balance: balanceOf(user) };
  }
  const balance = Math.max(0, balanceOf(user) - cost);
  db.update('users', user.id, { credits: balance });
  user.credits = balance;
  return { charged: cost, balance };
}

/** Add a plan's credit pack. Credits accumulate rather than reset. */
function grant(user, amount) {
  const balance = balanceOf(user) + Math.max(0, Math.round(amount));
  db.update('users', user.id, { credits: balance });
  user.credits = balance;
  return balance;
}

/** The shape the client renders in the header and in the out-of-credits state. */
function summary(user) {
  return {
    enabled: config.credits.enabled,
    balance: balanceOf(user),
    costs: { create: COSTS.create, iterate: COSTS.iterate }
  };
}

module.exports = { COSTS, balanceOf, costOf, canAfford, charge, grant, summary };
