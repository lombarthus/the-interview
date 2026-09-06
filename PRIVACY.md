# Privacy

The Interview runs locally. It sends **no telemetry**, has **no account**, and phones home only if you switch on the optional update check.

## Network connections the app makes

| When | Where | What is sent |
|---|---|---|
| Guest search / research | `de.wikipedia.org`, `en.wikipedia.org` | your search term / article title |
| Research from a link | the URL you paste (public hosts only) | an HTTP GET for that page |
| Script, profile, voice design | the AI provider you configured (Anthropic, OpenAI, Google, or your local server) or the CLI you logged into | the prompt: guest brief, theme, flavour, previous-part summaries |
| Update check (**opt-in**, default off) | `api.github.com` | nothing but the request |
| Setup wizard (once) | `gyan.dev` (ffmpeg), python-build-standalone via `uv`, `pypi.org`, `download.pytorch.org`, `huggingface.co` | download requests |
| Pocket TTS catalog voices (first use) | `huggingface.co` | download request |

Nothing else. In particular: no audio, no recordings, no voice clones and no interviews ever leave your PC unless you upload them yourself.

## Where your data lives

`%LOCALAPPDATA%\TheInterview\`

- `config.json` — settings (no secrets)
- `secrets.dpapi` — API keys, DPAPI-encrypted for your Windows user
- `voices/` — your voice clones (recording, 6-s reference clip, transcript)
- `archive/` — interviews (script, WAV, MP3, MP4)
- `models/` — downloaded model weights
- `python/` — the private Python environment
- `work/`, `logs/` — temporary files and logs (logs contain no keys)

Uninstalling asks whether to delete this folder.

## Voice cloning

Clone only voices you have the right to use. The app labels every interview as fictional and AI-generated and can speak that disclaimer at the start.
