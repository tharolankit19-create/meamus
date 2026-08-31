/* =============================================================================
 * Marketing landing page - the signed-out home screen.
 * ========================================================================== */

import { el, icon, toast, playModal } from './ui.js';
import { state, templatesApi, templatePlayUrl, ensureGuestSession } from './api.js';
import { createComposer } from './composer.js';
import { openAuth } from './auth-dialog.js';
import { startProject } from './generate.js';
import { siteNav, siteFooter, promptSignup, accountsOff } from './marketing.js';

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
      // An account is required to build, unless this deployment cannot make
      // one - then a session already exists and the prompt runs straight
      // through. The typed prompt survives the sign-up detour either way.
      if (!state.user && !accountsOff()) {
        const user = await openAuth('register');
        if (!user) { toast('Create a free account to generate your game', 'warn'); return; }
      }
      if (!state.user) {
        await ensureGuestSession();
        if (!state.user) { toast('Could not start a session. Reload and try again.', 'err'); return; }
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
    siteNav('home'),

    el('div', { class: 'hero-wrap' },
      el('div', { class: 'hero-glow' }),
      el('header', { class: 'hero' },
        el('div', { class: 'hero-inner' },
          el('span', { class: 'eyebrow' },
            icon('sparkles', 'sm'),
            state.status && state.status.openAccess
              ? 'No sign-up needed · unlimited games'
              : 'Free account · unlimited games'),
          el('h1', {}, 'Describe a game.', el('br'), 'Play it in seconds.'),
          el('p', { class: 'lede' },
            'meamus turns a sentence into a complete HTML5 game — art, physics, ' +
            'touch controls and all. Build as many as you like — there is no ' +
            'daily limit.'),
          signupBlockedNotice(),
          composer.node,
          el('div', { class: 'chiprow', style: { marginTop: '16px', justifyContent: 'center' } },
            EXAMPLES.map((example) => el('button', {
              class: 'chip',
              onClick: () => { composer.setValue(example); composer.focus(); }
            }, example.length > 46 ? `${example.slice(0, 46)}…` : example)))))),

    demoSection(),

    el('section', { class: 'section' },
      el('div', { class: 'section-inner' },
        el('div', { class: 'grid c3' },
          FEATURES.map((feature) => el('article', { class: 'card' },
            el('div', { class: 'feature-icon' }, icon(feature.icon, 'lg')),
            el('h3', {}, feature.title),
            el('p', { class: 'muted small', style: { margin: 0 } }, feature.body)))))),

    el('section', { class: 'section warm' },
      el('div', { class: 'section-inner' },
        el('div', { class: 'spread', style: { marginBottom: '26px' } },
          el('div', { class: 'section-head', style: { margin: 0 } },
            el('h2', {}, 'Built with meamus'),
            el('p', { class: 'muted', style: { margin: 0 } },
              'Four complete games ship as templates. Remix any of them with a prompt.')),
          el('a', { class: 'btn', href: '#/templates' }, 'All templates', icon('arrowRight', 'sm'))),
        el('div', { class: 'grid c4', id: 'landing-templates' },
          Array.from({ length: 4 }, () => el('div', { class: 'card' },
            el('div', { class: 'skeleton', style: { height: '92px' } })))))),

    siteFooter()
  );

  loadTemplateStrip();
}

/**
 * Shown when the deployment cannot keep an account. Without this the signup
 * form just fails and the cause - unset storage credentials - is invisible to
 * everyone including the operator.
 */
function signupBlockedNotice() {
  if (!state.status || state.status.accountsAvailable !== false) return null;
  return el('div', {
    class: 'notice',
    style: { margin: '0 auto 18px', maxWidth: '620px', textAlign: 'left' }
  },
  icon('alert'),
  el('span', {},
    el('strong', {}, 'Accounts are off on this deployment, so everything is unlocked instead. '),
    'Type a prompt and build — no sign-up, no limits, every template playable. ',
    el('span', { class: 'faint' }, '(Operator: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to turn accounts on.)')));
}

/**
 * The live demo: the showcase game playing itself in a loop. It is the real
 * game in an iframe, not a video - clicking it hands over the controls.
 */
function demoSection() {
  const showcase = (state.status && state.status.showcase) || 'space-shooter';
  const frame = el('iframe', {
    src: templatePlayUrl(showcase, { attract: true }),
    title: 'Live demo — a meamus game playing itself',
    loading: 'lazy',
    sandbox: 'allow-scripts allow-same-origin allow-pointer-lock',
    allow: 'autoplay'
  });

  return el('section', { class: 'section', id: 'demo' },
    el('div', { class: 'section-inner' },
      el('div', { class: 'demo-split' },
        el('div', {},
          el('span', { class: 'tag green dot', style: { marginBottom: '12px' } }, 'Live, not a video'),
          el('h2', { style: { fontSize: 'clamp(24px, 3.2vw, 32px)' } }, 'This is what one prompt produces'),
          el('p', { class: 'muted' },
            'The game on the right is playing itself right now — same code a prompt ' +
            'gives you, running in your browser. Click it and you take over the ship.'),
          el('ul', { class: 'ticks', style: { margin: '18px 0 22px' } },
            el('li', {}, 'Five scenes: boot, preload, menu, game, game over'),
            el('li', {}, 'Procedural art and synthesised sound — nothing downloaded'),
            el('li', {}, 'Keyboard, mouse and touch controls on every game'),
            el('li', {}, 'Ad placements and a coin economy already wired in')),
          el('div', { class: 'row' },
            el('button', {
              class: 'btn primary',
              onClick: () => {
                document.querySelector('.composer textarea')?.focus();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }, icon('sparkles', 'sm'), 'Build your own'),
            el('button', {
              class: 'btn',
              onClick: () => playModal('Astro Salvage', templatePlayUrl(showcase))
            }, icon('play', 'sm'), 'Play full screen'))),
        el('div', { class: 'demo-frame' }, frame))));
}

async function loadTemplateStrip() {
  const host = document.getElementById('landing-templates');
  if (!host) return;
  try {
    const { templates } = await templatesApi.list();
    state.templates = templates;
    if (!document.body.contains(host)) return;
    const ordered = [...templates].sort((a, b) => Number(b.playable) - Number(a.playable));
    host.replaceChildren(...ordered.map((template) => el('article', { class: 'card hover' },
      el('div', { class: 'row', style: { gap: '8px', marginBottom: '9px' } },
        el('span', { class: 'feature-icon', style: { width: '30px', height: '30px', margin: 0, borderRadius: '8px' } }, icon('gamepad', 'sm')),
        el('span', { class: 'tag orange' }, template.gameConfig.genre)),
      el('h3', { style: { marginBottom: '5px' } }, template.gameConfig.title),
      el('p', { class: 'muted small', style: { minHeight: '58px' } },
        `${template.gameConfig.description.slice(0, 108)}…`),
      el('button', {
        class: 'btn sm block',
        onClick: () => {
          if (!template.playable) {
            promptSignup('Create a free account to play the full template library');
            return;
          }
          playModal(template.gameConfig.title, templatePlayUrl(template.id));
        }
      }, icon(template.playable ? 'play' : 'user', 'sm'),
      template.playable ? 'Play' : 'Sign up to play'))));
  } catch {
    host.replaceChildren(el('p', { class: 'muted' }, 'Could not load the demo games.'));
  }
}
