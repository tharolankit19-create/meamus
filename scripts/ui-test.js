#!/usr/bin/env node
'use strict';
// Execute the actual ES modules against a small DOM stand-in; no browser/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.attrs = attrs; this.children = children; this.handlers = {};
    this.value = ''; this.style = {}; this.scrollHeight = 80; this.disabled = attrs.disabled || false;
    /* classList and `class` are the same thing in a browser, so they are the
       same thing here. They used to be a private Set that nothing wrote back
       from, which meant a test reading attrs.class saw the classes an element
       was BORN with and none of the ones it was given afterwards - a fake DOM
       that quietly disagrees with the real one is worse than no fake DOM. */
    const names = new Set((attrs.class || '').split(' ').filter(Boolean));
    const sync = () => { this.attrs.class = [...names].join(' '); };
    this.classList = {
      add: (...xs) => { xs.forEach((x) => names.add(x)); sync(); },
      remove: (...xs) => { xs.forEach((x) => names.delete(x)); sync(); },
      toggle: (x, yes) => { const on = yes === undefined ? !names.has(x) : yes; if (on) names.add(x); else names.delete(x); sync(); },
      contains: (x) => names.has(x)
    };
  }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) {
    for (const n of nodes) { if (n && typeof n === 'object') n.parent = this; }
    this.children.push(...nodes);
  }
  focus() {}
  contains() { return false; }
}
const find = (node, tag) => node.tag === tag ? node : node.children?.map((n) => find(n, tag)).find(Boolean);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
async function load(file, mocks, globals = {}) {
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, ...globals });
  const mod = new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), { context });
  await mod.link((name) => {
    const exports = mocks[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key,value] of Object.entries(exports)) this.setExport(key,value);
    }, { context });
  });
  await mod.evaluate(); return mod.namespace;
}
(async () => {
  const ui = { el: (tag, attrs, ...children) => new Node(tag, attrs, children), icon: () => new Node('svg'),
    toast: () => {}, clear: (n) => { n.children=[]; return n; }, spinner: () => new Node('spinner') };
  const composerModule = await load('composer.js', { './ui.js': ui, './api.js': { api: () => {} } });
  let calls = 0;
  const pending = deferred();
  const composer = composerModule.createComposer({ onSubmit: () => { calls++; return pending.promise; } });
  const input = find(composer.node, 'textarea');
  composer.setValue('a runner');
  const enter = (extra={}) => input.handlers.keydown({ key:'Enter', preventDefault() {}, ...extra });
  enter({ isComposing: true });
  assert.equal(calls, 0, 'IME confirmation must not submit');
  enter(); enter();
  assert.equal(calls, 1, 'duplicate enter must not submit twice');
  pending.reject(new Error('Please retry'));
  await tick();
  assert.equal(composer.getValue(), 'a runner', 'failed submission must retain the prompt');
  const feedback = composer.node.children.find((n) => n.attrs?.role === 'status');
  assert.equal(feedback.textContent, 'Please retry');
  assert.equal(feedback.classList.contains('hide'), false);
  console.log('  ok    IME, duplicate submit, preserved draft and inline error');

  let polls=0;
  const run = deferred();
  const nextPoll = deferred();
  const timers=[];
  const watcher = await load('watcher.js', {
    './ui.js': { ...ui, $: () => null },
    './api.js': { state:{}, playUrl:()=>'', builds: {
      run:()=>run.promise, poll:()=> { polls++; return polls===1 ? Promise.reject(new Error('offline')) : nextPoll.promise; }
    } }
  }, { location:{ hash:'#/project/g1' }, setTimeout:(fn,ms)=> { timers.push({fn,ms}); return timers.length; } });
  watcher.track({ buildId:'b1', gameId:'g1' });
  let view;
  watcher.subscribe('b1', (v)=> { view=v; });
  await tick();
  assert.equal(view, undefined, 'one transient poll failure must not fail the build');
  assert.ok(timers.length);
  timers.shift().fn(); await tick();
  run.resolve({ state:'done', game:{id:'g1'}, steps:[], spec:{} });
  await tick();
  assert.equal(view.state,'done', '/run result must recover progress');
  nextPoll.resolve({state:'running',steps:[]}); await tick();
  assert.equal(view.state,'done', 'late stale poll must not overwrite completion');
  console.log('  ok    poll retry, /run completion, stale progress race');
  /* --- the build panel -----------------------------------------------------
   *
   * A build produces a few real files; each should become a card that says what
   * it is, how long it took and what changed, with prose around them rather
   * than a scrolling log of sentences.
   */
  const panelTimers = new Map();
  let nextTimer = 1;
  const buildModule = await load('build.js', {
    './ui.js': { ...ui, modal: () => ({}), spinner: () => new Node('span') },
    './api.js': { builds: { stop: () => Promise.resolve() }, state: { user: { credits: 100 } } }
  }, {
    setInterval: (fn, ms) => { const id = nextTimer++; panelTimers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => panelTimers.delete(id),
    Date, Math, window: { matchMedia: () => ({ matches: false }) }
  });

  const panel = buildModule.buildPanel('bld_1');
  const cards = () => {
    const found = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.attrs?.class === 'string' && n.attrs.class.includes('artifact-card')) found.push(n);
      for (const child of n.children || []) walk(child);
    };
    walk(panel.node);
    return found;
  };
  const textOf = (n) => {
    let out = '';
    const walk = (x) => {
      if (x == null) return;
      if (typeof x === 'string' || typeof x === 'number') { out += `${x} `; return; }
      if (typeof x !== 'object') return;
      for (const child of x.children || []) walk(child);
    };
    walk(n);
    return out;
  };

  // Nothing has happened yet, so there are no files.
  assert.equal(cards().length, 0, 'a build shows file cards before any file exists');

  // A file that has started being written gets a card immediately - otherwise
  // its live timer has nothing to count from.
  panel.update({ elapsedMs: 100, steps: [
    { at: 0, phase: 'design', agent: 'Designer', detail: 'Designing', artifact: 'brief.json', artifactState: 'writing' }
  ] });
  assert.equal(cards().length, 1, 'a file being written did not appear');
  assert.ok(cards()[0].attrs.class.includes('is-writing'), 'a file in progress is not marked as such');
  assert.ok(panelTimers.size >= 1, 'nothing is ticking, so the live counter is not live');

  // ...and the same file finishing updates that card rather than adding another.
  panel.update({ elapsedMs: 3000, steps: [
    { at: 0, artifact: 'brief.json', artifactState: 'writing' },
    { at: 2000, phase: 'design', agent: 'Designer', detail: 'Dodge Rush — dodge the rocks',
      artifact: 'brief.json', artifactState: 'done', lines: 22, added: 22, removed: 0, exactDiff: true }
  ] });
  assert.equal(cards().length, 1, 'a file finishing added a second card for the same file');
  assert.ok(cards()[0].attrs.class.includes('is-done'), 'a finished file is still shown as writing');
  assert.match(textOf(cards()[0]), /\+22/, 'the lines added were not shown');
  assert.match(textOf(cards()[0]), /−0/, 'the lines removed were not shown');

  // A rewrite reports both directions, and they are the measured ones.
  panel.update({ elapsedMs: 9000, steps: [
    { at: 0, artifact: 'brief.json', artifactState: 'writing' },
    { at: 2000, artifact: 'brief.json', artifactState: 'done', lines: 22, added: 22, removed: 0 },
    { at: 3000, artifact: 'game.js', artifactState: 'writing' },
    { at: 8000, phase: 'build', agent: 'Coder', detail: '412 lines, 14 KB',
      artifact: 'game.js', artifactState: 'done', lines: 412, added: 96, removed: 38,
      exactDiff: true, model: 'dots-studio/dots-3-note-preview:free' }
  ] });
  const game = cards().find((c) => textOf(c).includes('game.js'));
  assert.ok(game, 'the game file never got a card');
  assert.match(textOf(game), /\+96/, 'lines added missing');
  assert.match(textOf(game), /−38/, 'lines removed missing');
  assert.match(textOf(game), /dots-3-note-preview/, 'the model that wrote it is not named');

  // Finishing stops every timer - a card left ticking after the build is over
  // is a counter that lies for as long as the tab stays open.
  panel.done({ state: 'done', elapsedMs: 9000, steps: [{ at: 8000, scenes: 3 }] });
  assert.equal(panelTimers.size, 0, `${panelTimers.size} timers still running after the build finished`);
  assert.match(textOf(panel.node), /You can play it now/, 'the founder is never told it is playable');
  console.log('  ok    files become cards, diffs are shown, and the timers stop');

  /* --- routing ------------------------------------------------------------
   *
   * The landing page was unreachable while signed in: the wordmark, #/home and
   * the bare URL all bounced to the dashboard. Three ways of asking to see the
   * front of the product, all refused, with nothing on screen saying why - so
   * it read as the app being stuck. The decision now lives in one exported
   * function, and this is the whole table.
   */
  const app = await load('app.js', {
    './ui.js': { ...ui, $: () => new Node('div') },
    './api.js': { state:{}, loadStatus:()=>{}, loadSession:()=>{}, onChange:()=>{}, projects:{}, consumeOAuthFragment:()=>{} },
    './landing.js': { renderLanding: ()=>{} },
    './setup.js': { setupRequired: ()=>false, renderSetup: ()=>{} },
    './dashboard.js': { renderDashboard:()=>{}, renderTemplatesPage:()=>{}, renderPricing:()=>{}, sidebar:()=>new Node('aside') },
    './workspace.js': { renderWorkspace: ()=>{} },
    './auth-dialog.js': { openAuth: ()=>Promise.resolve(null) },
    './marketing.js': { renderMarketingTemplates:()=>{}, renderMarketingPricing:()=>{}, renderDocs:()=>{} },
    './watcher.js': { releaseAll: ()=>{} }
  }, {
    location: { hash: '' },
    document: { body: { classList: { toggle: ()=>{} } } },
    window: { addEventListener: ()=>{} }
  });

  const route = (name, signedIn, extra) => app.routeFor({ name, signedIn, ...extra });

  // The bug, from both sides: the home page belongs to everybody.
  assert.equal(route('', true).view, 'landing', 'a signed-in visitor cannot reach the home page');
  assert.equal(route('home', true).view, 'landing', '#/home is refused while signed in');
  assert.equal(route('', false).view, 'landing');
  assert.equal(route('home', false).view, 'landing');
  assert.equal(route('', true).redirect, undefined, 'the home page still redirects somewhere else');

  // Signing in changes which version of a shared page you get, not whether you
  // get one.
  assert.equal(route('templates', false).view, 'marketing-templates');
  assert.equal(route('templates', true).view, 'templates');
  assert.equal(route('pricing', false).view, 'marketing-pricing');
  assert.equal(route('pricing', true).view, 'pricing');
  assert.equal(route('docs', false).view, 'docs');
  assert.equal(route('docs', true).view, 'docs');

  // A signed-out visitor following a project link is asked to sign in, not
  // dumped on the homepage with no explanation.
  for (const name of ['project', 'dashboard', 'account']) {
    const r = route(name, false);
    assert.equal(r.view, 'landing', `${name} should show the landing page to a guest`);
    assert.equal(r.askToSignIn, true, `${name} should ask a guest to sign in`);
  }

  // Signed in, the app routes proper.
  assert.equal(route('project', true, { hasProjectId: true }).view, 'workspace');
  assert.equal(route('project', true, { hasProjectId: false }).redirect, '#/dashboard',
    'a project link with no id must go somewhere, not render an empty workspace');
  assert.equal(route('account', true).view, 'account');
  assert.equal(route('dashboard', true).view, 'dashboard');
  assert.equal(route('anything-else', true).view, 'dashboard');
  console.log('  ok    the home page is reachable signed in, and every other route still lands');
})().catch((err)=> { console.error(err); process.exitCode=1; });
