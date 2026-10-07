'use strict';

// Real PostgreSQL / PLpgSQL checks. The optional test engine lives outside the repo:
// tmp=$(mktemp -d); npm install --prefix "$tmp" @electric-sql/pglite@0.5.8
// WEDDING_PGLITE_MODULE="$tmp/node_modules/@electric-sql/pglite" node --test backend/tests/supabase-sql.test.cjs
const test = require('node:test');
const strictAssert = require('node:assert/strict');
let assertionCount = 0;
const assert = new Proxy(strictAssert, {
  get(target, property) {
    const value = target[property];
    if (typeof value !== 'function') return value;
    return (...args) => { assertionCount++; return Reflect.apply(value, target, args); };
  },
});
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

let PGlite;
try {
  ({ PGlite } = require(process.env.WEDDING_PGLITE_MODULE || '@electric-sql/pglite'));
} catch (error) {
  if (process.env.WEDDING_PGLITE_MODULE || error.code !== 'MODULE_NOT_FOUND') throw error;
}

const ADMIN_UID = '00000000-0000-4000-8000-000000000001';
const administrator = { uid: ADMIN_UID, anonymous: false, email: 'wedding-host@example.invalid' };
const guest = () => ({ uid: randomUUID(), anonymous: true });
const payload = (changes = {}) => ({ name: '测试宾客', people: 3, submissionId: randomUUID(), operationId: randomUUID(), clientVersion: Date.now(), ...changes });

async function session(db, identity = {}) {
  await db.exec('reset role');
  const role = identity.uid ? 'authenticated' : 'anon';
  const claims = { role, ...(identity.uid ? { sub: identity.uid } : {}), ...(typeof identity.anonymous === 'boolean' ? { is_anonymous: identity.anonymous } : {}), ...(identity.email ? { email: identity.email } : {}) };
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [identity.uid || '', JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
}

async function submit(db, value) {
  const result = await db.query('select public.submit_wedding_rsvp($1::text, $2::integer, $3::uuid, $4::uuid, $5::bigint) as result', [value.name, value.people, value.submissionId, value.operationId, value.clientVersion]);
  return result.rows[0].result;
}
async function authorize(db) {
  return (await db.query('select public.authorize_wedding_admin() as result')).rows[0].result;
}
async function list(db, cursor = null, limit = 100) {
  return (await db.query('select public.list_wedding_rsvps($1::text, $2::integer) as result', [cursor, limit])).rows[0].result;
}
async function adminRows(db) {
  await session(db, administrator);
  const rows = [];
  let cursor = null;
  const seen = new Set();
  do {
    const page = await list(db, cursor);
    assert.ok(Array.isArray(page.rows), 'list RPC must return a rows array');
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!seen.has(cursor), 'pagination cursor must advance');
      seen.add(cursor);
    }
  } while (cursor);
  return rows;
}
async function tableSnapshot(db) {
  await db.exec('reset role');
  const tables = (await db.query("select table_schema, table_name from information_schema.tables where table_schema in ('public','private') and table_type='BASE TABLE' order by table_schema,table_name")).rows;
  const snapshot = {};
  for (const { table_schema: schema, table_name: table } of tables) {
    const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
    snapshot[`${schema}.${table}`] = (await db.query(`select to_jsonb(t) as row from ${quote(schema)}.${quote(table)} t order by to_jsonb(t)::text`)).rows.map((result) => result.row);
  }
  return snapshot;
}
async function newDatabase() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  // Execute the actual schema without textual rewrites or replaced business functions.
  await db.exec(readFileSync(resolve(__dirname, '../supabase/schema.sql'), 'utf8'));
  await db.query('insert into private.settings(singleton, admin_uid) values (true, $1::uuid) on conflict (singleton) do update set admin_uid=excluded.admin_uid', [ADMIN_UID]);
  return db;
}

