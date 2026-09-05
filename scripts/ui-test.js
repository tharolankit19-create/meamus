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
})().catch((err)=> { console.error(err); process.exitCode=1; });
