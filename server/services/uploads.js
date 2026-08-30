'use strict';

/**
 * Attachment store.
 *
 * Files arrive as data URLs inside the JSON body (no multipart parser, so no
 * extra dependency). Images are kept as files and replayed to Claude as image
 * content blocks; text files are read into the prompt as context.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const TEXT_TYPES = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'text/html': 'html',
  'text/css': 'css'
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PER_MESSAGE = 6;

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

function uploadDir() {
  const dir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Split a `data:<mime>;base64,<payload>` URL into its parts. */
function parseDataUrl(dataUrl) {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) throw new UploadError('Attachment must be a base64 data URL');
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

/**
 * @param {{name:string, dataUrl:string}} input
 * @param {string} userId
 */
function store(input, userId) {
  const name = String(input.name || 'attachment').slice(0, 120).replace(/[/\\]/g, '_');
  const { mime, buffer } = parseDataUrl(input.dataUrl);

  const isImage = Boolean(IMAGE_TYPES[mime]);
  const isText = Boolean(TEXT_TYPES[mime]);
  if (!isImage && !isText) {
    throw new UploadError(`Unsupported file type: ${mime}. Images (png, jpg, webp, gif) and text files only.`);
  }

  const limit = isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (buffer.length > limit) {
    throw new UploadError(`${name} is ${(buffer.length / 1024 / 1024).toFixed(1)} MB - the limit is ${limit / 1024 / 1024} MB`);
  }
  if (!buffer.length) throw new UploadError(`${name} is empty`);

  const id = db.id('upl');
  const ext = isImage ? IMAGE_TYPES[mime] : TEXT_TYPES[mime];
  const file = path.join(uploadDir(), `${id}.${ext}`);
  fs.writeFileSync(file, buffer);

  const record = {
    id,
    userId,
    name,
    mime,
    kind: isImage ? 'image' : 'text',
    bytes: buffer.length,
    file,
    createdAt: new Date().toISOString()
  };
  db.insert('uploads', record);
  return publicView(record);
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    mime: record.mime,
    bytes: record.bytes,
    url: `/api/uploads/${record.id}`,
    createdAt: record.createdAt
  };
}

function get(id, userId) {
  const record = db.find('uploads', (u) => u.id === id);
  if (!record) return null;
  if (userId && record.userId !== userId) return null;
  return record;
}

function read(record) {
  try {
    return fs.readFileSync(record.file);
  } catch {
    return null;
  }
}

/**
 * Resolve a list of ids into the shape the generator needs.
 * Unknown or foreign ids are dropped rather than failing the whole request.
 */
function resolve(ids, userId) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, MAX_PER_MESSAGE)) {
    const record = get(String(id), userId);
    if (!record) continue;
    const buffer = read(record);
    if (!buffer) continue;
    out.push({
      ...publicView(record),
      base64: record.kind === 'image' ? buffer.toString('base64') : null,
      text: record.kind === 'text' ? buffer.toString('utf8').slice(0, 40000) : null
    });
  }
  return out;
}

module.exports = {
  store, resolve, get, publicView, UploadError,
  MAX_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_TEXT_BYTES,
  IMAGE_TYPES, TEXT_TYPES
};
