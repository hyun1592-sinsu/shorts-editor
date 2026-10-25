/* =========================================================
   숏츠 편집기 ↔ 녹음기 연결 파일 (녹음기 쪽에 붙이는 파일)

   녹음기 index.html 맨 아래에 한 줄 추가:
     <script src="recorder-bridge.js"></script>

   쓰는 법:
     ShortsBridge.onScript(({ title, scenes, selectedId }) => { ... })   // 편집기 장면 목록이 바뀔 때마다
         scenes: [{ id, no, text, silent, voice: { name, dur } | null }]
     ShortsBridge.onSelect(({ id, no }) => { ... })   // 편집기에서 장면을 골랐을 때
     ShortsBridge.select(no 또는 id)                    // 녹음기에서 문장을 고르면 편집기도 그 장면으로
     await ShortsBridge.sendVoice(no 또는 id, blob, '03_문장.wav')   // 녹음 파일을 그 장면에 넣기
     ShortsBridge.connected                              // 편집기와 연결돼 있으면 true
     ShortsBridge.onStatus((connected) => { ... })

   편집기 없이 녹음기만 따로 열면 아무 일도 하지 않아요 (녹음기는 원래대로 동작).
   ========================================================= */
(function () {
  'use strict';
  const VER = 1;
  const editor = window.parent !== window ? window.parent : window.opener;
  const subs = { script: [], select: [], status: [] };
  const waits = new Map();
  let origin = '*';
  let connected = false;
  let last = null;

  const emit = (k, v) => subs[k].forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
  const post = (msg) => { if (editor && !editor.closed) editor.postMessage({ sv: VER, ...msg }, origin); };
  const ref = (x) => (typeof x === 'string' ? { id: x } : { no: Number(x) });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!editor || e.source !== editor || !m || m.sv !== VER) return;
    origin = e.origin === 'null' ? '*' : e.origin; // 처음 답한 편집기 주소로만 보냄
    if (!connected) { connected = true; emit('status', true); }
    if (m.type === 'script') { last = m; emit('script', m); }
    else if (m.type === 'select') emit('select', m);
    else if (m.type === 'voice-ok' || m.type === 'voice-error') {
      const w = waits.get(m.ref);
      if (w) { waits.delete(m.ref); m.type === 'voice-ok' ? w.ok(m) : w.fail(new Error(m.reason || 'voice-error')); }
    }
  });

  window.ShortsBridge = {
    get connected() { return connected; },
    get script() { return last; },
    onScript(f) { subs.script.push(f); if (last) f(last); },
    onSelect(f) { subs.select.push(f); },
    onStatus(f) { subs.status.push(f); f(connected); },
    select(x) { post({ type: 'select', ...ref(x) }); },
    refresh() { post({ type: 'get-script' }); },
    sendVoice(x, blob, name) {
      if (!connected) return Promise.reject(new Error('편집기와 연결되어 있지 않아요'));
      const r = Math.random().toString(36).slice(2);
      return new Promise((ok, fail) => {
        waits.set(r, { ok, fail });
        post({ type: 'voice', ref: r, ...ref(x), name, mime: blob.type, data: blob });
        setTimeout(() => { if (waits.delete(r)) fail(new Error('편집기 응답이 없어요')); }, 20000);
      });
    },
  };

  if (editor) {
    // 편집기가 먼저 떠 있거나 나중에 떠도 잡히도록 몇 번 인사
    let n = 0;
    const hi = () => { if (connected || n++ > 20 || editor.closed) return; post({ type: 'hello', app: 'recorder' }); setTimeout(hi, 500); };
    hi();
    // 녹음만 창이 편집기와 끊기면 알려 줌
    setInterval(() => { if (connected && editor.closed) { connected = false; emit('status', false); } }, 2000);
  }
})();
