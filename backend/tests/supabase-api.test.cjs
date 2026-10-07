'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let sequence = 0;
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function jwt(role, subject, anonymous) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [encode({ alg: 'HS256', typ: 'JWT' }), encode({ role, sub: subject, is_anonymous: anonymous, exp: Math.floor(Date.now() / 1000) + 3600 }), 'test-signature'].join('.');
}
function authSession(kind) {
  const user = { id: kind === 'guest' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002', is_anonymous: kind === 'guest', aud: 'authenticated', role: 'authenticated', email: kind === 'guest' ? '' : 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-10-07T00:00:00Z' };
  return { access_token: jwt('authenticated', user.id, user.is_anonymous), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: kind + '-refresh-test', user };
}
function receipt(changes = {}) {
  return { id: '00000000-0000-4000-8000-000000000010', name: '测试宾客', people: 3, createdAt: '2026-10-07T01:00:00Z', submittedAt: '2026-10-07T01:00:00Z', ...changes };
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
async function fixture(options = {}) {
  const number = ++sequence;
  const local = options.local ?? storage(); const session = options.session ?? storage(); const requests = [];
  const config = Object.hasOwn(options, 'config') ? options.config : { provider: 'supabase', url: `https://wedding-test-${number}.supabase.co`, publishableKey: 'sb_publishable_test_only' };
  const guest = authSession('guest'); const owner = authSession('admin');
  global.localStorage = local; global.sessionStorage = session;
  global.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (url.pathname.endsWith('/data/backend.json')) return json(config);
    const body = init.body ? JSON.parse(init.body) : null;
    const request = { origin: url.origin, path: url.pathname, query: url.search, body, headers: new Headers(init.headers), signal: init.signal };
    requests.push(request);
    if (options.handle) {
      const handled = await options.handle(request);
      if (handled) return handled;
    }
    if (url.pathname === '/auth/v1/signup') return json(guest);
    if (url.pathname === '/auth/v1/token') return json(owner);
    if (url.pathname === '/auth/v1/logout') return json({});
    if (url.pathname === '/rest/v1/rpc/authorize_wedding_admin') return json({ authorized: true });
    if (url.pathname === '/rest/v1/rpc/submit_wedding_rsvp') return json(receipt({ name: body.p_name, people: body.p_people }));
    if (url.pathname === '/rest/v1/rpc/list_wedding_rsvps') return json({ rows: [], nextCursor: null });
    throw new Error('Unexpected test request: ' + url.pathname);
  };
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../assets/rsvp-api.js'));
  moduleUrl.searchParams.set('test', String(number));
  const api = await import(moduleUrl.href);
  return { api, local, session, requests, guest, owner };
}

test('missing config and private keys cannot enable the frontend', async () => {
  for (const config of [null, { provider: 'cloudbase', env: 'old' }, { provider: 'supabase', url: 'https://example.test', publishableKey: 'sb_secret_do_not_use' }, { provider: 'supabase', url: 'https://example.test', publishableKey: jwt('service_role', 'secret', false) }, { provider: 'supabase', url: 'http://example.test', publishableKey: 'sb_publishable_test_only' }]) {
    const { api, requests } = await fixture({ config });
    assert.deepEqual(api.getServiceStatus(), { configured: false });
    await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: randomUUID() }), { code: 'NOT_CONFIGURED' });
    assert.equal(requests.length, 0);
  }
});

test('legacy anon public keys remain usable while names and people validate before auth', async () => {
  const { api, requests } = await fixture({ config: { provider: 'supabase', url: 'https://anon-key-test.supabase.co', publishableKey: jwt('anon', '', false) } });
  assert.deepEqual(api.getServiceStatus(), { configured: true });
  for (const people of [0, 21, 1.5, '3']) await assert.rejects(api.submitRsvp({ name: '测试', people, submissionId: randomUUID() }), { code: 'INVALID_PEOPLE' });
  for (const name of ['', '  ', 'x'.repeat(41), '测试\n姓名']) await assert.rejects(api.submitRsvp({ name, people: 2, submissionId: randomUUID() }), { code: 'INVALID_NAME' });
  await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: 'bad' }), { code: 'INVALID_ID' });
  assert.equal(requests.length, 0);
});

