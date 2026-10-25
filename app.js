'use strict';

/* =========================================================
   숏츠 자동 편집기
   - 대본 → 문장 단위 장면
   - 장면별 TTS(Web Speech API) + 가운데 자막
   - 장면별 화면(이미지·영상·단색), 없으면 앞 장면 화면 이어쓰기
   - 작업 내용·파일 모두 IndexedDB에 자동 저장
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

const ASPECTS = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 };
const FALLBACK_BG = '#111318';
const LANG_TAG = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };
const TEST_LINE = {
  ko: '안녕하세요. 이 목소리로 대본을 읽어 드릴게요.',
  en: 'Hi there. I will read your script in this voice.',
  ja: 'こんにちは。この声で台本を読み上げます。',
  zh: '你好，我会用这个声音朗读你的脚本。',
  all: '안녕하세요. 이 목소리로 대본을 읽어 드릴게요.',
};

const SAMPLE_SCRIPT = [
  '아침에 일어나자마자 휴대폰부터 보시나요?',
  '그 습관이 하루의 집중력을 떨어뜨릴 수 있어요.',
  '일어난 뒤 딱 10분만 휴대폰을 멀리 두세요.',
  '대신 물 한 잔을 마시고 창문을 열어 보세요.',
  '작은 변화가 하루 전체를 바꿉니다.',
  '도움이 됐다면 구독하고 내일 또 만나요!',
].join('\n');

/* 무료 한글 글꼴 (index.html에서 Google Fonts · Pretendard로 불러옴) */
const SANS = "'Malgun Gothic', sans-serif";
const SERIF = "'Batang', serif";
const FONT_GROUPS = [
  ['고딕', [
    ['본고딕', 'Noto Sans KR'], ['프리텐다드', 'Pretendard Variable'], ['나눔고딕', 'Nanum Gothic'],
    ['고딕 A1', 'Gothic A1'], ['IBM Plex Sans KR', 'IBM Plex Sans KR'], ['고운돋움', 'Gowun Dodum'], ['해바라기', 'Sunflower'],
  ]],
  ['제목 · 강조', [
    ['검은고딕', 'Black Han Sans'], ['도현', 'Do Hyeon'], ['주아', 'Jua'], ['구기', 'Gugi'],
    ['베이글', 'Bagel Fat One'], ['오르빗', 'Orbit'], ['동글', 'Dongle'],
  ]],
  ['명조', [
    ['본명조', 'Noto Serif KR', SERIF], ['나눔명조', 'Nanum Myeongjo', SERIF], ['고운바탕', 'Gowun Batang', SERIF],
    ['함렛', 'Hahmlet', SERIF], ['송명', 'Song Myung', SERIF],
  ]],
  ['손글씨', [
    ['나눔펜', 'Nanum Pen Script'], ['개구', 'Gaegu'], ['감자꽃', 'Gamja Flower'], ['연성', 'Yeon Sung'],
    ['하이멜로디', 'Hi Melody'], ['동해독도', 'East Sea Dokdo'], ['싱글데이', 'Single Day'],
  ]],
  ['Windows 기본', [['맑은 고딕', 'Malgun Gothic']]],
];
const fontCss = (family, fallback = SANS) =>
  family === 'Malgun Gothic' ? "'Malgun Gothic', sans-serif" : `'${family}', ${fallback}`;
const userFontCss = (f) => `'${f.family}', 'Noto Sans KR', ${SANS}`;
const FONT_SAMPLE = '가나다 숏츠 자막 123';
const DEFAULT_FONT = fontCss('Noto Sans KR');

const DEFAULT = {
  version: 1,
  title: '새 숏츠',
  aspect: '9:16',
  script: '',
  voice: { lang: 'ko', voiceURI: '', rate: 1, pitch: 1, volume: 1, noWords: [] },
  sub: {
    font: DEFAULT_FONT,
    size: 8, weight: '900', lineH: 1.3, letterSp: 0,
    color: '#ffffff', stroke: '#000000', strokeW: 0.6,
    glow: 0.6, glowColor: '#000000',
    posY: 50, maxW: 86, chunk: 0,
    box: false, boxColor: '#000000', boxOpacity: 0.55,
  },
  fonts: [], // 글꼴 보관함: { id, family, name, fileName, size }
  sfxLib: [], // 효과음 보관함: { id, name, fileName, size, dur }
  sfxVol: 1,  // 효과음 전체 음량
  layerStyles: [], // 저장한 글자 스타일: { id, name, style }
  ui: { zoom: 48, leftTab: 'settings' },
  scenes: [],
  selectedId: null,
};

let state = clone(DEFAULT);

/* ---------------- IndexedDB ---------------- */

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('shorts-editor', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['kv', 'media', 'fonts', 'sfx']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close(); // 새 버전이 열린 다른 탭의 업그레이드를 막지 않게
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => toast('예전 버전이 열린 다른 탭을 닫고 새로고침해 주세요.');
    });
  }
  return dbPromise;
}
async function idb(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k));
const mediaGet = (id) => idb('media', 'readonly', (s) => s.get(id));
const mediaPut = (id, blob) => idb('media', 'readwrite', (s) => s.put(blob, id));
const mediaDel = (id) => idb('media', 'readwrite', (s) => s.delete(id));
const mediaKeys = () => idb('media', 'readonly', (s) => s.getAllKeys());
const fontGet = (id) => idb('fonts', 'readonly', (s) => s.get(id));
const fontPut = (id, blob) => idb('fonts', 'readwrite', (s) => s.put(blob, id));
const fontDel = (id) => idb('fonts', 'readwrite', (s) => s.delete(id));
const sfxGet = (id) => idb('sfx', 'readonly', (s) => s.get(id));
const sfxPut = (id, blob) => idb('sfx', 'readwrite', (s) => s.put(blob, id));
const sfxDel = (id) => idb('sfx', 'readwrite', (s) => s.delete(id));

/* ---------------- 저장 ---------------- */

let saveTimer = null;
function save() {
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 350);
}
async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await kvSet('project', clone(state));
    setSaveStatus('saved');
  } catch (e) {
    console.error(e);
    setSaveStatus('error');
  }
}
function setSaveStatus(s) {
  const el = $('#saveStatus');
  el.dataset.state = s;
  el.textContent = s === 'saving' ? '저장 중…' : s === 'error' ? '저장 실패' : '자동 저장됨';
}

function mergeDeep(base, extra) {
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      mergeDeep(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

/* ---------------- 미디어 파일 ---------------- */

const urlCache = new Map();

async function mediaURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  let blob = null;
  try { blob = await mediaGet(id); } catch (e) { console.error(e); }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/* 장면 화면이나 화면 위에 얹은 이미지가 이 파일을 쓰고 있는지 */
function isMediaUsed(id) {
  const inLayers = (layers) => (layers || []).some((l) => l.mediaId === id);
  const uses = (s) => (s.media && s.media.mediaId === id) || (s.voice && s.voice.mediaId === id) || inLayers(s.layers);
  if (state.scenes.some(uses)) return true;
  if (undo && uses(undo.scene)) return true;
  if (lastDeletedLayer && lastDeletedLayer.L.mediaId === id) return true;
  return false;
}
function releaseMedia(m) {
  if (!m || !m.mediaId || isMediaUsed(m.mediaId)) return;
  mediaDel(m.mediaId).catch(console.error);
  const url = urlCache.get(m.mediaId);
  if (url) { URL.revokeObjectURL(url); urlCache.delete(m.mediaId); }
}
async function gcMedia() {
  try {
    const keys = await mediaKeys();
    for (const k of keys) if (!isMediaUsed(k)) await mediaDel(k);
  } catch (e) { console.error(e); }
}

function drawThumb(src, w, h) {
  const max = 240;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
function makeThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(v); };
    setTimeout(() => done(''), 8000);
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
      v.onseeked = () => { try { done(drawThumb(v, v.videoWidth, v.videoHeight)); } catch (e) { done(''); } };
      v.onerror = () => done('');
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => { try { done(drawThumb(img, img.naturalWidth, img.naturalHeight)); } catch (e) { done(''); } };
      img.onerror = () => done('');
      img.src = url;
    }
  });
}

async function setSceneFile(sceneId, file) {
  if (!file || !/^(image|video)\//.test(file.type)) {
    toast('이미지나 영상 파일만 넣을 수 있어요.');
    return;
  }
  const sc = findScene(sceneId);
  if (!sc) return;
  const id = 'm_' + uid();
  toast('파일 저장 중…', null, 0);
  try {
    await mediaPut(id, new Blob([file], { type: file.type }));
  } catch (e) {
    console.error(e);
    toast('파일을 저장하지 못했어요. 브라우저 저장 공간이 부족할 수 있어요.');
    return;
  }
  urlCache.set(id, URL.createObjectURL(file));
  const thumb = await makeThumb(file);
  const old = sc.media;
  sc.media = {
    type: file.type.startsWith('video/') ? 'video' : 'image',
    mediaId: id,
    name: file.name,
    thumb,
    // 화면을 바꿔도 맞춤·움직임·어둡게·소리 설정은 그대로 유지
    fit: (old && old.fit) || 'cover',
    motion: (old && old.motion) || 'none',
    motionAmt: (old && old.motionAmt) || 1,
    dim: (old && old.dim) || 0,
    volume: (old && old.volume) || 0,
  };
  releaseMedia(old);
  hideToast();
  mediaChanged();
  return true;
}

/* 끌어다 놓은 파일: 이미지·영상은 화면으로, 소리 파일은 효과음 보관함에 넣고 그 장면에 붙임 */
async function dropFiles(fileList, start) {
  const files = [...fileList];
  if (!files.length) return;
  const sounds = files.filter(isAudioFile);
  const visuals = files.filter((f) => /^(image|video)\//.test(f.type));
  if (!sounds.length && !visuals.length) { toast('이미지 · 영상 · 소리 파일만 넣을 수 있어요.'); return; }
  if (visuals.length) await placeFiles(visuals, start);
  if (sounds.length) await addSfxFiles(sounds, start >= 0 ? state.scenes[start] : null);
}

/* 여러 파일을 한꺼번에 넣으면 start번 장면부터 차례로 하나씩 */
async function placeFiles(fileList, start) {
  const files = [...fileList].filter((f) => /^(image|video)\//.test(f.type));
  if (!files.length) { toast('이미지나 영상 파일만 넣을 수 있어요.'); return; }
  if (!state.scenes.length || start < 0) { toast('먼저 장면을 만들어 주세요.'); return; }
  let placed = 0;
  for (let k = 0; k < files.length && start + k < state.scenes.length; k++) {
    if (await setSceneFile(state.scenes[start + k].id, files[k])) placed++;
  }
  const left = files.length - Math.min(files.length, state.scenes.length - start);
  if (files.length > 1) {
    toast(`${start + 1}번 장면부터 ${placed}개 장면에 화면을 넣었어요.` + (left > 0 ? ` 장면이 모자라 ${left}개는 넣지 못했어요.` : ''));
  }
}

function setSceneColor(sc, color) {
  const old = sc.media;
  sc.media = { type: 'color', color };
  if (old && old.type !== 'color') releaseMedia(old);
  mediaChanged();
}

function clearSceneMedia(sc) {
  const old = sc.media;
  sc.media = null;
  releaseMedia(old);
  mediaChanged();
}

function mediaChanged() {
  refreshCardMedia();
  renderTimeline();
  renderStage();
  save();
}

/* ---------------- 장면 데이터 ---------------- */

const findScene = (id) => state.scenes.find((s) => s.id === id);
const sceneIndex = (id) => state.scenes.findIndex((s) => s.id === id);
function selectedIndex() {
  const i = sceneIndex(state.selectedId);
  return i < 0 ? (state.scenes.length ? 0 : -1) : i;
}
const newScene = (text = '', media = null) => ({
  id: 's_' + uid(), text, media, measured: null,
  silent: false, silentDur: 3, hideSub: false, hold: 0,
  sfx: [], // { id, src: 'syn:이름' | 'lib:보관함id', vol, at(장면 시작 후 초), len(길이가 있는 기본 효과음) }
});

function effectiveMedia(i) {
  for (let j = i; j >= 0; j--) {
    const m = state.scenes[j] && state.scenes[j].media;
    if (m) return { media: m, from: j };
  }
  return { media: null, from: -1 };
}

function splitSentences(text) {
  const out = [];
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('ko', { granularity: 'sentence' })
    : null;
  for (const line of text.split(/\r?\n+/)) {
    const t = line.trim();
    if (!t) continue;
    if (seg) {
      for (const s of seg.segment(t)) {
        const x = s.segment.trim();
        if (x) out.push(x);
      }
    } else {
      const parts = t.match(/[^.!?。！？…]+(?:[.!?。！？…]+["'”’)\]]*|$)/g) || [t];
      for (const p of parts) { const x = p.trim(); if (x) out.push(x); }
    }
  }
  // 문장부호만 남은 조각("…", "!!")은 앞 문장에 붙인다
  const merged = [];
  for (const s of out) {
    if (merged.length && /^[\p{P}\s]+$/u.test(s)) merged[merged.length - 1] += s;
    else merged.push(s);
  }
  return merged;
}

/* 길이: 실제로 읽어 본 시간이 있으면 그 값, 없으면 글자 수로 추정 */
function durKey(sc) {
  const v = state.voice;
  return [sc.text, v.voiceURI, v.lang, v.rate].join('|');
}
function estimate(text) {
  let cjk = 0, other = 0, punct = 0;
  for (const ch of text.replace(/\s+/g, '')) {
    if (/[가-힣぀-ヿ一-鿿]/.test(ch)) cjk++;
    else if (/[\p{P}]/u.test(ch)) punct++;
    else other++;
  }
  const sec = (cjk / 6.2 + other / 13 + punct * 0.15) / (state.voice.rate || 1) + 0.35;
  return Math.max(0.8, sec);
}
/* 읽는 데 걸리는 시간: 녹음 파일이 있으면 그 길이, 아니면 TTS 실측값이나 추정값 */
function speechDur(sc) {
  if (sc.voice) return sc.voice.dur;
  if (sc.measured && sc.measured.k === durKey(sc)) return sc.measured.d;
  return estimate(sc.text);
}
/* 장면이 화면에 머무는 전체 시간: 나레이션 없는 장면은 정한 길이, 아니면 읽는 시간 + 끝에 더 보여주기 */
function sceneDur(sc) {
  const hold = Math.max(0, +sc.hold || 0);
  if (sc.silent) return Math.max(0.5, +sc.silentDur || 3);
  if (!sc.text.trim() && !sc.voice) return Math.max(1, hold);
  return speechDur(sc) + hold;
}
function timings() {
  const starts = [];
  let t = 0;
  state.scenes.forEach((sc) => {
    starts.push(t);
    t += sceneDur(sc); // 실측값에는 다음 문장 전까지의 자연스러운 쉼이 포함됨
  });
  return { starts, total: t };
}
function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/* ---------------- 음성 (TTS) ---------------- */

const hasTTS = 'speechSynthesis' in window;
let voices = [];
const liveUtterances = new Set(); // GC로 onend가 사라지는 크롬 버그 방지

function filteredVoices() {
  const lang = state.voice.lang;
  if (lang === 'all') return voices;
  return voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
}
function pickVoice() {
  const exact = voices.find((v) => v.voiceURI === state.voice.voiceURI);
  if (exact) return exact;
  const list = filteredVoices();
  return list.find((v) => /natural|online/i.test(v.name)) || list.find((v) => v.default) || list[0] || null;
}
function renderVoiceSelect() {
  const list = filteredVoices();
  const value = list.some((v) => v.voiceURI === state.voice.voiceURI) ? state.voice.voiceURI : '';
  for (const sel of $$('.voice-select')) {
    sel.innerHTML = '';
    sel.append(new Option('자동 선택', ''));
    for (const v of list) {
      sel.append(new Option(`${v.name.replace(/^Microsoft\s+/, '')} (${v.lang})${v.localService ? '' : ' · 온라인'}`, v.voiceURI));
    }
    sel.value = value;
  }
  updateVoiceMode();
  const note = $('#voiceNote');
  if (!hasTTS) {
    note.textContent = '이 브라우저는 음성 읽기를 지원하지 않아요. Edge나 Chrome에서 열어 주세요.';
    note.hidden = false;
  } else if (voices.length && !list.length) {
    note.textContent = '이 언어의 목소리가 설치되어 있지 않아요. Windows 설정 › 시간 및 언어 › 음성에서 추가하거나, 자연스러운 한국어 음성이 있는 Edge 브라우저를 써 보세요.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}
function updateVoiceMode() {
  const el = $('#voiceMode');
  if (!hasTTS) { el.textContent = ''; return; }
  el.textContent = voiceGivesWords(pickVoice())
    ? '읽기 방식: 대본 전체를 한 번에 이어 읽고, 다음 문장 첫 단어에서 화면을 넘겨요.'
    : '읽기 방식: 이 목소리는 단어 위치를 알려 주지 않아, 문장들을 빈틈없이 줄 세워 읽고 문장이 시작될 때 화면을 넘겨요.';
}
function loadVoices() {
  if (!hasTTS) { renderVoiceSelect(); return; }
  voices = speechSynthesis.getVoices();
  renderVoiceSelect();
}

function makeUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = LANG_TAG[state.voice.lang] || 'ko-KR'; }
  u.rate = state.voice.rate;
  u.pitch = state.voice.pitch;
  u.volume = state.voice.volume;
  return u;
}
async function resetSynth() {
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    await sleep(60); // cancel 직후 바로 speak하면 크롬이 새 문장까지 버리는 문제
  }
  if (speechSynthesis.paused) speechSynthesis.resume();
}

/* 목소리 들어 보기용 단순 재생 */
async function speak(text) {
  if (!hasTTS || !text.trim()) return;
  await resetSynth();
  const u = makeUtterance(text);
  liveUtterances.add(u);
  u.onend = u.onerror = () => liveUtterances.delete(u);
  speechSynthesis.speak(u);
}

/* 단어 위치(boundary)를 알려 주는 목소리인지.
   알려 주면 대본 전체를 한 번에 이어 읽으며 단어 위치로 장면을 넘기고,
   안 알려 주면(크롬의 Google 음성 등) 문장들을 미리 줄 세워 빈틈없이 이어 읽는다. */
function voiceGivesWords(v) {
  if (!v) return false;
  if ((state.voice.noWords || []).includes(v.voiceURI)) return false;
  if (/^Google/i.test(v.name)) return false;
  return v.localService || /Microsoft/i.test(v.name);
}
function markNoWords(v) {
  if (!v) return;
  state.voice.noWords = [...new Set([...(state.voice.noWords || []), v.voiceURI])];
  updateVoiceMode();
  save();
}

/* ---------------- 효과음 ---------------- */

/* 파일 없이 Web Audio로 합성하는 기본 효과음. 세 번째 값이 있으면 길이를 정할 수 있는 소리(기본 길이) */
const SYNTH_SFX = [
  ['click', '클릭'], ['pop', '뿅'], ['ding', '딩~ (맑은 종)'], ['coin', '띠링 (코인)'], ['whoosh', '휙 (전환)'],
  ['keyboard', '키보드 타건', 2], ['tap', '탭핑', 1.2], ['drop', '물방울'], ['fire', '모닥불', 4],
];
const synthInfo = (name) => SYNTH_SFX.find((s) => s[0] === name);
const SFX_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm)$/i;
const isAudioFile = (f) => /^audio\//.test(f.type) || SFX_EXT.test(f.name);

let actx = null;
let noiseBuf = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function noiseSrc(ctx, t, dur) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur + 0.05);
  return s;
}
/* 빠르게 올라갔다가 지수적으로 사라지는 음량 */
function env(ctx, t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}
function osc(ctx, type, t, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.start(t);
  o.stop(t + dur);
  return o;
}
function filt(ctx, type, freq, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}
const rand = (a, b) => a + Math.random() * (b - a);

function keyHit(ctx, out, t, a) {
  noiseSrc(ctx, t, 0.04).connect(filt(ctx, 'bandpass', rand(2500, 4500), 0.9)).connect(env(ctx, t, 0.7 * a, 0.001, rand(0.025, 0.05))).connect(out);
  const o = osc(ctx, 'sine', t, 0.07);
  o.frequency.setValueAtTime(rand(150, 220), t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.05);
  o.connect(env(ctx, t, 0.35 * a, 0.002, 0.05)).connect(out);
}

const SYNTH = {
  click(ctx, out, t) {
    noiseSrc(ctx, t, 0.03).connect(filt(ctx, 'highpass', 2500)).connect(env(ctx, t, 0.9, 0.001, 0.025)).connect(out);
    const o = osc(ctx, 'sine', t, 0.06);
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.03);
    o.connect(env(ctx, t, 0.4, 0.001, 0.04)).connect(out);
  },
  pop(ctx, out, t) {
    const o = osc(ctx, 'sine', t, 0.22);
    o.frequency.setValueAtTime(280, t);
    o.frequency.exponentialRampToValueAtTime(1100, t + 0.09);
    o.connect(env(ctx, t, 0.8, 0.005, 0.17)).connect(out);
  },
  ding(ctx, out, t) {
    // 맑은 종: 배음마다 조금씩 다른 속도로 사라짐
    const base = 1046.5;
    for (const [ratio, amp, decay] of [[1, 1, 2.2], [2, 0.5, 1.6], [3, 0.3, 1.1], [4.2, 0.2, 0.8], [5.4, 0.12, 0.5]]) {
      const o = osc(ctx, 'sine', t, decay + 0.05);
      o.frequency.value = base * ratio;
      o.connect(env(ctx, t, amp * 0.45, 0.004, decay)).connect(out);
    }
  },
  coin(ctx, out, t) {
    const lp = filt(ctx, 'lowpass', 5000);
    lp.connect(out);
    const tone = (f, s, d) => {
      const o = osc(ctx, 'square', s, d + 0.02);
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.22, s);
      g.gain.setValueAtTime(0.22, s + d * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, s + d);
      o.connect(g).connect(lp);
    };
    tone(987.77, t, 0.09);
    tone(1318.5, t + 0.08, 0.5);
  },
  whoosh(ctx, out, t) {
    const d = 0.5;
    const bp = filt(ctx, 'bandpass', 300, 1.2);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + d * 0.45);
    bp.frequency.exponentialRampToValueAtTime(500, t + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.3, t + d * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    noiseSrc(ctx, t, d).connect(bp).connect(g).connect(out);
  },
  keyboard(ctx, out, t, len) {
    for (let s = t; s < t + len;) {
      keyHit(ctx, out, s, rand(0.6, 1));
      s += rand(0.07, 0.19) + (Math.random() < 0.1 ? 0.25 : 0); // 가끔 쉬었다 치기
    }
  },
  tap(ctx, out, t, len) {
    for (let s = t; s < t + len; s += rand(0.22, 0.28)) {
      const o = osc(ctx, 'sine', s, 0.1);
      o.frequency.setValueAtTime(320, s);
      o.frequency.exponentialRampToValueAtTime(110, s + 0.06);
      o.connect(env(ctx, s, 0.8, 0.002, 0.07)).connect(out);
      noiseSrc(ctx, s, 0.02).connect(filt(ctx, 'lowpass', 1800)).connect(env(ctx, s, 0.4, 0.001, 0.015)).connect(out);
    }
  },
  drop(ctx, out, t) {
    const o = osc(ctx, 'sine', t, 0.2);
    o.frequency.setValueAtTime(600, t);
    o.frequency.exponentialRampToValueAtTime(1700, t + 0.05);
    o.connect(env(ctx, t, 0.8, 0.003, 0.12)).connect(out);
    const t2 = t + 0.11; // 작은 두 번째 방울
    const o2 = osc(ctx, 'sine', t2, 0.15);
    o2.frequency.setValueAtTime(900, t2);
    o2.frequency.exponentialRampToValueAtTime(2200, t2 + 0.04);
    o2.connect(env(ctx, t2, 0.25, 0.003, 0.08)).connect(out);
  },
  fire(ctx, out, t, len) {
    const end = t + len;
    // 낮게 깔리는 불길 소리
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + Math.min(0.4, len / 3));
    g.gain.setValueAtTime(0.35, Math.max(t + Math.min(0.4, len / 3), end - 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    noiseSrc(ctx, t, len).connect(filt(ctx, 'lowpass', 400)).connect(g).connect(out);
    // 탁탁 튀는 소리(무작위 간격)
    for (let s = t + 0.1; s < end - 0.1; s += -Math.log(1 - Math.random()) / 9) {
      const d = rand(0.005, 0.025);
      noiseSrc(ctx, s, d + 0.02).connect(filt(ctx, 'highpass', rand(1500, 4500))).connect(env(ctx, s, rand(0.2, 0.9), 0.001, d)).connect(out);
    }
  },
};

