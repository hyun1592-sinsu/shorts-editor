'use strict';

/* =========================================================
   영상 다듬기(모달) — 앞뒤 자르기 · 중간 잘라내기
   원본 파일은 그대로 두고, 남길 구간만 media.segs = [{ s, e }]로 기억한다.
   모달 안에서는 앞쪽 시작(trimS) · 뒤쪽 끝(trimE) · 중간에 잘라낸 곳(cuts)으로 따로 다뤄서,
   손잡이를 다시 넓히면 잘랐던 앞뒤가 되살아나고, 중간 잘라낸 곳은 하나씩 되살릴 수 있다.
   app.js의 전역(state, mediaURL, videoSegs …)을 그대로 씀.
   ========================================================= */

const VE = {
  sc: null, m: null, dur: 0,
  trimS: 0, trimE: 0, cuts: [],
  selA: null, selB: null,
  raf: 0, token: 0, drag: null,
};
const MIN_LEN = 0.2; // 남길 영상의 최소 길이(초)

const veVideo = () => $('#veVideo');
const fmtT = (t) => fmtTime(Math.max(0, t || 0));

/* 남길 구간 = [앞 시작, 뒤 끝]에서 중간 잘라낸 곳들을 뺀 나머지 */
function veSegs() {
  let segs = [{ s: VE.trimS, e: VE.trimE }];
  for (const [a, b] of VE.cuts) {
    const out = [];
    for (const g of segs) {
      if (b <= g.s || a >= g.e) { out.push(g); continue; }
      if (a > g.s) out.push({ s: g.s, e: a });
      if (b < g.e) out.push({ s: b, e: g.e });
    }
    segs = out;
  }
  return segs.filter((g) => g.e - g.s > 0.04).map((g) => ({ s: +g.s.toFixed(3), e: +g.e.toFixed(3) }));
}

/* WebM 등 길이를 바로 알려 주지 않는 영상 */
async function realDuration(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise((res) => {
    const done = () => { v.removeEventListener('durationchange', done); res(); };
    v.addEventListener('durationchange', done);
    v.currentTime = 1e9;
    setTimeout(done, 3000);
  });
  const d = isFinite(v.duration) ? v.duration : v.currentTime;
  v.currentTime = 0;
  return d || 1;
}

async function openVideoEditor(sceneId) {
  const sc = findScene(sceneId);
  const m = sc && sc.media;
  if (!m || m.type !== 'video') return;
  stopPlayback();
  const url = await mediaURL(m.mediaId);
  if (!url) { toast('영상 파일을 찾을 수 없어요.'); return; }
  const token = ++VE.token;
  const v = veVideo();
  v.src = url;
  v.muted = false;
  await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; });
  if (token !== VE.token) return;
  if (v.error) { toast('이 영상을 열 수 없어요.'); return; }
  VE.sc = sc;
  VE.m = m;
  VE.dur = await realDuration(v);
  // 저장된 남길 구간 → 앞 시작 · 뒤 끝 · 중간 잘라낸 곳
  const segs = videoSegs(m, VE.dur).map((g) => ({ s: clamp(g.s, 0, VE.dur), e: clamp(g.e, 0, VE.dur) }));
  VE.trimS = segs[0].s;
  VE.trimE = segs[segs.length - 1].e;
  VE.cuts = segs.slice(1).map((g, k) => [segs[k].e, g.s]);
  VE.selA = VE.selB = null;
  $('#veName').textContent = `${sceneIndex(sc.id) + 1}번 장면 · ${m.name || '영상'}`;
  $('#videoEditModal').hidden = false;
  v.currentTime = VE.trimS;
  veRender();
  veLoop();
  veStrip(url, token);
}

function closeVideoEditor() {
  VE.token++;
  cancelAnimationFrame(VE.raf);
  const v = veVideo();
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#videoEditModal').hidden = true;
  VE.sc = VE.m = null;
}

async function applyVideoEdit() {
  const m = VE.m;
  if (!m) return;
  const segs = veSegs();
  const whole = segs.length === 1 && segs[0].s < 0.05 && segs[0].e > VE.dur - 0.05;
  if (whole) delete m.segs; else m.segs = segs;
  // 카드·타임라인 그림을 첫 남길 장면으로
  try {
    const v = veVideo();
    v.pause();
    await seekTo(v, segs[0].s + 0.05);
    m.thumb = drawThumb(v, v.videoWidth, v.videoHeight);
  } catch (e) { /* 그림은 예전 것 유지 */ }
  const sc = VE.sc;
  closeVideoEditor();
  const node = stageNode();
  if (node && node.dataset.mid === m.mediaId) node.currentTime = segs[0].s;
  refreshCardMedia();
  renderTimeline();
  renderStage();
  save();
  toast(whole ? '영상을 원래대로 전부 써요.'
    : `${sceneIndex(sc.id) + 1}번 장면 영상: ${segsDuration(segs).toFixed(1)}초만 남겼어요. (원본 파일은 그대로예요)`);
}

