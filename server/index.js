'use strict';

/**
 * meamus - prompt-to-playable-game SaaS.
 * Boots the API, the static frontend, and the shareable play routes.
 */

const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const middleware = require('./middleware');
const bundler = require('./services/bundler');
const templates = require('./services/templates');
const { PLANS } = require('./routes/billing.routes');

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

app.use(middleware.optionalAuth);
app.use('/api', middleware.rateLimit());

/* --- API ----------------------------------------------------------------- */
app.get('/api/status', (req, res) => {
  res.json({
    service: 'meamus',
    version: require('../package.json').version,
    aiEnabled: config.aiEnabled,
    // The one thing an operator needs to see at a glance.
    mode: config.aiEnabled ? 'ai' : 'template',
    provider: config.llm.provider,
    model: config.aiEnabled ? config.llm.model : null,
    testMode: config.testMode,
    templates: templates.list().length,
    showcase: config.showcaseTemplate,
    quotas: config.quotas,
    billingProvider: config.billing.provider,
    plans: PLANS.map((p) => ({ id: p.id, name: p.name, price: p.price })),
    warnings: [
      ...(config.aiEnabled ? [] : ['OPENROUTER_API_KEY is not set - generation runs in template mode.']),
      ...(config.testMode ? ['TEST_MODE is on - anyone can generate without signing up.'] : []),
      ...(config.auth.secretIsEphemeral ? ['JWT_SECRET is not set - sessions reset when the server restarts.'] : [])
    ]
  });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api', require('./routes/templates.routes'));
app.use('/api', require('./routes/games.routes'));
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
    console.log(`  test mode  ${config.testMode ? 'ON - no signup required' : 'off'}`);
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
    if (db.kind === 'json' && config.env === 'production') {
      console.log('  Warning: storing to local disk in production. On an ephemeral host');
      console.log('           accounts vanish on restart - set SUPABASE_URL to fix it.');
    }
    console.log('');
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, flushing data...`);
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
