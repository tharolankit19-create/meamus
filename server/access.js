'use strict';

/**
 * Resolves the access model.
 *
 * The rule is not negotiable any more: an account is required to build.
 *
 * This used to auto-degrade - when storage was not durable it opened the
 * anonymous path so the site was not dead. That produced something worse than
 * a dead site: a sign-up dialog offering free credits that errored on submit
 * with "accounts are off", and an open door to the operator's model key. A
 * half-working product that lies about which half is working costs more trust
 * than one that says "not configured yet".
 *
 * So an unconfigured deployment now reports itself as unconfigured, and the
 * frontend shows the operator what to set. OPEN_ACCESS=true still forces the
 * anonymous path for anyone who genuinely wants it.
 */

const config = require('./config');
const db = require('./db');

/** True when a visitor may build without signing up. Off unless forced on. */
function openAccess() {
  return config.openAccessSetting === true;
}

/** 'open' or 'gated' for the template library. */
function templateAccess() {
  if (config.templateAccessSetting) return config.templateAccessSetting;
  return openAccess() ? 'open' : 'gated';
}

/** True when signing up would produce an account that actually survives. */
function accountsAvailable() {
  return db.durable !== false;
}

/**
 * What an operator has to do before this deployment works, if anything.
 * Empty means it is ready.
 */
function setupNeeded() {
  const missing = [];
  if (db.durable === false) {
    missing.push({
      key: 'SUPABASE_URL',
      why: 'Accounts and saved games need a database. Without it every account disappears on the next request.'
    });
    missing.push({
      key: 'SUPABASE_SERVICE_ROLE_KEY',
      why: 'The server-side key that reads and writes those tables. Never expose it to a browser.'
    });
  }
  if (!config.auth.secret || config.auth.secretIsEphemeral) {
    missing.push({
      key: 'JWT_SECRET',
      why: 'Without a fixed secret, every restart signs everyone out.'
    });
  }
  return missing;
}

/** One object for /api/status and the frontend to read. */
function describe() {
  const missing = setupNeeded();
  return {
    openAccess: openAccess(),
    templateAccess: templateAccess(),
    accountsAvailable: accountsAvailable(),
    // Blocking means the product cannot function at all until it is fixed.
    // A missing JWT_SECRET is untidy; a missing database is fatal.
    setupRequired: db.durable === false && !openAccess(),
    setupMissing: missing,
    auto: false
  };
}

module.exports = { openAccess, templateAccess, accountsAvailable, setupNeeded, describe };
