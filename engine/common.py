"""Gemeinsames für die Engine: Pfade, ffmpeg, Sprachtabellen, Geräteerkennung."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

VOICES_DIR = Path(os.environ.get("INTERVIEW_VOICES_DIR") or (Path.home() / "AppData" / "Local" / "TheInterview" / "voices"))
WORK_DIR = Path(os.environ.get("INTERVIEW_WORK") or (VOICES_DIR.parent / "work" / "engine"))
FFMPEG = os.environ.get("INTERVIEW_FFMPEG") or "ffmpeg"
SAMPLE_RATE = 24000

# Sprach-Kürzel -> OmniVoice-Name / Pocket-Modell-ID / Whisper-Code
LANG = {
    "de": {"omni": "German", "pocket": "german_24l", "whisper": "de"},
    "en": {"omni": "English", "pocket": "english", "whisper": "en"},
    "es": {"omni": "Spanish", "pocket": "spanish_24l", "whisper": "es"},
    "fr": {"omni": "French", "pocket": "french_24l", "whisper": "fr"},
    "it": {"omni": "Italian", "pocket": "italian_24l", "whisper": "it"},
    "pt": {"omni": "Portuguese", "pocket": "portuguese_24l", "whisper": "pt"},
}
POCKET_LANGS = set(LANG.keys())


def norm_lang(value: str | None, default: str = "en") -> str:
    v = (value or "").strip().lower()
    if v in LANG:
        return v
    for code, row in LANG.items():
        if v in (row["omni"].lower(), row["pocket"], row["whisper"]):
            return code
    return default


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def ffmpeg(args: list[str]) -> None:
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def device_name() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return "cpu"
