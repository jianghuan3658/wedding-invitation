'use strict';
const { createHash } = require('node:crypto');
const COLLECTIONS = Object.freeze({ entries: 'wedding_rsvps', receipts: 'wedding_rsvp_receipts', limits: 'wedding_rsvp_limits' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class RsvpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function validateSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RsvpError('INVALID_INPUT', '请填写姓名和用餐人数。');
  const name = typeof input.name === 'string' ? input.name.trim().normalize('NFC') : '';
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) throw new RsvpError('INVALID_NAME', '姓名需为 1–40 个字符。');
  if (!Number.isInteger(input.people) || input.people < 1 || input.people > 20) throw new RsvpError('INVALID_PEOPLE', '用餐人数需为 1–20 位，包含本人。');
  if (!UUID.test(input.submissionId || '') || !UUID.test(input.operationId || '')) throw new RsvpError('INVALID_ID', '报名标识无效，请刷新页面后再试。');
  return { name, people: input.people, submissionId: input.submissionId.toLowerCase(), operationId: input.operationId.toLowerCase() };
}
function requireIdentity(identity) {
  if (!identity || typeof identity.uid !== 'string' || !identity.uid || identity.uid.length > 256) throw new RsvpError('UNAUTHENTICATED', '身份连接未完成，请重试。');
  return identity.uid;
}
function requireAdmin(identity, adminUid) {
  const uid = requireIdentity(identity);
  if (!adminUid || uid !== adminUid || identity.anonymous || !identity.loginType || identity.loginType === 'ANONYMOUS') throw new RsvpError('FORBIDDEN', '此账号没有查看报名数据的权限。');
}
function publicEntry(row) {
  return { id: row._id, name: row.name, people: row.people, submittedAt: row.updatedAt, createdAt: row.createdAt };
}
function createService(store, { adminUid = '', clock = Date.now } = {}) {
  async function submit(input, identity) {
    const uid = requireIdentity(identity);
    const value = validateSubmission(input);
    const entryId = digest('entry:' + uid);
    const receiptId = digest('operation:' + uid + ':' + value.operationId);
    const fingerprint = digest(JSON.stringify([value.submissionId, value.name, value.people]));
    return store.transaction(async tx => {
      const previousReceipt = await tx.get(COLLECTIONS.receipts, receiptId);
      const previousEntry = await tx.get(COLLECTIONS.entries, entryId);
      if (previousReceipt) {
        if (previousReceipt.fingerprint !== fingerprint) throw new RsvpError('ID_CONFLICT', '同一提交标识不能重复用于不同内容，请刷新后重试。');
        if (!previousEntry) throw new RsvpError('INCONSISTENT_DATA', '报名记录需人工核对，请联系新人。');
        // Return the current row, without replaying an old write over a later edit.
        return publicEntry(previousEntry);
      }
      const now = clock();
      const bucket = Math.floor(now / 60000);
      const limits = [{ id: digest('uid:' + uid), max: 10 }];
      if (identity.ip) limits.push({ id: digest('ip:' + identity.ip), max: 100 });
      for (const limit of limits) {
        const previous = await tx.get(COLLECTIONS.limits, limit.id);
        const count = previous && previous.bucket === bucket ? previous.count : 0;
        if (count >= limit.max) throw new RsvpError('RATE_LIMITED', '提交过于频繁，请稍等一分钟后再试。');
        await tx.set(COLLECTIONS.limits, limit.id, { bucket, count: count + 1 });
      }
      const time = new Date(now).toISOString();
      const row = { _id: entryId, ownerUid: uid, name: value.name, people: value.people, status: 'active', createdAt: previousEntry?.createdAt || time, updatedAt: time };
      await tx.set(COLLECTIONS.entries, entryId, row);
      await tx.set(COLLECTIONS.receipts, receiptId, { entryId, fingerprint, acceptedAt: time });
      return publicEntry(row);
    });
  }
  async function list(input, identity) {
    requireAdmin(identity, adminUid);
    const cursor = input.cursor || '';
    if (cursor && !/^[0-9a-f]{64}$/.test(cursor)) throw new RsvpError('INVALID_CURSOR', '分页参数无效。');
    const rows = await store.list(COLLECTIONS.entries, cursor, 100);
    const page = rows.slice(0, 100);
    return { rows: page.map(publicEntry), nextCursor: rows.length === 100 ? page.at(-1)._id : null, fetchedAt: new Date(clock()).toISOString() };
  }
  async function authorize(identity) { requireAdmin(identity, adminUid); return { authorized: true }; }
  return { submit, list, authorize };
}
module.exports = { COLLECTIONS, RsvpError, validateSubmission, requireAdmin, createService };
