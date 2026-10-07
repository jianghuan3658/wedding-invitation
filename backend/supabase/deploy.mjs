#!/usr/bin/env node
// Official Supabase Management/Auth APIs only. No API response bodies or secrets in logs.
import { readFile, writeFile, mkdir, lstat, chmod, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const OWN_DIR = dirname(fileURLToPath(import.meta.url));
const MANAGEMENT = 'https://api.supabase.com/v1';
const REGION = 'ap-southeast-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF = /^[a-z]{20}$/;
class DeploymentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new DeploymentError(code, message); }
const usage = `Wedding RSVP Supabase deployment (Node.js 20+)
  node backend/supabase/deploy.mjs list [--token-file PATH]
  node backend/supabase/deploy.mjs prepare --org SLUG --name NAME --create [--apply]
  node backend/supabase/deploy.mjs deploy --org SLUG --admin-email EMAIL [--project REF] [--org-token-file PATH] [--apply]
prepare/deploy default to an offline dry-run. --apply explicitly enables cloud writes.
Credentials: SUPABASE_ACCESS_TOKEN in the environment, or a protected 0600 --token-file.
Optional --org-token-file is used only for the Free organization plan GET; project calls keep the primary project-scoped token.
No token/password command-line option is supported. No plan upgrade or resource deletion exists.
`;

function parseArgs(argv) {
  const result = { command: argv[0], apply: false, create: false };
  const values = new Set(['org', 'name', 'admin-email', 'project', 'token-file', 'org-token-file']);
  const switches = new Set(['apply', 'create', 'dry-run', 'help']);
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail('INVALID_ARGUMENT', 'Unexpected argument. Use --help.');
    const key = arg.slice(2);
    if (Object.hasOwn(result, key) && !['apply', 'create'].includes(key)) fail('INVALID_ARGUMENT', 'Duplicate option.');
    if (switches.has(key)) result[key] = true;
    else if (values.has(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) result[key] = argv[++index];
    else fail('INVALID_ARGUMENT', 'Unsupported or incomplete option. Use --help.');
  }
  if (result.apply && result['dry-run']) fail('INVALID_ARGUMENT', '--apply and --dry-run cannot be combined.');
  return result;
}
function identifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_ARGUMENT', `${label} is missing or invalid.`);
  return value;
}
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('INVALID_ARGUMENT', 'An explicit valid --admin-email is required.');
  return value.trim().toLowerCase();
}
async function protectedJson(path) {
  let metadata;
  try { metadata = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || (process.getuid && metadata.uid !== process.getuid()) || metadata.size > 100000) {
    fail('UNSAFE_LOCAL_FILE', 'Credential/state file must be a current-user-owned regular file with 0600 or stricter permissions.');
  }
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { fail('INVALID_LOCAL_STATE', 'Protected JSON file could not be read.'); }
}
async function accessToken(args, env) {
  let value = env.SUPABASE_ACCESS_TOKEN;
  if (!value && args['token-file']) {
    const path = resolve(args['token-file']);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
      || (process.getuid && metadata.uid !== process.getuid()) || metadata.size > 10000) {
      fail('UNSAFE_CREDENTIAL_FILE', 'The token file must be current-user-owned with 0600 or stricter permissions.');
    }
    const content = (await readFile(path, 'utf8')).trim();
    if (content.startsWith('{')) {
      let object;
      try { object = JSON.parse(content); } catch { fail('INVALID_CREDENTIAL_FILE', 'Could not parse the protected token file.'); }
      value = object.SUPABASE_ACCESS_TOKEN || object.access_token || object.token;
    } else value = content;
  }
  if (typeof value !== 'string' || value.length < 20 || value.length > 4096 || /\s/.test(value)) {
    fail('MISSING_TOKEN', 'Provide SUPABASE_ACCESS_TOKEN via environment or a protected --token-file; never put its value in CLI arguments.');
  }
  return value;
}
function jwtRole(key) {
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role; }
  catch { return null; }
}
function chooseKeys(keys) {
  if (!Array.isArray(keys)) fail('INVALID_API_RESPONSE', 'API key metadata was not an array.');
  const values = keys.map(item => item.api_key).filter(key => typeof key === 'string');
  const publishable = values.find(key => /^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) || values.find(key => jwtRole(key) === 'anon');
  const secret = values.find(key => jwtRole(key) === 'service_role') || values.find(key => /^sb_secret_[A-Za-z0-9_-]+$/.test(key));
  if (!publishable || !secret) fail('MISSING_PROJECT_KEYS', 'The management token must be permitted to reveal both public and server-only project keys.');
  return { publishable, secret };
}
function projectRef(project) { return identifier(project?.ref || project?.id, REF, 'Project reference'); }
function projectInOrg(project, slug) { return (project.organization_slug || project.organization_id) === slug; }
function projectMatches(project, state) {
  return projectInOrg(project, state.orgSlug) && project.name === state.name && project.region === REGION;
}

