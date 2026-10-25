"""Local voice dashboard: record training data, and generate speech in my voice.

Run: .venv\\Scripts\\python.exe recorder\\server.py  ->  http://127.0.0.1:8777
Recordings land in dataset/wavs/<id>.wav, transcripts in dataset/metadata.csv.
Generated speech lands in outputs/ (see tts.py).

The shorts editor (GitHub Pages or http://localhost:8765) talks to this server directly:
it reads voices, queues scene lines with /api/tts/generate and fetches the finished WAVs.
Only the origins in EDITOR_ORIGINS may call it from another page; every other site is refused.
"""
import csv
import io
import json
import re
import uuid
import wave
import zipfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response

import tts

ROOT = Path(__file__).resolve().parent
DATASET = ROOT.parent / "dataset"
WAVS = DATASET / "wavs"
SENTENCES = DATASET / "sentences.json"
METADATA = DATASET / "metadata.csv"

WAVS.mkdir(parents=True, exist_ok=True)

app = FastAPI()

# Pages allowed to use this server from the browser (the shorts editor). Same-origin requests
# (the dashboard itself at http://127.0.0.1:8777) carry no foreign Origin and are always allowed.
EDITOR_ORIGINS = {
    "https://hyun1592-sinsu.github.io",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
}
SELF_ORIGINS = {"http://127.0.0.1:8777", "http://localhost:8777"}


@app.middleware("http")
async def editor_cors(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in EDITOR_ORIGINS and origin not in SELF_ORIGINS:
        # Blocks other websites from writing recordings or queueing speech on this PC.
        return PlainTextResponse("origin not allowed", status_code=403)
    if request.method == "OPTIONS" and origin in EDITOR_ORIGINS:
        resp = Response(status_code=204)
    else:
        resp = await call_next(request)
    if origin in EDITOR_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        # Chrome/Edge ask before a public site (github.io) reaches 127.0.0.1; this answers that check.
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


def load_sentences():
    if not SENTENCES.exists():
        texts = json.loads((ROOT / "sentences_default.json").read_text(encoding="utf-8"))
        save_sentences([{"id": uuid.uuid4().hex[:8], "text": t} for t in texts])
    return json.loads(SENTENCES.read_text(encoding="utf-8"))


def save_sentences(items):
    SENTENCES.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def wav_duration(path):
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def recordings():
    """Map sentence id -> {duration, text recorded}."""
    texts = {}
    if METADATA.exists():
        with METADATA.open(encoding="utf-8", newline="") as f:
            for row in csv.reader(f, delimiter="|"):
                if len(row) >= 2:
                    texts[Path(row[0]).stem] = row[1]
    out = {}
    for p in WAVS.glob("*.wav"):
        out[p.stem] = {"duration": wav_duration(p), "text": texts.get(p.stem, "")}
    return out


def write_metadata(recs):
    # LJSpeech-style "wavs/<id>.wav|<transcript>", the format most TTS trainers accept.
    with METADATA.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="|")
        for sid, r in recs.items():
            w.writerow([f"wavs/{sid}.wav", r["text"]])


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/recorder-bridge.js")
def recorder_bridge():
    return FileResponse(ROOT / "recorder-bridge.js", media_type="text/javascript")


@app.get("/api/state")
def state():
    return {"sentences": load_sentences(), "recordings": recordings()}


@app.put("/api/sentences")
async def put_sentences(request: Request):
    items = await request.json()
    if not isinstance(items, list) or not all(isinstance(i, dict) and i.get("id") and "text" in i for i in items):
        raise HTTPException(400, "bad sentences")
    save_sentences([{"id": str(i["id"]), "text": str(i["text"])} for i in items])
    return {"ok": True}


def check_id(sid):
    if not sid.isalnum():
        raise HTTPException(400, "bad id")


@app.post("/api/recordings/{sid}")
async def put_recording(sid: str, request: Request):
    check_id(sid)
    text = next((s["text"] for s in load_sentences() if s["id"] == sid), None)
    if text is None:
        raise HTTPException(404, "unknown sentence")
    (WAVS / f"{sid}.wav").write_bytes(await request.body())
    recs = recordings()
    recs[sid]["text"] = text
    write_metadata(recs)
    return recs[sid]


@app.get("/api/recordings/{sid}")
def get_recording(sid: str):
    check_id(sid)
    path = WAVS / f"{sid}.wav"
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.delete("/api/recordings/{sid}")
def delete_recording(sid: str):
    check_id(sid)
    (WAVS / f"{sid}.wav").unlink(missing_ok=True)
    recs = recordings()
    write_metadata(recs)
    return {"ok": True}


@app.get("/api/tts/items")
def tts_items():
    return tts.list_items()


@app.post("/api/tts/generate")
async def tts_generate(request: Request):
    body = await request.json()
    lines = [l.strip() for l in str(body.get("text", "")).splitlines() if l.strip()]
    if not lines:
        raise HTTPException(400, "empty text")
    d = tts.DEFAULT_OPTS
    voice = str(body.get("voice", d["voice"]))
    if voice not in {v["id"] for v in tts.list_voices()}:
        raise HTTPException(400, "unknown voice")
    opts = {
        "speed": min(2.0, max(0.5, float(body.get("speed", d["speed"])))),
        "pitch": min(12.0, max(-12.0, float(body.get("pitch", d["pitch"])))),
        "gap": min(1.0, max(0.0, float(body.get("gap", d["gap"])))),
        "style": body.get("style") if body.get("style") in tts.STYLES else d["style"],
        "denoise": bool(body.get("denoise", d["denoise"])),
        "calm_exclaim": bool(body.get("calm_exclaim", d["calm_exclaim"])),
        "voice": voice,
    }
    return {"items": tts.enqueue(lines, opts)}


@app.get("/api/tts/voices")
def tts_voices():
    return {"voices": tts.list_voices(), "defaults": tts.DEFAULT_OPTS}


@app.get("/api/tts/lexicon")
def tts_lexicon():
    return {"pairs": tts.get_lexicon()}


@app.put("/api/tts/lexicon")
async def tts_put_lexicon(request: Request):
    pairs = (await request.json()).get("pairs", [])
    tts.set_lexicon([[str(a).strip(), str(b).strip()] for a, b in pairs if str(a).strip()])
    return {"ok": True}


@app.post("/api/tts/delete")
async def tts_delete(request: Request):
    tts.delete(set((await request.json()).get("ids", [])))
    return {"ok": True}


@app.get("/api/tts/audio/{item_id}")
def tts_audio(item_id: str):
    check_id(item_id)
    path = tts.wav_path(item_id)
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/tts/zip")
async def tts_zip(request: Request):
    """Body: {"files": [{"id": ..., "name": "대사.wav"}, ...]} -- names are chosen by the client."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for f in (await request.json()).get("files", []):
            check_id(str(f["id"]))
            path = tts.wav_path(f["id"])
            if path.exists():
                z.write(path, re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", str(f["name"])) or f"{f['id']}.wav")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="my_voice.zip"'})


if __name__ == "__main__":
    tts.start()
    uvicorn.run(app, host="127.0.0.1", port=8777)
