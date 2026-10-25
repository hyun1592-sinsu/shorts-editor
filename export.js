'use strict';

/* =========================================================
   MP4 내보내기 — 서버 없이 브라우저 안에서
   1) 목소리: 브라우저 TTS는 파일로 받을 수 없으므로, 미리보기처럼 끝까지 실제로 읽게 하면서
      화면 공유의 '시스템 오디오'로 그 소리를 녹음한다. 장면·자막이 넘어간 시각도 함께 기록.
   2) 소리: 녹음한 목소리 + 효과음(합성·파일) + 영상 소리를 OfflineAudioContext로 미리 섞음.
   3) 그림: 미리보기와 같은 CSS로 숨겨 둔 무대에 글자를 배치해 위치를 잰 뒤, 캔버스에 같은 모양으로 그림.
   4) 인코딩: WebCodecs(H.264 + AAC) → mp4-muxer(vendor/)로 MP4 파일.
   app.js의 전역(state, P, subChunks, mediaRun …)을 그대로 씀.
   ========================================================= */

const EXP = { running: false, cancelled: false, cleanup: [] };
let lastNarration = null; // 대본·목소리가 같으면 다시 녹음하지 않고 재사용
const SR = 48000;

class Cancelled extends Error {}
const checkCancel = () => { if (EXP.cancelled) throw new Cancelled(); };
const nextTick = () => new Promise((r) => setTimeout(r, 0));

function exportSize(short) {
  const ar = ASPECTS[state.aspect] || 9 / 16;
  let w, h;
  if (ar <= 1) { w = short; h = Math.round(short / ar); } else { h = short; w = Math.round(short * ar); }
  return { w: w - (w % 2), h: h - (h % 2) }; // H.264는 짝수 크기
}

/* 이 값이 같으면 예전에 녹음한 목소리를 그대로 쓸 수 있음 */
function narrationKey() {
  const v = state.voice;
  return JSON.stringify({
    v: [v.voiceURI, v.lang, v.rate, v.pitch, v.volume],
    s: state.scenes.map((sc) => [sc.text.trim(), !!sc.silent, +sc.silentDur || 3, +sc.hold || 0, sc.voice ? sc.voice.mediaId : '']),
  });
}
/* TTS로 읽어야 하는 문장이 있는지(모두 녹음 파일이면 실시간 녹음이 필요 없음) */
const ttsNeeded = () => state.scenes.some((sc) => !sc.silent && !sc.voice && sc.text.trim());

/* ---------------- 1) 목소리 녹음 ---------------- */

async function recordNarration(onProgress) {
  if (!hasTTS) throw new Error('이 브라우저는 음성 읽기를 지원하지 않아요.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('이 브라우저는 화면 공유 녹음을 지원하지 않아요. Edge나 Chrome 최신 버전에서 열어 주세요.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    throw new Error('화면 공유를 취소했어요. 목소리를 넣으려면 공유를 허용해 주세요.');
  }
  EXP.cleanup.push(() => stream.getTracks().forEach((t) => t.stop()));
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw new Error('소리가 공유되지 않았어요. 공유 창에서 「전체 화면」을 고르고 아래쪽 「시스템 오디오도 공유」를 켠 다음 다시 시도해 주세요.');
  }
  checkCancel();

  const ctx = audio();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const proc = ctx.createScriptProcessor(4096, 2, 2);
  const mute = ctx.createGain();
  mute.gain.value = 0; // 녹음한 소리를 다시 스피커로 내보내지 않음
  const chunks = [[], []];
  let samples = 0;
  proc.onaudioprocess = (e) => {
    const ib = e.inputBuffer;
    for (let c = 0; c < 2; c++) chunks[c].push(new Float32Array(ib.getChannelData(Math.min(c, ib.numberOfChannels - 1))));
    samples += ib.length;
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const disconnect = () => { try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) { /* 이미 끊김 */ } };
  EXP.cleanup.push(disconnect);

  await sleep(500); // 녹음이 자리 잡을 때까지
  checkCancel();

  const expected = Math.max(1, timings().total);
  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });
  const rec = { log: [], t0: performance.now(), onEnd: (ok) => resolveEnd(ok) };
  const startSamples = samples;
  P.rec = rec;
  const timer = setInterval(() => {
    if (EXP.cancelled) { stopPlayback(); resolveEnd(false); return; }
    if (!P.playing) { resolveEnd(false); return; } // 누군가 재생을 멈춤
    onProgress(Math.min(0.99, (performance.now() - rec.t0) / 1000 / expected), `${selectedIndex() + 1} / ${state.scenes.length} 장면`);
  }, 200);

  let ok = false;
  try {
    startPlayback(0);
    ok = await ended;
  } finally {
    clearInterval(timer);
  }
  if (ok) await sleep(700); // 마지막 숨소리까지
  P.rec = null;
  disconnect();
  stream.getTracks().forEach((t) => t.stop());
  if (!ok) {
    if (EXP.cancelled) throw new Cancelled();
    throw new Error('녹음 중에 재생이 멈췄어요. 내보내는 동안에는 재생 버튼을 누르지 말아 주세요.');
  }

  const len = chunks[0].reduce((a, b) => a + b.length, 0);
  const buffer = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: 2, sampleRate: ctx.sampleRate });
  for (let c = 0; c < 2; c++) {
    let off = 0;
    for (const part of chunks[c]) { buffer.copyToChannel(part, c, off); off += part.length; }
  }

  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak < 0.003) {
    throw new Error('녹음된 소리가 없어요. 공유 창에서 「전체 화면」 + 「시스템 오디오도 공유」를 켰는지, 컴퓨터 소리가 꺼져 있지 않은지 확인해 주세요. (「Chrome 탭」 공유는 목소리가 녹음되지 않아요)');
  }

  // 녹음 지연 맞추기: 첫 문장을 읽기 시작한 시각 ↔ 녹음에 실제로 소리가 처음 나타난 위치
  const sr = ctx.sampleRate;
  const firstSpeak = rec.log.find((x) => x.type === 'speak');
  let latency = 0.12;
  if (firstSpeak) {
    const exp = startSamples + firstSpeak.t * sr;
    const onset = findOnset(buffer, Math.floor(exp), sr);
    if (onset >= 0) latency = clamp((onset - exp) / sr - 0.03, 0, 1.5);
  }
  return { buffer, base: startSamples / sr + latency, log: rec.log, key: narrationKey() };
}