/* 보관함 파일 → AudioBuffer (한 번 풀어 둔 건 재사용) */
const sfxBufs = new Map();
function decodeAudio(arrayBuf) {
  const ctx = audio();
  return new Promise((res, rej) => ctx.decodeAudioData(arrayBuf, res, rej));
}
function sfxBuffer(id) {
  if (!sfxBufs.has(id)) {
    sfxBufs.set(id, (async () => {
      const blob = await sfxGet(id);
      if (!blob) return null;
      return decodeAudio(await blob.arrayBuffer());
    })().catch((e) => { console.error(e); return null; }));
  }
  return sfxBufs.get(id);
}

/* ---------------- 문장별 녹음 파일(TTS 대신) ---------------- */

const voiceBufs = new Map();
function voiceBuffer(id) {
  if (!voiceBufs.has(id)) {
    voiceBufs.set(id, (async () => {
      const blob = await mediaGet(id);
      return blob ? decodeAudio(await blob.arrayBuffer()) : null;
    })().catch((e) => { console.error(e); return null; }));
  }
  return voiceBufs.get(id);
}

/* 녹음 파일들을 파일 이름 순서대로 start번 장면부터 차례로(나레이션 없는 장면은 건너뜀) */
async function placeVoiceFiles(fileList, start) {
  const files = [...fileList].filter(isAudioFile)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  if (!files.length) { toast('mp3 · wav 같은 소리 파일만 넣을 수 있어요.'); return; }
  if (!state.scenes.length) { toast('먼저 장면을 만들어 주세요.'); return; }
  if (!audio()) { toast('이 브라우저는 소리 파일 재생을 지원하지 않아요.'); return; }
  stopPlayback();
  const targets = [];
  for (let i = Math.max(0, start); i < state.scenes.length && targets.length < files.length; i++) {
    if (!state.scenes[i].silent) targets.push(state.scenes[i]);
  }
  toast('녹음 파일 불러오는 중…', null, 0);
  let ok = 0, failed = 0;
  for (let k = 0; k < targets.length; k++) {
    const file = files[k], sc = targets[k];
    let buf;
    try {
      buf = await decodeAudio(await file.arrayBuffer());
    } catch (e) {
      console.error(e);
      failed++;
      continue;
    }
    const id = 'v_' + uid();
    try {
      await mediaPut(id, new Blob([file], { type: file.type || 'audio/mpeg' }));
    } catch (e) {
      console.error(e);
      failed++;
      continue;
    }
    voiceBufs.set(id, Promise.resolve(buf));
    const old = sc.voice;
    sc.voice = { mediaId: id, name: file.name, dur: +buf.duration.toFixed(3) };
    if (old) releaseMedia({ mediaId: old.mediaId });
    ok++;
  }
  renderScenes();
  renderTimeline();
  renderStage();
  save();
  const left = files.length - targets.length;
  const first = targets.length ? sceneIndex(targets[0].id) + 1 : 0;
  let msg = ok ? `${first}번 장면부터 ${ok}개 문장을 녹음 파일로 읽게 했어요 (파일 이름 순서).` : '녹음 파일을 넣지 못했어요.';
  if (failed) msg += ` ${failed}개는 읽지 못했어요.`;
  if (left > 0) msg += ` 장면이 모자라 ${left}개는 넣지 못했어요.`;
  toast(msg, null, 5000);
}

function clearVoice(sc) {
  if (!sc.voice) return;
  stopPlayback();
  const old = sc.voice;
  sc.voice = null;
  releaseMedia({ mediaId: old.mediaId });
  renderScenes();
  renderTimeline();
  renderStage();
  save();
  toast(`${sceneIndex(sc.id) + 1}번 장면을 다시 TTS로 읽어요.`);
}

function sfxName(src) {
  if (src.startsWith('syn:')) { const s = synthInfo(src.slice(4)); return s ? s[1] : '효과음'; }
  const f = state.sfxLib.find((x) => 'lib:' + x.id === src);
  return f ? f.name : '(지운 효과음)';
}

/* 효과음 하나 재생. delay초 뒤에 시작, bus로 내보냄(재생을 멈추면 bus째 끊어서 한꺼번에 조용히) */
async function playSfx(sfx, delay = 0, bus = null) {
  const ctx = audio();
  if (!ctx) return;
  await startSfx(ctx, sfx, ctx.currentTime + 0.03 + Math.max(0, delay), bus || ctx.destination);
}
/* ctx(실시간 또는 내보내기용 OfflineAudioContext)의 when 시각에 효과음을 dest로 */
async function startSfx(ctx, sfx, when, dest) {
  const out = ctx.createGain();
  out.gain.value = Math.max(0, sfx.vol === undefined ? 1 : +sfx.vol) * Math.max(0, +state.sfxVol);
  out.connect(dest);
  if (sfx.src.startsWith('syn:')) {
    const name = sfx.src.slice(4);
    const info = synthInfo(name);
    if (!info) return;
    SYNTH[name](ctx, out, when, Math.min(30, Math.max(0.2, +sfx.len || info[2] || 1)));
  } else {
    const buf = await sfxBuffer(sfx.src.slice(4));
    if (!buf) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(out);
    s.start(Math.max(when, ctx.currentTime + 0.01));
  }
}

let previewBus = null;
function previewSfx(sfx) {
  const ctx = audio();
  if (!ctx) { toast('이 브라우저는 효과음 재생을 지원하지 않아요.'); return; }
  if (previewBus) previewBus.disconnect(); // 앞서 듣던 미리 듣기는 끊기
  previewBus = ctx.createGain();
  previewBus.connect(ctx.destination);
  playSfx(Object.assign({}, sfx, { at: 0 }), 0, previewBus);
}

/* 장면에 들어설 때 그 장면의 효과음들을 '시작 시점'에 맞춰 예약 */
function scheduleSceneSfx(sc) {
  if (!P.bus || !sc.sfx) return;
  for (const s of sc.sfx) playSfx(s, Math.max(0, +s.at || 0), P.bus);
}

/* ---------------- 효과음 보관함 ---------------- */

function renderSfxBuiltin() {
  const box = $('#sfxBuiltin');
  box.innerHTML = '';
  for (const [name, label] of SYNTH_SFX) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip sfx-chip';
    b.dataset.syn = name;
    b.innerHTML = ICON.play;
    b.append(label.replace(/\s*\(.*\)/, ''));
    b.title = label + ' 미리 듣기';
    box.append(b);
  }
}

function renderSfxLib() {
  const lib = $('#sfxLib');
  lib.innerHTML = '';
  if (!state.sfxLib.length) {
    lib.innerHTML = '<div class="empty">가지고 있는 mp3 · wav 파일을 여기에 끌어다 놓거나<br><b>+ 효과음 파일 추가</b>를 누르세요. 모든 장면에서 골라 쓸 수 있어요.</div>';
    return;
  }
  for (const f of state.sfxLib) {
    const row = document.createElement('div');
    row.className = 'lib-item sfx-item';
    row.dataset.id = f.id;
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'ibtn';
    play.dataset.act = 'sfx-lib-play';
    play.title = '미리 듣기';
    play.innerHTML = ICON.play;
    const input = document.createElement('input');
    input.value = f.name;
    input.maxLength = 40;
    input.spellcheck = false;
    input.setAttribute('aria-label', '효과음 이름');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ibtn danger';
    del.dataset.act = 'sfx-lib-del';
    del.title = '보관함에서 삭제';
    del.innerHTML = ICON.trash;
    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    meta.textContent = `${f.dur ? f.dur.toFixed(1) + '초 · ' : ''}${f.fileName} · ${fmtSize(f.size)}`;
    row.append(play, input, del, meta);
    lib.append(row);
  }
  const note = document.createElement('div');
  note.className = 'lib-drop-note';
  note.textContent = '장면 카드에 끌어다 놓으면 보관함에 넣고 그 장면에 바로 붙여요';
  lib.append(note);
}

/* 효과음 파일을 보관함에 넣기. attachTo 장면이 있으면 그 장면에도 붙임 */
async function addSfxFiles(fileList, attachTo = null) {
  const files = [...fileList].filter(isAudioFile);
  if (!files.length) { toast('mp3 · wav 같은 소리 파일만 넣을 수 있어요.'); return; }
  if (!audio()) { toast('이 브라우저는 효과음 재생을 지원하지 않아요.'); return; }
  toast('효과음 불러오는 중…', null, 0);
  const added = [];
  let failed = 0;
  for (const file of files) {
    const id = 'a_' + uid();
    let buf;
    try {
      buf = await decodeAudio(await file.arrayBuffer());
    } catch (e) {
      console.error(e);
      failed++;
      continue;
    }
    try {
      await sfxPut(id, new Blob([file], { type: file.type || 'audio/mpeg' }));
    } catch (e) {
      console.error(e);
      failed++;
      continue;
    }
    sfxBufs.set(id, Promise.resolve(buf));
    const f = { id, name: file.name.replace(SFX_EXT, ''), fileName: file.name, size: file.size, dur: +buf.duration.toFixed(2) };
    state.sfxLib.push(f);
    added.push(f);
  }
  if (attachTo && added.length) {
    attachTo.sfx = attachTo.sfx || [];
    for (const f of added) attachTo.sfx.push({ id: 'x_' + uid(), src: 'lib:' + f.id, vol: 1, at: 0 });
    openOpts.add(attachTo.id);
  }
  renderSfxLib();
  if (added.length) { renderScenes(); renderTimeline(); }
  save();
  const where = attachTo ? ` ${sceneIndex(attachTo.id) + 1}번 장면에 붙였어요.` : '';
  if (added.length) toast(`효과음 ${added.length}개를 보관함에 넣었어요.${where}${failed ? ` ${failed}개는 읽지 못했어요.` : ''}`);
  else toast('소리 파일을 읽지 못했어요. 손상됐거나 브라우저가 지원하지 않는 형식일 수 있어요.');
}

function deleteSfx(id) {
  const f = state.sfxLib.find((x) => x.id === id);
  if (!f) return;
  const src = 'lib:' + id;
  const using = state.scenes.filter((sc) => (sc.sfx || []).some((s) => s.src === src)).length;
  if (!confirm(`‘${f.name}’ 효과음을 보관함에서 지울까요?` + (using ? `\n${using}개 장면에서 쓰고 있어서, 그 장면들에서도 빠집니다.` : ''))) return;
  state.sfxLib = state.sfxLib.filter((x) => x.id !== id);
  for (const sc of state.scenes) if (sc.sfx) sc.sfx = sc.sfx.filter((s) => s.src !== src);
  sfxBufs.delete(id);
  sfxDel(id).catch(console.error);
  renderSfxLib();
  renderScenes();
  renderTimeline();
  save();
}

/* ---------------- 재생 ---------------- */

