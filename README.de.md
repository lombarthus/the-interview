# The Interview

*Fiktive Talkshow-Interviews mit KI-Stimmen — ein Host trifft jeden beliebigen Gast aus Geschichte, Fiktion oder Gegenwart: recherchiert aus Wikipedia, geschrieben von einem Sprachmodell, gesprochen von Klonstimmen, exportiert als MP3 und MP4.*

[English README → README.md](README.md)

Alles läuft auf dem eigenen Windows-PC. Der Gast wird aus Wikipedia (oder einem Link / eigenem Text) recherchiert, ein Sprachmodell schreibt ein mehrteiliges Skript in einem von 15 Flavors (von „klassisch und sachlich" bis „absurdes Theater"), eine lokale Sprach-Engine spricht es mit geklonten oder entworfenen Stimmen, heraus kommen MP3, WAV und ein MP4 mit Untertiteln. Alles ist Fiktion und wird so gekennzeichnet.

> **Original von Arno für SARC-FM.** Dies ist die eigenständige Open-Source-Fassung einer App, die zuerst für einen KI-Radiosender entstand. Sie hat keine Verbindung zu diesem Sender: keine Konten, keine Server, keine Daten des ursprünglichen Autors sind enthalten oder werden kontaktiert.

## Herunterladen und installieren (Windows 10/11, 64-bit)

1. `TheInterview-Setup-<version>.exe` von der [Releases](../../releases)-Seite laden (oder das portable ZIP).
2. Starten. Die Installation geht pro Benutzer nach `%LOCALAPPDATA%\Programs\TheInterview` — keine Adminrechte, keine Änderungen an anderen Programmen, kein PATH-Eintrag.
3. Die App öffnet sich im Browser mit einem **Einrichtungs-Assistenten**, der ausschließlich in dein Benutzerprofil lädt und installiert:

| Schritt | Was | Download | GPU-PC | Nur CPU |
|---|---|---|---|---|
| ffmpeg | Audio/Video-Werkzeug | 110 MB | ✓ | ✓ |
| Python 3.11 | eigene Umgebung über `uv` | 30 MB | ✓ | ✓ |
| torch | CUDA-13.0-Build (NVIDIA-Treiber ab 580) oder CPU-Build | 3 GB / 250 MB | ✓ | ✓ |
| Engine | OmniVoice · Pocket TTS · Whisper | 400 MB | ✓ | ✓ |
| Modelle | OmniVoice + Whisper large / Whisper small + Pocket | 6,6 GB / 0,9 GB | ✓ | ✓ |

Gesamt: etwa **11 GB** mit NVIDIA-GPU (ab 6 GB VRAM), etwa **3,5 GB** ohne. Jeder Schritt lässt sich wiederholen und setzt fort, wo er war.

4. Host-Name und Show-Name eingeben, 15–30 s ins Mikrofon sprechen oder eine Aufnahme ablegen (oder eine Katalogstimme wählen), mindestens einen KI-Anbieter eintragen — fertig.

**Windows SmartScreen** meldet „Unbekannter Herausgeber", weil der Installer nicht signiert ist. SHA-256 in `SHA256SUMS.txt` vergleichen, dann *Weitere Informationen → Trotzdem ausführen*.

## KI-Anbieter

„Auto" probiert, was eingerichtet ist, in dieser Reihenfolge, und springt bei Quota- oder Login-Fehlern weiter:

1. Claude Code CLI (Abo-Login auf diesem PC, wird nur erkannt)
2. OpenAI Codex CLI (ChatGPT-Abo-Login)
3. Anthropic-API-Key
4. OpenAI-API-Key
5. Google-Gemini-API-Key (kostenfreie Flash-Modelle mit Rotation)
6. Lokales Modell über LM Studio / Ollama (OpenAI-kompatibel, offline)

API-Keys liegen **mit Windows DPAPI verschlüsselt** im Benutzerprofil, werden nie wieder angezeigt und nie protokolliert.

## Sprach-Engine