function findOnset(buf, from, sr) {
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  const win = Math.floor(sr * 0.005);
  const end = Math.min(a.length, from + sr * 2);
  for (let i = Math.max(0, from); i < end; i += win) {
    let m = 0;
    for (let k = i; k < i + win && k < a.length; k++) m = Math.max(m, Math.abs(a[k]), Math.abs(b[k]));
    if (m > 0.02) return i;
  }
  return -1;
}

/* ---------------- 시간표 ---------------- */

/* 녹음하며 기록한 장면·자막 시각 → 영상 시간표 (첫 장면이 0초) */
function timelineFromLog(log) {
  const n = state.scenes.length;
  const S = new Array(n).fill(null);
  const chunks = Array.from({ length: n }, () => []);
  for (const e of log) {
    if (e.type === 'scene') { S[e.i] = e.t; chunks[e.i] = []; } // 같은 장면을 다시 읽었으면 마지막 것 기준
    else if (e.type === 'chunk' && e.i >= 0) chunks[e.i].push([e.t, e.idx]);
  }
  for (let i = 0; i < n; i++) if (S[i] === null) S[i] = i ? S[i - 1] : 0;
  const endEv = [...log].reverse().find((e) => e.type === 'end');
  const t0 = S[0];
  return {
    S: S.map((s) => s - t0),
    chunks: chunks.map((list) => list.map(([t, idx]) => [t - t0, idx])),
    total: (endEv ? endEv.t : log[log.length - 1].t) - t0 + 0.4,
    t0,
  };
}

/* 목소리 없이 내보낼 때: 예상(또는 실측) 길이로 시간표 */
function timelineVirtual() {
  const { starts, total } = timings();
  const chunks = state.scenes.map((sc, i) => {
    const cs = subChunks(sc.text);
    if (cs.length < 2) return [];
    const base = sc.silent ? sceneDur(sc) : speechDur(sc);
    const w = cs.map((c) => c.text.replace(/\s+/g, '').length || 1);
    const sum = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    return cs.map((c, j) => { const r = [starts[i] + (base * acc) / sum, j]; acc += w[j]; return r; });
  });
  return { S: starts, chunks, total: total + 0.3, t0: 0 };
}

function frameState(tl, t) {
  let i = 0;
  for (let k = 0; k < tl.S.length; k++) if (tl.S[k] <= t + 1e-6) i = k;
  let idx = 0;
  for (const [ct, ci] of tl.chunks[i]) if (ct <= t + 1e-6) idx = Math.max(idx, ci);
  return { i, idx };
}
function runBounds(tl, i) {
  const run = mediaRun(i);
  if (!run) return null;
  return Object.assign(run, {
    s0: tl.S[run.from],
    s1: run.to + 1 < tl.S.length ? tl.S[run.to + 1] : tl.total,
  });
}

/* ---------------- 2) 소리 섞기 ---------------- */

