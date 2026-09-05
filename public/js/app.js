/* =============================================================================
 * Router + boot.
 * ========================================================================== */

import { $, el, clear, icon, toast } from './ui.js';
import { state, loadStatus, loadSession, onChange, projects, consumeOAuthFragment } from './api.js';
import { renderLanding } from './landing.js';
import { setupRequired, renderSetup } from './setup.js';
import { renderDashboard, renderTemplatesPage, renderPricing, sidebar } from './dashboard.js';
import { renderWorkspace } from './workspace.js';
import { openAuth } from './auth-dialog.js';
import { renderMarketingTemplates, renderMarketingPricing, renderDocs } from './marketing.js';
import * as watcher from './watcher.js';

const root = () => $('#root');

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = hash.split('/');
  return { name: head || '', params: rest };
}

/**
 * Which view a route wants, given who is asking.
 *
 * Pulled out of render() so the decision can be read - and tested - in one
 * place. It was three separate pieces of control flow (a guest switch, an
 * if for protected routes, a signed-in switch) and the disagreement between
 * them is where the bug lived: a signed-in visitor asking for the home page was
 * redirected to the dashboard by the third piece, so the landing page was
 * unreachable while signed in. From the sidebar wordmark, from #/home, and from
 * the bare URL - three ways of asking, all refused.
 *
 * @param {object} where
 * @param {string} where.name        the first hash segment ('' for the home page)
 * @param {boolean} where.signedIn
 * @param {boolean} [where.hasProjectId] whether #/project carries an id
 * @returns {{view:string, redirect?:string, askToSignIn?:boolean}}
 */
export function routeFor({ name, signedIn, hasProjectId = true }) {
  // The home page is a page, not a signed-out state. Everybody may see it; the
  // nav shows "Dashboard" rather than "Log in" to whoever is already signed in.
  if (name === '' || name === 'home') return { view: 'landing' };

  if (name === 'templates') return { view: signedIn ? 'templates' : 'marketing-templates' };
  if (name === 'pricing') return { view: signedIn ? 'pricing' : 'marketing-pricing' };
  if (name === 'docs') return { view: 'docs' };

  // A signed-out visitor following a project link is asked to sign in rather
  // than dropped on the homepage with no explanation.
  if (!signedIn) {
    if (name === 'project' || name === 'dashboard' || name === 'account') {
      return { view: 'landing', askToSignIn: true };
    }
    return { view: 'landing' };
  }

  if (name === 'project') {
    return hasProjectId ? { view: 'workspace' } : { view: 'dashboard', redirect: '#/dashboard' };
  }
  if (name === 'account') return { view: 'account' };
  return { view: 'dashboard' };
}

async function render() {
  const { name, params } = parseRoute();

  // The view about to be thrown away may be watching a build. Builds outlive
  // views on purpose - the founder can start one and go and read the pricing
  // page - so the subscription is dropped here and the watcher takes over
  // announcing the result. Skipping this leaves a screen nobody can see
  // holding the only claim on a finished game.
  watcher.releaseAll();

  const host = clear(root());
  document.body.classList.toggle('workspace-route', name === 'project');

  // Nothing else can work until the deployment is configured, so nothing else
  // is shown. Offering a sign-up form that cannot succeed is what produced the
  // "create your account / accounts are off" contradiction.
  if (setupRequired()) {
    renderSetup(host);
    return;
  }

  const { view, redirect, askToSignIn } = routeFor({
    name,
    signedIn: Boolean(state.user),
    hasProjectId: Boolean(params[0])
  });

  if (redirect) { location.hash = redirect; return; }

  switch (view) {
    case 'landing':
      renderLanding(host);
      if (askToSignIn) {
        const user = await openAuth('login');
        if (user) render();
      }
      return;
    case 'marketing-templates': renderMarketingTemplates(host); return;
    case 'marketing-pricing': await renderMarketingPricing(host); return;
    case 'docs': renderDocs(host); return;
    case 'workspace': await renderWorkspace(host, params[0]); return;
    case 'templates': renderTemplatesPage(host); return;
    case 'pricing': await renderPricing(host); return;
    case 'account': renderAccount(host); return;
    default: renderDashboard(host);
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
