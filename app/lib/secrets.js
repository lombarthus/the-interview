'use strict';

// API-Keys: nie im Klartext auf der Platte. Unter Windows werden sie mit DPAPI im Kontext des
// angemeldeten Benutzers verschlüsselt (System.Security.Cryptography.ProtectedData über
// PowerShell — kein natives Node-Modul nötig). Die Datei secrets.dpapi enthält nur den
// Base64-Chiffretext. Auf anderen Systemen (Entwicklung) fällt die Ablage auf eine Datei mit
// eingeschränkten Rechten zurück und meldet das im Status.
//
// Keys erreichen den Rest der App nur über get(name); Log-Ausgaben laufen durch mask().
// Umgebungsvariablen (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY + Aliasse) gelten
// zusätzlich, überschreiben aber nichts, was der Bediener im ⚙ eingetragen hat.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const FILE = path.join(paths.home, 'secrets.dpapi');
const PLAIN_FILE = path.join(paths.home, 'secrets.plain.json');
const NAMES = ['anthropic', 'openai', 'gemini', 'local', 'hf'];
const ENV_ALIASES = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['INTERVIEW_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY'],
  local: ['INTERVIEW_LOCAL_API_KEY', 'LM_STUDIO_API_KEY'],
  hf: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
};

let cache = null;            // { name: value }
let backend = 'none';        // dpapi | plain | none
let lastError = '';

function powershell(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `PowerShell exit ${r.status}`).trim().slice(0, 300));
  return String(r.stdout || '').trim();
}
const PS_PROTECT = '$in=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($in); $c=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($c))';
const PS_UNPROTECT = '$in=[Console]::In.ReadToEnd().Trim(); Add-Type -AssemblyName System.Security; $c=[Convert]::FromBase64String($in); $b=[System.Security.Cryptography.ProtectedData]::Unprotect($c,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))';

function dpapiAvailable() { return process.platform === 'win32'; }

function load() {
  if (cache) return cache;
  cache = {};
  try {
    if (dpapiAvailable() && fs.existsSync(FILE)) {
      const b64 = fs.readFileSync(FILE, 'utf8');
      cache = JSON.parse(powershell(PS_UNPROTECT, b64) || '{}');
      backend = 'dpapi';
    } else if (fs.existsSync(PLAIN_FILE)) {
      cache = JSON.parse(fs.readFileSync(PLAIN_FILE, 'utf8'));
      backend = 'plain';
    } else backend = dpapiAvailable() ? 'dpapi' : 'plain';
  } catch (e) { lastError = String(e.message || e).slice(0, 200); cache = {}; }
  return cache;
}

function save() {
  fs.mkdirSync(paths.home, { recursive: true });
  const json = JSON.stringify(cache || {});
  if (dpapiAvailable()) {
    const b64 = powershell(PS_PROTECT, json);
    if (!b64) throw new Error('DPAPI lieferte keinen Chiffretext');
    fs.writeFileSync(FILE, b64, 'utf8');
    try { fs.unlinkSync(PLAIN_FILE); } catch { /* keine */ }
    backend = 'dpapi';
  } else {
    fs.writeFileSync(PLAIN_FILE, json, { mode: 0o600 });
    backend = 'plain';
  }
}

function get(name) {
  const stored = String(load()[name] || '').trim();
  if (stored) return stored;
  for (const env of ENV_ALIASES[name] || []) { const v = String(process.env[env] || '').trim(); if (v) return v; }
  return '';
}
function source(name) {
  if (String(load()[name] || '').trim()) return 'stored';
  for (const env of ENV_ALIASES[name] || []) if (String(process.env[env] || '').trim()) return `env:${env}`;
  return '';
}
function set(name, value) {
  if (!NAMES.includes(name)) throw Object.assign(new Error(`Unbekannter Key-Name: ${name}`), { status: 400 });
  load();
  const v = String(value || '').trim();
  if (v) cache[name] = v; else delete cache[name];
  save();
}
function mask(value) {
  const v = String(value || '');
  if (v.length < 8) return v ? '••••' : '';
  return `${v.slice(0, 4)}…${v.slice(-2)}`;
}
// Fehlertexte von Anbietern können den Key enthalten (z. B. in der URL): überall ersetzen.
function scrub(text) {
  let t = String(text || '');
  for (const n of NAMES) { const v = get(n); if (v && v.length >= 8) t = t.split(v).join('[key]'); }
  return t;
}
function status() {
  load();
  const out = { backend, error: lastError, keys: {} };
  for (const n of NAMES) { const v = get(n); out.keys[n] = { present: Boolean(v), masked: v ? mask(v) : '', source: source(n) }; }
  return out;
}

module.exports = { NAMES, get, set, mask, scrub, status };