test('lost-response retry retains operation ID and version, while edits increase version', async () => {
  let calls = 0;
  const { api, requests, local, guest } = await fixture({ handle(request) {
    if (request.path.endsWith('/submit_wedding_rsvp') && ++calls === 1) return json({ code: 'P0001', message: 'SERVICE_ERROR' }, 500);
  } });
  const payload = { name: '  Cafe\u0301  ', people: 3, submissionId: randomUUID() };
  await assert.rejects(api.submitRsvp(payload), { code: 'SERVICE_ERROR' });
  const accepted = await api.submitRsvp(payload);
  assert.equal(accepted.name, 'Café');
  const firstTwo = requests.filter(row => row.path.endsWith('/submit_wedding_rsvp'));
  assert.equal(firstTwo[0].body.p_operation_id, firstTwo[1].body.p_operation_id);
  assert.equal(firstTwo[0].body.p_client_version, firstTwo[1].body.p_client_version);
  assert.equal(firstTwo[0].headers.get('authorization'), 'Bearer ' + guest.access_token);
  assert.equal(requests.filter(row => row.path === '/auth/v1/signup').length, 1);
  const now = Date.now;
  try {
    Date.now = () => firstTwo[0].body.p_client_version - 100;
    await api.submitRsvp({ ...payload, people: 6 });
  } finally { Date.now = now; }
  const third = requests.filter(row => row.path.endsWith('/submit_wedding_rsvp')).at(-1);
  assert.notEqual(third.body.p_operation_id, firstTwo[0].body.p_operation_id);
  assert.equal(third.body.p_client_version, firstTwo[0].body.p_client_version + 1);
  assert.equal(JSON.parse(local.getItem('wedding-rsvp-operation:' + payload.submissionId)).clientVersion, third.body.p_client_version);
});

test('admin and guest auth stay isolated, including after administrator logout', async () => {
  const { api, requests, local, session, guest, owner } = await fixture();
  const login = await api.signInAdmin({ email: ' owner@example.test ', password: 'synthetic-test-password' });
  assert.equal(login.user.id, owner.user.id);
  assert.equal((await api.getAdminSession()).user.id, owner.user.id);
  await api.submitRsvp({ name: '测试宾客', people: 3, submissionId: randomUUID() });
  assert.ok([...session.values.keys()].some(key => key.startsWith('wedding-rsvp-admin:')));
  assert.equal([...local.values.keys()].some(key => key.startsWith('wedding-rsvp-admin:')), false);
  assert.ok([...local.values.keys()].some(key => key.startsWith('wedding-rsvp-guest:')));
  const adminCall = requests.find(row => row.path.endsWith('/authorize_wedding_admin'));
  const guestCall = requests.find(row => row.path.endsWith('/submit_wedding_rsvp'));
  assert.equal(adminCall.headers.get('authorization'), 'Bearer ' + owner.access_token);
  assert.equal(guestCall.headers.get('authorization'), 'Bearer ' + guest.access_token);
  await api.signOutAdmin();
  assert.equal(await api.getAdminSession(), null);
  assert.equal([...session.values.keys()].some(key => key.startsWith('wedding-rsvp-admin:')), false);
  assert.ok([...local.values.keys()].some(key => key.startsWith('wedding-rsvp-guest:')));
  assert.equal(requests.find(row => row.path === '/auth/v1/logout').query, '?scope=local');
});

test('a signed-in account without owner privileges is logged out and denied', async () => {
  const { api, session } = await fixture({ handle(request) {
    if (request.path.endsWith('/authorize_wedding_admin')) return json({ code: 'P0001', message: 'FORBIDDEN' }, 400);
  } });
  await assert.rejects(api.signInAdmin({ email: 'outsider@example.test', password: 'synthetic-test-password' }), { code: 'FORBIDDEN' });
  assert.equal(await api.getAdminSession(), null);
  assert.equal([...session.values.keys()].some(key => key.startsWith('wedding-rsvp-admin:')), false);
  assert.throws(() => api.watchRsvpChanges({}), { code: 'FORBIDDEN' });
});

