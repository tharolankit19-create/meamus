/* =============================================================================
 * meamus - frontend
 * Hash-routed SPA, no framework, no build step.
 * ========================================================================== */

const state = {
  token: localStorage.getItem('meamus:token') || null,
  user: null,
  status: null,
  templates: [],
  games: [],
  current: null,        // { game, spec, meta }
  tab: 'preview',
  generating: false
};

/* --- tiny DOM helpers ---------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = 'ok', ms = 4200) {
  const node = el('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, ms);
}

/* --- API ----------------------------------------------------------------- */
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (raw) return response;

  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }

  if (!response.ok) {
    const error = new Error((payload && payload.error) || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload && payload.code;
    error.payload = payload;
    // An expired or invalid token should not leave the UI in a half-signed-in state.
    if (response.status === 401 && state.token) signOut(true);
    throw error;
  }
  return payload;
}

/* --- session ------------------------------------------------------------- */
function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) localStorage.setItem('meamus:token', token);
  else localStorage.removeItem('meamus:token');
  renderChrome();
}

function signOut(silent = false) {
  setSession(null, null);
  state.games = [];
  state.current = null;
  if (!silent) toast('Signed out', 'ok');
  if (location.hash.startsWith('#/library')) location.hash = '#/';
  else render();
}

async function loadSession() {
  if (!state.token) return;
  try {
    const { user } = await api('/auth/me');
    state.user = user;
  } catch {
    state.token = null;
    localStorage.removeItem('meamus:token');
  }
}

/* --- chrome -------------------------------------------------------------- */
function renderChrome() {
  const badge = $('#mode-badge');
  if (state.status) {
    const ai = state.status.aiEnabled;
    badge.className = `badge ${ai ? 'ai' : 'template'}`;
    badge.textContent = ai ? `AI · ${state.status.model}` : 'Template mode';
    badge.title = ai
      ? `Generating with ${state.status.model}`
      : 'No ANTHROPIC_API_KEY set. Prompts are matched to bundled templates.';
  }

  const account = $('#account');
  account.textContent = '';
  if (state.user) {
    // append() stringifies null, so drop the empty slots before rendering.
    account.append(...[
      el('div', { class: 'who' },
        el('strong', {}, state.user.name || state.user.email),
        `${state.user.usage}/${state.user.quota} today`),
      state.user.plan === 'pro' ? el('span', { class: 'badge pro' }, 'PRO') : null,
      el('button', { class: 'btn ghost small', onClick: () => signOut() }, 'Sign out')
    ].filter(Boolean));
  } else {
    account.append(
      el('button', { class: 'btn ghost small', onClick: () => openAuth('login') }, 'Sign in'),
      el('button', { class: 'btn primary small', onClick: () => openAuth('register') }, 'Get started')
    );
  }

  $$('[data-auth-only]').forEach((node) => { node.hidden = !state.user; });
  const route = (location.hash || '#/').split('?')[0].replace('#/', '') || 'home';
  $$('[data-nav]').forEach((node) => node.classList.toggle('active', node.dataset.nav === route));

  const footer = $('#footer-status');
  if (state.status) {
    footer.textContent = `${state.status.templates} templates · ${state.status.mode} mode · v${state.status.version}`;
  }
}

/* --- auth dialog --------------------------------------------------------- */
let authMode = 'login';

function openAuth(mode = 'login') {
  authMode = mode;
  const isRegister = mode === 'register';
  $('#auth-title').textContent = isRegister ? 'Create your account' : 'Sign in';
  $('#auth-sub').textContent = isRegister
    ? 'Free plan, no card. Your games are saved to your account.'
    : 'Welcome back.';
  $('#auth-submit').textContent = isRegister ? 'Create account' : 'Sign in';
  $('#name-field').hidden = !isRegister;
  $('#auth-switch-text').textContent = isRegister ? 'Already have an account?' : 'New here?';
  $('#auth-switch').textContent = isRegister ? 'Sign in instead' : 'Create an account';
  $('#auth-error').hidden = true;
  $('#auth-form').reset();
  $('#auth-dialog').showModal();
}

