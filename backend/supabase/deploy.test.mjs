import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './deploy.mjs';

const syntheticToken = 'sbp_' + 'fixture_only_never_a_real_key'.repeat(2);
const ref = 'abcdefghijklmnopqrst';
const createArgs = ['prepare', '--org', 'free-fixture', '--name', 'wedding-rsvp', '--create', '--apply'];
const response = body => new Response(JSON.stringify(body), { status: 200 });
async function fixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'wedding-deploy-test-'));
  try { await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const rejectsWith = (promise, code) => assert.rejects(promise, error => error.code === code);

test('offline dry-runs perform no fetch, state write, or credential disclosure', async () => fixture(async dir => {
  const logs = [];
  let calls = 0;
  const options = { baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, log: line => logs.push(line), fetch: () => { calls++; throw new Error('Must not run'); } };
  await runCli(createArgs.slice(0, -1), options);
  await runCli(['deploy', '--org', 'free-fixture', '--admin-email', 'host@example.invalid', '--org-token-file', join(dir, 'missing-org-token')], options);
  assert.equal(calls, 0);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => JSON.parse(line).dryRun));
  assert.ok(!logs.join('').includes(syntheticToken));
  await assert.rejects(stat(join(dir, 'local-secrets')), { code: 'ENOENT' });
}));

test('missing --create and conflicting dry-run/apply fail before networking', async () => {
  let calls = 0;
  const options = { env: {}, fetch: () => { calls++; } };
  await rejectsWith(runCli(['prepare', '--org', 'free-fixture', '--name', 'wedding-rsvp'], options), 'CREATE_REQUIRED');
  await rejectsWith(runCli([...createArgs, '--dry-run'], options), 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
});

test('world-readable credential files are rejected before networking', async () => fixture(async dir => {
  const path = join(dir, 'unsafe-token');
  await writeFile(path, syntheticToken, { mode: 0o644 });
  let calls = 0;
  await rejectsWith(runCli(['list', '--token-file', path], { env: {}, fetch: () => { calls++; } }), 'UNSAFE_CREDENTIAL_FILE');
  assert.equal(calls, 0);
}));

test('organization plan credential must also be protected and cannot fall back to a primary token', async () => fixture(async dir => {
  const path = join(dir, 'unsafe-org-token');
  await writeFile(path, 'org_fixture_only_' + 'x'.repeat(32), { mode: 0o644 });
  let calls = 0;
  await rejectsWith(runCli([...createArgs, '--org-token-file', path], {
    baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, fetch: () => { calls++; }
  }), 'UNSAFE_CREDENTIAL_FILE');
  assert.equal(calls, 0);
}));

test('organization Free check 403 stops deploy without retrying with project credentials', async () => fixture(async dir => {
  const path = join(dir, 'org-token');
  const orgToken = 'org_fixture_only_' + 'x'.repeat(32);
  await writeFile(path, orgToken, { mode: 0o600 });
  const calls = [];
  await rejectsWith(runCli(['deploy', '--org', 'free-fixture', '--admin-email', 'host@example.invalid', '--org-token-file', path, '--apply'], {
    baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, fetch: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization });
      return new Response('{}', { status: 403 });
    }
  }), 'HTTP_403');
  assert.deepEqual(calls, [{ url: 'https://api.supabase.com/v1/organizations/free-fixture', method: 'GET', authorization: `Bearer ${orgToken}` }]);
}));

test('paid or unverified organization plans never reach project creation', async () => fixture(async dir => {
  for (const plan of ['pro', undefined]) {
    const calls = [];
    await rejectsWith(runCli(createArgs, { baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken },
      fetch: async (url, init) => { calls.push([url, init.method]); return response({ plan }); } }), 'FREE_PLAN_REQUIRED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'GET');
  }
}));

test('unknown matching project is never adopted or overwritten', async () => fixture(async dir => {
  const calls = [];
  await rejectsWith(runCli(createArgs, { baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken },
    fetch: async (url, init) => {
      calls.push([url, init.method]);
      return url.endsWith('/organizations/free-fixture') ? response({ plan: 'free' })
        : response([{ ref, name: 'wedding-rsvp', organization_slug: 'free-fixture', region: 'ap-southeast-1' }]);
    } }), 'UNKNOWN_MATCHING_PROJECT');
  assert.ok(calls.every(([, method]) => method === 'GET'));
  await assert.rejects(stat(join(dir, 'local-secrets')), { code: 'ENOENT' });
}));

