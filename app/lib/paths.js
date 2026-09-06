'use strict';

// Alle Orte, die die App kennt. Nichts davon zeigt auf fremde Programme: Programm-Ordner
// (Code + Runtimes) und Daten-Ordner (Konfiguration, Stimmen, Archiv, Modelle, venv) liegen
// beide im Profil des Benutzers. INTERVIEW_HOME überschreibt den Daten-Ordner (Tests, Portable).

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');                // .../app
const PROGRAM_DIR = path.resolve(APP_DIR, '..');              // .../TheInterview (Installationsordner oder Repo)
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const HOME = path.resolve(process.env.INTERVIEW_HOME || path.join(LOCALAPPDATA, 'TheInterview'));

const P = {
  appDir: APP_DIR,
  programDir: PROGRAM_DIR,
  publicDir: path.join(APP_DIR, 'public'),
  assetsDir: path.join(APP_DIR, 'assets'),
  engineDir: path.join(PROGRAM_DIR, 'engine'),
  runtimeDir: path.join(PROGRAM_DIR, 'runtime'),
  home: HOME,
  dataDir: HOME,
  archiveDir: path.join(HOME, 'archive'),
  voicesDir: path.resolve(process.env.INTERVIEW_VOICES_DIR || path.join(HOME, 'voices')),
  workDir: path.join(HOME, 'work'),
  logsDir: path.join(HOME, 'logs'),
  modelsDir: path.join(HOME, 'models'),
  toolsDir: path.join(HOME, 'tools'),
  pythonDir: path.join(HOME, 'python'),
  venvDir: path.join(HOME, 'python', 'venv'),
  setupState: path.join(HOME, 'setup-state.json'),
};

function firstExisting(list) { for (const f of list) { try { if (f && fs.existsSync(f)) return f; } catch { /* weiter */ } } return ''; }

function ffmpegPath() {
  return process.env.INTERVIEW_FFMPEG_PATH || firstExisting([path.join(P.toolsDir, 'ffmpeg', 'ffmpeg.exe'), path.join(P.toolsDir, 'ffmpeg', 'ffmpeg')]) || 'ffmpeg';
}
function ffprobePath() {
  return firstExisting([path.join(P.toolsDir, 'ffmpeg', 'ffprobe.exe')]) || 'ffprobe';
}
function venvPython() {
  return process.env.INTERVIEW_PYTHON || firstExisting([path.join(P.venvDir, 'Scripts', 'python.exe'), path.join(P.venvDir, 'bin', 'python')]) || '';
}
function uvPath() {
  return process.env.INTERVIEW_UV || firstExisting([path.join(P.runtimeDir, 'uv.exe'), path.join(P.runtimeDir, 'uv')]) || 'uv';
}

function ensureDirs() {
  for (const d of [P.home, P.archiveDir, P.voicesDir, P.workDir, P.logsDir, P.modelsDir, P.toolsDir, P.pythonDir]) fs.mkdirSync(d, { recursive: true });
}

module.exports = { ...P, ffmpegPath, ffprobePath, venvPython, uvPath, ensureDirs };
