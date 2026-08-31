/* =============================================================================
 * Router + boot.
 * ========================================================================== */

import { $, el, clear, icon, toast } from './ui.js';
import { state, loadStatus, loadSession, onChange, projects, consumeOAuthFragment } from './api.js';
import { renderLanding } from './landing.js';
import { renderDashboard, renderTemplatesPage, renderPricing, sidebar } from './dashboard.js';
import { renderWorkspace } from './workspace.js';
import { openAuth } from './auth-dialog.js';
import { renderMarketingTemplates, renderMarketingPricing, renderDocs } from './marketing.js';

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

  const browsing = !state.user;

  if (browsing) {
    switch (name) {
      case '':
      case 'home':
        renderLanding(host);
        return;
      case 'templates':
        renderMarketingTemplates(host);
        return;
      case 'pricing':
        await renderMarketingPricing(host);
        return;
      case 'docs':
        renderDocs(host);
        return;
      default:
        break;      // a guest still gets the app for dashboard/project routes
    }
  }

  // A signed-out visitor following a project link is asked to sign in rather
  // than being dropped on the homepage with no explanation.
  if (!state.user) {
    if (name === 'project' || name === 'dashboard' || name === 'account') {
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
    case 'docs':
      renderDocs(host);
      return;
    case '':
    case 'home':
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

  // The gated template frame asks the parent to open sign-up. Only same-origin
  // frames are trusted, and only for that one message.
  window.addEventListener('message', async (event) => {
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== 'meamus:signin') return;
    const user = await openAuth('register');
    if (user) location.hash = '#/dashboard';
  });
  onChange(() => { /* state changes re-render through explicit calls */ });

  await loadStatus();
  // A Google redirect lands here with the session in the fragment. Consume it
  // before loadSession(), or the app decides nobody is signed in and bounces
  // straight back to the landing page.
  try {
    await consumeOAuthFragment();
  } catch (err) {
    toast(`Google sign-in failed: ${err.message}`, 'err', 8000);
  }
  await loadSession();

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