const videoAudioCache = new Map();
function videoAudioBuffer(id) {
  if (!videoAudioCache.has(id)) {
    videoAudioCache.set(id, (async () => {
      const blob = await mediaGet(id);
      return blob ? decodeAudio(await blob.arrayBuffer()) : null;
    })().catch(() => null)); // 소리가 없는 영상
  }
  return videoAudioCache.get(id);
}

/* 영상 소리도 남길 구간만 이어 붙임 */
function trimBuffer(buf, segs) {
  if (!segs || !segs.length) return buf;
  const sr = buf.sampleRate;
  const parts = segs.map((g) => [Math.floor(g.s * sr), Math.min(buf.length, Math.floor(g.e * sr))]).filter(([a, b]) => b > a);
  const len = parts.reduce((a, [x, y]) => a + (y - x), 0);
  const out = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    let off = 0;
    for (const [x, y] of parts) { out.copyToChannel(d.subarray(x, y), c, off); off += y - x; }
  }
  return out;
}

async function mixAudio(tl, narration) {
  const octx = new OfflineAudioContext(2, Math.ceil(tl.total * SR), SR);
  // 소리가 겹쳐 찢어지지 않게 살짝 눌러 주는 리미터
  const limiter = octx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.connect(octx.destination);

  if (narration) {
    const s = octx.createBufferSource();
    s.buffer = narration.buffer;
    s.connect(limiter);
    s.start(0, Math.max(0, narration.base + tl.t0));
  }
  let missingVideoAudio = 0, missingVoice = 0;
  for (let i = 0; i < state.scenes.length; i++) {
    checkCancel();
    const sc = state.scenes[i];
    for (const s of sc.sfx || []) await startSfx(octx, s, tl.S[i] + Math.max(0, +s.at || 0), limiter);
    if (sc.voice && !sc.silent) { // 문장별 녹음 파일
      const buf = await voiceBuffer(sc.voice.mediaId);
      if (buf) {
        const src = octx.createBufferSource();
        src.buffer = buf;
        src.connect(limiter);
        src.start(tl.S[i]);
      } else missingVoice++;
    }
    const m = sc.media;
    if (m && m.type === 'video' && +m.volume > 0) {
      const buf = await videoAudioBuffer(m.mediaId);
      if (!buf) { missingVideoAudio++; continue; }
      const rb = runBounds(tl, i);
      const src = octx.createBufferSource();
      src.buffer = trimBuffer(buf, m.segs);
      src.loop = true; // 미리보기처럼 영상이 짧으면 되풀이
      const g = octx.createGain();
      g.gain.value = Math.min(1, +m.volume);
      src.connect(g).connect(limiter);
      src.start(rb.s0);
      src.stop(rb.s1);
    }
  }
  const out = await octx.startRendering();
  return { buffer: out, missingVideoAudio, missingVoice };
}

/* ---------------- 3) 그림 그리기 ---------------- */

async function loadImage(id) {
  const url = await mediaURL(id);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  try { await img.decode(); return img; } catch (e) { return null; }
}
async function loadVideo(id) {
  const url = await mediaURL(id);
  if (!url) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 10000); });
  return v.readyState >= 2 ? v : null;
}
function seekVideo(v, t) {
  if (Math.abs(v.currentTime - t) < 1e-3 && !v.seeking) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function prepareAssets() {
  const imgs = new Map(), vids = new Map();
  for (const sc of state.scenes) {
    const m = sc.media;
    if (m && m.type === 'image' && !imgs.has(m.mediaId)) imgs.set(m.mediaId, await loadImage(m.mediaId));
    if (m && m.type === 'video' && !vids.has(m.mediaId)) vids.set(m.mediaId, await loadVideo(m.mediaId));
    for (const L of sc.layers || []) {
      if (L.type === 'image' && !imgs.has(L.mediaId)) imgs.set(L.mediaId, await loadImage(L.mediaId));
    }
    checkCancel();
  }
  return { imgs, vids };
}

/* 미리보기와 같은 CSS를 쓰는, 화면 밖에 숨겨 둔 측정용 무대(내보낼 픽셀 크기 그대로) */
function makeMeasureStage(W, H) {
  const st = document.createElement('div');
  st.className = 'stage measure-stage';
  Object.assign(st.style, {
    position: 'fixed', left: '-100000px', top: '0', width: W + 'px', height: H + 'px',
    visibility: 'hidden', pointerEvents: 'none', borderRadius: '0', boxShadow: 'none',
  });
  st.innerHTML = '<div class="sub"><span></span></div><div class="layers"></div>';
  document.body.append(st);
  applySubStyle(st);
  return st;
}

function nodeColor(node, root) {
  for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    if (el.dataset && el.dataset.c) return el.dataset.c;
    if (el === root) break;
  }
  return null;
}

