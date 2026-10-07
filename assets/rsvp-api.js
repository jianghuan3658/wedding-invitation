import { createCloudbaseApp } from './vendor/cloudbase-browser.js';

let config = null;
try {
  const response = await fetch(new URL('../data/backend.json', import.meta.url), { cache: 'no-store' });
  if (response.ok) config = await response.json();
} catch { /* A missing config must remain visibly unconfigured. */ }
const configured = Boolean(config?.provider === 'cloudbase' && config.env && config.adminUid && config.functionName && ['ap-shanghai', 'ap-guangzhou'].includes(config.region));
export function getServiceStatus() { return { configured }; }
let app;
let auth;
let signingIn;
const operations = new Map();
export class RsvpServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'RsvpServiceError'; this.code = code; }
}
function ensureConfigured() {
  if (!configured) throw new RsvpServiceError('NOT_CONFIGURED', '报名服务尚未开通，当前填写不会上传。请稍后再来，或直接联系新人。');
}
export function getCloudbaseClient() {
  ensureConfigured();
  if (!app) {
    app = createCloudbaseApp({ env: config.env, region: config.region, persistence: 'local', timeout: 15000 });
    auth = app.auth({ persistence: 'local' });
  }
  return { app, auth, config: { ...config } };
}
function authError(result) {
  if (result?.error) throw new RsvpServiceError(result.error.code || 'AUTH_FAILED', '身份连接失败，请检查网络后重试。');
  return result?.data;
}
async function ensureVisitor() {
  const { auth } = getCloudbaseClient();
  if (!signingIn) signingIn = (async () => {
    const current = authError(await auth.getSession());
    if (current?.user) return current.user;
    const anonymous = authError(await auth.signInAnonymously());
    if (!anonymous?.user) throw new RsvpServiceError('AUTH_FAILED', '身份连接未完成，请重试。');
    return anonymous.user;
  })().catch(error => { signingIn = null; throw error; });
  return signingIn;
}
export async function callRsvpFunction(data) {
  const { app, config } = getCloudbaseClient();
  let response;
  try { response = await app.callFunction({ name: config.functionName, data }); }
  catch { throw new RsvpServiceError('NETWORK_ERROR', '暂时无法连接报名服务。请保留填写内容，检查网络后重试。'); }
  if (response.code) throw new RsvpServiceError('SERVICE_ERROR', '报名服务暂时不可用，请稍后重试。');
  let result = response.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
  if (!result?.ok) throw new RsvpServiceError(result?.error?.code || 'SERVICE_ERROR', result?.error?.message || '报名服务暂时不可用，请稍后重试。');
  return result.data;
}
function stableOperation(payload) {
  const key = 'wedding-rsvp-operation:' + payload.submissionId;
  const fingerprint = JSON.stringify([payload.name.trim().normalize('NFC'), payload.people]);
  let previous = operations.get(key);
  if (!previous) { try { previous = JSON.parse(localStorage.getItem(key) || 'null'); } catch {} }
  if (!previous || previous.fingerprint !== fingerprint) previous = { fingerprint, operationId: randomUuid() };
  operations.set(key, previous);
  try { localStorage.setItem(key, JSON.stringify(previous)); } catch {}
  return previous.operationId;
}
function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new RsvpServiceError('UNSUPPORTED_BROWSER', '当前浏览器版本过旧，请用微信或系统浏览器的新版打开。');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function submitRsvp({ name, people, submissionId }) {
  ensureConfigured();
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 40) throw new RsvpServiceError('INVALID_NAME', '请填写姓名（最多 40 个字符）。');
  if (!Number.isInteger(people) || people < 1 || people > 20) throw new RsvpServiceError('INVALID_PEOPLE', '用餐人数需为 1–20 位，包含本人。');
  await ensureVisitor();
  const data = { action: 'submit', name: name.trim(), people, submissionId };
  data.operationId = stableOperation(data);
  const result = await callRsvpFunction(data);
  if (!result?.id || !result?.submittedAt || !Number.isInteger(result.people)) throw new RsvpServiceError('INVALID_RESPONSE', '尚未收到有效确认，请使用相同信息重试。');
  return result;
}
