import { createClient } from './vendor/supabase-browser.js';

let config = null;
try {
  const response = await fetch(new URL('../data/backend.json', import.meta.url), { cache: 'no-store' });
  if (response.ok) config = await response.json();
} catch { /* Missing configuration must never appear to accept a submission. */ }

function isPublicKey(key) {
  if (typeof key !== 'string' || key.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  // Legacy anon keys are public too; service-role and secret keys fail closed.
  try {
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    const body = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '='))).role === 'anon';
  } catch { return false; }
}
function validConfiguration(value) {
  if (value?.provider !== 'supabase' || !isPublicKey(value.publishableKey)) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && Boolean(url.hostname);
  } catch { return false; }
}
const configured = validConfiguration(config);
export function getServiceStatus() { return { configured }; }
export class RsvpServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'RsvpServiceError'; this.code = code; }
}
function ensureConfigured() {
  if (!configured) throw new RsvpServiceError('NOT_CONFIGURED', '回执服务暂时无法连接，请稍后再来，或直接联系新人。');
}

const messages = Object.freeze({
  INVALID_INPUT: '填写内容无效，请核对姓名和用餐人数后再试。',
  INVALID_NAME: '姓名需为 1–40 个字符，不能包含换行。',
  INVALID_PEOPLE: '用餐人数需为 1–20 位，包含本人。',
  INVALID_ID: '回执标识无效，请刷新页面后再试。',
  INVALID_CURSOR: '名单读取参数无效，请重新登录后再试。',
  ID_CONFLICT: '提交标识发生冲突，请刷新页面后再试。',
  STALE_OPERATION: '人数可能已在另一个页面更新，请刷新后核对，再提交最新信息。',
  RATE_LIMITED: '提交过于频繁，请稍等一分钟后再试。',
  FORBIDDEN: '此账号没有查看回执的权限。',
  UNAUTHENTICATED: '登录已失效，请重新登录。',
  INCONSISTENT_DATA: '回执记录需核对，请联系新人。',
  SERVICE_ERROR: '回执服务暂时不可用，请保留信息并稍后重试。'
});
function serviceError(error, fallback = 'SERVICE_ERROR') {
  if (error instanceof RsvpServiceError) return error;
  let code = fallback;
  if (messages[error?.code]) code = error.code;
  else {
    const message = typeof error?.message === 'string' ? error.message : '';
    const known = Object.keys(messages).find(candidate => message === candidate || message.startsWith(candidate + ':'));
    if (known) code = known;
    else if (error?.status === 429 || error?.code === 'over_request_rate_limit') code = 'RATE_LIMITED';
    else if (error?.status === 401 || ['PGRST301', 'PGRST302', 'bad_jwt', 'session_not_found', 'refresh_token_not_found', 'refresh_token_already_used'].includes(error?.code)) code = 'UNAUTHENTICATED';
    else if (error?.status === 403 || error?.code === '42501') code = 'FORBIDDEN';
    else if (['22P02', '22P03', '22003', '22023'].includes(error?.code)) code = 'INVALID_INPUT';
  }
  return new RsvpServiceError(code, messages[code] || messages.SERVICE_ERROR);
}
const clientCache = new Map();
const operations = new Map();
let signingIn;
let adminAuthorized = false;
function sessionStorageAdapter(kind) {
  const memory = new Map();
  let storage;
  try { storage = globalThis[kind]; } catch {}
  return {
    getItem(key) { try { return storage?.getItem(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; } },
    setItem(key, value) { memory.set(key, value); try { storage?.setItem(key, value); } catch {} },
    removeItem(key) { memory.delete(key); try { storage?.removeItem(key); } catch {} }
  };
}
async function timedFetch(input, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try { return await globalThis.fetch(input, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
function getClient(role) {
  ensureConfigured();
  if (!clientCache.has(role)) {
    const admin = role === 'admin';
    clientCache.set(role, createClient(config.url.replace(/\/+$/, ''), config.publishableKey, {
      auth: {
        storageKey: `wedding-rsvp-${role}:${new URL(config.url).hostname}`,
        storage: sessionStorageAdapter(admin ? 'sessionStorage' : 'localStorage'),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      },
      global: { fetch: timedFetch },
      realtime: { params: { eventsPerSecond: 5 } }
    }));
  }
  return clientCache.get(role);
}
async function rpc(client, name, parameters = {}) {
  let response;
  try { response = await client.rpc(name, parameters); }
  catch { throw new RsvpServiceError('NETWORK_ERROR', '暂时无法连接回执服务，请检查网络后重试。'); }
  if (response.error) throw serviceError(response.error);
  const result = Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : response.data;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new RsvpServiceError('INVALID_RESPONSE', '尚未收到有效确认，请使用相同信息重试。');
  return result;
}
async function ensureVisitor() {
  const client = getClient('guest');
  if (!signingIn) signingIn = (async () => {
    const current = await client.auth.getSession();
    if (current.error) throw serviceError(current.error);
    if (current.data?.session?.user?.is_anonymous === true) return current.data.session.user;
    if (current.data?.session) await client.auth.signOut({ scope: 'local' });
    const anonymous = await client.auth.signInAnonymously();
    if (anonymous.error) throw serviceError(anonymous.error, 'AUTH_FAILED');
    if (!anonymous.data?.user?.id || anonymous.data.user.is_anonymous !== true) throw new RsvpServiceError('AUTH_FAILED', '回执连接未完成，请检查网络后重试。');
    return anonymous.data.user;
  })().catch(error => { signingIn = null; throw error; });
  return signingIn;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new RsvpServiceError('UNSUPPORTED_BROWSER', '当前浏览器版本过旧，请用微信或系统浏览器的新版打开。');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function stableOperation(payload) {
  const key = 'wedding-rsvp-operation:' + payload.submissionId;
  const fingerprint = JSON.stringify([payload.name, payload.people]);
  let previous = operations.get(key);
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (Number.isSafeInteger(stored?.clientVersion) && (!previous || stored.clientVersion >= previous.clientVersion)) previous = stored;
  } catch {}
  const valid = UUID.test(previous?.operationId || '') && Number.isSafeInteger(previous?.clientVersion) && previous.clientVersion > 0;
  if (!valid || previous.fingerprint !== fingerprint) {
    previous = { fingerprint, operationId: randomUuid(), clientVersion: Math.max(Date.now(), valid ? previous.clientVersion + 1 : 1) };
  }
  operations.set(key, previous);
  try { localStorage.setItem(key, JSON.stringify(previous)); } catch {}
  return previous;
}
function validReceipt(result) {
  return typeof result?.id === 'string' && Boolean(result.id) && typeof result.name === 'string' && Boolean(result.name.trim()) && Number.isInteger(result.people) && result.people >= 1 && result.people <= 20 && typeof result.createdAt === 'string' && Number.isFinite(Date.parse(result.createdAt)) && typeof result.submittedAt === 'string' && Number.isFinite(Date.parse(result.submittedAt));
}
export async function submitRsvp({ name, people, submissionId }) {
  ensureConfigured();
  const normalizedName = typeof name === 'string' ? name.trim().normalize('NFC') : '';
  if (!normalizedName || [...normalizedName].length > 40 || /[\u0000-\u001f\u007f]/u.test(normalizedName)) throw new RsvpServiceError('INVALID_NAME', messages.INVALID_NAME);
  if (!Number.isInteger(people) || people < 1 || people > 20) throw new RsvpServiceError('INVALID_PEOPLE', messages.INVALID_PEOPLE);
  if (!UUID.test(submissionId || '')) throw new RsvpServiceError('INVALID_ID', messages.INVALID_ID);
  await ensureVisitor();
  const operation = stableOperation({ name: normalizedName, people, submissionId });
  let result;
  try {
    result = await rpc(getClient('guest'), 'submit_wedding_rsvp', {
      p_name: normalizedName, p_people: people, p_submission_id: submissionId,
      p_operation_id: operation.operationId, p_client_version: operation.clientVersion
    });
  } catch (error) { if (error.code === 'UNAUTHENTICATED') signingIn = null; throw error; }
  if (!validReceipt(result)) throw new RsvpServiceError('INVALID_RESPONSE', '尚未收到有效确认，请使用相同信息重试。');
  return { id: result.id, name: result.name, people: result.people, createdAt: result.createdAt, submittedAt: result.submittedAt };
}
export async function getAdminSession() {
  const response = await getClient('admin').auth.getSession();
  if (response.error) throw serviceError(response.error);
  const session = response.data?.session;
  return session?.user?.id && session.user.is_anonymous !== true ? session : null;
}
export async function authorizeAdmin() {
  adminAuthorized = false;
  if (!await getAdminSession()) throw new RsvpServiceError('UNAUTHENTICATED', messages.UNAUTHENTICATED);
  const result = await rpc(getClient('admin'), 'authorize_wedding_admin');
  if (result.authorized !== true) throw new RsvpServiceError('FORBIDDEN', messages.FORBIDDEN);
  adminAuthorized = true;
  return result;
}
export async function signInAdmin({ email, password }) {
  const client = getClient('admin');
  adminAuthorized = false;
  const response = await client.auth.signInWithPassword({ email: typeof email === 'string' ? email.trim() : '', password });
  if (response.error || !response.data?.session) throw new RsvpServiceError('LOGIN_FAILED', '登录失败，请核对邮箱和密码。');
  try { await authorizeAdmin(); }
  catch (error) { try { await client.auth.signOut({ scope: 'local' }); } catch {} throw error; }
  return response.data.session;
}
export async function signOutAdmin() {
  const client = getClient('admin');
  adminAuthorized = false;
  await client.removeAllChannels();
  const response = await client.auth.signOut({ scope: 'local' });
  if (response.error) throw new RsvpServiceError('SIGN_OUT_FAILED', '退出登录未完成，请检查网络后重试。');
}
export async function listRsvps({ cursor = null } = {}) {
  const result = await rpc(getClient('admin'), 'list_wedding_rsvps', { p_cursor: cursor, p_limit: 100 });
  if (!Array.isArray(result.rows) || !result.rows.every(validReceipt) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new RsvpServiceError('INVALID_RESPONSE', '名单读取结果不完整，请稍后重试。');
  return result;
}
export function watchRsvpChanges({ onChange, onError } = {}) {
  const client = getClient('admin');
  if (!adminAuthorized) throw new RsvpServiceError('FORBIDDEN', messages.FORBIDDEN);
  let closed = false;
  const channel = client.channel('wedding-rsvp-admin-' + randomUuid())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wedding_rsvps' }, () => { if (!closed) onChange?.(); })
    .subscribe(status => {
      if (closed) return;
      if (status === 'SUBSCRIBED') onChange?.();
      else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) onError?.(new RsvpServiceError('REALTIME_DISCONNECTED', '实时连接中断，请稍候重试。'));
    });
  return { close() { if (closed) return; closed = true; Promise.resolve(client.removeChannel(channel)).catch(() => {}); } };
}
