'use strict';

/**
 * Zero-dependency JSON document store with atomic writes and an in-memory
 * cache. The default backend, and fine for a demo or a few hundred users.
 *
 * It writes to local disk, so on an ephemeral or serverless host every restart
 * loses the data - which shows up as "signup stopped working". Point
 * SUPABASE_URL at a project to switch to the Postgres backend instead.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const COLLECTIONS = ['users', 'games', 'uploads'];

const cache = new Map();
const writeQueue = new Map();

function fileFor(collection) {
  return path.join(config.dataDir, `${collection}.json`);
}

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load(collection) {
  if (cache.has(collection)) return cache.get(collection);
  ensureDir();
  const file = fileFor(collection);
  let rows = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed;
    } catch (err) {
      // Corrupt file: keep a backup rather than silently losing data.
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.error(`[db] ${collection}.json unreadable, backed up to ${backup}`);
    }
  }
  cache.set(collection, rows);
  return rows;
}

/** Atomic write: tmp file + rename, coalesced so bursts write once. */
function persist(collection) {
  if (writeQueue.has(collection)) return writeQueue.get(collection);
  const promise = new Promise((resolve) => {
    setImmediate(() => {
      writeQueue.delete(collection);
      ensureDir();
      const file = fileFor(collection);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(load(collection), null, 2));
      fs.renameSync(tmp, file);
      resolve();
    });
  });
  writeQueue.set(collection, promise);
  return promise;
}

const store = {
  kind: 'json',

  // A local file survives a restart on a normal host, but on a serverless
  // platform it lives in /tmp and is discarded between invocations.
  get durable() { return !config.serverless; },

  async init() { /* files are read lazily; nothing to warm up */ },

  /** Drop the cache so the next read comes off disk. */
  async reload() { cache.clear(); },

  id(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
  },

  all(collection) {
    return load(collection).slice();
  },

  /**
   * The Supabase store re-reads one row from Postgres here, because its cache
   * is filled once at boot and another instance's writes never reach it. There
   * is one process here and the file is read on demand, so the ordinary lookup
   * is already fresh - this exists so callers do not have to know which store
   * they are talking to.
   */
  async findFresh(collection, filter) {
    const byBuild = /data->build->>buildId=eq\.([^&]+)/.exec(filter);
    if (byBuild) {
      return load(collection).find((row) => row.build && row.build.buildId === byBuild[1]) || null;
    }
    const byId = /(?:^|&)id=eq\.([^&]+)/.exec(filter);
    if (byId) return load(collection).find((row) => row.id === byId[1]) || null;
    return null;
  },

  find(collection, predicate) {
    return load(collection).find(predicate) || null;
  },

  filter(collection, predicate) {
    return load(collection).filter(predicate);
  },

  insert(collection, doc) {
    const rows = load(collection);
    rows.push(doc);
    persist(collection);
    return doc;
  },

  update(collection, id, patch) {
    const rows = load(collection);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch, updatedAt: new Date().toISOString() };
    persist(collection);
    return rows[idx];
  },

  remove(collection, id) {
    const rows = load(collection);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    persist(collection);
    return true;
  },

  /** Flush every pending write - used by tests and graceful shutdown. */
  async flush() {
    await Promise.all([...writeQueue.values()]);
  },

  async ping() {
    ensureDir();
    return { ok: true, ms: 0, dir: config.dataDir };
  },

  /** Test helper: drop the in-memory cache so files are re-read. */
  _reset() {
    cache.clear();
  }
};

// Warm the cache up-front so a missing data dir fails loudly at boot.
for (const collection of COLLECTIONS) load(collection);

module.exports = store;
