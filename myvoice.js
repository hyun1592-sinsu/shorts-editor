'use strict';

/* =========================================================
   목소리 입히기
   장면에 입힐 목소리를 한곳에서 고름:
   - 내 목소리 AI: 내 목소리 스튜디오(recorder/server.py)가 장면 문장을 내 목소리 WAV로 만들어 장면마다 넣음.
                   스튜디오에 이미 만들어 둔 같은 문장·같은 목소리(밤샘 일괄 등)가 있으면 새로 만들지 않고 바로 가져옴
   - 브라우저 목소리: 이 기기의 TTS 목소리로 읽음 (녹음 파일을 지운 장면은 TTS로 돌아감)
   - 직접 녹음: 간편 녹음기 · 스튜디오를 편집기 옆에 열어 녹음하면 장면에 바로 들어감
   적용 범위: 목소리가 없는 장면만 · 모든 장면 · 선택한 장면만
   ========================================================= */

const MV_PREF_KEY = 'shorts-myvoice';
const MV = { job: null, studio: null, secPerChar: 2.6, timer: null };

const mvUrl = (path) => new URL(path, new URL(studioUrl(), location.href)).href;
const mvLine = (text) => text.replace(/\s+/g, ' ').trim();

function mvPref(v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(MV_PREF_KEY) || '{}');
    localStorage.setItem(MV_PREF_KEY, JSON.stringify({ ...mvPref(), ...v }));
  } catch (e) { return {}; }
}

class StudioOffline extends Error {}

