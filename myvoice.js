'use strict';

/* =========================================================
   내 목소리로 읽기
   - PC에서 켠 내 목소리 스튜디오(recorder/server.py, 기본 http://127.0.0.1:8777)에
     장면 문장을 한 줄씩 보내고(/api/tts/generate), 다 만들어지면 WAV를 받아 장면 나레이션으로 넣음
   - 스튜디오 주소는 녹음기 ⚙ 주소(bridge.js의 recUrl)를 같이 씀
   ========================================================= */

const MV_PREF_KEY = 'shorts-myvoice';
const MV = { job: null, defaults: null, secPerChar: 2.6, timer: null };

const mvUrl = (path) => new URL(path, new URL(recUrl(), location.href)).href;
const mvLine = (text) => text.replace(/\s+/g, ' ').trim();

function mvPref(v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(MV_PREF_KEY) || '{}');
    localStorage.setItem(MV_PREF_KEY, JSON.stringify(v));
  } catch (e) { return {}; }
}

class StudioOffline extends Error {}

async function mvApi(method, path, body) {
  let r;
  try {
    r = await fetch(mvUrl(path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new StudioOffline(e.message);
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`);
  return path.startsWith('api/tts/audio/') ? r.blob() : r.json();
}

function mvOfflineHelp() {
  return `<b>내 목소리 스튜디오에 연결할 수 없어요.</b> (${escapeHtml(mvUrl(''))})
    <ol>
      <li>PC에서 스튜디오 서버를 켜 주세요: <code>.venv\\Scripts\\python.exe recorder\\server.py</code></li>
      <li>브라우저가 <b>「로컬 네트워크의 기기에 접근」</b>을 물으면 <b>허용</b>을 눌러 주세요.</li>
      <li>주소가 다르면 위쪽 <b>녹음기 ⚙</b>에서 바꿔 주세요.</li>
    </ol>`;
}

function mvTargets(scope) {
  return state.scenes.filter((sc) => !sc.silent && mvLine(sc.text) && (scope === 'all' || !sc.voice));
}
const mvScope = () => ($('input[name="mvScope"]:checked') || {}).value || 'missing';

function mvWait(sec) {
  return sec < 60 ? `${Math.max(1, Math.round(sec))}초` : `${Math.round(sec / 60)}분`;
}

function mvSummary() {
  const list = mvTargets(mvScope());
  const chars = list.reduce((a, sc) => a + mvLine(sc.text).length, 0);
  $('#mvMissing').textContent = `(${mvTargets('missing').length}개)`;
  $('#mvAll').textContent = `(${mvTargets('all').length}개)`;
  $('#mvSummary').textContent = list.length
    ? `${list.length}개 장면 · 예상 약 ${mvWait(chars * MV.secPerChar)} (PC 성능에 따라 달라요. 처음 한 번은 모델을 불러오느라 1~2분 더 걸려요)`
    : '만들 장면이 없어요. 모든 장면에 이미 목소리가 있으면 「모든 장면 새로 만들기」를 고르세요.';
  $('#mvStart').disabled = !list.length || !MV.defaults;
}

function mvShowError(html) {
  const el = $('#mvError');
  el.innerHTML = html || '';
  el.hidden = !html;
}

async function openMyVoice() {
  $('#mvModal').hidden = false;
  if (MV.job) { mvRenderRun(); return; }
  $('#mvSetup').hidden = false;
  $('#mvRun').hidden = true;
  mvShowError('');
  MV.defaults = null;
  mvSummary();
  $('#mvSummary').textContent = '스튜디오에 연결하는 중…';
  try {
    const [{ voices, defaults }, items] = await Promise.all([mvApi('GET', 'api/tts/voices'), mvApi('GET', 'api/tts/items')]);
    MV.defaults = defaults;
    // 지난번 만든 속도로 예상 시간 맞추기 (스튜디오와 같은 계산)
    const done = items.items.filter((i) => i.status === 'done' && i.took);
    if (done.length) MV.secPerChar = done.reduce((a, i) => a + i.took, 0) / done.reduce((a, i) => a + i.text.length, 0);
    const p = mvPref();
    const sel = $('#mvVoice');
    sel.innerHTML = '';
    for (const v of voices) sel.add(new Option(v.label, v.id));
    sel.value = voices.some((v) => v.id === p.voice) ? p.voice : defaults.voice;
    $('#mvStyle').value = p.style || defaults.style;
    const sp = String(p.speed || defaults.speed);
    $('#mvSpeed').value = [...$('#mvSpeed').options].some((o) => o.value === sp) ? sp : '1.05';
  } catch (e) {
    console.error(e);
    mvShowError(e instanceof StudioOffline ? mvOfflineHelp() : `스튜디오가 오류를 돌려줬어요: ${escapeHtml(e.message)}`);
    $('#mvSummary').textContent = '';
    $('#mvStart').disabled = true;
    return;
  }
  mvSummary();
}

function closeMyVoice() {
  $('#mvModal').hidden = true;
}

async function startMyVoice() {
  const targets = mvTargets(mvScope());
  if (!targets.length || !MV.defaults) return;
  const opts = {
    ...MV.defaults,
    voice: $('#mvVoice').value,
    style: $('#mvStyle').value,
    speed: +$('#mvSpeed').value,
  };
  mvPref({ voice: opts.voice, style: opts.style, speed: opts.speed });
  const lines = targets.map((sc) => mvLine(sc.text));
  $('#mvStart').disabled = true;
  let res;
  try {
    res = await mvApi('POST', 'api/tts/generate', { text: lines.join('\n'), ...opts });
  } catch (e) {
    console.error(e);
    mvShowError(e instanceof StudioOffline ? mvOfflineHelp() : `만들기를 시작하지 못했어요: ${escapeHtml(e.message)}`);
    $('#mvStart').disabled = false;
    return;
  }
  // 스튜디오는 보낸 줄 순서대로 항목을 돌려줌
  MV.job = {
    model: 'loading',
    entries: res.items.map((it, k) => ({ itemId: it.id, sceneId: targets[k].id, text: lines[k], status: 'queued' })),
    failed: 0,
    changed: 0,
  };
  stopPlayback();
  $('#mvSetup').hidden = true;
  $('#mvRun').hidden = false;
  mvRenderRun();
  mvPoll();
}

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
      if (en.status === 'done' || en.status === 'error' || en.status === 'skipped') continue;
      const it = byId.get(en.itemId);
      if (!it) { en.status = 'error'; job.failed++; continue; } // 스튜디오에서 지운 경우
      if (it.status === 'error') { en.status = 'error'; job.failed++; console.warn(it.error); continue; }
      if (it.status !== 'done') { en.status = it.status; continue; }
      await mvAttach(job, en);
    }
  } catch (e) {
    console.error(e);
    if (MV.job !== job) return;
    job.offline = true; // 서버를 잠깐 껐다 켜도 이어서 받음
  }
  if (MV.job !== job) return;
  mvRenderRun();
  if (job.entries.every((en) => ['done', 'error', 'skipped'].includes(en.status))) { mvFinish(); return; }
  MV.timer = setTimeout(mvPoll, 2000);
}

async function mvAttach(job, en) {
  const sc = findScene(en.sceneId);
  if (!sc) { en.status = 'skipped'; job.changed++; return; }
  if (mvLine(sc.text) !== en.text) { en.status = 'skipped'; job.changed++; return; } // 만드는 사이 문장을 고침
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
  if (!job) { btn.classList.remove('busy'); btn.textContent = '🎙 내 목소리'; return; }
  const total = job.entries.length;
  const fin = job.entries.filter((en) => ['done', 'error', 'skipped'].includes(en.status)).length;
  const gen = job.entries.find((en) => en.status === 'generating');
  const genNo = gen && findScene(gen.sceneId) ? sceneIndex(gen.sceneId) + 1 : null;
  const left = job.entries.filter((en) => en.status === 'queued' || en.status === 'generating')
    .reduce((a, en) => a + en.text.length * MV.secPerChar, 0);
  $('#mvPhase').textContent =
    job.offline ? '스튜디오와 연결이 끊겼어요. 서버가 다시 켜지면 이어서 받아요…' :
    job.model === 'loading' ? '목소리 모델을 불러오는 중이에요 (처음 한 번, 1~2분)…' :
    job.model === 'error' ? '스튜디오가 모델을 불러오지 못했어요. 서버 창의 오류를 확인해 주세요.' :
    genNo ? `${genNo}번 장면을 내 목소리로 만드는 중…` : '차례를 기다리는 중…';
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
  let msg = ok ? `${ok}개 장면을 내 목소리로 채웠어요.` : '내 목소리를 넣지 못했어요.';
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
  $$('[data-mv="close"]').forEach((b) => b.addEventListener('click', closeMyVoice));
  $$('input[name="mvScope"]').forEach((r) => r.addEventListener('change', mvSummary));
  $('#mvModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeMyVoice(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#mvModal').hidden) closeMyVoice(); });
}

bindMyVoice();
