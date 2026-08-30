'use strict';

/**
 * Supabase (PostgREST) storage backend.
 *
 * Talks to the REST endpoint with the service-role key over plain fetch, so
 * there is no driver dependency and it works on serverless hosts where a
 * pooled TCP connection is a liability.
 *
 * The interface matches server/store/json.js exactly - the rest of the app
 * cannot tell which one is running.
 *
 * Rows are stored as { id, data } with the document in a jsonb column, which
 * keeps the schema stable while the document shape evolves. Every table has
 * RLS on and no policies, so the service-role key is the only way in.
 */

const crypto = require('crypto');

const TABLES = { users: 'meamus_users', games: 'meamus_games', uploads: 'meamus_uploads' };

class StoreError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'StoreError';
    this.status = status || 500;
  }
}

function createSupabaseStore(config) {
  const base = `${config.supabase.url.replace(/\/+$/, '')}/rest/v1`;
  const headers = {
    apikey: config.supabase.serviceKey,
    authorization: `Bearer ${config.supabase.serviceKey}`,
    'content-type': 'application/json'
  };

  // Documents are cached in memory and refreshed on write. The app reads far
  // more than it writes, and every read path is synchronous by design.
  const cache = new Map();
  let loaded = false;

  /**
   * Writes are issued without blocking the caller, so flush() has to be able
   * to wait for them. Without this a process that exits straight after a write
   * - a script, or a serverless host freezing after the response - loses it.
   */
  const inFlight = new Set();

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { ...headers, ...(options.headers || {}) }
      });
    } catch (err) {
      throw new StoreError(
        err.name === 'AbortError' ? 'Supabase timed out' : `Supabase unreachable: ${err.message}`,
        503
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new StoreError(`Supabase ${options.method || 'GET'} ${path} failed (${response.status}): ${detail.slice(0, 300)}`, 502);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /** Pull every document once at boot so reads can stay synchronous. */
  async function hydrate() {
    for (const [collection, table] of Object.entries(TABLES)) {
      const rows = await request(`/${table}?select=id,data&order=created_at.asc`);
      cache.set(collection, (rows || []).map((row) => row.data));
    }
    loaded = true;
  }

  function rows(collection) {
    if (!loaded) throw new StoreError('The store is not ready yet', 503);
    return cache.get(collection) || [];
  }

  /** Track the write so flush() can await it, and log rather than crash. */
  function write(promise, description) {
    const tracked = promise
      .catch((err) => { console.error(`[store] ${description} failed: ${err.message}`); })
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    return tracked;
  }

  return {
    kind: 'supabase',

    async init() { await hydrate(); },

    /** Re-read everything from Postgres, discarding the cache. */
    async reload() { await hydrate(); },

    id(prefix = 'id') {
      return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
    },

    all(collection) { return rows(collection).slice(); },
    find(collection, predicate) { return rows(collection).find(predicate) || null; },
    filter(collection, predicate) { return rows(collection).filter(predicate); },

    insert(collection, doc) {
      rows(collection).push(doc);
      write(request(`/${TABLES[collection]}`, {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ id: doc.id, data: doc })
      }), `insert into ${collection}`);
      return doc;
    },

    update(collection, id, patch) {
      const list = rows(collection);
      const index = list.findIndex((row) => row.id === id);
      if (index === -1) return null;
      const next = { ...list[index], ...patch, updatedAt: new Date().toISOString() };
      list[index] = next;
      write(request(`/${TABLES[collection]}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ data: next })
      }), `update ${collection}/${id}`);
      return next;
    },

    remove(collection, id) {
      const list = rows(collection);
      const index = list.findIndex((row) => row.id === id);
      if (index === -1) return false;
      list.splice(index, 1);
      write(request(`/${TABLES[collection]}?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { prefer: 'return=minimal' }
      }), `delete ${collection}/${id}`);
      return true;
    },

    /** Wait for every outstanding write. Call before exiting the process. */
    async flush() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    /** Number of writes still in the air - used by the tests. */
    get pendingWrites() { return inFlight.size; },

    /** Connectivity probe used by `npm run db:check`. */
    async ping() {
      const started = Date.now();
      await request(`/${TABLES.users}?select=id&limit=1`);
      return { ok: true, ms: Date.now() - started };
    },

    _reset() { cache.clear(); loaded = false; }
  };
}

module.exports = { createSupabaseStore, TABLES, StoreError };
