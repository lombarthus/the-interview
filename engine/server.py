"""The Interview — Sprach-Engine (ein Prozess, ein Port, nur 127.0.0.1).

  GET  /status                       Gerät, Engines, Modelle
  POST /load  /unload                OmniVoice in den VRAM / wieder frei
  POST /generate                     Form: text, language, voice_name, instruct, seed, engine=auto|omnivoice|pocket -> WAV 24 kHz mono
  POST /clone?name&language&overwrite   Roh-Body (Audio/Video) -> Job {jobId}
  GET  /jobs/{id}                    Job-Status
  GET  /voices                       Bibliothek + Pocket-Katalog
  GET  /voices/{name}/words          Wort-Zeitstempel der Aufnahme
  POST /voices/{name}/recut          {text?, start?, end?, offset?} -> Job
  DELETE /voices/{name}              Stimme in den Papierkorb
  POST /transcribe                   {file, lang} -> {text}

Gestartet von app/lib/engine.js im venv des Benutzers. Alles andere (Skript, Zusammenbau, Archiv)
macht der Node-Server."""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import Body, FastAPI, Form, HTTPException, Request
from fastapi.responses import JSONResponse, Response

import asr
import clone as clone_mod
import omni
import pocket
from common import FFMPEG, LANG, SAMPLE_RATE, VOICES_DIR, WORK_DIR, cuda_available, device_name, norm_lang

app = FastAPI(title="The Interview Engine")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_started = time.time()


# --- Jobs (Klonen dauert 10–90 s: Upload, Whisper, Schnitt) -------------------------------------
def _new_job(kind: str, fn, *args, **kwargs) -> str:
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "status": "queued", "log": [], "result": None, "error": None, "createdAt": time.time()}
    with _jobs_lock:
        _jobs[jid] = job
        if len(_jobs) > 100:
            for k in sorted(_jobs, key=lambda k: _jobs[k]["createdAt"])[:-100]:
                _jobs.pop(k, None)

    def logf(msg: str):
        job["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")

    def run():
        job["status"] = "running"
        try:
            job["result"] = fn(*args, log_fn=logf, **kwargs)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            job["error"] = f"{type(e).__name__}: {e}"[:400]
            job["status"] = "failed"
            logf(f"Fehler: {job['error']}")
        finally:
            job["finishedAt"] = time.time()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
    return jid


def list_voices() -> list[dict]:
    out = []
    if VOICES_DIR.is_dir():
        for d in sorted(VOICES_DIR.iterdir()):
            if not d.is_dir() or not (d / "audio.wav").is_file():
                continue
            lang = ""
            try:
                lang = (d / "lang.txt").read_text(encoding="utf-8").strip()
            except OSError:
                pass
            out.append({"name": d.name, "lang": lang or "any", "kind": "clone", "pocketTemplate": any(d.glob("audio.??.wav")), "hasOriginal": (d / "original.wav").is_file(), "modifiedAt": (d / "audio.wav").stat().st_mtime * 1000})
    if pocket.available():
        for n in pocket.catalog():
            out.append({"name": n, "lang": "any", "kind": "catalog"})
    return out


# --- Status --------------------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/status")
def status():
    return {
        "ok": True, "uptimeSec": int(time.time() - _started), "device": device_name(), "cuda": cuda_available(),
        "omnivoice": omni.status(), "pocket": pocket.status(), "asr": asr.status(),
        "voices": len([v for v in list_voices() if v["kind"] == "clone"]), "voicesDir": str(VOICES_DIR), "ffmpeg": FFMPEG,
    }


@app.post("/load")
def load():
    try:
        return omni.load()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(e)[:300]) from e


@app.post("/unload")
def unload():
    return omni.unload()