function wireAuthDialog() {
  $('#auth-switch').addEventListener('click', () => openAuth(authMode === 'login' ? 'register' : 'login'));
  $('#auth-cancel').addEventListener('click', () => $('#auth-dialog').close());

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const button = $('#auth-submit');
    const errorBox = $('#auth-error');
    button.disabled = true;
    errorBox.hidden = true;

    try {
      const payload = await api(`/auth/${authMode}`, {
        method: 'POST',
        body: {
          email: data.get('email'),
          password: data.get('password'),
          name: data.get('name') || undefined
        }
      });
      setSession(payload.token, payload.user);
      $('#auth-dialog').close();
      toast(authMode === 'register' ? 'Account created. Describe your first game.' : 'Signed in', 'ok');
      render();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

/* --- play dialog --------------------------------------------------------- */
function openPlayer(title, url) {
  $('#play-title').textContent = title;
  const frame = $('#play-frame');
  frame.src = url;
  $('#play-reload').onclick = () => { frame.src = 'about:blank'; setTimeout(() => { frame.src = url; }, 40); };
  $('#play-newtab').onclick = () => window.open(url, '_blank', 'noopener');
  $('#play-dialog').showModal();
}

function wirePlayDialog() {
  const dialog = $('#play-dialog');
  const stop = () => { $('#play-frame').src = 'about:blank'; };
  $('#play-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stop);
  // Clicking the backdrop closes the player.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}

/** Preview URL for a saved game; the token lets the owner view a private one. */
const playUrl = (gameId) => `/play/${gameId}${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`;

/* --- views --------------------------------------------------------------- */
const EXAMPLES = [
  'A space shooter where I tap to blast asteroids and collect power-ups',
  'Flappy bird clone but the bird is a paper plane dodging skyscrapers',
  'A hard retro platformer with gems, spikes and patrolling slimes',
  'Candy-crush style match-3 with cascading combos and a move limit',
  'An endless neon runner where I swipe down to slide under lasers'
];

function viewHome() {
  const view = $('#view');
  view.textContent = '';

  view.append(
    el('section', { class: 'hero' },
      el('h1', {}, 'Describe a game. Play it in seconds.'),
      el('p', { class: 'lede' },
        'meamus turns one sentence into a complete Phaser 3 game: procedural art, ' +
        'keyboard, mouse and touch controls, a full menu-to-game-over loop, and an ' +
        'Android project you can build.')
    )
  );

  const textarea = el('textarea', {
    id: 'prompt',
    placeholder: 'Make a space shooter where I tap to blast asteroids and collect power-ups...',
    maxlength: '2000'
  });

  const button = el('button', { class: 'btn primary', id: 'go' }, 'Generate game');
  const progress = el('div', { class: 'progress', hidden: true },
    el('div', { class: 'progress-bar' }, el('i')),
    el('div', { class: 'progress-note' }, ''));

  button.addEventListener('click', () => generate(textarea.value, progress, button));
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') generate(textarea.value, progress, button);
  });

  const chips = el('div', { class: 'chiprow' },
    EXAMPLES.map((example) => el('button', {
      class: 'chip',
      onClick: () => { textarea.value = example; textarea.focus(); }
    }, example.length > 52 ? `${example.slice(0, 52)}…` : example)));

  view.append(
    el('section', { class: 'card composer' },
      el('label', { class: 'field' }, el('span', {}, 'Your game idea'), textarea),
      chips,
      el('div', { class: 'row' },
        button,
        el('span', { class: 'muted small' }, 'Ctrl/Cmd + Enter to generate')),
      progress)
  );

  if (state.status && !state.status.aiEnabled) {
    view.append(el('div', { class: 'notice', style: 'margin-top:18px' },
      el('strong', {}, 'Template mode. '),
      'No ANTHROPIC_API_KEY is configured, so prompts are matched to the bundled ' +
      'templates instead of generating original code. Everything else - accounts, ' +
      'quotas, library, preview, HTML export, APK export - works exactly as it will ' +
      'with a key. Add the key to .env and restart to switch on AI generation.'));
  }

  if (state.current) view.append(renderResult(state.current));
}

async function generate(prompt, progress, button) {
  if (state.generating) return;
  prompt = String(prompt || '').trim();

  if (!state.user) { openAuth('register'); return; }
  if (prompt.length < 4) { toast('Describe the game you want first', 'warn'); return; }

  state.generating = true;
  button.disabled = true;
  button.textContent = '';
  button.append(el('span', { class: 'spinner' }), 'Generating…');
  progress.hidden = false;

  // The bar is an honest progress *estimate*: generation is one long call,
  // so we pace the steps against a typical duration and hold at 92%.
  const steps = [
    'Parsing your prompt…',
    'Choosing mechanics and physics…',
    'Writing scenes and game loop…',
    'Baking procedural sprites…',
    'Wiring touch controls and ad hooks…',
    'Validating the generated code…'
  ];
  let step = 0;
  const bar = $('i', progress);
  const note = $('.progress-note', progress);
  note.textContent = steps[0];
  const ticker = setInterval(() => {
    step = Math.min(step + 1, steps.length - 1);
    note.textContent = steps[step];
    bar.style.width = `${Math.min(92, 12 + step * 15)}%`;
  }, 2600);

  try {
    const result = await api('/generate', { method: 'POST', body: { prompt } });
    bar.style.width = '100%';
    note.textContent = 'Done.';
    state.current = result;
    state.user.usage = result.quota.used;
    renderChrome();

    if (result.meta.mode === 'template') {
      toast(`Built from the ${result.meta.templateId} template (template mode).`, 'warn', 6000);
    } else {
      toast(`Generated "${result.spec.gameConfig.title}"`, 'ok');
    }
    render();
    setTimeout(() => $('#result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  } catch (err) {
    note.textContent = '';
    progress.hidden = true;
    if (err.code === 'quota_exceeded') toast(`${err.message}`, 'err', 7000);
    else toast(err.message, 'err', 7000);
  } finally {
    clearInterval(ticker);
    state.generating = false;
    button.disabled = false;
    button.textContent = 'Generate game';
  }
}

/* --- result panel -------------------------------------------------------- */
function renderResult(result) {
  const { game, spec, meta } = result;
  const tabs = ['preview', 'code', 'assets', 'mechanics', 'shipping'];

  const body = el('div', { id: 'result-body' });

  const section = el('section', { class: 'card', id: 'result', style: 'margin-top:24px' },
    el('div', { class: 'spread' },
      el('div', {},
        el('h2', {}, spec.gameConfig.title),
        el('div', { class: 'meta row' },
          el('span', { class: 'tag' }, spec.gameConfig.genre),
          el('span', { class: 'tag plain' }, spec.gameConfig.difficulty),
          el('span', { class: 'tag plain' }, spec.gameConfig.estimatedPlayTime),
          el('span', { class: `tag ${meta.mode === 'ai' ? 'good' : 'warn'}` },
            meta.mode === 'ai' ? `ai · ${meta.model || ''}` : `template · ${meta.templateId}`))),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', onClick: () => openPlayer(spec.gameConfig.title, playUrl(game.id)) }, '▶ Play'),
        el('button', { class: 'btn', onClick: () => download(`/games/${game.id}/export/html`) }, 'Download HTML'),
        el('button', { class: 'btn', onClick: () => exportApk(game.id) }, 'Export APK'))),
    el('p', { class: 'muted', style: 'margin-top:12px' }, spec.gameConfig.description),
    meta.issues && meta.issues.length
      ? el('div', { class: 'notice', style: 'margin-bottom:14px' },
        el('strong', {}, 'Notes: '), meta.issues.join(' · '))
      : null,
    el('div', { class: 'tabs' },
      tabs.map((tab) => el('button', {
        class: `tab ${state.tab === tab ? 'active' : ''}`,
        onClick: (event) => {
          state.tab = tab;
          $$('.tab', section).forEach((t) => t.classList.remove('active'));
          event.target.classList.add('active');
          body.textContent = '';
          body.append(renderTab(tab, result));
        }
      }, tab[0].toUpperCase() + tab.slice(1)))),
    body,
    el('div', { class: 'row', style: 'margin-top:18px' },
      renderModifyBox(game)));

  body.append(renderTab(state.tab, result));
  return section;
}

function renderTab(tab, { game, spec, meta }) {
  if (tab === 'preview') {
    const wrap = el('div', { class: 'play-frame-wrap', style: 'aspect-ratio:4/3;max-height:58vh' });
    wrap.append(el('iframe', {
      src: playUrl(game.id),
      title: 'Game preview',
      sandbox: 'allow-scripts allow-same-origin allow-pointer-lock',
      style: 'width:100%;height:100%;border:0;display:block'
    }));
    return el('div', {}, wrap,
      el('p', { class: 'muted small', style: 'margin-top:10px' },
        'Click inside the frame first so it takes keyboard input. ',
        el('button', { class: 'linkbtn', onClick: () => openPlayer(spec.gameConfig.title, playUrl(game.id)) }, 'Open the larger player'),
        '.'));
  }

  if (tab === 'code') {
    const lines = spec.gameCode.javascript.split('\n').length;
    return el('div', {},
      el('div', { class: 'spread', style: 'margin-bottom:10px' },
        el('span', { class: 'muted small mono' }, `${lines} lines · Phaser ${spec.runtime.phaserVersion}${spec.runtime.kit ? ' · uses the meamus kit' : ''}`),
        el('div', { class: 'row' },
          el('button', {
            class: 'btn small',
            onClick: async (event) => {
              await navigator.clipboard.writeText(spec.gameCode.javascript);
              event.target.textContent = 'Copied';
              setTimeout(() => { event.target.textContent = 'Copy JS'; }, 1400);
            }
          }, 'Copy JS'),
          el('button', { class: 'btn small', onClick: () => download(`/games/${game.id}/export/spec`) }, 'Download spec.json'))),
      el('pre', { class: 'code' }, spec.gameCode.javascript));
  }

  if (tab === 'assets') {
    return el('div', { class: 'grid cols-2' },
      el('div', {},
        el('h3', {}, `Sprites (${spec.assets.sprites.length})`),
        el('p', { class: 'muted small' }, 'Every sprite is procedural in the running game. These descriptions are the prompts for an image pipeline that replaces them.'),
        el('div', { class: 'stack' }, spec.assets.sprites.map((sprite) => el('div', { class: 'card', style: 'padding:13px' },
          el('div', { class: 'row', style: 'gap:8px' },
            el('strong', {}, sprite.name),
            el('span', { class: 'tag plain' }, sprite.type),
            el('span', { class: 'tag plain' }, sprite.size),
            el('span', { class: 'tag plain' }, sprite.style)),
          el('p', { class: 'muted small', style: 'margin:8px 0 0' }, sprite.description))))),
      el('div', {},
        el('h3', {}, `Audio (${spec.assets.audio.length})`),
        el('p', { class: 'muted small' }, 'Sound effects are synthesised with the Web Audio API. These are the briefs for replacing them with real audio.'),
        el('div', { class: 'stack' }, spec.assets.audio.map((sound) => el('div', { class: 'card', style: 'padding:13px' },
          el('div', { class: 'row', style: 'gap:8px' },
            el('strong', {}, sound.name),
            el('span', { class: 'tag plain' }, sound.type)),
          el('p', { class: 'muted small', style: 'margin:8px 0 0' }, sound.description))))));
  }

  if (tab === 'mechanics') {
    return el('div', { class: 'grid cols-2' },
      el('div', {},
        el('h3', {}, 'Mechanics'),
        el('div', { class: 'stack' }, spec.mechanics.map((m) => el('div', { class: 'card', style: 'padding:13px' },
          el('strong', {}, m.name),
          el('p', { class: 'muted small', style: 'margin:6px 0 0' }, m.description),
          m.implementation ? el('p', { class: 'small mono', style: 'margin:8px 0 0;color:#8b96ff' }, m.implementation) : null))),
        !spec.mechanics.length ? el('p', { class: 'muted' }, 'No mechanics documented.') : null),
      el('div', {},
        el('h3', {}, 'Controls'),
        el('dl', { class: 'deflist' },
          el('dt', {}, 'Keyboard'), el('dd', {}, spec.controls.keyboard.join(' · ') || '—'),
          el('dt', {}, 'Touch'), el('dd', {}, spec.controls.touch.join(' · ') || '—'),
          el('dt', {}, 'Mouse'), el('dd', {}, spec.controls.mouse.join(' · ') || '—')),
        el('h3', { style: 'margin-top:22px' }, 'Mobile optimisations'),
        el('ul', { class: 'ticks' }, spec.mobileOptimizations.map((o) => el('li', {}, o)))));
  }

  // shipping
  return el('div', { class: 'grid cols-2' },
    el('div', {},
      el('h3', {}, 'Monetization hooks'),
      el('ul', { class: 'ticks' }, spec.monetizationHooks.map((h) => el('li', {}, h))),
      el('p', { class: 'muted small' },
        'These are live call sites in the code (MEAMUS.ads.showBanner / showInterstitial / showRewarded). ' +
        'Point them at your ad network and set MEAMUS.ads.enabled = true.')),
    el('div', {},
      el('h3', {}, 'Android export'),
      el('p', { class: 'muted small' },
        'The APK export is a complete Cordova project: the game is already in www/index.html, ' +
        'config.xml is filled in, and build.sh runs the Gradle build. No code changes needed.'),
      el('dl', { class: 'deflist' },
        el('dt', {}, 'apkReady'), el('dd', { class: 'mono' }, String(spec.apkReady)),
        el('dt', {}, 'Plan'), el('dd', {}, state.user && state.user.plan === 'pro' ? 'Pro — unlocked' : 'Pro required'),
        el('dt', {}, 'Target'), el('dd', {}, 'Android API 34, min 24')),
      el('button', { class: 'btn primary', style: 'margin-top:14px', onClick: () => exportApk(game.id) }, 'Export APK project')));
}

function renderModifyBox(game) {
  const input = el('input', { type: 'text', placeholder: 'e.g. "add a boss fight every 5 waves" or "make it harder"' });
  const button = el('button', { class: 'btn' }, 'Apply change');

  const run = async () => {
    const instruction = input.value.trim();
    if (instruction.length < 3) { toast('Describe the change first', 'warn'); return; }
    button.disabled = true;
    button.textContent = 'Applying…';
    try {
      const result = await api(`/games/${game.id}/modify`, { method: 'POST', body: { instruction } });
      state.current = result;
      state.user.usage = result.quota.used;
      toast('Game updated', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err', 7000);
    } finally {
      button.disabled = false;
      button.textContent = 'Apply change';
    }
  };

  button.addEventListener('click', run);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });

  return el('div', { style: 'width:100%' },
    el('h3', {}, 'Iterate'),
    el('div', { class: 'row' },
      el('div', { style: 'flex:1;min-width:240px' }, input),
      button),
    el('p', { class: 'muted small', style: 'margin-top:8px' },
      'Changes are applied by the model and count against your daily quota. Previous versions are kept so you can revert.'));
}

/* --- library ------------------------------------------------------------- */
async function viewLibrary() {
  const view = $('#view');
  view.textContent = '';

  if (!state.user) {
    view.append(el('div', { class: 'empty' },
      el('h2', {}, 'Sign in to see your library'),
      el('button', { class: 'btn primary', onClick: () => openAuth('login') }, 'Sign in')));
    return;
  }

  view.append(el('div', { class: 'spread' },
    el('h1', {}, 'Your games'),
    el('a', { class: 'btn primary', href: '#/' }, 'New game')));

  const list = el('div', { class: 'grid cols-3', style: 'margin-top:20px' },
    el('p', { class: 'muted' }, 'Loading…'));
  view.append(list);

  try {
    const { games } = await api('/games');
    state.games = games;
    list.textContent = '';

    if (!games.length) {
      list.append(el('div', { class: 'empty' },
        el('h2', {}, 'Nothing here yet'),
        el('p', { class: 'muted' }, 'Describe a game on the Create tab and it lands here.'),
        el('a', { class: 'btn primary', href: '#/' }, 'Create your first game')));
      return;
    }

    for (const game of games) list.append(renderGameCard(game));
  } catch (err) {
    list.textContent = '';
    list.append(el('p', { class: 'form-error' }, err.message));
  }
}

function renderGameCard(game) {
  return el('article', { class: 'card gamecard' },
    el('h3', {}, game.title),
    el('div', { class: 'meta' },
      el('span', { class: 'tag' }, game.genre),
      el('span', { class: 'tag plain' }, game.difficulty),
      el('span', { class: `tag ${game.mode === 'ai' ? 'good' : 'warn'}` }, game.mode),
      game.versionCount > 1 ? el('span', { class: 'tag plain' }, `v${game.versionCount}`) : null),
    el('p', { class: 'desc' }, game.description),
    el('p', { class: 'muted small mono' },
      `${game.codeLines} lines · ${game.spriteCount} sprites · ${new Date(game.createdAt).toLocaleDateString()}`),
    el('div', { class: 'actions' },
      el('button', { class: 'btn primary small', onClick: () => openPlayer(game.title, playUrl(game.id)) }, '▶ Play'),
      el('button', {
        class: 'btn small',
        onClick: async () => {
          try {
            const result = await api(`/games/${game.id}`);
            state.current = { game: result.game, spec: result.spec, meta: result.meta };
            location.hash = '#/';
          } catch (err) { toast(err.message, 'err'); }
        }
      }, 'Open'),
      el('button', { class: 'btn small', onClick: () => download(`/games/${game.id}/export/html`) }, 'HTML'),
      el('button', { class: 'btn small', onClick: () => exportApk(game.id) }, 'APK'),
      el('button', {
        class: 'btn danger small',
        onClick: async (event) => {
          if (!confirm(`Delete "${game.title}"? This cannot be undone.`)) return;
          try {
            await api(`/games/${game.id}`, { method: 'DELETE' });
            event.target.closest('article').remove();
            if (state.current && state.current.game.id === game.id) state.current = null;
            toast('Deleted', 'ok');
          } catch (err) { toast(err.message, 'err'); }
        }
      }, 'Delete')));
}

/* --- templates ----------------------------------------------------------- */
async function viewTemplates() {
  const view = $('#view');
  view.textContent = '';
  view.append(
    el('h1', {}, 'Demo templates'),
    el('p', { class: 'lede muted' },
      'Four complete, playable games that ship with meamus. Each one is the reference ' +
      'implementation for its genre: five scenes, pooled sprites, touch controls, ' +
      'ad hooks and localStorage persistence. In template mode your prompt is matched ' +
      'against these.'));

  const list = el('div', { class: 'grid cols-2', style: 'margin-top:22px' }, el('p', { class: 'muted' }, 'Loading…'));
  view.append(list);

  try {
    const { templates } = await api('/templates');
    state.templates = templates;
    list.textContent = '';
    for (const template of templates) {
      list.append(el('article', { class: 'card gamecard' },
        el('h3', {}, template.gameConfig.title),
        el('div', { class: 'meta' },
          el('span', { class: 'tag' }, template.gameConfig.genre),
          el('span', { class: 'tag plain' }, template.gameConfig.difficulty),
          el('span', { class: 'tag plain' }, `${template.mechanics.length} mechanics`),
          el('span', { class: 'tag plain' }, `${template.spriteCount} sprites`)),
        el('p', { class: 'desc' }, template.gameConfig.description),
        el('details', {},
          el('summary', { class: 'muted small', style: 'cursor:pointer' }, 'Mechanics'),
          el('ul', { class: 'ticks', style: 'margin-top:10px' },
            template.mechanics.map((m) => el('li', {}, el('strong', {}, `${m.name}. `), m.description)))),
        el('div', { class: 'actions' },
          el('button', {
            class: 'btn primary small',
            onClick: () => openPlayer(template.gameConfig.title, `/api/templates/${template.id}/play`)
          }, '▶ Play'),
          el('a', { class: 'btn small', href: template.demoUrl, target: '_blank', rel: 'noopener' }, 'Open in a tab'),
          el('button', {
            class: 'btn small',
            onClick: () => {
              location.hash = '#/';
              setTimeout(() => {
                const box = $('#prompt');
                if (box) {
                  box.value = `A ${template.gameConfig.genre} like ${template.gameConfig.title}: ${template.gameConfig.description}`;
                  box.focus();
                }
              }, 40);
            }
          }, 'Use as a starting point'))));
    }
  } catch (err) {
    list.textContent = '';
    list.append(el('p', { class: 'form-error' }, err.message));
  }
}

/* --- pricing ------------------------------------------------------------- */
async function viewPricing() {
  const view = $('#view');
  view.textContent = '';
  view.append(
    el('h1', {}, 'Pricing'),
    el('p', { class: 'lede muted' }, 'Generate for free. Pay when you want to ship to the Play Store.'));

  const list = el('div', { class: 'grid cols-2', style: 'margin-top:24px' }, el('p', { class: 'muted' }, 'Loading…'));
  view.append(list);

  try {
    const { plans, provider } = await api('/billing/plans');
    list.textContent = '';
    for (const plan of plans) {
      const isCurrent = state.user && state.user.plan === plan.id;
      list.append(el('article', { class: `card plan ${plan.id === 'pro' ? 'featured' : ''}` },
        el('h2', {}, plan.name),
        el('div', { class: 'price' }, plan.price === 0 ? 'Free' : `$${plan.price}`,
          plan.price ? el('small', {}, ` / ${plan.interval}`) : null),
        el('ul', { class: 'ticks' }, plan.features.map((f) => el('li', {}, f))),
        isCurrent
          ? el('button', { class: 'btn', disabled: true }, 'Current plan')
          : el('button', {
            class: `btn ${plan.id === 'pro' ? 'primary' : ''}`,
            onClick: () => changePlan(plan.id)
          }, plan.id === 'pro' ? 'Upgrade to Pro' : 'Switch to Free')));
    }

    if (provider === 'stub') {
      view.append(el('div', { class: 'notice info', style: 'margin-top:20px' },
        el('strong', {}, 'Stub billing is active. '),
        'Upgrades apply instantly with no payment so the Pro features (APK export, ' +
        'higher quota) are testable end to end. Set BILLING_PROVIDER=stripe and follow ' +
        'docs/BILLING.md to take real money.'));
    }
  } catch (err) {
    list.textContent = '';
    list.append(el('p', { class: 'form-error' }, err.message));
  }
}

async function changePlan(planId) {
  if (!state.user) { openAuth('register'); return; }
  try {
    const payload = planId === 'free'
      ? await api('/billing/downgrade', { method: 'POST' })
      : await api('/billing/checkout', { method: 'POST', body: { plan: planId } });

    if (payload.checkoutUrl) { location.href = payload.checkoutUrl; return; }
    state.user = payload.user;
    renderChrome();
    toast(planId === 'pro' ? 'Upgraded to Pro. APK export is unlocked.' : 'Switched to the Free plan.', 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err', 7000);
  }
}

/* --- downloads ----------------------------------------------------------- */
/* Exports are authenticated, so they are fetched then saved from a blob
   rather than linked directly. */
async function download(path) {
  try {
    const response = await api(path, { raw: true });
    if (!response.ok) {
      let message = `Download failed (${response.status})`;
      try { message = (await response.json()).error || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: match ? match[1] : 'meamus-download' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Download started', 'ok');
  } catch (err) {
    toast(err.message, 'err', 7000);
  }
}

async function exportApk(gameId) {
  if (!state.user) { openAuth('register'); return; }
  if (state.user.plan !== 'pro') {
    toast('APK export needs the Pro plan.', 'warn', 6000);
    location.hash = '#/pricing';
    return;
  }
  await download(`/games/${gameId}/export/apk`);
}

/* --- router -------------------------------------------------------------- */
function render() {
  renderChrome();
  const route = (location.hash || '#/').split('?')[0];
  if (route.startsWith('#/library')) viewLibrary();
  else if (route.startsWith('#/templates')) viewTemplates();
  else if (route.startsWith('#/pricing')) viewPricing();
  else viewHome();
  window.scrollTo({ top: 0 });
}

/* --- boot ---------------------------------------------------------------- */
(async function boot() {
  wireAuthDialog();
  wirePlayDialog();
  window.addEventListener('hashchange', render);

  try {
    state.status = await api('/status');
  } catch {
    toast('Could not reach the meamus API.', 'err', 8000);
  }
  await loadSession();
  render();
})();