const P = {
  playing: false, mode: null, index: -1, token: 0, start: 0, raf: 0, singleId: null, endedAtEnd: false,
  chunks: null, chunkIdx: 0, wordAt: -1, speaking: false, still: false, bus: null,
  rec: null, // MP4 내보내기의 목소리 녹음 중일 때 { t0, log, onEnd }
};

function startPlayback(from, single = false) {
  stopPlayback();
  if (!state.scenes.length || from < 0) return;
  P.playing = true;
  P.mode = single ? 'single' : 'all';
  P.singleId = single ? state.scenes[from].id : null;
  P.endedAtEnd = false;
  // 효과음은 이번 재생 전용 bus로: 멈추면 예약된 소리까지 한꺼번에 끊김
  // 목소리 녹음 중에는 효과음을 내지 않음(녹음에 섞이지 않게, 나중에 따로 섞어 넣음)
  const ctx = !P.rec && state.scenes.some((sc) => (sc.sfx && sc.sfx.length) || sc.voice) ? audio() : null;
  if (ctx) {
    P.bus = ctx.createGain();
    P.bus.connect(ctx.destination);
    for (const sc of state.scenes) {
      for (const s of sc.sfx || []) if (s.src.startsWith('lib:')) sfxBuffer(s.src.slice(4));
      if (sc.voice) voiceBuffer(sc.voice.mediaId); // 미리 풀어 두기
    }
  }
  const token = ++P.token;
  updatePlayUI();
  runLoop();
  playFrom(from, token);
}

/* 재생 계획 만들기.
   이어지는 문장들은 하나의 '읽기 묶음'으로 이어 읽는다(각 장면이 묶음 글의 몇 번째 글자에서 시작하는지 기록).
   '끝에 더 보여주기'가 있는 장면에서 묶음을 끊고 그만큼 기다리며,
   나레이션 없는 장면(또는 글이 빈 장면)은 정한 시간만큼 화면만 보여 준다. */
function buildPlan(from) {
  const idxs = P.mode === 'single' ? [from] : state.scenes.map((_, i) => i).slice(from);
  const plan = [];
  let group = null;
  const flush = () => { if (group) plan.push(group); group = null; };
  for (const i of idxs) {
    const sc = state.scenes[i];
    const t = sc.text.trim();
    if (!sc.silent && sc.voice) { // 녹음 파일로 읽는 문장: TTS 이어 읽기를 여기서 끊고 파일 재생
      flush();
      plan.push({ type: 'file', i, hold: Math.max(0, +sc.hold || 0) });
      continue;
    }
    if (sc.silent || !t) {
      flush();
      plan.push({ type: 'still', i, sec: sceneDur(sc) });
      continue;
    }
    if (!group) group = { type: 'speech', segs: [], text: '', hold: 0 };
    if (group.text) group.text += ' ';
    group.segs.push({ i, start: group.text.length, text: t });
    group.text += t;
    if (+sc.hold > 0) { group.hold = +sc.hold; flush(); }
  }
  flush();
  return plan;
}

/* 장면에 들어설 때: 화면·자막을 넘기고, 앞 장면을 읽는 데 실제로 얼마나 걸렸는지 기록 */
function enterSeg(seg, speaking = true) {
  if (P.index === seg.i && P.chunks) return;
  measureLeave();
  P.index = seg.i;
  P.start = performance.now();
  P.chunks = subChunks(seg.text);
  P.chunkIdx = 0;
  P.wordAt = -1;
  P.speaking = speaking;
  P.still = !speaking;
  recLog('scene', { i: seg.i });
  selectScene(state.scenes[seg.i].id, { scroll: true });
  scheduleSceneSfx(state.scenes[seg.i]);
  // 영상이 새로 시작되는 장면이면 처음부터 재생
  const own = state.scenes[seg.i].media;
  const node = stageNode();
  if (own && own.type === 'video' && node && node.dataset.mid === own.mediaId) {
    node.currentTime = own.segs && own.segs.length ? own.segs[0].s : 0; // 다듬은 영상이면 첫 남길 구간부터
    node.play().catch(() => {});
  }
}
function measureLeave() {
  const sc = state.scenes[P.index];
  if (!hasTTS || !sc || !P.chunks || !P.speaking) return;
  const d = (performance.now() - P.start) / 1000;
  if (d < 0.3) return;
  const k = durKey(sc);
  const changed = !sc.measured || sc.measured.k !== k || Math.abs(sc.measured.d - d) > 0.05;
  sc.measured = { k, d: +d.toFixed(2) };
  if (changed) { renderTimeline(); updateCardDur(sc); save(); }
}

async function playFrom(from, token) {
  const plan = buildPlan(from);
  if (!plan.length) { stopPlayback(); return; }
  P.index = -1;
  P.chunks = null;
  let done = true;
  for (const item of plan) {
    if (token !== P.token) return;
    const r = item.type === 'still' ? await playStill(item, token)
      : item.type === 'file' ? await playFile(item, token)
      : await playSpeech(item, token);
    if (token !== P.token) return;
    if (!r.done) { done = false; break; }
  }
  const atEnd = done && P.mode === 'all';
  recLog('end');
  const rec = P.rec;
  stopPlayback();
  if (atEnd) P.endedAtEnd = true;
  if (rec && rec.onEnd) rec.onEnd(atEnd); // MP4 내보내기의 목소리 녹음이 끝남
}

/* MP4 내보내기용: 목소리를 녹음하는 동안 장면·자막이 넘어간 시각을 기록 */
function recLog(type, data) {
  if (P.rec) P.rec.log.push(Object.assign({ t: (performance.now() - P.rec.t0) / 1000, type }, data));
}

/* 나레이션 없는 장면: 정한 시간만큼 화면(과 글이 있으면 자막)만 보여 줌 */
async function playStill(item, token) {
  P.chunks = null;
  enterSeg({ i: item.i, text: state.scenes[item.i].text.trim() }, false);
  await sleep(item.sec * 1000);
  return { done: token === P.token };
}

/* 녹음 파일로 읽는 문장: 파일을 끝까지 틀고(자막은 파일 길이에 맞춰 넘김), 끝에 더 보여주기만큼 기다림.
   MP4용 목소리 녹음 중에는 소리를 내지 않고 시간만 맞춤(파일은 나중에 따로 섞어 넣음) */
async function playFile(item, token) {
  const sc = state.scenes[item.i];
  P.chunks = null;
  enterSeg({ i: item.i, text: sc.text.trim() });
  if (!P.rec && P.bus) {
    const buf = await voiceBuffer(sc.voice.mediaId);
    if (token !== P.token) return { done: false };
    if (buf) {
      const src = audio().createBufferSource();
      src.buffer = buf;
      src.connect(P.bus);
      src.start();
      P.start = performance.now();
    }
  }
  await sleep(sc.voice.dur * 1000);
  if (token !== P.token) return { done: false };
  P.speaking = false;
  if (P.chunks && P.chunks.length > 1) showChunk(P.chunks.length - 1);
  if (item.hold) await sleep(item.hold * 1000);
  return { done: token === P.token };
}

/* 읽기 묶음 하나를 이어 읽고, 필요하면 끝에 더 보여주기만큼 기다림 */
async function playSpeech(group, token) {
  const { segs, text } = group;
  P.chunks = null;
  enterSeg(segs[0]);

  let r;
  if (!hasTTS) {
    r = await playSilent(segs, token);
  } else {
    const v = pickVoice();
    if (P.mode === 'single' || voiceGivesWords(v)) {
      r = await playContinuous(segs, text, token, P.mode !== 'single');
      if (r.fallback && token === P.token) {
        // 단어 위치를 안 알려 주는 목소리였음 → 지금 장면부터 문장 줄 세우기 방식으로 다시
        markNoWords(v);
        const cur = Math.max(0, segs.findIndex((s) => s.i === P.index));
        P.speaking = false;
        P.chunks = null;
        enterSeg(segs[cur]);
        r = await playQueued(segs.slice(cur), token);
      }
    } else {
      r = await playQueued(segs, token);
    }
  }
  if (token !== P.token) return { done: false };
  if (r.done) measureLeave();
  P.speaking = false;
  if (P.chunks && P.chunks.length > 1) showChunk(P.chunks.length - 1);
  if (r.done && group.hold) await sleep(group.hold * 1000);
  return { done: r.done && token === P.token };
}

/* 방식 1: 대본을 하나의 발화로 이어 읽고, 다음 장면의 첫 단어를 읽기 시작하는 순간 화면을 넘김 */
function playContinuous(segs, text, token, allowFallback) {
  return new Promise(async (resolve) => {
    await resetSynth();
    if (token !== P.token) { resolve({ done: false }); return; }
    const u = makeUtterance(text);
    let gotWord = false, finished = false, watch = 0;
    const fin = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(watch);
      liveUtterances.delete(u);
      resolve(r);
    };
    // 이벤트가 끊기면(엔진 멈춤) 영원히 기다리지 않게
    const kick = (ms) => { clearTimeout(watch); watch = setTimeout(() => fin({ done: true }), ms); };

    u.onstart = () => {
      if (token !== P.token) return;
      P.start = performance.now();
      recLog('speak');
      kick((estimate(text) * 3 + 8) * 1000);
      if (allowFallback && segs.length > 1) {
        setTimeout(() => { if (!finished && !gotWord && token === P.token) fin({ fallback: true }); }, 2500);
      }
    };
    u.onboundary = (e) => {
      if (token !== P.token || e.name === 'sentence') return;
      gotWord = true;
      kick(12000);
      let k = 0;
      for (let j = 0; j < segs.length; j++) if (segs[j].start <= e.charIndex) k = j;
      enterSeg(segs[k]);
      P.wordAt = e.charIndex - segs[k].start;
    };
    u.onend = () => fin({ done: true });
    u.onerror = (e) => fin({ done: !/interrupted|canceled/.test(e.error) });
    liveUtterances.add(u);
    kick(20000); // 온라인 음성은 시작까지 시간이 걸릴 수 있음
    speechSynthesis.speak(u);
  });
}

/* 방식 2: 문장마다 발화를 만들되 한꺼번에 줄 세워 두고, 각 문장이 소리 나기 시작하는 순간 화면을 넘김 */
function playQueued(segs, token) {
  return new Promise(async (resolve) => {
    await resetSynth();
    if (token !== P.token) { resolve({ done: false }); return; }
    let finished = false, watch = 0;
    const fin = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(watch);
      resolve(r);
    };
    const kick = (seg) => {
      clearTimeout(watch);
      watch = setTimeout(() => fin({ done: true }), (estimate(seg.text) * 3 + 8) * 1000);
    };
    segs.forEach((seg, n) => {
      const u = makeUtterance(seg.text);
      u.onstart = () => {
        if (token !== P.token) return;
        kick(seg);
        recLog('speak');
        enterSeg(seg);
        P.start = performance.now();
      };
      u.onboundary = (e) => {
        if (token === P.token && e.name !== 'sentence' && P.index === seg.i) P.wordAt = e.charIndex;
      };
      u.onend = () => {
        liveUtterances.delete(u);
        if (n === segs.length - 1) fin({ done: true });
      };
      u.onerror = (e) => {
        liveUtterances.delete(u);
        fin({ done: false });
      };
      liveUtterances.add(u);
      speechSynthesis.speak(u);
    });
    kick({ text: segs[0].text + ' ' + segs[0].text }); // 첫 문장 시작 대기는 넉넉히
  });
}

/* 음성 읽기를 못 쓰는 브라우저: 예상 시간만큼 화면만 넘김 */
async function playSilent(segs, token) {
  for (const seg of segs) {
    if (token !== P.token) return { done: false };
    enterSeg(seg);
    P.start = performance.now();
    await sleep(estimate(seg.text) * 1000);
  }
  return { done: true };
}

/* 재생 중에 목소리·속도·높낮이를 바꾸면 지금 장면부터 새 설정으로 다시 읽음 */
function restartIfPlaying() {
  if (!P.playing || P.index < 0) return;
  startPlayback(P.index, P.mode === 'single');
}

