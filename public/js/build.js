/* =============================================================================
 * Running a build, from quote to preview.
 *
 * The founder approves a price once, then watches the agents work: each phase
 * arrives as a line in the chat, a clock runs, and the send button becomes a
 * stop button until it finishes. Shared by the dashboard (new games) and the
 * workspace (changes) so both behave identically.
 * ========================================================================== */

import { el, icon, modal, clear, spinner } from './ui.js';
import { builds, state } from './api.js';

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

/* Polling lives in watcher.js, not here. It used to be a loop a view owned,
   which meant a build only survived as long as the screen that started it -
   navigate away and the poll ran against a detached DOM and nobody was ever
   told the game was ready. One loop per build, owned by the page, fixed that;
   a second loop here would quietly bring the problem back. */

/**
 * One line in the build log.
 *
 * The label is whoever is speaking. With the crew that is a name — Designer,
 * Coder, Tester — because "the Tester found this" is a sentence a person can
 * follow, and "test" is a word on a screen. Without a crew it falls back to the
 * phase, which is all the single-model path knows.
 *
 * Exported so a finished project can replay the same lines from its saved
 * transcript instead of showing an empty chat above a working game.
 */
export function buildLine(step) {
  const attempt = step.attempt ? ` ${step.attempt}/${step.total || '·'}` : '';

  /* The facts under the sentence, as separate chips.
     
     "Wrote game.js — 340 lines, 12 KB" is a claim; the chips are the same thing
     as fields, which means they can be scanned down the column and compared
     between attempts. Which model answered matters most of all when it is not
     the first one: a build that took two minutes because four models refused
     is a different story from a slow model, and only the chip tells them
     apart. */
  const chips = [];
  if (step.model) {
    chips.push(el('span', { class: 'build-chip model', title: step.model },
      shortModel(step.model),
      step.modelIndex > 1 ? el('em', {}, ` ${step.modelIndex}/${step.modelCount}`) : null));
  }
  if (step.artifact) chips.push(el('span', { class: 'build-chip file mono' }, step.artifact));
  if (step.lines) chips.push(el('span', { class: 'build-chip' }, `${step.lines} lines`));
  if (step.bytes) chips.push(el('span', { class: 'build-chip' }, `${Math.round(step.bytes / 1024)} KB`));
  if (step.scenes) chips.push(el('span', { class: 'build-chip' }, `${step.scenes} scenes`));

  return el('div', { class: `build-line ${step.phase}${step.agent ? ' has-agent' : ''}` },
    el('span', { class: 'build-line-phase' }, (step.agent || step.phase) + attempt),
    el('div', { class: 'build-line-body' },
      el('span', { class: 'build-line-detail' }, step.detail),
      chips.length ? el('span', { class: 'build-chips' }, chips) : null),
    el('span', { class: 'build-line-at mono' }, humanMs(step.at)));
}

/** "nvidia/nemotron-3-super-120b-a12b:free" is unreadable in a chip. */
export function shortModel(id) {
  return String(id).replace(/:free$/, '').split('/').pop().replace(/-\d+b-a\d+b$/, '');
}

/** The agents, in the order they run. The strip shows all of them from the
 *  start, so what has not happened yet is as visible as what has. */
const AGENTS = ['Designer', 'Coder', 'Tester', 'Reviewer', 'Improver'];

/**
 * Who did what, and for how long.
 *
 * A log answers "what just happened"; it does not answer "how far in are we"
 * or "which part is slow", and those are the two questions a founder watching a
 * two-minute build actually has. This reads the same steps and reports, per
 * agent: whether it is waiting, working or finished, how long it has spent, and
 * the one number that says what it produced - lines for the coder, mechanics
 * for the designer, scenes for the tester.
 */
