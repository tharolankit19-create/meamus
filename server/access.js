'use strict';

/**
 * Resolves the access model.
 *
 * The rule the product wants: an account is required to build, and having one
 * removes every limit. The rule cannot apply when the deployment has nowhere
 * durable to keep an account - requiring a login that is impossible to
 * complete is a dead site, not a security posture. So when storage is not
 * durable the anonymous path opens on its own and the library comes with it.
 *
 * The moment SUPABASE_URL is set, this flips back to account-required with no
 * code change and no redeploy decision to make.
 */

const config = require('./config');
const db = require('./db');

/** True when a visitor may build without signing up. */
function openAccess() {
  if (config.openAccessSetting !== null) return config.openAccessSetting;
  return db.durable === false;
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

/** One object for /api/status and the frontend to read. */
function describe() {
  return {
    openAccess: openAccess(),
    templateAccess: templateAccess(),
    accountsAvailable: accountsAvailable(),
    // Whether the model above was chosen automatically rather than configured.
    auto: config.openAccessSetting === null
  };
}

module.exports = { openAccess, templateAccess, accountsAvailable, describe };
