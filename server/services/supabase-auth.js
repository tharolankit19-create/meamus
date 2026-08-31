'use strict';

/**
 * Real accounts, on Supabase Auth.
 *
 * meamus does not store passwords any more. Supabase owns identity - the
 * password hash, the email confirmation state, the Google identity link - and
 * meamus owns the profile row hanging off it (credits, plan, name).
 *
 * Email and password are proxied through this server so the browser never
 * needs a Supabase key. Google is a redirect: the browser goes to Supabase,
 * Supabase talks to Google, and the browser comes back with a token in the URL
 * fragment. That fragment never reaches a server, which is the point.
 */

const config = require('./../config');

class AuthError extends Error {
  constructor(message, status = 400, code = 'auth_failed') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

const base = () => `${config.supabase.url}/auth/v1`;

function headers(extra = {}) {
  return {
    apikey: config.supabase.serviceKey,
    Authorization: `Bearer ${config.supabase.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

/** Supabase phrases some failures for developers. These are for players. */
function readable(status, payload) {
  const raw = String(
    (payload && (payload.error_description || payload.msg || payload.message || payload.error)) || ''
  );
  if (/already registered|already been registered/i.test(raw)) {
    return new AuthError('That email already has an account. Sign in instead.', 409, 'email_taken');
  }
  if (/invalid login credentials/i.test(raw)) {
    return new AuthError('That email and password do not match.', 401, 'bad_credentials');
  }
  if (/email not confirmed/i.test(raw)) {
    return new AuthError('Check your inbox and confirm your email first.', 403, 'email_unconfirmed');
  }
  if (/password/i.test(raw) && /least|short|weak/i.test(raw)) {
    return new AuthError('Use a password of at least 8 characters.', 400, 'weak_password');
  }
  if (/rate limit|too many/i.test(raw)) {
    return new AuthError('Too many attempts. Wait a minute and try again.', 429, 'rate_limited');
  }
  return new AuthError(raw || `Sign-in failed (${status})`, status >= 500 ? 502 : 400, 'auth_failed');
}

async function call(path, { method = 'POST', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${base()}${path}`, {
      method,
      headers: headers(token ? { Authorization: `Bearer ${token}` } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    throw new AuthError(
      err.name === 'AbortError' ? 'The sign-in service timed out.' : `Cannot reach the sign-in service: ${err.message}`,
      503, 'auth_unreachable'
    );
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw readable(response.status, payload);
  return payload;
}

/* --- the four operations the app needs ------------------------------------ */

/**
 * Create an account. Whether a session comes back depends on the project's
 * email-confirmation setting, so the caller must handle both.
 */
async function signUp({ email, password, name }) {
  const payload = await call('/signup', {
    body: { email, password, data: { name: name || String(email).split('@')[0] } }
  });
  return {
    user: payload.user || payload,
    session: payload.access_token ? payload : (payload.session || null)
  };
}

async function signIn({ email, password }) {
  const payload = await call('/token?grant_type=password', { body: { email, password } });
  return { user: payload.user, session: payload };
}

async function refresh(refreshToken) {
  const payload = await call('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  return { user: payload.user, session: payload };
}

/**
 * Verify an access token by asking Supabase who it belongs to.
 *
 * Returns null for anything that is not a valid session. A malformed token
 * comes back as a 400 rather than a 401, so rejecting only on 401/403 turned
 * a garbage Authorization header into a server error instead of "signed out".
 * Only a genuine outage - a 5xx, or an unreachable service - is rethrown.
 */
async function getUser(accessToken) {
  if (!accessToken) return null;
  try {
    return await call('/user', { method: 'GET', token: accessToken });
  } catch (err) {
    if (err.status >= 500 || err.code === 'auth_unreachable') throw err;
    return null;
  }
}

/**
 * Where to send the browser for Google sign-in.
 *
 * Supabase handles the whole OAuth dance and returns to `redirectTo` with the
 * session in the URL fragment.
 */
function oauthUrl(provider, redirectTo) {
  const params = new URLSearchParams({ provider });
  if (redirectTo) params.set('redirect_to', redirectTo);
  return `${base()}/authorize?${params.toString()}`;
}

module.exports = { signUp, signIn, refresh, getUser, oauthUrl, AuthError };
