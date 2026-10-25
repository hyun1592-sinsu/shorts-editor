"""Background TTS worker: queue lines, generate with Qwen3-TTS voice clone, post-process with ffmpeg.

Each line is split into sentences that are generated separately, then joined with a fixed gap so pauses
stay even. Generated items persist in outputs/history.json so the list survives restarts.
"""
import csv
import gc
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "outputs"
HISTORY = OUT / "history.json"
LEXICON = OUT / "lexicon.json"
DATASET = ROOT / "dataset"
OUT.mkdir(exist_ok=True)

# Built-in reference clips. Recordings from the 녹음 tab are offered as voices too (id "rec:<sentence id>").
VOICES = {
    "A": {"label": "기본 (녹음 2번 앞부분)", "wav": ROOT / "voices" / "my_voice_2.wav", "start": 0.5, "end": 9.9,
          "text": "이번 주말 어디 갈지 아직 못 정하셨나요? 가까운 바다로 가는 기차표 한 장이면 충분해요."},
    "C": {"label": "평서문 (녹음 2번 뒷부분)", "wav": ROOT / "voices" / "my_voice_2.wav", "start": 15.6, "end": 25.9,
          "text": "도착하면 바닷바람 맞으며 따뜻한 커피 한 잔 마셔 보세요. 멀리 가지 않아도 쉼은 바로 거기 있습니다."},
}
# 억양: sampling temperature. Higher = more varied intonation, but less stable.
STYLES = {"calm": 0.35, "normal": 0.55, "rich": 0.8}
DEFAULT_LEXICON = [
    ["YouTube", "유튜브"], ["Shorts", "쇼츠"], ["AI", "에이아이"], ["OK", "오케이"], ["SNS", "에스엔에스"],
    ["TV", "티비"], ["PC", "피씨"], ["vlog", "브이로그"], ["iPhone", "아이폰"], ["Instagram", "인스타그램"],
]
DEFAULT_OPTS = {"speed": 1.05, "pitch": 0.0, "gap": 0.25, "style": "normal", "denoise": True,
                "calm_exclaim": True, "voice": "A"}

FFMPEG = shutil.which("ffmpeg") or os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe")
DENOISE = "highpass=f=70,afftdn=nr=12:nf=-50:tn=1"

_lock = threading.Lock()
_jobs = queue.Queue()
_items = json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []
_state = {"model": "unloaded"}  # unloaded | loading | ready | error


# ---------- persistence ----------

