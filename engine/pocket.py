"""Pocket TTS (kyutai-labs, 100M, CPU): ein Modell je Sprache, Stimmen aus der Bibliothek
(audio.<lang>.wav vor audio.wav) oder aus dem Pocket-Katalog (alba, juergen, giovanni, lola,
rafael, estelle — werden beim ersten Gebrauch von Hugging Face geladen).

Erfahrungen aus dem Betrieb, hier übernommen: der Text wird satzweise erzeugt (das Modell setzt
Pausen zwischen Sätzen sonst zufällig), vor jeden Satz kommt ein Wegwerf-Komma (fängt die
unzuverlässigen ersten Frames auf), Anfangs- und Endstille werden gekappt."""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path

import numpy as np

from common import LANG, POCKET_LANGS, VOICES_DIR, log

TEMP = 0.4
STEPS = 4
SENTENCE_GAP_MS = 380
TRIM_LEAD_MS = 120
TRIM_TAIL_MS = 120
_NO_SPLIT_BEFORE = {"z", "b", "bzw", "ca", "dr", "prof", "nr", "st", "usw", "vgl", "evtl", "ggf", "sog", "mr", "mrs", "ms", "u", "s", "vs", "etc", "inkl", "max", "min", "tel", "str"}

_models: dict[str, object] = {}
_states: dict[tuple[str, str], dict] = {}
_registry = threading.Lock()
_gen = threading.Lock()
_stats = {"generated": 0, "last_error": ""}
_import_error = ""


def available() -> bool:
    global _import_error
    try:
        import pocket_tts  # noqa: F401
        return True
    except Exception as e:  # noqa: BLE001
        _import_error = str(e)[:200]
        return False


def status() -> dict:
    return {"available": available(), "loaded": sorted(_models.keys()), "cloning": cloning_available(), "hfToken": bool(os.environ.get("HF_TOKEN")), "warm": [f"{k[0]}:{Path(k[1]).name}" for k in _states], "error": _import_error or _stats["last_error"]}


def default_voice(lang: str) -> str:
    from pocket_tts.default_parameters import get_default_voice_for_language
    return get_default_voice_for_language(LANG[lang]["pocket"])


def catalog() -> list[str]:
    """Alle Katalogstimmen der Bibliothek (kyutai/tts-voices, CC-BY-4.0), Sprach-Defaults zuerst."""
    try:
        from pocket_tts.default_parameters import DEFAULT_VOICE_FALLBACK, DEFAULT_VOICE_FOR_LANGUAGE
        first = [DEFAULT_VOICE_FALLBACK, *DEFAULT_VOICE_FOR_LANGUAGE.values()]
        try:
            from pocket_tts.models.tts_model import _ORIGINS_OF_PREDEFINED_VOICES
            rest = sorted(k for k in _ORIGINS_OF_PREDEFINED_VOICES if k not in first)
        except Exception:
            rest = []
        return first + rest
    except Exception:
        return []


def cloning_available() -> bool | None:
    """True/False, sobald ein Modell geladen ist; None = noch unbekannt. Die Klon-Gewichte sind bei
    Hugging Face gated: ohne akzeptierte Bedingungen + Token (HF_TOKEN) gibt es nur Katalogstimmen."""
    with _registry:
        for m in _models.values():
            return bool(getattr(m, "has_voice_cloning", True))
    return None


def get_model(lang: str):
    lid = LANG[lang]["pocket"]
    with _registry:
        m = _models.get(lid)
        if m is None:
            from pocket_tts.models.tts_model import TTSModel
            t0 = time.time()
            log(f"Pocket: lade Modell {lid} …")
            m = TTSModel.load_model(language=lid, temp=TEMP, lsd_decode_steps=STEPS)
            m.to("cpu")
            _models[lid] = m
            log(f"Pocket: {lid} geladen in {time.time() - t0:.1f}s")
        return m


def resolve_voice(voice_name: str | None, lang: str) -> tuple[str, bool]:
    """-> (voice_ref, is_clone). Klonvorlage aus der Bibliothek oder Katalogname."""
    if not voice_name:
        return default_voice(lang), False
    vdir = VOICES_DIR / voice_name
    ref_lang = vdir / f"audio.{lang}.wav"
    if ref_lang.is_file():
        return str(ref_lang), True
    ref = vdir / "audio.wav"
    if ref.is_file():
        return str(ref), True
    return voice_name, False   # Katalogname


