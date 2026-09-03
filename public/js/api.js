/* =============================================================================
 * App state, API client, session.
 * ========================================================================== */

export const state = {
  token: localStorage.getItem('meamus:token') || null,
  user: null,
  status: null,
  projects: [],
  projectsLoaded: false,   // false means "not fetched yet", not "empty"
  pendingBuild: null,      // a build the workspace should attach to on open

  templates: [],
  project: null,      // { game, spec, meta, messages } in the workspace
  ready: false
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = () => listeners.forEach((fn) => fn(state));

/**
 * Fetch wrapper. Throws an Error carrying `status`, `code` and the parsed
 * payload so callers can branch on `err.code` instead of matching strings.
 */
export async function api(path, { method = 'GET', body, raw = false, signal } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`/api${path}`, {
    method, headers, signal, body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return response;

  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }

  if (!response.ok) {
    const error = new Error((payload && payload.error) || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload && payload.code;
    error.payload = payload;
    // A stale token must not leave the UI in a half-signed-in state.
    if (response.status === 401 && state.token) setSession(null, null);
    throw error;
  }
  return payload;
}

export function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) localStorage.setItem('meamus:token', token);
  else localStorage.removeItem('meamus:token');
  if (!token) { state.projects = []; state.project = null; }
  emit();
}

export async function loadStatus() {
  try { state.status = await api('/status'); } catch { state.status = null; }
  return state.status;
}

/**
 * Finish a Google sign-in.
 *
 * Supabase returns the session in the URL fragment, which never reaches a
 * server - so the browser reads it, stores it, and scrubs it out of the address
 * bar before anything can screenshot or log it.
 */
export async function consumeOAuthFragment() {
  const raw = location.hash || '';
  const at = raw.indexOf('access_token=');
  if (at === -1) return null;

  const params = new URLSearchParams(raw.slice(raw.indexOf('#', 1) + 1 || 1).replace(/^\/?/, ''));
  const token = params.get('access_token');
  const refresh = params.get('refresh_token');
  const error = params.get('error_description') || params.get('error');

  // Never leave credentials in the address bar or the back button's history.
  history.replaceState(null, '', location.pathname + location.search + '#/dashboard');

  if (error) throw new Error(error);
  if (!token) return null;

  setSession(token, null);
  if (refresh) {
    try { localStorage.setItem('meamus:refresh', refresh); } catch { /* private mode */ }
  }
  await loadSession();
  return state.user;
}

export async function loadSession() {
  if (!state.token) return null;
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    return user;
  } catch {
    setSession(null, null);
    return null;
  }
}

export const auth = {
  register: (body) => api('/auth/register', { method: 'POST', body }),
  login: (body) => api('/auth/login', { method: 'POST', body }),
  methods: () => api('/auth/methods'),
  google: (redirect) => api(`/auth/oauth/google?redirect=${encodeURIComponent(redirect)}`),
  refresh: (refreshToken) => api('/auth/refresh', { method: 'POST', body: { refreshToken } })
};


export const projects = {
  list: () => api('/games'),
  get: (id) => api(`/games/${id}`),
  create: (body) => api('/generate', { method: 'POST', body }),
  // The chat endpoint routes: a question is answered, a vague request is
  // questioned back, anything else rebuilds. /modify is the direct build path.
  chat: (id, body) => api(`/games/${id}/chat`, { method: 'POST', body }),
  modify: (id, body) => api(`/games/${id}/modify`, { method: 'POST', body }),
  revert: (id) => api(`/games/${id}/revert`, { method: 'POST' }),
  patch: (id, body) => api(`/games/${id}`, { method: 'PATCH', body }),
  remove: (id) => api(`/games/${id}`, { method: 'DELETE' })
};

/**
 * The build pipeline: quote, approve, watch, stop.
 *
 * Deliberately four calls rather than one. The founder sees the price before
 * it is spent, watches the work, and can call it off - none of which is
 * possible when a build is a single blocking request.
 */
export const builds = {
  plan: (body) => api('/build/plan', { method: 'POST', body }),
  start: (planId) => api('/build/start', { method: 'POST', body: { planId } }),
  /**
   * Do the work. Long - the whole build happens inside this request.
   *
   * Nothing awaits it for the UI; progress comes from poll(). It exists as its
   * own call because the server cannot build after it has responded: on a
   * serverless host the function is frozen the moment it does, which left
   * builds dead a few seconds in and rows stuck on "building" for ever.
   */
  run: (buildId) => api(`/build/${buildId}/run`, { method: 'POST' }),
  poll: (buildId) => api(`/build/${buildId}`),
  stop: (buildId) => api(`/build/${buildId}/stop`, { method: 'POST' })
};

export const templatesApi = {
  list: () => api('/templates'),
  get: (id) => api(`/templates/${id}`)
};

export const billing = {
  plans: () => api('/billing/plans'),
  checkout: (plan) => api('/billing/checkout', { method: 'POST', body: { plan } }),
  downgrade: () => api('/billing/downgrade', { method: 'POST' })
};

/** Preview URL; the token lets the owner view their own private game. */
export const playUrl = (id) =>
  `/play/${id}${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`;

/**
 * Template preview URL.
 *
 * An iframe navigation carries no Authorization header, so the session token
 * has to ride in the query string or a gated template answers 401 to a signed-
 * in viewer.
 */
export function templatePlayUrl(id, { attract = false } = {}) {
  const params = new URLSearchParams();
  if (attract) params.set('attract', '1');
  if (state.token) params.set('token', state.token);
  const query = params.toString();
  return `/api/templates/${id}/play${query ? `?${query}` : ''}`;
}

/** Exports are authenticated, so fetch then save from a blob. */
export async function download(path) {
  const response = await api(path, { raw: true });
  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch { /* keep default */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  const match = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = match ? match[1] : 'meamus-download';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