def _save():
    tmp = HISTORY.with_suffix(".tmp")
    tmp.write_text(json.dumps(_items, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(HISTORY)


def _update(item_id, **fields):
    with _lock:
        for it in _items:
            if it["id"] == item_id:
                it.update(fields)
        _save()


def list_items():
    with _lock:
        return {"model": _state["model"], "items": [dict(i) for i in _items]}


def get_lexicon():
    if LEXICON.exists():
        return json.loads(LEXICON.read_text(encoding="utf-8"))
    return DEFAULT_LEXICON


def set_lexicon(pairs):
    LEXICON.write_text(json.dumps(pairs, ensure_ascii=False, indent=2), encoding="utf-8")


def list_voices():
    out = [{"id": k, "label": v["label"]} for k, v in VOICES.items()]
    meta = DATASET / "metadata.csv"
    if meta.exists():
        with meta.open(encoding="utf-8", newline="") as f:
            for row in csv.reader(f, delimiter="|"):
                path = DATASET / row[0] if len(row) >= 2 else None
                # Skip silent takes (e.g. recorded from an unplugged mic) — they can't clone anything.
                if path and path.exists() and np.abs(sf.read(str(path), dtype="float32")[0]).max() > 0.01:
                    out.append({"id": "rec:" + Path(row[0]).stem, "label": "녹음: " + row[1][:30]})
    return out


def _voice(voice_id):
    if voice_id.startswith("rec:"):
        sid = voice_id[4:]
        meta = DATASET / "metadata.csv"
        with meta.open(encoding="utf-8", newline="") as f:
            text = next(r[1] for r in csv.reader(f, delimiter="|") if len(r) >= 2 and Path(r[0]).stem == sid)
        return {"wav": DATASET / "wavs" / f"{sid}.wav", "start": 0, "end": None, "text": text}
    return VOICES[voice_id]


# ---------- queue API ----------

def enqueue(lines, opts):
    new = []
    with _lock:
        for text in lines:
            it = {"id": uuid.uuid4().hex[:10], "text": text, **opts,
                  "status": "queued", "created": time.time(), "duration": None, "error": None}
            _items.insert(0, it)
            new.append(it)
        _save()
    for it in reversed(new):  # oldest line first
        _jobs.put(it["id"])
    _ensure_worker()
    return new


def delete(ids):
    with _lock:
        keep = []
        for it in _items:
            if it["id"] in ids and it["status"] != "generating":
                for p in (OUT / f"{it['id']}.wav", OUT / f"{it['id']}_raw.wav"):
                    p.unlink(missing_ok=True)
            else:
                keep.append(it)
        _items[:] = keep
        _save()


def wav_path(item_id):
    return OUT / f"{item_id}.wav"


# ---------- text ----------

LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'\-]*")


def apply_lexicon(text, lexicon):
    for src, dst in sorted(lexicon, key=lambda p: -len(p[0])):
        if src:
            text = re.sub(rf"(?<![A-Za-z]){re.escape(src)}(?![A-Za-z])", dst, text, flags=re.IGNORECASE)
    return text


def split_sentences(text, calm_exclaim=True):
    """Return spoken sentences. Each ends with . ! or ? so the model knows to close the sentence."""
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"[~♡♥★☆]+", "", t)
    t = re.sub(r"([!?])[!?]+", r"\1", t)          # "?!", "!!!" -> one mark
    t = re.sub(r"\.{2,}|…", ",", t)                # trailing-off ellipsis reads as a short pause
    if calm_exclaim:
        t = t.replace("!", ".")
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", t) if p.strip()]
    return [p if p[-1] in ".!?" else p + "." for p in parts]


# ---------- audio ----------

def _quiet_mask(x, sr, thresh_db=-40, frame=0.01):
    hop = max(1, int(sr * frame))
    n = len(x) // hop
    rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    return 20 * np.log10(rms / (rms.max() + 1e-12)) < thresh_db, hop


def tidy_sentence(x, sr, max_pause=0.15, pad=0.03):
    """Trim edge silence and shorten pauses inside a sentence to at most `max_pause` seconds."""
    quiet, hop = _quiet_mask(x, sr)
    voiced = np.flatnonzero(~quiet)
    if not len(voiced):
        return x
    start = max(0, voiced[0] * hop - int(pad * sr))
    end = min(len(x), (voiced[-1] + 1) * hop + int(pad * sr))
    keep_frames = int(max_pause / (hop / sr))
    out, run_start = [], None
    first, last = voiced[0], voiced[-1]
    seg_start = start
    for i in range(first, last + 1):
        if quiet[i]:
            run_start = i if run_start is None else run_start
            continue
        if run_start is not None and i - run_start > keep_frames:
            # keep half the allowed pause on each side of the cut, joined with a short crossfade
            cut_a = (run_start + keep_frames // 2) * hop
            cut_b = (i - keep_frames // 2) * hop
            out.append(x[seg_start:cut_a])
            seg_start = cut_b
        run_start = None
    out.append(x[seg_start:end])
    return _join(out, sr, xfade=0.01)


def _join(chunks, sr, xfade=0.01, gap=0.0):
    n = int(xfade * sr)
    result = chunks[0].copy()
    for c in chunks[1:]:
        if gap:
            result = np.concatenate([result, np.zeros(int(gap * sr), dtype=result.dtype), c])
        elif n and len(result) > n and len(c) > n:
            ramp = np.linspace(0, 1, n, dtype=result.dtype)
            result = np.concatenate([result[:-n], result[-n:] * (1 - ramp) + c[:n] * ramp, c[n:]])
        else:
            result = np.concatenate([result, c])
    return result


def postprocess(src, dst, speed, pitch, denoise=False, lufs=-14.0):
    """Pitch shift (semitones), tempo change, optional denoise, then two-pass loudness normalization."""
    sr = sf.info(str(src)).samplerate
    r = 2 ** (pitch / 12)
    # asetrate shifts pitch and tempo together; atempo then corrects tempo to the requested speed.
    base = f"asetrate={sr * r:.0f},aresample={sr},atempo={speed / r:.5f}"
    if denoise:
        base = f"{DENOISE},{base}"
    norm = f"loudnorm=I={lufs}:TP=-1.0:LRA=11"
    probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src), "-af", f"{base},{norm}:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True, check=True).stderr
    m = json.loads(probe[probe.rindex("{"):probe.rindex("}") + 1])
    filters = (f"{base},{norm}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
               f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                    "-af", filters, "-ar", str(sr), str(dst)], check=True)


def load_reference(voice_id, denoise):
    v = _voice(voice_id)
    audio, sr = sf.read(str(v["wav"]), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    end = int(v["end"] * sr) if v["end"] else len(audio)
    ref = audio[int(v["start"] * sr):end]
    if denoise:
        # The model copies the reference's room noise, so cleaning the reference matters most.
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "in.wav", Path(d) / "out.wav"
            sf.write(str(a), ref, sr)
            subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(a), "-af", DENOISE, str(b)],
                           check=True)
            ref, sr = sf.read(str(b), dtype="float32")
    return ref, sr, v["text"]


