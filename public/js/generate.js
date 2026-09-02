/* =============================================================================
 * Creating a game: quote, approve, watch, open.
 *
 * Shared by the landing hero and the dashboard so both entry points behave
 * identically. The build is no longer one blocking call - the founder approves
 * a price, then watches the agents work with a clock and a stop button.
 * ========================================================================== */

import { el } from './ui.js';
import { state, projects, builds } from './api.js';
import { confirmBuild } from './build.js';
import * as watcher from './watcher.js';

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

  // Polling belongs to the watcher, not to whichever screen happened to start
  // the build. The founder can walk off to the pricing page and the build still
  // finishes, still lands in their library, and still tells them about it.
  const info = { buildId, gameId, prompt: text, startedAt: Date.now() };
  watcher.track(info);

  state.pendingBuild = info;
  state.projectsLoaded = false;   // the list has a new row it has not seen
  location.hash = `#/project/${gameId}`;
  void opts;
  return { buildId, gameId };
}

/**
 * Watch a build to completion from a mounted view.
 *
 * Subscribes to the watcher rather than polling: the workspace can pick up a
 * build it did not start, and can be torn down mid-build without killing it.
 * The founder leaving is not a reason to stop the work.
 */
export function attachToBuild(buildId, { onTick, gameId, prompt } = {}) {
  // Idempotent: a build the watcher already owns is not restarted, and one it
  // has never seen (a change started from the workspace) is picked up here.
  watcher.track({ buildId, gameId, prompt });
  return new Promise((resolve) => {
    // `subscribe` replays the last known state synchronously, so a build that
    // has already finished settles this before `stop` exists. Hence the let and
    // the settled flag rather than the obvious `const stop = subscribe(...)`,
    // which threw "Cannot access 'stop' before initialization" on exactly that
    // path - a build fast enough to beat the screen that started it.
    let stop = null;
    let settled = false;

    const settle = (view) => {
      if (settled) return;
      settled = true;
      // Reporting is the caller's job - it knows whether it has a chat thread
      // to write into or only a corner of the screen. Announcing here too would
      // say the same thing twice.
      if (view.state === 'done') {
        if (state.user && view.credits) state.user.credits = view.credits.balance;
        state.projectsLoaded = false;
      }
      if (stop) stop();
      resolve(view);
    };

    stop = watcher.subscribe(buildId, (view) => {
      // 'released' means the screen holding this went away. The build has not -
      // the watcher keeps it and will announce it - so this just stops here.
      if (view.state === 'released') { settle(view); return; }
      if (onTick) onTick(view);
      if (view.state !== 'running') settle(view);
    });

    if (settled) stop();
  });
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
