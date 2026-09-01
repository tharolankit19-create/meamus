/* =============================================================================
 * Creating a game: quote, approve, watch, open.
 *
 * Shared by the landing hero and the dashboard so both entry points behave
 * identically. The build is no longer one blocking call - the founder approves
 * a price, then watches the agents work with a clock and a stop button.
 * ========================================================================== */

import { toast, el, clear } from './ui.js';
import { state, projects, builds } from './api.js';
import { confirmBuild, watchBuild, buildPanel, buildStage, artifactChips } from './build.js';

/**
 * Quote a build, ask, run it.
 *
 * @param {string} text what the founder typed
 * @param {string[]} attachmentIds
 * @param {object} [opts]
 * @param {HTMLElement} [opts.host] where to mount the live panel
 * @returns {Promise<object|null>} the finished build, or null if declined
 */
export async function startProject(text, attachmentIds = [], opts = {}) {
  const plan = await builds.plan({ prompt: text, attachmentIds });

  if (!await confirmBuild(plan)) return null;

  const { buildId } = await builds.start(plan.planId);
  const panel = buildPanel(buildId);
  const stage = buildStage();

  // The first build has no preview to stale out, so the stage sits beside the
  // log: what is happening on the left, why it takes a moment on the right.
  if (opts.host) {
    clear(opts.host);
    opts.host.style.gridTemplateColumns = '1fr';
    opts.host.append(el('div', { class: 'first-build' },
      panel.node,
      el('div', { class: 'first-build-stage' }, stage.node)));
  }

  const view = await watchBuild(buildId, (tick) => { panel.update(tick); stage.update(tick); });
  panel.done();
  stage.done();

  if (view.state === 'stopped') {
    toast('Build stopped. Nothing was charged.', 'warn', 5000);
    return null;
  }
  if (view.state === 'failed') {
    throw new Error(view.error || 'The build failed');
  }

  if (state.user && view.credits) state.user.credits = view.credits.balance;
  state.project = { game: view.game, spec: view.spec, meta: view.meta, messages: view.messages || [] };
  state.projects = [view.game, ...state.projects.filter((p) => p.id !== view.game.id)];

  const spent = view.credits ? ` · ${view.credits.charged} credits, ${view.credits.balance} left` : '';
  toast(`Task complete — "${view.spec.gameConfig.title}" is ready${spent}`, 'ok', 6000);
  void artifactChips;

  location.hash = `#/project/${view.game.id}`;
  return view;
}

/** A one-line summary of what a finished build produced, for the chat. */
export function buildSummary(view) {
  const spec = view.spec;
  return el('span', {},
    `${spec.gameCode.javascript.split('\n').length} lines · `,
    `${spec.assets.sprites.length} sprites · `,
    `${spec.mechanics.length} mechanics`,
    view.meta && view.meta.attempts > 1 ? ` · ${view.meta.attempts} attempts` : '');
}
