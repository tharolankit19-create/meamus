/* =============================================================================
 * Running a build, from quote to preview.
 *
 * The founder approves a price once, then watches the agents work: each phase
 * arrives as a line in the chat, a clock runs, and the send button becomes a
 * stop button until it finishes. Shared by the dashboard (new games) and the
 * workspace (changes) so both behave identically.
 * ========================================================================== */

import { el, icon, modal } from './ui.js';
import { builds, state } from './api.js';

const POLL_MS = 600;

/** "2m 30s", "45s" - short enough to sit in a button. */
export function humanSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

export const humanMs = (ms) => humanSeconds(ms / 1000);

/**
 * Ask before spending. Resolves true to build, false to walk away.
 *
 * Shows both numbers on purpose: the expected cost and the worst case if the
 * review loop needs every attempt. Quoting only the happy path would make the
 * confirmation misleading the first time a build needs three tries.
 */
export function confirmBuild(plan) {
  return new Promise((resolve) => {
    let answered = false;
    const { dialog } = modal((close) => {
      const e = plan.estimate;
      const spread = e.credits.worstCase > e.credits.expected;

      return el('div', { class: 'dlg build-confirm' },
        el('div', { class: 'row', style: { gap: '9px', marginBottom: '4px' } },
          el('span', { class: 'brand-mark' }, icon('sparkles')),
          el('h2', { style: { margin: 0, fontSize: '18px' } },
            plan.kind === 'iterate' ? 'Apply this change?' : 'Build this game?')),

        el('p', { class: 'muted small', style: { margin: '0 0 16px' } }, plan.prompt),

        el('div', { class: 'quote' },
          el('div', { class: 'quote-cell' },
            el('span', { class: 'quote-label' }, 'Credits'),
            el('strong', {}, spread ? `${e.credits.expected}–${e.credits.worstCase}` : String(e.credits.expected)),
            el('span', { class: 'quote-sub' }, `${state.user.credits} available`)),
          el('div', { class: 'quote-cell' },
            el('span', { class: 'quote-label' }, 'Time'),
            el('strong', {}, `~${humanSeconds(e.seconds.expected)}`),
            el('span', { class: 'quote-sub' }, `up to ${humanSeconds(e.seconds.worstCase)}`))),

        el('div', { class: 'plan-steps' },
          plan.plan.map((step) => el('div', { class: 'plan-step' },
            el('span', { class: 'plan-dot' }),
            el('div', {},
              el('strong', {}, step.phase),
              el('span', { class: 'muted small' }, step.label))))),

        el('p', { class: 'faint small', style: { margin: '14px 0 0' } }, e.note),

        el('div', { class: 'dlg-actions' },
          el('button', { class: 'btn', onClick: close }, 'Cancel'),
          el('button', {
            class: 'btn primary',
            onClick: () => { answered = true; resolve(true); close(); }
          }, icon('bolt', 'sm'), plan.kind === 'iterate' ? 'Apply it' : 'Build it')));
    });
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

/**
 * Watch a build to completion.
 *
 * @param {string} buildId
 * @param {(view:object) => void} onTick called on every poll, for the live UI
 * @returns {Promise<object>} the finished build view
 */
export async function watchBuild(buildId, onTick) {
  for (;;) {
    const view = await builds.poll(buildId);
    if (onTick) onTick(view);
    if (view.state !== 'running') return view;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * The live panel: a clock, the phase lines as they arrive, and a stop button.
 * Returns the node plus an update() the poller drives.
 */
export function buildPanel(buildId, { onStop } = {}) {
  const clock = el('span', { class: 'build-clock mono' }, '0s');
  const phase = el('span', { class: 'build-phase' }, 'Starting…');
  const log = el('div', { class: 'build-log' });

  const stopBtn = el('button', {
    class: 'btn sm danger', type: 'button',
    onClick: async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
      try { await builds.stop(buildId); } catch { /* it may have just finished */ }
      if (onStop) onStop();
    }
  }, icon('x', 'sm'), 'Stop');

  const node = el('div', { class: 'build-card live build-live' },
    el('div', { class: 'build-head' },
      el('span', { class: 'ic' }, icon('sparkles', 'sm')),
      el('div', { style: { minWidth: 0, flex: '1' } },
        el('h4', {}, 'Agents are building'),
        el('div', { class: 'sub' }, phase)),
      clock,
      stopBtn),
    log);

  // A clock that only moved on each poll would visibly stutter. This one runs
  // locally and the poll corrects it.
  let base = 0;
  let baseAt = Date.now();
  const ticker = setInterval(() => {
    clock.textContent = humanMs(base + (Date.now() - baseAt));
  }, 250);

  let drawn = 0;
  return {
    node,
    update(view) {
      base = view.elapsedMs;
      baseAt = Date.now();
      for (const step of view.steps.slice(drawn)) {
        const attempt = step.attempt ? ` ${step.attempt}/${step.total}` : '';
        log.append(el('div', { class: `build-line ${step.phase}` },
          el('span', { class: 'build-line-phase' }, step.phase + attempt),
          el('span', { class: 'build-line-detail' }, step.detail),
          el('span', { class: 'build-line-at mono' }, humanMs(step.at))));
      }
      drawn = view.steps.length;
      const last = view.steps[view.steps.length - 1];
      if (last) phase.textContent = last.detail;
      if (view.stopRequested) {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
      }
    },
    done() {
      clearInterval(ticker);
      stopBtn.remove();
      node.classList.remove('live');
    }
  };
}
