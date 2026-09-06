# Changelog

## 1.0.0 — unreleased

First standalone release.

- Setup wizard: ffmpeg, Python (uv), torch (CUDA/CPU), speech engine, models — all inside the user profile
- Speech engine: OmniVoice (GPU clone + design), Pocket TTS (CPU, catalog voices), Whisper (clone cutting, pronunciation check)
- Six AI providers with fallback chain and DPAPI-encrypted keys
- Wikipedia research, 15 flavours, language and address guards, year spelling
- Line editor with partial re-rendering, voice switching, archive, resumable MP4 export
- Leak check (pre-commit + CI), gitleaks, release build only in GitHub Actions
