/* =============================================================================
 * Creating a game: quote, approve, watch, open.
 *
 * Shared by the landing hero and the dashboard so both entry points behave
 * identically. The build is no longer one blocking call - the founder approves
 * a price, then watches the agents work with a clock and a stop button.
 * ========================================================================== */

import { toast, el } from './ui.js';
import { state, projects, builds } from './api.js';
import { confirmBuild, watchBuild } from './build.js';

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

  // The server creates the game row before it spends a token and hands back
  // its id, so the workspace can open straight away. Building on the dashboard
  // meant the founder watched a card instead of their game, and closing the
  // tab lost the whole thing.
  const { buildId, gameId } = await builds.start(plan.planId);

  state.pendingBuild = { buildId, gameId, prompt: text, startedAt: Date.now() };
  state.projectsLoaded = false;   // the list has a new row it has not seen
  location.hash = `#/project/${gameId}`;
  void opts;
  return { buildId, gameId };
}

/**
 * Watch a build that is already running and land its result.
 *
 * Split out from startProject so the workspace can pick up a build it did not
 * start - the founder navigated in, or came back to a tab they had left.
 */
export async function attachToBuild(buildId, { onTick } = {}) {
  const view = await watchBuild(buildId, onTick);

  if (view.state === 'stopped') {
    toast('Build stopped. Nothing was charged.', 'warn', 5000);
    return view;
  }
  if (view.state === 'failed') {
    toast(view.error || 'The build failed', 'err', 8000);
    return view;
  }

  if (state.user && view.credits) state.user.credits = view.credits.balance;
  state.projectsLoaded = false;
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
