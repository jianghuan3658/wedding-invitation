'use strict';

// Executes the original SQL in a local PostgreSQL engine, without cloud credentials.
// runtime_dir=$(mktemp -d); npm install --prefix "$runtime_dir" @electric-sql/pglite@0.5.8
// WEDDING_PGLITE_MODULE="$runtime_dir/node_modules/@electric-sql/pglite" node --test backend/tests/service-health.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const modulePath = process.env.WEDDING_PGLITE_MODULE;
const PGlite = modulePath ? require(modulePath).PGlite : null;
const schemaSql = readFileSync(resolve(__dirname, '../supabase/schema.sql'), 'utf8');
const healthSql = readFileSync(resolve(__dirname, '../supabase/service-health.sql'), 'utf8');
const ADMIN_UID = '00000000-0000-4000-8000-000000000001';
const GUEST_UID = '00000000-0000-4000-8000-000000000002';

async function initialize(db) {
  await db.waitReady;
  // Supabase's roles and Auth helpers are simulated; wedding functions are not replaced.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role wedding_health_other nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    grant usage on schema public to wedding_health_other;
    create publication supabase_realtime;
  `);
  await db.exec(schemaSql);
  await db.exec(schemaSql);
  await db.query('insert into private.settings(singleton, admin_uid) values (true, $1::uuid)', [ADMIN_UID]);
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [GUEST_UID, JSON.stringify({ sub: GUEST_UID, role: 'authenticated', is_anonymous: true })]);
  await db.exec('set role authenticated');
  try {
    await db.query(`select public.submit_wedding_rsvp(
      '本地 SQL 测试宾客', 3,
      '00000000-0000-4000-8000-000000000003'::uuid,
      '00000000-0000-4000-8000-000000000004'::uuid, 1
    )`);
  } finally {
    await db.exec('reset role');
  }
  await db.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '{}', false)");
}

async function tableData(db) {
  const tables = (await db.query(`
    select n.nspname as schema_name, c.relname as table_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r'
    order by n.nspname, c.relname
  `)).rows;
  const snapshot = {};
  const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
  for (const { schema_name: schema, table_name: table } of tables) {
    snapshot[`${schema}.${table}`] = (await db.query(`
      select to_jsonb(t) as row from ${quote(schema)}.${quote(table)} t
      order by to_jsonb(t)::text
    `)).rows.map(({ row }) => row);
  }
  return snapshot;
}

async function tableSecurity(db) {
  return (await db.query(`
    select n.nspname as schema_name, c.relname as table_name,
      c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
      pg_catalog.pg_get_userbyid(c.relowner) as owner, c.relacl::text as table_acl,
      coalesce((select jsonb_agg(jsonb_build_object('column', a.attname, 'acl', a.attacl::text) order by a.attnum)
        from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::jsonb) as column_acls,
      coalesce((select jsonb_agg(jsonb_build_object(
        'name', p.polname, 'command', p.polcmd, 'permissive', p.polpermissive,
        'roles', p.polroles, 'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
        'withCheck', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname)
        from pg_catalog.pg_policy p where p.polrelid = c.oid), '[]'::jsonb) as policies
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r'
    order by n.nspname, c.relname
  `)).rows;
}

async function healthMetadata(db) {
  return (await db.query(`
    select p.oid, p.pronargs, p.prorettype::regtype::text as return_type,
      p.provolatile, p.prosecdef, p.proconfig, p.proacl::text as acl
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wedding_service_health'
  `)).rows;
}

test('service health migration and permissions execute in real PostgreSQL', {
  skip: PGlite ? false : 'PGlite dependency missing: install it outside the repo and set WEDDING_PGLITE_MODULE; see file header.',
}, async (t) => {
  const db = new PGlite();
  try {
    await initialize(db);
    console.log((await db.query('select version() as version')).rows[0].version);
    const originalData = await tableData(db);
    const originalSecurity = await tableSecurity(db);
    assert.equal(Object.keys(originalData).length, 4, 'fixture covers all four wedding tables');
    assert.ok(Object.values(originalData).every((rows) => rows.length > 0), 'snapshot includes existing settings, RSVP, operation, and rate-limit data');
    assert.ok(originalSecurity.every((table) => table.rls), 'existing wedding tables have RLS enabled');

    await t.test('original migrations execute twice and preserve existing table data, RLS, policies, and privileges', async () => {
      await db.exec(healthSql);
      const first = await healthMetadata(db);
      assert.equal(first.length, 1);
      assert.equal(first[0].pronargs, 0);
      assert.equal(first[0].return_type, 'jsonb');
      assert.equal(first[0].provolatile, 's');
      assert.equal(first[0].prosecdef, false, 'health function executes with caller permissions');
      assert.deepEqual(await tableData(db), originalData);
      assert.deepEqual(await tableSecurity(db), originalSecurity);
      await db.exec(healthSql);
      assert.deepEqual(await healthMetadata(db), first, 'reinstall preserves the same function and ACL');
      assert.deepEqual(await tableData(db), originalData);
      assert.deepEqual(await tableSecurity(db), originalSecurity);
    });

    for (const role of ['anon', 'authenticated']) {
      await t.test(`${role} can call without Auth claims in a read-only transaction and receives only ok and UTC milliseconds`, async () => {
        await db.exec(`begin read only; set local role ${role}; set local time zone 'Asia/Shanghai';`);
        try {
          const { result, expected_utc: expectedUtc, read_only: readOnly } = (await db.query(`
            select public.wedding_service_health() as result,
              pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expected_utc,
              pg_catalog.current_setting('transaction_read_only') as read_only
          `)).rows[0];
          assert.equal(readOnly, 'on');
          assert.deepEqual(Object.keys(result).sort(), ['checkedAt', 'ok'], 'no RSVP, user, count, or other data is returned');
          assert.equal(result.ok, true);
          assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
          assert.equal(result.checkedAt, expectedUtc, 'timestamp is UTC even when the session uses Asia/Shanghai');
          await db.exec('commit');
        } catch (error) {
          await db.exec('rollback');
          throw error;
        }
        assert.deepEqual(await tableData(db), originalData, 'health call performs no stored writes');
        assert.deepEqual(await tableSecurity(db), originalSecurity);
      });
    }

    await t.test('PUBLIC and an unrelated role have no EXECUTE permission', async () => {
      const permissions = (await db.query(`
        select pg_catalog.has_function_privilege('anon', 'public.wedding_service_health()', 'EXECUTE') as anon_execute,
          pg_catalog.has_function_privilege('authenticated', 'public.wedding_service_health()', 'EXECUTE') as authenticated_execute,
          pg_catalog.has_function_privilege('wedding_health_other', 'public.wedding_service_health()', 'EXECUTE') as other_execute,
          exists (select 1 from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            where p.oid = 'public.wedding_service_health()'::regprocedure
              and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      `)).rows[0];
      assert.deepEqual(permissions, { anon_execute: true, authenticated_execute: true, other_execute: false, public_execute: false });
      await db.exec('begin read only; set local role wedding_health_other;');
      try {
        await assert.rejects(db.query('select public.wedding_service_health()'), {
          code: '42501', message: /permission denied for function wedding_service_health/,
        });
      } finally {
        await db.exec('rollback');
      }
      assert.deepEqual(await tableData(db), originalData);
      assert.deepEqual(await tableSecurity(db), originalSecurity);
    });
    console.log('Local simulation only: PGlite uses one database connection and synthetic Supabase roles/Auth helpers; cloud PostgREST routing, schema-cache reload, scheduling, and uptime are not verified.');
  } finally {
    await db.close();
  }
});
