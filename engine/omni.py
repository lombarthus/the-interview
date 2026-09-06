"""OmniVoice (k2-fsa/OmniVoice): Voice Clone aus einem Referenzclip + Transkript, Voice Design aus
Attributen (instruct). Braucht eine CUDA-GPU; auf CPU wird das Modell nicht angeboten (20–50× zu
langsam). Ein Modell im VRAM, Laden lazy, Generierung serialisiert."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np

from common import LANG, SAMPLE_RATE, VOICES_DIR, cuda_available, log

MODEL_ID = "k2-fsa/OmniVoice"
_model = None
_loading = False
_error = ""
_lock = threading.Lock()
_stats = {"generated": 0, "last_ok": True, "last_error": ""}


def available() -> bool:
    if not cuda_available():
        return False
    try:
        import omnivoice  # noqa: F401
        return True
    except Exception:
        return False


def status() -> dict:
    return {"available": available(), "loaded": _model is not None, "loading": _loading, "ready": _model is not None and _stats["last_ok"], "model": MODEL_ID, "error": _error or _stats["last_error"]}


def load() -> dict:
    global _model, _loading, _error
    if _model is not None:
        return {"status": "already_loaded"}
    if not available():
        raise RuntimeError("OmniVoice braucht eine NVIDIA-GPU mit CUDA (auf diesem Rechner nicht verfügbar)")
    with _lock:
        if _model is not None:
            return {"status": "already_loaded"}
        _loading = True
        try:
            import torch
            from omnivoice import OmniVoice
            t0 = time.time()
            log(f"OmniVoice: lade {MODEL_ID} auf cuda …")
            _model = OmniVoice.from_pretrained(MODEL_ID, device_map="cuda", dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
            _error = ""
            log(f"OmniVoice geladen in {time.time() - t0:.1f}s")
        except Exception as e:  # noqa: BLE001
            _error = str(e)[:300]
            raise
        finally:
            _loading = False
    return {"status": "loaded"}


def unload() -> dict:
    global _model
    with _lock:
        _model = None
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass
    return {"status": "unloaded"}


def _normalize(audio) -> np.ndarray:
    if isinstance(audio, list):
        audio = audio[0] if audio else np.zeros(0, dtype=np.float32)
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio)
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.squeeze()
    if audio.ndim == 0:
        audio = audio.reshape(1)
    return audio


def generate(text: str, lang: str, voice_name: str | None, instruct: str | None, seed: int) -> np.ndarray:
    """Liefert float32 mono @ 24 kHz."""
    if _model is None:
        load()
    import torch
    kwargs: dict = {"text": text, "language": LANG[lang]["omni"], "num_step": 32, "speed": 1.0, "guidance_scale": 2.0, "t_shift": 0.1, "denoise": True, "preprocess_prompt": True, "postprocess_output": True}
    if voice_name:
        vdir = VOICES_DIR / voice_name
        ref = vdir / "audio.wav"
        if not ref.is_file():
            raise FileNotFoundError(f"Stimme {voice_name}: audio.wav fehlt")
        kwargs["ref_audio"] = str(ref)
        rt = vdir / "ref.txt"
        if rt.is_file():
            t = rt.read_text(encoding="utf-8").strip()
            if t:
                kwargs["ref_text"] = t
    elif instruct:
        kwargs["instruct"] = instruct
    with _lock:
        if seed is not None and seed >= 0:
            torch.manual_seed(int(seed))
            torch.cuda.manual_seed_all(int(seed))
        try:
            audio = _model.generate(**kwargs)
            _stats["generated"] += 1
            _stats["last_ok"] = True
            _stats["last_error"] = ""
        except Exception as e:  # noqa: BLE001
            _stats["last_ok"] = False
            _stats["last_error"] = str(e)[:300]
            raise
        finally:
            torch.cuda.empty_cache()
    return _normalize(audio)