function stopPlayback() {
  P.token++;
  P.playing = false;
  P.speaking = false;
  P.still = false;
  P.chunks = null;
  P.singleId = null;
  if (P.bus) { P.bus.disconnect(); P.bus = null; }
  cancelAnimationFrame(P.raf);
  if (hasTTS && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  applyMediaStatic(stageMedia); // 멈추면 영상 소리도 끔
  updatePlayUI();
  updateClock();
  updateMotion();
}

function runLoop() {
  cancelAnimationFrame(P.raf);
  const loop = () => {
    if (!P.playing) return;
    const { starts, total } = timings();
    const i = P.index;
    if (i >= 0 && i < starts.length) {
      const span = (i + 1 < starts.length ? starts[i + 1] : total) - starts[i];
      const elapsed = (performance.now() - P.start) / 1000;
      const t = starts[i] + Math.min(elapsed, span * 0.995);
      updateClock(t, true);
      updateMotion(t);
      if ((P.speaking || P.still) && P.chunks && P.chunks.length > 1) {
        showChunk(currentChunk(state.scenes[i], elapsed));
      }
    }
    P.raf = requestAnimationFrame(loop);
  };
  P.raf = requestAnimationFrame(loop);
}

/* 지금 보여 줄 자막 조각: 목소리가 단어 위치를 알려 주면 그 위치로, 아니면 글자 수 비율로 시간을 나눠서 */
function currentChunk(sc, elapsed) {
  const chunks = P.chunks;
  let idx = 0;
  if (P.wordAt >= 0) {
    chunks.forEach((c, j) => { if (c.start <= P.wordAt) idx = j; });
  } else {
    const weights = chunks.map((c) => c.text.replace(/\s+/g, '').length || 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    const frac = elapsed / Math.max(0.5, P.still ? sceneDur(sc) : speechDur(sc));
    let acc = 0;
    for (let j = 0; j < chunks.length; j++) {
      if (frac >= acc / sum) idx = j;
      acc += weights[j];
    }
  }
  return Math.max(idx, P.chunkIdx); // 뒤로 돌아가지 않게
}
function showChunk(idx) {
  if (!P.chunks || idx === P.chunkIdx) return;
  P.chunkIdx = idx;
  recLog('chunk', { i: P.index, idx });
  const sc = state.scenes[P.index];
  setSubtitle(P.chunks[idx].text, sc && sc.hideSub);
  updateSceneLabel();
}

function togglePlay() {
  if (P.playing) { stopPlayback(); return; }
  let from = selectedIndex();
  if (P.endedAtEnd && from === state.scenes.length - 1) from = 0;
  startPlayback(from);
}

function updatePlayUI() {
  $('#playBtn').classList.toggle('playing', P.playing && P.mode === 'all');
  $('#stage').classList.toggle('playing', P.playing); // 재생 중엔 꾸미기 테두리·손잡이 숨김
  $$('.scene').forEach((card) => {
    const on = P.playing && P.singleId === card.dataset.id;
    const b = $('.listen', card);
    const sc = findScene(card.dataset.id);
    b.classList.toggle('on', on);
    b.title = on ? '멈추기' : sc && sc.silent ? '이 장면 미리 보기' : '이 문장만 미리 듣기';
  });
}

/* ---------------- 미리보기 ---------------- */

let stageKey = null;

function fitStage() {
  const wrap = $('#stageWrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const ar = ASPECTS[state.aspect] || 9 / 16;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  const stage = $('#stage');
  stage.style.width = Math.floor(w) + 'px';
  stage.style.height = Math.floor(h) + 'px';
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function applySubStyle(target = $('#stage')) { // 내보내기 때는 숨겨 둔 측정용 무대에도 똑같이 적용
  const s = state.sub;
  const st = target.style;
  st.setProperty('--sub-font', s.font);
  st.setProperty('--sub-size', s.size);
  st.setProperty('--sub-weight', s.weight);
  st.setProperty('--sub-lh', s.lineH);
  st.setProperty('--sub-ls', s.letterSp);
  st.setProperty('--sub-color', s.color);
  const g = s.glow;
  st.setProperty('--sub-shadow', g > 0
    ? [1, 2.5, 5].map((k) => `0 0 ${(g * k).toFixed(2)}cqmin ${s.glowColor}`).join(', ')
    : 'none');
  st.setProperty('--sub-stroke', s.stroke);
  st.setProperty('--sub-stroke-w', s.strokeW);
  st.setProperty('--sub-y', s.posY + '%');
  st.setProperty('--sub-maxw', s.maxW + '%');
  st.setProperty('--sub-box', s.box ? hexToRgba(s.boxColor, s.boxOpacity) : 'transparent');
}

/* 긴 문장을 약 N자씩, 띄어쓰기 기준으로 고르게 나눈다. start는 원문에서의 위치(TTS 단어 위치와 맞추는 데 씀) */
function subChunks(text) {
  const N = Number(state.sub.chunk) || 0;
  const whole = [{ text: text.trim(), start: 0 }];
  if (!N || text.trim().length <= N) return whole;

  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    // 띄어쓰기 없이 너무 긴 덩어리는 같은 길이로 강제로 자름
    const w = m[0];
    const size = Math.ceil(w.length / Math.ceil(w.length / N));
    for (let p = 0; p < w.length; p += size) words.push({ w: w.slice(p, p + size), s: m.index + p });
  }
  const lenOf = (g) => g.reduce((a, x) => a + x.w.length, 0) + Math.max(0, g.length - 1);
  const greedy = (L) => {
    const out = [];
    let cur = [];
    for (const x of words) {
      if (cur.length && lenOf(cur) + 1 + x.w.length > L) { out.push(cur); cur = []; }
      cur.push(x);
    }
    if (cur.length) out.push(cur);
    return out;
  };
  // 조각 수는 그대로 두고 길이를 최대한 비슷하게(마지막에 한두 글자만 남는 일 방지)
  const total = lenOf(words);
  const k = Math.ceil(total / N);
  let groups = greedy(N);
  for (let L = Math.ceil(total / k); L < N; L++) {
    const g = greedy(L);
    if (g.length <= groups.length) { groups = g; break; }
  }
  return groups.map((g) => ({ text: g.map((x) => x.w).join(' '), start: g[0].s }));
}

function setSubtitle(text, hide = false) {
  $('#subText').textContent = text;
  $('#sub').hidden = hide || !text.trim();
}

function renderStage() {
  const i = selectedIndex();
  const sc = state.scenes[i];
  $('#stageEmpty').hidden = !!state.scenes.length;
  const hide = !!(sc && sc.hideSub);
  if (P.playing && P.index === i && P.chunks) setSubtitle(P.chunks[P.chunkIdx].text, hide);
  else setSubtitle(sc ? subChunks(sc.text)[0].text : '', hide);
  showMedia(sc ? effectiveMedia(i).media : null);
  updateSceneLabel();
  renderLayers();
}

let stageMedia = null;
const stageNode = () => $('#mediaLayer .media');

async function showMedia(m) {
  stageMedia = m;
  const key = !m ? 'none'
    : m.type === 'color' ? 'c:' + m.color
    : `${m.type}:${m.mediaId}`;
  if (key === stageKey) { // 같은 화면이면 그대로 둬서 이어지는 영상이 끊기지 않게
    applyMediaStatic(m);
    updateMotion();
    return;
  }
  stageKey = key;
  const layer = $('#mediaLayer');
  if (!m || m.type === 'color') {
    layer.replaceChildren();
    layer.style.background = m ? m.color : FALLBACK_BG;
    applyMediaStatic(m);
    return;
  }
  const url = await mediaURL(m.mediaId);
  if (stageKey !== key) return;
  layer.style.background = '#000';
  if (!url) {
    layer.innerHTML = '<div class="missing">파일을 찾을 수 없어요</div>';
    return;
  }
  let node;
  if (m.type === 'image') {
    node = new Image();
    node.alt = '';
  } else {
    node = document.createElement('video');
    node.muted = true;
    node.loop = true;
    node.playsInline = true;
    node.autoplay = true;
  }
  node.className = 'media';
  node.dataset.mid = m.mediaId;
  node.src = url;
  layer.replaceChildren(node);
  if (m.type === 'video') {
    if (m.segs && m.segs.length) node.currentTime = m.segs[0].s;
    watchSegments(node);
  }
  applyMediaStatic(stageMedia);
  updateMotion();
  if (node.play) node.play().catch(() => {});
}

/* 맞춤 · 어둡게 · 영상 소리(소리는 재생 중에만 나게) */
function applyMediaStatic(m) {
  const real = m && m.type !== 'color';
  $('#dimLayer').style.opacity = real ? (+m.dim || 0) : 0;
  const node = stageNode();
  if (!node || !real) return;
  node.style.objectFit = m.fit || 'cover';
  if (node.tagName === 'VIDEO') {
    const vol = Math.min(1, Math.max(0, +m.volume || 0));
    node.volume = vol;
    node.muted = !(P.playing && vol > 0) || !!P.rec; // 목소리 녹음 중엔 영상 소리도 끔
  }
}

/* 천천히 확대 · 축소 · 이동: 이 화면이 이어지는 장면들 전체에 걸쳐 0→1로 진행 */
const MOTIONS = [
  ['none', '움직임 없음'], ['zoomIn', '천천히 확대'], ['zoomOut', '천천히 축소'],
  ['panLeft', '왼쪽으로 이동'], ['panRight', '오른쪽으로 이동'], ['panUp', '위로 이동'], ['panDown', '아래로 이동'],
];
const MOTION_AMTS = [['0.5', '약하게'], ['1', '보통'], ['1.8', '강하게']];

/* 움직임 값: 배율 s, 이동 tx·ty(화면 너비·높이의 %). 미리보기(CSS)와 내보내기(캔버스)가 함께 씀 */
function motionParams(type, p, amt) {
  const a = 0.12 * amt;           // 확대 비율
  const s = 1 + a;
  const max = (a / 2 / s) * 100;  // 가장자리가 드러나지 않는 최대 이동(%)
  switch (type) {
    case 'zoomIn': return { s: 1 + a * p, tx: 0, ty: 0 };
    case 'zoomOut': return { s: 1 + a * (1 - p), tx: 0, ty: 0 };
    case 'panLeft': return { s, tx: max * (1 - 2 * p), ty: 0 };
    case 'panRight': return { s, tx: -max * (1 - 2 * p), ty: 0 };
    case 'panUp': return { s, tx: 0, ty: max * (1 - 2 * p) };
    case 'panDown': return { s, tx: 0, ty: -max * (1 - 2 * p) };
    default: return null;
  }
}
function motionTransform(type, p, amt) {
  const m = motionParams(type, p, amt);
  return m ? `scale(${m.s}) translate(${m.tx}%, ${m.ty}%)` : '';
}

/* 영상 다듬기: 원본은 그대로 두고 남길 구간만 media.segs = [{ s, e }](원본 초)로 기억.
   segs가 없으면 영상 전체. 남길 구간들을 이어 붙인 '다듬은 영상' 시간 ↔ 원본 시간 */
const videoSegs = (m, dur) => (m && m.segs && m.segs.length ? m.segs : [{ s: 0, e: dur }]);
const segsDuration = (segs) => segs.reduce((a, g) => a + (g.e - g.s), 0);
function virtToSource(segs, v) {
  for (const g of segs) {
    const len = g.e - g.s;
    if (v < len) return g.s + v;
    v -= len;
  }
  return segs[segs.length - 1].e;
}

/* 미리보기 영상이 남길 구간만 이어서 보이게: 잘라낸 곳은 건너뛰고, 마지막 구간이 끝나면 첫 구간으로 */
function watchSegments(node) {
  const tick = () => {
    if (!node.isConnected) return;
    const m = stageMedia;
    const segs = m && m.type === 'video' && m.mediaId === node.dataset.mid && m.segs;
    if (segs && segs.length && !node.seeking) {
      const t = node.currentTime;
      if (!segs.some((g) => t >= g.s - 0.05 && t < g.e - 0.03)) {
        const next = segs.find((g) => g.s >= t - 0.05);
        node.currentTime = (next || segs[0]).s;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* i번 장면에 보이는 화면이 몇 번 장면부터 몇 번 장면까지 이어지는지 */
function mediaRun(i) {
  const eff = effectiveMedia(i);
  if (eff.from < 0) return null;
  let end = eff.from;
  while (end + 1 < state.scenes.length && !state.scenes[end + 1].media) end++;
  return { from: eff.from, to: end, media: eff.media };
}

function updateMotion(t) {
  const node = stageNode();
  if (!node) return;
  const i = P.playing && P.index >= 0 ? P.index : selectedIndex();
  const run = i >= 0 ? mediaRun(i) : null;
  const m = run && run.media;
  if (!m || m.type === 'color' || !m.motion || m.motion === 'none' || node.dataset.mid !== m.mediaId) {
    node.style.transform = '';
    return;
  }
  const { starts, total } = timings();
  const s0 = starts[run.from];
  const s1 = run.to + 1 < starts.length ? starts[run.to + 1] : total;
  if (t === undefined) t = starts[i];
  const p = Math.min(1, Math.max(0, (t - s0) / Math.max(0.1, s1 - s0)));
  node.style.transform = motionTransform(m.motion, p, +m.motionAmt || 1);
}

function updateSceneLabel() {
  const n = state.scenes.length;
  if (!n) { $('#sceneLabel').textContent = ''; return; }
  const i = selectedIndex();
  const chunks = P.playing && P.index === i && P.chunks ? P.chunks : subChunks(state.scenes[i].text);
  const cur = P.playing && P.index === i ? P.chunkIdx : 0;
  $('#sceneLabel').textContent = `장면 ${i + 1} / ${n}` + (chunks.length > 1 ? ` · 자막 ${cur + 1}/${chunks.length}` : '');
}

/* ---------------- 타임라인 ---------------- */

function thumbStyle(m) {
  if (!m) return `background-color:${FALLBACK_BG}`;
  if (m.type === 'color') return `background-color:${m.color}`;
  return m.thumb ? `background-image:url("${m.thumb}")` : 'background-color:#000';
}

function renderTimeline() {
  const pps = state.ui.zoom;
  const { starts, total } = timings();
  const n = state.scenes.length;
  const inner = $('#tlInner');
  inner.style.width = Math.ceil(total * pps + 60) + 'px';
  inner.style.setProperty('--pps', pps + 'px');

  const ruler = $('#tlRuler');
  ruler.innerHTML = '';
  const step = pps >= 60 ? 1 : pps >= 30 ? 2 : 5;
  for (let t = 0; t <= total + step; t += step) {
    const s = document.createElement('span');
    s.style.left = t * pps + 'px';
    s.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    ruler.append(s);
  }

  const blocks = $('#tlBlocks');
  blocks.innerHTML = '';
  const sel = state.scenes[selectedIndex()];
  state.scenes.forEach((sc, i) => {
    const eff = effectiveMedia(i);
    const b = document.createElement('div');
    b.className = 'tl-block' + (eff.from !== i ? ' inherit' : '') + (sel && sel.id === sc.id ? ' active' : '');
    b.dataset.id = sc.id;
    b.style.cssText = thumbStyle(eff.media);
    b.style.width = Math.max(4, sceneDur(sc) * pps) + 'px';
    b.title = sc.text;
    const flags = [];
    if (sc.silent) flags.push('무음');
    else if (sc.voice) flags.push('녹음');
    if (sc.hideSub) flags.push('자막✕');
    if (!sc.silent && +sc.hold) flags.push(`+${+sc.hold}초`);
    b.innerHTML = `<span class="tl-num">${i + 1}</span>${eff.from !== i && eff.from >= 0 ? `<span class="tl-inh">↳ ${eff.from + 1}</span>` : ''}`
      + (flags.length ? `<span class="tl-flags">${flags.join(' · ')}</span>` : '')
      + '<span class="tl-txt"></span>';
    $('.tl-txt', b).textContent = sc.text;
    if (sc.hideSub) b.classList.add('nosub');
    for (const s of sc.sfx || []) { // 효과음이 울리는 지점
      const mk = document.createElement('span');
      mk.className = 'tl-sfx';
      mk.style.left = Math.min(+s.at || 0, sceneDur(sc)) * pps + 'px';
      mk.title = `${sfxName(s.src)} · ${+s.at || 0}초 뒤`;
      mk.textContent = '♪';
      b.append(mk);
    }
    blocks.append(b);
  });
  updateClock();
}

function updateClock(t, follow = false) {
  const { starts, total } = timings();
  if (t === undefined) {
    const i = selectedIndex();
    t = i >= 0 ? starts[i] : 0;
  }
  $('#clock').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  const x = t * state.ui.zoom;
  $('#playhead').style.left = x + 'px';
  if (follow) {
    const tl = $('#timeline');
    const pad = 16;
    if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - pad * 3) {
      tl.scrollLeft = Math.max(0, x - tl.clientWidth * 0.3);
    }
  }
}

function sceneAtTime(t) {
  const { starts } = timings();
  let idx = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= t) idx = i;
  return idx;
}

/* ---------------- 장면 목록 ---------------- */

const ICON = {
  grip: '<svg viewBox="0 0 24 24"><path d="M9 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  play: '<svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg class="i-stop" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 6l-6 6 1.4 1.4 3.6-3.6V18h2V9.8l3.6 3.6L18 12z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 18l6-6-1.4-1.4-3.6 3.6V6h-2v8.2l-3.6-3.6L6 12z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zm2 2v8.5l3.5-3.5 3 3 2-2 3.5 3.5V7zm9 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h-2v-2.1A7 7 0 0 1 5 12z"/></svg>',
  palette: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0 0 18c1 0 1.5-.7 1.5-1.4 0-.9-.7-1.2-.7-2 0-.8.6-1.4 1.4-1.4H16a5 5 0 0 0 5-5c0-4.6-4-8.2-9-8.2zM7 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
};

const openOpts = new Set(); // '화면 · 시간'을 펼쳐 둔 장면(다시 그려도 유지)

function renderScenes() {
  const list = $('#sceneList');
  list.innerHTML = '';
  $('#sceneCount').textContent = state.scenes.length ? `${state.scenes.length}개` : '';
  if (!state.scenes.length) {
    list.innerHTML = '<div class="empty">아직 장면이 없어요.<br>대본을 나누거나 <b>+ 장면 추가</b>를 눌러 보세요.</div>';
    return;
  }
  const selId = state.scenes[selectedIndex()].id;
  state.scenes.forEach((sc, i) => list.append(sceneCard(sc, i, selId)));
  refreshCardMedia();
  updatePlayUI();
  $$('.scene-text', list).forEach(autoGrow);
}

function sceneCard(sc, i, selId) {
  const n = state.scenes.length;
  const el = document.createElement('article');
  el.className = 'scene' + (sc.id === selId ? ' selected' : '');
  el.dataset.id = sc.id;
  el.innerHTML = `
    <div class="scene-head">
      <span class="handle" draggable="true" title="끌어서 순서 바꾸기">${ICON.grip}</span>
      <span class="num">${i + 1}</span>
      <span class="dur"></span>
      <div class="acts">
        <button type="button" class="ibtn listen" data-act="listen" title="이 문장만 미리 듣기">${ICON.play}${ICON.stop}</button>
        <button type="button" class="ibtn" data-act="up" title="위로" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button type="button" class="ibtn" data-act="down" title="아래로" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button type="button" class="ibtn" data-act="insert" title="아래에 장면 추가">${ICON.plus}</button>
        <button type="button" class="ibtn danger" data-act="del" title="장면 삭제">${ICON.trash}</button>
      </div>
    </div>
    <textarea class="scene-text" rows="1" spellcheck="false" aria-label="${i + 1}번 장면 문장"></textarea>
    <div class="voice-row" title="녹음 파일을 여기에 끌어다 놓아도 돼요 (여러 개면 파일 이름 순서대로 다음 문장들에)">
      <span class="vr-ico">${ICON.mic}</span>
      <span class="vr-label"></span>
      <button type="button" class="mbtn" data-act="voice-file"></button>
      <button type="button" class="mbtn" data-act="voice-tts">TTS로 되돌리기</button>
    </div>
    <div class="media-row">
      <div class="thumb"></div>
      <div class="media-info">
        <div class="media-label"></div>
        <div class="media-btns">
          <button type="button" class="mbtn" data-act="file">${ICON.image}이미지·영상</button>
          <label class="mbtn" title="단색 배경">${ICON.palette}단색<input type="color" data-act="color" aria-label="단색 배경 색"></label>
          <button type="button" class="mbtn" data-act="video-edit" title="앞뒤 자르기 · 중간 잘라내기">영상 다듬기</button>
          <button type="button" class="mbtn" data-act="clear">비우기</button>
        </div>
      </div>
    </div>
    <details class="scene-opts"${openOpts.has(sc.id) ? ' open' : ''}>
      <summary><span class="opts-title">화면 · 시간 · 효과음</span><span class="opts-sum"></span></summary>
      <div class="opts-body">
        <div class="opt-media">
          <div class="opt-row">
            <span class="opt-label">맞춤</span>
            <div class="seg">
              <button type="button" data-act="fit" data-val="cover">가득 채우기</button>
              <button type="button" data-act="fit" data-val="contain">전체 보이기</button>
            </div>
          </div>
          <div class="opt-row">
            <span class="opt-label">움직임</span>
            <select data-opt="motion" aria-label="움직임">${MOTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
            <select data-opt="motionAmt" aria-label="움직임 세기">${MOTION_AMTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </div>
          <div class="opt-row">
            <span class="opt-label">어둡게</span>
            <input type="range" min="0" max="0.8" step="0.05" data-opt="dim" aria-label="화면 어둡게">
            <output data-o="dim"></output>
          </div>
          <div class="opt-row opt-video">
            <span class="opt-label">영상 소리</span>
            <input type="range" min="0" max="1" step="0.05" data-opt="volume" aria-label="영상 소리 크기">
            <output data-o="volume"></output>
          </div>
        </div>
        <p class="opt-note"></p>
        <div class="opt-time">
          <label class="chk"><input type="checkbox" data-opt="silent"> 나레이션 없이 화면만 보여주기</label>
          <div class="opt-row opt-silent">
            <span class="opt-label">보여줄 길이</span>
            <input type="number" min="0.5" max="120" step="0.5" data-opt="silentDur" aria-label="보여줄 길이(초)"><span class="unit">초</span>
          </div>
          <label class="chk"><input type="checkbox" data-opt="hideSub"> <span class="hide-label">읽기는 하되 자막 숨기기</span></label>
          <div class="opt-row opt-speech">
            <span class="opt-label">끝에 더 보여주기</span>
            <input type="number" min="0" max="60" step="0.5" data-opt="hold" aria-label="끝에 더 보여주기(초)"><span class="unit">초</span>
          </div>
        </div>
        <div class="opt-sfx">
          <div class="opt-row">
            <span class="opt-label">효과음</span>
            <button type="button" class="mbtn" data-act="sfx-add">+ 효과음 추가</button>
          </div>
          <div class="sfx-list"></div>
        </div>
      </div>
    </details>`;
  renderSfxRows(el, sc);
  $('.scene-text', el).value = sc.text;
  $('.dur', el).textContent = sceneDur(sc).toFixed(1) + '초';
  return el;
}

function refreshCardMedia() {
  $$('.scene').forEach((card) => {
    const i = sceneIndex(card.dataset.id);
    if (i < 0) return;
    const sc = state.scenes[i];
    const eff = effectiveMedia(i);
    const own = sc.media;
    const thumb = $('.thumb', card);
    thumb.style.cssText = thumbStyle(eff.media);
    thumb.classList.toggle('inherit', !own);
    thumb.innerHTML = eff.media && eff.media.type === 'video' ? '<span class="vbadge">영상</span>' : '';

    const label = $('.media-label', card);
    if (own && own.type === 'color') label.innerHTML = `<b>단색</b> · ${escapeHtml(String(own.color))}`;
    else if (own) label.innerHTML = `<b>${own.type === 'video' ? '영상' : '이미지'}</b> · <span></span>`;
    else if (eff.from >= 0) label.innerHTML = `↳ <b>${eff.from + 1}번 장면</b> 화면 이어쓰기`;
    else label.innerHTML = '화면 없음 · 파일을 끌어다 놓거나 Ctrl+V';
    if (own && own.name) { $('span', label).textContent = own.name; label.title = own.name; }
    else label.title = '';

    $('[data-act="clear"]', card).hidden = !own;
    $('[data-act="video-edit"]', card).hidden = !(own && own.type === 'video');
    $('input[data-act="color"]', card).value = own && own.type === 'color' ? own.color : '#1f2a44';
    refreshCardOpts(card, sc, i);
  });
}

const pct = (v) => Math.round((+v || 0) * 100) + '%';

/* 장면 카드의 '화면 · 시간' 값과 보이기/숨기기, 요약 글 */
function refreshCardOpts(card, sc, i) {
  const own = sc.media;
  const real = own && own.type !== 'color';
  const eff = effectiveMedia(i);
  $('.opt-media', card).hidden = !real;
  $('.opt-video', card).hidden = !(real && own.type === 'video');
  const note = $('.opt-note', card);
  if (!own && eff.from >= 0 && eff.media.type !== 'color') {
    note.textContent = `화면 맞춤·움직임·어둡게·소리는 이 화면을 넣은 ${eff.from + 1}번 장면에서 바꿀 수 있어요.`;
    note.hidden = false;
  } else if (!real) {
    note.textContent = '이미지나 영상을 넣으면 맞춤·움직임·어둡게 설정이 나타나요.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  if (real) {
    $$('[data-act="fit"]', card).forEach((b) => b.classList.toggle('on', (own.fit || 'cover') === b.dataset.val));
    $('[data-opt="motion"]', card).value = own.motion || 'none';
    $('[data-opt="motionAmt"]', card).value = String(own.motionAmt || 1);
    $('[data-opt="motionAmt"]', card).hidden = !own.motion || own.motion === 'none';
    $('[data-opt="dim"]', card).value = own.dim || 0;
    $('[data-o="dim"]', card).textContent = pct(own.dim);
    $('[data-opt="volume"]', card).value = own.volume || 0;
    $('[data-o="volume"]', card).textContent = +own.volume ? pct(own.volume) : '끔';
  }
  $('[data-opt="silent"]', card).checked = !!sc.silent;
  const setNum = (el, v) => { if (el !== document.activeElement) el.value = v; }; // 입력 중인 칸은 건드리지 않음
  setNum($('[data-opt="silentDur"]', card), +sc.silentDur || 3);
  $('[data-opt="hideSub"]', card).checked = !!sc.hideSub;
  setNum($('[data-opt="hold"]', card), +sc.hold || 0);
  $('.opt-silent', card).hidden = !sc.silent;
  $('.opt-speech', card).hidden = !!sc.silent;
  $('.hide-label', card).textContent = sc.silent ? '자막(글) 숨기기' : '읽기는 하되 자막 숨기기';

  // 무엇으로 읽는지: TTS / 녹음 파일 / 나레이션 없음
  const vr = $('.voice-row', card);
  const vl = $('.vr-label', vr);
  vr.classList.toggle('has-file', !!sc.voice && !sc.silent);
  if (sc.silent) vl.textContent = '나레이션 없음 (화면만)';
  else if (sc.voice) {
    vl.innerHTML = '<b>녹음 파일</b> · <span class="vr-name"></span>';
    $('.vr-name', vl).textContent = `${sc.voice.name} · ${sc.voice.dur.toFixed(1)}초`;
    vl.title = sc.voice.name;
  } else vl.textContent = 'TTS로 읽기';
  const vf = $('[data-act="voice-file"]', vr);
  vf.hidden = !!sc.silent;
  vf.textContent = sc.voice ? '파일 바꾸기' : '녹음 파일 넣기';
  $('[data-act="voice-tts"]', vr).hidden = !sc.voice || !!sc.silent;
  $('.listen', card).title = sc.silent ? '이 장면 미리 보기' : '이 문장만 미리 듣기';

  const parts = [];
  if (real) {
    parts.push(own.fit === 'contain' ? '전체 보이기' : '가득 채우기');
    if (own.motion && own.motion !== 'none') parts.push(MOTIONS.find((x) => x[0] === own.motion)[1]);
    if (+own.dim) parts.push('어둡게 ' + pct(own.dim));
    if (own.type === 'video' && +own.volume) parts.push('소리 ' + pct(own.volume));
    if (own.type === 'video' && own.segs && own.segs.length) parts.push(`다듬음 ${segsDuration(own.segs).toFixed(1)}초`);
  }
  if (sc.silent) parts.push(`나레이션 없음 ${+sc.silentDur || 3}초`);
  else if (+sc.hold) parts.push(`끝에 +${+sc.hold}초`);
  if (sc.hideSub) parts.push('자막 숨김');
  if (sc.sfx && sc.sfx.length) parts.push(sc.sfx.length === 1 ? '효과음 ' + sfxName(sc.sfx[0].src) : `효과음 ${sc.sfx.length}개`);
  if (sc.layers && sc.layers.length) parts.push(`얹은 글자·이미지 ${sc.layers.length}개`);
  $('.opts-sum', card).textContent = parts.join(' · ');
}

function sfxOptions(selected) {
  const opt = (v, l) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`;
  let html = '<optgroup label="기본 효과음">' + SYNTH_SFX.map(([n, l]) => opt('syn:' + n, l)).join('') + '</optgroup>';
  if (state.sfxLib.length) {
    html += '<optgroup label="효과음 보관함">' + state.sfxLib.map((f) => opt('lib:' + f.id, escapeHtml(f.name))).join('') + '</optgroup>';
  }
  if (selected.startsWith('lib:') && !state.sfxLib.some((f) => 'lib:' + f.id === selected)) html += opt(selected, '(지운 효과음)');
  return html;
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 장면 카드의 효과음 줄들 */
function renderSfxRows(card, sc) {
  const list = $('.sfx-list', card);
  list.innerHTML = '';
  for (const s of sc.sfx || []) {
    const row = document.createElement('div');
    row.className = 'sfx-row';
    row.dataset.sid = s.id;
    row.innerHTML = `
      <div class="sfx-top">
        <select data-sfx="src" aria-label="효과음 고르기">${sfxOptions(s.src)}</select>
        <button type="button" class="ibtn" data-act="sfx-play" title="미리 듣기">${ICON.play}</button>
        <button type="button" class="ibtn danger" data-act="sfx-del" title="효과음 빼기">${ICON.trash}</button>
      </div>
      <div class="sfx-params">
        <label>음량<input type="range" min="0" max="1.5" step="0.05" data-sfx="vol"><output></output></label>
        <label>시작<input type="number" min="0" max="60" step="0.1" data-sfx="at">초 뒤</label>
        <label class="sfx-len">길이<input type="number" min="0.2" max="30" step="0.1" data-sfx="len">초</label>
      </div>`;
    $('[data-sfx="vol"]', row).value = s.vol === undefined ? 1 : s.vol;
    $('[data-sfx="at"]', row).value = +s.at || 0;
    list.append(row);
    refreshSfxRow(row, s);
  }
}
function refreshSfxRow(row, s) {
  $('output', row).textContent = pct(s.vol === undefined ? 1 : s.vol);
  const info = s.src.startsWith('syn:') && synthInfo(s.src.slice(4));
  const lenBox = $('.sfx-len', row);
  lenBox.hidden = !(info && info[2]);
  const lenInput = $('[data-sfx="len"]', lenBox);
  if (info && info[2] && lenInput !== document.activeElement) lenInput.value = +s.len || info[2];
}

/* 효과음 값을 바꿨을 때 */
function applySfxInput(sc, card, el) {
  const row = el.closest('.sfx-row');
  const s = (sc.sfx || []).find((x) => x.id === row.dataset.sid);
  if (!s) return;
  const key = el.dataset.sfx;
  if (key === 'src') {
    s.src = el.value;
    delete s.len; // 소리를 바꾸면 길이는 그 소리의 기본값으로
    previewSfx(s);
  } else {
    const v = parseFloat(el.value);
    if (key === 'vol') s.vol = Math.min(1.5, Math.max(0, v || 0));
    else if (key === 'at') { if (!(v >= 0)) return; s.at = Math.min(60, v); }
    else if (key === 'len') { if (!(v > 0)) return; s.len = Math.min(30, Math.max(0.2, v)); }
  }
  refreshSfxRow(row, s);
  refreshCardOpts(card, sc, sceneIndex(sc.id));
  renderTimeline();
  save();
}

/* 카드에서 '화면 · 시간' 값을 바꿨을 때 */
function applySceneOpt(sc, card, el) {
  const opt = el.dataset.opt;
  const m = sc.media;
  if (['motion', 'motionAmt', 'dim', 'volume'].includes(opt)) {
    if (!m || m.type === 'color') return;
    m[opt] = opt === 'motion' ? el.value : parseFloat(el.value) || 0;
  } else if (opt === 'silent' || opt === 'hideSub') {
    sc[opt] = el.checked;
  } else if (opt === 'silentDur') {
    const v = parseFloat(el.value);
    if (!(v > 0)) return; // 입력 중 빈 값은 무시
    sc.silentDur = Math.min(120, Math.max(0.5, v));
  } else if (opt === 'hold') {
    const v = parseFloat(el.value);
    sc.hold = Math.min(60, Math.max(0, v || 0));
  }
  refreshCardOpts(card, sc, sceneIndex(sc.id));
  updateCardDur(sc);
  renderTimeline();
  renderStage();
  save();
}

function updateCardDur(sc) {
  const card = $(`.scene[data-id="${sc.id}"]`);
  if (card) $('.dur', card).textContent = sceneDur(sc).toFixed(1) + '초';
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

function selectScene(id, { scroll = false } = {}) {
  if (!findScene(id)) return;
  state.selectedId = id;
  $$('.scene').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  $$('.tl-block').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  if (scroll) {
    const card = $(`.scene[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  renderStage();
  if (!P.playing) updateClock();
  save();
}

function structureChanged() {
  renderScenes();
  renderTimeline();
  renderStage();
  save();
}

function insertScene(at, text = '') {
  stopPlayback();
  const sc = newScene(text);
  state.scenes.splice(at, 0, sc);
  state.selectedId = sc.id;
  structureChanged();
  const ta = $(`.scene[data-id="${sc.id}"] .scene-text`);
  if (ta) { ta.scrollIntoView({ block: 'nearest' }); ta.focus(); }
}

let undo = null;
let undoTimer = null;
function deleteScene(id) {
  stopPlayback();
  const i = sceneIndex(id);
  if (i < 0) return;
  const [sc] = state.scenes.splice(i, 1);
  dropUndo();
  undo = { scene: sc, index: i };
  if (state.selectedId === id) {
    const next = state.scenes[Math.min(i, state.scenes.length - 1)];
    state.selectedId = next ? next.id : null;
  }
  structureChanged();
  toast(`${i + 1}번 장면을 삭제했어요.`, { label: '되돌리기', fn: restoreUndo }, 6000);
  undoTimer = setTimeout(dropUndo, 6000);
}
function restoreUndo() {
  if (!undo) return;
  clearTimeout(undoTimer);
  const { scene, index } = undo;
  undo = null;
  state.scenes.splice(Math.min(index, state.scenes.length), 0, scene);
  state.selectedId = scene.id;
  structureChanged();
  hideToast();
}
function dropUndo() {
  clearTimeout(undoTimer);
  if (!undo) return;
  const m = undo.scene.media;
  undo = null;
  releaseMedia(m);
}

function moveScene(id, to) {
  stopPlayback();
  const from = sceneIndex(id);
  if (from < 0 || to < 0 || to >= state.scenes.length || from === to) return;
  const [sc] = state.scenes.splice(from, 1);
  state.scenes.splice(to, 0, sc);
  structureChanged();
}

function applyScript() {
  const sentences = splitSentences(state.script);
  if (!sentences.length) { toast('대본이 비어 있어요.'); return; }
  const old = state.scenes;
  if (old.length) {
    const ok = confirm(
      `지금 있는 장면 ${old.length}개를 대본의 문장 ${sentences.length}개로 바꿀까요?\n` +
      '장면에 넣어 둔 화면과 효과음은 순서대로(1번→1번, 2번→2번…) 그대로 남습니다.'
    );
    if (!ok) return;
  }
  stopPlayback();
  dropUndo();
  state.scenes = sentences.map((t, i) => {
    const sc = newScene(t, old[i] ? old[i].media : null);
    if (old[i] && old[i].sfx) sc.sfx = old[i].sfx;
    if (old[i] && old[i].layers) sc.layers = old[i].layers;
    if (old[i] && old[i].voice) sc.voice = old[i].voice;
    return sc;
  });
  state.selectedId = state.scenes[0].id;
  for (const sc of old.slice(sentences.length)) releaseMedia(sc.media);
  structureChanged();
  toast(`문장 ${sentences.length}개를 장면으로 만들었어요.`);
}

/* ---------------- 글꼴 고르기 · 글꼴 보관함 ---------------- */

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const fontFaces = new Map(); // id → FontFace
const fontErrors = new Set();
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');

function renderFontPicker() {
  const box = $('#fontPicker');
  box.innerHTML = '';
  const groups = [];
  if (state.fonts.length) groups.push(['내 글꼴', state.fonts.map((f) => ({ name: f.name, css: userFontCss(f) }))]);
  for (const [g, list] of FONT_GROUPS) groups.push([g, list.map(([name, fam, fb]) => ({ name, css: fontCss(fam, fb) }))]);

  let current = null;
  for (const [g, list] of groups) {
    const h = document.createElement('div');
    h.className = 'fp-group';
    h.textContent = g;
    box.append(h);
    for (const f of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'font-item';
      b.dataset.css = f.css;
      b.setAttribute('role', 'option');
      const sample = document.createElement('span');
      sample.className = 'fi-sample';
      sample.style.fontFamily = f.css;
      sample.textContent = FONT_SAMPLE;
      const name = document.createElement('span');
      name.className = 'fi-name';
      name.textContent = f.name;
      b.append(sample, name);
      if (f.css === state.sub.font) {
        b.classList.add('on');
        b.setAttribute('aria-selected', 'true');
        current = { f, b };
      }
      box.append(b);
    }
  }
  $('#fontCurrent').textContent = current ? current.f.name : '';
  if (current) box.scrollTop = Math.max(0, current.b.offsetTop - box.clientHeight / 2 + 20);
  renderLayerFontSelect();
}

function chooseFont(css) {
  state.sub.font = css;
  $$('.font-item').forEach((b) => {
    const on = b.dataset.css === css;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) $('#fontCurrent').textContent = $('.fi-name', b).textContent;
  });
  applySubStyle();
  save();
}

function renderFontLib() {
  const lib = $('#fontLib');
  lib.innerHTML = '';
  if (!state.fonts.length) {
    lib.innerHTML = '<div class="empty">가지고 있는 글꼴 파일(ttf · otf · woff · woff2)을<br>여기에 끌어다 놓거나 <b>+ 글꼴 파일 추가</b>를 누르세요.</div>';
    return;
  }
  for (const f of state.fonts) {
    const row = document.createElement('div');
    row.className = 'lib-item';
    row.dataset.id = f.id;
    const input = document.createElement('input');
    input.value = f.name;
    input.maxLength = 40;
    input.spellcheck = false;
    input.style.fontFamily = userFontCss(f);
    input.setAttribute('aria-label', '글꼴 이름');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ibtn danger';
    del.dataset.act = 'del-font';
    del.title = '보관함에서 삭제';
    del.innerHTML = ICON.trash;
    const meta = document.createElement('div');
    const bad = fontErrors.has(f.id);
    meta.className = 'lib-meta' + (bad ? ' err' : '');
    meta.textContent = bad ? `${f.fileName} · 글꼴을 불러오지 못했어요` : `${f.fileName} · ${fmtSize(f.size)}`;
    row.append(input, del, meta);
    lib.append(row);
  }
  const note = document.createElement('div');
  note.className = 'lib-drop-note';
  note.textContent = '파일을 끌어다 놓아도 추가돼요 · 이름을 눌러 바꿀 수 있어요';
  lib.append(note);
}

async function registerFont(f, blob) {
  const face = new FontFace(f.family, await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  fontFaces.set(f.id, face);
}

async function loadUserFonts() {
  for (const f of state.fonts) {
    try {
      const blob = await fontGet(f.id);
      if (!blob) throw new Error('font file missing');
      await registerFont(f, blob);
      fontErrors.delete(f.id);
    } catch (e) {
      console.error(e);
      fontErrors.add(f.id);
    }
  }
  if (fontErrors.size) renderFontLib();
}

async function addFontFiles(files) {
  const list = [...files].filter((f) => FONT_EXT.test(f.name));
  if (!list.length) { toast('ttf · otf · woff · woff2 글꼴 파일만 넣을 수 있어요.'); return; }
  toast('글꼴 불러오는 중…', null, 0);
  let last = null, ok = 0, failed = 0;
  for (const file of list) {
    const id = 'f_' + uid();
    const f = { id, family: 'UserFont-' + id, name: file.name.replace(FONT_EXT, ''), fileName: file.name, size: file.size };
    try {
      await registerFont(f, file);
    } catch (e) {
      console.error(e);
      failed++;
      continue;
    }
    try {
      await fontPut(id, new Blob([file], { type: file.type || 'font/' + file.name.split('.').pop().toLowerCase() }));
    } catch (e) {
      console.error(e);
      document.fonts.delete(fontFaces.get(id));
      fontFaces.delete(id);
      failed++;
      continue;
    }
    state.fonts.push(f);
    last = f;
    ok++;
  }
  if (last) {
    state.sub.font = userFontCss(last);
    applySubStyle();
  }
  renderFontPicker();
  renderFontLib();
  save();
  if (ok === 1 && !failed) toast(`‘${last.name}’ 글꼴을 보관함에 넣고 자막에 적용했어요.`);
  else if (ok) toast(`글꼴 ${ok}개를 보관함에 넣었어요.${failed ? ` ${failed}개는 읽지 못했어요.` : ''}`);
  else toast('글꼴 파일을 읽지 못했어요. 손상됐거나 지원하지 않는 형식일 수 있어요.');
}

function deleteFont(id) {
  const f = state.fonts.find((x) => x.id === id);
  if (!f) return;
  if (!confirm(`‘${f.name}’ 글꼴을 보관함에서 지울까요?`)) return;
  const wasUsed = state.sub.font === userFontCss(f);
  state.fonts = state.fonts.filter((x) => x.id !== id);
  const face = fontFaces.get(id);
  if (face) document.fonts.delete(face);
  fontFaces.delete(id);
  fontErrors.delete(id);
  fontDel(id).catch(console.error);
  if (wasUsed) {
    state.sub.font = DEFAULT_FONT;
    applySubStyle();
    toast('지운 글꼴을 쓰고 있어서 자막을 본고딕으로 바꿨어요.');
  }
  renderFontPicker();
  renderFontLib();
  save();
}

/* ---------------- 장면 꾸미기: 화면 위에 글자 · 이미지 얹기 ----------------
   레이어 위치(x, y)는 미리보기 기준 %(가운데 점), 너비(w)는 미리보기 너비의 %.
   글자 크기는 화면 짧은 변의 %(cqmin), 외곽선·상자 여백·그림자는 글자 크기(em) 기준이라 크기를 바꿔도 비율이 유지됨.
   글자 내용은 색 조각(runs) 목록: [{ t: '글자', c: '#색' | null(기본 글자색) }] */

const TEXT_STYLE_KEYS = [
  'font', 'size', 'weight', 'align', 'color', 'stroke', 'strokeW', 'letterSp', 'lineH', 'opacity',
  'box', 'boxColor', 'boxOpacity', 'boxPad', 'boxRadius',
  'shadow', 'shadowColor', 'shadowOpacity', 'shadowBlur', 'shadowDist',
];
const TEXT_DEFAULT = {
  font: DEFAULT_FONT, size: 9, weight: '900', align: 'center', color: '#ffffff',
  stroke: '#000000', strokeW: 0.6, letterSp: 0, lineH: 1.2, opacity: 1,
  box: false, boxColor: '#ff4f6d', boxOpacity: 1, boxPad: 0.3, boxRadius: 0.25,
  shadow: true, shadowColor: '#000000', shadowOpacity: 0.5, shadowBlur: 0.25, shadowDist: 0.08,
};
const IMAGE_DEFAULT = {
  opacity: 1, radius: 0,
  shadow: false, shadowColor: '#000000', shadowOpacity: 0.5, shadowBlur: 0.25, shadowDist: 0.08,
};
const HANDLES = ['nw', 'ne', 'sw', 'se'].map((p) => `<i class="h h-${p}" data-h="scale"></i>`).join('')
  + '<i class="h h-e" data-h="w"></i><i class="h h-w" data-h="w"></i><i class="h h-rot" data-h="rot"></i>';

let selLayer = null;          // { sceneId, id }
let editingId = null;         // 글자를 편집 중인 레이어
let editSel = null;           // 편집 중 드래그로 고른 범위 { s, e }
let lastDeletedLayer = null;  // 되돌리기용

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : null);
const runsText = (runs) => (runs || []).map((r) => r.t).join('');
const layerScene = () => state.scenes[P.playing && P.index >= 0 ? P.index : selectedIndex()] || null;
const layerEl = (L) => (L ? $(`#layers .layer[data-lid="${L.id}"]`) : null);
function findLayer(id) {
  for (const sc of state.scenes) {
    const L = (sc.layers || []).find((l) => l.id === id);
    if (L) return { sc, L };
  }
  return null;
}
function selectedLayer() {
  if (!selLayer) return null;
  const sc = findScene(selLayer.sceneId);
  return (sc && (sc.layers || []).find((l) => l.id === selLayer.id)) || null;
}

/* --- 색 조각(runs) --- */
function normRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && last.c === r.c) last.t += r.t;
    else out.push({ t: r.t, c: r.c || null });
  }
  return out;
}
function runsToHtml(runs) {
  return (runs || []).map((r) => {
    const t = escapeHtml(r.t);
    const c = safeColor(r.c);
    return c ? `<span data-c="${c}" style="color:${c}">${t}</span>` : t;
  }).join('');
}
function cssColorToHex(s) {
  if (!s) return null;
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + m.slice(1, 4).map((n) => (+n).toString(16).padStart(2, '0')).join('');
  return safeColor(s);
}
function domToRuns(root) {
  const runs = [];
  const walk = (node, c) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) runs.push({ t: ch.data, c });
      else if (ch.nodeName === 'BR') runs.push({ t: '\n', c });
      else if (ch.nodeType === 1) {
        if (/^(DIV|P)$/.test(ch.nodeName) && runs.length) runs.push({ t: '\n', c });
        walk(ch, (ch.dataset && safeColor(ch.dataset.c)) || cssColorToHex(ch.style && ch.style.color) || c);
      }
    }
  };
  walk(root, null);
  return normRuns(runs);
}
/* s~e 글자 범위의 색을 c로(null이면 기본 글자색으로 되돌림) */
function runsSetColor(runs, s, e, c) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const a = pos, b = pos + r.t.length;
    pos = b;
    if (b <= s || a >= e) { out.push(r); continue; }
    if (a < s) out.push({ t: r.t.slice(0, s - a), c: r.c });
    out.push({ t: r.t.slice(Math.max(s, a) - a, Math.min(e, b) - a), c });
    if (b > e) out.push({ t: r.t.slice(e - a), c: r.c });
  }
  return normRuns(out);
}
/* 편집 중인 글자에서 선택 범위를 글자 위치(0부터)로 */
function selOffsets(root) {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  const off = (node, o) => {
    const rr = document.createRange();
    rr.setStart(root, 0);
    rr.setEnd(node, o);
    return rr.toString().length;
  };
  return { s: off(r.startContainer, r.startOffset), e: off(r.endContainer, r.endOffset) };
}
function setSelOffsets(root, s, e) {
  const find = (target) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0, n;
    while ((n = w.nextNode())) {
      if (pos + n.data.length >= target) return [n, target - pos];
      pos += n.data.length;
    }
    return [root, root.childNodes.length];
  };
  const [a, ao] = find(s);
  const [b, bo] = find(e);
  const r = document.createRange();
  r.setStart(a, ao);
  r.setEnd(b, bo);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* --- 그리기 --- */

