# Security Policy

## Reporting a vulnerability

Please open a **private security advisory** on GitHub (Security → Advisories → "Report a vulnerability") instead of a public issue. You will get an answer within 7 days.

## Scope and design

- The app binds to `127.0.0.1` only (Node on port 3113, the Python engine on 3114). It does not listen on the network.
- API requests are accepted only from the app's own origin (`Origin` header check); there is no CORS.
- API keys are stored with Windows DPAPI (current-user scope) in `%LOCALAPPDATA%\TheInterview\secrets.dpapi`, never in `config.json`, never returned by any endpoint, and scrubbed from logs and job protocols.
- Links entered for research go through an SSRF guard (no private, link-local or loopback targets, redirects re-checked).
- Downloads during setup are verified against SHA-256 checksums embedded in `app/lib/downloads.json`; Python packages are installed by `uv` with hash-checked wheels.
- Child processes (ffmpeg, engine, CLIs) are started without a shell and with timeouts.
- The installer is not code-signed (yet). Verify `SHA256SUMS.txt` from the release.

## Supply-chain guard for this repository

- `tools/leak-check.js` runs as a pre-commit hook and in CI against the working tree and the full history (secrets, personal paths, forbidden file types).
- gitleaks runs in CI on every push.
- Release artefacts are built only by GitHub Actions from the tagged commit.
