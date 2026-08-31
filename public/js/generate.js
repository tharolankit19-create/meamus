/* =============================================================================
 * Project creation. Shared by the landing hero and the dashboard so both
 * entry points behave identically: create, then open the workspace.
 * ========================================================================== */

import { toast } from './ui.js';
import { state, projects } from './api.js';

/**
 * Create a project from a prompt and navigate into its workspace.
 * The pending prompt is stashed so the workspace can render the user's
 * message and a "building…" card while the request is still in flight.
 */
export async function startProject(text, attachmentIds = [], mode = 'build') {
  const result = await projects.create({
    prompt: text,
    attachmentIds,
    forceTemplate: mode === 'template'
  });

  state.project = {
    game: result.game,
    spec: result.spec,
    meta: result.meta,
    messages: result.messages || []
  };
  if (state.user) {
    state.user.usage = result.quota.used;
    if (result.credits) state.user.credits = result.credits.balance;
  }
  state.projects = [result.game, ...state.projects.filter((p) => p.id !== result.game.id)];

  if (result.meta.mode === 'template') {
    toast(`Built from the ${result.meta.templateId} template — add an API key for original generation.`, 'warn', 6500);
  } else {
    const spent = result.credits && result.credits.charged
      ? ` · ${result.credits.charged} credits, ${result.credits.balance} left`
      : '';
    toast(`Task complete — "${result.spec.gameConfig.title}" is ready${spent}`, 'ok');
  }

  location.hash = `#/project/${result.game.id}`;
  return result;
}
