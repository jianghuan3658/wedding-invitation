const $ = (selector) => document.querySelector(selector);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = { wedding: null, albums: [], lightboxAlbum: null, photoIndex: 0, returnFocus: null, service: null, configured: false, submitting: false };
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
    shot.setAttribute('aria-label', `翻阅${album.title}系列照片`);
    const frame = text('div', 'feature-image', '');
    frame.append(image(album.cover, photoAlt(album, coverIndex(album))));
    const caption = text('div', 'feature-caption', '');
    caption.append(text('span', '', album.title), text('span', '', '翻阅这一刻'));
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
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-controls', 'lightbox');
    card.setAttribute('aria-label', `翻阅${album.title}，共${album.photos.length}张照片`);
    const cover = text('div', 'album-cover', '');
    const coverPhoto = album.photos[coverIndex(album)];
    cover.append(image(album.cover, photoAlt(album, coverIndex(album)), { width: coverPhoto.width, height: coverPhoto.height }));
    const label = text('div', 'album-label', '');
    label.append(text('span', 'album-index', String(index + 1).padStart(2, '0')), text('strong', '', album.title), text('small', '', `${album.photos.length} 张`));
    card.append(cover, label);
    card.addEventListener('click', () => openLightbox(album, coverIndex(album), card));
    cards.append(card);
  });
  albumRail.replaceChildren(cards);
  $('#gallery-status').hidden = true;
  updateGalleryPosition();
}