class Engine:
    """Wraps the model plus a cache of voice-clone prompts per (voice, denoise)."""

    def __init__(self, model):
        self.model = model
        self.prompts = {}

    def prompt(self, voice_id, denoise):
        key = (voice_id, bool(denoise))
        if key not in self.prompts:
            self.prompts.clear()  # keep one voice in memory; rebuilding a prompt takes only seconds
            ref, sr, text = load_reference(voice_id, denoise)
            self.prompts[key] = self.model.create_voice_clone_prompt(ref_audio=(ref, sr), ref_text=text)
        return self.prompts[key]

    def synthesize(self, text, opts, lexicon, non_streaming=True):
        """Return (audio, sr) for one line, built sentence by sentence."""
        sentences = split_sentences(apply_lexicon(text, lexicon), opts.get("calm_exclaim", True))
        temp = STYLES.get(opts.get("style", "normal"), 0.55)
        prompt = self.prompt(opts.get("voice", "A"), opts.get("denoise", False))
        kw = dict(non_streaming_mode=non_streaming,
                  temperature=temp, top_k=20, subtalker_temperature=temp, subtalker_top_k=20)

        def run(sentence):
            # The default cap (2048 codec frames ≈ 170 s) lets a sentence that misses its end babble for
            # half an hour on CPU, so cap by text length instead.
            cap = max_frames(len(sentence))
            wavs, sr = self.model.generate_voice_clone(
                text=sentence, language="Korean", voice_clone_prompt=prompt, max_new_tokens=cap, **kw)
            w = np.asarray(wavs[0], dtype=np.float32)
            return w, sr, len(w) / sr >= 0.95 * cap / FRAME_RATE

        # One sentence at a time: batching multiplies memory, and on 8 GB that means swapping.
        parts = []
        for s in sentences:
            w, sr, hit_cap = run(s)
            if hit_cap:  # it lost the sentence end; retry once
                w, sr, _ = run(s)
            parts.append(tidy_sentence(w, sr))
        gc.collect()
        return _join(parts, sr, gap=float(opts.get("gap", 0.25))), sr


FRAME_RATE = 12.5  # codec frames per second for the 12Hz tokenizer


def max_frames(chars):
    # Korean narration runs ~0.15-0.2 s per character; allow 0.3 s plus 2 s headroom.
    return int(FRAME_RATE * (chars * 0.3 + 2))


def load_model():
    import torch
    from qwen_tts import Qwen3TTSModel

    torch.set_num_threads(os.cpu_count() or 4)
    return Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-0.6B-Base", device_map="cpu", dtype=torch.float32)


# ---------- worker ----------

def _keep_awake(on):
    """Windows: keep the PC from sleeping while lines are queued (overnight batches). Screen may still turn off."""
    if os.name != "nt":
        return
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))


def _worker():
    _keep_awake(True)  # loading the model already counts as work
    try:
        engine = Engine(load_model())
        _state["model"] = "ready"
    except Exception:
        _state["model"] = "error"
        raise

    while True:
        if _jobs.empty():
            _keep_awake(False)
        item_id = _jobs.get()
        _keep_awake(True)
        with _lock:
            it = next((dict(i) for i in _items if i["id"] == item_id), None)
        if not it or it["status"] != "queued":
            continue
        _update(item_id, status="generating")
        try:
            t0 = time.time()
            opts = {**DEFAULT_OPTS, **{k: it[k] for k in DEFAULT_OPTS if k in it}}
            audio, sr = engine.synthesize(it["text"], opts, get_lexicon())
            raw = OUT / f"{item_id}_raw.wav"
            sf.write(str(raw), audio, sr)
            postprocess(raw, wav_path(item_id), opts["speed"], opts["pitch"], opts["denoise"])
            _update(item_id, status="done", duration=sf.info(str(wav_path(item_id))).duration,
                    took=round(time.time() - t0, 1))
        except Exception as e:  # keep the worker alive; surface the error on the item
            _update(item_id, status="error", error=str(e))


def _ensure_worker():
    # The model takes ~2.5 GB RAM, so load it only once something actually needs generating.
    if _state["model"] in ("unloaded", "error"):
        _state["model"] = "loading"
        threading.Thread(target=_worker, daemon=True).start()


def start():
    # Items left queued/generating by a previous run are picked up again.
    with _lock:
        pending = [i for i in reversed(_items) if i["status"] in ("queued", "generating")]
        for i in pending:
            i["status"] = "queued"
        _save()
    for i in pending:
        _jobs.put(i["id"])
    if pending:
        _ensure_worker()