/* 글자 꾸밈을 CSS로 (미리보기 레이어와 저장한 스타일 견본이 함께 씀) */
function textCss(s) {
  return {
    fontFamily: s.font,
    fontWeight: s.weight,
    textAlign: s.align,
    color: s.color,
    letterSpacing: (+s.letterSp || 0) + 'em',
    lineHeight: s.lineH,
    webkitTextStroke: `${((+s.strokeW || 0) * 0.2).toFixed(3)}em ${s.stroke}`,
    background: s.box ? hexToRgba(s.boxColor, s.boxOpacity) : 'transparent',
    padding: s.box ? `${s.boxPad}em ${s.boxPad * 1.5}em` : '0',
    borderRadius: (+s.boxRadius || 0) + 'em',
    filter: s.shadow
      ? `drop-shadow(${s.shadowDist * 0.5}em ${s.shadowDist}em ${s.shadowBlur}em ${hexToRgba(s.shadowColor, s.shadowOpacity)})`
      : 'none',
  };
}

function applyLayerStyle(el, L) {
  el.style.left = L.x + '%';
  el.style.top = L.y + '%';
  el.style.transform = `translate(-50%, -50%) rotate(${L.rot || 0}deg)`;
  el.style.opacity = L.opacity === undefined ? 1 : L.opacity;
  const box = $('.layer-box', el);
  if (L.type === 'image') {
    el.style.width = L.w + '%';
    box.style.borderRadius = (+L.radius || 0) + 'cqmin';
    box.style.filter = L.shadow
      ? `drop-shadow(${L.shadowDist * 4}cqmin ${L.shadowDist * 8}cqmin ${L.shadowBlur * 8}cqmin ${hexToRgba(L.shadowColor, L.shadowOpacity)})`
      : 'none';
    return;
  }
  el.style.width = L.w ? L.w + '%' : 'max-content'; // 너비를 정하지 않았으면 글자에 맞춰 늘어남
  el.style.maxWidth = L.w ? '' : '94%';
  Object.assign(box.style, textCss(L), { fontSize: `calc(${L.size} * 1cqmin)` });
}