def get_state(model, lang: str, voice_ref: str) -> dict:
    key = (LANG[lang]["pocket"], voice_ref)
    with _registry:
        st = _states.get(key)
    if st is None:
        st = model.get_state_for_audio_prompt(voice_ref)
        with _registry:
            _states[key] = st
    return st


def forget_voice(voice_name: str) -> None:
    with _registry:
        for k in list(_states):
            if voice_name in k[1]:
                _states.pop(k, None)


def _split_sentences(text: str) -> list[str]:
    t = " ".join(text.split())
    if not t:
        return []
    out, start = [], 0
    for m in re.finditer(r"[.!?…]+[\"')\]»]*\s+(?=[A-ZÄÖÜ0-9„\"«(\[])", t):
        before = t[start:m.end()].strip()
        words = before.split()
        last = re.sub(r"[^\wäöüÄÖÜß]+$", "", words[-1] if words else "").lower()
        if last in _NO_SPLIT_BEFORE or len(last) <= 1:
            continue
        out.append(before)
        start = m.end()
    rest = t[start:].strip()
    if rest:
        out.append(rest)
    return out or [t]


def _trim_tail(audio: np.ndarray, sr: int, keep_ms: int, thresh: float = 0.006) -> np.ndarray:
    hop = max(1, int(sr * 0.02))
    last = None
    for i in range(audio.size - hop, 0, -hop):
        if float(np.sqrt(np.mean(audio[i:i + hop] ** 2))) > thresh:
            last = i + hop
            break
    if last is None:
        return audio
    return audio[: min(audio.size, last + int(sr * keep_ms / 1000))]


def _trim_lead(audio: np.ndarray, sr: int, keep_ms: int, thresh: float = 0.006) -> np.ndarray:
    if audio.size == 0:
        return audio
    hop = max(1, int(sr * 0.02))
    voiced = [float(np.sqrt(np.mean(audio[i:i + hop] ** 2))) > thresh for i in range(0, audio.size - hop, hop)]
    first, run = None, 0
    for idx, v in enumerate(voiced):
        run = run + 1 if v else 0
        if run >= 4:
            first = (idx - 3) * hop
            break
    if first is None:
        return audio
    start = max(0, first - int(sr * keep_ms / 1000))
    return audio[start:] if start > 0 else audio


def generate(text: str, lang: str, voice_name: str | None, seed: int) -> tuple[np.ndarray, int, str]:
    """-> (float32 audio, sample_rate, substituted_voice_or_empty)"""
    if lang not in POCKET_LANGS:
        raise ValueError(f"Pocket TTS kennt die Sprache {lang} nicht")
    import torch
    model = get_model(lang)
    sr = int(model.config.mimi.sample_rate)
    voice_ref, is_clone = resolve_voice(voice_name, lang)
    substituted = ""
    if is_clone and not getattr(model, "has_voice_cloning", True):
        voice_ref, substituted = default_voice(lang), default_voice(lang)
    with _gen:
        model.temp = TEMP
        model.lsd_decode_steps = STEPS
        try:
            state = get_state(model, lang, voice_ref)
        except Exception as e:  # noqa: BLE001
            if is_clone:
                log(f"Pocket: Klon {voice_name} nicht ladbar ({str(e)[:120]}) — Katalogstimme")
                voice_ref, substituted = default_voice(lang), default_voice(lang)
                state = get_state(model, lang, voice_ref)
            else:
                raise
        sentences = _split_sentences(text)
        pieces = []
        gap = np.zeros(int(sr * SENTENCE_GAP_MS / 1000), dtype=np.float32)
        for idx, sent in enumerate(sentences):
            if seed is not None and seed >= 0:
                torch.manual_seed(int(seed) + idx)
            guarded = sent.strip()
            if guarded and guarded[0].isalnum():
                guarded = ", " + guarded
            chunks = model.generate_audio_stream(model_state=state, text_to_generate=guarded)
            parts = [np.asarray(c.detach().cpu().numpy(), dtype=np.float32).reshape(-1) for c in chunks]
            piece = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
            piece = _trim_lead(piece, sr, TRIM_LEAD_MS if idx == 0 else 40)
            if len(sentences) > 1:
                piece = _trim_tail(piece, sr, TRIM_TAIL_MS)
            if pieces:
                pieces.append(gap)
            pieces.append(piece)
        audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
        audio = np.concatenate([audio, np.zeros(int(sr * 0.2), dtype=np.float32)])
        _stats["generated"] += 1
    return audio, sr, substituted
