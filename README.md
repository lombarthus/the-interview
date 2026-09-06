# The Interview

*Fictional talk-show interviews with AI voices — a host meets any guest from history, fiction or the present, researched from Wikipedia, scripted by an LLM, spoken by voice clones, exported as MP3 and MP4.*

[Deutsche Anleitung → README.de.md](README.de.md)

The app runs entirely on your own Windows PC. Guests are researched from Wikipedia (or a link / your own text), a language model writes a multi-part script in one of 15 flavours (from "classic radio" to "theatre of the absurd"), a local speech engine speaks it with cloned or designed voices, and you get MP3, WAV and a subtitled MP4. Everything is fiction and labelled as such.

> **Original by Arno for SARC-FM.** This is the standalone, open-source edition of an app first built for an AI radio station. It has no ties to that station: no accounts, no servers, no data of the original author are included or contacted.

## Download & install (Windows 10/11, 64-bit)

1. Grab `TheInterview-Setup-<version>.exe` from the [Releases](../../releases) page (or the portable ZIP).
2. Run it. It installs per user into `%LOCALAPPDATA%\Programs\TheInterview` — no admin rights, no changes to other programs, no PATH edits.
3. The app opens in your browser with a **setup wizard** that downloads and installs, into your user profile only:

| Step | What | Download | GPU PC | CPU-only PC |
|---|---|---|---|---|
| ffmpeg | audio/video tool | 110 MB | ✓ | ✓ |
| Python 3.11 | private environment via `uv` | 30 MB | ✓ | ✓ |
| torch | CUDA 13.0 build (NVIDIA driver 580 or newer) or CPU build | 3 GB / 250 MB | ✓ | ✓ |
| Engine | OmniVoice · Pocket TTS · Whisper | 400 MB | ✓ | ✓ |
| Models | OmniVoice + Whisper large / Whisper small + Pocket | 6.6 GB / 0.9 GB | ✓ | ✓ |

Total: about **11 GB** with an NVIDIA GPU (6 GB VRAM or more), about **3.5 GB** without. Every step is resumable.

4. Enter a host name and show name, record or upload 15–30 s of your voice (or pick a catalog voice), add at least one AI provider — done.

**Windows SmartScreen** will say "Unknown publisher" because the installer is not code-signed. Compare the SHA-256 in `SHA256SUMS.txt`, then choose *More info → Run anyway*.

## AI providers

"Auto" tries whatever you have set up, in this order, and falls through on quota or login errors:

1. Claude Code CLI (subscription login on this PC, detected only)
2. OpenAI Codex CLI (ChatGPT subscription login)
3. Anthropic API key
4. OpenAI API key
5. Google Gemini API key (free Flash models with rotation)
6. Local model via LM Studio / Ollama (OpenAI-compatible, offline)

API keys are stored **encrypted with Windows DPAPI** in your user profile, never shown again, never logged.

## Speech engine

| | NVIDIA GPU (CUDA) | CPU only |
|---|---|---|
| Voice cloning from a recording | OmniVoice (6-s reference clip) | Pocket TTS (12-s template) |
| Voice design from attributes (age, pitch, accent) | ✓ | – |
| Catalog voices without cloning | – | ✓ (26 Pocket TTS voices) |
| Pronunciation check (Whisper) | large-v3-turbo | small (int8) |

CPU note: Pocket TTS voice-cloning weights are gated on Hugging Face. Create a free account, accept the terms at huggingface.co/kyutai/pocket-tts and paste a read token in the app (stored encrypted). Without it the app uses catalog voices only.

## Privacy & security

- Binds to `127.0.0.1` only. No telemetry. No update check unless you opt in.
- Network connections: Wikipedia, the AI provider you chose, links you paste, and — during setup — GitHub, python.org builds via uv, PyPI, download.pytorch.org, huggingface.co. See [PRIVACY.md](PRIVACY.md).
- Downloads are verified against SHA-256 checksums embedded in the app.
- Nothing from the original author's environment is in this repository or the installer: the voice library starts empty, all names are configurable. The repo is guarded by a leak check on every commit and in CI (`tools/leak-check.js`, gitleaks).

Report a vulnerability: see [SECURITY.md](SECURITY.md).

## Run from source (developers)

Requirements: Node 24, `uv` on PATH (for the setup steps), Windows 10/11.

```bash
git clone https://github.com/lombarthus/the-interview
cd the-interview
node tools/install-hooks.js      # pre-commit leak check
node tools/smoke.js              # logic tests, no network
dev.cmd                          # http://127.0.0.1:3113 → setup wizard
```

Environment overrides: `INTERVIEW_HOME` (data folder), `INTERVIEW_PORT` (3113), `INTERVIEW_ENGINE_PORT` (3114), `INTERVIEW_FFMPEG_PATH`, `INTERVIEW_PYTHON`, `INTERVIEW_NO_BROWSER=1`.

Layout: `app/` Node server + UI (no npm dependencies) · `engine/` Python speech engine (FastAPI) · `installer/` Inno Setup · `tools/` leak check, smoke tests · `.github/workflows/` CI and release build. Architecture notes: [docs/KONZEPT.md](docs/KONZEPT.md) (German).

## Releases

Tag `vX.Y.Z` → GitHub Actions builds `TheInterview-Setup-X.Y.Z.exe`, `TheInterview-portable-X.Y.Z.zip` and `SHA256SUMS.txt` and attaches them to a draft release. No artefact is ever built on a developer machine.

## License

MIT — see [LICENSE](LICENSE). Third-party components and model licenses: [THIRD_PARTY.md](THIRD_PARTY.md).
