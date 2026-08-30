'use strict';

/**
 * Serverless entry point (Vercel, and anything else that wants a handler
 * rather than a listening process).
 *
 * `server/index.js` only calls app.listen() when it is the main module, so
 * requiring it here gives us the configured Express app with no socket bound.
 * Storage is initialised lazily by middleware, because the boot path that
 * normally does it never runs in this mode.
 */

const { app } = require('../server/index');

module.exports = app;
