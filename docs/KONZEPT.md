# The Interview — Standalone-Konzept (GitHub-Version, Windows-EXE)

Stand: 2026-09-06 · Status: **Entwurf zur Freigabe** · Ursprung: Standalone-Ableitung der Launchpad-App „The Interview“

Ziel in einem Satz: Ein Fremder lädt `TheInterview-Setup.exe` von GitHub, doppelklickt, und hat nach
dem Assistenten ein lauffähiges „The Interview" auf seinem Windows-PC — ohne Launchpad, ohne SARC-FM,
ohne dass irgendetwas von Arnos Rechner, Konten oder Stimmen im Repo oder in der EXE steckt.

---

## 0. Kurzfassung der Entscheidungen

| # | Frage | Entscheidung (Vorschlag) |
|---|---|---|
| 1 | Was wird die Standalone-App? | Ein **neuer, eigenständiger Codebaum** in `Standalone/` (Node + eine eigene Python-Engine), abgeleitet aus dem Bestand, aber ohne jede Referenz auf Launchpad, Hermann, Voice Clone, tts-player, SARC-FM |
| 2 | Wie kommt Sprache raus? | Eigene **Engine** `engine/` (Python, ein Prozess): OmniVoice (GPU) + Pocket TTS (CPU) + Whisper (Klon-Schnitt und Aussprache-Riegel). Ersetzt `omnivoice_server`, `pocket_tts_server`, `voiceclone`, `verify_worker.py` |
| 3 | Welche LLMs? | Eigene schlanke Provider-Schicht: Claude Code CLI · Codex CLI · Anthropic API · OpenAI API · Gemini API · lokal (LM Studio/Ollama, OpenAI-kompatibel). „Auto" probiert in dieser Reihenfolge nur das, was eingerichtet ist |
| 4 | Ohne NVIDIA-GPU? | **Ja, läuft** — Pocket TTS (CPU) + faster-whisper small. Voice Design ist dann ausgegraut (braucht OmniVoice) |
| 5 | Was ist die EXE? | **Inno-Setup-Installer** (≈ 45 MB), Installation pro Benutzer ohne Adminrechte. Enthält App, `node.exe`, `uv.exe`. Beim ersten Start holt ein **Assistent im Browser** ffmpeg, Python, torch, die Engine-Pakete und die Modelle (3,3 GB CPU / 11 GB GPU) mit Fortschrittsanzeige |
| 6 | Wo wird gebaut? | **Nur in GitHub Actions** (windows-latest). Kein lokal gebautes Artefakt geht je auf GitHub |
| 7 | Leak-Schutz | Vier Riegel: sauberer Repo-Start (`git init` in `Standalone/`, keine Historie) · `tools/leak-check.js` als Pre-Commit-Hook **und** CI-Gate · gitleaks + GitHub Push Protection · Release nur aus CI. Plus Laufzeit: Keys DPAPI-verschlüsselt, nur 127.0.0.1, Log-Maskierung |
| 8 | Branding | In-App neutral: Host-Name und Show-Name werden im Assistenten eingegeben (Vorgabe „The Interview"). Kein Sender-Logo, keine Sender-URL im Video. Autoren-Credit nur in README/About („Original von Arno für SARC-FM") — **bitte bestätigen** |
| 9 | UI-Sprache | v1: Oberfläche **Deutsch** (wie jetzt), README **Englisch + Deutsch**. Englische Oberfläche als v1.1 (Strings sind dafür in einer Tabelle vorbereitet) |
| 10 | Lizenz | **MIT** für eigenen Code; Drittanbieter in `THIRD_PARTY.md`. ffmpeg/Modelle werden **beim Installieren heruntergeladen**, nie mitgeliefert (keine GPL-/Gewichts-Redistribution) |
| 11 | Ports | App **3113**, Engine **3114** (nicht 3013/3008/3009, damit Arnos Launchpad parallel weiterläuft) |
| 12 | Code-Signatur | v1 **ohne** (SmartScreen-Warnung „Unbekannter Herausgeber", in README erklärt). Später SignPath.io für Open Source, kostenlos |

Aufwand (Schätzung): Implementierung ≈ 3 200 Zeilen neu/geändert, 1 Arbeitssession; danach 1 Testlauf in einer
sauberen Windows-11-Sandbox (CPU-Pfad, ≈ 60 min inkl. Downloads) und 1 GPU-Test auf Arnos PC mit
frischem Datenordner (≈ 30 min).

---

## 1. Was im Bestand hängt woran (Ist-Analyse)

Gelesen: `server.js` (1 072 Zeilen), `lib/*` (2 100 Zeilen), `public/*`, `tools/*`, `HANDOFF.md`, `README.md`,
dazu `apps/hermann/llm-fallback.js`, `apps/voiceclone`, `omnivoice_server`, `pocket_tts_server`, `tts-player/voices`.

| Abhängigkeit | Wo im Code | Art | Standalone |
|---|---|---|---|
| Launchpad (Port aus `PORT`, Manifest, `/app/<id>/`-Proxy) | `manifest.json`, `server.js` | Start/Proxy | eigener Launcher, absolute Vorgabe 3113, relative Pfade bleiben |
| `apps/hermann/llm-fallback.js` (Codex, Gemini-Pool, LM Studio) | `lib/llm.js` `loadFallbackModule` (Pfad `../../hermann/`) | `require` über Ordnergrenze | **ersetzt** durch `app/lib/providers/*.js` (eigene, kleine Implementierungen) |
| Claude Code CLI (MSIX-Pfad unter `%LOCALAPPDATA%\Packages\Claude_*`) | `lib/llm.js` `resolveClaudeCmd` | Prozess | bleibt als optionaler Provider (Erkennung generisch: PATH + bekannte Orte) |
| OmniVoice `:3008` (`/status`, `/generate` mit `voice_name`/`instruct`) | `lib/tts.js`, `server.js` `designClip` | HTTP | **Engine** `:3114` mit gleichem Vertrag (`/generate`) |
| Pocket TTS `:3009` | `lib/tts.js` | HTTP | in der Engine |
| Voice Clone `:3012` (`/api/clone`, `/api/jobs`, `/voices/<n>/words`, `/transcript`) | `server.js` Proxy-Routen, `finalizeDesignVoice` | HTTP | in der Engine (`/clone`, `/voices/<n>/words`, `/voices/<n>/recut`) |
| Whisper-Prüfer aus der omnivoice-venv (`<Workspace>\omnivoice_server\.venv`) | `lib/verify.js`, `tools/verify_worker.py` | Prozess + harter Pfad | in der Engine (`/transcribe`) |
| Stimmbibliothek `<Workspace>\tts-player\voices` | `server.js` `VOICES_DIR` | harter Pfad | `%LOCALAPPDATA%\TheInterview\voices\` (leer bei Auslieferung) |
| SARC-FM `:3030` (Host-Stimme, Daypart, Publish, Talk-Modus, Rotation) + Sender-Statusdateien | `lib/sarcfm.js`, `server.js` `runAiring/airPlan/startAiring`, Routen `/api/sarcfm/*`, `/api/air/*`, `…/air`, `…/air-plan`; UI „ON AIR"-Balken, Checkbox, ⚙ `airSongs/airGapMin` | HTTP + Datei | **entfällt komplett** (≈ 420 Zeilen Server, ≈ 90 Zeilen UI, `lib/sarcfm.js`, `tools/verify_air_gap.js`) |
| SARC-FM-Branding | `assets/sarcfm-logo.png`, `lib/video.js` (Logo, Sender-URL, Claim im Abbinder), `lib/script.js` (System-Prompt „AI radio station SARC-FM", Flavor „reverse", `DISCLAIMER` „hier ist Arno"), `index.html` | Inhalt | neutral + konfigurierbar (Host-Name, Show-Name, optional URL) |
| Python + Pillow (System-Python) für Textkarten/Wortmarke | `lib/video.js` `PYTHON = 'python'` | Prozess | Engine-Python (liegt dann sicher vor) |
| ffmpeg aus PATH / Fremdinstallation | `lib/tts.js`, `lib/video.js` | Prozess | im Datenordner installiert, Pfad fest bekannt |
| Persönliche Daten | `data/`, `work/`, `*.bak-*`, Arnos Stimme `Arno_2` (Transkript = Arnos Satz über seinen KI-Clone), `Hermann` u. a. | Dateien | **kommen nie ins Repo** (siehe §6) |

Nicht betroffen (reine Logik, wird übernommen und nur entpersonalisiert): `lib/lang.js`, `lib/years.js`,
`lib/research.js`, `lib/script.js` (Prompts, Flavors, Planung), `lib/store.js`, der Großteil von `lib/tts.js`
(PCM-Zusammenbau, Lautstärke-Angleich, Teil-Neuvertonung), `lib/video.js` (Segment-Rendering, Wiederaufnahme),
`lib/verify.js` `compare()` (Wort-Levenshtein), `tools/cards.py`, `tools/wordmark.py`.

---

## 2. Zielarchitektur

```
TheInterview-Setup.exe  (Inno Setup, ≈ 45 MB)
 └─ %LOCALAPPDATA%\Programs\TheInterview\          Programm (nur Code + Runtimes, austauschbar bei Update)
     ├─ TheInterview.cmd                            Launcher: Engine starten → App starten → Browser öffnen
     ├─ runtime\node\node.exe                       Node 24 LTS (offizielles Zip, aus CI geladen, SHA-256 geprüft)
     ├─ runtime\uv.exe                              uv (Astral): lädt Python 3.11, baut venv, installiert Pakete, alles hash-geprüft
     ├─ app\                                        Node-Server ohne npm-Abhängigkeiten
     │   ├─ server.js                               HTTP 127.0.0.1:3113, Jobs, Archiv, Setup-Assistent, statische UI
     │   ├─ lib\ {llm, providers\*, secrets, research, script, lang, years, tts, verify, video, store, engine, setup}.js
     │   ├─ public\ {index.html, app.js, style.css, setup.html}
     │   └─ assets\ logo.png (neutral, eigenes Mikrofon-Icon)
     ├─ engine\                                     Python-Dienst 127.0.0.1:3114
     │   ├─ server.py                               FastAPI: /status /load /unload /generate /clone /voices… /transcribe /words
     │   ├─ omni.py  pocket.py  asr.py  clone.py    Adapter je Engine, Klon-Schnitt an Wortgrenze (aus clone_prep.py abgeleitet)
     │   ├─ cards.py  wordmark.py                   Video-Textkarten (Pillow)
     │   └─ requirements-{gpu,cpu}.txt
     └─ setup\ bootstrap.ps1                        Erststart-Schritte, idempotent, von der App gesteuert

 └─ %LOCALAPPDATA%\TheInterview\                   Daten (bleiben bei Update/Deinstallation wählbar erhalten)
     ├─ config.json                                 Einstellungen (kein Geheimnis darin)
     ├─ secrets.dpapi                               API-Keys, DPAPI-verschlüsselt (Windows-Benutzerkontext)
     ├─ voices\<Name>\ {audio.wav, ref.txt, lang.txt, audio.<lang>.wav, original.wav, words.json}
     ├─ archive\<id>\ {interview.json, audio.wav, audio.mp3, video.mp4}
     ├─ tools\ffmpeg\ffmpeg.exe                     beim Setup geladen (BtbN/gyan.dev, SHA-256 geprüft)
     ├─ python\  .venv\                             von uv erzeugt
     ├─ models\  (HF-Cache: OmniVoice ≈ 5 GB, Pocket ≈ 0,4 GB, Whisper 1,6 GB GPU / 0,5 GB CPU)
     ├─ work\  logs\
```

### 2.1 App (Node, ohne npm-Pakete — wie bisher)

- `server.js`: Übernahme der Routen ohne SARC-FM/Voice-Clone-Proxy. Neu: `/api/setup/*` (Assistent, Fortschritt der
  Bootstrap-Schritte, Engine-Start), `/api/secrets` (Key setzen/löschen, nie lesen — Antwort nur maskiert `AIza…3f`),
  `/api/engine/status`. Der Server startet die Engine als Kindprozess und beendet sie mit.
- `lib/llm.js`: eigene Kette. `runChat({only})` wie bisher, Provider-Module in `lib/providers/`:
  `claude-cli.js` (bestehender Code, generische Pfadsuche), `codex-cli.js` (schlank: `codex exec --json`, ≈ 80 Zeilen,
  kein MCP/Agent-Modus), `anthropic.js` (Messages API, `claude-sonnet-5` Default), `openai.js` (Chat Completions,
  `gpt-5-mini` Default), `gemini.js` (Free-Flash-Pool mit Rotation, Modellliste aus dem Bestand), `local.js`
  (OpenAI-kompatibel, URL + Modell frei, Default LM Studio `:1234`, Ollama-Preset `:11434`). Alle mit
  `check(depth)` (cheap = Version/Login/`GET /models`, deep = „ping"). Quota-Erkennung wie bisher.
- `lib/secrets.js`: DPAPI über PowerShell (`System.Security.Cryptography.ProtectedData`), kein natives Modul.
  Fallback bei fehlendem PowerShell: Datei mit Warnung im UI. Keys werden in Logs/Jobs durch eine zentrale
  `mask()` ersetzt; `process.env`-Keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` + Aliasse) werden
  zusätzlich akzeptiert.
- `lib/engine.js`: ersetzt `omnivoiceStatus/pocketStatus`, den Voice-Clone-Proxy, `verify.js` `transcribe()`
  und `designClip` — alles gegen `:3114`.
- `lib/script.js`: `hostName`, `showName` als Parameter statt „Arno"/„SARC-FM"; Flavor „Rollentausch" neu
  formuliert („der Gast interviewt den Host über seine KI-Talkshow"); Disclaimer mit Host-Namen.
- `lib/video.js`: Logo/Abbinder aus Einstellungen (Show-Name, optionale URL, optionales eigenes Logo-PNG);
  Python = Engine-Python; Fonts Bahnschrift/Segoe UI mit Fallback Arial.
- `lib/research.js`: **SSRF-Riegel** für freie Links (keine privaten/Link-lokalen Adressen, kein `localhost`) —
  im Bestand nicht nötig, für eine veröffentlichte App Pflicht.
- UI: Schritt 4 (Stimme) spricht mit der Engine; Mikrofon-Aufnahme im Browser (aus Voice Clone übernommen);
  Setup-Seite `setup.html` mit Schrittliste + Live-Log; ⚙ mit Provider-Karten und Key-Feldern (Eingabe als
  `type=password`, nach dem Speichern nur Maske).

### 2.2 Engine (Python, ein Prozess, ein Port)

| Endpunkt | Zweck | Herkunft |
|---|---|---|
| `GET /status` | Gerät (cuda/cpu), geladene Modelle, Engines verfügbar | neu |
| `POST /load`, `/unload` | OmniVoice in VRAM laden/freigeben (lazy) | `omnivoice_server` |
| `POST /generate` | Form `text, language, voice_name, instruct, seed, engine=auto|omnivoice|pocket` → WAV 24 kHz mono. Vertrag identisch zum Bestand, damit `tts.js` fast unverändert bleibt | `omnivoice_server`, `pocket_tts_server` |
| `POST /clone` | Upload (beliebiges Audio/Video, ffmpeg → 24 kHz) → Whisper-Wortzeiten → 6-s-Clip an Wortgrenze in Pause + 12-s-Pocket-Vorlage + `ref.txt` | `voiceclone/clone_prep.py` (abgeleitet, entpersonalisiert) |
| `GET /voices`, `GET /voices/{n}/words`, `POST /voices/{n}/recut`, `DELETE /voices/{n}`, `POST /voices/{n}/rename` | Bibliothek | `voiceclone/server.js` |
| `POST /transcribe` | WAV → Text (Aussprache-Riegel) | `tools/verify_worker.py` |
| `POST /cards`, `/wordmark` | Textkarten/Wortmarke für Video (Pillow) | `tools/cards.py`, `tools/wordmark.py` |

Geräteregel: `torch.cuda.is_available()` → OmniVoice + Whisper-large-v3-turbo (fp16); sonst Pocket TTS +
faster-whisper `small` (int8). Nur eine Generierung zugleich (Lock), wie bisher. Modelle landen unter
`%LOCALAPPDATA%\TheInterview\models` (`HF_HOME`), `HF_HUB_OFFLINE=1` sobald vorhanden.

### 2.3 Installer und Erststart

**Installer** (`installer/TheInterview.iss`): pro Benutzer (`PrivilegesRequired=lowest`), Zielordner
`{localappdata}\Programs\TheInterview`, Startmenü + optional Desktop-Verknüpfung, „Daten behalten?"
bei Deinstallation. Enthält: `app/`, `engine/` (nur Quelltext), `runtime/node/`, `runtime/uv.exe`, `setup/`.
Größe ≈ 45 MB. Zusätzlich aus demselben CI-Lauf: `TheInterview-portable.zip` (gleicher Inhalt, ohne Installer).

**Erststart-Assistent** (im Browser, von der App gesteuert, jeder Schritt einzeln wiederholbar):

| Schritt | Was passiert | Download | Dauer (Schätzung, 100 Mbit/s) |
|---|---|---|---|
| 1 Systemcheck | Windows-Version, freier Speicher, `nvidia-smi` (GPU-Name, VRAM), PowerShell | – | 2 s |
| 2 ffmpeg | BtbN-Release-Zip, SHA-256 gegen eingebettete Prüfsumme | 90 MB | 20 s |
| 3 Python | `uv python install 3.11` + `uv venv` | 30 MB | 20 s |
| 4 torch | GPU: `torch` cu130 (RTX 20xx–50xx, Treiber ≥ 580) · CPU: torch-cpu | 2,8 GB / 0,2 GB | 5 min / 30 s |
| 5 Engine-Pakete | `uv pip install -r requirements-{gpu,cpu}.txt` (omnivoice, pocket-tts, transformers/faster-whisper, fastapi, soundfile, pillow) | 400 MB | 1 min |
| 6 Modelle | GPU: OmniVoice + whisper-large-v3-turbo · CPU: pocket-tts + whisper-small; Download mit Fortschritt, wiederaufnehmbar | 6,6 GB / 0,9 GB | 10 min / 2 min |
| 7 Show & Host | Show-Name, Host-Name, Sprache der Oberfläche (v1: de) | – | – |
| 8 Host-Stimme | (a) 15 s ins Mikrofon sprechen oder Datei ablegen → Klon, (b) GPU: Stimme entwerfen, (c) Pocket-Preset (falls das Paket welche mitbringt — beim Umsetzen prüfen) | – | 1 min |
| 9 KI-Anbieter | Karte wählen, Key eintragen oder CLI/lokal erkennen lassen, „Test now" | – | 1 min |

Gesamt: CPU-PC ≈ 3,3 GB Platte, ≈ 6 min; GPU-PC ≈ 11 GB, ≈ 20 min. Abbruch ist ungefährlich: jeder Schritt
prüft erst, was schon da ist. Ohne Assistent lässt sich alles auch per `setup\bootstrap.ps1 -All` fahren.

**Update:** neue Setup.exe drüberinstallieren; Daten- und Modellordner bleiben. In-App-Hinweis „Version x.y
verfügbar" über die GitHub-Releases-API (nur wenn in ⚙ eingeschaltet, Default aus — keine stillen Netzaufrufe).

---

## 3. Funktionsumfang (Soll gegen Ist)

Bleibt vollständig: Gastsuche (Wikipedia de/en), Link/Text-Recherche, Charakterprofil, Sprache + Anrede-Riegel,
Sprach-Riegel, Jahreszahlen, 15 Flavors + eigener Flavor, Dauer-Slider und Teileplanung, Skript in Teilen,
Vertonung mit festen Seeds, Lautstärke-Angleich, Aussprache-Riegel (Whisper) inkl. „Aussprache prüfen" im Archiv,
Zeilen-Editor mit Teil-Neuvertonung, Gaststimme wechseln, komplett neu vertonen, Regenerieren, Archiv (umbenennen,
sortieren, löschen in Papierkorb), MP3/WAV-Download, Skript als Text, Video-Export mit Segmenten und Wiederaufnahme
nach Neustart, Voice Design (GPU), Voice Clone (Upload und Mikrofon), Backend-Chip + ⚙ mit Status-LEDs und Tests.

Entfällt: alles SARC-FM (Einspielen, Ansagen, Daypart-Logik, Songgrenzen, ON-AIR-Balken), Host-Stimme aus SARC-FM.

Neu: Setup-Assistent, Provider-Karten mit Key-Verwaltung, Engine-Verwaltung (Start/Stop/Modelle laden),
Host-/Show-Name, eigenes Logo fürs Video, SSRF-Riegel, portable Variante, Update-Hinweis (opt-in).

Bewusst nicht in v1: englische Oberfläche, macOS/Linux (Engine wäre portabel, Installer/DPAPI nicht), Tray-Icon
statt Konsolenfenster (Launcher startet minimiert; Tray als v1.1), Code-Signatur.

---

## 4. Provider-Kette im Detail

„Auto" = Reihenfolge Claude Code CLI → Codex CLI → Anthropic API → OpenAI API → Gemini → lokal; jede Stufe wird
nur probiert, wenn sie eingerichtet ist (CLI gefunden **und** eingeloggt, Key vorhanden, lokale URL antwortet).
Quota/429/Auth-Fehler → nächste Stufe, alles im Job-Protokoll (Chip gelb bei Fallback). Manuelle Wahl pinnt.
Reihenfolge ist im ⚙ per Drag änderbar (gespeichert in `config.json`). Ohne einen einzigen eingerichteten
Provider zeigt die App beim Generieren eine klare Karte „KI-Anbieter einrichten" statt eines Fehlers.

Prompts bleiben die geprüften aus `lib/script.js` (inkl. `NO_TOOLS`-Satz). Claude CLI wird wie bisher mit
`--allowed-tools '' --strict-mcp-config` gestartet; Codex mit `--sandbox read-only`, ohne MCP.

---

## 5. Repo-Layout und Veröffentlichung

```
Standalone/                    ← wird das GitHub-Repo (Vorschlag: github.com/<Arno>/the-interview)
├─ README.md (EN)  README.de.md  SECURITY.md  PRIVACY.md  LICENSE (MIT)  THIRD_PARTY.md  CHANGELOG.md
├─ app/  engine/  installer/  setup/  tools/  docs/
├─ .github/workflows/ci.yml        leak-check + gitleaks + Syntax/Smoke (node --check, py_compile, Unit-Tests ohne Modelle) bei jedem Push/PR
├─ .github/workflows/release.yml   bei Tag v*: node.zip + uv.exe laden (SHA-256), Inno Setup, Setup.exe + portable.zip + SHA256SUMS an das Release hängen
├─ .gitignore  .gitattributes  .editorconfig
└─ KONZEPT.md (diese Datei; wandert vor dem ersten Push nach docs/ oder wird gelöscht — Entscheidung Arno)
```

`PRIVACY.md` listet jede Netzverbindung der App: Wikipedia (Suche/Volltext), der gewählte KI-Anbieter, frei
eingegebene Links, beim Setup: GitHub (ffmpeg, node, uv), python.org-Builds via uv, PyPI, download.pytorch.org,
huggingface.co. Sonst nichts — keine Telemetrie, keine Update-Prüfung ohne Opt-in.

Release-Ablauf: Tag `v1.0.0` → CI baut → Release-Entwurf mit Setup.exe, portable.zip, SHA256SUMS → Arno
prüft und veröffentlicht. GitHub-Repo-Einstellungen: Secret Scanning + Push Protection an, Branch-Schutz auf
`main` (CI muss grün sein).

---

## 6. Sicherheits- und Leak-Konzept (der Kern der Aufgabe)

**Grundsatz:** Das Repo entsteht als **Reinraum**. `Standalone/` wird mit `git init` ein eigenes Repository ohne
Historie; es gibt keine Symlinks, Submodule oder `require`-Pfade nach außen. Alles, was hineinkommt, wird
geschrieben oder bewusst kopiert und dabei gelesen — nie per `cp -r` aus `data/`, `work/`, `voices/`.

**Was nie ins Repo darf** (Verbotsliste, maschinell geprüft):

| Kategorie | Beispiele | Prüfung |
|---|---|---|
| Geheimnisse | `AIza…`, `AQ.…` (Gemini), `sk-…`, `sk-ant-…`, `ghp_/gho_/github_pat_`, `xoxb-`, `-----BEGIN … PRIVATE KEY`, JWTs, Bearer-Token, `auth.json` | Regex + Shannon-Entropie (≥ 4,0 bei ≥ 20 Zeichen ohne Leerzeichen) |
| Identität/Umgebung | Windows-Benutzername, E-Mail-Adresse, Workspace-Laufwerkspfade, Benutzerprofil-Pfade, Fremdinstallationen, GitHub-Kontoname, Sender-Domain, Sender- und Nachbar-App-Präfixe, private IPs ≠ 127.0.0.1 | Wortliste (konfigurierbar in `tools/leak-check.config.json`, liegt selbst NICHT im Repo, sondern nur lokal — Muster dafür im Repo) |
| Dateien | `*.wav *.mp3 *.mp4 *.m4a *.flac *.ogg`, `*.env*`, `*.bak*`, `*.pem *.key *.pfx`, `secrets.*`, `voice_settings.json`, `data/`, `work/`, `voices/`, `models/`, `*.safetensors *.bin *.pt` | `.gitignore` + Endungs-Denylist im Check (auch für versehentlich `git add -f`) |
| Persönliche Inhalte | Archiv-Interviews, Klonstimmen, Transkripte (`ref.txt`), Job-Logs | Ordner sind ignoriert **und** die lokale Verbotsliste enthält die Namen der Bibliotheksstimmen und Arnos Klon-Transkript |

**Vier Riegel, in dieser Reihenfolge wirksam:**

1. **Pre-Commit-Hook** (`tools/leak-check.js`, installiert per `node tools/install-hooks.js`): prüft die
   gestageten Dateien; Treffer = Commit abgelehnt mit Datei:Zeile. Läuft in < 1 s.
2. **CI-Gate** bei jedem Push/PR: derselbe Check über den ganzen Baum **plus** `gitleaks` (Standardregeln)
   **plus** `git log -p` der gesamten Historie durch den Check (fängt Dinge, die vor dem Hook committet wurden).
3. **GitHub Push Protection** (Repo-Einstellung): blockiert bekannte Token-Formate serverseitig.
4. **Release nur aus CI**: Setup.exe entsteht auf einem GitHub-Runner aus dem getaggten Commit. Lokale
   Pfade oder Umgebungsvariablen von Arnos PC können gar nicht in ein Artefakt geraten.

**Vor dem allerersten Push** zusätzlich manuell: `node tools/leak-check.js --all --history` und ein Blick auf
`git ls-files` (Erwartung: nur Text, PNG-Logo, Icon, `.iss`, Workflows).

**Laufzeit-Sicherheit der ausgelieferten App:**

- Bindet ausschließlich an `127.0.0.1` (App und Engine). Kein CORS, keine Fremd-Origins.
- API-Keys: DPAPI-verschlüsselt im Benutzerkontext; nie im Klartext auf Platte, nie in `config.json`, nie im
  Health-Endpunkt, nie in Job-Logs (`mask()` an der einzigen Stelle, wo Fehlertexte von Anbietern durchgereicht
  werden). Eingabefeld ist `type=password`; die API gibt Keys nie zurück.
- Downloads beim Setup: nur HTTPS, feste URLs, **SHA-256 in der App eingebettet** für ffmpeg, node, uv; Python
  und Pakete über uv (Hash-geprüfte Wheels aus einer `uv.lock`), Modelle über huggingface_hub (eigene Prüfung).
- Kindprozesse (`ffmpeg`, Engine, CLIs) ohne Shell (`spawn` mit Argument-Array), `windowsHide`, Zeitlimits.
- Eingaben: bestehende Riegel (`VOICE_RE`, `ID_RE`, Pfad-Normalisierung unter `public/`) bleiben; neu SSRF-Riegel
  für Links; Upload-Limit 300 MB; JSON-Limit 2 MB.
- `SECURITY.md` mit Meldeweg; `PRIVACY.md` wie oben.

**Was der Check nicht kann** (offen gesagt): eine Stimmdatei erkennt er nur an der Endung; ein persönlicher
Satz nur, wenn er in der lokalen Wortliste steht — deshalb steht er drin, und deshalb werden Stimmen nie
kopiert, sondern die Bibliothek startet leer.

---

## 7. Drittanbieter und Lizenzen

| Komponente | Lizenz | Umgang |
|---|---|---|
| Node.js 24 | MIT | Binär im Installer, `LICENSE` beiliegend |
| uv | MIT/Apache-2.0 | Binär im Installer |
| Python 3.11 (python-build-standalone) | PSF | beim Setup geladen |
| ffmpeg (BtbN GPL-Build) | GPL v3 | **nur beim Setup geladen**, nie im Repo/Installer |
| PyTorch | BSD-3 | beim Setup |
| k2-fsa/OmniVoice (Code + Gewichte) | Apache-2.0 (beim Umsetzen im Repo verifizieren) | beim Setup |
| kyutai pocket-tts (Code) / Gewichte | MIT / CC-BY-4.0 (verifizieren) | beim Setup; Attribution in THIRD_PARTY.md |
| openai/whisper-large-v3-turbo, faster-whisper | MIT | beim Setup |
| Inno Setup | eigene, frei | nur in CI |
| Bahnschrift, Segoe UI | Windows-Systemfonts | werden nur genutzt, nie verteilt; Fallback Arial |

---

## 8. Testplan (vor dem ersten Release)

1. **Entwicklungslauf** auf Arnos PC: `Standalone\dev.cmd` mit `INTERVIEW_HOME=%TEMP%\ti-test`, Port 3113/3114 —
   Setup-Assistent bis Schritt 9 mit GPU-Pfad, ein 3-Minuten-Interview inkl. Video. Erwartung: 0 Referenzen auf
   Launchpad-Ports im Log, Datenordner ausschließlich unter `INTERVIEW_HOME`.
2. **Leak-Check**: `node tools/leak-check.js --all --history` = 0 Treffer; `git ls-files` manuell gesichtet.
3. **CI**: Push auf `main` grün; Tag `v1.0.0-rc1` erzeugt Setup.exe + portable.zip + SHA256SUMS.
4. **Reinraum-Installation**: Windows-Sandbox (Win 11, ohne GPU) → Setup.exe → Assistent (CPU-Pfad) →
   Mikrofon-Klon → Gemini-Free-Key → 3-Minuten-Interview → MP3 und MP4 spielen. Deinstallation entfernt Programm,
   Daten wahlweise.
5. **GPU-Pfad** auf Arnos PC mit frischem Datenordner (Umgebungsvariable `INTERVIEW_HOME`):
   OmniVoice-Design + Klon + Aussprache-Riegel.
6. **Negativtests**: kein Provider → klare Karte; Engine abgeschossen → App startet sie neu, Job meldet Wartezeit;
   Setup-Abbruch bei Schritt 4 → Neustart setzt bei 4 fort.

---

## 9. Offene Entscheidungen für Arno (bitte je Nummer „ok" oder Änderung)

1. Repo-Name `the-interview`, Lizenz MIT, öffentlich unter deinem GitHub-Account.
2. In-App neutral (Host-/Show-Name im Assistenten), Credit „Original von Arno / SARC-FM" nur in README und About.
3. Provider-Set wie §4 (sechs Stufen). Alternative: nur Gemini + Anthropic + OpenAI + lokal (kleiner, ohne CLIs).
4. CPU-Pfad mit Pocket TTS: ja.
5. Installer Inno Setup + portable ZIP; ohne Signatur in v1.
6. Oberfläche v1 Deutsch, README zweisprachig.
7. Ports 3113/3114.
8. Update-Hinweis als Opt-in (Default aus).
9. `KONZEPT.md` vor dem ersten Push nach `docs/` verschieben (Vorschlag: ja, als Architektur-Doku).

Nach der Freigabe entsteht alles unter `Standalone/` — keine Datei außerhalb wird verändert.
