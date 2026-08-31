'use strict';

/**
 * The account record meamus owns.
 *
 * With Supabase Auth on, identity lives in auth.users and this is the profiles
 * row hanging off it: credits, plan, display name. With it off - a fresh clone,
 * the offline test suite - the same shape is served from the local store, so
 * every caller reads and writes a profile without caring which is underneath.
 */

const config = require('./config');
const db = require('./db');

const usingSupabaseAuth = () => config.auth.provider === 'supabase';

const REST = () => `${config.supabase.url}/rest/v1/profiles`;
const restHeaders = (extra = {}) => ({
  apikey: config.supabase.serviceKey,
  Authorization: `Bearer ${config.supabase.serviceKey}`,
  'Content-Type': 'application/json',
  ...extra
});

/** Normalise either backing store into one shape. */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    name: row.name || (row.email ? String(row.email).split('@')[0] : 'Player'),
    plan: row.plan || 'free',
    credits: Number.isFinite(row.credits) ? row.credits : config.credits.signupGrant,
    usage: row.usage || { date: null, count: 0 },
    billing: row.billing || null,
    createdAt: row.created_at || row.createdAt || null
  };
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = String((body && (body.message || body.hint)) || '');
      // The one failure an operator will actually hit: the migration has not
      // been run. Say that, rather than relaying PostgREST's schema-cache
      // wording, which reads like a bug in the app.
      if (res.status === 404 || /could not find the table/i.test(message)) {
        const err = new Error(
          'The profiles table does not exist yet. Run supabase/profiles.sql in the '
          + 'Supabase SQL editor (Dashboard -> SQL Editor -> New query), then try again.'
        );
        err.status = 503;
        err.code = 'profiles_missing';
        throw err;
      }
      const err = new Error(`profiles ${res.status}${message ? `: ${message}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The profile for a verified auth user, created if the database trigger has
 * not run yet. Google sign-in never touches our signup endpoint, so the row
 * has to be able to appear on first sight of the account either way.
 */
async function ensure(authUser) {
  if (!usingSupabaseAuth()) {
    const existing = db.find('users', (u) => u.id === authUser.id);
    if (existing) return shape(existing);
    return shape(db.insert('users', {
      id: authUser.id,
      email: authUser.email,
      name: authUser.name || String(authUser.email || 'player').split('@')[0],
      plan: 'free',
      credits: config.credits.signupGrant,
      usage: { date: null, count: 0 },
      createdAt: new Date().toISOString()
    }));
  }

  const rows = await fetchJson(`${REST()}?id=eq.${encodeURIComponent(authUser.id)}&select=*`, {
    headers: restHeaders()
  });
  if (Array.isArray(rows) && rows.length) return shape(rows[0]);

  const meta = authUser.user_metadata || {};
  const created = await fetchJson(`${REST()}?on_conflict=id`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify([{
      id: authUser.id,
      email: authUser.email || null,
      name: meta.name || meta.full_name || String(authUser.email || 'player').split('@')[0]
    }])
  });
  return shape(Array.isArray(created) ? created[0] : created);
}

/** Server-side writes only. Credits and plan are revoked from the client. */
async function update(id, patch) {
  if (!usingSupabaseAuth()) {
    return shape(db.update('users', id, patch));
  }
  const rows = await fetchJson(`${REST()}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch)
  });
  return shape(Array.isArray(rows) ? rows[0] : rows);
}

async function get(id) {
  if (!usingSupabaseAuth()) return shape(db.find('users', (u) => u.id === id));
  const rows = await fetchJson(`${REST()}?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: restHeaders()
  });
  return Array.isArray(rows) && rows.length ? shape(rows[0]) : null;
}

module.exports = { ensure, update, get, shape, usingSupabaseAuth };