async function mvApi(method, path, body, timeoutMs = 0) {
  const ctl = timeoutMs ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(mvUrl(path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (e) {
    throw new StudioOffline(e.message);
  } finally {
    clearTimeout(t);
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  return path.startsWith('api/tts/audio/') ? r.blob() : r.json();
}

function mvOfflineHelp() {
  return `<b>내 목소리 스튜디오에 연결할 수 없어요.</b> (${escapeHtml(mvUrl(''))})
    <ol>
      <li>스튜디오 PC에서 서버를 켜 주세요: <code>.venv\\Scripts\\python.exe recorder\\server.py</code></li>
      <li>다른 기기라면 위쪽 <b>⚙</b>에 스튜디오 PC의 Tailscale 주소를 넣어 주세요.</li>
      <li>브라우저가 <b>「로컬 네트워크의 기기에 접근」</b>을 물으면 <b>허용</b>을 눌러 주세요.</li>
    </ol>
    다른 목소리(브라우저 목소리 · 직접 녹음)는 스튜디오 없이도 쓸 수 있어요.`;
}

/* ---------------- 고른 것 읽기 ---------------- */

const mvChoice = () => $('#mvVoice').value || '';
const mvKind = () => mvChoice().split(':')[0]; // ai | tts | rec
const mvScope = () => ($('input[name="mvScope"]:checked') || {}).value || 'missing';
const mvAiOpts = () => ({ voice: mvChoice().slice(3), style: $('#mvStyle').value, speed: +$('#mvSpeed').value });

function mvTargets(scope) {
  return state.scenes.filter((sc) => !sc.silent && mvLine(sc.text) &&
    (scope === 'all' || (scope === 'selected' ? sc.id === state.selectedId : !sc.voice)));
}

/* 스튜디오에 이미 만들어 둔 같은 문장 · 같은 목소리 (가장 최근 것) */
function mvMadeItem(line, o) {
  if (!MV.studio) return null;
  return MV.studio.items.find((it) => it.status === 'done' && it.text === line && it.voice === o.voice &&
    it.style === o.style && Math.abs(it.speed - o.speed) < 0.001) || null;
}

const mvWait = (sec) => (sec < 60 ? `${Math.max(1, Math.round(sec))}초` : `${Math.round(sec / 60)}분`);

/* ---------------- 대화창 ---------------- */

function mvFillVoices() {
  const sel = $('#mvVoice');
  const p = mvPref();
  const keep = sel.value || p.choice || '';
  sel.innerHTML = '';

  const ai = document.createElement('optgroup');
  ai.label = '내 목소리 AI · 스튜디오';
  if (MV.studio) for (const v of MV.studio.voices) ai.append(new Option(v.label, 'ai:' + v.id));
  else { const o = new Option('스튜디오 연결 안 됨 (⚙에서 주소 설정)', 'ai:'); o.disabled = true; ai.append(o); }
  sel.append(ai);

  const tts = document.createElement('optgroup');
  tts.label = '브라우저 목소리 · 이 기기';
  tts.append(new Option('자동 선택', 'tts:'));
  for (const v of filteredVoices()) tts.append(new Option(`${v.name.replace(/^Microsoft\s+/, '')} (${v.lang})`, 'tts:' + v.voiceURI));
  sel.append(tts);

  const rec = document.createElement('optgroup');
  rec.label = '직접 녹음';
  rec.append(new Option('간편 녹음기로 녹음 (어느 기기에서나)', 'rec:quick'));
  rec.append(new Option('내 목소리 스튜디오에서 녹음', 'rec:studio'));
  sel.append(rec);

  const ok = (v) => [...sel.options].some((o) => o.value === v && !o.disabled);
  sel.value = ok(keep) ? keep
    : MV.studio ? 'ai:' + MV.studio.defaults.voice
      : 'tts:' + (state.voice.voiceURI || '');
  if (!ok(sel.value)) sel.value = 'tts:';
}

function mvSummary() {
  const kind = mvKind();
  $('#mvAiOpts').hidden = kind !== 'ai';
  const list = mvTargets(mvScope());
  $('#mvMissing').textContent = `(${mvTargets('missing').length}개)`;
  $('#mvAll').textContent = `(${mvTargets('all').length}개)`;
  const selSc = findScene(state.selectedId);
  $('#mvSel').textContent = selSc ? `(${sceneIndex(selSc.id) + 1}번)` : '(없음)';
  let msg = '';
  if (!list.length) msg = '고른 범위에 목소리를 입힐 장면이 없어요.';
  else if (kind === 'ai') {
    const o = mvAiOpts();
    const lines = list.map((sc) => mvLine(sc.text));
    const made = lines.filter((l) => mvMadeItem(l, o)).length;
    const chars = lines.filter((l) => !mvMadeItem(l, o)).reduce((a, l) => a + l.length, 0);
    msg = `${list.length}개 장면` + (made ? ` · 만들어 둔 음성 ${made}개 바로 사용` : '') +
      (chars ? ` · 새로 만들기 예상 약 ${mvWait(chars * MV.secPerChar)} (스튜디오 PC 성능에 따라 달라요)` : '');
  } else if (kind === 'tts') {
    msg = `${list.length}개 장면을 이 기기의 브라우저 목소리로 읽어요. 이미 넣은 녹음·AI 음성은 이 장면들에서 빠져요.` +
      ' MP4로 내보낼 때는 컴퓨터에서 화면 공유로 소리를 녹음해요.';
  } else if (kind === 'rec') {
    msg = `${mvChoice() === 'rec:studio' ? '내 목소리 스튜디오' : '간편 녹음기'}를 편집기 옆에 열어요. 문장을 골라 녹음하면 그 장면에 바로 들어가요.`;
  }
  $('#mvSummary').textContent = msg;
  $('#mvStart').disabled = !list.length || (kind === 'ai' && !MV.studio);
  $('#mvStart').textContent = kind === 'rec' ? '녹음기 열기' : kind === 'tts' ? '이 목소리로 바꾸기' : '목소리 입히기';
}

function mvShowError(html) {
  const el = $('#mvError');
  el.innerHTML = html || '';
  el.hidden = !html;
}

async function mvLoadStudio() {
  try {
    const [{ voices, defaults }, items] = await Promise.all([
      mvApi('GET', 'api/tts/voices', undefined, 4000), mvApi('GET', 'api/tts/items', undefined, 4000)]);
    MV.studio = { voices, defaults, items: items.items };
    const done = items.items.filter((i) => i.status === 'done' && i.took);
    if (done.length) MV.secPerChar = done.reduce((a, i) => a + i.took, 0) / done.reduce((a, i) => a + i.text.length, 0);
    return null;
  } catch (e) {
    console.error(e);
    MV.studio = null;
    return e instanceof StudioOffline ? mvOfflineHelp() : `스튜디오가 오류를 돌려줬어요: ${escapeHtml(e.message)}`;
  }
}

async function openMyVoice() {
  $('#mvModal').hidden = false;
  if (MV.job) { mvRenderRun(); return; }
  $('#mvSetup').hidden = false;
  $('#mvRun').hidden = true;
  mvShowError('');
  $('#mvSummary').textContent = '목소리 목록을 불러오는 중…';
  $('#mvStart').disabled = true;
  const err = await mvLoadStudio();
  const p = mvPref();
  if (p.style) $('#mvStyle').value = p.style;
  else if (MV.studio) $('#mvStyle').value = MV.studio.defaults.style;
  const sp = String(p.speed || (MV.studio && MV.studio.defaults.speed) || 1.05);
  $('#mvSpeed').value = [...$('#mvSpeed').options].some((o) => o.value === sp) ? sp : '1.05';
  mvFillVoices();
  mvOnChoice(err);
}

function mvOnChoice(studioErr) {
  // 스튜디오가 안 될 때 안내는 AI 목소리를 고를 때만 보여 줌
  if (typeof studioErr === 'string') MV.studioErr = studioErr;
  mvShowError(mvKind() === 'ai' && !MV.studio ? MV.studioErr : '');
  mvSummary();
}

function closeMyVoice() {
  $('#mvModal').hidden = true;
}

async function startMyVoice() {
  const kind = mvKind();
  const scope = mvScope();
  const targets = mvTargets(scope);
  if (!targets.length) return;
  mvPref({ choice: mvChoice(), style: $('#mvStyle').value, speed: +$('#mvSpeed').value });
  if (kind === 'tts') return mvUseBrowserVoice(targets);
  if (kind === 'rec') return mvOpenRecorder(targets);
  if (!MV.studio) return;

  const o = mvAiOpts();
  const opts = { ...MV.studio.defaults, ...o };
  const entries = targets.map((sc) => {
    const line = mvLine(sc.text);
    const made = mvMadeItem(line, o);
    return { itemId: made ? made.id : null, sceneId: sc.id, text: line, status: made ? 'ready' : 'new' };
  });
  const fresh = entries.filter((en) => en.status === 'new');
  $('#mvStart').disabled = true;
  if (fresh.length) {
    let res;
    try {
      res = await mvApi('POST', 'api/tts/generate', { text: fresh.map((en) => en.text).join('\n'), ...opts, tag: '편집기' });
    } catch (e) {
      console.error(e);
      mvShowError(e instanceof StudioOffline ? mvOfflineHelp() : `만들기를 시작하지 못했어요: ${escapeHtml(e.message)}`);
      $('#mvStart').disabled = false;
      return;
    }
    // 스튜디오는 보낸 줄 순서대로 항목을 돌려줌
    res.items.forEach((it, k) => { fresh[k].itemId = it.id; fresh[k].status = 'queued'; });
  }
  MV.job = { model: fresh.length ? 'loading' : 'ready', entries, failed: 0, changed: 0, reused: entries.length - fresh.length };
  stopPlayback();
  $('#mvSetup').hidden = true;
  $('#mvRun').hidden = false;
  mvRenderRun();
  mvPoll();
}

function mvUseBrowserVoice(targets) {
  stopPlayback();
  state.voice.voiceURI = mvChoice().slice(4);
  let cleared = 0;
  for (const sc of targets) {
    if (!sc.voice) continue;
    releaseMedia({ mediaId: sc.voice.mediaId });
    sc.voice = null;
    cleared++;
  }
  renderVoiceSelect();
  renderScenes();
  renderTimeline();
  renderStage();
  save();
  closeMyVoice();
  const v = pickVoice();
  toast(`브라우저 목소리 「${v ? v.name.replace(/^Microsoft\s+/, '') : '자동'}」로 읽어요.` +
    (cleared ? ` ${cleared}개 장면의 녹음을 뺐어요.` : ''), null, 4500);
}

function mvOpenRecorder(targets) {
  setRecSrc(mvChoice() === 'rec:studio' ? 'studio' : 'quick');
  if (!targets.some((sc) => sc.id === state.selectedId)) selectScene(targets[0].id, { scroll: true });
  setMode('both', { user: true });
  closeMyVoice();
  toast('녹음기에서 문장을 골라 녹음하면 그 장면에 바로 들어가요.', null, 4500);
}

/* ---------------- 내 목소리 AI 진행 ---------------- */

const MV_END = ['done', 'error', 'skipped'];

async function mvPoll() {
  const job = MV.job;
  if (!job) return;
  try {
    const data = await mvApi('GET', 'api/tts/items');
    if (MV.job !== job) return;
    job.model = data.model;
    job.offline = false;
    const byId = new Map(data.items.map((i) => [i.id, i]));
    for (const en of job.entries) {
      if (MV_END.includes(en.status)) continue;
      const it = byId.get(en.itemId);
      if (!it) { en.status = 'error'; job.failed++; continue; } // 스튜디오에서 지운 경우
      if (it.status === 'error') { en.status = 'error'; job.failed++; console.warn(it.error); continue; }
      if (it.status !== 'done') { en.status = it.status; continue; }
      await mvAttach(job, en);
      if (MV.job !== job) return;
    }
  } catch (e) {
    console.error(e);
    if (MV.job !== job) return;
    job.offline = true; // 서버를 잠깐 껐다 켜도 이어서 받음
  }
  if (MV.job !== job) return;
  mvRenderRun();
  if (job.entries.every((en) => MV_END.includes(en.status))) { mvFinish(); return; }
  MV.timer = setTimeout(mvPoll, 2000);
}

async function mvAttach(job, en) {
  const sc = findScene(en.sceneId);
  if (!sc || mvLine(sc.text) !== en.text) { en.status = 'skipped'; job.changed++; return; } // 만드는 사이 장면을 지우거나 문장을 고침
  const blob = await mvApi('GET', `api/tts/audio/${en.itemId}`);
  if (MV.job !== job) return;
  const no = sceneIndex(sc.id) + 1;
  const name = `${String(no).padStart(2, '0')}_${en.text.slice(0, 12).replace(/[\\/:*?"<>|\s]+/g, '')}_내목소리.wav`;
  stopPlayback();
  if (await attachVoice(sc, new Blob([blob], { type: 'audio/wav' }), name)) {
    en.status = 'done';
    renderScenes();
    renderTimeline();
    renderStage();
    save();
  } else {
    en.status = 'error';
    job.failed++;
  }
}

function mvRenderRun() {
  const job = MV.job;
  const btn = $('#mvOpen');
  if (!job) { btn.classList.remove('busy'); btn.textContent = '🎙 목소리 입히기'; return; }
  const total = job.entries.length;
  const fin = job.entries.filter((en) => MV_END.includes(en.status)).length;
  const gen = job.entries.find((en) => en.status === 'generating');
  const genNo = gen && findScene(gen.sceneId) ? sceneIndex(gen.sceneId) + 1 : null;
  const left = job.entries.filter((en) => en.status === 'queued' || en.status === 'generating')
    .reduce((a, en) => a + en.text.length * MV.secPerChar, 0);
  $('#mvPhase').textContent =
    job.offline ? '스튜디오와 연결이 끊겼어요. 서버가 다시 켜지면 이어서 받아요…' :
    job.entries.some((en) => en.status === 'ready') ? '만들어 둔 음성을 가져오는 중…' :
    job.model === 'loading' ? '목소리 모델을 불러오는 중이에요 (처음 한 번, 1~2분)…' :
    job.model === 'error' ? '스튜디오가 모델을 불러오지 못했어요. 서버 창의 오류를 확인해 주세요.' :
    genNo ? `${genNo}번 장면을 내 목소리로 만드는 중…` :
    left ? '스튜디오 차례를 기다리는 중… (밤샘 일괄 작업이 먼저 돌고 있을 수 있어요)' : '마무리하는 중…';
  $('#mvBar').style.width = `${(fin / total) * 100}%`;
  $('#mvPct').textContent = `${fin} / ${total} 완료${left ? ` · 약 ${mvWait(left)} 남음` : ''}`;
  btn.classList.add('busy');
  btn.textContent = `🎙 ${fin}/${total}`;
}

function mvFinish() {
  const job = MV.job;
  MV.job = null;
  clearTimeout(MV.timer);
  mvRenderRun();
  const ok = job.entries.filter((en) => en.status === 'done').length;
  let msg = ok ? `${ok}개 장면에 내 목소리를 입혔어요.` : '내 목소리를 넣지 못했어요.';
  if (ok && job.reused) msg += ` (${job.reused}개는 만들어 둔 음성)`;
  if (job.changed) msg += ` 만드는 사이 문장이 바뀐 ${job.changed}개는 넣지 않았어요.`;
  if (job.failed) msg += ` ${job.failed}개는 실패했어요 (스튜디오 화면에서 확인).`;
  toast(msg, null, 6000);
  closeMyVoice();
}

async function cancelMyVoice() {
  const job = MV.job;
  if (!job) return;
  MV.job = null;
  clearTimeout(MV.timer);
  const ids = job.entries.filter((en) => en.status === 'queued').map((en) => en.itemId);
  // 기다리던 줄은 스튜디오 대기열에서 지움 (지금 만드는 한 줄은 끝까지 만들어지고 스튜디오 목록에 남음)
  if (ids.length) mvApi('POST', 'api/tts/delete', { ids }).catch((e) => console.error(e));
  mvRenderRun();
  const ok = job.entries.filter((en) => en.status === 'done').length;
  toast(`멈췄어요. ${ok}개 장면은 이미 넣었어요.`);
  closeMyVoice();
}

function bindMyVoice() {
  $('#mvOpen').addEventListener('click', openMyVoice);
  $('#mvStart').addEventListener('click', startMyVoice);
  $('#mvCancel').addEventListener('click', cancelMyVoice);
  $('#mvVoice').addEventListener('change', () => mvOnChoice());
  $('#mvStyle').addEventListener('change', mvSummary);
  $('#mvSpeed').addEventListener('change', mvSummary);
  $$('[data-mv="close"]').forEach((b) => b.addEventListener('click', closeMyVoice));
  $$('input[name="mvScope"]').forEach((r) => r.addEventListener('change', mvSummary));
  $('#mvModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMyVoice(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#mvModal').hidden) closeMyVoice(); });
}

bindMyVoice();