function createLayerEl(L) {
  const el = document.createElement('div');
  el.className = 'layer layer-' + L.type;
  el.dataset.lid = L.id;
  el.dataset.type = L.type;
  el.innerHTML = `<div class="layer-box">${L.type === 'text' ? '<span class="layer-text"></span>' : '<img alt="" draggable="false">'}</div>${HANDLES}`;
  if (L.type === 'image') mediaURL(L.mediaId).then((u) => { if (u) $('img', el).src = u; });
  return el;
}

function renderLayers() {
  const box = $('#layers');
  if (!box) return;
  const sc = layerScene();
  if (selLayer && (!sc || selLayer.sceneId !== sc.id) && !P.playing) deselectLayer();
  const layers = (sc && sc.layers) || [];
  const old = new Map([...box.children].map((el) => [el.dataset.lid, el]));
  layers.forEach((L, k) => {
    let el = old.get(L.id);
    if (!el) el = createLayerEl(L);
    old.delete(L.id);
    if (box.children[k] !== el) box.insertBefore(el, box.children[k] || null); // 순서가 다를 때만 옮김(편집 중 포커스 유지)
    applyLayerStyle(el, L);
    if (L.type === 'text' && editingId !== L.id) $('.layer-text', el).innerHTML = runsToHtml(L.runs);
    el.classList.toggle('sel', !!selLayer && selLayer.id === L.id);
  });
  for (const el of old.values()) el.remove();
  if (state.ui.leftTab === 'deco' && !P.playing) refreshLayerList();
}

/* --- 고르기 · 편집 --- */

function selectLayer(sc, L) {
  if (editingId && editingId !== L.id) endEdit();
  selLayer = { sceneId: sc.id, id: L.id };
  $$('#layers .layer').forEach((el) => el.classList.toggle('sel', el.dataset.lid === L.id));
  if (state.ui.leftTab !== 'deco') setTab('deco');
  renderInspector();
}
function deselectLayer() {
  if (editingId) endEdit();
  if (!selLayer) return;
  selLayer = null;
  $$('#layers .layer.sel').forEach((el) => el.classList.remove('sel'));
  renderInspector();
}

function startEdit(L) {
  if (!L || L.type !== 'text' || P.playing) return;
  const el = layerEl(L);
  if (!el) return;
  editingId = L.id;
  editSel = null;
  el.classList.add('editing');
  const t = $('.layer-text', el);
  t.contentEditable = 'true';
  t.spellcheck = false;
  t.focus();
  setSelOffsets(t, 0, runsText(L.runs).length); // 처음엔 전체 선택
}
function endEdit() {
  if (!editingId) return;
  const found = findLayer(editingId);
  editingId = null;
  editSel = null;
  if (!found) return;
  const { L } = found;
  const el = layerEl(L);
  if (el) {
    const t = $('.layer-text', el);
    L.runs = domToRuns(t);
    t.contentEditable = 'false';
    el.classList.remove('editing');
    getSelection().removeAllRanges();
  }
  if (!runsText(L.runs).trim()) { deleteLayer(L, true); return; } // 빈 글자는 지움
  if (el) $('.layer-text', el).innerHTML = runsToHtml(L.runs);
  refreshLayerList();
  refreshCardMedia();
  save();
}

/* 편집 중에 고른 부분 칠하기(c가 null이면 기본 글자색으로) */
function applyPaint(c, quiet = false) {
  const L = selectedLayer();
  if (!L || L.type !== 'text' || editingId !== L.id || !editSel || editSel.e <= editSel.s) {
    if (!quiet) toast('미리보기에서 글자를 두 번 눌러 편집한 뒤, 칠할 부분을 드래그로 골라 주세요.');
    return;
  }
  const t = $('.layer-text', layerEl(L));
  const { s, e } = editSel;
  L.runs = runsSetColor(domToRuns(t), s, e, c);
  t.innerHTML = runsToHtml(L.runs);
  if (document.activeElement === t) setSelOffsets(t, s, e);
  save();
}

/* --- 추가 · 복제 · 순서 · 삭제 --- */

function layersChanged() {
  renderLayers();
  refreshLayerList();
  refreshCardMedia();
  save();
}

function addTextLayer() {
  const sc = state.scenes[selectedIndex()];
  if (!sc) { toast('먼저 장면을 만들어 주세요.'); return; }
  stopPlayback();
  sc.layers = sc.layers || [];
  const L = Object.assign({ id: 'l_' + uid(), type: 'text', x: 50, y: 24, w: null, rot: 0, runs: [{ t: '글자를 입력하세요', c: null }] }, clone(TEXT_DEFAULT));
  sc.layers.push(L);
  layersChanged();
  selectLayer(sc, L);
  requestAnimationFrame(() => startEdit(L));
}

async function addImageLayer(file, at = null) {
  if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 얹을 수 있어요.'); return; }
  const sc = state.scenes[selectedIndex()];
  if (!sc) { toast('먼저 장면을 만들어 주세요.'); return; }
  stopPlayback();
  const id = 'm_' + uid();
  try {
    await mediaPut(id, new Blob([file], { type: file.type }));
  } catch (e) {
    console.error(e);
    toast('이미지를 저장하지 못했어요. 브라우저 저장 공간이 부족할 수 있어요.');
    return;
  }
  urlCache.set(id, URL.createObjectURL(file));
  sc.layers = sc.layers || [];
  const L = Object.assign({
    id: 'l_' + uid(), type: 'image', mediaId: id, name: file.name || '이미지',
    x: at ? clamp(at.x, 0, 100) : 50, y: at ? clamp(at.y, 0, 100) : 50, w: 40, rot: 0,
  }, clone(IMAGE_DEFAULT));
  sc.layers.push(L);
  layersChanged();
  selectLayer(sc, L);
  toast(`${sceneIndex(sc.id) + 1}번 장면 화면 위에 이미지를 얹었어요.`);
}

