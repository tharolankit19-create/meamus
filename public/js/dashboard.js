/* =============================================================================
 * Signed-in home: sidebar + greeting + composer + project grid.
 * ========================================================================== */

import { el, icon, toast, clear, playModal, confirmModal, relativeTime, quotaLabel } from './ui.js';
import { state, projects, templatesApi, playUrl, setSession, billing, templatePlayUrl } from './api.js';
import { createComposer } from './composer.js';
import { startProject } from './generate.js';
import { openAuth } from './auth-dialog.js';

const GREETINGS = ['Let\'s build something', 'What are we making', 'Ready when you are'];

export function renderDashboard(root, { tab = 'projects' } = {}) {
  const main = el('main', { class: 'main' });
  root.append(el('div', { class: 'app' }, sidebar('dashboard'), main));

  const greeting = GREETINGS[new Date().getDate() % GREETINGS.length];
  const firstName = state.user.isGuest ? '' : (state.user.name || state.user.email).split(/[\s@]/)[0];

  const composer = createComposer({
    placeholder: 'Describe your next game… attach art or notes with +',
    autofocus: true,
    submitLabel: 'Generate game',
    async onSubmit(text, attachmentIds, { mode }) {
      composer.setBusy(true);
      try {
        await startProject(text, attachmentIds, mode);
      } catch (err) {
        toast(err.code === 'quota_exceeded'
          ? `${err.message}`
          : err.message, 'err', 7000);
      } finally {
        composer.setBusy(false);
      }
    }
  });

  const listHost = el('div', { class: 'grid c4' });
  const tabs = el('div', { class: 'tabbar' });

  const paintTabs = (active) => {
    clear(tabs).append(
      ...[['projects', 'My games'], ['templates', 'Templates']].map(([id, label]) =>
        el('button', {
          class: active === id ? 'active' : '',
          onClick: () => { paintTabs(id); loadTab(id, listHost); }
        }, label)));
  };
  paintTabs(tab);

  main.append(
    el('h1', { class: 'greet' }, firstName ? `${greeting}, ${firstName}` : greeting),
    composer.node,
    !state.status?.aiEnabled && el('div', { class: 'notice', style: { marginTop: '16px' } },
      icon('alert'),
      el('span', {},
        el('strong', {}, 'Template mode. '),
        'No Claude API key is set, so prompts are matched to the bundled templates ' +
        'and attachments are ignored. Everything else works exactly as it will with a key.')),
    el('div', { class: 'spread', style: { margin: '38px 0 16px' } },
      tabs,
      el('span', { class: 'faint small' },
        quotaLabel(state.user))),
    listHost);

  loadTab(tab, listHost);
}

