/* =============================================================================
 * DOM helpers, icon set, toasts, dialogs.
 * ========================================================================== */

import { state } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Terse element builder. Children that are null/false are skipped, so
 * conditional markup reads as `cond && el(...)` without leaking "null" text.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  add(node, children);
  return node;
}

export function add(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false || child === '') continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); return node; };

/**
 * A button that shows its own work.
 *
 * A disabled button is not feedback - it looks like the click was ignored.
 * This swaps in a spinner and a verb ("Creating account…") for the duration,
 * so a network round trip reads as progress rather than a frozen form, and
 * restores the exact original content afterwards.
 */
export function withBusy(button, busyLabel) {
  const original = [...button.childNodes];
  let released = false;

  clear(button).append(spinner(), document.createTextNode(busyLabel));
  button.disabled = true;
  button.classList.add('is-busy');

  return () => {
    if (released) return;
    released = true;
    button.disabled = false;
    button.classList.remove('is-busy');
    clear(button).append(...original);
  };
}

/** Indeterminate progress ring. Honours prefers-reduced-motion via CSS. */
export function spinner(size = 'sm') {
  return el('span', {
    class: `spin ${size}`,
    'aria-hidden': 'true',
    html: '<svg viewBox="0 0 20 20" width="14" height="14">'
      + '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" '
      + 'stroke-opacity=".22" stroke-width="2.5"/>'
      + '<path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke="currentColor" '
      + 'stroke-width="2.5" stroke-linecap="round"/></svg>'
  });
}

/* --- icons --------------------------------------------------------------- */
const PATHS = {
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  arrowUp: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  home: '<path d="M3 10l9-7 9 7v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 21V12h6v9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  code: '<path d="M9 18l-6-6 6-6"/><path d="M15 6l6 6-6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 20"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  paperclip: '<path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.4 3.4 0 015 5l-9 9a1.8 1.8 0 01-2.5-2.5l8-8"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18.5h2"/>',
  refresh: '<path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 3v6h-6"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 010 18a15 15 0 010-18"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4"/><path d="M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  gamepad: '<path d="M7 12h4"/><path d="M9 10v4"/><circle cx="16" cy="11" r="1"/><circle cx="18.5" cy="13.5" r="1"/><path d="M8.5 6h7a5.5 5.5 0 015.4 4.5l.8 4.6A3 3 0 0118.8 19c-1 0-1.9-.5-2.4-1.3L15.5 16h-7l-.9 1.7A2.8 2.8 0 015.2 19a3 3 0 01-3-3.5l.9-5A5.5 5.5 0 018.5 6z"/>',
  sparkles: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/>',
  wand: '<path d="M15 4V2"/><path d="M15 10V8"/><path d="M12.5 6h-2"/><path d="M19.5 6h-2"/><path d="M4 20l10-10"/><path d="M13.5 8.5l2 2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 4v16"/>',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z"/>',
  rocket: '<path d="M12 3c3.5 2 5.5 5.5 5.5 9.5L15 15H9l-2.5-2.5C6.5 8.5 8.5 5 12 3z"/><circle cx="12" cy="10" r="1.6"/><path d="M9 15l-2 4 4-1.5"/><path d="M15 15l2 4-4-1.5"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0116 0"/>'
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] || PATHS.spark;
  return svg;
}

/* --- toasts -------------------------------------------------------------- */
export function toast(message, kind = 'ok', ms = 4200) {
  const host = $('#toasts');
  const node = el('div', { class: `toast ${kind}` },
    icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'bolt'),
    el('span', {}, message));
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

/* --- dialogs ------------------------------------------------------------- */
/** Opens a modal built from `render(close)`; resolves when it closes. */
export function modal(render, { wide = false } = {}) {
  const dialog = el('dialog', { class: wide ? 'wide' : '' });
  const close = () => dialog.close();
  dialog.append(render(close));
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Player modal: an iframe with restart / open-in-tab / close. */
export function playModal(title, url) {
  return modal((close) => {
    const frame = el('iframe', {
      src: url, title: `${title} preview`,
      sandbox: 'allow-scripts allow-same-origin allow-pointer-lock', allow: 'autoplay; fullscreen'
    });
    return el('div', { class: 'dlg play-shell' },
      el('div', { class: 'spread' },
        el('div', { class: 'row', style: { gap: '9px' } }, icon('gamepad', 'lg'), el('h2', { style: { margin: 0, fontSize: '17px' } }, title)),
        el('div', { class: 'row', style: { gap: '7px' } },
          el('button', { class: 'btn sm', onClick: () => { const s = frame.src; frame.src = 'about:blank'; setTimeout(() => { frame.src = s; }, 40); } }, icon('refresh', 'sm'), 'Restart'),
          el('button', { class: 'btn sm', onClick: () => window.open(url, '_blank', 'noopener') }, icon('external', 'sm'), 'Open'),
          el('button', { class: 'btn sm', onClick: close }, icon('x', 'sm')))),
      el('div', { class: 'play-frame' }, frame));
  }, { wide: true });
}

export function confirmModal(title, body, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    let answered = false;
    const { dialog, close } = modal((closeFn) => el('div', { class: 'dlg' },
      el('h2', { style: { fontSize: '18px' } }, title),
      el('p', { class: 'muted' }, body),
      el('div', { class: 'dlg-actions' },
        el('button', { class: 'btn', onClick: closeFn }, 'Cancel'),
        el('button', {
          class: 'btn danger',
          onClick: () => { answered = true; resolve(true); closeFn(); }
        }, confirmLabel))));
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What the meter says. Credits are the real currency, so they win over the
 * legacy daily quota whenever the server has them switched on.
 */
export function quotaLabel(user) {
  const target = user || state.user;
  if (!target) return '';
  if (target.creditsEnabled) {
    const costs = target.creditCosts || {};
    return `${target.credits} credits · ${costs.create || 20} per game, ${costs.iterate || 10} per change`;
  }
  if (target.quota == null) return `${target.usage} generations today · unlimited`;
  return `${target.usage}/${target.quota} generations today`;
}

/**
 * The header balance. Goes amber once there is not enough left for two more
 * games, which is the point at which a plan stops being abstract.
 */
export function creditChip(user) {
  const target = user || state.user;
  if (!target || !target.creditsEnabled) return null;
  const cost = (target.creditCosts || {}).create || 20;
  const chip = el('button', {
    class: 'credit-chip', type: 'button',
    onClick: () => { location.hash = '#/pricing'; }
  }, icon('bolt', 'sm'), el('b', {}, '0'), 'credits');

  /**
   * Repaint from the live user object. The balance changes on every build, so
   * a chip rendered once at mount goes stale and contradicts the chat.
   */
  chip.refresh = () => {
    const now = (state.user || target).credits;
    const low = now < cost * 2;
    chip.querySelector('b').textContent = String(now);
    chip.classList.toggle('low', low);
    chip.title = low ? 'Running low - see plans' : `${now} credits left`;
  };
  chip.refresh();
  return chip;
}

export function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
