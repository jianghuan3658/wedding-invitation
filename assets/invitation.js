const $ = (selector) => document.querySelector(selector);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = { wedding: null, albums: [], activeAlbum: null, albumTrigger: null, lightboxAlbum: null, photoIndex: 0, returnFocus: null, service: null, configured: false, submitting: false };
const STORAGE_KEY = 'wedding-invitation:rsvp:v1';
let saved = readSaved();

function readSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* The form can still be retried in this page. */ }
}
function makeSubmissionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error('请帖内容暂时无法加载，请稍后刷新。');
  return response.json();
}
function image(src, alt, { lazy = true, width = 960, height = 1280 } = {}) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.width = width;
  img.height = height;
  img.decoding = 'async';
  img.loading = lazy ? 'lazy' : 'eager';
  return img;
}
function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}
function photoAlt(album, index) {
  return `${state.wedding.groom}与${state.wedding.bride}的婚纱照，${album.title}系列第${index + 1}张`;
}
function coverIndex(album) {
  const base = album.cover.replace(/-960\.[^.]+$/, '');
  const match = album.photos.findIndex((photo) => photo.src.replace(/-1600\.[^.]+$/, '') === base);
  return match >= 0 ? match : 0;
}
function applyWedding(wedding) {
  state.wedding = wedding;
  document.querySelectorAll('[data-groom]').forEach((node) => { node.textContent = wedding.groom; });
  document.querySelectorAll('[data-bride]').forEach((node) => { node.textContent = wedding.bride; });
  const [year, month, day] = wedding.date.split('-');
  document.querySelectorAll('[data-date-short]').forEach((node) => { node.textContent = `${year} . ${month} . ${day}`; });
  document.querySelectorAll('[data-date-long]').forEach((node) => { node.textContent = `${year} 年 ${Number(month)} 月 ${Number(day)} 日`; });
  document.querySelectorAll('[data-time]').forEach((node) => { node.textContent = wedding.time; });
  document.querySelectorAll('[data-address]').forEach((node) => { node.textContent = wedding.address; });
  $('.wordmark').replaceChildren(document.createTextNode(`${wedding.groom} `), text('span', '', '&'), document.createTextNode(` ${wedding.bride}`));
  document.title = `${wedding.groom} & ${wedding.bride} · 新婚晚宴邀请`;
  const map = new URL('https://uri.amap.com/search');
  map.searchParams.set('keyword', wedding.address);
  map.searchParams.set('city', '杭州市');
  map.searchParams.set('view', 'map');
  map.searchParams.set('callnative', '0');
  $('#map-link').href = map.href;
  configureMusic(wedding.music);
}
function renderAlbums(albums) {
  state.albums = albums;
  const heroAlbum = albums.find((album) => album.title === '初见誓约') || albums[0];
  if (heroAlbum) {
    $('#hero-photo').src = heroAlbum.cover;
    $('#hero-photo').alt = photoAlt(heroAlbum, coverIndex(heroAlbum));
  }
  const total = albums.reduce((sum, album) => sum + album.photos.length, 0);
  $('#album-summary').textContent = `${albums.length} 个系列，${total} 张照片。记录我们的不同模样。`;
  const featured = ['氧气誓约', '酒红喜韵'].map((title) => albums.find((album) => album.title === title)).filter(Boolean);
  if (!featured.length) featured.push(...albums.slice(0, 2));
  const featuredFrag = document.createDocumentFragment();
  featured.forEach((album) => {
    const shot = document.createElement('a');
    shot.className = 'feature-shot';
    shot.href = '#albums';
    shot.setAttribute('aria-label', `查看${album.title}系列照片`);
    const frame = text('div', 'feature-image', '');
    frame.append(image(album.cover, photoAlt(album, coverIndex(album))));
    const caption = text('div', 'feature-caption', '');
    caption.append(text('span', '', album.title), text('span', '', '翻阅这一刻 ↗'));
    shot.append(frame, caption);
    shot.addEventListener('click', (event) => { event.preventDefault(); openLightbox(album, coverIndex(album), shot); });
    featuredFrag.append(shot);
  });
  $('#featured-pair').replaceChildren(featuredFrag);
  const cards = document.createDocumentFragment();
  albums.forEach((album, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'album-card';
    card.dataset.albumId = album.id;
    card.setAttribute('aria-expanded', 'false');
    card.setAttribute('aria-controls', 'album-detail');
    card.setAttribute('aria-label', `展开${album.title}，共${album.photos.length}张照片`);
    const cover = text('div', 'album-cover', '');
    cover.append(image(album.cover, photoAlt(album, coverIndex(album))), text('span', 'album-index', String(index + 1).padStart(2, '0')));
    const label = text('div', 'album-label', '');
    label.append(text('strong', '', album.title), text('small', '', `${album.photos.length} 张 ↗`));
    card.append(cover, label);
    card.addEventListener('click', () => {
      if (state.activeAlbum?.id === album.id) closeAlbum();
      else selectAlbum(album, card);
    });
    cards.append(card);
  });
  $('#album-grid').replaceChildren(cards);
  $('#gallery-status').hidden = true;
}
function selectAlbum(album, trigger) {
  state.activeAlbum = album;
  state.albumTrigger = trigger;
  document.querySelectorAll('.album-card').forEach((card) => { card.setAttribute('aria-expanded', String(card.dataset.albumId === album.id)); });
  $('#active-album-title').textContent = album.title;
  $('#active-album-count').textContent = `共 ${album.photos.length} 张 · 点开查看完整画面`;
  const frag = document.createDocumentFragment();
  album.photos.forEach((photo, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo-button';
    button.setAttribute('aria-label', `放大查看${album.title}第${index + 1}张照片`);
    button.append(image(photo.thumb, photoAlt(album, index), { width: photo.width, height: photo.height }), text('span', 'photo-number', String(index + 1).padStart(2, '0')));
    button.addEventListener('click', () => openLightbox(album, index, button));
    frag.append(button);
  });
  $('#photo-grid').replaceChildren(frag);
  $('#album-detail').hidden = false;
  $('#active-album-title').focus({ preventScroll: true });
  $('#album-detail').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
}
function closeAlbum() {
  $('#album-detail').hidden = true;
  $('#photo-grid').replaceChildren();
  document.querySelectorAll('.album-card').forEach((card) => { card.setAttribute('aria-expanded', 'false'); });
  state.activeAlbum = null;
  state.albumTrigger?.focus({ preventScroll: true });
  state.albumTrigger?.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' });
}
$('#close-album').addEventListener('click', closeAlbum);

