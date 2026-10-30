'use strict';
// RP38: the "Roadmap conformity" drawer already lists every repo with the requirements that do not pass. Each repo that
// has a gap now carries a "Put in conditions" button there, the same action as the card's menu (so it keeps the
// protection against a second click from RP33). Nothing is sent to a session by these tests: the fetch is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const lf = (text) => text.replace(/\r\n/g, '\n');
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage(routes = {}) {
  const app = { innerHTML: '' };
  const drawer = { innerHTML: '', hidden: true };
  const calls = [];
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, {
      get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === '#app' ? app : sel === '#drawerBody' ? drawer : sel === '#confBadge' ? { hidden: false, textContent: '' } : stub())
        : k === 'addEventListener' ? () => {} : stub),
    }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 1,
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET' });
      const route = routes[url.split('?')[0]];
      if (!route) throw new Error('offline');
      const a = await route(opts && opts.body ? JSON.parse(opts.body) : null, url);
      return { ok: a.status === undefined || a.status < 400, status: a.status || 200, statusText: 'x', json: async () => a.json };
    },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(lf(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  calls.length = 0;
  return { get: (name) => vm.runInContext(name, ctx), drawer, calls, posts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/pi') };
}

const R = { id: 'abc', name: 'demo', path: 'x', group: 'g' };
const R2 = { id: 'def', name: 'other', path: 'y', group: 'g' };
const result = (o = {}) => ({ id: 'agents-file', title: 'AGENTS.md on the base branch', category: 'verificable', level: 'required', status: 'fail', detail: 'missing', remedy: 'Create AGENTS.md', ...o });
const entry = (results) => ({ state: 'loaded', data: { results, summary: { ready: results.every((x) => x.status === 'pass'), required: { pass: 0, total: 1 }, recommended: { pass: 0, total: 0 } } } });

function open(page, repos, reqs) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos }];
  S.confOpen = true;
  for (const [id, e] of Object.entries(reqs)) S.req[id] = e;
  page.get('drawConformity')();
  return S;
}
const putButtons = (html) => [...html.matchAll(/<button[^>]*data-act="put-in-conditions"[^>]*>[^<]*<\/button>/g)].map((m) => m[0]);

test('a repo with a requirement that does not pass has a Put in conditions button in the drawer', async () => {
  const page = await loadPage();
  open(page, [R], { [R.id]: entry([result()]) });
  const buttons = putButtons(page.drawer.innerHTML);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /data-id="abc"/);
  assert.match(buttons[0], />Put in conditions</);
  assert.doesNotMatch(buttons[0], /disabled/);
});

test('a recommended gap counts too: the card menu offers the action for any open requirement', async () => {
  const page = await loadPage();
  open(page, [R], { [R.id]: entry([result({ id: 'estado-block', level: 'recommended' })]) });
  assert.equal(putButtons(page.drawer.innerHTML).length, 1);
});

test('a repo that meets everything has no button, and neither has one that has not answered yet or failed to load', async () => {
  const page = await loadPage();
  open(page, [R, R2], { [R.id]: entry([result({ status: 'pass' })]), [R2.id]: { state: 'failed' } });
  assert.equal(putButtons(page.drawer.innerHTML).length, 0);
  open(page, [R], {});
  assert.equal(putButtons(page.drawer.innerHTML).length, 0, 'still loading');
});

test('only the repos with a gap get the button, each with its own id', async () => {
  const page = await loadPage();
  open(page, [R, R2], { [R.id]: entry([result({ status: 'pass' })]), [R2.id]: entry([result({ status: 'outdated' })]) });
  const buttons = putButtons(page.drawer.innerHTML);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /data-id="def"/);
});

test('while an order of the repo is on its way the drawer button is disabled', async () => {
  const page = await loadPage();
  const S = open(page, [R], { [R.id]: entry([result()]) });
  S.sending[R.id] = 'put-in-conditions';
  page.get('drawConformity')();
  assert.match(putButtons(page.drawer.innerHTML)[0], /disabled/);
});

test('the button runs the same action as the card menu, so a second click still sends the order once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const page = await loadPage({ '/api/pi': () => gate });
  open(page, [R], { [R.id]: entry([result()]) });
  const act = page.get('ACTIONS')['put-in-conditions'];
  const first = act({ dataset: { id: R.id }, disabled: false });
  const second = act({ dataset: { id: R.id }, disabled: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(page.posts().length, 1);
  release({ json: { sent: true, confirmed: true } });
  await Promise.all([first, second]);
  assert.match(putButtons(page.drawer.innerHTML).join(''), /data-id="abc"/);
});

test('what the drawer already showed is unchanged: the repo name filter, the failing line with its remedy and the passing list', async () => {
  const page = await loadPage();
  open(page, [R], { [R.id]: entry([result(), result({ id: 'base-branch', title: 'Remote base branch exists', status: 'pass' })]) });
  const html = page.drawer.innerHTML;
  assert.match(html, /data-act="queue-pick" data-close="1" data-name="demo"/);
  assert.match(html, /class="conf-line req-fail" title="Create AGENTS\.md"/);
  assert.match(html, /<summary>1 passing<\/summary>/);
  assert.match(html, /Not ready/);
});