/* 글자마다 화면 위치를 재서, 같은 줄·같은 색끼리 이어진 조각으로 묶음 */
function measurePieces(root, origin) {
  const pieces = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur = null, node;
  while ((node = walker.nextNode())) {
    const color = nodeColor(node, root);
    const s = node.data;
    for (let i = 0; i < s.length;) {
      const len = s.codePointAt(i) > 0xffff ? 2 : 1;
      const ch = s.slice(i, i + len);
      range.setStart(node, i);
      range.setEnd(node, i + len);
      i += len;
      if (ch === '\n') { cur = null; continue; }
      const r = range.getClientRects()[0];
      if (!r || (r.width === 0 && /\s/.test(ch))) continue; // 줄 끝에 걸린 공백
      const x = r.left - origin.left, top = r.top - origin.top;
      if (cur && Math.abs(top - cur.top) < 1 && cur.color === color && Math.abs(x - cur.right) < 1.5) {
        cur.text += ch;
        cur.right = x + r.width;
      } else {
        cur = { text: ch, x, top, right: x + r.width, bottom: r.bottom - origin.top, color };
        pieces.push(cur);
      }
    }
  }
  return pieces;
}

function setupText(ctx, cs) {
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  return ctx.measureText('가Ag').fontBoundingBoxAscent;
}

/* CSS의 paint-order: stroke fill처럼 — 외곽선을 모두 먼저, 그 위에 채우기 */
function drawPieces(ctx, pieces, ascent, strokeW, strokeColor, baseColor) {
  if (strokeW > 0) {
    ctx.lineWidth = strokeW;
    ctx.strokeStyle = strokeColor;
    for (const p of pieces) ctx.strokeText(p.text, p.x, p.top + ascent);
  }
  for (const p of pieces) {
    ctx.fillStyle = p.color || baseColor;
    ctx.fillText(p.text, p.x, p.top + ascent);
  }
}

