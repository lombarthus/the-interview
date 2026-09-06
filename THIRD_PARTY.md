# Third-party components

Nothing below is redistributed in this repository. The installer ships Node.js and uv; everything else is downloaded by the setup wizard into the user's profile.

| Component | Used for | License | Shipped in installer? |
|---|---|---|---|
| [Node.js](https://nodejs.org) 24 | app server | MIT | yes (`runtime/node/`) |
| [uv](https://github.com/astral-sh/uv) | Python install + packages | MIT / Apache-2.0 | yes (`runtime/uv.exe`) |
| [python-build-standalone](https://github.com/astral-sh/python-build-standalone) 3.11 | engine runtime | PSF | no — setup |
| [ffmpeg](https://ffmpeg.org) (gyan.dev essentials build) | audio/video | GPL v3 | no — setup |
| [PyTorch](https://pytorch.org) | inference | BSD-3 | no — setup |
| [FastAPI](https://fastapi.tiangolo.com), [uvicorn](https://www.uvicorn.org) | engine HTTP | MIT / BSD-3 | no — setup |
| [OmniVoice](https://github.com/k2-fsa/OmniVoice) (code + weights `k2-fsa/OmniVoice`) | GPU voice clone / design | Apache-2.0 — verify in the upstream repository | no — setup |
| [pocket-tts](https://github.com/kyutai-labs/pocket-tts) (kyutai) | CPU TTS, catalog voices | code: MIT; weights and catalog voices: CC-BY-4.0 — verify upstream | no — setup |
| [Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) via transformers | GPU pronunciation check, clone cutting | MIT (model), Apache-2.0 (transformers) | no — setup |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) + `Systran/faster-whisper-small` | CPU pronunciation check, clone cutting | MIT | no — setup |
| [Pillow](https://python-pillow.org), numpy, soundfile, huggingface_hub | video text cards, audio I/O, model download | MIT-CMU / BSD / BSD / Apache-2.0 | no — setup |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | building the installer (CI only) | Inno Setup License | no |
| Windows fonts (Bahnschrift, Segoe UI) | video overlays, if present on the PC | Microsoft — used, not distributed | no |

Data sources at runtime: Wikipedia (CC BY-SA text, attribution kept via source link in the profile).

Model attribution notes: when you publish audio made with Pocket TTS catalog voices, respect the CC-BY-4.0 attribution requirement of kyutai's voice dataset.