const lightbox = $('#lightbox');
const lightboxImage = $('#lightbox-image');
function updateModalBody() { document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]'))); }
function openLightbox(album, index, trigger) {
  state.lightboxAlbum = album;
  state.photoIndex = index;
  state.returnFocus = trigger;
  renderLightbox();
  if (!lightbox.open) lightbox.showModal();
  updateModalBody();
  $('#lightbox-close').focus({ preventScroll: true });
}
function setZoom(zoom) {
  lightboxImage.classList.toggle('zoomed', zoom);
  lightboxImage.parentElement.classList.toggle('zoomed', zoom);
  lightboxImage.setAttribute('aria-expanded', String(zoom));
  lightboxImage.setAttribute('aria-label', zoom ? '缩小照片' : '放大照片');
}
function renderLightbox() {
  const album = state.lightboxAlbum;
  const photo = album.photos[state.photoIndex];
  setZoom(false);
  $('#lightbox-title').textContent = album.title;
  $('#lightbox-counter').textContent = `${state.photoIndex + 1} / ${album.photos.length}`;
  $('#lightbox-caption').textContent = `${album.title} · ${String(state.photoIndex + 1).padStart(2, '0')}`;
  $('#lightbox-status').textContent = '正在载入照片…';
  lightboxImage.alt = photoAlt(album, state.photoIndex);
  lightboxImage.width = photo.width;
  lightboxImage.height = photo.height;
  lightboxImage.src = photo.src;
  $('#lightbox-prev').disabled = state.photoIndex === 0;
  $('#lightbox-next').disabled = state.photoIndex === album.photos.length - 1;
}
function movePhoto(step) {
  if (!state.lightboxAlbum) return;
  const next = state.photoIndex + step;
  if (next < 0 || next >= state.lightboxAlbum.photos.length) return;
  state.photoIndex = next;
  renderLightbox();
}
lightboxImage.addEventListener('load', () => { $('#lightbox-status').textContent = ''; });
lightboxImage.addEventListener('error', () => { $('#lightbox-status').textContent = '这张照片暂时未能载入，请切换照片后重试。'; });
lightboxImage.tabIndex = 0;
lightboxImage.setAttribute('role', 'button');
lightboxImage.addEventListener('click', () => setZoom(!lightboxImage.classList.contains('zoomed')));
lightboxImage.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setZoom(!lightboxImage.classList.contains('zoomed')); }
});
$('#lightbox-prev').addEventListener('click', () => movePhoto(-1));
$('#lightbox-next').addEventListener('click', () => movePhoto(1));
$('#lightbox-close').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('close', () => { setZoom(false); updateModalBody(); state.returnFocus?.focus({ preventScroll: true }); });
lightbox.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') { event.preventDefault(); movePhoto(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); movePhoto(1); }
});
let touchStart = null;
$('#lightbox-stage').addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1 || lightboxImage.classList.contains('zoomed') || event.target.closest('button')) { touchStart = null; return; }
  touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
