'use strict';

/* =========================================================
   녹음기 연결
   - 작업 모드: 편집만 · 같이 쓰기(오른쪽에 녹음기) · 녹음만(녹음기 따로 창)
   - 녹음기와 postMessage로 주고받음 (형식은 recorder/README.md)
     편집기 → 녹음기: script(장면 목록) · select(고른 장면) · voice-ok · voice-error
     녹음기 → 편집기: hello · get-script · select · voice(녹음 파일)
   - 이 편집기가 열어 둔 창(같이 쓰기 칸, 녹음만 창)이 보낸 것만 받음
   ========================================================= */

const BRIDGE_VER = 1;
const STUDIO_URL_KEY = 'shorts-rec-url'; // 내 목소리 스튜디오 주소 (기기마다 따로 저장)
const REC_SRC_KEY = 'shorts-rec-src';   // 같이 쓰기 · 녹음만에 여는 녹음기: quick | studio
const REC_MODE_KEY = 'shorts-rec-mode';
const STUDIO_URL_DEFAULT = 'http://127.0.0.1:8777/'; // PC에서 recorder/server.py를 켠 주소
const QUICK_REC_URL = 'recorder/quick.html';         // 간편 녹음기: 서버 없이 어느 기기에서나

const R = {
  mode: 'edit',
  popup: null,
  popupUrl: '',
  peers: new Set(), // hello를 보낸 창
  lastSig: '',
  fromRemote: false,
};

function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 동작은 함 */ } }

const studioUrl = () => lsGet(STUDIO_URL_KEY, STUDIO_URL_DEFAULT);
const recSrc = () => (lsGet(REC_SRC_KEY, 'quick') === 'studio' ? 'studio' : 'quick');
const recUrl = () => (recSrc() === 'studio' ? studioUrl() : new URL(QUICK_REC_URL, location.href).href);
const recName = () => (recSrc() === 'studio' ? '스튜디오' : '녹음기');
function recOrigin() {
  try {
    const o = new URL(recUrl(), location.href).origin;
    return o === 'null' ? '*' : o;
  } catch (e) { return '*'; }
}

const frameWin = () => { const f = $('#recFrame'); return f && f.getAttribute('src') ? f.contentWindow : null; };
const popupWin = () => (R.popup && !R.popup.closed ? R.popup : null);
const knownPeer = (w) => !!w && (w === frameWin() || w === popupWin());

function post(win, msg) {
  if (!win) return;
  try { win.postMessage({ sv: BRIDGE_VER, ...msg }, recOrigin()); } catch (e) { console.error(e); }
}
function broadcast(msg) {
  for (const w of [frameWin(), popupWin()]) if (w && R.peers.has(w)) post(w, msg);
}

/* ---------------- 장면 목록 보내기 ---------------- */

function scriptMsg() {
  return {
    type: 'script',
    title: state.title || '',
    selectedId: state.selectedId,
    scenes: state.scenes.map((sc, i) => ({
      id: sc.id,
      no: i + 1,
      text: sc.text,
      silent: !!sc.silent, // 나레이션 없는 장면 (녹음할 필요 없음)
      voice: sc.voice ? { name: sc.voice.name, dur: sc.voice.dur } : null,
    })),
  };
}

function sendScript(force = false) {
  const msg = scriptMsg();
  const sig = JSON.stringify([msg.title, msg.scenes]);
  if (!force && sig === R.lastSig) return;
  R.lastSig = sig;
  broadcast(msg);
}

/* 편집기에서 무엇이든 바뀌면 save()가 불리므로 거기에 얹어서 보냄 */
const _save = save;
save = function () {
  _save();
  if (R.peers.size) sendScript();
};

/* 편집기에서 장면을 고르면 녹음기도 같은 문장으로 */
const _selectScene = selectScene;
selectScene = function (id, opts) {
  _selectScene(id, opts);
  if (!R.fromRemote && R.peers.size && findScene(id)) {
    broadcast({ type: 'select', id, no: sceneIndex(id) + 1 });
  }
};

/* ---------------- 녹음기에서 온 것 받기 ---------------- */

function sceneFor(msg) {
  if (msg.id && findScene(msg.id)) return findScene(msg.id);
  const no = Number(msg.no);
  if (Number.isInteger(no) && no >= 1 && no <= state.scenes.length) return state.scenes[no - 1];
  return null;
}

async function receiveVoice(win, msg) {
  const sc = sceneFor(msg);
  const reply = (type, extra) => post(win, { type, ref: msg.ref, id: sc && sc.id, no: sc && sceneIndex(sc.id) + 1, ...extra });
  if (!sc) { reply('voice-error', { reason: 'no-scene' }); toast('녹음을 넣을 장면을 찾지 못했어요.'); return; }
  let blob = msg.data;
  if (blob instanceof ArrayBuffer) blob = new Blob([blob], { type: msg.mime || 'audio/wav' });
  if (!(blob instanceof Blob) || !blob.size) { reply('voice-error', { reason: 'no-data' }); return; }
  if (!audio()) { reply('voice-error', { reason: 'no-audio' }); return; }

  stopPlayback();
  const no = sceneIndex(sc.id) + 1;
  const name = String(msg.name || `${String(no).padStart(2, '0')}_녹음.${(blob.type.split('/')[1] || 'wav').split(';')[0]}`);
  if (!(await attachVoice(sc, blob, name))) {
    reply('voice-error', { reason: 'decode' });
    toast(`${no}번 장면 녹음 파일을 읽지 못했어요.`);
    return;
  }
  renderScenes();
  renderTimeline();
  renderStage();
  save();
  reply('voice-ok', { dur: sc.voice.dur });
  toast(`${no}번 장면에 녹음을 넣었어요 (${sc.voice.dur.toFixed(1)}초).`);
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object' || msg.sv !== BRIDGE_VER) return;
  if (!knownPeer(e.source)) return;
  const win = e.source;
  switch (msg.type) {
    case 'hello':
      R.peers.add(win);
      updateRecLink();
      post(win, scriptMsg());
      break;
    case 'get-script':
      post(win, scriptMsg());
      break;
    case 'select': {
      const sc = sceneFor(msg);
      if (!sc) break;
      R.fromRemote = true;
      try { selectScene(sc.id, { scroll: true }); } finally { R.fromRemote = false; }
      break;
    }
    case 'voice':
      receiveVoice(win, msg);
      break;
  }
});