test('pagination preserves all 205 groups and passes the requested cursor', async () => {
  const source = Array.from({ length: 205 }, (_, index) => receipt({ id: String(index).padStart(5, '0'), name: '宾客' + index, people: (index % 4) + 1 }));
  const { api, requests } = await fixture({ handle(request) {
    if (!request.path.endsWith('/list_wedding_rsvps')) return;
    const start = request.body.p_cursor ? Number(request.body.p_cursor) + 1 : 0;
    const rows = source.slice(start, start + request.body.p_limit);
    return json({ rows, nextCursor: start + rows.length < source.length ? rows.at(-1).id : null });
  } });
  await api.signInAdmin({ email: 'owner@example.test', password: 'synthetic-test-password' });
  let cursor = null; const rows = [];
  do { const page = await api.listRsvps({ cursor }); rows.push(...page.rows); cursor = page.nextCursor; } while (cursor);
  assert.equal(rows.length, 205); assert.equal(new Set(rows.map(row => row.id)).size, 205);
  assert.equal(rows.reduce((sum, row) => sum + row.people, 0), 511);
  assert.deepEqual(requests.filter(row => row.path.endsWith('/list_wedding_rsvps')).map(row => row.body), [{ p_cursor: null, p_limit: 100 }, { p_cursor: '00099', p_limit: 100 }, { p_cursor: '00199', p_limit: 100 }]);
  await api.signOutAdmin();
});

test('SQL stale-operation errors retain a clear retry instruction without exposing SQL details', async () => {
  const { api } = await fixture({ handle(request) {
    if (request.path.endsWith('/submit_wedding_rsvp')) return json({ code: 'P0001', message: 'STALE_OPERATION', details: 'PRIVATE DATABASE DETAILS' }, 400);
  } });
  await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: randomUUID() }), error => {
    assert.equal(error.code, 'STALE_OPERATION'); assert.match(error.message, /核对/); assert.equal(error.message.includes('PRIVATE'), false); return true;
  });
});

test('malformed server acknowledgements are rejected rather than shown as saved', async () => {
  const { api } = await fixture({ handle(request) {
    if (request.path.endsWith('/submit_wedding_rsvp')) return json({ id: 'partial', name: '测试', people: 2 });
    if (request.path.endsWith('/list_wedding_rsvps')) return json({ rows: [receipt({ people: 0 })], nextCursor: null });
  } });
  await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: randomUUID() }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(api.listRsvps(), { code: 'INVALID_RESPONSE' });
});

test('type-conversion errors use a guest-facing message without raw database text', async () => {
  const { api } = await fixture({ handle(request) {
    if (request.path.endsWith('/submit_wedding_rsvp')) return json({ code: '22P02', message: 'invalid input syntax for uuid: PRIVATE VALUE' }, 400);
  } });
  await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: randomUUID() }), error => {
    assert.equal(error.code, 'INVALID_INPUT'); assert.equal(error.message.includes('PRIVATE'), false); return true;
  });
});

test('moving the same project behind a proxy preserves visitor ownership, operations and admin sessions', async () => {
  const identityHost = 'abcdefghijklmnopqrst.supabase.co';
  const directConfig = { provider: 'supabase', url: 'https://' + identityHost, publishableKey: 'sb_publishable_test_only' };
  const original = await fixture({ config: directConfig });
  const payload = { name: '迁移测试宾客', people: 4, submissionId: randomUUID() };
  const first = await original.api.submitRsvp(payload);
  await original.api.signInAdmin({ email: 'owner@example.test', password: 'synthetic-test-password' });
  const originalOperation = original.requests.find(request => request.path.endsWith('/submit_wedding_rsvp')).body;
  assert.ok(original.local.getItem('wedding-rsvp-guest:' + identityHost));
  assert.ok(original.session.getItem('wedding-rsvp-admin:' + identityHost));
  const proxy = await fixture({ config: { ...directConfig, url: 'https://wedding-proxy.example.test', identityHost }, local: original.local, session: original.session });
  const retried = await proxy.api.submitRsvp(payload);
  assert.equal(retried.id, first.id);
  assert.equal(proxy.requests.some(request => request.path === '/auth/v1/signup'), false, 'Proxy migration must not create another anonymous owner');
  const proxyOperation = proxy.requests.find(request => request.path.endsWith('/submit_wedding_rsvp'));
  assert.equal(proxyOperation.origin, 'https://wedding-proxy.example.test');
  assert.equal(proxyOperation.headers.get('authorization'), 'Bearer ' + original.guest.access_token);
  assert.equal(proxyOperation.body.p_submission_id, originalOperation.p_submission_id);
  assert.equal(proxyOperation.body.p_operation_id, originalOperation.p_operation_id);
  assert.equal(proxyOperation.body.p_client_version, originalOperation.p_client_version);
  assert.equal((await proxy.api.getAdminSession()).user.id, original.owner.user.id);
  await proxy.api.authorizeAdmin();
  const authorization = proxy.requests.find(request => request.path.endsWith('/authorize_wedding_admin'));
  assert.equal(authorization.origin, 'https://wedding-proxy.example.test');
  assert.equal(authorization.headers.get('authorization'), 'Bearer ' + original.owner.access_token);
  assert.equal(proxy.requests.some(request => request.path === '/auth/v1/token'), false, 'Existing administrator session should survive migration');
  assert.equal([...proxy.local.values.keys()].some(key => key.includes('wedding-proxy.example.test')), false);
  assert.equal([...proxy.session.values.keys()].some(key => key.includes('wedding-proxy.example.test')), false);
  await proxy.api.signOutAdmin();
});