$('#lightbox-stage').addEventListener('touchend', (event) => {
  if (!touchStart || event.changedTouches.length !== 1) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) movePhoto(dx < 0 ? 1 : -1);
}, { passive: true });

const audio = $('#wedding-music');
const musicGate = $('#music-gate');
function musicState() {
  const playing = !audio.paused && !audio.ended;
  $('#music-toggle').setAttribute('aria-pressed', String(playing));
  $('#music-label').textContent = playing ? '暂停音乐' : '播放音乐';
}
function musicError(message) {
  $('#music-status').textContent = message;
  $('#music-status').hidden = false;
  musicState();
}
async function playMusic() {
  try {
    await audio.play();
    $('#music-status').hidden = true;
  } catch { musicError('音乐暂时无法播放，你仍可以继续阅读请帖。'); }
  musicState();
}
function closeMusicGate() {
  musicGate.close();
  $('#couple-title').tabIndex = -1;
  $('#couple-title').focus({ preventScroll: true });
}
function configureMusic(music) {
  if (!music?.src) return;
  audio.src = music.src;
  audio.preload = 'metadata';
  $('#music-toggle').hidden = false;
  if (music.title) $('#music-toggle').title = music.title;
  audio.play().then(() => { musicState(); }).catch(() => {
    musicState();
    if (!musicGate.open) musicGate.showModal();
    updateModalBody();
  });
}
['play', 'pause', 'ended'].forEach((event) => audio.addEventListener(event, musicState));
audio.addEventListener('error', () => musicError('音乐暂时无法载入，你仍可以继续阅读请帖。'));
$('#music-toggle').addEventListener('click', () => { if (audio.paused) playMusic(); else audio.pause(); });
$('#open-invitation').addEventListener('click', () => { playMusic(); closeMusicGate(); });
$('#skip-music').addEventListener('click', () => { audio.pause(); closeMusicGate(); });
musicGate.addEventListener('close', updateModalBody);

