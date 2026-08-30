/* =============================================================================
 * Marketing landing page - the signed-out home screen.
 * ========================================================================== */

import { el, icon, toast, playModal } from './ui.js';
import { state, templatesApi, projects as projectsApi } from './api.js';
import { createComposer } from './composer.js';
import { openAuth } from './auth-dialog.js';
import { startProject } from './generate.js';

const EXAMPLES = [
  'A space shooter where I tap to blast asteroids and grab power-ups',
  'Endless runner where a paper plane dodges skyscrapers',
  'A retro platformer with gems, spikes and patrolling slimes',
  'Match-3 puzzle with cascading combos and a move limit'
];

const FEATURES = [
  {
    icon: 'wand',
    title: 'Describe it in plain language',
    body: 'One sentence in. A complete Phaser 3 game out — scenes, physics, art, sound and a full menu-to-game-over loop.'
  },
  {
    icon: 'image',
    title: 'Drop in art and notes',
    body: 'Attach reference images, a design doc, or a level list. meamus reads them and matches the direction you set.'
  },
  {
    icon: 'rocket',
    title: 'Ship it the same day',
    body: 'Play it instantly, download one self-contained HTML file, or export a signed-ready Android project.'
  }
];

export function renderLanding(root) {
  const composer = createComposer({
    placeholder: 'A space shooter where I tap to blast asteroids…',
    submitLabel: 'Generate game',
    async onSubmit(text, attachmentIds, { mode }) {
      // In test mode a guest session already exists, so this never fires and
      // the first prompt generates straight away.
      if (!state.user) {
        const user = await openAuth('register');
        if (!user) { toast('Create an account to generate your game', 'warn'); return; }
      }
      composer.setBusy(true);
      try {
        await startProject(text, attachmentIds, mode);
      } catch (err) {
        toast(err.message, 'err', 7000);
      } finally {
        composer.setBusy(false);
      }
    }
  });

  root.append(
    el('nav', { class: 'site-nav' },
      el('a', { class: 'brand', href: '#/' }, el('span', { class: 'brand-mark' }, icon('gamepad')), 'meamus'),
      el('div', { class: 'links' },
        el('a', { href: '#/templates' }, 'Templates'),
        el('a', { href: '#/pricing' }, 'Pricing'),
        el('a', { href: '#/docs' }, 'Docs')),
      el('span', { class: 'grow' }),
      state.user && state.user.isGuest
        ? el('button', {
          class: 'btn ghost', onClick: () => { location.hash = '#/dashboard'; }
        }, icon('grid', 'sm'), 'My games')
        : null,
      el('button', { class: 'btn ghost', onClick: () => openAuth('login') }, 'Log in'),
      el('button', {
        class: 'btn primary',
        onClick: async () => {
          const user = await openAuth('register');
          if (user) location.hash = '#/dashboard';
        }
      }, state.user && state.user.isGuest ? 'Save my work' : 'Get started')),

    el('div', { class: 'hero-wrap' },
      el('div', { class: 'hero-glow' }),
      el('header', { class: 'hero' },
        el('div', { class: 'hero-inner' },
          el('span', { class: 'eyebrow' },
            icon('sparkles', 'sm'),
            state.status && state.status.testMode
              ? 'Test mode — no signup, just prompt and play'
              : 'Prompt to playable in one step'),
          el('h1', {}, 'Describe a game.', el('br'), 'Play it in seconds.'),
          el('p', { class: 'lede' },
            'meamus turns a sentence into a complete HTML5 game — art, physics, ' +
            'touch controls and all. No engine to learn, no assets to source.'),
          composer.node,
          el('div', { class: 'chiprow', style: { marginTop: '16px', justifyContent: 'center' } },
            EXAMPLES.map((example) => el('button', {
              class: 'chip',
              onClick: () => { composer.setValue(example); composer.focus(); }
            }, example.length > 46 ? `${example.slice(0, 46)}…` : example)))))),

    el('section', { class: 'section' },
      el('div', { class: 'section-inner' },
        el('div', { class: 'grid c3' },
          FEATURES.map((feature) => el('article', { class: 'card' },
            el('div', { class: 'feature-icon' }, icon(feature.icon, 'lg')),
            el('h3', {}, feature.title),
            el('p', { class: 'muted small', style: { margin: 0 } }, feature.body)))))),

    el('section', { class: 'section warm' },
      el('div', { class: 'section-inner' },
        el('div', { class: 'section-head' },
          el('h2', {}, 'Four games, built and playable right now'),
          el('p', { class: 'muted' },
            'These ship with meamus as the reference build for their genre. ' +
            'Play them here — no account needed.')),
        el('div', { class: 'grid c4', id: 'landing-templates' },
          Array.from({ length: 4 }, () => el('div', { class: 'card' },
            el('div', { class: 'skeleton', style: { height: '92px' } })))))),

    el('footer', { class: 'site-foot' },
      el('div', { class: 'spread' },
        el('span', {}, '© ', String(new Date().getFullYear()), ' meamus · Built on Phaser 3'),
        el('span', {}, state.status ? `${state.status.templates} templates · ${state.status.mode} mode` : '')))
  );

  loadTemplateStrip();
}

async function loadTemplateStrip() {
  const host = document.getElementById('landing-templates');
  if (!host) return;
  try {
    const { templates } = await templatesApi.list();
    state.templates = templates;
    if (!document.body.contains(host)) return;
    host.replaceChildren(...templates.map((template) => el('article', { class: 'card hover' },
      el('div', { class: 'row', style: { gap: '8px', marginBottom: '9px' } },
        el('span', { class: 'feature-icon', style: { width: '30px', height: '30px', margin: 0, borderRadius: '8px' } }, icon('gamepad', 'sm')),
        el('span', { class: 'tag orange' }, template.gameConfig.genre)),
      el('h3', { style: { marginBottom: '5px' } }, template.gameConfig.title),
      el('p', { class: 'muted small', style: { minHeight: '58px' } },
        `${template.gameConfig.description.slice(0, 108)}…`),
      el('button', {
        class: 'btn sm block',
        onClick: () => playModal(template.gameConfig.title, `/api/templates/${template.id}/play`)
      }, icon('play', 'sm'), 'Play'))));
  } catch {
    host.replaceChildren(el('p', { class: 'muted' }, 'Could not load the demo games.'));
  }
}
