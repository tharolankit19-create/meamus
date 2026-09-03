/* =============================================================================
 * Builds that outlive the screen that started them.
 *
 * A build takes a couple of minutes, and in that time the founder will open the
 * dashboard, read the pricing page, or go and look at somebody else's game.
 * Two things must not happen when the build lands:
 *
 *   - it must not yank them out of whatever they are reading. A redirect on
 *     completion is the rudest thing a builder does.
 *   - it must not vanish. Before this, the poll loop lived inside the workspace
 *     view; navigating away left it polling a detached DOM and the founder was
 *     never told the game was ready.
 *
 * So polling lives here instead, once per build, for the life of the page. A
 * view subscribes while it is mounted and unsubscribes when it is torn down. If
 * a build finishes with nobody watching, it announces itself in the corner and
 * waits to be clicked.
 * ========================================================================== */

import { el, icon, $ } from './ui.js';
import { builds, state, playUrl } from './api.js';

const POLL_MS = 600;

/** buildId -> { info, view, subs:Set<fn>, finished:boolean, announced:boolean } */
const live = new Map();

/**
 * Start watching a build. Safe to call twice with the same id.
 *
 * @param {{buildId:string, gameId:string, prompt:string}} info
 */
export function track(info) {
  if (live.has(info.buildId)) return live.get(info.buildId);

  const entry = { info, view: null, subs: new Set(), finished: false, announced: false };
  live.set(info.buildId, entry);

  /* Kick off the work, and poll it separately.
   *
   * These are two requests on purpose. The server cannot build after it has
   * responded - on a serverless host the function is frozen the moment it does,
   * which is what left builds dead a few seconds in and rows stuck on
   * "building" for ever. So one request does the building and is awaited by
   * nobody here, and the other asks how it is going.
   *
   * Nothing is done with the result: whatever it says, the poll below sees the
   * same outcome, and a build already claimed by another tab answers 409, which
   * is a correct refusal rather than an error worth showing. */
  builds.run(info.buildId).catch(() => { /* the poll is the source of truth */ });

  void poll(entry);
  return entry;
}

/**
 * Watch a build's progress.
 *
 * The last known state is replayed immediately, so a view that mounts halfway
 * through a build shows the steps already taken instead of starting blank.
 *
 * @returns {() => void} unsubscribe
 */
export function subscribe(buildId, fn) {
  const entry = live.get(buildId);
  if (!entry) return () => {};
  entry.subs.add(fn);
  if (entry.view) fn(entry.view);
  return () => { entry.subs.delete(fn); };
}

/** The live build for a game, if there is one. */
export function forGame(gameId) {
  for (const entry of live.values()) {
    if (!entry.finished && entry.info.gameId === gameId) return entry;
  }
  return null;
}

/**
 * Drop every subscription, because the screen holding them is being replaced.
 *
 * The router has no unmount hook - it clears the host and renders the next
 * view - so this is the signal that the old view is gone. Without it a
 * workspace the founder navigated away from stays subscribed forever, and the
 * watcher goes on believing somebody is looking at a build that nobody can see.
 * That is exactly the case the completion card exists for.
 */
export function releaseAll() {
  for (const entry of live.values()) {
    const subs = [...entry.subs];
    entry.subs.clear();
    for (const fn of subs) {
      try { fn({ state: 'released', steps: (entry.view && entry.view.steps) || [] }); } catch { /* going away anyway */ }
    }
    // A build that finished in the gap between the last poll and this teardown
    // still owes the founder a card.
    if (entry.finished && shouldAnnounce(entry)) announce(entry);
  }
}

async function poll(entry) {
  for (;;) {
    let view;
    try {
      view = await builds.poll(entry.info.buildId);
    } catch (err) {
      // A build the server has forgotten is not worth retrying forever.
      entry.finished = true;
      entry.view = { state: 'failed', error: err.message, steps: (entry.view && entry.view.steps) || [] };
      emit(entry);
      return;
    }

    entry.view = view;
    emit(entry);

    if (view.state !== 'running') {
      entry.finished = true;
      if (shouldAnnounce(entry)) announce(entry);
      // Keep it around briefly so a view opening right now can still read it.
      setTimeout(() => live.delete(entry.info.buildId), 60_000);
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function emit(entry) {
  for (const fn of entry.subs) {
    try { fn(entry.view); } catch { /* a broken listener must not stop the poll */ }
  }
}

/* --- the "it's ready" card ------------------------------------------------ */

/**
 * Whether this build has to speak for itself.
 *
 * The question is not "is anyone subscribed" but "is the founder looking at
 * this game". Those come apart in one real case: a build that finishes in the
 * moment between the create flow starting it and the workspace mounting. There
 * is nobody subscribed yet, but the founder is on their way to the very screen
 * that will show the result — popping a card at them there announces a game
 * they are already staring at, which is the same rudeness as a redirect, only
 * inside out.
 *
 * So the route decides. Anywhere but this game's page, it announces.
 */
function shouldAnnounce(entry) {
  if (entry.announced) return false;
  if (entry.subs.size) return false;

  const gameId = (entry.view && entry.view.game && entry.view.game.id) || entry.info.gameId;
  return !(gameId && location.hash.startsWith(`#/project/${gameId}`));
}

/**
 * The completion popup.
 *
 * It is a card in the corner rather than a modal, on purpose: a modal is a
 * redirect with extra steps. This one waits, and the founder deals with it when
 * they are ready. The line is about the game they asked for, not about the
 * build system - the server writes it from the finished spec.
 */
function announce(entry) {
  entry.announced = true;
  const view = entry.view;
  const host = $('#toasts');
  if (!host) return;

  if (view.state !== 'done') {
    const why = view.state === 'stopped'
      ? 'Build stopped. Nothing was charged.'
      : (view.error || 'That build did not finish.');
    host.append(card({
      kind: 'err',
      line: why,
      title: entry.info.prompt || 'Build failed',
      gameId: entry.info.gameId,
      openLabel: 'See what happened'
    }));
    return;
  }

  const title = (view.game && view.game.title) || 'Your game';
  host.append(card({
    kind: 'ok',
    line: view.hype || `${title} is ready. Go play it 🎮`,
    title,
    gameId: (view.game && view.game.id) || entry.info.gameId,
    playable: true,
    openLabel: 'Open chat'
  }));
}

function card({ kind, line, title, gameId, playable = false, openLabel }) {
  const node = el('div', { class: `ready-card ${kind}`, role: 'status' });
  const dismiss = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 200);
  };

  node.append(
    el('button', {
      class: 'ready-x', type: 'button', 'aria-label': 'Dismiss', onClick: dismiss
    }, icon('x', 'sm')),
    el('div', { class: 'ready-mark' }, icon(kind === 'ok' ? 'gamepad' : 'alert', 'lg')),
    el('div', { class: 'ready-body' },
      el('strong', { class: 'ready-title' }, title),
      el('p', { class: 'ready-line' }, line),
      el('div', { class: 'ready-actions' },
        playable
          ? el('button', {
            class: 'btn primary sm',
            onClick: async () => {
              dismiss();
              const { playModal } = await import('./ui.js');
              playModal(title, playUrl(gameId));
            }
          }, icon('play', 'sm'), 'Play it')
          : null,
        el('button', {
          class: 'btn sm',
          onClick: () => { dismiss(); location.hash = `#/project/${gameId}`; }
        }, openLabel))));

  // Nothing here disappears on a timer. A game the founder waited two minutes
  // for should not be gone because they were reading something else.
  void state;
  return node;
}
