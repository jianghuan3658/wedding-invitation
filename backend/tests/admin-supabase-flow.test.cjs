'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function element(id = '') {
  const events = new Map();
  let text = '';
  return {
    id, get textContent() { return text; }, set textContent(value) { text = String(value); }, value: '', dataset: {}, children: [], disabled: false,
    hidden: ['dashboard', 'unconfigured', 'logout', 'empty-state'].includes(id),
    addEventListener(name, callback) { events.set(name, callback); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    async emit(name, event = {}) { return events.get(name)?.({ preventDefault() {}, ...event }); },
    click() { this.clicked = true; }
  };
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); }
function row(index, changes = {}) {
  return { id: String(index).padStart(8, '0') + '-0000-4000-8000-000000000000', name: '宾客' + index, people: (index % 4) + 1, createdAt: '2026-10-07T01:00:00Z', submittedAt: '2026-10-07T01:00:00Z', ...changes };
}
async function fixture(options = {}) {
  const nodes = new Map(); const documentEvents = new Map(); const windowEvents = new Map();
  const intervals = new Map(); const watches = []; const requests = []; const exports = []; const accounts = [];
  let timerId = 0; let signedOut = 0;
  const node = id => {
    if (!nodes.has(id)) {
      const created = element(id);
      if (['groups-total', 'people-total', 'duplicate-total', 'last-update'].includes(id)) created.textContent = '—';
      if (id === 'export') created.disabled = true;
      nodes.set(id, created);
    }
    return nodes.get(id);
  };
  const document = { hidden: false, getElementById: node, createElement: () => element(), addEventListener: (name, callback) => documentEvents.set(name, callback) };
  const window = { addEventListener: (name, callback) => windowEvents.set(name, callback) };
  const dependencies = {
    getServiceStatus: () => ({ configured: options.configured !== false }),
    signInAdmin: async credentials => { accounts.push(credentials); if (options.signIn) return options.signIn(credentials); return { user: { id: 'owner', is_anonymous: false } }; },
    signOutAdmin: async () => { signedOut++; if (options.signOut) return options.signOut(); },
    getAdminSession: async () => options.session ?? null,
    authorizeAdmin: async () => { if (options.authorize) return options.authorize(); return { authorized: true }; },
    listRsvps: async payload => { requests.push(payload); if (options.list) return options.list(payload); return { rows: [], nextCursor: null }; },
    watchRsvpChanges: callbacks => {
      if (options.watchThrows) throw new Error('synthetic watch failure');
      const watch = { closed: false, closes: 0, callbacks, close() { this.closed = true; this.closes++; } };
      watches.push(watch); return watch;
    },
    document, window,
    setInterval: (callback, delay) => { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: callback => { callback(); return 0; },
    URL: { createObjectURL: blob => { exports.push(blob); return 'blob:synthetic-export'; }, revokeObjectURL() {} },
    Blob
  };
  // Execute the actual controller, replacing only its module imports with injected
  // service/DOM boundaries; none of the controller's functions are reimplemented.
  const filename = path.resolve(__dirname, '../../assets/admin.js');
  let source = await fs.readFile(filename, 'utf8');
  source = source.replace(/^import[^\n]+\n/u, '').replace('export function csvCell', 'function csvCell');
  const run = new AsyncFunction(...Object.keys(dependencies), source + '\nreturn { csvCell };');
  const module = await run(...Object.values(dependencies));
  const login = async () => { node('account').value = ' owner@example.test '; node('password').value = 'synthetic-password'; return node('login-form').emit('submit'); };
  return { node, nodes, intervals, watches, requests, exports, accounts, document, login, module,
    signedOut: () => signedOut,
    notifyChange: async (watch = watches.at(-1)) => { if (watch && !watch.closed) watch.callbacks.onChange(); await settle(); },
    notifyError: async (watch = watches.at(-1)) => { if (watch && !watch.closed) watch.callbacks.onError(); await settle(); },
    poll: async () => { for (const { callback } of intervals.values()) callback(); await settle(); },
    documentEvent: async name => { documentEvents.get(name)?.({}); await settle(); },
    windowEvent: async (name, event = {}) => { await windowEvents.get(name)?.(event); await settle(); }
  };
}

test('authorization failure keeps private dashboard hidden and does not start polling', async () => {
  const error = Object.assign(new Error('此账号没有查看回执的权限。'), { code: 'FORBIDDEN' });
  const view = await fixture({ authorize: async () => { throw error; } });
  await view.login();
  assert.equal(view.node('dashboard').hidden, true); assert.equal(view.node('login-panel').hidden, false);
  assert.match(view.node('login-error').textContent, /没有查看/);
  assert.equal(view.requests.length, 0); assert.equal(view.watches.length, 0); assert.equal(view.intervals.size, 0);
  assert.equal(view.node('people-total').textContent, '—');
  assert.equal(view.node('login-button').disabled, false);
});

test('all pages contribute to totals; searching does not change attendance totals', async () => {
  const source = Array.from({ length: 205 }, (_, index) => row(index, [1, 2].includes(index) ? { name: '同名宾客' } : {}));
  const view = await fixture({ list: async ({ cursor }) => {
    const start = cursor ? source.findIndex(item => item.id === cursor) + 1 : 0;
    const rows = source.slice(start, start + 100);
    return { rows, nextCursor: start + rows.length < source.length ? rows.at(-1).id : null };
  } });
  await view.login();
  assert.equal(view.node('groups-total').textContent, '205'); assert.equal(view.node('people-total').textContent, '511');
  assert.equal(view.node('duplicate-total').textContent, '1'); assert.equal(view.requests.length, 3);
  assert.equal(view.node('guest-rows').children.length, 205); assert.equal(view.node('password').value, '');
  assert.equal(view.accounts[0].email, 'owner@example.test');
  view.node('search').value = '同名宾客'; await view.node('search').emit('input');
  assert.equal(view.node('guest-rows').children.length, 2); assert.equal(view.node('people-total').textContent, '511');
  assert.match(view.node('list-description').textContent, /全部 205 组 · 当前显示 2 组/);
  await view.node('export').emit('click');
  const csv = await view.exports[0].text();
  assert.equal(csv.split('\r\n').length, 206); assert.match(csv, /同名宾客/);
});

test('Realtime invalidates the full list and a five-second poll survives watch failures', async () => {
  let people = 2;
  const view = await fixture({ list: async () => ({ rows: [row(1, { people })], nextCursor: null }) });
  await view.login();
  assert.deepEqual([...view.intervals.values()].map(item => item.delay), [5000]);
  people = 4; await view.notifyChange();
  assert.equal(view.node('people-total').textContent, '4'); assert.match(view.node('sync-status').textContent, /实时同步中/);
  await view.notifyError(); assert.match(view.node('sync-status').textContent, /已切换每 5 秒/);
  people = 7; await view.poll();
  assert.equal(view.node('people-total').textContent, '7'); assert.match(view.node('sync-status').textContent, /自动刷新中/);
  const requests = view.requests.length;
  view.document.hidden = true; people = 8; await view.poll(); assert.equal(view.requests.length, requests);
  view.document.hidden = false; await view.documentEvent('visibilitychange'); assert.equal(view.node('people-total').textContent, '8');
  const fallback = await fixture({ watchThrows: true }); await fallback.login();
  assert.equal(fallback.intervals.size, 1); assert.match(fallback.node('sync-status').textContent, /自动刷新中/);
});

test('failed reads retain the last successful snapshot and show an error instead of success', async () => {
  let fail = false;
  const view = await fixture({ list: async () => {
    if (fail) throw new Error('synthetic network outage');
    return { rows: [row(1, { people: 6 })], nextCursor: null };
  } });
  await view.login(); const previous = view.node('last-update').textContent;
  fail = true; await view.poll();
  assert.equal(view.node('people-total').textContent, '6'); assert.equal(view.node('last-update').textContent, previous);
  assert.match(view.node('sync-status').textContent, /上次成功同步/); assert.equal(view.node('sync-status').dataset.tone, 'error');
  const initialFailure = await fixture({ list: async () => { throw new Error('synthetic initial outage'); } });
  await initialFailure.login();
  assert.equal(initialFailure.node('people-total').textContent, '—'); assert.equal(initialFailure.node('last-update').textContent, '—');
  assert.equal(initialFailure.node('sync-status').dataset.tone, 'error'); assert.equal(initialFailure.intervals.size, 1);
});

test('expired authorization stops all syncing and hides the private dashboard', async () => {
  let fail = false;
  const view = await fixture({ list: async () => {
    if (fail) throw Object.assign(new Error('登录已失效'), { code: 'UNAUTHENTICATED' });
    return { rows: [row(1)], nextCursor: null };
  } });
  await view.login(); fail = true; await view.poll();
  assert.equal(view.node('dashboard').hidden, true); assert.equal(view.node('login-panel').hidden, false);
  assert.equal(view.intervals.size, 0); assert.equal(view.watches[0].closed, true);
  assert.equal(view.node('sync-status').dataset.tone, 'error');
});

test('logout clears rendered guest data and stale totals before the next login', async () => {
  let fail = false;
  const view = await fixture({ list: async () => {
    if (fail) throw new Error('synthetic initial outage');
    return { rows: [row(1, { name: 'PRIVATE GUEST', people: 6 })], nextCursor: null };
  } });
  await view.login(); await view.node('logout').emit('click');
  assert.equal(view.signedOut(), 1); assert.equal(view.intervals.size, 0); assert.equal(view.watches[0].closed, true);
  assert.equal(view.node('dashboard').hidden, true); assert.equal(view.node('logout').hidden, true);
  assert.equal(view.node('guest-rows').children.length, 0); assert.equal(view.node('people-total').textContent, '—');
  assert.equal(view.node('last-update').textContent, '—'); assert.equal(view.node('export').disabled, true);
  fail = true; await view.login();
  assert.equal(view.node('people-total').textContent, '—'); assert.equal(view.node('sync-status').dataset.tone, 'error');
});

test('logout failure never claims success and keeps syncing stopped', async () => {
  const view = await fixture({ signOut: async () => { throw new Error('synthetic logout failure'); } });
  await view.login(); await view.node('logout').emit('click');
  assert.match(view.node('sync-status').textContent, /退出登录未完成/); assert.equal(view.node('sync-status').dataset.tone, 'error');
  assert.equal(view.node('logout').hidden, false); assert.equal(view.intervals.size, 0); assert.equal(view.node('dashboard').hidden, true);
});

test('an old failed refresh cannot sign out or start duplicate watchers for a new session', async () => {
  const pending = deferred(); let calls = 0;
  const view = await fixture({ list: async () => {
    calls++;
    if (calls === 1) return pending.promise;
    return { rows: [row(2, { name: 'NEW SESSION GUEST', people: 4 })], nextCursor: null };
  } });
  const oldLogin = view.login(); await settle(); assert.equal(calls, 1);
  await view.node('logout').emit('click'); await view.login();
  pending.reject(Object.assign(new Error('old session is forbidden'), { code: 'FORBIDDEN' }));
  await oldLogin; await settle();
  assert.equal(view.node('dashboard').hidden, false); assert.equal(view.node('people-total').textContent, '4');
  assert.equal(view.node('sync-status').dataset.tone, 'connected');
  assert.equal(view.intervals.size, 1); assert.equal(view.watches.filter(watch => !watch.closed).length, 1);
});

test('a duplicated cursor fails visibly instead of displaying partial totals', async () => {
  const cursor = row(100).id;
  const view = await fixture({ list: async () => ({ rows: [row(1)], nextCursor: cursor }) });
  await view.login();
  assert.equal(view.node('people-total').textContent, '—'); assert.equal(view.node('sync-status').dataset.tone, 'error');
  assert.match(view.node('sync-status').textContent, /分页结果重复/); assert.equal(view.requests.length, 2);
});

test('logout while history restoration awaits authorization cannot restart syncing', async () => {
  const authorization = deferred(); let calls = 0;
  const view = await fixture({ authorize: async () => {
    calls++;
    if (calls === 2) return authorization.promise;
    return { authorized: true };
  } });
  await view.login(); assert.equal(view.node('logout').hidden, false);
  await view.windowEvent('pagehide'); await view.windowEvent('pageshow', { persisted: true });
  assert.equal(calls, 2); await view.node('logout').emit('click');
  authorization.resolve({ authorized: true }); await settle();
  assert.equal(view.node('dashboard').hidden, true); assert.equal(view.node('logout').hidden, true);
  assert.equal(view.intervals.size, 0); assert.equal(view.watches.filter(watch => !watch.closed).length, 0);
  assert.equal(view.node('sync-status').textContent, '已退出登录');
});