function seekTo(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 2000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

/* ---------- 그리기 ---------- */

const pctOf = (t) => (clamp(t, 0, VE.dur) / VE.dur) * 100 + '%';

function veRender() {
  const dur = VE.dur;
  const segs = veSegs();
  const marks = $('#veMarks');
  marks.innerHTML = '';
  // 잘려 나간 곳(남길 구간의 나머지)
  let prev = 0;
  const removed = [];
  for (const g of segs) { if (g.s > prev + 0.01) removed.push([prev, g.s]); prev = g.e; }
  if (prev < dur - 0.01) removed.push([prev, dur]);
  for (const [a, b] of removed) {
    const el = document.createElement('div');
    el.className = 've-removed';
    el.style.left = pctOf(a);
    el.style.width = ((b - a) / dur) * 100 + '%';
    const middle = a > VE.trimS + 0.01 && b < VE.trimE - 0.01;
    if (middle) {
      el.innerHTML = '<button type="button" class="ve-restore" title="이 부분 되살리기">↺</button>';
      el.dataset.a = a;
      el.dataset.b = b;
    }
    marks.append(el);
  }
  // 고른 구간
  const sel = $('#veSel');
  if (VE.selA !== null) {
    const a = VE.selB === null ? VE.selA : Math.min(VE.selA, VE.selB);
    const b = VE.selB === null ? VE.selA : Math.max(VE.selA, VE.selB);
    sel.hidden = false;
    sel.style.left = pctOf(a);
    sel.style.width = Math.max(0.3, ((b - a) / dur) * 100) + '%';
  } else sel.hidden = true;
  $('#veTrimL').style.left = pctOf(VE.trimS);
  $('#veTrimR').style.left = pctOf(VE.trimE);

  const keep = segsDuration(segs);
  const parts = [];
  if (VE.trimS > 0.05) parts.push(`앞 ${VE.trimS.toFixed(1)}초`);
  if (VE.trimE < dur - 0.05) parts.push(`뒤 ${(dur - VE.trimE).toFixed(1)}초`);
  const mids = removed.filter(([a, b]) => a > VE.trimS + 0.01 && b < VE.trimE - 0.01).length;
  if (mids) parts.push(`중간 ${mids}군데`);
  $('#veSum').textContent = `남길 길이 ${keep.toFixed(1)}초 / 원본 ${dur.toFixed(1)}초` + (parts.length ? ` · 잘라낸 곳: ${parts.join(', ')}` : ' · 아직 자르지 않았어요');
  const hasSel = VE.selA !== null && VE.selB !== null && Math.abs(VE.selB - VE.selA) >= 0.05;
  $('#veCut').disabled = !hasSel;
  $('#veSelClear').disabled = VE.selA === null;
  $('#veSelInfo').textContent = VE.selA === null ? '잘라낼 구간: 아직 안 고름'
    : VE.selB === null ? `잘라낼 구간: ${fmtT(VE.selA)} ~ (끝 지점을 고르세요)`
    : `잘라낼 구간: ${fmtT(Math.min(VE.selA, VE.selB))} ~ ${fmtT(Math.max(VE.selA, VE.selB))} (${Math.abs(VE.selB - VE.selA).toFixed(1)}초)`;
}

/* 재생 위치 표시 + '잘라낸 곳 건너뛰며 보기' */
function veLoop() {
  cancelAnimationFrame(VE.raf);
  const v = veVideo();
  const tick = () => {
    if ($('#videoEditModal').hidden) return;
    const t = v.currentTime;
    $('#veHead').style.left = pctOf(t);
    $('#veTime').textContent = `${fmtT(t)} / ${fmtT(VE.dur)}`;
    $('#vePlay').classList.toggle('playing', !v.paused);
    if (!v.paused && $('#veSkip').checked && !VE.drag) {
      const segs = veSegs();
      if (!segs.some((g) => t >= g.s - 0.05 && t < g.e - 0.03)) {
        const next = segs.find((g) => g.s >= t - 0.05);
        if (next) v.currentTime = next.s;
        else { v.pause(); v.currentTime = segs[segs.length - 1].e; } // 남길 영상의 끝에서 멈춤
      }
    }
    VE.raf = requestAnimationFrame(tick);
  };
  VE.raf = requestAnimationFrame(tick);
}

/* 위쪽 줄에 영상 장면 몇 장 */
async function veStrip(url, token) {
  const cv = $('#veStrip');
  const w = cv.clientWidth || 700, h = cv.clientHeight || 56;
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, w, h);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  await new Promise((res) => { v.onloadeddata = res; v.onerror = res; });
  if (!v.videoWidth) return;
  const tw = Math.max(20, Math.round((h * v.videoWidth) / v.videoHeight));
  const n = Math.ceil(w / tw);
  for (let k = 0; k < n; k++) {
    if (token !== VE.token) return;
    await seekTo(v, Math.min(VE.dur - 0.05, ((k + 0.5) / n) * VE.dur));
    ctx.drawImage(v, k * tw, 0, tw, h);
  }
  v.removeAttribute('src');
  v.load();
}

/* ---------- 조작 ---------- */