function boundsOf(rects, margin, W, H) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const q of rects) { l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
  if (!isFinite(l)) return null;
  l = Math.max(-W, Math.floor(l - margin));
  t = Math.max(-H, Math.floor(t - margin));
  r = Math.min(2 * W, Math.ceil(r + margin));
  b = Math.min(2 * H, Math.ceil(b + margin));
  return { x: l, y: t, w: Math.max(1, r - l), h: Math.max(1, b - t) };
}
function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* 자막 한 조각을 그림(미리보기의 .sub span과 같은 배치) */
async function renderSubtitle(ms, text, W, H) {
  const sub = $('.sub', ms);
  const span = $('span', sub);
  span.textContent = text;
  let cs = getComputedStyle(span);
  await document.fonts.load(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, text); // 이 글자들이 든 글꼴 조각 받기
  cs = getComputedStyle(span);
  const origin = ms.getBoundingClientRect();
  const fontPx = parseFloat(cs.fontSize);
  const cq = Math.min(W, H) / 100;
  const s = state.sub;
  const boxes = [...span.getClientRects()].map((r) => ({
    left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top, width: r.width, height: r.height,
  }));
  const glow = s.glow > 0 ? [1, 2.5, 5].map((k) => s.glow * k * cq) : [];
  const strokeW = parseFloat(cs.webkitTextStrokeWidth) || 0;
  const bd = boundsOf(boxes, (glow.length ? glow[2] * 1.5 : 0) + strokeW + fontPx * 0.3, W, H);
  if (!bd) return null;
  const c = canvasOf(bd.w, bd.h);
  const ctx = c.getContext('2d');
  ctx.translate(-bd.x, -bd.y);
  if (s.box) {
    ctx.fillStyle = hexToRgba(s.boxColor, s.boxOpacity);
    for (const r of boxes) { ctx.beginPath(); ctx.roundRect(r.left, r.top, r.width, r.height, 0.22 * fontPx); ctx.fill(); }
  }
  const ascent = setupText(ctx, cs);
  const pieces = measurePieces(span, origin);
  for (const blur of glow) { // 글자 뒤로 퍼지는 그림자(text-shadow 세 겹)
    ctx.shadowColor = s.glowColor;
    ctx.shadowBlur = blur;
    drawPieces(ctx, pieces, ascent, strokeW, cs.webkitTextStrokeColor, cs.color);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  drawPieces(ctx, pieces, ascent, strokeW, cs.webkitTextStrokeColor, cs.color);
  return { canvas: c, ox: bd.x, oy: bd.y };
}

/* 그림자(drop-shadow)는 합친 모양 전체에 — CSS filter와 같은 방식 */
function withDropShadow(c, filter) {
  if (!filter) return c;
  const o = canvasOf(c.width, c.height);
  const ctx = o.getContext('2d');
  ctx.filter = filter;
  ctx.drawImage(c, 0, 0);
  return o;
}

/* 얹은 글자 하나를 그림(회전은 합칠 때). 미리보기의 .layer와 같은 배치 */
async function renderTextLayer(ms, L, W, H) {
  const box = $('.layers', ms);
  box.innerHTML = '';
  const el = createLayerEl(L);
  box.append(el);
  applyLayerStyle(el, L);
  el.style.transform = 'translate(-50%, -50%)';
  el.style.opacity = '1';
  const t = $('.layer-text', el);
  t.innerHTML = runsToHtml(L.runs);
  const bx = $('.layer-box', el);
  let cs = getComputedStyle(bx);
  await document.fonts.load(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, runsText(L.runs) || 'A');
  cs = getComputedStyle(bx);
  const origin = ms.getBoundingClientRect();
  const fontPx = parseFloat(cs.fontSize);
  const b = bx.getBoundingClientRect();
  const r = { left: b.left - origin.left, top: b.top - origin.top, right: b.right - origin.left, bottom: b.bottom - origin.top };
  const strokeW = parseFloat(cs.webkitTextStrokeWidth) || 0;
  const sh = L.shadow ? (L.shadowDist + L.shadowBlur * 3) * fontPx : 0;
  const bd = boundsOf([r], strokeW + sh + fontPx * 0.4, W, H);
  const c = canvasOf(bd.w, bd.h);
  const ctx = c.getContext('2d');
  ctx.translate(-bd.x, -bd.y);
  if (L.box) {
    ctx.fillStyle = hexToRgba(L.boxColor, L.boxOpacity);
    ctx.beginPath();
    ctx.roundRect(r.left, r.top, r.right - r.left, r.bottom - r.top, (+L.boxRadius || 0) * fontPx);
    ctx.fill();
  }
  const ascent = setupText(ctx, cs);
  drawPieces(ctx, measurePieces(t, origin), ascent, strokeW, L.stroke, L.color);
  box.innerHTML = '';
  const filter = L.shadow
    ? `drop-shadow(${L.shadowDist * 0.5 * fontPx}px ${L.shadowDist * fontPx}px ${L.shadowBlur * fontPx}px ${hexToRgba(L.shadowColor, L.shadowOpacity)})`
    : '';
  return {
    canvas: withDropShadow(c, filter), ox: bd.x, oy: bd.y,
    cx: (L.x / 100) * W, cy: (L.y / 100) * H, rot: L.rot || 0, alpha: L.opacity === undefined ? 1 : L.opacity,
  };
}

function renderImageLayer(L, img, W, H) {
  if (!img) return null;
  const cq = Math.min(W, H) / 100;
  const w = (L.w / 100) * W;
  const h = (w * img.naturalHeight) / img.naturalWidth;
  const cx = (L.x / 100) * W, cy = (L.y / 100) * H;
  const m = Math.ceil((L.shadow ? (L.shadowDist * 8 + L.shadowBlur * 24) * cq : 0) + 2);
  const c = canvasOf(Math.ceil(w + 2 * m), Math.ceil(h + 2 * m));
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(m, m, w, h, (+L.radius || 0) * cq);
  ctx.clip();
  ctx.drawImage(img, m, m, w, h);
  const filter = L.shadow
    ? `drop-shadow(${L.shadowDist * 4 * cq}px ${L.shadowDist * 8 * cq}px ${L.shadowBlur * 8 * cq}px ${hexToRgba(L.shadowColor, L.shadowOpacity)})`
    : '';
  return {
    canvas: withDropShadow(c, filter), ox: cx - w / 2 - m, oy: cy - h / 2 - m,
    cx, cy, rot: L.rot || 0, alpha: L.opacity === undefined ? 1 : L.opacity,
  };
}

/* 자막·얹은 글자는 장면 안에서 모양이 변하지 않으므로 한 번 그려 두고 재사용 */
function makeCache(ms, assets, W, H) {
  const subs = new Map(), layers = new Map();
  return {
    async sub(text) {
      if (!subs.has(text)) subs.set(text, await renderSubtitle(ms, text, W, H));
      return subs.get(text);
    },
    async layer(L) {
      if (!layers.has(L.id)) {
        layers.set(L.id, L.type === 'text' ? await renderTextLayer(ms, L, W, H) : renderImageLayer(L, assets.imgs.get(L.mediaId), W, H));
      }
      return layers.get(L.id);
    },
  };
}

async function drawFrame(ctx, W, H, t, tl, assets, cache) {
  const { i, idx } = frameState(tl, t);
  const sc = state.scenes[i];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';

  // 장면 화면 (앞 장면 화면 이어쓰기 · 맞춤 · 움직임 · 어둡게)
  const rb = runBounds(tl, i);
  const m = rb && rb.media;
  ctx.fillStyle = m && m.type === 'color' ? m.color : m ? '#000' : FALLBACK_BG;
  ctx.fillRect(0, 0, W, H);
  if (m && m.type !== 'color') {
    let src = null, sw = 0, sh = 0;
    if (m.type === 'image') {
      src = assets.imgs.get(m.mediaId);
      if (src) { sw = src.naturalWidth; sh = src.naturalHeight; }
    } else {
      const v = assets.vids.get(m.mediaId);
      if (v) {
        // 다듬은 영상: 남길 구간들을 이어 붙인 시간으로 되풀이 → 원본 위치로 바꿔서 찾아감
        const segs = videoSegs(m, v.duration || 1);
        const len = Math.max(0.05, segsDuration(segs));
        let vt = (t - rb.s0) % len;
        if (vt < 0) vt += len;
        await seekVideo(v, Math.min(virtToSource(segs, vt), Math.max(0, (v.duration || 1) - 0.05)));
        src = v;
        sw = v.videoWidth;
        sh = v.videoHeight;
      }
    }
    if (src && sw && sh) {
      ctx.save();
      const mp = m.motion && m.motion !== 'none'
        ? motionParams(m.motion, clamp((t - rb.s0) / Math.max(0.1, rb.s1 - rb.s0), 0, 1), +m.motionAmt || 1)
        : null;
      if (mp) { // CSS의 transform: scale() translate() 와 같은 순서(가운데 기준)
        ctx.translate(W / 2, H / 2);
        ctx.scale(mp.s, mp.s);
        ctx.translate((mp.tx / 100) * W, (mp.ty / 100) * H);
        ctx.translate(-W / 2, -H / 2);
      }
      const k = m.fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
      ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
      ctx.restore();
    }
    if (+m.dim) { ctx.fillStyle = `rgba(0,0,0,${+m.dim})`; ctx.fillRect(0, 0, W, H); }
  }

  // 자막
  if (!sc.hideSub) {
    const chunks = subChunks(sc.text);
    const text = (chunks[Math.min(idx, chunks.length - 1)] || { text: '' }).text;
    if (text.trim()) {
      const bm = await cache.sub(text);
      if (bm) ctx.drawImage(bm.canvas, bm.ox, bm.oy);
    }
  }

  // 화면 위에 얹은 글자 · 이미지 (목록 순서 = 뒤 → 앞)
  for (const L of sc.layers || []) {
    const bm = await cache.layer(L);
    if (!bm) continue;
    ctx.save();
    ctx.globalAlpha = bm.alpha;
    ctx.translate(bm.cx, bm.cy);
    ctx.rotate((bm.rot * Math.PI) / 180);
    ctx.translate(-bm.cx, -bm.cy);
    ctx.drawImage(bm.canvas, bm.ox, bm.oy);
    ctx.restore();
  }
}

/* ---------------- 4) 인코딩 ---------------- */

async function pickVideoConfig(W, H, fps) {
  const bitrate = Math.round(W * H * fps * 0.14); // 1080×1920·30fps ≈ 8.7Mbps
  const levels = fps > 30 ? ['2a', '33', '28'] : ['28', '2a', '33'];
  const codecs = [];
  for (const p of ['6400', '4d00', '42e0']) for (const l of levels) codecs.push(`avc1.${p}${l}`);
  for (const codec of codecs) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch (e) { /* 다음 후보 */ }
  }
  return null;
}
async function pickAudioConfig() {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: 160000 };
    try {
      if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux };
    } catch (e) { /* 다음 후보 */ }
  }
  return null;
}

