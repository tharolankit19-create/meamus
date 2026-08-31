/* =============================================================================
 * The signed-out shell: site nav, footer, and the marketing pages.
 * Landing, Templates, Pricing and Docs all render through here, so a visitor
 * never lands on a page that quietly falls back to the homepage.
 * ========================================================================== */

import { el, icon, toast, playModal, add } from './ui.js';
import { state, templatesApi, templatePlayUrl } from './api.js';
import { openAuth } from './auth-dialog.js';

/** True when this deployment cannot create accounts at all. */
export function accountsOff() {
  return Boolean(state.status && state.status.accountsAvailable === false);
}

/** Opens the sign-up dialog and routes the new account into the app. */
export async function promptSignup(reason) {
  if (accountsOff()) {
    toast('Accounts are off here — everything is already unlocked, just start a prompt.', 'warn', 5000);
    location.hash = '#/';
    return null;
  }
  if (reason) toast(reason, 'warn', 5000);
  const user = await openAuth('register');
  if (user) location.hash = '#/dashboard';
  return user;
}

export function siteNav(active) {
  const link = (label, hash, id) => el('a', {
    href: hash,
    class: active === id ? 'active' : '',
    style: active === id ? { background: 'var(--surface-2)', color: 'var(--ink)' } : null
  }, label);

  return el('nav', { class: 'site-nav' },
    el('a', { class: 'brand', href: '#/' }, el('span', { class: 'brand-mark' }, icon('gamepad')), 'meamus'),
    el('div', { class: 'links' },
      link('Templates', '#/templates', 'templates'),
      link('Pricing', '#/pricing', 'pricing'),
      link('Docs', '#/docs', 'docs')),
    el('span', { class: 'grow' }),
    state.user && state.user.isGuest
      ? el('button', { class: 'btn ghost', onClick: () => { location.hash = '#/dashboard'; } },
        icon('grid', 'sm'), 'My games')
      : null,
    state.user && !state.user.isGuest
      ? el('button', { class: 'btn primary', onClick: () => { location.hash = '#/dashboard'; } },
        icon('grid', 'sm'), 'Dashboard')
      : accountsOff()
        // No sign-up button when signing up cannot succeed - send people to
        // the thing that does work instead.
        ? el('button', { class: 'btn primary', onClick: () => { location.hash = '#/'; } },
          icon('sparkles', 'sm'), 'Start building')
        : el('span', { class: 'row', style: { gap: '8px' } },
          el('button', { class: 'btn ghost', onClick: () => openAuth('login') }, 'Log in'),
          el('button', {
            class: 'btn primary',
            onClick: () => promptSignup()
          }, state.user && state.user.isGuest ? 'Save my work' : 'Sign up free')));
}

export function siteFooter() {
  return el('footer', { class: 'site-foot' },
    el('div', { class: 'spread' },
      el('span', {},
        `© ${new Date().getFullYear()} meamus · Built on Phaser 3 · Game design data from `,
        el('a', {
          href: 'https://www.freetogame.com', target: '_blank', rel: 'noopener',
          style: { color: 'var(--orange)' }
        }, 'FreeToGame')),
      el('span', { class: 'row', style: { gap: '16px' } },
        el('a', { href: '#/templates' }, 'Templates'),
        el('a', { href: '#/pricing' }, 'Pricing'),
        el('a', { href: '#/docs' }, 'Docs'))));
}

/** Standard marketing page frame: nav, a heading block, body, footer. */
export function marketingPage(host, { active, title, lede, body }) {
  host.append(
    siteNav(active),
    el('main', { class: 'section', style: { paddingTop: 'clamp(38px, 6vw, 70px)' } },
      el('div', { class: 'section-inner' },
        el('div', { class: 'section-head' },
          el('h1', { style: { fontSize: 'clamp(30px, 4.4vw, 44px)' } }, title),
          lede ? el('p', { class: 'lede muted', style: { fontSize: '17px', margin: 0 } }, lede) : null),
        body)),
    siteFooter());
}

/* --- Templates ------------------------------------------------------------ */
export function renderMarketingTemplates(host) {
  const grid = el('div', { class: 'grid c3' },
    Array.from({ length: 4 }, () => el('div', { class: 'card' },
      el('div', { class: 'skeleton', style: { height: '190px' } }))));

  marketingPage(host, {
    active: 'templates',
    title: 'Template library',
    lede: 'Four complete games, each the reference build for its genre. Play them, ' +
      'then remix any one into your own with a prompt.',
    body: el('div', {}, grid)
  });

  loadTemplateGrid(grid);
}