const albumRail = $('#album-grid');
let albumScrollFrame = 0;
function updateGalleryPosition() {
  const cards = [...albumRail.children];
  if (!cards.length) {
    $('#gallery-back').disabled = true;
    $('#gallery-next').disabled = true;
    return;
  }
  const left = albumRail.getBoundingClientRect().left;
  const end = albumRail.scrollWidth - albumRail.clientWidth;
  let nearest = 0;
  let distance = Infinity;
  cards.forEach((card, index) => {
    const candidate = Math.abs(card.getBoundingClientRect().left - left);
    if (candidate < distance) { nearest = index; distance = candidate; }
  });
  const atStart = albumRail.scrollLeft <= 2;
  const atEnd = albumRail.scrollLeft >= end - 2;
  if (!atStart && atEnd) nearest = cards.length - 1;
  $('#gallery-position').textContent = `${String(nearest + 1).padStart(2, '0')} / ${String(cards.length).padStart(2, '0')}`;
  $('#gallery-back').disabled = atStart;
  $('#gallery-next').disabled = atEnd;
}
function moveGallery(direction) {
  const first = albumRail.firstElementChild;
  if (!first) return;
  const gap = Number.parseFloat(getComputedStyle(albumRail).columnGap) || 0;
  const amount = first.getBoundingClientRect().width + gap;
  albumRail.scrollBy({ left: direction * amount, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}
$('#gallery-back').addEventListener('click', () => moveGallery(-1));
$('#gallery-next').addEventListener('click', () => moveGallery(1));
albumRail.addEventListener('scroll', () => {
  cancelAnimationFrame(albumScrollFrame);
  albumScrollFrame = requestAnimationFrame(updateGalleryPosition);
}, { passive: true });

const lightbox = $('#lightbox');
const lightboxRail = $('#lightbox-rail');
const lightboxThumbs = $('#lightbox-thumbs');
let viewerGeneration = 0;
let viewerScrollFrame = 0;
let viewerIdleTimer = null;
let photoStatusTimer = null;
let requestedPhotoIndex = null;
let zoomed = false;
function updateModalBody() { document.body.classList.toggle('modal-open', Boolean(document.querySelector('dialog[open]'))); }
function activeSlide() { return lightboxRail.children[state.photoIndex]; }
function activeImage() { return activeSlide()?.querySelector('img'); }
function photoSourceSet(photo) { return `${photo.src.replace(/-1600\.[^.]+$/, '-960.webp')} 960w, ${photo.src} 1600w`; }
function renderPhotoStatus() {
  clearTimeout(photoStatusTimer);
  const img = activeImage();
  const status = $('#lightbox-status');
  if (!lightbox.open || !img) { status.textContent = ''; return; }
  if (img.dataset.loadState === 'error') {
    status.textContent = '这张照片暂时未能载入，可以稍后重新打开此系列。';
    return;
  }
  if (img.complete && img.naturalWidth > 0) { status.textContent = ''; return; }
  status.textContent = '';
  const generation = viewerGeneration;
  photoStatusTimer = setTimeout(() => {
    if (generation === viewerGeneration && lightbox.open && activeImage() === img && !(img.complete && img.naturalWidth > 0) && img.dataset.loadState !== 'error') status.textContent = '正在载入照片…';
  }, 300);
}
function syncPhotoSelection(index, { revealThumb = true } = {}) {
  const album = state.lightboxAlbum;
  if (!album || !album.photos[index]) return;
  if (state.photoIndex !== index) setZoom(false);
  state.photoIndex = index;
  $('#lightbox-position').textContent = `${String(index + 1).padStart(2, '0')} / ${String(album.photos.length).padStart(2, '0')}`;
  [...lightboxRail.children].forEach((slide, slideIndex) => {
    slide.classList.toggle('is-active', slideIndex === index);
    const img = slide.querySelector('img');
    img.tabIndex = slideIndex === index ? 0 : -1;
  });
  [...lightboxThumbs.children].forEach((thumb, thumbIndex) => {
    thumb.setAttribute('aria-current', String(thumbIndex === index));
  });
  $('#lightbox-prev').disabled = zoomed || index === 0;
  $('#lightbox-next').disabled = zoomed || index === album.photos.length - 1;
  if (revealThumb) {
    const thumb = lightboxThumbs.children[index];
    const stripRect = lightboxThumbs.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    if (thumbRect.left < stripRect.left || thumbRect.right > stripRect.right) {
      lightboxThumbs.scrollTo({ left: thumbRect.left - stripRect.left + lightboxThumbs.scrollLeft - (lightboxThumbs.clientWidth - thumbRect.width) / 2, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }
  renderPhotoStatus();
}
function nearestPhotoIndex() {
  const center = lightboxRail.getBoundingClientRect().left + lightboxRail.clientWidth / 2;
  let nearest = 0;
  let distance = Infinity;
  [...lightboxRail.children].forEach((slide, index) => {
    const rect = slide.getBoundingClientRect();
    const candidate = Math.abs(rect.left + rect.width / 2 - center);
    if (candidate < distance) { nearest = index; distance = candidate; }
  });
  return nearest;
}
function scrollToPhoto(index, animate = true) {
  const slide = lightboxRail.children[index];
  if (!slide || !lightbox.open) return;
  requestedPhotoIndex = index;
  syncPhotoSelection(index);
  const targetLeft = slide.getBoundingClientRect().left - lightboxRail.getBoundingClientRect().left + lightboxRail.scrollLeft;
  lightboxRail.scrollTo({ left: targetLeft, behavior: animate && !reducedMotion.matches ? 'smooth' : 'auto' });
  clearTimeout(viewerIdleTimer);
  viewerIdleTimer = setTimeout(() => {
    if (!lightbox.open || zoomed) return;
    requestedPhotoIndex = null;
    syncPhotoSelection(nearestPhotoIndex());
  }, animate && !reducedMotion.matches ? 500 : 60);
}
function openLightbox(album, index, trigger) {
  clearTimeout(viewerIdleTimer);
  clearTimeout(photoStatusTimer);
  cancelAnimationFrame(viewerScrollFrame);
  const generation = ++viewerGeneration;
  state.lightboxAlbum = album;
  state.photoIndex = Math.max(0, Math.min(index, album.photos.length - 1));
  state.returnFocus = trigger;
  zoomed = false;
  requestedPhotoIndex = state.photoIndex;
  lightbox.classList.remove('is-zoomed');
  $('#lightbox-title').textContent = album.title;
  $('#lightbox-counter').textContent = `${album.photos.length} 帧关于我们的记忆`;
  $('#lightbox-zoom').textContent = '查看细节';
  $('#lightbox-zoom').setAttribute('aria-pressed', 'false');
  $('#lightbox-status').textContent = '';
  const slides = document.createDocumentFragment();
  const thumbs = document.createDocumentFragment();
  album.photos.forEach((photo, photoIndex) => {
    const slide = text('div', 'photo-slide', '');
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-label', `${photoIndex + 1} / ${album.photos.length}`);
    slide.style.setProperty('--detail-width', `${Math.min(photo.width, 1600)}px`);
    const figure = document.createElement('figure');
    const img = image(photo.src, photoAlt(album, photoIndex), { lazy: photoIndex !== state.photoIndex, width: photo.width, height: photo.height });
    img.className = 'lightbox-image';
    img.srcset = photoSourceSet(photo);
    img.sizes = '(max-width: 760px) 94vw, 86vw';
    img.dataset.loadState = 'loading';
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `${photoAlt(album, photoIndex)}，查看细节`);
    img.setAttribute('aria-expanded', 'false');
    img.addEventListener('load', () => {
      img.dataset.loadState = 'loaded';
      if (generation === viewerGeneration && lightbox.open && activeImage() === img) renderPhotoStatus();
    });
    img.addEventListener('error', () => {
      img.dataset.loadState = 'error';
      if (generation === viewerGeneration && lightbox.open && activeImage() === img) renderPhotoStatus();
    });
    img.addEventListener('click', () => {
      if (state.photoIndex !== photoIndex) syncPhotoSelection(photoIndex);
      setZoom(!zoomed);
    });
    img.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setZoom(!zoomed); }
    });
    figure.append(img, text('figcaption', '', `${album.title} · ${String(photoIndex + 1).padStart(2, '0')}`));
    slide.append(figure);
    slides.append(slide);
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'lightbox-thumb';
    thumb.setAttribute('aria-label', `查看${album.title}第${photoIndex + 1}张照片`);
    thumb.setAttribute('aria-current', String(photoIndex === state.photoIndex));
    thumb.append(image(photo.thumb, '', { width: photo.width, height: photo.height }));
    thumb.addEventListener('click', () => { setZoom(false); scrollToPhoto(photoIndex); });
    thumbs.append(thumb);
  });
  lightboxRail.replaceChildren(slides);
  lightboxThumbs.replaceChildren(thumbs);
  if (!lightbox.open) lightbox.showModal();
  updateModalBody();
  $('#lightbox-close').focus({ preventScroll: true });
  syncPhotoSelection(state.photoIndex, { revealThumb: false });
  requestAnimationFrame(() => {
    if (generation !== viewerGeneration || !lightbox.open) return;
    scrollToPhoto(state.photoIndex, false);
  });
}
function setZoom(value) {
  const slide = activeSlide();
  if (!slide) return;
  zoomed = value;
  lightbox.classList.toggle('is-zoomed', value);
  [...lightboxRail.children].forEach((item) => {
    const active = item === slide && value;
    item.classList.toggle('is-zoomed', active);
    const img = item.querySelector('img');
    img.setAttribute('aria-expanded', String(active));
    img.setAttribute('aria-label', `${img.alt}，${active ? '恢复完整画面' : '查看细节'}`);
    if (!active) item.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  });
  $('#lightbox-zoom').setAttribute('aria-pressed', String(value));
  $('#lightbox-zoom').textContent = value ? '完整画面' : '查看细节';
  $('#lightbox-prev').disabled = value || state.photoIndex === 0;
  $('#lightbox-next').disabled = value || state.photoIndex === state.lightboxAlbum.photos.length - 1;
  if (value) {
    const img = slide.querySelector('img');
    img.srcset = '';
    img.src = state.lightboxAlbum.photos[state.photoIndex].src;
    requestedPhotoIndex = null;
    clearTimeout(viewerIdleTimer);
    const generation = viewerGeneration;
    requestAnimationFrame(() => {
      if (generation !== viewerGeneration || !zoomed || activeSlide() !== slide) return;
      slide.scrollTo({ left: Math.max(0, (slide.scrollWidth - slide.clientWidth) / 2), top: Math.max(0, (slide.scrollHeight - slide.clientHeight) / 2), behavior: 'auto' });
    });
  } else {
    const img = slide.querySelector('img');
    img.srcset = photoSourceSet(state.lightboxAlbum.photos[state.photoIndex]);
  }
  renderPhotoStatus();
}
function movePhoto(step) {
  if (!state.lightboxAlbum || zoomed) return;
  const next = state.photoIndex + step;
  if (next < 0 || next >= state.lightboxAlbum.photos.length) return;
  scrollToPhoto(next);
}
$('#lightbox-prev').addEventListener('click', () => movePhoto(-1));
$('#lightbox-next').addEventListener('click', () => movePhoto(1));
$('#lightbox-zoom').addEventListener('click', () => setZoom(!zoomed));
$('#lightbox-close').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('close', () => {
  ++viewerGeneration;
  clearTimeout(viewerIdleTimer);
  clearTimeout(photoStatusTimer);
  cancelAnimationFrame(viewerScrollFrame);
  zoomed = false;
  requestedPhotoIndex = null;
  lightbox.classList.remove('is-zoomed');
  lightboxRail.replaceChildren();
  lightboxThumbs.replaceChildren();
  $('#lightbox-status').textContent = '';
  state.lightboxAlbum = null;
  updateModalBody();
  state.returnFocus?.focus({ preventScroll: true });
});
lightbox.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' && !zoomed) { event.preventDefault(); movePhoto(-1); }
  if (event.key === 'ArrowRight' && !zoomed) { event.preventDefault(); movePhoto(1); }
});
lightboxRail.addEventListener('scroll', () => {
  if (!lightbox.open || zoomed) return;
  const generation = viewerGeneration;
  cancelAnimationFrame(viewerScrollFrame);
  viewerScrollFrame = requestAnimationFrame(() => {
    if (generation !== viewerGeneration || !lightbox.open || zoomed) return;
    if (requestedPhotoIndex === null) syncPhotoSelection(nearestPhotoIndex());
  });
  clearTimeout(viewerIdleTimer);
  viewerIdleTimer = setTimeout(() => {
    if (generation !== viewerGeneration || !lightbox.open || zoomed) return;
    requestedPhotoIndex = null;
    syncPhotoSelection(nearestPhotoIndex());
  }, 140);
}, { passive: true });
function beginNativeBrowse() { if (!zoomed) requestedPhotoIndex = null; }
lightboxRail.addEventListener('pointerdown', beginNativeBrowse, { passive: true });
lightboxRail.addEventListener('touchstart', beginNativeBrowse, { passive: true });
lightboxRail.addEventListener('wheel', beginNativeBrowse, { passive: true });
if (typeof ResizeObserver === 'function') {
  let previousRailWidth = -1;
  const galleryResize = new ResizeObserver(() => {
    updateGalleryPosition();
    const width = lightboxRail.clientWidth;
    if (width === previousRailWidth) return;
    previousRailWidth = width;
    if (lightbox.open && !zoomed) scrollToPhoto(state.photoIndex, false);
  });
  galleryResize.observe(albumRail);
  galleryResize.observe(lightboxRail);
}

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