async function encodeMp4({ W, H, fps, tl, mix, onProgress }) {
  const vcfg = await pickVideoConfig(W, H, fps);
  if (!vcfg) throw new Error('이 브라우저에서 H.264 영상 인코딩을 쓸 수 없어요. Edge나 Chrome 최신 버전에서 해 주세요.');
  const acfg = mix ? await pickAudioConfig() : null;

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: SR } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, meta) => muxer.addVideoChunk(c, meta), error: (e) => { encErr = e; } });
  const aenc = acfg ? new AudioEncoder({ output: (c, meta) => muxer.addAudioChunk(c, meta), error: (e) => { encErr = e; } }) : null;
  EXP.cleanup.push(() => {
    for (const enc of [venc, aenc]) if (enc && enc.state !== 'closed') try { enc.close(); } catch (e) { /* 이미 닫힘 */ }
  });
  venc.configure(vcfg);

  // 소리 먼저(빠름)
  if (aenc) {
    aenc.configure(acfg.cfg);
    const a = mix.getChannelData(0), b = mix.getChannelData(1);
    const block = 4800;
    for (let off = 0; off < mix.length; off += block) {
      const n = Math.min(block, mix.length - off);
      const data = new Float32Array(n * 2);
      data.set(a.subarray(off, off + n), 0);
      data.set(b.subarray(off, off + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / SR) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
    aenc.close();
  }

  // 그림
  const ms = makeMeasureStage(W, H);
  EXP.cleanup.push(() => ms.remove());
  onProgress(0, '그림 재료 불러오는 중…');
  const assets = await prepareAssets();
  const cache = makeCache(ms, assets, W, H);
  const canvas = canvasOf(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const N = Math.max(1, Math.ceil(tl.total * fps));
  const started = performance.now();
  for (let n = 0; n < N; n++) {
    checkCancel();
    if (encErr) throw encErr;
    await drawFrame(ctx, W, H, n / fps, tl, assets, cache);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: n % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    if (n % 3 === 0) {
      const el = (performance.now() - started) / 1000;
      const left = n > 10 ? (el / n) * (N - n) : null;
      onProgress(n / N, `${n} / ${N} 프레임${left !== null ? ` · 약 ${Math.ceil(left)}초 남음` : ''}`);
      await nextTick();
    }
  }
  await venc.flush();
  if (encErr) throw encErr;
  venc.close();
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), audioCodec: acfg ? acfg.mux : null };
}