async function loadTemplateGrid(grid) {
  try {
    const { templates, gated } = await templatesApi.list();
    state.templates = templates;
    // The playable one leads, so the page opens on a running game rather than
    // on three locked tiles.
    const ordered = [...templates].sort((a, b) => Number(b.playable) - Number(a.playable));
    grid.replaceChildren(...ordered.map((template) => templateCard(template, gated)));
  } catch (err) {
    grid.replaceChildren(el('p', { class: 'form-error' }, err.message));
  }
}

function templateCard(template, gated) {
  const locked = !template.playable;

  const play = () => {
    if (locked) {
      promptSignup('Create a free account to play the full template library');
      return;
    }
    playModal(template.gameConfig.title, templatePlayUrl(template.id));
  };

  const thumb = el('div', { class: 'project-thumb', style: { cursor: 'pointer' }, onClick: play });
  if (template.playable) {
    thumb.append(el('iframe', {
      src: templatePlayUrl(template.id, { attract: template.showcase }),
      title: `${template.gameConfig.title} preview`, loading: 'lazy',
      sandbox: 'allow-scripts allow-same-origin', tabindex: '-1'
    }));
  } else {
    // No frame for a locked template - a blank iframe reads as a broken page.
    thumb.append(el('div', { class: 'locked-thumb' },
      icon('gamepad', 'lg'),
      el('strong', {}, template.gameConfig.title),
      el('span', { class: 'small' }, 'Sign up free to play')));
  }

  return el('article', { class: 'card hover project-card' },
    thumb,
    el('div', { class: 'project-body' },
      el('div', { class: 'spread', style: { marginBottom: '5px' } },
        el('h3', {}, template.gameConfig.title),
        el('span', { class: `tag ${template.showcase ? 'green' : 'orange'}` },
          template.showcase ? 'free demo' : template.gameConfig.genre)),
      el('p', { class: 'muted small', style: { margin: '0 0 10px', minHeight: '42px' } },
        template.gameConfig.description),
      el('p', { class: 'faint small mono', style: { margin: '0 0 12px' } },
        `${template.mechanics.length} mechanics · ${template.spriteCount} sprites · ${template.gameConfig.difficulty}`),
      el('div', { class: 'row', style: { gap: '8px' } },
        el('button', { class: 'btn primary sm', onClick: play },
          icon(locked ? 'user' : 'play', 'sm'), locked ? 'Sign up to play' : 'Play'),
        el('button', {
          class: 'btn sm',
          onClick: () => {
            if (!state.user || state.user.isGuest) {
              if (!state.user) { promptSignup('Create a free account to remix a template'); return; }
            }
            location.hash = '#/dashboard';
            setTimeout(() => {
              const box = document.querySelector('.composer textarea');
              if (!box) return;
              box.value = `A ${template.gameConfig.genre} like ${template.gameConfig.title}: ${template.gameConfig.description}`;
              box.dispatchEvent(new Event('input'));
              box.focus();
            }, 80);
          }
        }, icon('wand', 'sm'), 'Remix'))));
}

/* --- Pricing -------------------------------------------------------------- */
export async function renderMarketingPricing(host) {
  const grid = el('div', { class: 'grid c3', style: { maxWidth: '1000px' } },
    el('div', { class: 'card' }, el('div', { class: 'skeleton', style: { height: '260px' } })),
    el('div', { class: 'card' }, el('div', { class: 'skeleton', style: { height: '260px' } })),
    el('div', { class: 'card' }, el('div', { class: 'skeleton', style: { height: '260px' } })));

  marketingPage(host, {
    active: 'pricing',
    title: 'Pricing',
    lede: 'Every account starts with free credits. A new game costs 20, a change costs 10 — ' +
      'so the free grant builds about ten games before you need a plan.',
    body: grid
  });

  try {
    const { plans } = await (await fetch('/api/billing/plans')).json();
    grid.replaceChildren(...plans.map((plan) => el('article', {
      class: 'card',
      style: plan.id === 'pro' ? { borderColor: 'var(--orange-line)' } : null
    },
    el('div', { class: 'spread' },
      el('h2', { style: { fontSize: '18px', margin: 0 } }, plan.name),
      plan.id === 'starter' ? el('span', { class: 'tag orange' }, 'Most popular') : null,
      plan.apk ? el('span', { class: 'tag green' }, 'APK export') : null),
    el('div', { style: { fontSize: '34px', fontWeight: '650', letterSpacing: '-0.03em', margin: '10px 0 2px' } },
      plan.price === 0 ? 'Free' : `$${plan.price}`,
      plan.price ? el('span', { class: 'faint', style: { fontSize: '14px', fontWeight: '500' } }, ` / ${plan.interval}`) : null),
    // The number people are actually buying, stated before the feature list.
    el('div', { class: 'muted small', style: { margin: '0 0 8px' } },
      plan.credits
        ? `${plan.credits.toLocaleString()} credits a month`
        : 'Credits you get on sign-up'),
    el('ul', { class: 'ticks', style: { margin: '14px 0 20px' } }, plan.features.map((f) => el('li', {}, f))),
    el('button', {
      class: `btn block ${plan.id === 'starter' ? 'primary' : ''}`,
      onClick: () => promptSignup()
    }, plan.price === 0 ? 'Start free' : `Get ${plan.name}`))));
  } catch (err) {
    grid.replaceChildren(el('p', { class: 'form-error' }, err.message));
  }
}