test('uncertain project creation preserves 0600 intent and never issues a second POST', async () => fixture(async dir => {
  const calls = [];
  const logs = [];
  let posted = false;
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/organizations/free-fixture')) return response({ plan: 'free' });
    if (url.endsWith('/projects') && init.method === 'GET') return response([]);
    if (url.includes('/available-regions?')) return response({ all: { specific: [{ code: 'ap-southeast-1' }] } });
    posted = true;
    throw new Error('Synthetic network uncertainty');
  };
  const options = { baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, fetch, log: value => logs.push(value) };
  await rejectsWith(runCli(createArgs, options), 'UNKNOWN_NETWORK_OUTCOME');
  const path = join(dir, 'local-secrets/deployment.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(posted, true);
  assert.equal(saved.creationAttempted, true);
  assert.ok(saved.dbPassword.length >= 40);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'local-secrets'))).mode & 0o777, 0o700);
  assert.ok(!(await readFile(path, 'utf8')).includes(syntheticToken));
  const originalPosts = calls.filter(call => call.method === 'POST').length;
  await rejectsWith(runCli(createArgs, options), 'UNRESOLVED_PROJECT_CREATION');
  assert.equal(calls.filter(call => call.method === 'POST').length, originalPosts);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).dbPassword, saved.dbPassword);
  assert.ok(!logs.join('').includes(saved.dbPassword));
}));

test('explicit Free Singapore creation uses current official fields and logs no password', async () => fixture(async dir => {
  const logs = [];
  let creationBody;
  const options = { baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, log: value => logs.push(value),
    fetch: async (url, init) => {
      if (url.endsWith('/organizations/free-fixture')) return response({ plan: 'free' });
      if (url.endsWith('/projects') && init.method === 'GET') return response([]);
      if (url.includes('/available-regions?')) return response({ all: { specific: [{ code: 'ap-southeast-1' }] } });
      creationBody = JSON.parse(init.body);
      return response({ ref, name: creationBody.name, organization_slug: creationBody.organization_slug, region: 'ap-southeast-1', status: 'COMING_UP' });
    } };
  await runCli(createArgs, options);
  assert.deepEqual(creationBody.region_selection, { type: 'specific', code: 'ap-southeast-1' });
  assert.equal(creationBody.organization_slug, 'free-fixture');
  assert.equal(creationBody.plan, undefined);
  assert.equal(creationBody.desired_instance_size, undefined);
  const saved = JSON.parse(await readFile(join(dir, 'local-secrets/deployment.json'), 'utf8'));
  assert.equal(saved.projectRef, ref);
  assert.equal(saved.creationResolved, true);
  assert.equal(saved.dbPassword, creationBody.db_pass);
  assert.ok(!logs.join('').includes(creationBody.db_pass));
  assert.ok(!logs.join('').includes(syntheticToken));
}));

test('unknown configured administrator stops deploy before schema/Auth mutations', async () => fixture(async dir => {
  await mkdir(join(dir, 'local-secrets'), { mode: 0o700 });
  await writeFile(join(dir, 'local-secrets/deployment.json'), JSON.stringify({ orgSlug: 'free-fixture', name: 'wedding-rsvp',
    projectRef: ref, creationResolved: true, dbPassword: 'synthetic-db-password' }), { mode: 0o600 });
  const mutations = [];
  await rejectsWith(runCli(['deploy', '--org', 'free-fixture', '--admin-email', 'host@example.invalid', '--apply'], {
    baseDir: dir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, fetch: async (url, init) => {
      if (url.endsWith('/organizations/free-fixture')) return response({ plan: 'free' });
      if (url.endsWith('/projects/' + ref)) return response({ ref, name: 'wedding-rsvp', organization_slug: 'free-fixture', region: 'ap-southeast-1', status: 'ACTIVE_HEALTHY' });
      if (url.endsWith('/database/query')) {
        const body = JSON.parse(init.body);
        if (!body.read_only) mutations.push(body.query);
        return body.query.includes('pg_catalog.pg_tables') ? response([{ schemaname: 'private', tablename: 'settings' }])
          : response([{ admin_uid: '00000000-0000-4000-8000-000000000999' }]);
      }
      mutations.push(url); throw new Error('Unexpected mutation');
    }
  }), 'UNKNOWN_ADMINISTRATOR');
  assert.deepEqual(mutations, []);
}));