/* ---------------- 전체 흐름 ---------------- */

async function runExport(opts) {
  EXP.running = true;
  EXP.cancelled = false;
  EXP.cleanup = [];
  stopPlayback();
  deselectLayer();
  const { w: W, h: H } = exportSize(opts.res);
  const notes = [];
  try {
    if (!state.scenes.length) throw new Error('장면이 없어요.');
    if (!window.VideoEncoder || !window.AudioEncoder || !window.VideoFrame) {
      throw new Error('이 브라우저는 영상 인코딩(WebCodecs)을 지원하지 않아요. Edge나 Chrome 최신 버전에서 해 주세요.');
    }

    // 1) 목소리
    let narration = null, tl;
    if (!ttsNeeded() && opts.voice !== 'none') {
      opts.voice = 'none';
      notes.push('모든 문장이 녹음 파일이라 TTS 녹음 없이 만들었어요.');
    }
    if (opts.voice === 'record') {
      exUI.step('record', '목소리를 실제로 읽으며 녹음하는 중… (실시간, 다른 소리가 나지 않게 해 주세요)');
      narration = await recordNarration((p, txt) => exUI.progress(p, txt));
      lastNarration = narration;
    } else if (opts.voice === 'reuse' && lastNarration && lastNarration.key === narrationKey()) {
      narration = lastNarration;
    }
    tl = narration ? timelineFromLog(narration.log) : timelineVirtual();
    checkCancel();

    // 2) 소리
    exUI.step('mix', '목소리 · 효과음 · 영상 소리를 섞는 중…');
    exUI.progress(0.3, '');
    const hasSound = state.scenes.some((sc) => (sc.sfx && sc.sfx.length) || (sc.voice && !sc.silent)
      || (sc.media && sc.media.type === 'video' && +sc.media.volume > 0));
    let mix = null;
    if (narration || hasSound) {
      const r = await mixAudio(tl, narration);
      mix = r.buffer;
      if (r.missingVideoAudio) notes.push('일부 영상은 소리를 읽을 수 없어 영상 소리 없이 넣었어요.');
      if (r.missingVoice) notes.push(`녹음 파일 ${r.missingVoice}개를 읽지 못해 그 문장은 소리 없이 넣었어요.`);
    }
    checkCancel();

    // 3) 4) 그림 + 인코딩
    exUI.step('video', `영상 만드는 중… (${W}×${H}, ${opts.fps}fps)`);
    const { blob, audioCodec } = await encodeMp4({ W, H, fps: opts.fps, tl, mix, onProgress: (p, txt) => exUI.progress(p, txt) });
    if (audioCodec === 'opus') notes.push('이 브라우저가 AAC 인코딩을 지원하지 않아 소리를 Opus로 넣었어요. 일부 플레이어(아이폰 기본 앱 등)에서는 소리가 안 날 수 있어요.');
    if (!narration && ttsNeeded()) notes.push('TTS 목소리 없이 만들었어요.');
    exUI.done(blob, tl.total, W, H, notes);
  } catch (e) {
    if (e instanceof Cancelled) exUI.cancelled();
    else { console.error(e); exUI.error(e.message || String(e)); }
  } finally {
    P.rec = null;
    for (const fn of EXP.cleanup.reverse()) { try { fn(); } catch (e) { /* 정리 중 오류는 무시 */ } }
    EXP.cleanup = [];
    EXP.running = false;
  }
}

