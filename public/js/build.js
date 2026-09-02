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
  const attempt = step.attempt ? ` ${step.attempt}/${step.total}` : '';
  return el('div', { class: `build-line ${step.phase}${step.agent ? ' has-agent' : ''}` },
    el('span', { class: 'build-line-phase' }, (step.agent || step.phase) + attempt),
    el('span', { class: 'build-line-detail' }, step.detail),
    el('span', { class: 'build-line-at mono' }, humanMs(step.at)));
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
      for (const step of view.steps.slice(drawn)) log.append(buildLine(step));
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
