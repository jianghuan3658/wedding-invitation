'use strict';
const { createService, RsvpError } = require('./logic');
function makeStore(db) {
  return {
    transaction(callback) {
      return db.runTransaction(async transaction => callback({
        async get(collection, id) {
          const response = await transaction.collection(collection).doc(id).get();
          if (response.code) throw new Error('DATABASE_READ_FAILED');
          return Array.isArray(response.data) ? response.data[0] || null : response.data || null;
        },
        async set(collection, id, data) {
          const { _id, ...document } = data;
          const response = await transaction.collection(collection).doc(id).set(document);
          if (response.code) throw new Error('DATABASE_WRITE_FAILED');
        }
      }), 5);
    },
    async list(collection, cursor, size) {
      let query = db.collection(collection);
      if (cursor) query = query.where({ _id: db.command.gt(cursor) });
      const response = await query.orderBy('_id', 'asc').limit(size).get();
      if (response.code) throw new Error('DATABASE_READ_FAILED');
      return response.data || [];
    }
  };
}
function createHandler({ cloudbase, adminUid = '', clock }) {
  return async (event, context) => {
    try {
      if (!event || typeof event !== 'object' || JSON.stringify(event).length > 4096) throw new RsvpError('INVALID_INPUT', '请求内容无效。');
      // Ordinary CloudBase event function: credentials and caller identity come
      // from the trusted runtime, never from event.uid / request JSON / headers.
      const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
      const auth = await app.auth().getAuthContext(context);
      const runtime = cloudbase.getCloudbaseContext(context);
      const identity = { uid: auth.uid, loginType: auth.loginType, anonymous: auth.loginType === 'ANONYMOUS' || runtime.TCB_ISANONYMOUS_USER === 'true', ip: runtime.TCB_SOURCE_IP || '' };
      const service = createService(makeStore(app.database()), { adminUid, clock });
      let data;
      if (event.action === 'submit') data = await service.submit(event, identity);
      else if (event.action === 'list') data = await service.list(event, identity);
      else if (event.action === 'authorize') data = await service.authorize(identity);
      else throw new RsvpError('INVALID_ACTION', '请求方式无效。');
      return { ok: true, data };
    } catch (error) {
      if (error instanceof RsvpError) return { ok: false, error: { code: error.code, message: error.message } };
      // Never return runtime variables, credentials, raw request or personal data.
      return { ok: false, error: { code: 'SERVICE_ERROR', message: '服务暂时不可用，请保留信息并稍后重试。' } };
    }
  };
}
exports.createHandler = createHandler;
exports.main = async (event, context) => createHandler({ cloudbase: require('@cloudbase/node-sdk'), adminUid: process.env.ADMIN_UID || '' })(event, context);