test('Supabase schema executes and enforces authorization and writes in real PostgreSQL', { skip: PGlite ? false : 'Install PGlite in a temp directory and set WEDDING_PGLITE_MODULE; see file header.' }, async (t) => {
  async function check(name, callback) {
    await t.test(name, async () => {
      const db = await newDatabase();
      try { await callback(db); } finally { await db.close(); }
    });
  }

  await check('schema is installed with RLS and a realtime publication', async (db) => {
    const version = (await db.query('select version() as version')).rows[0].version;
    assert.match(version, /PostgreSQL/);
    console.log(version);
    const tables = (await db.query("select schemaname,tablename from pg_publication_tables where pubname='supabase_realtime'")).rows;
    assert.ok(tables.some((row) => row.schemaname === 'public'), 'realtime publication contains the RSVP table');
    const rls = (await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'")).rows;
    assert.ok(rls.length > 0 && rls.every((row) => row.relrowsecurity), 'all public RSVP tables have RLS enabled');
  });

  await check('unauthenticated callers and anonymous visitors cannot read the guest list', async (db) => {
    const owner = guest();
    await session(db, owner);
    await submit(db, payload());
    for (const identity of [{}, owner, { uid: randomUUID(), anonymous: false, email: administrator.email }, { ...administrator, anonymous: true }, { uid: ADMIN_UID, anonymous: false }]) {
      await session(db, identity);
      await assert.rejects(authorize(db), 'only the explicitly configured non-anonymous administrator may authorize');
      await assert.rejects(list(db), 'visitor list RPC must deny access');
      let directRows = [];
      try { directRows = (await db.query('select * from public.wedding_rsvps')).rows; } catch (error) { assert.equal(error.code, '42501', 'direct table SELECT is denied by database permissions or RLS'); }
      assert.equal(directRows.length, 0, 'no guest rows leak through direct SELECT');
    }
    await session(db, {});
    await assert.rejects(submit(db, payload()), 'submission requires a trusted auth UID');
  });

  await check('configured administrator authorizes and reads the complete submitted record', async (db) => {
    await session(db, guest());
    const saved = await submit(db, payload({ name: '真实 SQL 验证', people: 4 }));
    await session(db, administrator);
    assert.deepEqual(await authorize(db), { authorized: true });
    const page = await list(db);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].id, saved.id);
    assert.equal(page.rows[0].name, '真实 SQL 验证');
    assert.equal(page.rows[0].people, 4);
    assert.ok(page.fetchedAt);
    assert.equal((await db.query('select * from public.wedding_rsvps')).rows.length, 1, 'administrator SELECT policy supports realtime access');
  });

  await check('one device updates one group, retries do not duplicate it, and old requests cannot undo edits', async (db) => {
    const owner = guest();
    const first = payload({ clientVersion: 100 });
    await session(db, owner);
    const initial = await submit(db, first);
    for (let index = 0; index < 25; index++) assert.equal((await submit(db, first)).id, initial.id);
    const edit = { ...first, name: '更新姓名', people: 6, operationId: randomUUID(), clientVersion: 200 };
    const updated = await submit(db, edit);
    assert.equal(updated.id, initial.id);
    assert.equal(updated.createdAt, initial.createdAt);
    assert.equal(updated.name, edit.name);
    const oldRetry = await submit(db, first);
    assert.equal(oldRetry.people, 6, 'retry receipt reflects the latest successful edit');
    await assert.rejects(submit(db, { ...first, name: '迟到覆盖', operationId: randomUUID(), clientVersion: 150 }), 'a new operation with an older version must fail');
    await assert.rejects(submit(db, { ...edit, people: 9 }), 'the same operation ID cannot represent a different request');
    const rows = await adminRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, initial.id);
    assert.equal(rows[0].name, edit.name);
    assert.equal(rows[0].people, 6);
  });

  await check('another owner cannot overwrite a forged submission or operation ID', async (db) => {
    const first = payload({ clientVersion: 100 });
    await session(db, guest());
    const saved = await submit(db, first);
    await session(db, guest());
    await assert.rejects(submit(db, { ...first, name: '伪造覆盖', people: 20, operationId: randomUUID(), clientVersion: 200 }));
    // An operation UUID is scoped to its trusted owner, so another owner may
    // reuse that UUID for their own distinct row without accessing the first row.
    const ownRecord = await submit(db, { ...first, submissionId: randomUUID(), name: '另一位宾客' });
    assert.notEqual(ownRecord.id, saved.id);
    await assert.rejects(db.query('update public.wedding_rsvps set people=20 where id=$1::uuid', [saved.id]), { code: '42501' });
    const rows = await adminRows(db);
    assert.equal(rows.length, 2);
    const original = rows.find((row) => row.id === saved.id);
    assert.equal(original.name, first.name);
    assert.equal(original.people, first.people);
  });

  await check('205 actual submissions paginate without omissions or double counts', async (db) => {
    const expected = new Map();
    for (let index = 0; index < 205; index++) {
      await session(db, guest());
      const value = payload({ name: `分页宾客${String(index).padStart(3, '0')}`, people: (index % 4) + 1 });
      const saved = await submit(db, value);
      expected.set(saved.id, value);
    }
    await session(db, administrator);
    let cursor = null;
    const rows = [];
    const sizes = [];
    do {
      const page = await list(db, cursor, 100);
      sizes.push(page.rows.length);
      rows.push(...page.rows);
      cursor = page.nextCursor;
      assert.ok(sizes.length <= 3, 'cursor must terminate after the third page');
    } while (cursor);
    assert.deepEqual(sizes, [100, 100, 5]);
    assert.equal(rows.length, 205);
    assert.equal(new Set(rows.map((row) => row.id)).size, 205);
    assert.equal(rows.reduce((sum, row) => sum + row.people, 0), 511);
    for (const row of rows) {
      assert.equal(row.name, expected.get(row.id)?.name);
      assert.equal(row.people, expected.get(row.id)?.people);
    }
    console.log('Actual SQL pagination: 205 groups, 511 people, page sizes 100/100/5.');
  });

  await check('illegal inputs roll back all tables and preserve an existing valid group', async (db) => {
    const owner = guest();
    const valid = payload();
    await session(db, owner);
    await submit(db, valid);
    const before = await tableSnapshot(db);
    const invalid = [
      { name: '' }, { name: '  ' }, { name: 'x'.repeat(41) }, { name: '测试\n姓名' },
      { people: 0 }, { people: -1 }, { people: 21 }, { people: null }, { people: 1.5 }, { people: '3.1' },
      { submissionId: 'invalid-uuid' }, { submissionId: null },
      { operationId: 'invalid-uuid' }, { operationId: null },
      { clientVersion: 0 }, { clientVersion: -1 }, { clientVersion: null }, { clientVersion: 1.5 }, { clientVersion: 9007199254740992 },
    ];
    for (const changes of invalid) {
      await session(db, owner);
      await assert.rejects(submit(db, { ...valid, operationId: randomUUID(), clientVersion: Date.now() + 1, ...changes }), `invalid input must fail: ${JSON.stringify(changes)}`);
      assert.deepEqual(await tableSnapshot(db), before, 'failed statement leaves every entry, operation, and rate-limit value unchanged');
    }
    const rows = await adminRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, valid.name);
    assert.equal(rows[0].people, valid.people);
  });

  await check('Unicode boundary whitespace and NFC normalize consistently, including idempotent fingerprints', async (db) => {
    const value = payload({ name: '\uFEFF\u3000\u00A0Jose\u0301\u2009\u2028\t' });
    await session(db, guest());
    const saved = await submit(db, value);
    assert.equal(saved.name, 'José');
    const retry = await submit(db, { ...value, name: 'José' });
    assert.equal(retry.id, saved.id);
    assert.equal(retry.name, 'José');
    await assert.rejects(submit(db, { ...value, name: '测试\u0000姓名', operationId: randomUUID(), clientVersion: value.clientVersion + 1 }));
    const rows = await adminRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'José');
    await session(db, guest());
    const verticalWhitespace = await submit(db, payload({ name: '\u000bv姓名v\u000b' }));
    assert.equal(verticalWhitespace.name, 'v姓名v', 'vertical-tab boundaries trim without removing literal v characters');
  });

  await check('rate limits count writes once, reject the eleventh edit atomically, and permit successful retries', async (db) => {
    const owner = guest();
    const first = payload({ name: '限流宾客1', clientVersion: 1 });
    await session(db, owner);
    await submit(db, first);
    for (let version = 2; version <= 10; version++) {
      await submit(db, { ...first, name: `限流宾客${version}`, people: version, operationId: randomUUID(), clientVersion: version });
    }
    const before = await tableSnapshot(db);
    assert.equal(before['private.wedding_rsvp_limits'][0].request_count, 10);
    assert.equal(before['private.wedding_rsvp_operations'].length, 10);
    await session(db, owner);
    await assert.rejects(submit(db, { ...first, operationId: randomUUID(), clientVersion: 11 }), { message: 'RATE_LIMITED' });
    assert.deepEqual(await tableSnapshot(db), before, 'rate limit rejection changes no stored value');
    await session(db, owner);
    const retry = await submit(db, first);
    assert.equal(retry.name, '限流宾客10');
    assert.equal(retry.people, 10);
    assert.deepEqual(await tableSnapshot(db), before, 'old successful retry incurs no additional write or limit charge');
  });

  await check('missing administrator configuration fails closed', async (db) => {
    await db.exec('delete from private.settings');
    await session(db, administrator);
    await assert.rejects(authorize(db), { message: 'FORBIDDEN' });
    await assert.rejects(list(db), { message: 'FORBIDDEN' });
    assert.equal((await db.query('select * from public.wedding_rsvps')).rows.length, 0);
  });
  console.log(`Actual SQL assertion calls: ${assertionCount}. PGlite uses one database connection; cloud Auth, multi-session locking, and WebSocket delivery require deployed verification.`);
});