function veTimeAt(clientX) {
  const r = $('#veTrack').getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * VE.dur;
}
function veSetTrim(which, t) {
  if (which === 'L') VE.trimS = clamp(t, 0, VE.trimE - MIN_LEN);
  else VE.trimE = clamp(t, VE.trimS + MIN_LEN, VE.dur);
}
function veCutSelection() {
  if (VE.selA === null || VE.selB === null) return;
  const a = Math.min(VE.selA, VE.selB), b = Math.max(VE.selA, VE.selB);
  const before = VE.cuts;
  VE.cuts = [...VE.cuts, [a, b]];
  if (segsDuration(veSegs()) < MIN_LEN) {
    VE.cuts = before;
    toast('영상을 전부 잘라낼 수는 없어요.');
    return;
  }
  VE.selA = VE.selB = null;
  const v = veVideo();
  if (v.currentTime > a && v.currentTime < b) v.currentTime = b;
  veRender();
}

function bindVideoEditor() {
  const modal = $('#videoEditModal');
  const v = veVideo();
  const track = $('#veTrack');

  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-ve="close"]') || e.target === modal) closeVideoEditor();
  });
  $('#veApply').addEventListener('click', applyVideoEdit);
  const togglePlayVE = () => {
    if (v.paused) {
      const segs = veSegs();
      const t = v.currentTime;
      if ($('#veSkip').checked && !segs.some((g) => t >= g.s - 0.05 && t < g.e - 0.03)) {
        const next = segs.find((g) => g.s >= t - 0.05);
        v.currentTime = (next || segs[0]).s;
      }
      v.play().catch(() => {});
    } else v.pause();
  };
  $('#vePlay').addEventListener('click', togglePlayVE);

  // 줄을 누르거나 끌면 그 위치로 / 양 끝 손잡이를 끌면 앞뒤 자르기
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.ve-restore')) return;
    e.preventDefault();
    const h = e.target.closest('.ve-trim');
    VE.drag = { mode: h ? h.dataset.side : 'seek', wasPlaying: !v.paused };
    v.pause();
    track.setPointerCapture(e.pointerId);
    const t = veTimeAt(e.clientX);
    if (VE.drag.mode === 'seek') v.currentTime = t;
  });
  track.addEventListener('pointermove', (e) => {
    if (!VE.drag) return;
    const t = veTimeAt(e.clientX);
    if (VE.drag.mode === 'seek') v.currentTime = t;
    else {
      veSetTrim(VE.drag.mode, t);
      v.currentTime = VE.drag.mode === 'L' ? VE.trimS : VE.trimE; // 자르는 지점의 장면 보여 주기
      veRender();
    }
  });
  const endDrag = () => {
    if (!VE.drag) return;
    const d = VE.drag;
    VE.drag = null;
    if (d.mode === 'seek' && d.wasPlaying) v.play().catch(() => {});
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  $('#veMarks').addEventListener('click', (e) => {
    const b = e.target.closest('.ve-restore');
    if (!b) return;
    const el = b.closest('.ve-removed');
    const a = +el.dataset.a, z = +el.dataset.b;
    VE.cuts = VE.cuts.filter(([x, y]) => !(x < z - 0.001 && y > a + 0.001)); // 이 틈을 만든 잘라내기 취소
    veRender();
  });

  // 버튼
  $('#veStartHere').addEventListener('click', () => { veSetTrim('L', v.currentTime); veRender(); });
  $('#veEndHere').addEventListener('click', () => { veSetTrim('R', v.currentTime); veRender(); });
  $('#veMarkA').addEventListener('click', () => { VE.selA = v.currentTime; if (VE.selB !== null && Math.abs(VE.selB - VE.selA) < 0.01) VE.selB = null; veRender(); });
  $('#veMarkB').addEventListener('click', () => {
    if (VE.selA === null) VE.selA = v.currentTime; else VE.selB = v.currentTime;
    veRender();
  });
  $('#veCut').addEventListener('click', veCutSelection);
  $('#veSelClear').addEventListener('click', () => { VE.selA = VE.selB = null; veRender(); });
  $('#veReset').addEventListener('click', () => {
    VE.trimS = 0;
    VE.trimE = VE.dur;
    VE.cuts = [];
    VE.selA = VE.selB = null;
    veRender();
  });
  const step = (d) => { v.pause(); v.currentTime = clamp(v.currentTime + d, 0, VE.dur); };
  $('#veBack').addEventListener('click', () => step(-1 / 30));
  $('#veFwd').addEventListener('click', () => step(1 / 30));

  // 모달이 열려 있을 때 단축키(편집기 본래 단축키보다 먼저)
  document.addEventListener('keydown', (e) => {
    if (modal.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') closeVideoEditor();
    else if (k === ' ') togglePlayVE();
    else if (k === 'ArrowLeft') step(e.shiftKey ? -1 : -1 / 30);
    else if (k === 'ArrowRight') step(e.shiftKey ? 1 : 1 / 30);
    else if (k === 'i' || k === 'I') $('#veMarkA').click();
    else if (k === 'o' || k === 'O') $('#veMarkB').click();
    else if (k === 'Delete' || k === 'Backspace') veCutSelection();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

bindVideoEditor();
