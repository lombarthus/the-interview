"""Spracherkennung für Klon-Schnitt (Wort-Zeitstempel) und Aussprache-Riegel (Volltext).
GPU: openai/whisper-large-v3-turbo über transformers (fp16). CPU: faster-whisper small (int8).
Modell wird einmal geladen und nach Leerlauf wieder freigegeben."""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from common import FFMPEG, LANG, cuda_available, log

GPU_MODEL = "openai/whisper-large-v3-turbo"
CPU_MODEL = "small"
IDLE_SEC = 10 * 60

_backend = None      # "transformers" | "faster"
_model = None
_lock = threading.Lock()
_last_used = 0.0
_error = ""


def backend_name() -> str:
    return "transformers" if cuda_available() and _has("transformers") else ("faster-whisper" if _has("faster_whisper") else "")


def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def available() -> bool:
    return bool(backend_name())


def status() -> dict:
    return {"available": available(), "backend": backend_name(), "loaded": _model is not None, "model": GPU_MODEL if backend_name() == "transformers" else CPU_MODEL, "error": _error}


def _load():
    global _model, _backend, _error
    if _model is not None:
        return
    b = backend_name()
    if not b:
        raise RuntimeError("Kein Whisper-Backend installiert")
    t0 = time.time()
    try:
        if b == "transformers":
            import torch
            from transformers import pipeline
            _model = pipeline("automatic-speech-recognition", model=GPU_MODEL, device=0, dtype=torch.float16)
            _backend = "transformers"
        else:
            from faster_whisper import WhisperModel
            _model = WhisperModel(CPU_MODEL, device="cpu", compute_type="int8", cpu_threads=max(2, min(6, (os.cpu_count() or 4) // 2)))
            _backend = "faster"
        _error = ""
        log(f"ASR: {b} geladen in {time.time() - t0:.1f}s")
    except Exception as e:  # noqa: BLE001
        _error = str(e)[:300]
        raise


def release_if_idle() -> None:
    global _model
    if _model is not None and time.time() - _last_used > IDLE_SEC:
        with _lock:
            _model = None
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            log("ASR: nach Leerlauf freigegeben")


def _to16k(src: str, offset: float = 0.0, seconds: float | None = None) -> Path:
    out = Path(tempfile.mkstemp(suffix=".16k.wav")[1])
    args = ["-ss", f"{offset:.3f}", "-i", src]
    if seconds:
        args += ["-t", f"{seconds:.2f}"]
    args += ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)]
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return out


def transcribe(file: str, lang: str) -> str:
    global _last_used
    with _lock:
        _load()
        _last_used = time.time()
        wav = _to16k(file)
        try:
            if _backend == "transformers":
                res = _model(str(wav), generate_kwargs={"language": LANG[lang]["whisper"], "task": "transcribe"}, return_timestamps=True)
                return (res.get("text") or "").strip()
            segs, _ = _model.transcribe(str(wav), language=LANG[lang]["whisper"], beam_size=1, vad_filter=False, condition_on_previous_text=False)
            return " ".join(s.text for s in segs).strip()
        finally:
            try:
                wav.unlink()
            except OSError:
                pass


def words(file: str, lang: str | None, offset: float = 0.0, seconds: float | None = None) -> list[tuple[str, float, float]]:
    """Wort-Zeitstempel (Wort, Start, Ende) in Sekunden, bezogen auf die Originaldatei."""
    global _last_used
    with _lock:
        _load()
        _last_used = time.time()
        wav = _to16k(file, offset, seconds)
        out: list[tuple[str, float, float]] = []
        try:
            if _backend == "transformers":
                extra = {"chunk_length_s": 30, "stride_length_s": 5} if (seconds or 0) > 30 or not seconds else {}
                gk = {"language": LANG[lang]["whisper"]} if lang else {}
                res = _model(str(wav), return_timestamps="word", generate_kwargs=gk, **extra)
                for ch in res.get("chunks") or []:
                    ts = ch.get("timestamp") or (None, None)
                    s, e = ts[0], ts[1] if ts[1] is not None else ts[0]
                    if s is None:
                        continue
                    raw = ch["text"]
                    if out and raw and not raw[0].isspace():
                        w0, s0, _ = out[-1]
                        out[-1] = (w0 + raw.strip(), s0, float(e) + offset)
                    else:
                        out.append((raw.strip(), float(s) + offset, float(e) + offset))
            else:
                segs, _ = _model.transcribe(str(wav), language=LANG[lang]["whisper"] if lang else None, word_timestamps=True, beam_size=1, vad_filter=False)
                for seg in segs:
                    for w in seg.words or []:
                        out.append((w.word.strip(), float(w.start) + offset, float(w.end) + offset))
        finally:
            try:
                wav.unlink()
            except OSError:
                pass
        return [w for w in out if w[0]]


def detect_language(file: str) -> str:
    """Grobe Spracherkennung der Aufnahme (de/en/es/fr/it/pt), sonst 'en'."""
    with _lock:
        _load()
        wav = _to16k(file, 0.0, 20.0)
        try:
            if _backend == "faster":
                _, info = _model.transcribe(str(wav), beam_size=1)
                code = (info.language or "en").lower()
            else:
                res = _model(str(wav), return_language=True)
                chunks = res.get("chunks") or []
                code = (chunks[0].get("language") if chunks else None) or "en"
                code = {"german": "de", "english": "en", "spanish": "es", "french": "fr", "italian": "it", "portuguese": "pt"}.get(str(code).lower(), str(code).lower()[:2])
        except Exception:
            code = "en"
        finally:
            try:
                wav.unlink()
            except OSError:
                pass
    return code if code in LANG else "en"
