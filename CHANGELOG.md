# Changelog

## 1.0.2 — 2026-09-06

- Setup step "Python" no longer uses `uv python install`: on some Windows 11 systems its directory link failed with "untrusted mount point" (os error 448). Python 3.11.16 is now downloaded as a checksum-pinned python-build-standalone archive and unpacked with `tar`; uv only creates the venv. Nothing is written outside the data folder.
- `tools/pin-downloads.js` verifies the Python archive checksum against the publisher's SHA256SUMS

## 1.0.1 — 2026-09-06

- Setup step "Python" failed on PCs where `~/.local/bin` already held a Python launcher: uv now installs with `--no-bin --no-registry`, so nothing is written outside the data folder (no launcher, no Windows registry entry)
- Setup errors show the last line of the failing tool's output
- Setup log is written to `%LOCALAPPDATA%\TheInterview\logs\setup.log`

## 1.0.0 — 2026-09-06

First standalone release.

- Setup wizard: ffmpeg, Python (uv), torch (CUDA/CPU), speech engine, models — all inside the user profile
- Speech engine: OmniVoice (GPU clone + design), Pocket TTS (CPU, catalog voices), Whisper (clone cutting, pronunciation check)
- Six AI providers with fallback chain and DPAPI-encrypted keys
- Wikipedia research, 15 flavours, language and address guards, year spelling
- Line editor with partial re-rendering, voice switching, archive, resumable MP4 export
- Leak check (pre-commit + CI), gitleaks, release build only in GitHub Actions
