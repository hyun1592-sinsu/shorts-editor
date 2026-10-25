'use strict';

/* =========================================================
   프로젝트 저장 / 불러오기 (zip 하나)
   zip 안:
     project.json  — 작업 내용(state)과 파일 목록 { id: { path, type, store } }
     media/…       — 장면 화면, 얹은 이미지, 문장별 녹음 파일
     fonts/…       — 글꼴 보관함
     sfx/…         — 효과음 보관함
   외부 라이브러리 없이 압축하지 않는(STORE) zip을 직접 만든다. 이미지·영상·소리는 이미 압축돼 있어서 차이가 거의 없음.
   불러올 때는 다른 프로그램으로 다시 압축한 zip(DEFLATE)도 읽는다.
   app.js의 전역(state, mediaGet …)을 그대로 씀.
   ========================================================= */

const PROJECT_FORMAT = 'shorts-editor-project';

/* ---------------- zip ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* entries: [{ name, data: Uint8Array | Blob }] → zip Blob */
async function makeZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const bytes = e.data instanceof Uint8Array ? e.data : new Uint8Array(await e.data.arrayBuffer());
    const name = enc.encode(e.name);
    const crc = crc32(bytes);
    const size = bytes.length;
    if (offset + size > 0xfffffff0) throw new Error('프로젝트가 4GB보다 커서 zip 하나로 저장할 수 없어요.');

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);       // 필요한 버전
    lh.setUint16(6, 0x0800, true);   // 이름은 UTF-8
    lh.setUint16(8, 0, true);        // STORE(압축 안 함)
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, bytes);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);  // 나머지(추가 필드·주석·속성)는 0
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 파일이 아니거나 손상됐어요.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 파일이 손상됐어요.');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    files.set(name, { method, data: buf.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: [...files.keys()],
    async get(name) {
      const f = files.get(name);
      if (!f) return null;
      if (f.method === 0) return f.data;
      if (f.method === 8) { // 다른 프로그램으로 다시 압축한 zip
        const stream = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`지원하지 않는 압축 방식이에요 (${name}).`);
    },
  };
}

/* ---------------- 저장 ---------------- */