/* ---------------- 화면 ---------------- */

const exUI = {
  modal: null,
  url: null,
  open() {
    if (EXP.running) { this.modal.hidden = false; return; }
    if (!state.scenes.length) { toast('먼저 장면을 만들어 주세요.'); return; }
    this.show('setup');
    const need = ttsNeeded();
    const reuse = need && lastNarration && lastNarration.key === narrationKey();
    const setOpt = (v, on) => {
      const input = $(`input[name="exVoice"][value="${v}"]`);
      input.disabled = !on;
      input.closest('label').classList.toggle('disabled', !on);
    };
    setOpt('record', need);
    setOpt('reuse', reuse);
    $('#exReuseNote').textContent = reuse ? '(실시간 녹음 없이 바로 만들어요)' : '(아직 없음 · 대본이나 목소리를 바꾸면 다시 녹음해야 해요)';
    $('#exVoiceNote').hidden = need;
    $(`input[name="exVoice"][value="${!need ? 'none' : reuse ? 'reuse' : 'record'}"]`).checked = true;
    this.updateSummary();
    this.modal.hidden = false;
  },
  close() {
    if (EXP.running) return;
    this.modal.hidden = true;
    $('#exVideo').removeAttribute('src');
    $('#exVideo').load();
  },
  show(view) {
    for (const v of ['setup', 'run', 'done']) $('#ex' + v[0].toUpperCase() + v.slice(1)).hidden = v !== view;
  },
  updateSummary() {
    const res = +$('#exRes').value;
    const { w, h } = exportSize(res);
    const voice = $('input[name="exVoice"]:checked').value;
    const total = timings().total;
    $('#exHelp').hidden = voice !== 'record';
    $('#exSummary').textContent = `${w}×${h} · ${state.aspect} · 약 ${Math.ceil(total)}초` +
      (voice === 'record' ? ` · 목소리 녹음에 약 ${Math.ceil(total + 2)}초(실시간) 걸려요` : '');
  },
  step(name, text) {
    this.show('run');
    const order = ['record', 'mix', 'video'];
    const at = order.indexOf(name);
    $$('#exRun [data-step]').forEach((el) => {
      const k = order.indexOf(el.dataset.step);
      el.classList.toggle('on', k === at);
      el.classList.toggle('past', k < at);
    });
    $('#exPhase').textContent = text;
    this.progress(0, '');
  },
  progress(p, text) {
    $('#exBar').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
    $('#exPct').textContent = Math.round(clamp(p, 0, 1) * 100) + '%' + (text ? ' · ' + text : '');
  },
  done(blob, dur, W, H, notes) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.show('done');
    $('#exVideo').src = this.url;
    const name = (state.title || '숏츠').replace(/[\\/:*?"<>|]+/g, '_') + '.mp4';
    const a = $('#exDownload');
    a.href = this.url;
    a.download = name;
    $('#exInfo').textContent = `${name} · ${W}×${H} · ${dur.toFixed(1)}초 · ${(blob.size / 1048576).toFixed(1)}MB` + (notes.length ? '\n' + notes.join('\n') : '');
    a.click(); // 바로 저장
  },
  error(msg) {
    this.show('setup');
    toast('내보내기 실패: ' + msg, null, 9000);
    $('#exError').textContent = msg;
    $('#exError').hidden = false;
  },
  cancelled() {
    this.show('setup');
    toast('내보내기를 취소했어요.');
  },
};

function bindExport() {
  exUI.modal = $('#exportModal');
  $('#exportBtn').addEventListener('click', () => { $('#exError').hidden = true; exUI.open(); });
  exUI.modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-ex="close"]') || e.target === exUI.modal) exUI.close();
  });
  $('#exRes').addEventListener('change', () => exUI.updateSummary());
  $$('input[name="exVoice"]').forEach((r) => r.addEventListener('change', () => exUI.updateSummary()));
  $('#exStart').addEventListener('click', () => {
    $('#exError').hidden = true;
    runExport({
      res: +$('#exRes').value,
      fps: +$('#exFps').value,
      voice: $('input[name="exVoice"]:checked').value,
    });
  });
  $('#exCancel').addEventListener('click', () => {
    EXP.cancelled = true;
    $('#exPhase').textContent = '취소하는 중…';
    if (P.rec) stopPlayback();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !exUI.modal.hidden) exUI.close(); });
}

bindExport();
