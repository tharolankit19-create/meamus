'use strict';

const express = require('express');
const uploads = require('../services/uploads');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

/** Accepts one or many `{ name, dataUrl }` entries in a single request. */
router.post('/uploads', requireAuth, asyncRoute(async (req, res) => {
  const incoming = Array.isArray(req.body.files) ? req.body.files : [req.body];
  if (!incoming.length || incoming.length > uploads.MAX_PER_MESSAGE) {
    return res.status(400).json({
      error: `Attach between 1 and ${uploads.MAX_PER_MESSAGE} files`,
      code: 'bad_attachment_count'
    });
  }

  const stored = [];
  for (const file of incoming) stored.push(uploads.store(file, req.user.id));
  res.status(201).json({ files: stored });
}));

/** Serves an attachment back to its owner (used for chat thumbnails). */
router.get('/uploads/:id', requireAuth, (req, res) => {
  const record = uploads.get(req.params.id, req.user.id);
  if (!record) return res.status(404).json({ error: 'Attachment not found', code: 'not_found' });
  res.set('Content-Type', record.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(record.file);
});

module.exports = router;