const EXT_BY_TYPE = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/webm': '.webm',
  'font/ttf': '.ttf', 'font/otf': '.otf', 'font/woff': '.woff', 'font/woff2': '.woff2',
};
function extFor(blob, nameHint) {
  const m = /\.[a-z0-9]{1,5}$/i.exec(nameHint || '');
  return m ? m[0].toLowerCase() : EXT_BY_TYPE[blob.type] || '.bin';
}
const safeFileName = (s) => (s || '숏츠').replace(/[\\/:*?"<>|]+/g, '_').trim() || '숏츠';

async function saveProjectZip() {
  stopPlayback();
  if (typeof endEdit === 'function') endEdit();
  await flush();
  toast('프로젝트 파일 만드는 중…', null, 0);
  try {
    const files = {};
    const entries = [];
    let missing = 0;
    const add = async (store, folder, id, nameHint) => {
      if (!id || files[id]) return;
      const blob = await (store === 'fonts' ? fontGet(id) : store === 'sfx' ? sfxGet(id) : mediaGet(id));
      if (!blob) { missing++; return; }
      const path = `${folder}/${id}${extFor(blob, nameHint)}`;
      files[id] = { path, type: blob.type || '', store };
      entries.push({ name: path, data: blob });
    };
    for (const sc of state.scenes) {
      if (sc.media && sc.media.mediaId) await add('media', 'media', sc.media.mediaId, sc.media.name);
      if (sc.voice) await add('media', 'media', sc.voice.mediaId, sc.voice.name);
      for (const L of sc.layers || []) if (L.type === 'image') await add('media', 'media', L.mediaId, L.name);
    }
    for (const f of state.fonts) await add('fonts', 'fonts', f.id, f.fileName);
    for (const f of state.sfxLib) await add('sfx', 'sfx', f.id, f.fileName);

    const manifest = {
      format: PROJECT_FORMAT, version: 1, savedAt: new Date().toISOString(),
      app: '숏츠 자동 편집기', state: clone(state), files,
    };
    entries.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    const zip = await makeZip(entries);

    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = safeFileName(state.title) + '.zip';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`프로젝트를 저장했어요 · ${a.download} (${(zip.size / 1048576).toFixed(1)}MB, 파일 ${entries.length - 1}개)`
      + (missing ? ` · 찾을 수 없는 파일 ${missing}개는 빠졌어요.` : ''), null, 6000);
  } catch (e) {
    console.error(e);
    toast('프로젝트를 저장하지 못했어요: ' + e.message, null, 8000);
  }
}

/* ---------------- 불러오기 ---------------- */

const mergeById = (mine, theirs) => [...mine, ...(theirs || []).filter((x) => x && !mine.some((y) => y.id === x.id))];

/* 다른 곳에서 온 데이터라 화면에 그대로 쓰는 값은 확인해 둠 */
function sanitizeLoaded(st) {
  if (!Array.isArray(st.scenes)) throw new Error('프로젝트 파일에 장면 정보가 없어요.');
  st.scenes = st.scenes.filter((sc) => sc && typeof sc.id === 'string');
  for (const sc of st.scenes) {
    sc.text = String(sc.text || '');
    if (sc.media && sc.media.type === 'color') sc.media.color = safeColor(sc.media.color) || '#000000';
    if (sc.voice && !(+sc.voice.dur > 0)) sc.voice = null;
    for (const L of sc.layers || []) if (L.runs) L.runs = L.runs.map((r) => ({ t: String(r.t || ''), c: safeColor(r.c) }));
  }
  return st;
}

async function loadProjectZip(file) {
  if (!confirm(`‘${file.name}’ 프로젝트를 열까요?\n지금 작업 중인 대본·장면·화면 파일은 이 프로젝트로 바뀝니다. (필요하면 먼저 「프로젝트 저장」을 해 두세요)\n글꼴·효과음 보관함과 저장한 스타일은 지금 것에 더해져요.`)) return;
  stopPlayback();
  if (typeof endEdit === 'function') endEdit();
  toast('프로젝트 여는 중…', null, 0);
  try {
    const zip = await readZip(file);
    const pj = zip.names.find((n) => n === 'project.json' || n.endsWith('/project.json'));
    if (!pj) throw new Error('이 zip에는 프로젝트 정보(project.json)가 없어요.');
    const prefix = pj.slice(0, -'project.json'.length); // 폴더째 다시 압축한 경우
    const man = JSON.parse(new TextDecoder().decode(await zip.get(pj)));
    if (!man || man.format !== PROJECT_FORMAT || !man.state) throw new Error('숏츠 자동 편집기 프로젝트 파일이 아니에요.');
    const loaded = sanitizeLoaded(man.state);

    // 파일을 브라우저 저장소에
    let missing = 0;
    const haveFont = new Set(state.fonts.map((f) => f.id));
    const haveSfx = new Set(state.sfxLib.map((f) => f.id));
    for (const [id, f] of Object.entries(man.files || {})) {
      if (!/^[\w-]+$/.test(id) || !f || typeof f.path !== 'string') continue;
      if ((f.store === 'fonts' && haveFont.has(id)) || (f.store === 'sfx' && haveSfx.has(id))) continue;
      const bytes = await zip.get(prefix + f.path);
      if (!bytes) { missing++; continue; }
      const blob = new Blob([bytes], { type: f.type || '' });
      if (f.store === 'fonts') await fontPut(id, blob);
      else if (f.store === 'sfx') await sfxPut(id, blob);
      else await mediaPut(id, blob);
    }

    // 작업 내용 바꾸기(보관함·스타일은 합침)
    const newFonts = (loaded.fonts || []).filter((f) => f && !haveFont.has(f.id));
    const libs = {
      fonts: mergeById(state.fonts, loaded.fonts),
      sfxLib: mergeById(state.sfxLib, loaded.sfxLib),
      layerStyles: mergeById(state.layerStyles, loaded.layerStyles),
    };
    dropUndo();
    lastDeletedLayer = null;
    selLayer = null;
    editingId = null;
    for (const u of urlCache.values()) URL.revokeObjectURL(u);
    urlCache.clear();
    voiceBufs.clear();
    stageKey = null;
    state = Object.assign(mergeDeep(clone(DEFAULT), loaded), libs);
    if (!findScene(state.selectedId)) state.selectedId = state.scenes.length ? state.scenes[0].id : null;

    for (const f of newFonts) {
      try { await registerFont(f, await fontGet(f.id)); fontErrors.delete(f.id); } catch (e) { fontErrors.add(f.id); }
    }
    syncControls();
    applySubStyle();
    fitStage();
    setTab(state.ui.leftTab || 'settings');
    structureChanged();
    await flush();
    gcMedia(); // 앞 프로젝트에서 쓰던 화면 파일 정리
    toast(`‘${state.title}’ 프로젝트를 열었어요 · 장면 ${state.scenes.length}개`
      + (missing ? ` · zip에 없는 파일 ${missing}개는 빠졌어요.` : ''), null, 6000);
  } catch (e) {
    console.error(e);
    toast('프로젝트를 열지 못했어요: ' + e.message, null, 8000);
  }
}

function bindProject() {
  $('#saveProject').addEventListener('click', saveProjectZip);
  $('#openProject').addEventListener('click', () => {
    const fi = $('#projectFileInput');
    fi.value = '';
    fi.click();
  });
  $('#projectFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadProjectZip(e.target.files[0]);
  });
}

bindProject();
