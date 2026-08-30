/* =============================================================================
 * Router + boot.
 * ========================================================================== */

import { $, el, clear, icon, toast } from './ui.js';
import { state, loadStatus, loadSession, onChange, projects, ensureGuestSession } from './api.js';
import { renderLanding } from './landing.js';
import { renderDashboard, renderTemplatesPage, renderPricing, sidebar } from './dashboard.js';
import { renderWorkspace } from './workspace.js';
import { openAuth } from './auth-dialog.js';

const root = () => $('#root');

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = hash.split('/');
  return { name: head || '', params: rest };
}

async function render() {
  const { name, params } = parseRoute();
  const host = clear(root());
  document.body.classList.toggle('workspace-route', name === 'project');

  // A guest is signed in but has not committed to anything, so the landing
  // page - with its prompt box - stays their home rather than the dashboard.
  const browsing = !state.user || state.user.isGuest;

  if (browsing && (name === '' || name === 'home')) {
    renderLanding(host);
    return;
  }

  if (!state.user) {
    if (name === 'templates' || name === 'pricing' || name === 'docs') {
      renderLanding(host);
      setTimeout(() => document.querySelector('.section.warm')?.scrollIntoView({ behavior: 'smooth' }), 80);
      return;
    }
    if (name === 'project') {
      renderLanding(host);
      const user = await openAuth('login');
      if (user) render();
      return;
    }
    renderLanding(host);
    return;
  }

  switch (name) {
    case 'project':
      if (!params[0]) { location.hash = '#/dashboard'; return; }
      await renderWorkspace(host, params[0]);
      return;
    case 'templates':
      renderTemplatesPage(host);
      return;
    case 'pricing':
      await renderPricing(host);
      return;
    case 'account':
      renderAccount(host);
      return;
    case '':
      location.hash = '#/dashboard';
      return;
    default:
      renderDashboard(host);
  }
}

function renderAccount(host) {
  const main = el('main', { class: 'main', style: { maxWidth: '620px' } });
  host.append(el('div', { class: 'app' }, sidebar('account'), main));
  const user = state.user;
  main.append(
    el('h1', { class: 'greet' }, 'Account'),
    el('div', { class: 'card' },
      el('div', { class: 'row', style: { gap: '12px', marginBottom: '18px' } },
        el('span', { class: 'avatar lg' }, (user.name || user.email).charAt(0).toUpperCase()),
        el('div', {},
          el('div', { style: { fontWeight: '600' } }, user.name || '—'),
          el('div', { class: 'faint small' }, user.email))),
      el('dl', { class: 'deflist' },
        el('dt', {}, 'Plan'), el('dd', {}, el('span', { class: `tag ${user.plan === 'pro' ? 'orange' : ''}` }, user.plan)),
        el('dt', {}, 'Today'), el('dd', {}, `${user.usage} of ${user.quota} generations`),
        el('dt', {}, 'Member since'), el('dd', {}, new Date(user.createdAt).toLocaleDateString()),
        el('dt', {}, 'Mode'), el('dd', {}, state.status ? state.status.mode : '—')),
      el('div', { class: 'row', style: { marginTop: '20px' } },
        el('button', { class: 'btn primary', onClick: () => { location.hash = '#/pricing'; } }, icon('bolt', 'sm'), 'Manage plan'))));
}

/* --- boot ----------------------------------------------------------------- */
(async function boot() {
  window.addEventListener('hashchange', render);
  onChange(() => { /* state changes re-render through explicit calls */ });

  await loadStatus();
  await loadSession();
  // In test mode nobody should hit a signup wall before their first game.
  if (!state.user) await ensureGuestSession();

  // Warm the project list so the sidebar's recents are populated on first paint.
  if (state.user) {
    try {
      const { games } = await projects.list();
      state.projects = games;
    } catch { /* the dashboard will retry and surface the error */ }
  }

  if (!state.status) toast('Could not reach the meamus API.', 'err', 8000);
  state.ready = true;
  render();
})();