function renderReceipt(receipt, fromStorage = false) {
  if (!receipt || typeof receipt.name !== 'string' || !Number.isInteger(receipt.people)) return;
  $('#receipt').hidden = false;
  $('#receipt-summary').textContent = `${receipt.name} · ${receipt.people} 位用餐宾客（含本人）`;
  const date = new Date(receipt.submittedAt);
  $('#receipt-time').textContent = Number.isNaN(date.getTime()) ? (fromStorage ? '此设备上次提交的回执' : '已由服务器确认收到') : `${fromStorage ? '此设备上次提交' : '收到于'} ${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
  $('#submit-label').textContent = '更新赴宴回执';
}
if (saved.draft && typeof saved.draft.name === 'string') $('#guest-name').value = saved.draft.name;
if (saved.draft && Number.isInteger(saved.draft.people) && saved.draft.people >= 1 && saved.draft.people <= 20) $('#guest-people').value = saved.draft.people;
if (saved.receipt) renderReceipt(saved.receipt, true);
function persistDraft() {
  saved.draft = { name: $('#guest-name').value, people: Number($('#guest-people').value) };
  saveLocal();
}
$('#guest-name').addEventListener('input', persistDraft);
$('#guest-people').addEventListener('input', persistDraft);
async function connectRsvp() {
  try {
    state.service = await import('./rsvp-api.js');
    state.configured = state.service.getServiceStatus().configured === true;
  } catch { state.configured = false; }
  $('#submit-rsvp').disabled = !state.configured;
  $('#service-notice').classList.toggle('unavailable', !state.configured);
  $('#service-notice').textContent = state.configured ? '填写完成后，请点击提交。' : '线上回执暂未开通，目前无法提交。开通后即可在这里填写赴宴信息。';
}
function validateForm() {
  const name = $('#guest-name').value.trim();
  const peopleValue = $('#guest-people').value.trim();
  const people = Number(peopleValue);
  const nameError = !name ? '请填写你的姓名。' : name.length > 40 ? '姓名请控制在 40 个字以内。' : /[\u0000-\u001f\u007f]/.test(name) ? '姓名中不能包含换行或特殊控制字符。' : '';
  const peopleError = !peopleValue || !Number.isInteger(people) || people < 1 || people > 20 ? '请填写 1 至 20 位用餐人数，包含本人。' : '';
  $('#name-error').textContent = nameError;
  $('#people-error').textContent = peopleError;
  $('#guest-name').setAttribute('aria-invalid', String(Boolean(nameError)));
  $('#guest-people').setAttribute('aria-invalid', String(Boolean(peopleError)));
  if (nameError || peopleError) { (nameError ? $('#guest-name') : $('#guest-people')).focus(); return null; }
  return { name, people };
}
$('#rsvp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.submitting) return;
  if (!state.configured) { $('#form-feedback').textContent = '回执服务尚未开通，当前信息没有提交。'; return; }
  const values = validateForm();
  if (!values) return;
  if (!saved.submissionId) saved.submissionId = makeSubmissionId();
  saved.draft = values;
  saveLocal();
  state.submitting = true;
  $('#submit-rsvp').disabled = true;
  $('#rsvp-form').setAttribute('aria-busy', 'true');
  $('#guest-name').readOnly = true;
  $('#guest-people').readOnly = true;
  $('#submit-label').textContent = '正在提交…';
  $('#form-feedback').textContent = '正在发送回执，请稍候。';
  try {
    const receipt = await state.service.submitRsvp({ ...values, submissionId: saved.submissionId });
    if (!receipt?.id || typeof receipt.name !== 'string' || !Number.isInteger(receipt.people) || !receipt.submittedAt) throw new Error('服务器返回不完整，请重试确认提交结果。');
    saved.receipt = receipt;
    saved.draft = { name: receipt.name, people: receipt.people };
    saveLocal();
    renderReceipt(receipt);
    $('#guest-name').value = receipt.name;
    $('#guest-people').value = receipt.people;
    $('#form-feedback').textContent = '回执已收到，期待与你相聚！如人数有变化，可以在这里更新。';
  } catch (error) {
    $('#form-feedback').textContent = typeof error?.message === 'string' && error.message ? `${error.message} 你的填写内容已保留，可以重试。` : '暂时未能确认提交结果。你的填写内容已保留，请检查网络后重试。';
    $('#submit-label').textContent = saved.receipt ? '更新赴宴回执' : '重新提交回执';
  } finally {
    state.submitting = false;
    $('#submit-rsvp').disabled = !state.configured;
    $('#rsvp-form').setAttribute('aria-busy', 'false');
    $('#guest-name').readOnly = false;
    $('#guest-people').readOnly = false;
  }
});

const rsvpObserver = new IntersectionObserver((entries) => {
  $('.sticky-rsvp').hidden = entries[0]?.isIntersecting || false;
}, { threshold: 0.2 });
rsvpObserver.observe($('#rsvp'));
connectRsvp();
Promise.all([loadJson('data/wedding.json'), loadJson('data/albums.json')]).then(([wedding, albums]) => {
  if (!wedding?.groom || !wedding?.bride || !/^\d{4}-\d{2}-\d{2}$/.test(wedding.date) || !Array.isArray(albums)) throw new Error('请帖内容暂时无法加载，请稍后刷新。');
  applyWedding(wedding);
  renderAlbums(albums.filter((album) => album && typeof album.title === 'string' && typeof album.cover === 'string' && Array.isArray(album.photos) && album.photos.length));
}).catch((error) => {
  $('#gallery-status').textContent = error.message || '画册暂时无法载入，请稍后刷新。';
  $('#gallery-status').hidden = false;
});