export async function runCli(argv, options = {}) {
  const env = options.env || process.env;
  const baseDir = options.baseDir || OWN_DIR;
  const fetchImpl = options.fetch || globalThis.fetch;
  const log = options.log || (value => process.stdout.write(`${value}\n`));
  const args = parseArgs(argv);
  if (!args.command || args.command === '--help' || args.help) { log(usage); return; }
  if (!['list', 'prepare', 'deploy'].includes(args.command)) fail('INVALID_ARGUMENT', 'Unknown command. Use --help.');
  if (args.command !== 'list') {
    identifier(args.org, /^[A-Za-z0-9_-]{1,100}$/, 'Organization slug');
    if (args.command === 'prepare') {
      if (!args.create) fail('CREATE_REQUIRED', 'prepare requires explicit --create. Existing unknown projects are never adopted automatically.');
      identifier(args.name, /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/, 'Project name');
    } else {
      emailAddress(args['admin-email']);
      if (args.project) identifier(args.project, REF, 'Project reference');
    }
  }
  if (args.command !== 'list' && !args.apply) {
    log(JSON.stringify({ dryRun: true, command: args.command, org: args.org,
      name: args.name || null, project: args.project || 'known local state only', region: REGION,
      actions: args.command === 'prepare'
        ? ['verify the explicitly selected organization is Free', 'list/reconcile before any creation', 'create one Singapore project only if no unknown match exists', 'save password and project reference locally with 0600']
        : ['verify known owned project and Free organization', 'refuse unrelated database tables or unknown administrator', 'apply schema', 'enable anonymous Auth with 300 new identities/IP/hour', 'create/reconcile the explicitly named permanent administrator', 'bind administrator privately', 'write public project URL and publishable key'] }));
    return;
  }
  const token = await accessToken(args, env);
  async function request(url, { method = 'GET', body, key, label = 'API request' } = {}, managementToken = token) {
    const headers = { 'Content-Type': 'application/json' };
    if (url.startsWith(MANAGEMENT + '/')) headers.Authorization = `Bearer ${managementToken}`;
    else if (key) {
      headers.apikey = key;
      if (jwtRole(key)) headers.Authorization = `Bearer ${key}`;
    } else fail('INVALID_REQUEST', 'A project request has no API key.');
    let response;
    try {
      response = await fetchImpl(url, { method, headers, redirect: 'error',
        signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail('UNKNOWN_NETWORK_OUTCOME', `${label} did not return a definitive response. Reconcile existing resources before repeating any creation.`); }
    if (!response.ok) fail(`HTTP_${response.status}`, `${label} was rejected. Provider response bodies are intentionally not printed.`);
    try { return await response.json(); }
    catch { fail('UNKNOWN_API_RESPONSE', `${label} returned an unreadable response. Reconcile before another creation.`); }
  }
  const api = (path, options) => request(MANAGEMENT + path, options);
  async function requireFree(slug) {
    // An explicitly supplied organization credential is read independently of the
    // primary token environment and is never passed to project/database/key APIs.
    const orgToken = args['org-token-file']
      ? await accessToken({ 'token-file': args['org-token-file'] }, {}) : token;
    const organization = await request(MANAGEMENT + `/organizations/${encodeURIComponent(slug)}`,
      { label: 'Organization plan check' }, orgToken);
    if (organization.plan !== 'free') fail('FREE_PLAN_REQUIRED', 'Only a verified Free organization is permitted; missing or paid plan information is refused.');
    return organization;
  }
  async function listProjects() {
    const projects = await api('/projects', { label: 'Project inventory' });
    if (!Array.isArray(projects)) fail('INVALID_API_RESPONSE', 'Project inventory was not an array.');
    return projects;
  }
  if (args.command === 'list') {
    const organizations = await api('/organizations', { label: 'Organization inventory' });
    const projects = await listProjects();
    if (!Array.isArray(organizations)) fail('INVALID_API_RESPONSE', 'Organization inventory was not an array.');
    log(JSON.stringify({ organizations: organizations.map(({ slug, id, name }) => ({ slug: slug || id, name })),
      projects: projects.map(project => ({ ref: projectRef(project), name: project.name,
        org: project.organization_slug || project.organization_id, region: project.region, status: project.status })) }));
    return;
  }
  // Keep only password/account state here; the access token is never copied to this file.
  const stateDir = join(baseDir, 'local-secrets');
  const statePath = join(stateDir, 'deployment.json');
  let state = await protectedJson(statePath);
  async function saveState() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(stateDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('UNSAFE_LOCAL_STATE', 'Local state directory must be a regular directory.');
    await chmod(stateDir, 0o700);
    const temp = join(stateDir, `deployment.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, statePath);
    await chmod(statePath, 0o600);
  }
  await requireFree(args.org);
  if (state && state.orgSlug !== args.org) fail('LOCAL_STATE_CONFLICT', 'Local state belongs to a different organization. It will not be overwritten.');
  if (args.command === 'prepare') {
    if (state && state.name !== args.name) fail('LOCAL_STATE_CONFLICT', 'Local state belongs to a different project name. It will not be overwritten.');
    const projects = await listProjects();
    const matching = projects.filter(project => projectInOrg(project, args.org) && project.name === args.name);
    if (state?.projectRef) {
      const known = matching.find(project => projectRef(project) === state.projectRef);
      if (!known || !projectMatches(known, state)) fail('PROJECT_STATE_CONFLICT', 'The known project cannot be verified from the inventory.');
      log(JSON.stringify({ prepared: true, projectRef: state.projectRef, status: known.status, reusedKnownState: true }));
      return;
    }
    if (state?.creationAttempted) {
      const candidates = matching.filter(project => projectMatches(project, state)
        && Number.isFinite(Date.parse(project.created_at)) && Date.parse(project.created_at) >= Date.parse(state.intentAt) - 10000);
      if (candidates.length !== 1) fail('UNRESOLVED_PROJECT_CREATION', 'The previous creation outcome is still unknown. No second project will be created; inspect the inventory/dashboard and reconcile this intent.');
      state.projectRef = projectRef(candidates[0]);
      state.creationResolved = true;
      await saveState();
      log(JSON.stringify({ prepared: true, projectRef: state.projectRef, status: candidates[0].status, reconciled: true }));
      return;
    }
    if (matching.length) fail('UNKNOWN_MATCHING_PROJECT', 'A matching project exists without trusted local creation state. It will not be adopted or modified.');
    const regions = await api(`/projects/available-regions?organization_slug=${encodeURIComponent(args.org)}`, { label: 'Singapore availability check' });
    const region = regions?.all?.specific?.find(item => item.code === REGION);
    if (!region || region.status) fail('REGION_UNAVAILABLE', 'Singapore is unavailable or capacity-constrained. No alternate region will be chosen automatically.');
    state = { format: 1, orgSlug: args.org, name: args.name, region: REGION,
      dbPassword: `A1!${randomBytes(30).toString('base64url')}z`, intentAt: new Date().toISOString(), creationAttempted: true };
    await saveState();
    const created = await api('/projects', { method: 'POST', label: 'Project creation', body: {
      organization_slug: args.org, name: args.name, db_pass: state.dbPassword,
      region_selection: { type: 'specific', code: REGION }
    } });
    if (!projectMatches(created, state)) fail('UNKNOWN_PROJECT_RESPONSE', 'Created-project metadata did not match the saved intent. Reconcile the inventory before proceeding.');
    state.projectRef = projectRef(created);
    state.creationResolved = true;
    await saveState();
    log(JSON.stringify({ prepared: true, projectRef: state.projectRef, status: created.status }));
    return;
  }
  if (!state?.creationResolved || !state.projectRef || !state.dbPassword) fail('PREPARE_REQUIRED', 'No trusted created-project state exists. Complete prepare first.');
  identifier(state.projectRef, REF, 'Known project reference');
  if (args.project && args.project !== state.projectRef) fail('PROJECT_STATE_CONFLICT', 'The explicit project differs from protected local state.');
  const project = await api(`/projects/${state.projectRef}`, { label: 'Known-project check' });
  if (!projectMatches(project, state)) fail('PROJECT_STATE_CONFLICT', 'Project metadata differs from protected local creation state.');
  if (project.status !== 'ACTIVE_HEALTHY') fail('PROJECT_NOT_READY', 'The known project is not ACTIVE_HEALTHY. Check its status later; no database write was attempted.');
  const projectURL = `https://${state.projectRef}.supabase.co`;
  const sql = (query, readOnly = false) => api(`/projects/${state.projectRef}/database/query`, {
    method: 'POST', body: { query, read_only: readOnly }, label: readOnly ? 'Database ownership check' : 'Database configuration'
  });
  const tables = await sql("select schemaname, tablename from pg_catalog.pg_tables where schemaname in ('public','private')", true);
  const allowed = new Set(['public.wedding_rsvps', 'private.settings', 'private.wedding_rsvp_operations', 'private.wedding_rsvp_limits']);
  if (!Array.isArray(tables) || tables.some(row => !allowed.has(`${row.schemaname}.${row.tablename}`))) {
    fail('UNRELATED_DATABASE_DATA', 'The project contains unknown public/private tables and will not be modified.');
  }
  const adminEmail = emailAddress(args['admin-email']);
  if (state.adminEmail && state.adminEmail !== adminEmail) fail('ADMIN_STATE_CONFLICT', 'The known administrator email cannot be changed by this script.');
  if (tables.some(row => row.schemaname === 'private' && row.tablename === 'settings')) {
    const existing = await sql('select admin_uid::text from private.settings where singleton', true);
    if (!Array.isArray(existing) || existing.some(row => row.admin_uid !== state.adminUid)) {
      fail('UNKNOWN_ADMINISTRATOR', 'An administrator not recorded in protected local state is already configured. It will not be replaced.');
    }
  }
  const schema = await readFile(join(baseDir, 'schema.sql'), 'utf8');
  await sql(schema);
  state.schemaHash = createHash('sha256').update(schema).digest('hex');
  await saveState();
  await api(`/projects/${state.projectRef}/config/auth`, { method: 'PATCH', label: 'Anonymous Auth configuration', body: {
    external_anonymous_users_enabled: true, external_email_enabled: true,
    disable_signup: false, rate_limit_anonymous_users: 300
  } });
  const authConfiguration = await api(`/projects/${state.projectRef}/config/auth`, { label: 'Auth configuration verification' });
  if (authConfiguration.external_anonymous_users_enabled !== true || authConfiguration.rate_limit_anonymous_users !== 300) {
    fail('AUTH_CONFIG_NOT_VERIFIED', 'The requested anonymous Auth settings were not confirmed.');
  }
  const keys = chooseKeys(await api(`/projects/${state.projectRef}/api-keys?reveal=true`, { label: 'Project-key retrieval' }));
  const auth = (path, options = {}) => request(projectURL + '/auth/v1' + path, { ...options, key: options.key || keys.secret });
  const matches = [];
  for (let page = 1; page <= 20; page++) {
    const result = await auth(`/admin/users?page=${page}&per_page=100`, { label: 'Administrator account inventory' });
    if (!Array.isArray(result.users)) fail('INVALID_API_RESPONSE', 'Auth user inventory was not an array.');
    matches.push(...result.users.filter(user => String(user.email || '').toLowerCase() === adminEmail));
    if (result.users.length < 100) break;
    if (page === 20) fail('AUTH_INVENTORY_TOO_LARGE', 'Auth inventory exceeded the safe reconciliation bound. No account was created.');
  }
  if (matches.length > 1) fail('ADMIN_ACCOUNT_CONFLICT', 'More than one matching administrator account exists.');
  if (state.adminUid) {
    if (matches[0]?.id !== state.adminUid || matches[0]?.is_anonymous === true) fail('ADMIN_STATE_CONFLICT', 'The known permanent administrator account could not be verified.');
  } else if (matches.length) {
    if (!state.adminCreationPending || !state.adminPassword) fail('UNKNOWN_ADMIN_ACCOUNT', 'The email is already assigned to an unknown account. No password or account will be changed.');
    // An uncertain account creation is reconciled by proving the saved password works.
    const verified = await auth('/token?grant_type=password', { method: 'POST', key: keys.publishable,
      label: 'Uncertain administrator creation reconciliation', body: { email: adminEmail, password: state.adminPassword } });
    if (verified.user?.id !== matches[0].id || verified.user?.is_anonymous === true) fail('ADMIN_RECONCILIATION_FAILED', 'The matching account could not be proven to belong to this deployment intent.');
    state.adminUid = identifier(verified.user.id, UUID, 'Administrator UUID');
    state.adminCreationPending = false;
    await saveState();
  } else {
    if (state.adminCreationPending) fail('UNRESOLVED_ADMIN_CREATION', 'The prior account creation outcome is unknown and no matching user is visible. No duplicate account creation will be attempted.');
    state.adminEmail = adminEmail;
    state.adminPassword = `A1!${randomBytes(24).toString('base64url')}z`;
    state.adminCreationPending = true;
    await saveState();
    const result = await auth('/admin/users', { method: 'POST', label: 'Permanent administrator creation', body: {
      email: adminEmail, password: state.adminPassword, email_confirm: true
    } });
    const user = result.user || result;
    if (String(user.email || '').toLowerCase() !== adminEmail || user.is_anonymous === true) fail('UNKNOWN_ADMIN_RESPONSE', 'The new administrator response did not match the saved account intent.');
    state.adminUid = identifier(user.id, UUID, 'Administrator UUID');
    state.adminCreationPending = false;
    await saveState();
  }
  // UUID is validated before interpolation; no email/password/token enters SQL text.
  await sql(`do $configure$ begin
    if exists(select 1 from private.settings where singleton and admin_uid <> '${state.adminUid}'::uuid) then
      raise exception 'UNKNOWN_ADMINISTRATOR';
    end if;
    if not exists(select 1 from auth.users where id = '${state.adminUid}'::uuid and is_anonymous is false and email is not null) then
      raise exception 'INVALID_ADMINISTRATOR';
    end if;
    insert into private.settings(singleton,admin_uid,updated_at) values(true,'${state.adminUid}'::uuid,now())
    on conflict(singleton) do update set updated_at=excluded.updated_at where private.settings.admin_uid=excluded.admin_uid;
  end; $configure$;`);
  const outputPath = resolve(baseDir, '../../data/backend.json');
  let current;
  try { current = JSON.parse(await readFile(outputPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail('PUBLIC_CONFIG_UNREADABLE', 'Existing public backend configuration could not be parsed.'); }
  if (current?.url && current.url !== projectURL) fail('PUBLIC_CONFIG_CONFLICT', 'An existing public configuration points to a different project and will not be replaced.');
  const publicConfig = { provider: 'supabase', url: projectURL, publishableKey: keys.publishable, pollIntervalMs: 5000 };
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryOutput = outputPath + '.supabase-public.tmp';
  await writeFile(temporaryOutput, JSON.stringify(publicConfig, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  await rename(temporaryOutput, outputPath);
  state.deployedAt = new Date().toISOString();
  await saveState();
  log(JSON.stringify({ deployed: true, projectRef: state.projectRef, publicConfigPath: outputPath,
    privateCredentialsPath: statePath, next: 'Verify actual guest submission, private admin access and realtime behavior before publishing.' }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch(error => {
    if (error instanceof DeploymentError) process.stderr.write(`ERROR ${error.code}: ${error.message}\n`);
    else process.stderr.write('ERROR LOCAL_OR_API_FAILURE: Operation failed. No raw error details or credentials are printed.\n');
    process.exitCode = 1;
  });
}