test('successful mocked deployment writes only public configuration and keeps passwords private', async () => fixture(async dir => {
  const baseDir = join(dir, 'backend/supabase');
  await mkdir(join(baseDir, 'local-secrets'), { recursive: true, mode: 0o700 });
  await writeFile(join(baseDir, 'schema.sql'), await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const statePath = join(baseDir, 'local-secrets/deployment.json');
  await writeFile(statePath, JSON.stringify({ orgSlug: 'free-fixture', name: 'wedding-rsvp',
    projectRef: ref, creationResolved: true, dbPassword: 'synthetic-db-password' }), { mode: 0o600 });
  const publicKey = 'sb_publishable_fixture_only';
  const serviceKey = 'fixture.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.fixture';
  const adminUid = '00000000-0000-4000-8000-000000000123';
  const orgToken = 'org_fixture_only_' + 'x'.repeat(32);
  const orgTokenPath = join(dir, 'org-token');
  await writeFile(orgTokenPath, orgToken, { mode: 0o600 });
  const logs = [];
  let adminPassword;
  await runCli(['deploy', '--org', 'free-fixture', '--admin-email', 'host@example.invalid', '--org-token-file', orgTokenPath, '--apply'], {
    baseDir, env: { SUPABASE_ACCESS_TOKEN: syntheticToken }, log: line => logs.push(line),
    fetch: async (url, init) => {
      if (url.endsWith('/organizations/free-fixture')) {
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, `Bearer ${orgToken}`);
        return response({ plan: 'free' });
      }
      if (url.startsWith('https://api.supabase.com/v1/')) assert.equal(init.headers.Authorization, `Bearer ${syntheticToken}`);
      if (url.endsWith('/projects/' + ref)) return response({ ref, name: 'wedding-rsvp', organization_slug: 'free-fixture', region: 'ap-southeast-1', status: 'ACTIVE_HEALTHY' });
      if (url.endsWith('/database/query')) return response([]);
      if (url.endsWith('/config/auth')) {
        if (init.method === 'PATCH') assert.deepEqual(JSON.parse(init.body), {
          external_anonymous_users_enabled: true, external_email_enabled: true,
          disable_signup: false, rate_limit_anonymous_users: 300
        });
        return response({ external_anonymous_users_enabled: true, rate_limit_anonymous_users: 300 });
      }
      if (url.endsWith('/api-keys?reveal=true')) return response([{ api_key: publicKey }, { api_key: serviceKey }]);
      if (url.includes('/admin/users?page=')) return response({ users: [] });
      if (url.endsWith('/admin/users') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        adminPassword = body.password;
        assert.equal(body.email_confirm, true);
        assert.equal(body.email, 'host@example.invalid');
        return response({ id: adminUid, email: body.email, is_anonymous: false });
      }
      throw new Error('Unexpected mocked endpoint');
    }
  });
  const publicContent = await readFile(join(dir, 'data/backend.json'), 'utf8');
  assert.deepEqual(JSON.parse(publicContent), { provider: 'supabase', url: `https://${ref}.supabase.co`, publishableKey: publicKey, pollIntervalMs: 5000 });
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.adminUid, adminUid);
  assert.equal(saved.adminPassword, adminPassword);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  for (const secret of [syntheticToken, orgToken, serviceKey, saved.dbPassword, saved.adminPassword, adminUid]) {
    assert.ok(!publicContent.includes(secret));
    assert.ok(!logs.join('').includes(secret));
  }
  assert.ok(!(await readFile(statePath, 'utf8')).includes(orgToken));
  assert.ok(!(await readFile(statePath, 'utf8')).includes(syntheticToken));
}));