/* --- Docs ----------------------------------------------------------------- */
const DOC_SECTIONS = [
  {
    title: 'How it works',
    body: [
      'You describe a game in a sentence. meamus sends that to a model along with a ' +
      'strict spec of what a finished game must contain, and gets back a GameSpec: ' +
      'the game config, every sprite and sound brief, the control scheme, the ' +
      'mechanics, and the complete Phaser 3 source.',
      'The spec is validated before anything runs — missing fields are filled, enums ' +
      'are clamped, and code using eval() is rejected outright. What survives is ' +
      'bundled into one self-contained HTML file whose only external request is a ' +
      'pinned Phaser build.'
    ]
  },
  {
    title: 'Iterating',
    body: [
      'Every project is a chat. Say "make it harder", "add a boss every 5 waves", or ' +
      '"use a colder palette" and the game is rebuilt with that change applied and ' +
      'everything else preserved. The previous ten versions are kept, so a bad edit ' +
      'is one click back.'
    ]
  },
  {
    title: 'Attachments',
    body: [
      'Click +, drag files onto the prompt box, or paste a screenshot. Text files ' +
      '(md, txt, json, csv, js, html, css up to 512 KB) become design notes in the ' +
      'prompt — a level list, a mechanics doc, a palette.',
      'Images (png, jpg, webp, gif up to 5 MB) are sent as vision input when the ' +
      'configured model reads images. When it does not, meamus says so in the build ' +
      'notes rather than pretending they were used. Six files per message.'
    ]
  },
  {
    title: 'What you get out',
    body: [
      'A share link that plays in any browser. A standalone HTML file you can host ' +
      'anywhere or open by double-clicking. And on Pro, a complete Cordova project ' +
      'for Android — the game already in www/, config.xml filled in, and a build ' +
      'script that produces an APK in two commands. meamus does not compile the APK ' +
      'itself: that needs the Android SDK and your signing key, neither of which ' +
      'belongs on a web server.'
    ]
  },
  {
    title: 'What the generated games contain',
    body: [
      'Five scenes (boot, preload, menu, game, game over), Arcade physics tuned for ' +
      'the genre, keyboard and mouse and touch controls on every game, object pooling ' +
      'so the sprite count stays bounded, high scores in localStorage, and ad ' +
      'placements already called in the right places — a banner slot, interstitials ' +
      'on level and run boundaries, and a rewarded-video hook for a revive.',
      'All art is procedural: shapes drawn with Phaser Graphics and baked into ' +
      'textures at load. All sound is synthesised through the Web Audio API. Nothing ' +
      'is fetched, so the games work offline and inside an APK.'
    ]
  }
];

export function renderDocs(host) {
  marketingPage(host, {
    active: 'docs',
    title: 'Docs',
    lede: 'What meamus builds, how to steer it, and what you can take away.',
    body: el('div', { class: 'grid c2', style: { alignItems: 'start' } },
      DOC_SECTIONS.map((section) => el('article', { class: 'card' },
        el('h3', { style: { marginBottom: '10px' } }, section.title),
        section.body.map((paragraph) => el('p', { class: 'muted small', style: { margin: '0 0 10px' } }, paragraph)))),
      el('article', { class: 'card', style: { borderColor: 'var(--orange-line)', background: 'var(--orange-soft)' } },
        el('h3', { style: { marginBottom: '10px' } }, 'Start building'),
        el('p', { class: 'muted small' }, 'The fastest way to understand it is to describe one game and look at what comes back.'),
        el('button', { class: 'btn primary block', style: { marginTop: '4px' }, onClick: () => { location.hash = '#/'; } },
          icon('sparkles', 'sm'), 'Try a prompt')))
  });
}

export { add };