function agentStrip() {
  const cells = new Map();
  const node = el('div', { class: 'agent-strip' },
    AGENTS.map((name) => {
      const time = el('span', { class: 'agent-time mono' }, '');
      const note = el('span', { class: 'agent-note' }, '');
      const cell = el('div', { class: 'agent-cell', 'data-agent': name },
        el('span', { class: 'agent-dot' }),
        el('span', { class: 'agent-name' }, name),
        note, time);
      cells.set(name, { cell, time, note });
      return cell;
    }));

  return {
    node,
    update(view) {
      const steps = view.steps || [];
      const totals = new Map();     // agent -> ms spent
      const notes = new Map();      // agent -> the number worth showing
      let previousAt = 0;
      let previousAgent = null;

      for (const step of steps) {
        // A step reports when its agent FINISHED speaking, so the time belongs
        // to whoever was working up to that point, not to whoever spoke.
        if (previousAgent) {
          totals.set(previousAgent, (totals.get(previousAgent) || 0) + (step.at - previousAt));
        }
        previousAgent = step.agent || previousAgent;
        previousAt = step.at;

        if (step.lines) notes.set(step.agent, `${step.lines} lines`);
        else if (step.scenes) notes.set(step.agent, `${step.scenes} scenes`);
        else if (step.mechanics) notes.set(step.agent, `${step.mechanics} mechanics`);
      }
      // The agent still working owns the time since its last line.
      const now = view.elapsedMs || previousAt;
      if (previousAgent && view.state === 'running') {
        totals.set(previousAgent, (totals.get(previousAgent) || 0) + Math.max(0, now - previousAt));
      }

      const active = view.state === 'running' ? previousAgent : null;
      const seen = new Set(steps.map((s) => s.agent).filter(Boolean));

      for (const [name, { cell, time, note }] of cells) {
        const spent = totals.get(name) || 0;
        cell.classList.toggle('working', name === active);
        cell.classList.toggle('done', seen.has(name) && name !== active);
        time.textContent = spent > 400 ? humanMs(spent) : '';
        note.textContent = notes.get(name) || '';
      }
    }
  };
}

/**
 * A build failure, said plainly.
 *
 * The server's errors are now several sentences and sometimes several
 * paragraphs - "all six models were unavailable, here is what each one said,
 * here are the two ways on" - and putting that through a single inline span
 * collapses the newlines and buries the part the founder can act on. So the
 * first line is the headline, the rest is kept as written, and anything that
 * looks like a machine detail is set in mono where it cannot be mistaken for
 * advice.
 */
export function errorNotice(message, { steps } = {}) {
  const text = String(message || 'The build failed.').trim();
  const [headline, ...rest] = text.split(/\n\n+/);

  /* Where it got to before it stopped. An error on its own does not say
     whether the designer ever answered, and that is the difference between
     "nothing worked" and "it got as far as the code". */
  const reached = (steps || []).filter((s) => s.agent).slice(-1)[0];

  return el('div', { class: 'notice error-notice' },
    icon('alert'),
    el('div', { class: 'error-body' },
      el('strong', {}, headline),
      rest.map((para) => el('p', { class: /:\s*\d{3}\b|\(\w+\)/.test(para) ? 'mono small' : 'small' }, para)),
      reached
        ? el('p', { class: 'faint small' }, `It got as far as ${reached.agent}: ${reached.detail}`)
        : null));
}

/**
 * The live panel: a clock, the phase lines as they arrive, and a stop button.
 * Returns the node plus an update() the poller drives.
 */
/**
 * One file, as a card.
 *
 * The panel used to be a scrolling log of sentences, which is what a terminal
 * looks like and not what a person reading a chat wants. A build produces a
 * small number of real things - a brief, the game code, the page it ships in -
 * and each of those is worth a card that says what it is, how long it took, and
 * what changed in it. Prose stays prose, in the chat, around the cards.
 *
 * The files are the ones that actually exist. Sprites and sound live inside
 * game.js - they are drawn and synthesised, not downloaded - so they are named
 * in that card's line rather than invented as files of their own.
 */
