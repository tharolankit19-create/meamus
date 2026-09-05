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
    const names = new Set((attrs.class || '').split(' '));
    this.classList = { add: (x) => names.add(x), remove: (x) => names.delete(x),
      toggle: (x, yes) => yes ? names.add(x) : names.delete(x), contains: (x) => names.has(x) };
  }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
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
