'use strict';

// Erststart-Assistent: sechs technische Schritte, jeder idempotent (prüft erst, was schon da ist),
// jeder einzeln wiederholbar. Zustand in <home>/setup-state.json. Alles landet ausschließlich im
// Datenordner des Benutzers — kein System-Python, kein PATH, keine Registry.
//
//  system   Windows, Platz, GPU (nvidia-smi), Werkzeuge -> Profil gpu | cpu
//  ffmpeg   Zip laden (SHA-256), entpacken, nach tools/ffmpeg/
//  python   python-build-standalone-Archiv (SHA-256) + uv venv
//  torch    torch/torchaudio (cu130 für GPU — der cu128-Index endet bei 2.11, transformers 5 braucht neuer; sonst CPU-Wheel)
//  packages engine/requirements-<profil>.txt
//  models   engine/fetch_models.py (HF-Cache im Datenordner)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const { downloadFile, extractZip, findFile } = require('./download');
const DL = require('./downloads.json');
const secrets = require('./secrets');

const STEPS = ['system', 'ffmpeg', 'python', 'torch', 'packages', 'models'];
let state = load();
let running = null;   // { step, log[], progress, startedAt }

function load() {
  try { return JSON.parse(fs.readFileSync(paths.setupState, 'utf8')); } catch { return { steps: {}, profile: null, gpu: null, forceCpu: false }; }
}
function save() { fs.mkdirSync(paths.home, { recursive: true }); fs.writeFileSync(paths.setupState, JSON.stringify(state, null, 2)); }
function mark(step, status, detail, extra = {}) { state.steps[step] = { status, detail: String(detail || '').slice(0, 300), at: Date.now(), ...extra }; save(); }

function uvEnv() {
  return {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: path.join(paths.pythonDir, 'installs'),
    UV_CACHE_DIR: path.join(paths.pythonDir, 'uv-cache'),
    UV_LINK_MODE: 'copy',
    UV_HTTP_TIMEOUT: '900',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_PREFERENCE: 'only-managed',   // nie ein System-Python anfassen
    UV_PYTHON_INSTALL_BIN: '0',             // keine Starter in ~/.local/bin
    UV_PYTHON_INSTALL_REGISTRY: '0',        // kein Eintrag in der Windows-Registry (PEP 514)
  };
}

// Letzte aussagekräftige Zeile einer Werkzeug-Ausgabe für Fehlermeldungen.
function lastLine(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /error|fehler|caused by|failed/i.test(l));
  return (err || lines[lines.length - 1] || '').slice(0, 200);
}
function fail(what, r) { return new Error(`${what} fehlgeschlagen (exit ${r.code})${lastLine(r.out) ? `: ${lastLine(r.out)}` : ''}`); }

function runLogged(cmd, args, { env, cwd, log, timeoutMs = 3 * 60 * 60 * 1000, onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: env || process.env, cwd, windowsHide: true }); }
    catch (e) { resolve({ code: -1, error: String(e.message || e) }); return; }
    let buf = ''; let out = '';
    const handle = (d) => {
      const s = String(d); out += s; buf += s;
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1)); if (line) { if (log) log(line); if (onLine) onLine(line); } }
    };
    child.stdout.on('data', handle); child.stderr.on('data', handle);
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* egal */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, error: String(e.message || e), out }); });
    child.on('close', (code) => { clearTimeout(t); if (buf.trim() && log) log(buf.trim()); resolve({ code, out }); });
  });
}
// Windows-eigenes bsdtar (System32) — ein GNU-tar aus Git/MSYS im PATH würde „C:“ als Rechnernamen lesen.
function tarExe() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}
function tryRun(cmd, args, timeoutMs = 15000) {
  try { const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: timeoutMs }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; }
  catch (e) { return { ok: false, out: String(e.message || e) }; }
}