function artifactCard(name) {
  const KIND = {
    'brief.json': { icon: 'layers', what: 'the design brief' },
    'game.js': { icon: 'code', what: 'the game' },
    'index.html': { icon: 'rocket', what: 'the page it ships in' }
  }[name] || { icon: 'file', what: '' };

  const timer = el('span', { class: 'artifact-time mono' }, '0.0s');
  const detail = el('div', { class: 'artifact-detail' }, KIND.what);
  const stats = el('div', { class: 'artifact-stats' });
  const state = el('span', { class: 'artifact-state' }, 'writing');

  const node = el('article', { class: 'artifact-card is-writing' },
    el('span', { class: 'artifact-icon' }, icon(KIND.icon, 'sm')),
    el('div', { class: 'artifact-body' },
      el('div', { class: 'artifact-head' },
        el('span', { class: 'artifact-name mono' }, name),
        state,
        el('span', { class: 'grow' }),
        timer),
      detail,
      stats));

  /* The timer runs locally rather than moving on each poll. A counter that
     jumps three seconds every three seconds is not a counter, it is a clock
     being read out - and the whole point of showing it is that something is
     happening between the polls too. */
  let startedAt = Date.now();
  let ticking = null;
  const tick = () => { timer.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`; };

  const start = (at) => {
    startedAt = Date.now() - (at || 0);
    node.classList.add('is-writing');
    node.classList.remove('is-done');
    state.textContent = 'writing';
    if (!ticking) ticking = setInterval(tick, 100);
    tick();
  };

  const finish = (step) => {
    if (ticking) { clearInterval(ticking); ticking = null; }
    node.classList.remove('is-writing');
    node.classList.add('is-done');
    state.textContent = 'built';
    if (step.detail) detail.textContent = step.detail;

    clear(stats);
    if (step.added || step.removed) {
      stats.append(
        el('span', { class: 'diff-add' }, `+${step.added || 0}`),
        el('span', { class: 'diff-del' }, `−${step.removed || 0}`),
        step.exactDiff === false
          ? el('span', { class: 'faint small' }, 'approx.')
          : null);
    }
    if (step.model) stats.append(el('span', { class: 'artifact-model' }, shortModel(step.model)));
  };

  return { node, name, start, finish, stop: () => { if (ticking) clearInterval(ticking); } };
}

/**
 * The live panel: what the crew is doing, as chat plus file cards.
 *
 * Returns the node plus an update() the poller drives.
 */
export function buildPanel(buildId, { onStop } = {}) {
  const clock = el('span', { class: 'build-clock mono' }, '0s');
  const phase = el('span', { class: 'build-phase' }, 'Reading what you asked for…');

  const stopBtn = el('button', {
    class: 'btn sm danger', type: 'button',
    onClick: async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
      try { await builds.stop(buildId); } catch { /* it may have just finished */ }
      if (onStop) onStop();
    }
  }, icon('x', 'sm'), 'Stop');

  const files = el('div', { class: 'artifact-list' });
  const log = el('div', { class: 'build-log' });
  const strip = agentStrip();

  /* The opening line. It is prose, in the chat, not another box - a founder
     starting a build wants to be told the work has begun in a sentence, and
     then shown the pieces as they land. */
  const opening = el('p', { class: 'build-say' },
    'I have read your prompt and everything you attached. Building it now — '
    + 'each file appears below as it is written.');

  const node = el('div', { class: 'build-activity live' },
    opening,
    el('div', { class: 'build-status' },
      el('span', { class: 'build-pulse' }),
      el('span', { class: 'build-phase-wrap' }, phase),
      clock,
      stopBtn),
    files,
    strip.node,
    el('details', { class: 'build-log-wrap' },
      el('summary', {}, 'Every step'),
      log));

  let base = 0;
  let baseAt = Date.now();
  const ticker = setInterval(() => {
    clock.textContent = humanMs(base + (Date.now() - baseAt));
  }, 250);

  const cards = new Map();
  let drawn = 0;

  const applyArtifact = (step) => {
    let card = cards.get(step.artifact);
    if (!card) {
      card = artifactCard(step.artifact);
      cards.set(step.artifact, card);
      files.append(card.node);
    }
    if (step.artifactState === 'writing') card.start();
    else card.finish(step);
  };

  return {
    node,
    update(view) {
      base = view.elapsedMs;
      baseAt = Date.now();

      for (const step of view.steps.slice(drawn)) {
        if (step.artifact) applyArtifact(step);
        log.append(buildLine(step));
      }
      drawn = view.steps.length;

      const last = view.steps[view.steps.length - 1];
      if (last) phase.textContent = last.agent ? `${last.agent} · ${last.detail}` : last.detail;
      strip.update(view);

      if (view.stopRequested) {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
      }
    },

    /**
     * The closing line: what happened, in a sentence, and what to do next.
     *
     * Prose again, not a box. The boxes are the files; this is the part that
     * tells a founder the thing is finished and playable, which is the only
     * sentence they were waiting for.
     */
    done(view) {
      clearInterval(ticker);
      for (const card of cards.values()) card.stop();
      stopBtn.remove();
      node.classList.remove('live');
      if (view) strip.update(view);

      const built = [...cards.values()].filter((c) => c.node.classList.contains('is-done'));
      if (!view || view.state !== 'done') return;

      const scenes = (view.steps || []).reduce((n, s) => Math.max(n, s.scenes || 0), 0);
      const ran = scenes
        ? `Every scene was constructed and ticked — ${scenes} of them — before it shipped.`
        : 'It was booted and ticked before it shipped.';

      node.append(el('p', { class: 'build-say build-say-done' },
        `Done. ${built.length} file${built.length === 1 ? '' : 's'} written in `
        + `${humanMs(view.elapsedMs)}. ${ran} `,
        el('strong', {}, 'You can play it now — it is running on the right.')));
    }
  };
}

/* --------------------------------------------------------------------------
 * The stage while a build runs.
 *
 * An empty frame for two minutes reads as a hang. This fills it with the one
 * thing that is actually true at each moment: the phase the agents are in.
 *
 * The hints rotate, but they are not filler - each set is tied to the phase on
 * screen, so reading them tells you something about what is happening rather
 * than about the product. They pause on hover and on focus, and can be paused
 * outright; with prefers-reduced-motion they do not rotate at all.
 * ------------------------------------------------------------------------ */

const PHASE_COPY = {
  analyse: {
    title: 'Reading your brief',
    hints: [
      'Picking the genre, the core loop and the control scheme.',
      'Grounding the design in real games from the same genre.'
    ]
  },
  design: {
    title: 'Designing your game',
    hints: [
      'The designer settles the genre, the core loop and the fail state first.',
      'Three to six mechanics, all reachable in the first thirty seconds.',
      'The coder builds this brief — it does not get to invent a different game.'
    ]
  },
  build: {
    title: 'Writing the game',
    hints: [
      'Writing game.js — the scenes, the physics and the whole loop.',
      'Every sprite is drawn in code — nothing is downloaded.',
      'Sound is synthesised at runtime, so the file stays small.',
      'Keyboard, mouse and touch controls are written together.'
    ]
  },
  review: {
    title: 'Reviewing the code',
    hints: [
      'A reviewer reads the game back against the brief it was built from.',
      'It is looking for controls that do nothing and scores that cannot go up.',
      'A stub or a half-file is rejected rather than shipped.'
    ]
  },
  improve: {
    title: 'Applying the review',
    hints: [
      'Only what the reviewer flagged is changed — nothing else is touched.',
      'If a fix breaks the game, the version that passed is the one you get.'
    ]
  },
  test: {
    title: 'Test-running the game',
    hints: [
      'Every scene is booted and ticked before you ever see it.',
      'A game that throws on start is sent back, not shipped.',
      'This is the check that stops black screens reaching you.'
    ]
  },
  repair: {
    title: 'Fixing what the review caught',
    hints: [
      'The failure is handed back with the reason, not just retried.',
      'Only the attempts that produced something are charged for.'
    ]
  },
  ship: {
    title: 'Saving your game',
    hints: [
      'Writing game.js, the sprites and the sound cues into one file.',
      'One self-contained HTML file. It runs offline, on any browser.'
    ]
  },
  stopping: { title: 'Stopping', hints: ['Nothing will be charged for a stopped build.'] }
};

const DEFAULT_PHASE = { title: 'Working', hints: ['Setting up the build.'] };

export function buildStage() {
  const mark = el('div', { class: 'stage-mark' }, icon('gamepad', 'lg'));
  const title = el('h3', { class: 'stage-title' }, 'Setting up');
  const hint = el('p', { class: 'stage-hint' }, '');
  const dots = el('div', { class: 'stage-dots' });

  let hints = DEFAULT_PHASE.hints;
  let index = 0;
  let paused = false;
  let timer = null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function paintHint() {
    hint.classList.remove('in');
    // Next frame, so the animation restarts rather than being a no-op.
    requestAnimationFrame(() => {
      hint.textContent = hints[index] || '';
      hint.classList.add('in');
    });
    clear(dots).append(...hints.map((_, i) => el('span', {
      class: `stage-dot ${i === index ? 'on' : ''}`
    })));
    dots.classList.toggle('hide', hints.length < 2);
  }

  function advance() {
    if (paused || hints.length < 2) return;
    index = (index + 1) % hints.length;
    paintHint();
  }

  const pauseBtn = el('button', {
    class: 'stage-pause', type: 'button',
    title: 'Pause the hints', 'aria-label': 'Pause the hints',
    onClick: () => {
      paused = !paused;
      pauseBtn.classList.toggle('on', paused);
      pauseBtn.title = paused ? 'Resume the hints' : 'Pause the hints';
    }
  }, icon('pause', 'sm'));

  const node = el('div', { class: 'build-stage' },
    el('div', { class: 'stage-inner-block' },
      mark,
      el('div', { class: 'stage-live', role: 'status', 'aria-live': 'polite' }, title),
      hint,
      el('div', { class: 'stage-foot' }, dots, hints.length > 1 ? pauseBtn : pauseBtn)));

  // Rotation pauses while a pointer or keyboard focus is on the stage, so
  // nobody loses a line they were halfway through reading.
  node.addEventListener('mouseenter', () => { paused = true; });
  node.addEventListener('mouseleave', () => { if (!pauseBtn.classList.contains('on')) paused = false; });

  if (!reduced) timer = setInterval(advance, 3800);
  paintHint();

  let lastPhase = null;
  return {
    node,
    /** Drive the stage from the real build steps. */
    update(view) {
      const step = view.steps[view.steps.length - 1];
      const phase = (step && step.phase) || 'analyse';
      if (phase === lastPhase) return;
      lastPhase = phase;

      const copy = PHASE_COPY[phase] || DEFAULT_PHASE;
      title.textContent = copy.title;
      hints = copy.hints;
      index = 0;
      paintHint();
      node.classList.toggle('is-repair', phase === 'repair');
      node.classList.toggle('is-test', phase === 'test');
    },
    done() { if (timer) clearInterval(timer); }
  };
}

/**
 * What a finished build actually produced, as chips.
 *
 * Reported from the spec rather than narrated, so the numbers are checkable
 * against the code the founder can open in the next tab.
 */
export function artifactChips(view) {
  const spec = view.spec;
  if (!spec) return null;
  const chips = [
    ['file', 'game.js', `${spec.gameCode.javascript.split('\n').length} lines`],
    ['image', 'sprites', `${spec.assets.sprites.length}`],
    ['bolt', 'mechanics', `${spec.mechanics.length}`]
  ];
  if (view.meta && view.meta.attempts > 1) {
    chips.push(['refresh', 'attempts', String(view.meta.attempts)]);
  }
  return el('div', { class: 'artifact-chips' },
    chips.map(([ic, name, value]) => el('span', { class: 'artifact-chip' },
      icon(ic, 'sm'),
      el('code', {}, name),
      el('b', {}, value))));
}
