'use strict';

// Anbindung der Sprach-Engine (engine/server.py): OmniVoice (GPU), Pocket TTS (CPU), Whisper
// (Klon-Schnitt, Aussprache-Prüfung). Die App startet die Engine als Kindprozess im eigenen
// venv und beendet sie beim Stopp. Alles läuft über 127.0.0.1:<enginePort>.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const PORT = Number(process.env.INTERVIEW_ENGINE_PORT || 3114);
const URL_BASE = (process.env.INTERVIEW_ENGINE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const GEN_TIMEOUT_MS = Number(process.env.INTERVIEW_TTS_TIMEOUT_MS || 240000);

let child = null;
let startedAt = 0;
let lastExit = null;
let logTail = [];
function pushLog(line) { const l = String(line || '').trimEnd(); if (!l) return; logTail.push(l); if (logTail.length > 80) logTail.shift(); }

function available() { return Boolean(paths.venvPython()) && fs.existsSync(path.join(paths.engineDir, 'server.py')); }

function start(extraEnv = {}) {
  if (child) return child;
  const py = paths.venvPython();
  if (!py) throw new Error('Kein Python-venv — Setup-Assistent ausführen');
  const logFile = fs.createWriteStream(path.join(paths.logsDir, 'engine.log'), { flags: 'a' });
  const env = {
    ...process.env, ...extraEnv,
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
    HF_HOME: paths.modelsDir, HUGGINGFACE_HUB_CACHE: path.join(paths.modelsDir, 'hub'), HF_HUB_DISABLE_SYMLINKS_WARNING: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    INTERVIEW_VOICES_DIR: paths.voicesDir, INTERVIEW_FFMPEG: paths.ffmpegPath(), INTERVIEW_WORK: path.join(paths.workDir, 'engine'),
  };
  child = spawn(py, [path.join(paths.engineDir, 'server.py'), '--port', String(PORT)], { env, windowsHide: true, cwd: paths.engineDir });
  startedAt = Date.now(); lastExit = null;
  child.stdout.on('data', (d) => { const s = String(d); logFile.write(s); s.split('\n').forEach(pushLog); });
  child.stderr.on('data', (d) => { const s = String(d); logFile.write(s); s.split('\n').forEach(pushLog); });
  child.on('exit', (code) => { lastExit = { code, at: Date.now() }; child = null; logFile.end(); pushLog(`[engine beendet, exit ${code}]`); });
  return child;
}
function stop() {
  if (!child) return false;
  try { child.kill(); } catch { /* weg */ }
  child = null;
  return true;
}
function running() { return Boolean(child); }

async function status() {
  try {
    const r = await fetch(`${URL_BASE}/status`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return { reachable: true, running: running(), ...j };
  } catch {
    return { reachable: false, running: running(), device: null, omnivoice: { available: false, loaded: false, ready: false }, pocket: { available: false }, asr: { available: false }, lastExit, log: logTail.slice(-15) };
  }
}

// Warten, bis die Engine antwortet (Start dauert ein paar Sekunden: torch importieren).
async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const s = await status();
    if (s.reachable) return s;
    if (!running()) throw new Error(`Engine läuft nicht${lastExit ? ` (exit ${lastExit.code})` : ''}: ${logTail.slice(-3).join(' | ').slice(0, 300)}`);
    if (Date.now() - t0 > timeoutMs) throw new Error('Engine antwortet nicht (Start-Timeout)');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function ensureRunning() {
  const s = await status();
  if (s.reachable) return s;
  if (!available()) throw new Error('Sprach-Engine nicht installiert — Setup-Assistent ausführen');
  start();
  return waitReady();
}

async function postJson(p, body, timeoutMs = 30000) {
  const r = await fetch(`${URL_BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
  if (!r.ok) throw Object.assign(new Error((j && (j.detail || j.error)) || `Engine HTTP ${r.status}: ${text.slice(0, 160)}`), { status: r.status });
  return j;
}
async function getJson(p, timeoutMs = 10000) {
  const r = await fetch(`${URL_BASE}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
  if (!r.ok) throw Object.assign(new Error((j && (j.detail || j.error)) || `Engine HTTP ${r.status}: ${text.slice(0, 160)}`), { status: r.status });
  return j;
}

// OmniVoice-Modell laden (GPU); auf CPU-Rechnern antwortet die Engine mit "not available".
async function load() { return postJson('/load', {}, 600000); }
async function unload() { return postJson('/unload', {}, 60000); }

// Eine Zeile sprechen. engine: auto | omnivoice | pocket. Liefert WAV 24 kHz mono.
async function generate({ text, language, voiceName, instruct, seed, engine = 'auto' }) {
  const form = new FormData();
  form.set('text', text);
  form.set('language', language === 'de' ? 'de' : 'en');
  if (voiceName) form.set('voice_name', voiceName);
  if (instruct) form.set('instruct', instruct);
  form.set('seed', String(Number.isFinite(Number(seed)) ? Number(seed) : -1));
  form.set('engine', engine);
  const r = await fetch(`${URL_BASE}/generate`, { method: 'POST', body: form, signal: AbortSignal.timeout(GEN_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Engine ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { wav: Buffer.from(await r.arrayBuffer()), engine: r.headers.get('x-engine') || engine, substituted: r.headers.get('x-voice-substituted') || '' };
}

// Klon anlegen: Upload → Job. Poll über job(id).
async function clone({ name, language, buffer, filename, overwrite }) {
  const qs = new URLSearchParams({ name, language: language || 'auto' });
  if (overwrite) qs.set('overwrite', '1');
  const r = await fetch(`${URL_BASE}/clone?${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(filename || 'upload.bin') }, body: buffer, signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
  if (!r.ok) throw Object.assign(new Error((j && (j.detail || j.error)) || `Engine HTTP ${r.status}`), { status: r.status, exists: Boolean(j && j.exists) });
  return j;
}
async function job(id) { return getJson(`/jobs/${encodeURIComponent(id)}`); }
async function waitJob(id, timeoutMs = 600000) {
  const t0 = Date.now();
  for (;;) {
    const j = await job(id);
    if (j.status === 'done') return j;
    if (j.status === 'failed') throw new Error(j.error || 'Engine-Job fehlgeschlagen');
    if (Date.now() - t0 > timeoutMs) throw new Error('Engine-Job antwortet nicht rechtzeitig');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function words(name) { return getJson(`/voices/${encodeURIComponent(name)}/words`, 20000); }
async function recut(name, body) { return postJson(`/voices/${encodeURIComponent(name)}/recut`, body, 30000); }
async function deleteVoice(name) {
  const r = await fetch(`${URL_BASE}/voices/${encodeURIComponent(name)}`, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Engine HTTP ${r.status}`);
  return r.json();
}

// Aussprache-Prüfung: WAV-Datei → gehörter Text.
async function transcribe(wavFile, lang) {
  const j = await postJson('/transcribe', { file: wavFile, lang: lang === 'de' ? 'de' : 'en' }, 90000);
  return String(j.text || '');
}

module.exports = { PORT, URL_BASE, available, start, stop, running, status, waitReady, ensureRunning, load, unload, generate, clone, job, waitJob, words, recut, deleteVoice, transcribe, logTail: () => logTail.slice() };
