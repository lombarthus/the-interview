"""Modelle für das gewählte Profil in den HF-Cache (HF_HOME im Datenordner) laden.
Fortschritt als JSON-Zeilen auf stdout ({"progress":true,"done":..,"total":..,"label":..}), damit
der Setup-Assistent ihn anzeigen kann. Wiederaufnehmbar: huggingface_hub lädt nur fehlende Dateien."""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time

GPU = ["k2-fsa/OmniVoice", "openai/whisper-large-v3-turbo"]
CPU = ["Systran/faster-whisper-small"]
POCKET_VOICES = ["kyutai/tts-voices"]   # Katalogstimmen (alba, juergen, …), kleine Dateien


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def snapshot(repo: str, label: str, allow=None):
    from huggingface_hub import snapshot_download
    emit(log=f"{label}: prüfe {repo} …")
    emit(progress=True, done=0, total=1, label=f"{label} ({repo})")
    done = {"finished": False}

    def ticker():
        t0 = time.time()
        while not done["finished"]:
            time.sleep(2)
            emit(progress=True, done=0, total=1, label=f"{label} ({repo}) … {int(time.time() - t0)} s")

    threading.Thread(target=ticker, daemon=True).start()
    try:
        path = snapshot_download(repo, allow_patterns=allow)
    finally:
        done["finished"] = True
    emit(log=f"{label}: bereit ({path})")
    return path


def pocket_models(langs):
    """Pocket lädt seine Gewichte über die Bibliothek; einmal laden = im Cache."""
    from pocket_tts.models.tts_model import TTSModel
    for lang in langs:
        emit(progress=True, done=0, total=1, label=f"Pocket TTS {lang}")
        emit(log=f"Pocket TTS: lade Modell {lang} …")
        m = TTSModel.load_model(language=lang, temp=0.4, lsd_decode_steps=4)
        try:
            from pocket_tts.default_parameters import get_default_voice_for_language
            m.get_state_for_audio_prompt(get_default_voice_for_language(lang))
        except Exception as e:  # noqa: BLE001
            emit(log=f"Pocket TTS: Katalogstimme für {lang} nicht vorgewärmt ({e})")
        del m
        emit(log=f"Pocket TTS: {lang} bereit")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", choices=["gpu", "cpu"], required=True)
    ap.add_argument("--langs", default="german_24l,english")
    args = ap.parse_args()
    steps = []
    if args.profile == "gpu":
        steps += [(r, "OmniVoice" if "Omni" in r else "Whisper") for r in GPU]
    else:
        steps += [(r, "Whisper (klein)") for r in CPU]
    total = len(steps) + 1
    for i, (repo, label) in enumerate(steps):
        emit(progress=True, done=i, total=total, label=f"{label} wird geladen")
        snapshot(repo, label)
    emit(progress=True, done=len(steps), total=total, label="Pocket TTS wird geladen")
    pocket_models([s.strip() for s in args.langs.split(",") if s.strip()])
    emit(progress=True, done=total, total=total, label="Modelle vollständig")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit(log=f"Fehler: {type(e).__name__}: {e}")
        sys.exit(1)
