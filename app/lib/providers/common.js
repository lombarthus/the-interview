'use strict';

// Gemeinsames für alle Provider: Prozessstart mit Zeitlimit, HTTP-JSON, Quota-Erkennung,
// einheitliches Ergebnisformat für Connectivity-Checks.

const { spawn } = require('child_process');
const secrets = require('../secrets');

const DEFAULT_TIMEOUT_MS = 240000;

function runProcess(cmd, args, { input = '', timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) }); }
    catch (err) { resolve({ code: -1, stdout: '', stderr: String(err.message || err), spawnError: true }); return; }
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; try { child.kill('SIGKILL'); } catch { /* weg */ } resolve({ code: -1, stdout, stderr, timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err.message || err), spawnError: true }); });
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (child.stdin) { child.stdin.on('error', () => { /* EPIPE */ }); child.stdin.end(input); }
  });
}

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 90000 } = {}) {
  let r;
  try {
    r = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = new Error(`Netzfehler: ${secrets.scrub(String(e && e.message || e)).slice(0, 200)}`);
    err.network = true; err.timeout = /timeout|abort/i.test(String(e && e.name || e));
    throw err;
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { ok: r.ok, status: r.status, json, text: secrets.scrub(text) };
}

function isQuotaLike(text, status = 0) {
  if (status === 429 || status === 402) return true;
  return /quota|rate limit|rate_limit|usage limit|too many requests|429|RESOURCE_EXHAUSTED|capacity|overloaded|hit your limit|insufficient_quota|credit balance/i.test(String(text || ''));
}
function isAuthLike(text, status = 0) {
  if (status === 401 || status === 403) return true;
  return /not logged in|login required|unauthorized|authenticat|invalid api key|invalid_api_key|api key not valid|permission denied|401|403/i.test(String(text || ''));
}

function apiError(label, r) {
  const msg = (r.json && r.json.error && (r.json.error.message || r.json.error)) || (r.json && r.json.message) || r.text || `HTTP ${r.status}`;
  const err = new Error(`${label} HTTP ${r.status}: ${secrets.scrub(String(typeof msg === 'string' ? msg : JSON.stringify(msg))).slice(0, 300)}`);
  err.status = r.status;
  err.quota = isQuotaLike(msg, r.status);
  err.auth = isAuthLike(msg, r.status);
  return err;
}

function messagesToPrompt(messages, systemPrompt) {
  const parts = [];
  if (systemPrompt) parts.push(String(systemPrompt).trim());
  for (const m of messages || []) if (m && m.content) parts.push(String(m.content).trim());
  return parts.join('\n\n');
}

function connectivityResult({ ok, provider, depth, latencyMs, detail, model, errorKind, error, models }) {
  const out = { ok: Boolean(ok), provider, depth, latencyMs: Math.max(0, Math.round(latencyMs || 0)), detail: secrets.scrub(String(detail || '')).slice(0, 200) };
  if (model) out.model = String(model);
  if (errorKind) out.errorKind = errorKind;
  if (error) out.error = secrets.scrub(String(error)).slice(0, 200);
  if (Array.isArray(models)) out.models = models.slice(0, 60);
  return out;
}
function classify(err) {
  const msg = String(err && err.message || err);
  if (err && err.quota) return 'quota';
  if (err && err.auth) return 'auth';
  if ((err && err.timeout) || /timeout/i.test(msg)) return 'timeout';
  if (err && err.network) return 'unavailable';
  if (/leere Antwort|empty/i.test(msg)) return 'empty';
  return 'error';
}

module.exports = { DEFAULT_TIMEOUT_MS, runProcess, httpJson, isQuotaLike, isAuthLike, apiError, messagesToPrompt, connectivityResult, classify };
