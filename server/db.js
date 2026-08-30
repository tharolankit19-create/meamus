'use strict';

/**
 * Storage facade.
 *
 * Picks a backend once at boot and re-exports it. Nothing else in the codebase
 * knows which one is active, so moving from the JSON file to Supabase is an
 * env-var change, not a refactor.
 */

const config = require('./config');

let backend;

if (config.supabase.enabled) {
  const { createSupabaseStore } = require('./store/supabase');
  backend = createSupabaseStore(config);
} else {
  backend = require('./store/json');
}

module.exports = backend;
