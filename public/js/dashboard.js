/* =============================================================================
 * Signed-in home: sidebar + greeting + composer + project grid.
 * ========================================================================== */

import { el, add, icon, toast, clear, playModal, confirmModal, relativeTime, quotaLabel } from './ui.js';
import { state, projects, templatesApi, playUrl, setSession, billing, templatePlayUrl } from './api.js';
import { createComposer } from './composer.js';
import { startProject } from './generate.js';
import { openAuth } from './auth-dialog.js';
import { takePrompt } from './landing.js';

const GREETINGS = ['Let\'s build something', 'What are we making', 'Ready when you are'];

export function renderDashboard(root, { tab = 'projects' } = {}) {
  const main = el('main', { class: 'main' });
  const side = sidebar('dashboard');
  root.append(el('div', { class: 'app' }, side, main));

  const greeting = GREETINGS[new Date().getDate() % GREETINGS.length];
  const firstName = (state.user.name || state.user.email || '').split(/[\s@]/)[0];

  const composer = createComposer({
    placeholder: 'Describe your next game… attach art or notes with +',
    autofocus: true,
    submitLabel: 'Generate game',
    async onSubmit(text, attachmentIds) {
      composer.setBusy(true);
      try {
        // The live panel replaces the project grid while the agents work, so
        // the progress is where the founder is already looking.
        await startProject(text, attachmentIds, { host: listHost });
      } catch (err) {
        if (err.code === 'insufficient_credits') {
          toast(err.message, 'warn', 7000);
          location.hash = '#/pricing';
        } else {
          toast(err.message, 'err', 7000);
        }
        loadTab('projects', listHost);
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

  // add() rather than the native append(): native append writes a bare `false`
  // into the page as text, which is exactly what the "false" under the composer
  // was. add() skips null/false children.
  add(main,
    [el('h1', { class: 'greet' }, firstName ? `${greeting}, ${firstName}` : greeting),
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
    listHost]);

  // A prompt typed on the landing page before signing in is waiting here. The
  // sign-in detour should be invisible: the words come back, ready to send.
  const pending = takePrompt();
  if (pending) {
    composer.setValue(pending);
    composer.focus();
  }

  listHost.__side = side;
  loadTab(tab, listHost);
}

/* --- sidebar -------------------------------------------------------------- */
export function sidebar(active) {
  const initial = (state.user.name || state.user.email || 'P').charAt(0).toUpperCase();

  // Straight after signing in the list has not arrived yet. Skeleton rows hold
  // the space so the sidebar settles rather than jolting when it does.
  const recentsHost = el('div', { class: 'recents-list' });

  /**
   * Straight after signing in the list has not arrived yet, so skeleton rows
   * hold the space. Repainted when it lands, rather than left to jolt - and
   * exported on the node so loadTab can call it without a full re-render.
   */
  function paintRecents() {
    clear(recentsHost).append(...(state.projects.length
      ? state.projects.slice(0, 6).map((project) => el('button', {
        class: 'side-item',
        onClick: () => { location.hash = `#/project/${project.id}`; }
      }, icon('gamepad', 'sm'), el('span', { class: 'nm' }, project.title)))
      : state.projectsLoaded
        ? []
        : Array.from({ length: 3 }, () =>
          el('div', { class: 'side-item skeleton-row' }, el('span', { class: 'skeleton' })))));
  }
  paintRecents();
  const recents = state.projects.length || !state.projectsLoaded ? [recentsHost] : [];

  const node = el('aside', { class: 'sidebar' },
    el('div', { class: 'side-head' },
      el('a', { class: 'brand', href: '#/dashboard' },
        el('span', { class: 'brand-mark' }, icon('gamepad')), 'meamus')),

    el('button', { class: 'workspace-pill', onClick: () => { location.hash = '#/account'; } },
      el('span', { class: 'avatar' }, initial),
      el('span', { class: 'nm grow', style: { textAlign: 'left' } },
        state.user.name || 'My workspace'),
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

    state.user.plan === 'pro'
        ? el('div', { class: 'upsell', style: { marginTop: 'auto' } },
          el('h4', {}, 'Pro plan'),
          el('p', {}, `${state.user.credits} credits left, plus Android APK export.`))
        : el('div', { class: 'upsell' },
          el('h4', {}, state.user.credits < 40 ? 'Almost out of credits' : 'Need more credits?'),
          el('p', {}, `${state.user.credits} left. Starter is $29 for 1,000 a month; Pro is $59 for 2,500 plus APK export.`),
          el('button', {
            class: 'btn primary sm block',
            onClick: () => { location.hash = '#/pricing'; }
          }, icon('bolt', 'sm'), 'See plans')),

    el('button', {
      class: 'side-item',
      style: { marginTop: '6px' },
      onClick: () => { setSession(null, null); location.href = '/'; }
    }, icon('user'), 'Sign out'));

  node.paintRecents = paintRecents;
  return node;
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
    state.projectsLoaded = true;
    // The sidebar is already on screen holding skeleton rows. Repaint it in
    // place rather than leaving them until the next full render.
    if (host.__side && host.__side.paintRecents) host.__side.paintRecents();
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

  const host = el('div', { class: 'grid c3', style: { maxWidth: '1000px' } });
  const costs = state.user.creditCosts || { create: 20, iterate: 10 };
  main.append(
    el('h1', { class: 'greet' }, 'Plans'),
    el('p', { class: 'muted', style: { marginBottom: '10px' } },
      `A new game costs ${costs.create} credits and a change costs ${costs.iterate}. ` +
      'Credits from a plan add to what you already have.'),
    el('p', { class: 'muted', style: { marginBottom: '26px' } },
      el('strong', {}, `You have ${state.user.credits} credits.`)),
    host);

  try {
    const { plans, provider } = await billing.plans();
    clear(host).append(...plans.map((plan) => {
      const isCurrent = state.user.plan === plan.id;
      return el('article', { class: 'card', style: plan.id === 'starter' ? { borderColor: 'var(--orange-line)' } : {} },
        el('div', { class: 'spread' },
          el('h2', { style: { fontSize: '18px', margin: 0 } }, plan.name),
          plan.id === 'starter' ? el('span', { class: 'tag orange' }, 'Most popular') : null,
          plan.apk ? el('span', { class: 'tag green' }, 'APK export') : null),
        el('div', { style: { fontSize: '34px', fontWeight: '650', letterSpacing: '-0.03em', margin: '10px 0 2px' } },
          plan.price === 0 ? 'Free' : `$${plan.price}`,
          plan.price ? el('span', { class: 'faint', style: { fontSize: '14px', fontWeight: '500' } }, ` / ${plan.interval}`) : null),
        el('div', { class: 'muted small', style: { margin: '0 0 8px' } },
          plan.credits ? `${plan.credits.toLocaleString()} credits a month` : 'Credits you get on sign-up'),
        el('ul', { class: 'ticks', style: { margin: '14px 0 20px' } },
          plan.features.map((feature) => el('li', {}, feature))),
        isCurrent
          ? el('button', { class: 'btn block', disabled: true }, icon('check', 'sm'), 'Current plan')
          : el('button', {
            class: `btn block ${plan.id === 'starter' ? 'primary' : ''}`,
            onClick: () => changePlan(plan.id)
          }, plan.price === 0 ? 'Switch to Free' : `Get ${plan.name}`));
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
  try {
    const payload = planId === 'free' ? await billing.downgrade() : await billing.checkout(planId);
    if (payload.checkoutUrl) { location.href = payload.checkoutUrl; return; }
    state.user = payload.user;
    const added = payload.granted
      ? ` — ${payload.granted.toLocaleString()} credits added, ${payload.user.credits} total`
      : '';
    toast(planId === 'free' ? 'Switched to the Free plan.' : `Plan updated${added}.`, 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } catch (err) {
    toast(err.message, 'err', 7000);
  }
}