/* --- sidebar -------------------------------------------------------------- */
export function sidebar(active) {
  const initial = state.user.isGuest ? 'G' : (state.user.name || state.user.email).charAt(0).toUpperCase();

  const recents = state.projects.slice(0, 6).map((project) => el('button', {
    class: 'side-item',
    onClick: () => { location.hash = `#/project/${project.id}`; }
  }, icon('gamepad', 'sm'), el('span', { class: 'nm' }, project.title)));

  return el('aside', { class: 'sidebar' },
    el('div', { class: 'side-head' },
      el('a', { class: 'brand', href: '#/dashboard' },
        el('span', { class: 'brand-mark' }, icon('gamepad')), 'meamus')),

    el('button', { class: 'workspace-pill', onClick: () => { location.hash = '#/account'; } },
      el('span', { class: 'avatar' }, initial),
      el('span', { class: 'nm grow', style: { textAlign: 'left' } },
        state.user.isGuest ? 'Guest workspace' : (state.user.name || 'My workspace')),
      icon('chevronDown', 'sm')),

    el('div', { style: { height: '10px' } }),
    el('button', {
      class: `side-item ${active === 'dashboard' ? 'active' : ''}`,
      onClick: () => { location.hash = '#/dashboard'; }
    }, icon('home'), 'Dashboard'),
    el('button', {
      class: `side-item ${active === 'templates' ? 'active' : ''}`,
      onClick: () => { location.hash = '#/templates'; }
    }, icon('layers'), 'Templates'),
    el('button', {
      class: `side-item ${active === 'pricing' ? 'active' : ''}`,
      onClick: () => { location.hash = '#/pricing'; }
    }, icon('bolt'), 'Plans'),

    recents.length ? el('div', { class: 'recents' },
      el('div', { class: 'side-label' }, 'Recent'),
      ...recents) : null,

    state.user.isGuest
      ? el('div', { class: 'upsell' },
        el('h4', {}, 'Guest session'),
        el('p', {}, 'Your games live in this browser only. Sign up to keep them.'),
        el('button', {
          class: 'btn primary sm block',
          onClick: async () => {
            const user = await openAuth('register');
            if (user) window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        }, icon('user', 'sm'), 'Save my work'))
      : state.user.plan === 'pro'
        ? el('div', { class: 'upsell', style: { marginTop: 'auto' } },
          el('h4', {}, 'Pro plan'),
          el('p', {}, `${state.user.quota} generations a day and Android export.`))
        : el('div', { class: 'upsell' },
          el('h4', {}, 'Upgrade to Pro'),
          el('p', {}, 'Android export and 200 generations a day.'),
          el('button', {
            class: 'btn primary sm block',
            onClick: () => { location.hash = '#/pricing'; }
          }, icon('bolt', 'sm'), 'See plans')),

    el('button', {
      class: 'side-item',
      style: { marginTop: '6px' },
      onClick: () => { setSession(null, null); location.href = '/'; }
    }, icon('user'), state.user.isGuest ? 'End guest session' : 'Sign out'));
}

/* --- lists ---------------------------------------------------------------- */
async function loadTab(tab, host) {
  clear(host).append(...Array.from({ length: 4 }, () =>
    el('div', { class: 'card' }, el('div', { class: 'skeleton', style: { height: '120px' } }))));

  try {
    if (tab === 'templates') {
      const { templates } = await templatesApi.list();
      state.templates = templates;
      clear(host).append(...templates.map(templateCard));
      return;
    }

    const { games } = await projects.list();
    state.projects = games;
    if (!games.length) {
      clear(host);
      host.style.gridTemplateColumns = '1fr';
      host.append(el('div', { class: 'empty' },
        el('div', { class: 'feature-icon', style: { margin: '0 auto 14px' } }, icon('sparkles', 'lg')),
        el('h2', { style: { fontSize: '18px' } }, 'No games yet'),
        el('p', { class: 'muted' }, 'Describe one in the box above and it lands here.')));
      return;
    }
    host.style.gridTemplateColumns = '';
    clear(host).append(...games.map(projectCard));
  } catch (err) {
    clear(host).append(el('p', { class: 'form-error' }, err.message));
  }
}

function projectCard(game) {
  const open = () => { location.hash = `#/project/${game.id}`; };

  return el('article', { class: 'card hover project-card' },
    el('div', { class: 'project-thumb', onClick: open },
      el('iframe', {
        src: playUrl(game.id), title: `${game.title} thumbnail`, loading: 'lazy',
        sandbox: 'allow-scripts allow-same-origin', tabindex: '-1'
      })),
    el('div', { class: 'project-body' },
      el('div', { class: 'spread', style: { marginBottom: '4px' } },
        el('h3', { onClick: open, style: { cursor: 'pointer' } }, game.title),
        el('span', { class: `tag ${game.mode === 'ai' ? 'green' : ''}` }, game.mode)),
      el('p', { class: 'faint small', style: { margin: '0 0 11px' } },
        `${game.genre} · ${game.codeLines} lines · ${relativeTime(game.updatedAt || game.createdAt)}`),
      el('div', { class: 'row', style: { gap: '6px' } },
        el('button', { class: 'btn sm', onClick: () => playModal(game.title, playUrl(game.id)) }, icon('play', 'sm'), 'Play'),
        el('button', { class: 'btn sm', onClick: open }, 'Open'),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'btn icon sq', title: `Delete ${game.title}`, 'aria-label': `Delete ${game.title}`,
          onClick: async (event) => {
            const confirmed = await confirmModal('Delete this game?',
              `"${game.title}" and its chat history will be removed. This cannot be undone.`);
            if (!confirmed) return;
            try {
              await projects.remove(game.id);
              state.projects = state.projects.filter((p) => p.id !== game.id);
              event.target.closest('article').remove();
              toast('Game deleted', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          }
        }, icon('trash', 'sm')))));
}

function templateCard(template) {
  return el('article', { class: 'card hover project-card' },
    el('div', { class: 'project-thumb' },
      el('iframe', {
        src: templatePlayUrl(template.id), title: `${template.gameConfig.title} thumbnail`,
        loading: 'lazy', sandbox: 'allow-scripts allow-same-origin', tabindex: '-1'
      })),
    el('div', { class: 'project-body' },
      el('div', { class: 'spread', style: { marginBottom: '4px' } },
        el('h3', {}, template.gameConfig.title),
        el('span', { class: 'tag orange' }, template.gameConfig.genre)),
      el('p', { class: 'faint small', style: { margin: '0 0 11px' } },
        `${template.mechanics.length} mechanics · ${template.spriteCount} sprites`),
      el('div', { class: 'row', style: { gap: '6px' } },
        el('button', {
          class: 'btn sm',
          onClick: () => playModal(template.gameConfig.title, templatePlayUrl(template.id))
        }, icon('play', 'sm'), 'Play'),
        el('button', {
          class: 'btn sm',
          onClick: () => {
            location.hash = '#/dashboard';
            setTimeout(() => {
              const textarea = document.querySelector('.composer textarea');
              if (!textarea) return;
              textarea.value = `A ${template.gameConfig.genre} like ${template.gameConfig.title}: ${template.gameConfig.description}`;
              textarea.dispatchEvent(new Event('input'));
              textarea.focus();
            }, 60);
          }
        }, icon('wand', 'sm'), 'Remix'))));
}

/* --- templates + pricing pages -------------------------------------------- */
export function renderTemplatesPage(root) {
  const main = el('main', { class: 'main' });
  root.append(el('div', { class: 'app' }, sidebar('templates'), main));
  const host = el('div', { class: 'grid c4' });
  main.append(
    el('h1', { class: 'greet' }, 'Templates'),
    el('p', { class: 'muted', style: { maxWidth: '580px', marginBottom: '28px' } },
      'Four complete games that ship with meamus. Each is the reference build for ' +
      'its genre, and the match target when generation runs in template mode.'),
    host);
  loadTab('templates', host);
}

export async function renderPricing(root) {
  const main = el('main', { class: 'main' });
  root.append(el('div', { class: 'app' }, sidebar('pricing'), main));

  const host = el('div', { class: 'grid c2', style: { maxWidth: '760px' } });
  main.append(
    el('h1', { class: 'greet' }, 'Plans'),
    el('p', { class: 'muted', style: { marginBottom: '28px' } },
      'Generate for free. Pay when you want to ship to the Play Store.'),
    host);

  try {
    const { plans, provider } = await billing.plans();
    clear(host).append(...plans.map((plan) => {
      const isCurrent = state.user.plan === plan.id;
      return el('article', { class: 'card', style: plan.id === 'pro' ? { borderColor: 'var(--orange-line)' } : {} },
        el('div', { class: 'spread' },
          el('h2', { style: { fontSize: '18px', margin: 0 } }, plan.name),
          plan.id === 'pro' ? el('span', { class: 'tag orange' }, 'Most popular') : null),
        el('div', { style: { fontSize: '34px', fontWeight: '650', letterSpacing: '-0.03em', margin: '10px 0 4px' } },
          plan.price === 0 ? 'Free' : `$${plan.price}`,
          plan.price ? el('span', { class: 'faint', style: { fontSize: '14px', fontWeight: '500' } }, ` / ${plan.interval}`) : null),
        el('ul', { class: 'ticks', style: { margin: '16px 0 20px' } },
          plan.features.map((feature) => el('li', {}, feature))),
        isCurrent
          ? el('button', { class: 'btn block', disabled: true }, icon('check', 'sm'), 'Current plan')
          : el('button', {
            class: `btn block ${plan.id === 'pro' ? 'primary' : ''}`,
            onClick: () => changePlan(plan.id)
          }, plan.id === 'pro' ? 'Upgrade to Pro' : 'Switch to Free'));
    }));

    if (provider === 'stub') {
      main.append(el('div', { class: 'notice', style: { marginTop: '20px', maxWidth: '760px' } },
        icon('alert'),
        el('span', {},
          el('strong', {}, 'Stub billing is active. '),
          'Upgrades apply instantly with no payment so the Pro features are testable ' +
          'end to end. Set BILLING_PROVIDER=stripe to take real money.')));
    }
  } catch (err) {
    clear(host).append(el('p', { class: 'form-error' }, err.message));
  }
}

async function changePlan(planId) {
  if (state.user.isGuest) {
    const user = await openAuth('register');
    if (!user) { toast('Create an account before upgrading', 'warn'); return; }
  }
  try {
    const payload = planId === 'free' ? await billing.downgrade() : await billing.checkout(planId);
    if (payload.checkoutUrl) { location.href = payload.checkoutUrl; return; }
    state.user = payload.user;
    toast(planId === 'pro' ? 'Upgraded to Pro — Android export unlocked.' : 'Switched to the Free plan.', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } catch (err) {
    toast(err.message, 'err', 7000);
  }
}