# --- Sprechen ------------------------------------------------------------------------------------
def _wav(audio: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@app.post("/generate")
def generate(text: str = Form(...), language: str = Form("en"), voice_name: str = Form(""), instruct: str = Form(""), seed: int = Form(-1), engine: str = Form("auto")):
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text darf nicht leer sein")
    lang = norm_lang(language)
    if voice_name and not NAME_RE.match(voice_name):
        raise HTTPException(status_code=400, detail="ungültiger voice_name")
    want = engine if engine in ("auto", "omnivoice", "pocket") else "auto"
    is_catalog = bool(voice_name) and not (VOICES_DIR / voice_name / "audio.wav").is_file()
    use_omni = omni.available() and want != "pocket" and not is_catalog
    errors = []
    t0 = time.perf_counter()
    if use_omni:
        try:
            audio = omni.generate(text, lang, voice_name or None, instruct or None, seed)
            return Response(content=_wav(audio, SAMPLE_RATE), media_type="audio/wav", headers={"X-Engine": "omnivoice", "X-Render-Time-Ms": str(int((time.perf_counter() - t0) * 1000))})
        except Exception as e:  # noqa: BLE001
            errors.append(f"OmniVoice: {str(e)[:160]}")
            if want == "omnivoice":
                raise HTTPException(status_code=500, detail=" | ".join(errors)) from e
    if instruct and not voice_name:
        raise HTTPException(status_code=503, detail="Voice Design braucht OmniVoice (NVIDIA-GPU); " + (" | ".join(errors) or "nicht verfügbar"))
    if not pocket.available():
        raise HTTPException(status_code=503, detail="Keine Sprach-Engine verfügbar: " + (" | ".join(errors) or "Pocket TTS nicht installiert"))
    try:
        audio, sr, substituted = pocket.generate(text, lang, voice_name or None, seed)
    except Exception as e:  # noqa: BLE001
        errors.append(f"Pocket: {str(e)[:160]}")
        raise HTTPException(status_code=500, detail=" | ".join(errors)) from e
    headers = {"X-Engine": "pocket-tts", "X-Render-Time-Ms": str(int((time.perf_counter() - t0) * 1000))}
    if substituted:
        headers["X-Voice-Substituted"] = substituted
    return Response(content=_wav(audio, sr), media_type="audio/wav", headers=headers)


# --- Stimmen --------------------------------------------------------------------------------------
@app.get("/voices")
def voices():
    return {"voicesDir": str(VOICES_DIR), "voices": list_voices()}


@app.post("/clone")
async def clone(request: Request, name: str, language: str = "auto", overwrite: str = ""):
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Name: nur Buchstaben, Ziffern, _ und -, max. 40 Zeichen")
    if name in pocket.catalog():
        raise HTTPException(status_code=400, detail="Dieser Name ist eine Katalogstimme — bitte anderen Namen wählen")
    if (VOICES_DIR / name / "audio.wav").is_file() and overwrite not in ("1", "true"):
        return JSONResponse(status_code=409, content={"error": f"Stimme \"{name}\" gibt es schon", "exists": True})
    if not asr.available():
        raise HTTPException(status_code=503, detail="Kein Whisper-Backend installiert — Setup-Schritt Pakete/Modelle prüfen")
    body = await request.body()
    if len(body) < 1000:
        raise HTTPException(status_code=400, detail="Datei ist leer oder zu klein")
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    fname = request.headers.get("x-filename", "upload.bin")
    ext = Path(fname).suffix[:8] if Path(fname).suffix else ".bin"
    upload = WORK_DIR / f"upload-{uuid.uuid4().hex[:8]}{re.sub(r'[^A-Za-z0-9.]', '', ext) or '.bin'}"
    upload.write_bytes(body)

    def work(log_fn):
        try:
            return clone_mod.build(name, input_file=str(upload), language=language, log_fn=log_fn)
        finally:
            try:
                upload.unlink()
            except OSError:
                pass

    return JSONResponse(status_code=202, content={"jobId": _new_job("clone", work), "name": name})


@app.get("/jobs/{jid}")
def job(jid: str):
    j = _jobs.get(jid)
    if not j:
        raise HTTPException(status_code=404, detail="unbekannter Job")
    return j


@app.get("/voices/{name}/words")
def voice_words(name: str):
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="ungültiger Name")
    vdir = VOICES_DIR / name
    if not (vdir / "original.wav").is_file():
        raise HTTPException(status_code=404, detail="keine original.wav")
    if not asr.available():
        raise HTTPException(status_code=503, detail="Kein Whisper-Backend")
    lang = None
    try:
        lang = (vdir / "lang.txt").read_text(encoding="utf-8").strip() or None
    except OSError:
        pass
    heard = clone_mod.full_words(vdir, vdir / "original.wav", lang if lang in LANG else None)
    return {"name": name, "words": [{"w": w, "s": round(s, 2), "e": round(e, 2)} for (w, s, e) in heard]}


@app.post("/voices/{name}/recut")
def voice_recut(name: str, body: dict = Body(default={})):
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="ungültiger Name")
    if not (VOICES_DIR / name / "original.wav").is_file():
        raise HTTPException(status_code=404, detail="keine original.wav — Neuschnitt nicht möglich")
    kw = {"recut": True, "language": str(body.get("language") or "auto"), "text": str(body.get("text") or "")}
    for k in ("offset", "start", "end"):
        if body.get(k) is not None:
            kw[k] = float(body[k])
    return JSONResponse(status_code=202, content={"jobId": _new_job("recut", lambda log_fn: clone_mod.build(name, log_fn=log_fn, **kw)), "name": name})


@app.delete("/voices/{name}")
def voice_delete(name: str):
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="ungültiger Name")
    vdir = VOICES_DIR / name
    if not vdir.is_dir():
        raise HTTPException(status_code=404, detail="Stimme nicht gefunden")
    trash = VOICES_DIR.parent / "work" / "trash"
    trash.mkdir(parents=True, exist_ok=True)
    target = trash / f"voice-{name}-{int(time.time())}"
    shutil.move(str(vdir), str(target))
    pocket.forget_voice(name)
    return {"ok": True, "movedTo": str(target)}


# --- Aussprache-Riegel -----------------------------------------------------------------------------
@app.post("/transcribe")
def transcribe(body: dict = Body(...)):
    f = str(body.get("file") or "")
    lang = norm_lang(body.get("lang"))
    if not f or not Path(f).is_file():
        raise HTTPException(status_code=400, detail="file fehlt")
    if not asr.available():
        raise HTTPException(status_code=503, detail="Kein Whisper-Backend installiert")
    try:
        return {"text": asr.transcribe(f, lang)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)[:300]) from e


def _idle_watch():
    while True:
        time.sleep(60)
        try:
            asr.release_if_idle()
        except Exception:
            pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("INTERVIEW_ENGINE_PORT") or 3114))
    args = ap.parse_args()
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_idle_watch, daemon=True).start()
    print(json.dumps({"engine": "the-interview", "host": args.host, "port": args.port, "cuda": cuda_available(), "device": device_name(), "voices": str(VOICES_DIR)}), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
