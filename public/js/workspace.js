/* =============================================================================
 * Project workspace: chat thread on the left, live game on the right.
 * ========================================================================== */

import { el, icon, toast, clear, playModal, relativeTime, escapeHtml, quotaLabel, creditChip } from './ui.js';
import { state, projects, builds, playUrl, download } from './api.js';
import { buildPanel, buildLine, buildStage, artifactChips, errorNotice, humanMs } from './build.js';
import { attachToBuild } from './generate.js';
import * as watcher from './watcher.js';
import { createComposer } from './composer.js';

const TABS = [
  { id: 'preview', label: 'Preview', icon: 'globe' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'spec', label: 'Spec', icon: 'layers' }
];

export async function renderWorkspace(root, projectId) {
  const shell = el('div', { class: 'ws' });
  root.append(shell);

  // Reuse the project the create flow already fetched; otherwise load it.
  let data = state.project && state.project.game.id === projectId ? state.project : null;
  if (!data) {
    shell.append(el('div', { class: 'stage', style: { flex: '1' } },
      el('div', { class: 'stage-inner' }, el('div', { class: 'row', style: { gap: '10px' } },
        el('span', { class: 'spinner ink' }), el('span', { class: 'muted' }, 'Opening project…')))));
    try {
      const result = await projects.get(projectId);
      data = { game: result.game, spec: result.spec, meta: result.meta, messages: result.messages || [] };
      state.project = data;
    } catch (err) {
      clear(shell).append(el('div', { class: 'main' },
        el('h1', { class: 'greet' }, err.status === 404 ? 'Project not found' : 'Could not open this project'),
        el('p', { class: 'muted' }, err.message),
        el('button', { class: 'btn primary', onClick: () => { location.hash = '#/dashboard'; } }, 'Back to dashboard')));
      return;
    }
    clear(shell);
  }

  // A build started from the dashboard hands the workspace its id, so the
  // founder lands here and watches it rather than watching a card elsewhere.
  // A build in flight for this game, whether this screen started it or the
  // founder wandered off and came back. Coming back to your own build and
  // finding a dead "Still building" panel is the version of this that loses
  // people, so the watcher is asked too, not just the create flow.
  const inFlight = watcher.forGame(projectId);
  const pending = (state.pendingBuild && state.pendingBuild.gameId === projectId)
    ? state.pendingBuild
    : (inFlight ? inFlight.info : null);
  if (state.pendingBuild && state.pendingBuild.gameId === projectId) state.pendingBuild = null;

  const view = {
    tab: 'preview',
    device: 'desktop',
    chatOpen: true,
    busy: false,
    frameKey: 0,
    building: null   // the live stage that replaces the preview during a build
  };

  /* --- stage (right side) ---------------------------------------------- */
  const stageInner = el('div', { class: 'stage-inner' });
  const stage = el('div', { class: 'stage' }, stageInner);

  function paintStage() {
    clear(stageInner);
    stageInner.style.padding = view.building ? '0' : (view.tab === 'preview' ? '14px' : '0');
    stageInner.style.alignItems = view.tab === 'preview' ? 'center' : 'stretch';

    if (view.building) {
      stageInner.style.padding = '0';
      stageInner.append(view.building.node);
      return;
    }

    // A game whose build has not landed yet has no spec to preview, no code to
    // show and no spec to inspect. Say so rather than rendering an empty frame.
    if (!data.spec) {
      stageInner.style.padding = '28px';
      stageInner.append(el('div', { class: 'empty', style: { maxWidth: '420px' } },
        el('div', { class: 'feature-icon', style: { margin: '0 auto 14px' } }, icon('sparkles', 'lg')),
        el('h2', { style: { fontSize: '17px' } },
          data.game.status === 'failed' ? 'That build did not finish' : 'Still building'),
        el('p', { class: 'muted' },
          data.game.status === 'failed'
            ? (data.game.description || 'Send the prompt again to retry.')
            : 'This game is being built. It will appear here the moment it lands.')));
      return;
    }

    if (view.tab === 'preview') {
      stageInner.append(el('div', { class: `frame-shell ${view.device === 'phone' ? 'phone' : ''}` },
        el('iframe', {
          key: String(view.frameKey),
          src: `${playUrl(data.game.id)}${playUrl(data.game.id).includes('?') ? '&' : '?'}v=${view.frameKey}`,
          title: `${data.game.title} preview`,
          sandbox: 'allow-scripts allow-same-origin allow-pointer-lock',
          allow: 'autoplay; fullscreen'
        })));
      return;
    }

    if (view.tab === 'code') {
      const js = data.spec.gameCode.javascript;
      stageInner.append(el('div', { class: 'code-pane', style: { margin: '14px' } },
        el('div', { class: 'pane-head' },
          el('span', { class: 'mono faint' },
            `game.js · ${js.split('\n').length} lines · Phaser ${data.spec.runtime.phaserVersion}`),
          el('div', { class: 'row', style: { gap: '6px' } },
            el('button', {
              class: 'btn sm',
              onClick: async (event) => {
                await navigator.clipboard.writeText(js);
                const button = event.currentTarget;
                button.textContent = 'Copied';
                setTimeout(() => { clear(button).append(icon('copy', 'sm'), 'Copy'); }, 1400);
              }
            }, icon('copy', 'sm'), 'Copy'),
            el('button', {
              class: 'btn sm',
              onClick: () => safeDownload(`/games/${data.game.id}/export/spec`)
            }, icon('download', 'sm'), 'spec.json'))),
        el('pre', { class: 'code', html: escapeHtml(js) })));
      return;
    }

    stageInner.append(specPane(data));
  }

  /* --- top bar ---------------------------------------------------------- */
  const seg = el('div', { class: 'seg' },
    TABS.map((tab) => el('button', {
      class: tab.id === view.tab ? 'active' : '',
      onClick: () => {
        view.tab = tab.id;
        [...seg.children].forEach((child, index) => child.classList.toggle('active', TABS[index].id === tab.id));
        paintStage();
      }
    }, icon(tab.icon, 'sm'), el('span', { class: 'hide-sm' }, tab.label))));

  const deviceBtn = el('button', {
    class: 'btn icon sq hide-sm', title: 'Toggle phone width', 'aria-label': 'Toggle phone width',
    onClick: () => {
      view.device = view.device === 'desktop' ? 'phone' : 'desktop';
      clear(deviceBtn).append(icon(view.device === 'phone' ? 'phone' : 'monitor', 'lg'));
      paintStage();
    }
  }, icon('monitor', 'lg'));

  const creditsChip = creditChip(state.user);

  const top = el('header', { class: 'ws-top' },
    el('a', { class: 'brand', href: '#/dashboard', title: 'Back to dashboard' },
      el('span', { class: 'brand-mark' }, icon('gamepad'))),
    el('span', { class: 'ws-title', title: data.game.title }, data.game.title),
    data.game.genre ? el('span', { class: 'tag' }, data.game.genre) : null,
    el('button', {
      class: 'btn icon sq hide-sm', title: 'Toggle the chat panel', 'aria-label': 'Toggle the chat panel',
      onClick: () => {
        view.chatOpen = !view.chatOpen;
        body.classList.toggle('wide', !view.chatOpen);
      }
    }, icon('panel', 'lg')),
    el('span', { class: 'grow', style: { display: 'flex', justifyContent: 'center' } }, seg),
    creditsChip,
    deviceBtn,
    el('button', {
      class: 'btn icon sq', title: 'Restart the game', 'aria-label': 'Restart the game',
      onClick: () => { view.frameKey += 1; paintStage(); }
    }, icon('refresh', 'lg')),
    el('button', {
      class: 'btn icon sq hide-sm', title: 'Open in a new tab', 'aria-label': 'Open in a new tab',
      onClick: () => window.open(playUrl(data.game.id), '_blank', 'noopener')
    }, icon('external', 'lg')),
    el('span', { class: 'divider' }),
    el('button', {
      class: 'btn sm hide-sm',
      onClick: () => playModal(data.game.title, playUrl(data.game.id))
    }, icon('play', 'sm'), 'Play'),
    el('button', { class: 'btn primary sm', onClick: (event) => togglePublish(event) }, icon('rocket', 'sm'), 'Publish'));

  /* --- chat (left side) -------------------------------------------------- */
  const thread = el('div', { class: 'chat-scroll' });

  const composer = createComposer({
    placeholder: 'Ask for a change… "add a boss every 5 waves"',
    compact: true,
    submitLabel: 'Send',
    async onSubmit(text, attachmentIds) {
      if (view.busy) return;
      view.busy = true;
      composer.setBusy(true);

      // Optimistic: the user's turn and a pending card appear immediately.
      thread.append(userBubble({ text, attachments: [], createdAt: new Date().toISOString() }));
      const pending = el('div', { class: 'build-card' },
        el('div', { class: 'thinking' },
          el('span', { class: 'dots' }, el('i'), el('i'), el('i')),
          el('span', {}, 'Reading your message…')));
      thread.append(pending);
      scrollThread();

      try {
        const result = await projects.chat(data.game.id, { message: text, attachmentIds });

        // A question or a clarifying question changes the thread, not the game.
        if (result.kind === 'answer' || result.kind === 'clarify') {
          data.messages = result.messages || data.messages;
          state.project = data;
          composer.clearAll();
          paintThread();
          scrollThread();
          return;
        }

        /* A change inside a project just happens.
        
           The estimate dialog belongs to the decision to start a game - that is
           the moment someone chooses to spend, and it deserves a price. Asking
           again for every tweak after it turns a conversation into a checkout
           queue: type "make the jump higher", press enter, and get a modal
           about credits. Nobody reads the fifth one, and everyone resents it.
        
           The cost is still shown, before and after: the composer footer says
           what a change costs, and the finished turn says what it actually
           took. What is gone is the interruption, not the number. */
        const plan = await builds.plan({ prompt: text, attachmentIds, gameId: data.game.id });

        const { buildId } = await builds.start(plan.planId);
        const panel = buildPanel(buildId);
        pending.replaceWith(panel.node);
        scrollThread();

        // The preview is stale for the whole build. Rather than leave it there
        // looking live, it becomes a stage that reports the real phase.
        const stage = buildStage();
        view.building = stage;
        paintStage();

        const finished = await attachToBuild(buildId, {
          gameId: data.game.id,
          prompt: text,
          onTick: (tick) => {
            panel.update(tick);
            stage.update(tick);
            scrollThread();
          }
        });
        panel.done(finished);
        stage.done();
        view.building = null;

        // The founder navigated away. The build carries on and the watcher
        // will tell them when it lands; there is nothing left to draw here.
        if (finished.state === 'released') return;

        if (finished.state === 'stopped') {
          thread.append(el('div', { class: 'notice' }, icon('alert'),
            el('span', {}, 'Build stopped. Nothing was charged.')));
          scrollThread();
          return;
        }
        if (finished.state === 'failed') {
          const failure = new Error(finished.error || 'The build failed');
          // So the notice can say how far it got, not just that it stopped.
          failure.steps = finished.steps;
          throw failure;
        }

        data = {
          game: finished.game,
          spec: finished.spec,
          meta: finished.meta,
          messages: finished.messages || data.messages
        };
        state.project = data;
        composer.clearAll();
        // The live panel is replaced by the saved turn, so what is on screen is
        // what a reload would show. Two versions of the same chat is how a
        // thread starts lying about itself.
        panel.node.remove();
        paintThread();
        view.frameKey += 1;
        if (state.user && finished.credits) {
          state.user.credits = finished.credits.balance;
          // A chip painted once at mount goes stale and contradicts the chat.
          if (creditsChip) creditsChip.refresh();
          meter.textContent = `${quotaLabel(state.user)} · Enter to send, Shift+Enter for a new line`;
        }
        paintStage();

        // The thread ends on a result, not a progress word, and says what the
        // build actually produced.
        thread.append(el('div', { class: 'done-line' },
          icon('check', 'sm'),
          el('span', {}, `Task complete — ${finished.spec.gameConfig.title} rebuilt in ${humanMs(finished.elapsedMs)}.`),
          finished.credits && finished.credits.charged
            ? el('span', { class: 'faint' }, ` ${finished.credits.charged} credits · ${finished.credits.balance} left`)
            : null));
        // What it produced, as checkable numbers rather than a claim.
        const chips = artifactChips(finished);
        if (chips) thread.append(chips);
        scrollThread();
        toast('Task complete', 'ok');
      } catch (err) {
        const notice = errorNotice(err.message, { steps: err.steps });
        if (pending.isConnected) pending.replaceWith(notice);
        else thread.append(notice);
        scrollThread();
      } finally {
        view.busy = false;
        composer.setBusy(false);
      }
    }
  });

  const meter = el('p', { class: 'faint small', style: { margin: '8px 2px 0' } },
    state.user ? `${quotaLabel(state.user)} · Enter to send, Shift+Enter for a new line` : '');

  const chat = el('div', { class: 'chat' },
    thread,
    el('div', { class: 'chat-foot' }, composer.node, meter));

  const body = el('div', { class: 'ws-body' }, chat, stage);
  shell.append(top, body);

  function scrollThread() {
    requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  }

  function paintThread() {
    clear(thread);
    const messages = data.messages || [];
    if (!messages.length) {
      thread.append(el('div', { class: 'build-card' },
        el('div', { class: 'build-head' },
          el('span', { class: 'ic' }, icon('sparkles', 'sm')),
          el('div', {}, el('h4', {}, data.game.title), el('div', { class: 'sub' }, 'Ready')))));
    }
    for (const message of messages) {
      if (message.role === 'user') { thread.append(userBubble(message)); continue; }
      // An answer or a clarifying question is prose, not a build - rendering it
      // as a build card would claim a rebuild that never happened.
      thread.append(message.kind === 'answer' || message.kind === 'clarify'
        ? replyBubble(message)
        : buildCard(message));
    }
    scrollThread();
  }

  /** A plain prose turn from the assistant: an answer, or a question back. */
  function replyBubble(message) {
    return el('div', { class: `msg reply ${message.kind === 'clarify' ? 'asking' : ''}` },
      el('div', { class: 'bubble' },
        el('div', { class: 'reply-head' },
          icon(message.kind === 'clarify' ? 'alert' : 'sparkles', 'sm'),
          el('span', {}, message.kind === 'clarify' ? 'Need one detail' : 'Answer')),
        el('div', { class: 'reply-body' }, message.text)));
  }

  function userBubble(message) {
    return el('div', { class: 'msg user' },
      el('div', { class: 'bubble' }, message.text),
      (message.attachments || []).length
        ? el('div', { class: 'atts' }, message.attachments.map((att) =>
          att.kind === 'image'
            ? el('img', { src: att.url, alt: att.name, title: att.name, loading: 'lazy' })
            : el('span', { class: 'fdoc' }, icon('file', 'sm'), att.name)))
        : null);
  }

  function buildCard(message) {
    const isLatest = message === data.messages[data.messages.length - 1];
    // With the crew, the body is the account of what it did and `stats` is the
    // one-line shape. Older messages have neither, so the text falls back into
    // the subtitle exactly as it did before.
    const subtitle = message.stats || message.text;
    const body = message.stats ? message.text : null;

    return el('div', { class: `build-card ${isLatest ? 'live' : ''}` },
      el('div', { class: 'build-head' },
        el('span', { class: 'ic' }, icon(message.kind === 'edit' ? 'pencil' : 'sparkles', 'sm')),
        el('div', { style: { minWidth: '0' } },
          el('h4', { title: message.title || data.game.title }, message.title || data.game.title),
          el('div', { class: 'sub' }, subtitle)),
        el('span', { class: 'grow' }),
        el('span', { class: 'faint small nowrap' }, relativeTime(message.createdAt))),

      body ? el('div', { class: 'build-summary' }, ...summaryLines(body)) : null,
      (message.issues || []).length
        ? el('div', { class: 'build-issues' },
          message.issues.map((text) => el('div', { class: 'build-issue' }, icon('alert', 'sm'), el('span', {}, text))))
        : null,
      (message.transcript || []).length ? transcriptBlock(message.transcript) : null,

      isLatest
        ? el('div', { class: 'build-actions' },
          el('button', {
            class: 'btn sm',
            onClick: () => {
              view.tab = 'spec';
              [...seg.children].forEach((child, index) => child.classList.toggle('active', TABS[index].id === 'spec'));
              paintStage();
            }
          }, 'Details'),
          el('button', {
            class: 'btn sm primary',
            onClick: () => playModal(data.game.title, playUrl(data.game.id))
          }, icon('play', 'sm'), 'Preview'))
        : null);
  }

  /**
   * The summary body, one paragraph per line.
   *
   * The crew writes `**Title** — pitch` on the first line. Rendering the two
   * asterisks literally would be worse than plain text, so that one marker is
   * honoured and nothing else is: this is a summary, not a markdown document,
   * and anything more would need escaping the whole string first.
   */
  function summaryLines(text) {
    return String(text).split('\n').filter(Boolean).map((line) => {
      const bold = line.match(/^\*\*(.+?)\*\*(.*)$/);
      return bold
        ? el('p', {}, el('strong', {}, bold[1]), bold[2])
        : el('p', {}, line);
    });
  }

  /**
   * The crew's handoffs, replayed.
   *
   * Collapsed by default. It is genuinely interesting the first time and noise
   * on the twentieth, and the founder is the one who gets to decide which of
   * those they are on.
   */
  function transcriptBlock(transcript) {
    const details = el('details', { class: 'transcript' },
      el('summary', {}, icon('layers', 'sm'),
        el('span', {}, `${transcript.length} steps · Designer → Coder → Tester → Reviewer`)),
      el('div', { class: 'build-log' },
        // The saved transcript has the same shape as a live step, chips and
        // all - so a reload shows what was on screen while it was building,
        // not a thinner version of it.
        transcript.map((entry) => buildLine(entry))));
    return details;
  }

  /* --- publish popover --------------------------------------------------- */
  let pop = null;
  function togglePublish(event) {
    if (pop) { pop.remove(); pop = null; return; }
    event.stopPropagation();

    const shareUrl = `${location.origin}/play/${data.game.id}`;
    const isPublic = data.game.isPublic;

    const visibilityRow = el('button', {
      class: 'url-row',
      style: { width: '100%', cursor: 'pointer', textAlign: 'left', font: 'inherit', marginTop: '8px' },
      onClick: async () => {
        try {
          const { game } = await projects.patch(data.game.id, { isPublic: !data.game.isPublic });
          data.game = game;
          pop.remove();
          pop = null;
          togglePublish(event);
          toast(game.isPublic ? 'Anyone with the link can play it' : 'Back to private', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      }
    }, icon(isPublic ? 'globe' : 'eye', 'sm'),
    el('span', { class: 'grow' }, isPublic ? 'Visible to anyone with the link' : 'Private — only you'),
    icon('chevronRight', 'sm'));

    pop = el('div', { class: 'pop' },
      el('div', { class: 'spread' },
        el('h3', { style: { margin: 0 } }, icon('rocket', 'sm'), 'Publish'),
        el('button', { class: 'btn icon sq', onClick: () => { pop.remove(); pop = null; }, 'aria-label': 'Close' }, icon('x', 'sm'))),
      el('p', { class: 'faint small', style: { margin: '2px 0 14px' } },
        `Last built ${relativeTime(data.game.updatedAt || data.game.createdAt)}`),

      el('div', { class: 'spread', style: { marginBottom: '7px' } },
        el('span', { class: 'small', style: { fontWeight: '580' } }, 'Share link'),
        el('span', { class: 'tag' }, data.spec.gameConfig.difficulty)),
      el('div', { class: 'url-row' },
        icon('globe', 'sm'),
        el('span', { class: 'u' }, shareUrl),
        el('button', {
          class: 'btn icon sq', title: 'Copy link', 'aria-label': 'Copy link',
          onClick: async (copyEvent) => {
            await navigator.clipboard.writeText(shareUrl);
            toast('Link copied', 'ok');
            copyEvent.stopPropagation();
          }
        }, icon('copy', 'sm'))),
      visibilityRow,

      el('div', { style: { height: '18px' } }),
      el('div', { class: 'stack' },
        el('button', {
          class: 'btn block',
          onClick: () => safeDownload(`/games/${data.game.id}/export/html`)
        }, icon('download', 'sm'), 'Download standalone HTML'),
        el('button', {
          class: 'btn primary block',
          onClick: () => {
            if (!state.user || state.user.plan !== 'pro') {
              toast('Android export needs the Pro plan', 'warn');
              location.hash = '#/pricing';
              return;
            }
            safeDownload(`/games/${data.game.id}/export/apk`);
          }
        }, icon('rocket', 'sm'),
        state.user && state.user.plan === 'pro' ? 'Export Android project' : 'Export Android project · Pro')));

    shell.append(pop);
    // Any click outside the popover dismisses it.
    setTimeout(() => document.addEventListener('click', function dismiss(clickEvent) {
      if (pop && !pop.contains(clickEvent.target)) {
        pop.remove();
        pop = null;
        document.removeEventListener('click', dismiss);
      }
    }), 0);
  }

  paintThread();
  paintStage();

  // A build already in flight for this game: show it here, live, from the
  // moment the workspace opens.
  if (pending) watchFirstBuild(pending);

  /**
   * Attach to the build that brought us here.
   *
   * The founder can close the tab at any point - the game row already exists
   * server-side and the build keeps going, so nothing is lost either way.
   */
  async function watchFirstBuild(info) {
    view.busy = true;
    composer.setBusy(true);

    const panel = buildPanel(info.buildId);
    thread.append(panel.node);
    const stage = buildStage();
    view.building = stage;
    paintStage();
    scrollThread();

    const finished = await attachToBuild(info.buildId, {
      onTick: (tick) => { panel.update(tick); stage.update(tick); scrollThread(); }
    }).catch((err) => ({ state: 'failed', error: err.message }));

    panel.done(finished);
    stage.done();
    view.building = null;
    view.busy = false;
    composer.setBusy(false);

    // Same as above: this screen is gone, the build is not.
    if (finished.state === 'released') return;

    if (finished.state !== 'done') {
      thread.append(finished.state === 'stopped'
        ? el('div', { class: 'notice' }, icon('alert'),
          el('span', {}, 'Build stopped. Nothing was charged.'))
        : errorNotice(finished.error, { steps: finished.steps }));
      paintStage();
      scrollThread();
      return;
    }

    data = {
      game: finished.game,
      spec: finished.spec,
      meta: finished.meta,
      messages: finished.messages || data.messages
    };
    state.project = data;
    view.frameKey += 1;
    if (creditsChip) creditsChip.refresh();
    paintStage();

    // Same reason as above: the saved turn replaces the live panel, so the
    // thread on screen and the thread on the server are the same thread.
    panel.node.remove();
    paintThread();

    thread.append(el('div', { class: 'done-line' },
      icon('check', 'sm'),
      el('span', {}, `Task complete — ${finished.spec.gameConfig.title} is ready in ${humanMs(finished.elapsedMs)}.`),
      finished.credits && finished.credits.charged
        ? el('span', { class: 'faint' }, ` ${finished.credits.charged} credits · ${finished.credits.balance} left`)
        : null));
    const chips = artifactChips(finished);
    if (chips) thread.append(chips);
    scrollThread();
  }
}

async function safeDownload(path) {
  try {
    await download(path);
    toast('Download started', 'ok');
  } catch (err) {
    toast(err.message, 'err', 7000);
  }
}

/* --- spec pane ------------------------------------------------------------ */
function specPane(data) {
  const { spec, meta } = data;
  const section = (title, ...children) => el('section', { style: { marginBottom: '30px' } },
    el('h3', { style: { marginBottom: '12px' } }, title), ...children);

  return el('div', { class: 'spec-pane' }, el('div', { class: 'inner' },
    el('div', { class: 'spread', style: { marginBottom: '6px' } },
      el('h2', { style: { margin: 0 } }, spec.gameConfig.title),
      el('div', { class: 'row', style: { gap: '6px' } },
        el('span', { class: 'tag orange' }, spec.gameConfig.genre),
        el('span', { class: 'tag' }, spec.gameConfig.difficulty),
        el('span', { class: `tag ${meta.mode === 'ai' ? 'green' : ''}` },
          meta.mode === 'ai' ? `ai · ${meta.model || ''}` : `template · ${meta.templateId}`))),
    el('p', { class: 'muted', style: { marginBottom: '26px' } }, spec.gameConfig.description),

    (meta.issues || []).length
      ? el('div', { class: 'notice', style: { marginBottom: '26px' } },
        icon('alert'), el('span', {}, el('strong', {}, 'Notes: '), meta.issues.join(' · ')))
      : null,

    meta.research && meta.research.used
      ? section('Design research',
        el('p', { class: 'muted small' },
          `Grounded in ${meta.research.count} real ${meta.research.categories.join(' / ')} games from `,
          el('a', { href: meta.research.sourceUrl, target: '_blank', rel: 'noopener', style: { color: 'var(--orange)' } }, 'FreeToGame'),
          '. Metadata and design context only — the code is generated fresh.'),
        el('div', { class: 'row', style: { gap: '6px' } },
          meta.research.titles.map((title) => el('span', { class: 'tag' }, title))))
      : null,

    section('Controls', el('dl', { class: 'deflist' },
      el('dt', {}, 'Keyboard'), el('dd', {}, spec.controls.keyboard.join(' · ') || '—'),
      el('dt', {}, 'Touch'), el('dd', {}, spec.controls.touch.join(' · ') || '—'),
      el('dt', {}, 'Mouse'), el('dd', {}, spec.controls.mouse.join(' · ') || '—'))),

    section(`Mechanics (${spec.mechanics.length})`,
      el('div', { class: 'grid c2' }, spec.mechanics.map((mechanic) => el('div', { class: 'card' },
        el('h3', { style: { fontSize: '14.5px', marginBottom: '5px' } }, mechanic.name),
        el('p', { class: 'muted small', style: { margin: '0 0 7px' } }, mechanic.description),
        mechanic.implementation
          ? el('p', { class: 'mono', style: { margin: 0, color: 'var(--orange)' } }, mechanic.implementation)
          : null)))),

    section(`Sprites (${spec.assets.sprites.length})`,
      el('p', { class: 'faint small' },
        'Every sprite is drawn procedurally in the running game. These descriptions ' +
        'are the briefs for an image pipeline that replaces them.'),
      el('div', { class: 'grid c2' }, spec.assets.sprites.map((sprite) => el('div', { class: 'card' },
        el('div', { class: 'row', style: { gap: '6px', marginBottom: '7px' } },
          el('strong', { style: { fontSize: '14px' } }, sprite.name),
          el('span', { class: 'tag' }, sprite.type),
          el('span', { class: 'tag' }, sprite.size)),
        el('p', { class: 'muted small', style: { margin: 0 } }, sprite.description))))),

    section(`Audio (${spec.assets.audio.length})`,
      el('div', { class: 'grid c2' }, spec.assets.audio.map((sound) => el('div', { class: 'card' },
        el('div', { class: 'row', style: { gap: '6px', marginBottom: '6px' } },
          el('strong', { style: { fontSize: '14px' } }, sound.name),
          el('span', { class: 'tag' }, sound.type)),
        el('p', { class: 'muted small', style: { margin: 0 } }, sound.description))))),

    section('Mobile', el('ul', { class: 'ticks' }, spec.mobileOptimizations.map((item) => el('li', {}, item)))),

    section('Monetization',
      el('ul', { class: 'ticks' }, spec.monetizationHooks.map((hook) => el('li', {}, hook))),
      el('p', { class: 'faint small' },
        'These are live call sites in the code (MEAMUS.ads.showBanner / showInterstitial / ' +
        'showRewarded). Point them at your ad network and set MEAMUS.ads.enabled = true.'))));
}