async function replaceLayerImage(L, file) {
  if (!file || !/^image\//.test(file.type)) { toast('이미지 파일만 넣을 수 있어요.'); return; }
  const id = 'm_' + uid();
  try { await mediaPut(id, new Blob([file], { type: file.type })); } catch (e) { toast('이미지를 저장하지 못했어요.'); return; }
  urlCache.set(id, URL.createObjectURL(file));
  const oldId = L.mediaId;
  L.mediaId = id;
  L.name = file.name || '이미지';
  const el = layerEl(L);
  if (el) $('img', el).src = urlCache.get(id);
  releaseMedia({ mediaId: oldId });
  layersChanged();
  renderInspector();
}

function duplicateLayer(L) {
  const sc = findScene(selLayer.sceneId);
  const copy = Object.assign(clone(L), { id: 'l_' + uid(), x: L.x + 3, y: L.y + 3 });
  sc.layers.splice(sc.layers.indexOf(L) + 1, 0, copy);
  layersChanged();
  selectLayer(sc, copy);
}

function reorderLayer(L, toFront) {
  const sc = findScene(selLayer.sceneId);
  sc.layers.splice(sc.layers.indexOf(L), 1);
  if (toFront) sc.layers.push(L); else sc.layers.unshift(L);
  layersChanged();
}

function deleteLayer(L, silent = false) {
  const found = findLayer(L.id);
  if (!found) return;
  const { sc } = found;
  const idx = sc.layers.indexOf(L);
  sc.layers.splice(idx, 1);
  if (editingId === L.id) { editingId = null; editSel = null; }
  if (selLayer && selLayer.id === L.id) selLayer = null;
  const prev = lastDeletedLayer;
  lastDeletedLayer = silent ? null : { sceneId: sc.id, L, idx };
  if (prev && prev.L.mediaId) releaseMedia({ mediaId: prev.L.mediaId });
  if (silent && L.mediaId) releaseMedia({ mediaId: L.mediaId });
  layersChanged();
  renderInspector();
  if (!silent) toast(L.type === 'text' ? '글자를 지웠어요.' : '이미지를 지웠어요.', { label: '되돌리기', fn: restoreLayer }, 6000);
}
function restoreLayer() {
  const d = lastDeletedLayer;
  if (!d) return;
  const sc = findScene(d.sceneId);
  if (!sc) return;
  lastDeletedLayer = null;
  sc.layers = sc.layers || [];
  sc.layers.splice(Math.min(d.idx, sc.layers.length), 0, d.L);
  if (state.scenes[selectedIndex()] !== sc) selectScene(sc.id, { scroll: true });
  layersChanged();
  selectLayer(sc, d.L);
  hideToast();
}

/* --- 왼쪽 '글자 · 이미지 꾸미기' 탭 --- */

function setTab(name) {
  state.ui.leftTab = name;
  $$('.tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'deco') renderInspector();
  save();
}

function renderLayerFontSelect() {
  const groups = [];
  if (state.fonts.length) groups.push(['내 글꼴', state.fonts.map((f) => [f.name, userFontCss(f)])]);
  for (const [g, list] of FONT_GROUPS) groups.push([g, list.map(([name, fam, fb]) => [name, fontCss(fam, fb)])]);
  const html = groups.map(([g, list]) =>
    `<optgroup label="${escapeHtml(g)}">${list.map(([n, css]) => `<option value="${escapeHtml(css)}">${escapeHtml(n)}</option>`).join('')}</optgroup>`).join('');
  for (const sel of $$('.layer-font')) {
    const v = sel.value;
    sel.innerHTML = html;
    sel.value = v;
  }
  const L = selectedLayer();
  if (L && L.type === 'text') syncInspector();
}

function refreshLayerList() {
  const box = $('#layerList');
  if (!box) return;
  const sc = state.scenes[selectedIndex()];
  $('#decoScene').textContent = sc ? `${selectedIndex() + 1}번 장면` : '장면 없음';
  const layers = (sc && sc.layers) || [];
  box.innerHTML = '';
  if (!layers.length) {
    box.innerHTML = '<div class="empty small">이 장면에는 얹은 글자·이미지가 없어요.</div>';
    return;
  }
  for (const L of [...layers].reverse()) { // 위에 보이는 것부터
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'layer-item' + (selLayer && selLayer.id === L.id ? ' on' : '');
    b.dataset.lid = L.id;
    b.innerHTML = `<span class="li-ico">${L.type === 'text' ? 'T' : ICON.image}</span><span class="li-name"></span>`;
    $('.li-name', b).textContent = L.type === 'text'
      ? (runsText(L.runs).replace(/\s+/g, ' ').trim() || '(빈 글자)')
      : (L.name || '이미지');
    box.append(b);
  }
}

const LFMT = {
  size: (v) => (+v).toFixed(1), rot: (v) => Math.round(v) + '°', opacity: pct,
  letterSp: (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%', lineH: (v) => (+v).toFixed(2),
  boxOpacity: pct, boxPad: (v) => (+v).toFixed(2), boxRadius: (v) => (+v).toFixed(2),
  shadowOpacity: pct, shadowBlur: (v) => (+v).toFixed(2), shadowDist: (v) => (+v).toFixed(2),
  radius: (v) => (+v).toFixed(1),
};

function renderInspector() {
  if (!$('#inspText')) return;
  refreshLayerList();
  const L = selectedLayer();
  $('#inspText').hidden = !(L && L.type === 'text');
  $('#inspImage').hidden = !(L && L.type === 'image');
  $('#inspEmpty').hidden = !!L;
  if (L) syncInspector();
  renderStyleList();
}

function syncInspector() {
  const L = selectedLayer();
  if (!L) return;
  const pane = L.type === 'text' ? $('#inspText') : $('#inspImage');
  for (const el of $$('[data-ls]', pane)) {
    const k = el.dataset.ls;
    const v = L[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el !== document.activeElement || el.type === 'range') el.value = v == null ? '' : v;
    const out = $(`[data-lo="${k}"]`, pane);
    if (out) out.textContent = LFMT[k] ? LFMT[k](v || 0) : v;
  }
  $$('[data-align]', pane).forEach((b) => b.classList.toggle('on', b.dataset.align === L.align));
  const box = $('.box-opts', pane);
  if (box) box.hidden = !L.box;
  $('.shadow-opts', pane).hidden = !L.shadow;
}

/* --- 저장한 스타일 --- */

function renderStyleList() {
  const box = $('#styleList');
  box.innerHTML = '';
  if (!state.layerStyles.length) {
    box.innerHTML = '<div class="empty small">아직 저장한 스타일이 없어요.<br>글자를 꾸민 뒤 아래 <b>스타일 저장</b>에서 이름을 붙여 저장하세요.</div>';
    return;
  }
  const L = selectedLayer();
  const canApply = !!(L && L.type === 'text');
  for (const st of state.layerStyles) {
    const item = document.createElement('div');
    item.className = 'style-item';
    item.dataset.sid = st.id;
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'style-apply';
    apply.dataset.act = 'style-apply';
    apply.disabled = !canApply;
    apply.title = canApply ? '선택한 글자에 이 스타일 적용' : '미리보기에서 글자를 고르면 적용할 수 있어요';
    const sample = document.createElement('span');
    sample.className = 'style-sample';
    sample.textContent = '가나다';
    Object.assign(sample.style, textCss(st.style));
    const name = document.createElement('span');
    name.className = 'style-name';
    name.textContent = st.name;
    apply.append(sample, name);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ibtn danger';
    del.dataset.act = 'style-del';
    del.title = '스타일 지우기';
    del.innerHTML = ICON.trash;
    item.append(apply, del);
    box.append(item);
  }
}

function saveLayerStyle() {
  const L = selectedLayer();
  if (!L || L.type !== 'text') return;
  const input = $('#styleName');
  const name = input.value.trim() || `스타일 ${state.layerStyles.length + 1}`;
  const style = {};
  for (const k of TEXT_STYLE_KEYS) style[k] = L[k];
  const same = state.layerStyles.find((s) => s.name === name);
  if (same) {
    if (!confirm(`‘${name}’ 스타일이 이미 있어요. 지금 꾸민 모양으로 바꿀까요?`)) return;
    same.style = style;
  } else {
    state.layerStyles.push({ id: 'st_' + uid(), name, style });
  }
  input.value = '';
  renderStyleList();
  save();
  toast(`‘${name}’ 스타일을 저장했어요. 다른 장면의 글자에서도 불러올 수 있어요.`);
}
function applyLayerStyleById(id) {
  const st = state.layerStyles.find((s) => s.id === id);
  const L = selectedLayer();
  if (!st || !L || L.type !== 'text') return;
  Object.assign(L, clone(st.style));
  applyLayerStyle(layerEl(L), L);
  syncInspector();
  save();
  toast(`‘${st.name}’ 스타일을 적용했어요.`);
}
function deleteLayerStyle(id) {
  const st = state.layerStyles.find((s) => s.id === id);
  if (!st || !confirm(`‘${st.name}’ 스타일을 지울까요? (이미 적용한 글자는 그대로예요)`)) return;
  state.layerStyles = state.layerStyles.filter((s) => s.id !== id);
  renderStyleList();
  save();
}

/* --- 이벤트 --- */

function bindDeco() {
  const stage = $('#stage');
  const layersBox = $('#layers');
  const guideV = $('#guideV'), guideH = $('#guideH');
  let drag = null;

  // 끌어서 옮기기 · 모서리로 크기 · 위쪽 점으로 회전 · 옆 점으로 글상자 너비
  layersBox.addEventListener('pointerdown', (e) => {
    if (P.playing || e.button !== 0) return;
    const el = e.target.closest('.layer');
    const sc = layerScene();
    const L = el && sc && (sc.layers || []).find((l) => l.id === el.dataset.lid);
    if (!L) return;
    if (editingId === L.id && !e.target.dataset.h) return; // 글자 편집 중엔 글자 고르기가 우선
    e.preventDefault();
    const active = document.activeElement;
    if (active && active !== document.body && !layersBox.contains(active)) active.blur(); // Delete·화살표가 레이어에 먹히게
    selectLayer(sc, L);
    const r = stage.getBoundingClientRect();
    drag = {
      L, el, mode: e.target.dataset.h || 'move', r, moved: false,
      px: e.clientX, py: e.clientY, start: clone(L),
      cx: r.left + (L.x / 100) * r.width, cy: r.top + (L.y / 100) * r.height,
    };
    el.setPointerCapture(e.pointerId);
  });
  layersBox.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { L, r, start } = drag;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    if (drag.mode === 'move') {
      let x = start.x + (dx / r.width) * 100;
      let y = start.y + (dy / r.height) * 100;
      const snapX = Math.abs(x - 50) < 1.5, snapY = Math.abs(y - 50) < 1.5; // 가운데에 착 붙기
      if (snapX) x = 50;
      if (snapY) y = 50;
      L.x = +clamp(x, -30, 130).toFixed(2);
      L.y = +clamp(y, -30, 130).toFixed(2);
      guideV.hidden = !snapX;
      guideH.hidden = !snapY;
    } else if (drag.mode === 'scale') {
      const d0 = Math.hypot(drag.px - drag.cx, drag.py - drag.cy) || 1;
      const f = Math.max(0.05, Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) / d0);
      if (L.type === 'text') {
        L.size = +clamp(start.size * f, 1, 80).toFixed(2);
        if (start.w) L.w = +clamp(start.w * f, 5, 200).toFixed(2);
      } else {
        L.w = +clamp(start.w * f, 3, 300).toFixed(2);
      }
    } else if (drag.mode === 'rot') {
      let a = (Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180) / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      const near = Math.round(a / 45) * 45;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      else if (Math.abs(a - near) < 3) a = near; // 0°·45°·90° 근처에선 착 붙기
      L.rot = Math.round(a);
    } else if (drag.mode === 'w') {
      const rad = ((start.rot || 0) * Math.PI) / 180;
      const half = Math.abs((e.clientX - drag.cx) * Math.cos(rad) + (e.clientY - drag.cy) * Math.sin(rad));
      L.w = +clamp(((2 * half) / r.width) * 100, 5, 200).toFixed(2);
    }
    applyLayerStyle(drag.el, L);
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    guideV.hidden = guideH.hidden = true;
    if (moved) { syncInspector(); save(); }
  };
  layersBox.addEventListener('pointerup', endDrag);
  layersBox.addEventListener('pointercancel', endDrag);

  layersBox.addEventListener('dblclick', (e) => {
    // 포인터 캡처 때문에 대상이 글자 안쪽이 아닌 레이어 자체로 올 수 있음
    const el = e.target.closest('.layer');
    if (!el || P.playing || e.target.dataset.h) return;
    const found = findLayer(el.dataset.lid);
    if (found && found.L.type === 'text' && editingId !== found.L.id) startEdit(found.L);
  });

  // 빈 곳을 누르면 고르기 해제
  stage.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.layer')) deselectLayer();
  });
  // 편집 중에 꾸미기 탭 밖을 누르면 편집 끝
  document.addEventListener('pointerdown', (e) => {
    if (!editingId) return;
    const el = layerEl(findLayer(editingId) && findLayer(editingId).L);
    if (el && el.contains(e.target)) return;
    if (e.target.closest('.paint-tools') || e.target.closest('#inspText')) return;
    endEdit();
  }, true);

  // 글자 편집
  layersBox.addEventListener('input', (e) => {
    const t = e.target.closest('.layer-text');
    if (!t || !editingId) return;
    const found = findLayer(editingId);
    if (!found) return;
    found.L.runs = domToRuns(t);
    refreshLayerList();
    save();
  });
  layersBox.addEventListener('keydown', (e) => {
    if (!e.target.closest('.layer-text')) return;
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
    else if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
  });
  layersBox.addEventListener('paste', (e) => {
    if (!e.target.closest('.layer-text')) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    document.execCommand('insertText', false, text); // 서식 없이 글자만
  });
  layersBox.addEventListener('focusout', (e) => {
    if (!e.target.closest('.layer-text') || !editingId) return;
    const to = e.relatedTarget;
    if (to && !to.closest('.paint-tools') && !to.closest('#layers')) endEdit();
  });
  document.addEventListener('selectionchange', () => {
    if (!editingId) return;
    const found = findLayer(editingId);
    const el = found && layerEl(found.L);
    if (!el) return;
    const o = selOffsets($('.layer-text', el));
    if (!o) return; // 다른 곳(색 고르기 등)으로 포커스가 가도 마지막 범위는 기억
    editSel = o.e > o.s ? o : null;
  });

  // 탭
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // 버튼들
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-deco]');
    if (!b) return;
    const L = selectedLayer();
    switch (b.dataset.deco) {
      case 'add-text': addTextLayer(); break;
      case 'add-image': {
        const fi = $('#layerFileInput');
        fi.dataset.mode = 'add';
        fi.value = '';
        fi.click();
        break;
      }
      case 'replace': {
        const fi = $('#layerFileInput');
        fi.dataset.mode = 'replace';
        fi.value = '';
        fi.click();
        break;
      }
      case 'edit': if (L) startEdit(L); break;
      case 'dup': if (L) duplicateLayer(L); break;
      case 'front': if (L) reorderLayer(L, true); break;
      case 'back': if (L) reorderLayer(L, false); break;
      case 'center':
        if (L) { L.x = 50; L.y = 50; applyLayerStyle(layerEl(L), L); save(); }
        break;
      case 'del': if (L) deleteLayer(L); break;
    }
  });
  $('#layerFileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const L = selectedLayer();
    if (e.target.dataset.mode === 'replace' && L && L.type === 'image') replaceLayerImage(L, f);
    else addImageLayer(f);
  });
  $('#layerList').addEventListener('click', (e) => {
    const b = e.target.closest('.layer-item');
    const sc = state.scenes[selectedIndex()];
    const L = b && sc && (sc.layers || []).find((l) => l.id === b.dataset.lid);
    if (L) { stopPlayback(); selectLayer(sc, L); }
  });

  // 꾸밈 값 바꾸기
  const deco = $('[data-pane="deco"]');
  deco.addEventListener('input', (e) => {
    const k = e.target.dataset.ls;
    const L = selectedLayer();
    if (!k || !L) return;
    const el = e.target;
    let v = el.value;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') v = parseFloat(el.value);
    L[k] = v;
    applyLayerStyle(layerEl(L), L);
    syncInspector();
    save();
  });
  deco.addEventListener('click', (e) => {
    const a = e.target.closest('[data-align]');
    const L = selectedLayer();
    if (a && L) { L.align = a.dataset.align; applyLayerStyle(layerEl(L), L); syncInspector(); save(); }
  });

  // 일부 색칠: 버튼을 눌러도 편집 중인 글자 선택이 풀리지 않게
  for (const id of ['#paintBtn', '#paintClear']) $(id).addEventListener('mousedown', (e) => e.preventDefault());
  $('#paintBtn').addEventListener('click', () => applyPaint($('#paintColor').value));
  $('#paintClear').addEventListener('click', () => applyPaint(null));
  $('#paintColor').addEventListener('input', (e) => applyPaint(e.target.value, true));

  // 스타일
  $('#saveStyle').addEventListener('click', saveLayerStyle);
  $('#styleName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveLayerStyle(); });
  $('#styleList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.style-item').dataset.sid;
    if (b.dataset.act === 'style-apply') applyLayerStyleById(id);
    else if (b.dataset.act === 'style-del') deleteLayerStyle(id);
  });

  // 키보드: 고른 글자·이미지 지우기 / 화살표로 조금씩 옮기기 / Esc로 해제
  document.addEventListener('keydown', (e) => {
    if (!selLayer || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const L = selectedLayer();
    if (!L) return;
    const step = e.shiftKey ? 2 : 0.5;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === 'Delete' || e.key === 'Backspace') deleteLayer(L);
    else if (e.key === 'Escape') deselectLayer();
    else if (moves[e.key]) {
      L.x = +(L.x + moves[e.key][0]).toFixed(2);
      L.y = +(L.y + moves[e.key][1]).toFixed(2);
      applyLayerStyle(layerEl(L), L);
      save();
    } else return;
    e.preventDefault();
    e.stopPropagation(); // 장면 넘기기 등 다른 단축키로 가지 않게
  }, true);
}

/* ---------------- 토스트 ---------------- */

let toastTimer = null;
function toast(msg, action = null, ms = 2600) {
  clearTimeout(toastTimer);
  $('#toastMsg').textContent = msg;
  const btn = $('#toastAct');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.fn;
  }
  $('#toast').hidden = false;
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

/* ---------------- 왼쪽 설정 바인딩 ---------------- */

const FMT = {
  'voice.rate': (v) => v.toFixed(2) + '×',
  'voice.pitch': (v) => v.toFixed(2),
  'voice.volume': (v) => Math.round(v * 100) + '%',
  'sub.size': (v) => v.toFixed(1),
  'sub.lineH': (v) => v.toFixed(2),
  'sub.letterSp': (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%',
  sfxVol: (v) => Math.round(v * 100) + '%',
  'sub.posY': (v) => Math.round(v) + '%',
  'sub.maxW': (v) => Math.round(v) + '%',
  'sub.boxOpacity': (v) => Math.round(v * 100) + '%',
};
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}
function updateOut(path, v) {
  for (const out of $$(`output[data-out="${path}"]`)) out.textContent = FMT[path] ? FMT[path](v) : v;
}
function syncControls() {
  $$('[data-bind]').forEach((el) => {
    const path = el.dataset.bind;
    const v = getPath(state, path);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    updateOut(path, v);
  });
  $('#title').value = state.title;
  document.title = `${state.title || '숏츠'} · 숏츠 자동 편집기`;
  $('#script').value = state.script;
  updateSentenceCount();
  $('#zoom').value = state.ui.zoom;
  $$('.aspect button').forEach((b) => b.classList.toggle('on', b.dataset.ar === state.aspect));
  renderVoiceSelect();
  renderFontPicker();
  renderFontLib();
  renderSfxBuiltin();
  renderSfxLib();
}
function onSettingChange(path) {
  if (path.startsWith('sub.')) applySubStyle();
  if (path === 'sub.chunk') renderStage();
  if (path === 'voice.lang') { state.voice.voiceURI = ''; renderVoiceSelect(); }
  if (path === 'voice.rate' || path === 'voice.lang') {
    renderTimeline();
    state.scenes.forEach(updateCardDur);
  }
}

let countTimer = null;
function updateSentenceCount() {
  const n = state.script.trim() ? splitSentences(state.script).length : 0;
  $('#sentenceCount').textContent = n ? `문장 ${n}개 감지` : '';
}

/* ---------------- 이벤트 ---------------- */

