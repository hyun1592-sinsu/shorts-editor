'use strict';

/* =========================================================
   화면 칸 크기 조절
   - 왼쪽 칸 | 미리보기 | 장면 목록 | (같이 쓰기) 녹음기 칸 사이 경계를 좌우로 끌기
   - 미리보기와 타임라인 사이 경계를 위아래로 끌기
   - 크기는 이 기기에 기억, 경계를 두 번 누르면 처음 크기로
   ========================================================= */

const LAYOUT_KEY = 'shorts-layout';
const MIN_CENTER = 300; // 미리보기 칸은 이보다 좁아지지 않게
const LIMITS = { left: [200, 560], right: [240, 640], dock: [300, 900], tl: [110, 520] };

let sizes = {};
try { sizes = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {}; } catch (e) { sizes = {}; }

const layoutEl = () => $('.layout');
const clampTo = (v, [a, b]) => Math.max(a, Math.min(b, v));

function applySizes() {
  const L = layoutEl();
  for (const k of ['left', 'right', 'dock']) {
    if (sizes[k]) L.style.setProperty(`--w-${k}`, sizes[k] + 'px');
    else L.style.removeProperty(`--w-${k}`);
  }
  const tw = $('.timeline-wrap');
  if (sizes.tl) {
    tw.style.height = sizes.tl + 'px';
    tw.style.overflowY = 'auto';
    // 타임라인을 키우면 장면 칸도 같이 커지게 (머리글·눈금 몫을 빼고)
    L.style.setProperty('--tl-blocks-h', Math.max(56, sizes.tl - 74) + 'px');
  } else {
    tw.style.height = '';
    tw.style.overflowY = '';
    L.style.removeProperty('--tl-blocks-h');
  }
}

function saveSizes() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes)); } catch (e) { /* 기억 못 해도 동작은 함 */ }
}

/* 경계 손잡이 위치를 실제 칸 위치에 맞춤 */
function placeGutters() {
  const L = layoutEl().getBoundingClientRect();
  const edge = (sel, side) => { const el = $(sel); if (!el || el.hidden || !el.offsetWidth) return null; return el.getBoundingClientRect()[side] - L.left; };
  const pos = {
    left: edge('.panel.left', 'right'),
    right: edge('.panel.right', 'left'),
    dock: edge('#recDock', 'left'),
  };
  for (const [k, x] of Object.entries(pos)) {
    const g = $(`.gutter[data-g="${k}"]`);
    g.hidden = x == null;
    if (x != null) g.style.left = x + 'px';
  }
  const tw = $('.timeline-wrap');
  $('.gutter[data-g="tl"]').style.top = tw.offsetTop + 'px';
}

function startDrag(e, key) {
  e.preventDefault();
  const g = e.currentTarget;
  g.setPointerCapture(e.pointerId);
  g.classList.add('drag');
  document.body.classList.add('resizing');
  document.body.style.cursor = key === 'tl' ? 'row-resize' : 'col-resize';
  const L = layoutEl().getBoundingClientRect();
  const center = $('.center').getBoundingClientRect();
  const leftW = $('.panel.left').offsetWidth, rightW = $('.panel.right').offsetWidth;
  const dock = $('#recDock'), dockW = dock.hidden ? 0 : dock.offsetWidth;

  const move = (ev) => {
    if (key === 'left') {
      const max = Math.min(LIMITS.left[1], L.width - rightW - dockW - MIN_CENTER);
      sizes.left = Math.round(clampTo(ev.clientX - L.left, [LIMITS.left[0], max]));
    } else if (key === 'right') {
      const right = L.right - dockW;
      const max = Math.min(LIMITS.right[1], L.width - leftW - dockW - MIN_CENTER);
      sizes.right = Math.round(clampTo(right - ev.clientX, [LIMITS.right[0], max]));
    } else if (key === 'dock') {
      const max = Math.min(LIMITS.dock[1], L.width - leftW - rightW - MIN_CENTER);
      sizes.dock = Math.round(clampTo(L.right - ev.clientX, [LIMITS.dock[0], max]));
    } else {
      const max = Math.min(LIMITS.tl[1], center.height - 260); // 미리보기·재생 버튼 자리는 남김
      sizes.tl = Math.round(clampTo(center.bottom - ev.clientY, [LIMITS.tl[0], max]));
    }
    applySizes();
    placeGutters();
  };
  const up = () => {
    g.classList.remove('drag');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', up);
    g.removeEventListener('pointercancel', up);
    saveSizes();
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', up);
  g.addEventListener('pointercancel', up);
}

function bindResize() {
  const titles = {
    left: '끌어서 왼쪽 칸 너비 조절 · 두 번 누르면 처음대로',
    right: '끌어서 장면 목록 너비 조절 · 두 번 누르면 처음대로',
    dock: '끌어서 녹음기 칸 너비 조절 · 두 번 누르면 처음대로',
    tl: '끌어서 타임라인 높이 조절 · 두 번 누르면 처음대로',
  };
  for (const key of ['left', 'right', 'dock', 'tl']) {
    const g = document.createElement('div');
    g.className = 'gutter ' + (key === 'tl' ? 'row' : 'col');
    g.dataset.g = key;
    g.title = titles[key];
    g.addEventListener('pointerdown', (e) => startDrag(e, key));
    g.addEventListener('dblclick', () => { delete sizes[key]; applySizes(); saveSizes(); placeGutters(); });
    (key === 'tl' ? $('.center') : layoutEl()).appendChild(g);
  }
  applySizes();
  const ro = new ResizeObserver(placeGutters);
  for (const sel of ['.layout', '.panel.left', '.panel.right', '#recDock', '.center', '.timeline-wrap']) ro.observe($(sel));
  new MutationObserver(placeGutters).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  placeGutters();
}

bindResize();