/* ---------------- 작업 모드 ---------------- */

function updateRecLink() {
  const el = $('#recLink');
  [...R.peers].forEach((w) => { if (!knownPeer(w)) R.peers.delete(w); });
  const on = R.peers.size > 0;
  const opened = !!(frameWin() || popupWin());
  el.dataset.state = on ? 'on' : opened ? 'wait' : 'off';
  el.textContent = on ? `${recName()} 연결됨` : opened ? `${recName()} 기다리는 중` : '녹음기 꺼짐';
  el.title = on ? '대본과 녹음 파일이 자동으로 오가요' :
    opened ? (recSrc() === 'studio'
      ? `${recUrl()} 에서 응답이 없어요. 스튜디오 서버(server.py)가 켜져 있는지, ⚙의 주소가 맞는지 확인해 주세요.`
      : '간편 녹음기를 불러오는 중이에요.') :
      '녹음기를 쓰지 않는 중';
}

function openFrame() {
  const f = $('#recFrame');
  if (f.getAttribute('src') !== recUrl()) { R.peers.delete(f.contentWindow); f.src = recUrl(); }
}
function closeFrame() {
  const f = $('#recFrame');
  R.peers.delete(f.contentWindow);
  if (!f.getAttribute('src')) return;
  f.src = 'about:blank';
  f.removeAttribute('src'); // src가 없으면 꺼진 것으로 봄
}

function setMode(mode, { user = false } = {}) {
  R.mode = mode;
  lsSet(REC_MODE_KEY, mode);
  $$('.mode-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.body.classList.toggle('mode-both', mode === 'both');
  $('#recDock').hidden = mode !== 'both';

  if (mode === 'both') {
    openFrame();
  } else {
    closeFrame();
  }

  if (mode === 'rec' && user) {
    // 팝업은 버튼을 눌렀을 때만 열 수 있음
    if (popupWin() && R.popupUrl === recUrl()) popupWin().focus();
    else {
      R.popupUrl = recUrl();
      R.popup = window.open(recUrl(), 'shorts-recorder', 'width=520,height=860');
      if (!R.popup) toast('팝업이 막혔어요. 주소창 오른쪽에서 팝업을 허용해 주세요.', null, 5000);
    }
  } else if (mode === 'rec' && !popupWin()) {
    toast('「녹음만」을 한 번 더 누르면 녹음기 창이 열려요.', null, 4000);
  }
  // 편집만으로 바꿔도 따로 열린 녹음기 창은 닫지 않음 (녹음 중일 수 있으므로). 그 창이 보내는 녹음은 계속 받음
  fitStage();
  updateRecLink();
}

/* 녹음기를 바꾸면 열려 있는 칸·창도 새 녹음기로 */
function reopenRecorder(user) {
  if (R.mode === 'both') { closeFrame(); openFrame(); }
  if (R.mode === 'rec' && user) setMode('rec', { user: true });
  updateRecLink();
}

function setRecSrc(src, { user = false } = {}) {
  lsSet(REC_SRC_KEY, src);
  $('#recSrc').value = src;
  reopenRecorder(user);
}

function changeStudioUrl() {
  const now = studioUrl();
  const v = prompt('내 목소리 스튜디오 주소를 넣어 주세요. (이 기기에만 저장돼요)\n\n'
    + '· 스튜디오를 켠 PC에서: http://127.0.0.1:8777/\n'
    + '· 다른 기기(휴대폰·노트북)에서: Tailscale 주소 예) https://내PC이름.tailXXXX.ts.net/\n\n'
    + '비워 두고 확인하면 기본값으로 돌아가요.', now);
  if (v == null) return;
  if (!v.trim()) lsSet(STUDIO_URL_KEY, '');
  else {
    let url;
    try { url = new URL(v.trim(), location.href).href; } catch (e) { toast('주소 모양이 올바르지 않아요.'); return; }
    lsSet(STUDIO_URL_KEY, url);
  }
  if (recSrc() === 'studio') reopenRecorder(false);
  toast(`스튜디오 주소: ${studioUrl()}`);
}

function bindBridge() {
  $$('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, { user: true })));
  $('#recSettings').addEventListener('click', changeStudioUrl);
  $('#recSrc').value = recSrc();
  $('#recSrc').addEventListener('change', (e) => setRecSrc(e.target.value, { user: true }));
  $('#recFrame').addEventListener('load', () => { setTimeout(updateRecLink, 1500); });
  setInterval(updateRecLink, 2000); // 녹음만 창을 닫았는지 확인
  const saved = lsGet(REC_MODE_KEY, 'edit');
  setMode(['edit', 'both', 'rec'].includes(saved) ? saved : 'edit');
}

bindBridge();
