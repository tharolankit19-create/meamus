'use strict';

const express = require('express');
const templates = require('../services/templates');
const bundler = require('../services/bundler');

const router = express.Router();

router.get('/templates', (req, res) => {
  res.json({ templates: templates.list() });
});

router.get('/templates/:id', (req, res) => {
  const template = templates.get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found', code: 'not_found' });
  res.json({
    id: template.id,
    slug: template.slug,
    keywords: template.keywords,
    spec: template.spec,
    demoUrl: `/demos/${template.id}.html`
  });
});

/** Playable HTML for the template, served inline for the preview iframe. */
router.get('/templates/:id/play', (req, res) => {
  const template = templates.get(req.params.id);
  if (!template) return res.status(404).send('Template not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(bundler.bundle(template.spec));
});

module.exports = router;
