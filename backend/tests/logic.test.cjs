'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createService, COLLECTIONS, validateSubmission, requireAdmin } = require('../functions/wedding-rsvp/logic');
const { createHandler } = require('../functions/wedding-rsvp/index');
const copy = data => data === undefined ? undefined : structuredClone(data);
function memoryStore() {
  let records = new Map();
  let queue = Promise.resolve();
  return {
    transaction(callback) {
      const next = queue.then(async () => {
        const pending = new Map(records);
        const result = await callback({
          async get(collection, id) { return copy(pending.get(collection + ':' + id)) || null; },
          async set(collection, id, data) { pending.set(collection + ':' + id, { ...copy(data), _id: id }); }
        });
        records = pending;
        return result;
      });
      queue = next.catch(() => {}); return next;
    },
    async list(collection, cursor, limit) { return [...records.entries()].filter(([key, row]) => key.startsWith(collection + ':') && (!cursor || row._id > cursor)).map(([, row]) => copy(row)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit); },
    async seed(collection, id, data) { records.set(collection + ':' + id, { ...copy(data), _id: id }); },
    values(collection) { return [...records.entries()].filter(([key]) => key.startsWith(collection + ':')).map(([, row]) => copy(row)); }
  };
}
const guest = { uid: 'guest-trusted-runtime', loginType: 'ANONYMOUS', anonymous: true, ip: '192.0.2.1' };
const owner = { uid: 'host-trusted-runtime', loginType: 'USERNAME', anonymous: false, ip: '192.0.2.2' };
const payload = (changes = {}) => ({ name: '测试宾客', people: 3, submissionId: randomUUID(), operationId: randomUUID(), ...changes });
test('invalid people, names and IDs are rejected before any write', async () => {
  for (const people of [0, 21, -1, 1.5, '3', NaN]) assert.throws(() => validateSubmission(payload({ people })), { code: 'INVALID_PEOPLE' });
  for (const name of ['', '  ', 'x'.repeat(41), '测试\n姓名']) assert.throws(() => validateSubmission(payload({ name })), { code: 'INVALID_NAME' });
  assert.throws(() => validateSubmission(payload({ submissionId: 'bad' })), { code: 'INVALID_ID' });
  const store = memoryStore(); const service = createService(store);
  await assert.rejects(service.submit(payload(), { uid: '' }), { code: 'UNAUTHENTICATED' });
  assert.equal(store.values(COLLECTIONS.entries).length, 0);
});
test('parallel retries save one group and consume the rate limit once', async () => {
  const store = memoryStore(); const service = createService(store); const input = payload();
  const responses = await Promise.all(Array.from({ length: 25 }, () => service.submit(input, guest)));
  assert.equal(new Set(responses.map(row => row.id)).size, 1);
  assert.equal(store.values(COLLECTIONS.entries).length, 1);
  assert.equal(store.values(COLLECTIONS.receipts).length, 1);
  assert.ok(store.values(COLLECTIONS.limits).every(row => row.count === 1));
});
test('edits update one owned group; retrying an old operation cannot undo edits', async () => {
  let time = Date.parse('2026-10-07T05:00:00Z');
  const store = memoryStore(); const service = createService(store, { clock: () => time });
  const first = payload(); const created = await service.submit(first, guest);
  time += 1000;
  const edited = await service.submit({ ...first, operationId: randomUUID(), name: '更新姓名', people: 6 }, guest);
  const oldRetry = await service.submit(first, guest);
  assert.equal(created.id, edited.id); assert.equal(edited.createdAt, created.createdAt);
  assert.equal(oldRetry.people, 6); assert.equal(oldRetry.name, '更新姓名');
  assert.equal(store.values(COLLECTIONS.entries).length, 1);
  await assert.rejects(service.submit({ ...first, people: 9 }, guest), { code: 'ID_CONFLICT' });
  const other = await service.submit(first, { ...guest, uid: 'second-guest' });
  assert.notEqual(other.id, created.id);
});
test('rate limiting is transactional, resets, and does not reject a valid retry', async () => {
  let time = 60000; const store = memoryStore(); const service = createService(store, { clock: () => time });
  const first = payload(); await service.submit(first, guest);
  for (let index = 0; index < 9; index++) await service.submit(payload(), guest);
  await assert.rejects(service.submit(payload(), guest), { code: 'RATE_LIMITED' });
  assert.equal((await service.submit(first, guest)).people, 3);
  assert.equal(store.values(COLLECTIONS.receipts).length, 10);
  time += 60000; await service.submit(payload(), guest);
  assert.equal(store.values(COLLECTIONS.entries).length, 1);
});
test('only the configured non-anonymous owner can read any list', async () => {
  const service = createService(memoryStore(), { adminUid: owner.uid });
  for (const identity of [guest, { ...owner, anonymous: true }, { ...owner, uid: 'another-user' }, { ...owner, loginType: '' }]) {
    assert.throws(() => requireAdmin(identity, owner.uid), { code: 'FORBIDDEN' });
    await assert.rejects(service.list({}, identity), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(await service.authorize(owner), { authorized: true });
});
test('all pages contribute to totals, including more than 100 records', async () => {
  const store = memoryStore(); const service = createService(store, { adminUid: owner.uid });
  for (let index = 0; index < 205; index++) await store.seed(COLLECTIONS.entries, index.toString(16).padStart(64, '0'), { name: '宾客' + index, people: (index % 4) + 1, createdAt: '2026-10-07T05:00:00Z', updatedAt: '2026-10-07T05:00:00Z' });
  let cursor = ''; const rows = []; let pages = 0;
  do { const page = await service.list({ cursor }, owner); rows.push(...page.rows); cursor = page.nextCursor; pages++; } while (cursor);
  assert.equal(pages, 3); assert.equal(rows.length, 205); assert.equal(new Set(rows.map(row => row.id)).size, 205);
  assert.equal(rows.reduce((sum, row) => sum + row.people, 0), 511);
});
test('handler rejects event.uid spoofing and fails closed without a configured owner', async () => {
  const cloudbase = {
    SYMBOL_CURRENT_ENV: 'current',
    getCloudbaseContext() { return { TCB_ISANONYMOUS_USER: 'true', TCB_SOURCE_IP: '192.0.2.1' }; },
    init() { return { auth: () => ({ getAuthContext: async () => ({ uid: guest.uid, loginType: 'ANONYMOUS' }) }), database: () => ({}) }; }
  };
  const handler = createHandler({ cloudbase, adminUid: owner.uid });
  const response = await handler({ action: 'list', uid: owner.uid, adminUid: owner.uid }, {});
  assert.equal(response.ok, false); assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(JSON.stringify(response).includes('192.0.2.1'), false);
});
test('a failed transaction leaves neither partial row nor success receipt', async () => {
  const store = memoryStore(); const original = store.transaction.bind(store);
  store.transaction = callback => original(tx => callback({ ...tx, async set(collection, id, data) { if (collection === COLLECTIONS.receipts) throw new Error('storage failed'); return tx.set(collection, id, data); } }));
  const service = createService(store);
  await assert.rejects(service.submit(payload(), guest));
  assert.equal(store.values(COLLECTIONS.entries).length, 0); assert.equal(store.values(COLLECTIONS.limits).length, 0);
});