function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function bindEvents() {
  // 상단
  $('#title').addEventListener('input', (e) => {
    state.title = e.target.value;
    document.title = `${state.title || '숏츠'} · 숏츠 자동 편집기`;
    save();
  });
  $$('.aspect button').forEach((b) => b.addEventListener('click', () => {
    state.aspect = b.dataset.ar;
    $$('.aspect button').forEach((x) => x.classList.toggle('on', x === b));
    fitStage();
    save();
  }));
  $('#newProject').addEventListener('click', async () => {
    if (!confirm('새 프로젝트를 시작할까요?\n지금 대본·장면·넣어 둔 화면 파일이 모두 지워집니다.\n(음성·자막 설정, 글꼴 보관함, 효과음 보관함은 그대로 남아요)')) return;
    stopPlayback();
    dropUndo();
    const keep = {
      voice: state.voice, sub: state.sub, ui: state.ui, aspect: state.aspect,
      fonts: state.fonts, sfxLib: state.sfxLib, sfxVol: state.sfxVol, layerStyles: state.layerStyles,
    };
    for (const u of urlCache.values()) URL.revokeObjectURL(u);
    urlCache.clear();
    state = mergeDeep(clone(DEFAULT), clone(keep));
    stageKey = null;
    await gcMedia();
    syncControls();
    fitStage();
    structureChanged();
  });

  // 대본
  $('#script').addEventListener('input', (e) => {
    state.script = e.target.value;
    clearTimeout(countTimer);
    countTimer = setTimeout(updateSentenceCount, 200);
    save();
  });
  $('#splitBtn').addEventListener('click', applyScript);

  // 설정
  $$('[data-bind]').forEach((el) => {
    el.addEventListener('input', () => {
      const path = el.dataset.bind;
      let v = el.value;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range' || el.type === 'number' || 'num' in el.dataset) v = parseFloat(el.value);
      setPath(state, path, v);
      // 같은 설정을 가리키는 다른 컨트롤(왼쪽 패널 ↔ 미리보기 아래 빠른 설정)도 맞춤
      for (const o of $$(`[data-bind="${path}"]`)) {
        if (o === el) continue;
        if (o.type === 'checkbox') o.checked = !!v; else o.value = v;
      }
      updateOut(path, v);
      onSettingChange(path);
      save();
    });
    // 슬라이더를 놓았을 때 재생 중이면 새 설정으로 지금 장면부터 다시 읽기
    if (/^voice\.(rate|pitch|volume|lang)$/.test(el.dataset.bind)) el.addEventListener('change', restartIfPlaying);
  });
  $$('.voice-select').forEach((sel) => sel.addEventListener('change', (e) => {
    state.voice.voiceURI = e.target.value;
    $$('.voice-select').forEach((o) => { if (o !== sel) o.value = e.target.value; });
    updateVoiceMode();
    onSettingChange('voice.rate');
    save();
    restartIfPlaying();
  }));
  $('#voiceTest').addEventListener('click', () => {
    stopPlayback();
    speak(TEST_LINE[state.voice.lang] || TEST_LINE.ko);
  });
  $$('[data-posy]').forEach((b) => b.addEventListener('click', () => {
    const r = $('[data-bind="sub.posY"]');
    r.value = b.dataset.posy;
    r.dispatchEvent(new Event('input'));
  }));

  // 재생
  $('#playBtn').addEventListener('click', togglePlay);
  $('#stopBtn').addEventListener('click', () => {
    stopPlayback();
    if (state.scenes.length) selectScene(state.scenes[0].id);
    $('#timeline').scrollLeft = 0;
  });
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  // 타임라인
  $('#tlBlocks').addEventListener('click', (e) => {
    const b = e.target.closest('.tl-block');
    if (!b) return;
    if (P.playing && P.mode === 'all') startPlayback(sceneIndex(b.dataset.id));
    else { stopPlayback(); selectScene(b.dataset.id, { scroll: true }); }
  });
  $('#tlRuler').addEventListener('click', (e) => {
    if (!state.scenes.length) return;
    const t = (e.clientX - e.currentTarget.getBoundingClientRect().left) / state.ui.zoom;
    const i = sceneAtTime(t);
    if (P.playing && P.mode === 'all') startPlayback(i);
    else { stopPlayback(); selectScene(state.scenes[i].id, { scroll: true }); }
  });
  $('#zoom').addEventListener('input', (e) => {
    state.ui.zoom = parseFloat(e.target.value);
    renderTimeline();
    save();
  });

  // 장면 목록
  $('#addScene').addEventListener('click', () => {
    const i = selectedIndex();
    insertScene(i < 0 ? 0 : i + 1);
  });
  const list = $('#sceneList');
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.scene');
    if (!card) return;
    const id = card.dataset.id;
    const sc = findScene(id);
    const actEl = e.target.closest('[data-act]');
    const act = actEl && actEl.tagName !== 'INPUT' ? actEl.dataset.act : null;
    if (state.selectedId !== id) selectScene(id);
    switch (act) {
      case 'listen':
        if (P.playing && P.singleId === id) stopPlayback();
        else startPlayback(sceneIndex(id), true);
        break;
      case 'up': moveScene(id, sceneIndex(id) - 1); break;
      case 'down': moveScene(id, sceneIndex(id) + 1); break;
      case 'insert': insertScene(sceneIndex(id) + 1); break;
      case 'del': deleteScene(id); break;
      case 'file': {
        const fp = $('#filePicker');
        fp.dataset.target = id;
        fp.value = '';
        fp.click();
        break;
      }
      case 'fit':
        if (sc.media && sc.media.type !== 'color') {
          sc.media.fit = actEl.dataset.val;
          mediaChanged();
        }
        break;
      case 'clear': clearSceneMedia(sc); break;
      case 'voice-file': {
        const vp = $('#voicePicker');
        vp.dataset.start = sceneIndex(id);
        vp.value = '';
        vp.click();
        break;
      }
      case 'voice-tts': clearVoice(sc); break;
      case 'video-edit': openVideoEditor(id); break;
      case 'sfx-add': {
        sc.sfx = sc.sfx || [];
        const s = { id: 'x_' + uid(), src: 'syn:pop', vol: 1, at: 0 };
        sc.sfx.push(s);
        renderSfxRows(card, sc);
        refreshCardOpts(card, sc, sceneIndex(id));
        renderTimeline();
        save();
        previewSfx(s);
        break;
      }
      case 'sfx-play': {
        const s = (sc.sfx || []).find((x) => x.id === actEl.closest('.sfx-row').dataset.sid);
        if (s) previewSfx(s);
        break;
      }
      case 'sfx-del':
        sc.sfx = (sc.sfx || []).filter((x) => x.id !== actEl.closest('.sfx-row').dataset.sid);
        renderSfxRows(card, sc);
        refreshCardOpts(card, sc, sceneIndex(id));
        renderTimeline();
        save();
        break;
    }
  });
  list.addEventListener('input', (e) => {
    const card = e.target.closest('.scene');
    if (!card) return;
    const sc = findScene(card.dataset.id);
    if (e.target.classList.contains('scene-text')) {
      sc.text = e.target.value;
      autoGrow(e.target);
      updateCardDur(sc);
      renderTimeline();
      if (state.scenes[selectedIndex()] === sc && !P.playing) {
        setSubtitle(subChunks(sc.text)[0].text);
        updateSceneLabel();
      }
      save();
    } else if (e.target.dataset.act === 'color') {
      setSceneColor(sc, e.target.value);
    } else if (e.target.dataset.opt) {
      applySceneOpt(sc, card, e.target);
    } else if (e.target.dataset.sfx) {
      applySfxInput(sc, card, e.target);
    }
  });
  list.addEventListener('toggle', (e) => {
    if (!e.target.classList || !e.target.classList.contains('scene-opts')) return;
    const id = e.target.closest('.scene').dataset.id;
    if (e.target.open) openOpts.add(id); else openOpts.delete(id);
  }, true);
  // 숫자 칸에서 빈 값으로 나가면 실제 값으로 되돌려 보여 줌
  list.addEventListener('focusout', (e) => {
    if (e.target.type !== 'number') return;
    const card = e.target.closest('.scene');
    const sc = card && findScene(card.dataset.id);
    if (sc) refreshCardOpts(card, sc, sceneIndex(sc.id));
  });
  list.addEventListener('focusin', (e) => {
    const card = e.target.closest('.scene');
    if (card && state.selectedId !== card.dataset.id && !P.playing) selectScene(card.dataset.id);
  });
  $('#filePicker').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) setSceneFile(e.target.dataset.target, f);
  });
  $('#voicePicker').addEventListener('change', (e) => {
    if (e.target.files.length) placeVoiceFiles(e.target.files, +e.target.dataset.start || 0);
  });
  $('#voiceBatch').addEventListener('click', () => {
    const vp = $('#voicePicker');
    vp.dataset.start = 0;
    vp.value = '';
    vp.click();
  });

  // 효과음 보관함
  $('#sfxBuiltin').addEventListener('click', (e) => {
    const b = e.target.closest('[data-syn]');
    if (b) previewSfx({ src: 'syn:' + b.dataset.syn, vol: 1 });
  });
  $('#addSfxBtn').addEventListener('click', () => {
    const fi = $('#sfxFileInput');
    fi.value = '';
    fi.click();
  });
  $('#sfxFileInput').addEventListener('change', (e) => {
    if (e.target.files.length) addSfxFiles(e.target.files);
  });
  const sfxLib = $('#sfxLib');
  sfxLib.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('.sfx-item').dataset.id;
    if (b.dataset.act === 'sfx-lib-play') previewSfx({ src: 'lib:' + id, vol: 1 });
    else if (b.dataset.act === 'sfx-lib-del') deleteSfx(id);
  });
  sfxLib.addEventListener('change', (e) => {
    const row = e.target.closest('.sfx-item');
    if (!row || e.target.tagName !== 'INPUT') return;
    const f = state.sfxLib.find((x) => x.id === row.dataset.id);
    if (!f) return;
    f.name = e.target.value.trim() || f.fileName.replace(SFX_EXT, '');
    e.target.value = f.name;
    renderScenes(); // 장면 카드의 효과음 목록 이름도 바꿈
    renderTimeline();
    save();
  });
  sfxLib.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  });
  sfxLib.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    sfxLib.classList.add('dragover');
  });
  sfxLib.addEventListener('dragleave', (e) => {
    if (!sfxLib.contains(e.relatedTarget)) sfxLib.classList.remove('dragover');
  });
  sfxLib.addEventListener('drop', (e) => {
    e.preventDefault();
    sfxLib.classList.remove('dragover');
    if (e.dataTransfer.files.length) addSfxFiles(e.dataTransfer.files);
  });

  // 글꼴
  $('#fontPicker').addEventListener('click', (e) => {
    const b = e.target.closest('.font-item');
    if (b) chooseFont(b.dataset.css);
  });
  $('#addFontBtn').addEventListener('click', () => {
    const fi = $('#fontFileInput');
    fi.value = '';
    fi.click();
  });
  $('#fontFileInput').addEventListener('change', (e) => {
    if (e.target.files.length) addFontFiles(e.target.files);
  });
  const lib = $('#fontLib');
  lib.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="del-font"]');
    if (b) deleteFont(b.closest('.lib-item').dataset.id);
  });
  lib.addEventListener('change', (e) => {
    const row = e.target.closest('.lib-item');
    if (!row || e.target.tagName !== 'INPUT') return;
    const f = state.fonts.find((x) => x.id === row.dataset.id);
    if (!f) return;
    f.name = e.target.value.trim() || f.fileName.replace(FONT_EXT, '');
    e.target.value = f.name;
    renderFontPicker();
    save();
  });
  lib.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  });
  lib.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    lib.classList.add('dragover');
  });
  lib.addEventListener('dragleave', (e) => {
    if (!lib.contains(e.relatedTarget)) lib.classList.remove('dragover');
  });
  lib.addEventListener('drop', (e) => {
    e.preventDefault();
    lib.classList.remove('dragover');
    if (e.dataTransfer.files.length) addFontFiles(e.dataTransfer.files);
  });

  // 순서 바꾸기(끌어서 놓기) + 장면 카드에 파일 끌어다 놓기
  let dragId = null;
  const clearDrop = () => {
    $$('.scene').forEach((c) => c.classList.remove('drop-before', 'drop-after', 'filedrop'));
    $$('.voice-row.over').forEach((r) => r.classList.remove('over'));
  };
  list.addEventListener('dragstart', (e) => {
    const h = e.target.closest && e.target.closest('.handle');
    if (!h) return;
    const card = h.closest('.scene');
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.setDragImage(card, 24, 20);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    $$('.scene.dragging').forEach((c) => c.classList.remove('dragging'));
    clearDrop();
  });
  list.addEventListener('dragover', (e) => {
    const card = e.target.closest('.scene');
    const isFile = e.dataTransfer.types.includes('Files');
    if (!card || (!dragId && !isFile)) return;
    e.preventDefault();
    clearDrop();
    if (isFile && !dragId) {
      e.dataTransfer.dropEffect = 'copy';
      const vr = e.target.closest('.voice-row');
      if (vr) vr.classList.add('over');
      else card.classList.add('filedrop');
      return;
    }
    const r = card.getBoundingClientRect();
    card.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearDrop();
  });
  list.addEventListener('drop', (e) => {
    const card = e.target.closest('.scene');
    clearDrop();
    if (!card) return;
    e.preventDefault();
    if (!dragId) {
      if (e.target.closest('.voice-row')) placeVoiceFiles(e.dataTransfer.files, sceneIndex(card.dataset.id)); // 녹음 파일 줄에 놓으면 목소리로
      else dropFiles(e.dataTransfer.files, sceneIndex(card.dataset.id));
      return;
    }
    const r = card.getBoundingClientRect();
    const after = e.clientY >= r.top + r.height / 2;
    const from = sceneIndex(dragId);
    let to = sceneIndex(card.dataset.id) + (after ? 1 : 0);
    if (from < to) to--;
    const id = dragId;
    dragId = null;
    moveScene(id, to);
  });

  // 미리보기에 파일 끌어다 놓기 → 선택한 장면
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    stage.classList.add('dragover');
  });
  stage.addEventListener('dragleave', (e) => {
    if (!stage.contains(e.relatedTarget)) stage.classList.remove('dragover');
  });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const imgs = [...e.dataTransfer.files].filter((f) => /^image\//.test(f.type));
    if (state.ui.leftTab === 'deco' && imgs.length) { // 꾸미기 탭: 놓은 자리에 이미지 얹기
      const r = stage.getBoundingClientRect();
      const at = { x: (e.clientX - r.left) / r.width * 100, y: (e.clientY - r.top) / r.height * 100 };
      imgs.forEach((f, k) => addImageLayer(f, { x: at.x + k * 4, y: at.y + k * 4 }));
      return;
    }
    dropFiles(e.dataTransfer.files, selectedIndex());
  });

  // 복사한 이미지 Ctrl+V → 선택한 장면의 화면
  document.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...cd.files].filter((f) => /^(image|video)\//.test(f.type));
    if (!files.length) return;
    // 글을 쓰는 중이고 클립보드에 글도 있으면 글 붙여넣기가 우선
    if (isTyping(e) && cd.types.includes('text/plain')) return;
    e.preventDefault();
    if (!state.scenes.length) { toast('먼저 장면을 만들어 주세요.'); return; }
    const i = selectedIndex();
    const f = files[0];
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const stamp = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const named = !f.name || /^image\.\w+$/i.test(f.name)
      ? new File([f], `붙여넣은 이미지 ${stamp}.${ext}`, { type: f.type })
      : f;
    if (state.ui.leftTab === 'deco' && /^image\//.test(named.type)) { addImageLayer(named); return; } // 꾸미기 탭: 화면 위에 얹기
    setSceneFile(state.scenes[i].id, named).then((ok) => { if (ok) toast(`${i + 1}번 장면에 붙여 넣었어요.`); });
  });
  // 빈 곳에 파일을 놓아 브라우저가 파일을 열어 버리는 일 막기
  window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => e.preventDefault());

  // 키보드
  document.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  new ResizeObserver(fitStage).observe($('#stageWrap'));
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(); });
  window.addEventListener('pagehide', () => { if (saveTimer) flush(); });
}

function step(d) {
  if (!state.scenes.length) return;
  const i = Math.max(0, Math.min(state.scenes.length - 1, selectedIndex() + d));
  if (P.playing && P.mode === 'all') startPlayback(i);
  else { stopPlayback(); selectScene(state.scenes[i].id, { scroll: true }); }
}

/* ---------------- 시작 ---------------- */

async function init() {
  let saved = null;
  try { saved = await kvGet('project'); } catch (e) { console.error(e); setSaveStatus('error'); }

  if (saved) {
    state = mergeDeep(clone(DEFAULT), saved);
  } else {
    // 처음 열었을 때 보여 줄 예시
    state = clone(DEFAULT);
    state.title = '아침 습관 숏츠';
    state.script = SAMPLE_SCRIPT;
    const colors = ['#1f2a44', null, '#40213f', null, '#123d36', null];
    state.scenes = splitSentences(SAMPLE_SCRIPT).map((t, i) =>
      newScene(t, colors[i] ? { type: 'color', color: colors[i] } : null));
    state.selectedId = state.scenes[0] && state.scenes[0].id;
  }
  if (state.selectedId && !findScene(state.selectedId)) state.selectedId = null;

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  bindEvents();
  bindDeco();
  setTab(state.ui.leftTab || 'settings');
  syncControls();
  applySubStyle();
  fitStage();
  renderScenes();
  renderTimeline();
  renderStage();

  if (hasTTS) {
    loadVoices();
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
  } else {
    renderVoiceSelect();
  }

  gcMedia();
  if (!saved) flush();
  loadUserFonts();
}

init();
