/* =============================================================================
 * The setup screen.
 *
 * Shown when the deployment cannot do its job: no durable storage means no
 * accounts, and an account is required to build. This replaces the old
 * behaviour of quietly opening the product to everyone, which produced a
 * sign-up dialog that offered free credits and then errored on submit.
 *
 * It is written for the person who can fix it - the operator - and it names
 * the exact variables and the exact deployment that needs them.
 * ========================================================================== */

import { el, icon } from './ui.js';
import { state } from './api.js';

export function setupRequired() {
  return Boolean(state.status && state.status.setupRequired);
}

function deploymentLine() {
  const d = (state.status && state.status.deployment) || {};
  if (!d.vercelEnv && !d.branch) return null;

  // Which environment is answering matters: variables set on Preview do not
  // reach Production, and variables added after the last deploy do not reach
  // anything until it is redeployed.
  return el('div', { class: 'setup-meta' },
    el('div', {}, el('span', {}, 'Environment'), el('code', {}, d.vercelEnv || 'unknown')),
    d.branch ? el('div', {}, el('span', {}, 'Branch'), el('code', {}, d.branch)) : null,
    d.commit ? el('div', {}, el('span', {}, 'Commit'), el('code', {}, d.commit)) : null,
    el('div', {}, el('span', {}, 'Variables present'), el('code', {}, String(d.envCount || 0))));
}

export function renderSetup(root) {
  const missing = (state.status && state.status.setupMissing) || [];
  const seen = (state.status && state.status.envSeen) || [];
  const d = (state.status && state.status.deployment) || {};

  root.append(el('div', { class: 'setup-wrap' },
    el('div', { class: 'setup-card' },
      el('div', { class: 'row', style: { gap: '10px', marginBottom: '18px' } },
        el('span', { class: 'brand-mark' }, icon('gamepad')),
        el('strong', { style: { fontSize: '17px' } }, 'meamus')),

      el('h1', { style: { fontSize: '24px', margin: '0 0 8px', letterSpacing: '-.02em' } },
        'This deployment is not finished'),
      el('p', { class: 'muted', style: { margin: '0 0 22px' } },
        'Building a game needs an account, and an account needs somewhere to live. '
        + 'Until the database is connected, nobody can sign in — so the product is '
        + 'showing you this instead of a sign-up form that would fail.'),

      el('div', { class: 'setup-list' },
        missing.map((item) => el('div', { class: 'setup-item' },
          el('code', { class: 'setup-key' }, item.key),
          el('span', { class: 'muted small' }, item.why)))),

      // The single most useful thing this screen can say: you did set a
      // variable, it is just not the name the app reads.
      (state.status.envSuspicious || []).length
        ? el('div', { class: 'setup-typo' },
          el('strong', {}, 'These look like they were meant to be something else'),
          (state.status.envSuspicious || []).map((entry) => el('div', { class: 'setup-typo-row' },
            el('code', { class: 'wrong' }, entry.name),
            icon('arrowRight', 'sm'),
            el('code', { class: 'right' }, entry.didYouMean))),
          el('span', { class: 'muted small' },
            'Rename them and redeploy. The app only reads the names on the right.'))
        : null,

      deploymentLine(),

      el('div', { class: 'setup-note' },
        el('strong', {}, 'Two things trip this up most often. '),
        'A variable added to Preview does not reach Production — set it on every '
        + 'environment. And a variable added after the last deploy does not take '
        + 'effect until you redeploy.'),

      seen.length
        ? el('p', { class: 'faint small', style: { margin: '16px 0 0' } },
          'Variables this server can currently see: ',
          seen.map((n, i) => el('span', {}, i ? ', ' : '', el('code', {}, n))))
        : el('p', { class: 'faint small', style: { margin: '16px 0 0' } },
          'This server can see no configuration variables at all.'),

      el('p', { class: 'faint small', style: { margin: '10px 0 0' } },
        'Names only — values are never reported. Live status: ',
        el('a', { href: '/api/status', target: '_blank', rel: 'noopener' }, '/api/status')))));
}