| | NVIDIA-GPU (CUDA) | Nur CPU |
|---|---|---|
| Stimme aus einer Aufnahme klonen | OmniVoice (6-s-Referenzclip) | Pocket TTS (12-s-Vorlage) |
| Stimme aus Attributen entwerfen (Alter, Tonhöhe, Akzent) | ✓ | – |
| Katalogstimmen ohne Klonen | – | ✓ (26 Pocket-TTS-Stimmen) |
| Aussprache-Riegel (Whisper) | large-v3-turbo | small (int8) |

Hinweis CPU: Die Klon-Gewichte von Pocket TTS sind bei Hugging Face freigabepflichtig. Kostenloses Konto anlegen, auf huggingface.co/kyutai/pocket-tts die Bedingungen akzeptieren und einen Lese-Token in der App eintragen (wird verschlüsselt abgelegt). Ohne Token nutzt die App nur Katalogstimmen.

## Bedienung in Kürze

1. **Gast suchen** (Wikipedia de/en) oder Link / eigene Beschreibung.
2. **Recherche** → Charakterprofil (Biografie, Fakten, Sprechweise, Themenvorschläge).
3. **Sprache** Deutsch oder Englisch, bei Deutsch Siezen oder Duzen — wird nach jedem Teil geprüft.
4. **Stimme des Gastes**: Standard, Bibliothek, Klon aus Aufnahme/Mikrofon oder (GPU) KI-Entwurf mit Vorhören.
5. **Flavor** aus 15 Karten oder frei beschreiben.
6. **Titel, Dauer (3–30 min), Teile**, Fiktions-Hinweis.
7. **Generieren** — Skript, Vertonung, Player, Download. Danach: Zeilen per Doppelklick ändern (nur diese werden neu gesprochen), Gaststimme wechseln, Aussprache prüfen, Video produzieren, Archiv.

## Datenschutz und Sicherheit

- Lauscht nur auf `127.0.0.1`. Keine Telemetrie. Keine Update-Prüfung ohne Opt-in.
- Netzverbindungen: Wikipedia, der gewählte KI-Anbieter, eingefügte Links und — beim Setup — GitHub, python.org-Builds über uv, PyPI, download.pytorch.org, huggingface.co. Details in [PRIVACY.md](PRIVACY.md).
- Downloads werden gegen in der App hinterlegte SHA-256-Summen geprüft.
- Nichts aus der Umgebung des ursprünglichen Autors steckt im Repo oder Installer: die Stimmbibliothek startet leer, alle Namen sind konfigurierbar. Das Repo wird bei jedem Commit und in CI auf Leaks geprüft (`tools/leak-check.js`, gitleaks).

Sicherheitslücke melden: [SECURITY.md](SECURITY.md).

## Aus dem Quelltext starten (Entwickler)

Voraussetzungen: Node 24, `uv` im PATH (für die Setup-Schritte), Windows 10/11.

```bash
git clone https://github.com/YOUR-GITHUB-USER/the-interview
cd the-interview
node tools/install-hooks.js      # Pre-Commit-Leak-Check
node tools/smoke.js              # Logik-Tests ohne Netz
dev.cmd                          # http://127.0.0.1:3113 → Setup-Assistent
```

Umgebungsvariablen: `INTERVIEW_HOME` (Datenordner), `INTERVIEW_PORT` (3113), `INTERVIEW_ENGINE_PORT` (3114), `INTERVIEW_FFMPEG_PATH`, `INTERVIEW_PYTHON`, `INTERVIEW_NO_BROWSER=1`.

Aufbau: `app/` Node-Server + Oberfläche (ohne npm-Pakete) · `engine/` Python-Sprach-Engine (FastAPI) · `installer/` Inno Setup · `tools/` Leak-Check, Smoke-Tests · `.github/workflows/` CI und Release-Build. Architektur: [docs/KONZEPT.md](docs/KONZEPT.md).

## Releases

Tag `vX.Y.Z` → GitHub Actions baut `TheInterview-Setup-X.Y.Z.exe`, `TheInterview-portable-X.Y.Z.zip` und `SHA256SUMS.txt` und hängt sie an einen Release-Entwurf. Kein Artefakt entsteht je auf einem Entwickler-PC.

## Lizenz

MIT — siehe [LICENSE](LICENSE). Drittanbieter und Modell-Lizenzen: [THIRD_PARTY.md](THIRD_PARTY.md).