test('an explicitly malformed identityHost fails closed before any Auth or RPC request', async () => {
  for (const identityHost of ['', null, 7, 'https://abcdefghijklmnopqrst.supabase.co', 'ABCDEFGHIJKLMNOPQRST.supabase.co', 'abcdefghijklmnopqrs.supabase.co', 'abcdefghijklmnopqrstu.supabase.co', 'abcdefghijklmnopqrst.supabase.co.evil.test', 'abcdefghijklmnopqrst.supabase.co ']) {
    const { api, requests } = await fixture({ config: { provider: 'supabase', url: 'https://wedding-proxy.example.test', publishableKey: 'sb_publishable_test_only', identityHost } });
    assert.deepEqual(api.getServiceStatus(), { configured: false });
    await assert.rejects(api.submitRsvp({ name: '测试', people: 2, submissionId: randomUUID() }), { code: 'NOT_CONFIGURED' });
    await assert.rejects(api.getAdminSession(), { code: 'NOT_CONFIGURED' });
    assert.equal(requests.length, 0);
  }
});

test('Realtime uses the owner token, invalidates on changes, and stops callbacks after close', async () => {
  const originalWebSocket = global.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send(value) {
      const frame = JSON.parse(value); this.sent.push(frame);
      const [join, ref, topic, event, payload] = frame;
      if (event === 'phx_join') {
        this.topic = topic; this.join = join;
        this.receive([join, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: payload.config.postgres_changes.map((filter, index) => ({ ...filter, id: index + 1 })) } }]);
      } else if (event === 'phx_leave') this.receive([join, ref, topic, 'phx_reply', { status: 'ok', response: {} }]);
    }
    receive(frame) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) })); }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000 })); }
  }
  global.WebSocket = FakeWebSocket;
  let api;
  try {
    const fixtureResult = await fixture(); api = fixtureResult.api;
    await api.signInAdmin({ email: 'owner@example.test', password: 'synthetic-test-password' });
    let changes = 0; let failures = 0; const argumentsSeen = [];
    const watch = api.watchRsvpChanges({ onChange(...args) { changes++; argumentsSeen.push(args); }, onError() { failures++; } });
    const waitUntil = async predicate => {
      for (let count = 0; count < 100 && !predicate(); count++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(Boolean(predicate()), true, 'Realtime callback did not arrive');
    };
    await waitUntil(() => changes === 1);
    const socket = sockets.at(-1);
    assert.equal(socket.sent.find(frame => frame[3] === 'phx_join')[4].access_token, fixtureResult.owner.access_token);
    const change = [socket.join, null, socket.topic, 'postgres_changes', { ids: [1], data: { schema: 'public', table: 'wedding_rsvps', type: 'INSERT', columns: [], record: { name: 'PRIVATE NAME' }, old_record: {}, commit_timestamp: '2026-10-07T01:00:00Z' } }];
    socket.receive(change);
    await waitUntil(() => changes === 2);
    assert.ok(argumentsSeen.every(args => args.length === 0), 'Realtime must only invalidate, not forward personal rows');
    socket.receive([socket.join, null, socket.topic, 'phx_error', { reason: 'synthetic disconnect' }]);
    await waitUntil(() => failures > 0);
    watch.close(); watch.close();
    const previous = changes;
    socket.receive(change);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(changes, previous);
    await api.signOutAdmin();
  } finally {
    global.WebSocket = originalWebSocket;
  }
});
