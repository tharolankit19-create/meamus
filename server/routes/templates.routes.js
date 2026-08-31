'use strict';

const express = require('express');
const config = require('../config');
const access = require('../access');
const templates = require('../services/templates');
const bundler = require('../services/bundler');
const { requireAuth } = require('../middleware');

const router = express.Router();

/**
 * Whether this caller may play this template. With TEMPLATE_ACCESS=open (the
 * default) everything plays for everyone; gated keeps the library behind an
 * account, apart from the showcase that runs the landing page's demo loop.
 */
function isPlayable(req, id) {
  if (access.templateAccess() === 'open') return true;
  return Boolean(req.user) || id === config.showcaseTemplate;
}

/**
 * Catalogue. Public, but signed-out callers get metadata only - enough to
 * render the marketing page, not enough to play.
 */
router.get('/templates', (req, res) => {
  const list = templates.list().map((template) => ({
    ...template,
    showcase: template.id === config.showcaseTemplate,
    playable: isPlayable(req, template.id)
  }));
  res.json({
    templates: list,
    showcase: config.showcaseTemplate,
    gated: access.templateAccess() !== 'open' && !req.user
  });
});

router.get('/templates/:id', (req, res) => {
  const template = templates.get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found', code: 'not_found' });
  res.json({
    id: template.id,
    slug: template.slug,
    keywords: template.keywords,
    spec: template.spec,
    showcase: template.id === config.showcaseTemplate,
    playUrl: `/api/templates/${template.id}/play`
  });
});

/**
 * Playable HTML.
 *
 * The showcase template is open to everyone - it is the demo on the landing
 * page. Every other template needs an account, which is the point of the
 * library. `?attract=1` starts the game in its self-playing loop.
 */
router.get('/templates/:id/play', (req, res) => {
  const template = templates.get(req.params.id);
  if (!template) return res.status(404).send('Template not found');

  if (!isPlayable(req, template.id)) {
    return res.status(401).send(signInWall(template));
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(bundler.bundle(template.spec));
});

/**
 * Rendered inside the preview iframe when a signed-out visitor opens a gated
 * template, so the frame explains itself instead of showing a bare 401.
 */
function signInWall(template) {
  const title = bundler.escapeHtml(template.spec.gameConfig.title);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - sign in to play</title>
<style>
  html,body{margin:0;height:100%;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
    background:#faf9f7;color:#16150f;display:grid;place-items:center;text-align:center}
  .box{padding:28px;max-width:340px}
  .mark{width:44px;height:44px;border-radius:12px;margin:0 auto 16px;display:grid;place-items:center;
    background:linear-gradient(140deg,#ff8a3d,#f1600d);color:#fff;font-size:20px}
  h1{font-size:18px;margin:0 0 8px;letter-spacing:-.02em}
  p{color:#57534e;font-size:14px;margin:0 0 18px}
  button{font:inherit;font-weight:600;font-size:14px;padding:10px 18px;border:0;border-radius:9px;
    background:#f1600d;color:#fff;cursor:pointer}
  button:hover{background:#d95309}
</style></head>
<body><div class="box">
  <div class="mark">&#9654;</div>
  <h1>${title}</h1>
  <p>Create a free account to play the full template library and remix any of them into your own game.</p>
  <button type="button" onclick="parent.postMessage({ type: 'meamus:signin' }, '*')">Sign up free</button>
</div></body></html>`;
}

module.exports = router;
