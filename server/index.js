'use strict';

/**
 * meamus - prompt-to-playable-game SaaS.
 * Boots the API, the static frontend, and the shareable play routes.
 */

const path = require('path');
const express = require('express');

const config = require('./config');
const modelRouter = require('./services/models');
const db = require('./db');
const middleware = require('./middleware');
const access = require('./access');
const bundler = require('./services/bundler');
const templates = require('./services/templates');
const { PLANS } = require('./routes/billing.routes');
const envAuditor = require('./env-audit');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '44mb' }));
app.use(express.urlencoded({ extended: false }));

/* --- security headers ---------------------------------------------------- */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  // Play routes intentionally render generated code, so they are framed by the
  // app itself; everything else refuses to be framed.
  if (!req.path.startsWith('/play/') && !req.path.startsWith('/demos/') && !req.path.startsWith('/api/templates/')) {
    res.set('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

/**
 * Storage has to be ready before any handler reads it. A long-running server
 * does that in start(); a serverless invocation never calls start(), so the
 * first request through does it here. The promise is memoised, so concurrent
 * cold-start requests share one hydrate rather than racing.
 */
let storageReady = null;
app.use((req, res, next) => {
  if (!db.init) return next();
  if (!storageReady) {
    storageReady = db.init().catch((err) => {
      storageReady = null;          // let the next request retry
      throw err;
    });
  }
  storageReady.then(() => next(), next);
});

app.use(middleware.optionalAuth);
app.use('/api', middleware.rateLimit());

/* --- API ----------------------------------------------------------------- */
app.get('/api/status', (req, res) => {
  // Recomputed per request so a redeploy is reflected without a restart.
  const envAudit = envAuditor.audit();
  res.json({
    service: 'meamus',
    version: require('../package.json').version,
    aiEnabled: config.aiEnabled,
    // The one thing an operator needs to see at a glance.
    mode: config.aiEnabled ? 'ai' : 'template',
    provider: config.llm.provider,
    model: config.aiEnabled ? config.llm.model : null,
    /* The roster, and anything currently benched.
       
       "Generation is slow today" and "four of the six free models are capped
       until midnight" look identical from outside, and only one of them is
       worth adding credit over. Ids only - no keys, no values. */
    models: config.aiEnabled && config.llm.provider === 'openrouter'
      ? {
        coder: modelRouter.CODER.map((m) => m.id),
        brief: modelRouter.BRIEF.map((m) => m.id),
        unavailable: modelRouter.benchedNow().map((b) => ({
          model: b.id, forSeconds: Math.round(b.forMs / 1000)
        }))
      }
      : null,
    testMode: config.testMode,
    templates: templates.list().length,
    showcase: config.showcaseTemplate,
    storage: db.kind,
    storageDurable: db.durable !== false,
    serverless: config.serverless,
    ...access.describe(),
    unlimited: config.quotas.unlimited,
    quotas: config.quotas,
    credits: {
      enabled: config.credits.enabled,
      signupGrant: config.credits.signupGrant,
      costs: { create: config.credits.costCreate, iterate: config.credits.costIterate }
    },
    billingProvider: config.billing.provider,
    plans: PLANS.map((p) => ({
      id: p.id, name: p.name, price: p.price, credits: p.credits || 0, apk: Boolean(p.apk)
    })),
    // Names only, never values. A key set under the wrong name - or on the
    // wrong Vercel environment - is invisible otherwise, and looks exactly
    // like a key that was never added.
    // Which deployment is answering. Env vars set on the wrong Vercel
    // environment, or set after the last deploy, are invisible otherwise and
    // look exactly like vars that were never added.
    // Recomputed per request, so a redeploy is reflected without a restart.
    deployment: {
      vercelEnv: process.env.VERCEL_ENV || null,          // production | preview | development
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      region: process.env.VERCEL_REGION || null,
      envCount: envAudit.count
    },
    // Names only, never values. A key set under the wrong name - or on the
    // wrong Vercel environment - is invisible otherwise, and looks exactly
    // like a key that was never added.
    envSeen: envAudit.seen,
    // Names that look like a near miss for one the app reads. A misspelling is
    // the one cause of "I set it and nothing happened" that no substring
    // search would ever surface.
    envSuspicious: envAudit.suspicious,
    // Present but blank. Bulk-importing a .env.example creates every name in
    // it, and its secrets are deliberately blank - so the dashboard looks
    // complete while the server sees nothing.
    envEmpty: envAudit.empty,
    // Values that are almost certainly an example-file default left in place.
    envRisky: envAudit.risky,
    warnings: [
      ...(config.aiEnabled ? [] : ['OPENROUTER_API_KEY is not set - generation runs in template mode.']),
      ...(config.testMode ? ['TEST_MODE is on - anyone can generate without signing up.'] : []),
      // The failure mode this catches: on a serverless host the JSON store
      // writes to /tmp, which is discarded between invocations, so accounts
      // are created and then vanish.
      ...(db.durable === false
        ? ['No durable storage, so accounts are off and the app is running open to everyone. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to turn accounts back on.']
        : []),
      // Open access with a model key means strangers reach the API key. Credits
      // bound how far each one gets, so the warning says which case this is.
      ...(config.aiEnabled && access.openAccess()
        ? [config.credits.enabled
          ? `Access is open with a model key set. Credits cap each anonymous visitor at ${Math.floor(Math.round(config.credits.signupGrant / 4) / config.credits.costCreate)} generations, but a new session gets a fresh grant. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to require accounts.`
          : 'Access is open with a model key set and credits are off - anyone can spend your API credits without signing up.']
        : []),
      // Settings that were corrected at boot. Silent correction is how a
      // rate limit of 0 turns into "the whole site is down" with no clue why.
      ...config.problems,
      ...(config.auth.secretIsEphemeral ? ['JWT_SECRET is not set - sessions reset when the server restarts.'] : [])
    ]
  });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api', require('./routes/templates.routes'));
app.use('/api', require('./routes/games.routes'));
app.use('/api', require('./routes/build.routes'));
app.use('/api', require('./routes/uploads.routes'));
app.use('/api', require('./routes/billing.routes').router);

/* --- shareable play route ------------------------------------------------ */
/* Public games play for anyone; private ones need the owner's token, which
   the app appends when it builds the preview iframe URL. */
app.get('/play/:id', (req, res) => {
  const game = db.find('games', (g) => g.id === req.params.id);
  if (!game) return res.status(404).send('<h1>404</h1><p>That game does not exist.</p>');

  const isOwner = req.user && req.user.id === game.userId;
  if (!game.isPublic && !isOwner) {
    return res.status(403).send('<h1>403</h1><p>This game is private.</p>');
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(bundler.bundle(game.spec));
});

/* --- static frontend ----------------------------------------------------- */
app.use(express.static(config.publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));

app.use('/api', middleware.notFound);
app.get('*', (req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
app.use(middleware.errorHandler);

/* --- boot ---------------------------------------------------------------- */
/**
 * public/demos/ is generated (and gitignored), normally by the postinstall
 * hook. Rebuild it at boot if it is missing so a clone that skipped the hook
 * still serves the demo gallery.
 */
function ensureDemos() {
  const fs = require('fs');
  // public/ is read-only on serverless hosts; the demos are built at deploy
  // time instead, and /api/templates/:id/play renders them anyway.
  if (config.serverless) return;
  const demoDir = path.join(config.publicDir, 'demos');
  const expected = templates.list().length;
  const present = fs.existsSync(demoDir)
    ? fs.readdirSync(demoDir).filter((f) => f.endsWith('.html')).length
    : 0;
  if (present >= expected) return;
  try {
    require('../scripts/build-demos');
  } catch (err) {
    console.error('[boot] could not build the demo pages:', err.message);
  }
}

async function start() {
  ensureDemos();

  // The Postgres backend reads every document once before serving, so route
  // handlers can stay synchronous. Failing here is better than answering the
  // first signup with an empty user table.
  if (db.init) {
    try {
      await db.init();
    } catch (err) {
      console.error(`\n  Storage failed to start: ${err.message}`);
      console.error('  Run `npm run db:check` to diagnose. Falling back would silently');
      console.error('  lose data, so meamus stops here instead.\n');
      process.exit(1);
    }
  }
  const server = app.listen(config.port, config.host, () => {
    const url = `http://localhost:${config.port}`;
    console.log('');
    console.log(`  meamus  ${require('../package.json').version}`);
    console.log(`  ${url}`);
    console.log('');
    console.log(`  mode       ${config.aiEnabled ? `AI · ${config.llm.provider} · ${config.llm.model}` : 'TEMPLATE (no OPENROUTER_API_KEY)'}`);
    console.log(`  access     ${access.openAccess() ? 'open - no signup required' : 'account required'} · templates ${access.templateAccess()}`);
    console.log(`  limits     ${config.rateLimit.max} req/min · generations ${config.quotas.unlimited ? 'unlimited' : `${config.quotas.guest}/${config.quotas.free}/${config.quotas.pro} per day`}`);
    console.log(`  templates  ${templates.list().length}`);
    console.log(`  billing    ${config.billing.provider}`);
    console.log(`  storage    ${db.kind}${db.kind === 'json' ? ` (${config.dataDir})` : ` (${config.supabase.url})`}`);
    if (!config.aiEnabled) {
      console.log('');
      console.log('  Add OPENROUTER_API_KEY to .env and restart for original AI generation.');
      console.log('  Verify the key with: npm run llm:check');
    }
    if (config.auth.secretIsEphemeral) {
      console.log('  Warning: JWT_SECRET is unset, so sessions reset on restart.');
    }
    for (const problem of config.problems) console.log(`  Config: ${problem}`);
    if (db.kind === 'json' && config.env === 'production') {
      console.log('  Warning: storing to local disk in production. On an ephemeral host');
      console.log('           accounts vanish on restart - set SUPABASE_URL to fix it.');
    }
    console.log('');
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, flushing data...`);
    // Writes are issued without blocking requests, so the process must not
    // exit until they have actually landed.
    await db.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('meamus failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
