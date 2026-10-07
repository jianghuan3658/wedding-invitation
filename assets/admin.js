import { getServiceStatus, signInAdmin, signOutAdmin, getAdminSession, authorizeAdmin, listRsvps, watchRsvpChanges } from './rsvp-api.js?v=4';

const $ = id => document.getElementById(id);
let rows = [];
let watcher;
let poll;
let active = false;
let busy = false;
let watchConnected = false;
let refreshAgain = false;
let lastSuccess;
let syncGeneration = 0;
let resumeAfterHistory = false;
function status(text, tone = '') { $('sync-status').textContent = text; $('sync-status').dataset.tone = tone; }
function formatTime(time) { return time ? new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }
function clearDashboard(resetSearch = true) {
  rows = []; lastSuccess = null;
  $('guest-rows').replaceChildren();
  for (const id of ['groups-total', 'people-total', 'duplicate-total', 'last-update']) $(id).textContent = '—';
  if (resetSearch) $('search').value = '';
  $('list-description').textContent = '等待读取报名';
  $('empty-state').hidden = false;
  $('empty-state').textContent = '正在读取已经保存的报名。';
  $('export').disabled = true;
}
function render() {
  if (!lastSuccess) {
    clearDashboard(false);
    $('empty-state').textContent = '尚未读取到报名，请稍后重试。';
    return;
  }
  $('groups-total').textContent = rows.length.toLocaleString('zh-CN');
  $('people-total').textContent = rows.reduce((sum, row) => sum + row.people, 0).toLocaleString('zh-CN');
  const names = new Map();
  for (const row of rows) names.set(row.name, (names.get(row.name) || 0) + 1);
  $('duplicate-total').textContent = [...names.values()].filter(count => count > 1).length;
  const search = $('search').value.trim();
  const visible = rows.filter(row => row.name.includes(search)).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const body = $('guest-rows');
  body.replaceChildren();
  for (const [index, row] of visible.entries()) {
    const tr = document.createElement('tr');
    for (const text of [String(index + 1), row.name, String(row.people), formatTime(row.submittedAt), names.get(row.name) > 1 ? '同名，需核对' : '已登记']) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    body.append(tr);
  }
  $('empty-state').hidden = visible.length > 0;
  $('empty-state').textContent = rows.length ? '没有匹配的姓名。' : '暂时没有报名。这里仅展示已经保存到云端的数据。';
  $('list-description').textContent = `全部 ${rows.length} 组 · 当前显示 ${visible.length} 组`;
  $('export').disabled = rows.length === 0;
  $('last-update').textContent = formatTime(lastSuccess);
}
async function refresh() {
  if (!active) return;
  if (busy) { refreshAgain = true; return; }
  busy = true;
  const generation = syncGeneration;
  try {
    let cursor = null;
    const complete = new Map();
    const seenCursors = new Set();
    do {
      const page = await listRsvps({ cursor });
      if (!Array.isArray(page.rows)) throw new Error('分页结果无效');
      for (const row of page.rows) {
        if (!row.id || !Number.isInteger(row.people)) throw new Error('报名结果无效');
        complete.set(row.id, row);
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error('分页结果重复');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (!active || generation !== syncGeneration) return;
    rows = [...complete.values()]; lastSuccess = new Date().toISOString();
    render();
    status(watchConnected ? '实时同步中 · 每 5 秒自动校对' : '自动刷新中 · 每 5 秒更新', 'connected');
  } catch (error) {
    if (!active || generation !== syncGeneration) return;
    if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHENTICATED') {
      stopSync(); clearDashboard();
      $('dashboard').hidden = true; $('login-panel').hidden = false;
    }
    status(lastSuccess ? '连接中断 · 当前为上次成功同步的数据，正在重试' : error.message || '连接失败，正在重试', 'error');
  } finally {
    busy = false;
    if (refreshAgain && active) { refreshAgain = false; void refresh(); }
  }
}
function stopSync() {
  syncGeneration += 1;
  active = false; clearInterval(poll); poll = null;
  try { watcher?.close(); } catch {} watcher = null; watchConnected = false;
}
async function startSync() {
  const requestedGeneration = syncGeneration;
  try { await authorizeAdmin(); }
  catch (error) { if (requestedGeneration !== syncGeneration) return; throw error; }
  if (requestedGeneration !== syncGeneration) return;
  stopSync();
  const generation = syncGeneration;
  active = true;
  $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
  status('正在读取全部报名…');
  await refresh();
  if (!active || generation !== syncGeneration) return;
  // The watch is an invalidation signal, never the complete source of totals.
  // Full pagination runs after changes and every five seconds to reconcile.
  try {
    watcher = watchRsvpChanges({
      onChange() { watchConnected = true; void refresh(); },
      onError() { watchConnected = false; if (active) status('实时连接中断 · 已切换每 5 秒自动刷新'); }
    });
  } catch { watchConnected = false; }
  poll = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
}
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('login-button'); button.disabled = true; $('login-error').textContent = '';
  try {
    const account = $('account').value.trim();
    await signInAdmin({ email: account, password: $('password').value });
    $('password').value = '';
    await startSync();
  } catch (error) { $('login-error').textContent = error.message || '登录失败，请稍后重试。'; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  stopSync(); clearDashboard();
  $('dashboard').hidden = true; $('login-panel').hidden = false;
  try {
    await signOutAdmin();
    $('logout').hidden = true; status('已退出登录');
  } catch {
    $('logout').hidden = false; status('同步已暂停，退出登录未完成。请检查网络后再次点击退出。', 'error');
  }
});
$('search').addEventListener('input', render);
$('refresh').addEventListener('click', () => void refresh());
$('export').addEventListener('click', () => {
  const data = [['姓名', '用餐人数（含本人）', '首次报名时间', '最后更新时间'], ...rows.map(row => [row.name, row.people, formatTime(row.createdAt), formatTime(row.submittedAt)])];
  const blob = new Blob(['\uFEFF' + data.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '婚礼用餐报名-' + new Date().toISOString().slice(0, 10) + '.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active) void refresh(); });
window.addEventListener('pagehide', () => { resumeAfterHistory = active; stopSync(); if (resumeAfterHistory) status('页面已暂停 · 返回后重新同步'); });
window.addEventListener('pageshow', event => {
  if (event.persisted && resumeAfterHistory) {
    resumeAfterHistory = false;
    void startSync().catch(error => status(error.message || '请重新登录后同步', 'error'));
  }
});
if (!getServiceStatus().configured) {
  $('login-panel').hidden = true; $('unconfigured').hidden = false; status('待开通 · 当前没有连接云端数据库');
} else {
  status('请登录后查看报名');
  try {
    const session = await getAdminSession();
    if (session?.user && !session.user.is_anonymous) await startSync();
  } catch (error) { status(error.message || '请重新登录'); }
}