// --- Schritt 1: System -----------------------------------------------------------------------
function probeGpu() {
  const r = tryRun('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!r.ok || !r.out) return null;
  const [name, mem, driver] = r.out.split('\n')[0].split(',').map((s) => s.trim());
  return { name, vramMb: Number(mem) || 0, driver };
}
function freeDiskGb(dir) {
  const r = tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name '${path.parse(dir).root.replace(/[:\\\/]/g, '')}').Free`]);
  return r.ok ? Math.round(Number(r.out) / 1e9) : null;
}
async function stepSystem(log) {
  const gpu = probeGpu();
  const free = freeDiskGb(paths.home);
  const tar = tryRun(tarExe(), ['--version']).ok;
  const ps = tryRun('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
  const uvOk = tryRun(paths.uvPath(), ['--version']);
  const gpuOk = Boolean(gpu && gpu.vramMb >= 6000);
  const profile = state.forceCpu || !gpuOk ? 'cpu' : 'gpu';
  state.gpu = gpu; state.profile = profile;
  state.system = { os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9), freeGb: free, tar, powershell: ps.ok ? ps.out : null, uv: uvOk.ok ? uvOk.out.split('\n')[0] : null };
  log(`System: ${state.system.os} (${os.arch()}), ${state.system.cpus} Kerne, ${state.system.ramGb} GB RAM, ${free == null ? '?' : free} GB frei`);
  log(gpu ? `GPU: ${gpu.name}, ${Math.round(gpu.vramMb / 1024)} GB VRAM, Treiber ${gpu.driver}` : 'GPU: keine NVIDIA-Karte gefunden (nvidia-smi fehlt) — CPU-Pfad');
  if (gpu && !gpuOk) log('GPU hat weniger als 6 GB VRAM — CPU-Pfad (Pocket TTS)');
  if (state.forceCpu) log('CPU-Pfad erzwungen (Einstellung)');
  if (!uvOk.ok) throw new Error(`uv nicht gefunden (${paths.uvPath()}) — Installation unvollständig`);
  const need = profile === 'gpu' ? 12 : 4;
  if (free != null && free < need) throw new Error(`Zu wenig Platz: ${free} GB frei, ${need} GB nötig`);
  const detail = `${profile.toUpperCase()}-Profil · uv ${state.system.uv} · ${free == null ? '?' : free} GB frei`;
  mark('system', 'done', detail, { profile });
  return detail;
}

// --- Schritt 2: ffmpeg -----------------------------------------------------------------------
async function stepFfmpeg(log, progress) {
  const target = path.join(paths.toolsDir, 'ffmpeg');
  const exe = path.join(target, 'ffmpeg.exe');
  if (fs.existsSync(exe) && tryRun(exe, ['-version']).ok) { const d = `vorhanden: ${tryRun(exe, ['-version']).out.split('\n')[0].slice(0, 80)}`; log(d); mark('ffmpeg', 'done', d); return d; }
  const zip = path.join(paths.workDir, 'ffmpeg.zip');
  log(`Lade ffmpeg ${DL.ffmpeg.version} (${Math.round(DL.ffmpeg.bytes / 1e6)} MB) …`);
  await downloadFile(DL.ffmpeg.url, zip, { sha256: DL.ffmpeg.sha256, onProgress: (p) => progress({ done: p.done, total: p.total, label: `ffmpeg: ${Math.round(p.done / 1e6)} / ${Math.round((p.total || DL.ffmpeg.bytes) / 1e6)} MB` }) });
  log('Prüfsumme ok, entpacke …');
  const tmp = path.join(paths.workDir, 'ffmpeg-extract');
  fs.rmSync(tmp, { recursive: true, force: true });
  extractZip(zip, tmp);
  const found = findFile(tmp, 'ffmpeg.exe');
  if (!found) throw new Error('ffmpeg.exe nicht im Archiv gefunden');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const n of ['ffmpeg.exe', 'ffprobe.exe']) { const f = findFile(tmp, n); if (f) fs.copyFileSync(f, path.join(target, n)); }
  for (const n of ['LICENSE', 'LICENSE.txt', 'README.txt']) { const f = findFile(tmp, n, 2); if (f) fs.copyFileSync(f, path.join(target, `ffmpeg-${n}`)); }
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.unlinkSync(zip); } catch { /* egal */ }
  const v = tryRun(exe, ['-version']);
  if (!v.ok) throw new Error('ffmpeg läuft nicht nach dem Entpacken');
  const detail = v.out.split('\n')[0].slice(0, 80);
  log(detail); mark('ffmpeg', 'done', detail);
  return detail;
}

// --- Schritt 3: Python -----------------------------------------------------------------------
// Python kommt als geprüftes Archiv von python-build-standalone (dieselbe Quelle, die uv nutzt) und wird
// per tar entpackt. Bewusst NICHT `uv python install`: das legt einen Verzeichnis-Link, Starter in
// ~/.local/bin und Registry-Einträge an — und der Link scheitert auf manchen Windows-11-Systemen
// mit „nicht vertrauenswürdiger Bereitstellungspunkt" (os error 448). uv baut nur noch das venv.
function basePython() { return path.join(paths.pythonDir, `cpython-${DL.python.version}`, 'python', 'python.exe'); }
async function stepPython(log, progress) {
  const py = paths.venvPython();
  if (py && tryRun(py, ['--version']).ok) { const d = `venv vorhanden: ${tryRun(py, ['--version']).out}`; log(d); mark('python', 'done', d); return d; }
  const exe = basePython();
  if (!(fs.existsSync(exe) && tryRun(exe, ['--version']).ok)) {
    if (!tryRun(tarExe(), ['--version']).ok) throw new Error('tar.exe fehlt (gehört seit Windows 10 1803 zum System)');
    const tgz = path.join(paths.workDir, 'python.tar.gz');
    log(`Lade Python ${DL.python.version} (python-build-standalone, ${Math.round(DL.python.bytes / 1e6)} MB) …`);
    await downloadFile(DL.python.url, tgz, { sha256: DL.python.sha256, onProgress: (p) => progress({ done: p.done, total: p.total, label: `Python: ${Math.round(p.done / 1e6)} / ${Math.round((p.total || DL.python.bytes) / 1e6)} MB` }) });
    log('Prüfsumme ok, entpacke …');
    const base = path.dirname(path.dirname(exe));
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    const t = await runLogged(tarExe(), ['-xzf', tgz, '-C', base], { log });
    if (t.code !== 0) throw fail('tar', t);
    try { fs.unlinkSync(tgz); } catch { /* egal */ }
    if (!tryRun(exe, ['--version']).ok) throw new Error('Python startet nicht nach dem Entpacken');
  }
  // Reste älterer Fassungen (uv-verwaltete Installation samt Verzeichnis-Link) wegräumen.
  try { fs.rmSync(path.join(paths.pythonDir, 'installs'), { recursive: true, force: true }); } catch { /* egal */ }
  log(`uv venv (Basis: ${tryRun(exe, ['--version']).out}) …`);
  const r = await runLogged(paths.uvPath(), ['venv', paths.venvDir, '--python', exe, '--seed'], { env: uvEnv(), log });
  if (r.code !== 0) throw fail('uv venv', r);
  const v = tryRun(paths.venvPython(), ['--version']);
  if (!v.ok) throw new Error('venv-Python startet nicht');
  const detail = v.out.trim();
  log(detail); mark('python', 'done', detail);
  return detail;
}

// --- Schritt 4: torch ------------------------------------------------------------------------
function torchInfo() {
  const py = paths.venvPython();
  if (!py) return null;
  const r = tryRun(py, ['-c', 'import torch,json;print(json.dumps({"version":torch.__version__,"cuda":torch.cuda.is_available()}))'], 120000);
  if (!r.ok) return null;
  const line = r.out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{'));   // stderr-Warnungen (numpy fehlt noch) ignorieren
  try { return line ? JSON.parse(line) : null; } catch { return null; }
}
async function stepTorch(log, progress) {
  const profile = state.profile || 'cpu';
  const cur = torchInfo();
  if (cur && (profile === 'cpu' || cur.cuda)) { const d = `torch ${cur.version} vorhanden (CUDA ${cur.cuda ? 'ja' : 'nein'})`; log(d); mark('torch', 'done', d); return d; }
  const index = profile === 'gpu' ? DL.torch.gpuIndex : DL.torch.cpuIndex;
  log(`Installiere torch/torchaudio (${profile === 'gpu' ? 'CUDA 13.0, ≈ 3 GB' : 'CPU, ≈ 250 MB'}) von ${index} …`);
  progress({ label: profile === 'gpu' ? 'torch (CUDA) wird geladen — das dauert einige Minuten' : 'torch (CPU) wird geladen' });
  // Nur DIESER Index: bei uv hätten --extra-index-url-Quellen Vorrang, und PyPI liefert den CPU-Build.
  // Liegt schon ein falscher Build (CPU statt CUDA), wird er ausdrücklich ersetzt — gleiche Versionsnummer
  // reicht uv sonst als "erfüllt".
  const args = ['pip', 'install', '--python', paths.venvPython(), '--index-url', index];
  if (cur && !cur.cuda && profile === 'gpu') args.push('--reinstall-package', 'torch', '--reinstall-package', 'torchaudio');
  args.push('torch', 'torchaudio');
  const r = await runLogged(paths.uvPath(), args, { env: uvEnv(), log });
  if (r.code !== 0) throw fail('torch-Installation', r);
  const rn = await runLogged(paths.uvPath(), ['pip', 'install', '--python', paths.venvPython(), 'numpy'], { env: uvEnv(), log });
  if (rn.code !== 0) throw fail('numpy-Installation', rn);
  const info = torchInfo();
  if (!info) throw new Error('torch importiert nicht');
  if (profile === 'gpu' && !info.cuda) throw new Error(`torch ${info.version} sieht keine CUDA-GPU. NVIDIA-Treiber ≥ 580 installieren (CUDA 13) und den Schritt wiederholen — oder oben „CPU-Pfad erzwingen“ wählen (Pocket TTS statt OmniVoice).`);
  const detail = `torch ${info.version}, CUDA ${info.cuda ? 'ja' : 'nein'}`;
  log(detail); mark('torch', 'done', detail);
  return detail;
}

// --- Schritt 5: Pakete -----------------------------------------------------------------------
async function stepPackages(log, progress) {
  const profile = state.profile || 'cpu';
  const req = path.join(paths.engineDir, `requirements-${profile}.txt`);
  if (!fs.existsSync(req)) throw new Error(`${req} fehlt`);
  progress({ label: 'Engine-Pakete werden installiert' });
  log(`uv pip install -r ${path.basename(req)} …`);
  const pargs = ['pip', 'install', '--python', paths.venvPython()];
  if (profile === 'gpu') {
    // Der CUDA-Index enthält auch alte Fremdpakete (z. B. requests). Mit „first-index" bräche uv dort ab,
    // statt auf PyPI weiterzusuchen — also „unsafe-best-match" über alle Indizes, und torch/torchaudio
    // exakt auf die installierten +cu130-Versionen festnageln, damit PyPI sie nicht gegen CPU-Builds tauscht.
    const pins = tryRun(paths.venvPython(), ['-c', 'import torch,torchaudio;print(torch.__version__);print(torchaudio.__version__)'], 120000);
    const [tv, tav] = pins.ok ? pins.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d/.test(l)) : [];
    pargs.push('--index', DL.torch.gpuIndex, '--index-strategy', 'unsafe-best-match');
    if (tv) pargs.push(`torch==${tv}`);
    if (tav) pargs.push(`torchaudio==${tav}`);
    log(`torch bleibt bei ${tv || '?'}, torchaudio bei ${tav || '?'}`);
  }
  pargs.push('-r', req);
  const r = await runLogged(paths.uvPath(), pargs, { env: uvEnv(), log });
  if (r.code !== 0) throw fail('Paket-Installation', r);
  const after = torchInfo();
  if (profile === 'gpu' && after && !after.cuda) throw new Error('Ein Paket hat torch gegen den CPU-Build getauscht — Schritt „torch“ wiederholen, dann diesen Schritt');
  const check = tryRun(paths.venvPython(), ['-c', 'import fastapi, uvicorn, soundfile, PIL; print("ok")'], 120000);
  if (!check.ok) throw new Error(`Engine-Import schlägt fehl: ${check.out.slice(-200)}`);
  const detail = `Pakete für ${profile.toUpperCase()} installiert`;
  log(detail); mark('packages', 'done', detail);
  return detail;
}

// --- Schritt 6: Modelle ----------------------------------------------------------------------
async function stepModels(log, progress) {
  const profile = state.profile || 'cpu';
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HOME: paths.modelsDir, HUGGINGFACE_HUB_CACHE: path.join(paths.modelsDir, 'hub'), HF_HUB_DISABLE_SYMLINKS_WARNING: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_ENABLE_HF_TRANSFER: '0' };
  const hf = secrets.get('hf');
  if (hf) env.HF_TOKEN = hf; else delete env.HF_TOKEN;
  log(`Modelle für das ${profile.toUpperCase()}-Profil (Ablage: ${paths.modelsDir})${hf ? ' — mit Hugging-Face-Token (Pocket-Klon-Gewichte)' : ''} …`);
  const r = await runLogged(paths.venvPython(), [path.join(paths.engineDir, 'fetch_models.py'), '--profile', profile], {
    env, cwd: paths.engineDir, log: (l) => { if (!l.startsWith('{')) log(l); },
    onLine: (l) => { if (l.startsWith('{')) { try { const j = JSON.parse(l); if (j.progress) progress({ done: j.done, total: j.total, label: j.label }); if (j.log) log(j.log); } catch { /* egal */ } } },
  });
  if (r.code !== 0) throw fail('Modell-Download', r);
  const detail = `Modelle für ${profile.toUpperCase()} vorhanden`;
  log(detail); mark('models', 'done', detail);
  return detail;
}

const RUNNERS = { system: stepSystem, ffmpeg: stepFfmpeg, python: stepPython, torch: stepTorch, packages: stepPackages, models: stepModels };

async function runStep(step) {
  if (!RUNNERS[step]) throw Object.assign(new Error(`Unbekannter Schritt: ${step}`), { status: 400 });
  if (running) throw Object.assign(new Error(`Schritt „${running.step}“ läuft gerade`), { status: 409 });
  running = { step, log: [], progress: null, startedAt: Date.now() };
  const log = (l) => {
    const line = `${new Date().toLocaleTimeString('de-DE')} ${l}`;
    running.log.push(line); if (running.log.length > 400) running.log.shift();
    try { fs.appendFileSync(path.join(paths.logsDir, 'setup.log'), `${line}\n`); } catch { /* Log ist Komfort, kein Muss */ }
  };
  const progress = (p) => { running.progress = p; };
  mark(step, 'running', '');
  log(`=== Schritt ${step} ===`);
  try {
    const detail = await RUNNERS[step](log, progress);
    return { ok: true, detail };
  } catch (e) {
    mark(step, 'failed', String(e.message || e));
    log(`Fehler: ${String(e.message || e)}`);
    throw e;
  } finally { running = null; }
}
async function runAll(from = 0) {
  for (const s of STEPS.slice(from)) await runStep(s);
}
function status() {
  const s = load(); state = s;
  return { steps: STEPS.map((id) => ({ id, ...(s.steps[id] || { status: 'pending' }) })), profile: s.profile, gpu: s.gpu, system: s.system || null, forceCpu: Boolean(s.forceCpu), running: running ? { step: running.step, progress: running.progress, log: running.log.slice(-60), seconds: Math.round((Date.now() - running.startedAt) / 1000) } : null, complete: STEPS.every((id) => s.steps[id] && s.steps[id].status === 'done'), home: paths.home, ffmpeg: paths.ffmpegPath(), python: paths.venvPython() || null };
}
function setForceCpu(v) { state.forceCpu = Boolean(v); state.profile = state.forceCpu ? 'cpu' : state.profile; for (const k of ['torch', 'packages', 'models']) delete state.steps[k]; save(); }
function techComplete() { const s = load(); return STEPS.every((id) => s.steps[id] && s.steps[id].status === 'done'); }

module.exports = { STEPS, runStep, runAll, status, setForceCpu, techComplete, torchInfo, probeGpu };
