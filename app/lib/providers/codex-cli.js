'use strict';

// OpenAI Codex CLI mit ChatGPT-Abo-Login (kein API-Key). `codex exec --json` in einem leeren
// Sandbox-Verzeichnis, read-only, ohne Benutzerkonfiguration (keine MCP-Server) — reine
// Textgenerierung. Stufe wird übersprungen, wenn kein Login (auth.json) vorliegt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common');

const ID = 'codex-cli';
const LABEL = 'OpenAI Codex CLI';

function resolveCmd(env = process.env) {
  const explicit = env.INTERVIEW_CODEX_CMD || env.CODEX_CMD;
  if (explicit) return explicit;
  const npmBin = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (fs.existsSync(npmBin)) return npmBin;
  return 'codex';
}
function resolveModel(env = process.env) {
  const raw = String(env.INTERVIEW_CODEX_MODEL || env.CODEX_MODEL || '').trim();
  if (!raw || /^auto$/i.test(raw)) return '';
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : '';
}
function codexHome(env = process.env) { return env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function authPresent(env = process.env) { try { return fs.existsSync(path.join(codexHome(env), 'auth.json')); } catch { return false; } }
function available(env = process.env) { return authPresent(env); }

function sandboxCwd() {
  const dir = path.join(os.tmpdir(), 'the-interview-codex-sandbox');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* egal */ }
  return dir;
}

function parseJsonl(stdout) {
  let reply = ''; let model = ''; let error = '';
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (typeof ev.model === 'string' && ev.model) model = ev.model;
    if (ev.type === 'error' && typeof ev.message === 'string') error = ev.message;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') reply = ev.item.text;
    if (ev.type === 'turn.failed' && ev.error && typeof ev.error.message === 'string') error = ev.error.message;
  }
  return { reply: reply.trim(), model, error: error.trim() };
}

async function chat({ messages, systemPrompt, timeoutMs, env = process.env, model }) {
  if (!authPresent(env)) { const err = new Error('Codex CLI ist nicht eingeloggt (codex login)'); err.auth = true; throw err; }
  const cmd = resolveCmd(env);
  const m = model || resolveModel(env);
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules'];
  if (m) args.push('--model', m);
  args.push('-');
  const r = await C.runProcess(cmd, args, { input: C.messagesToPrompt(messages, systemPrompt), timeoutMs: timeoutMs || C.DEFAULT_TIMEOUT_MS, env, cwd: sandboxCwd() });
  if (r.timedOut) { const err = new Error('Codex CLI Timeout'); err.timeout = true; throw err; }
  if (r.spawnError) { const err = new Error(`Codex CLI nicht startbar: ${r.stderr.slice(0, 200)}`); err.network = true; throw err; }
  const parsed = parseJsonl(r.stdout);
  const combined = `${parsed.error}\n${r.stderr}`;
  if (r.code !== 0 || (!parsed.reply && parsed.error)) {
    const err = new Error(`Codex CLI exit ${r.code}: ${(parsed.error || r.stderr || r.stdout).slice(0, 300)}`);
    err.quota = C.isQuotaLike(combined); err.auth = C.isAuthLike(combined) || /codex login/i.test(combined);
    throw err;
  }
  if (!parsed.reply) throw new Error('Codex CLI lieferte eine leere Antwort');
  return { provider: ID, model: parsed.model || m || 'codex', reply: parsed.reply };
}

async function check({ depth = 'cheap', env = process.env, timeoutMs } = {}) {
  const started = Date.now();
  if (!authPresent(env)) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: 0, detail: 'nicht eingeloggt (codex login) oder nicht installiert', errorKind: 'auth' });
  if (depth === 'cheap') {
    const r = await C.runProcess(resolveCmd(env), ['login', 'status'], { timeoutMs: timeoutMs || 8000, env, cwd: sandboxCwd() });
    const latencyMs = Date.now() - started;
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.spawnError) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs, detail: 'Codex CLI nicht startbar', errorKind: 'unavailable' });
    const loggedIn = r.status === 0 || (r.code === 0 && /logged in/i.test(out));
    return C.connectivityResult({ ok: loggedIn, provider: ID, depth, latencyMs, detail: loggedIn ? (out.replace(/\s+/g, ' ').trim().slice(0, 120) || 'eingeloggt') : 'codex login status nicht OK', errorKind: loggedIn ? undefined : 'auth', error: loggedIn ? undefined : out.trim().slice(0, 200) });
  }
  try {
    const r = await chat({ messages: [{ role: 'user', content: 'Reply with the single word: pong' }], env, timeoutMs: timeoutMs || 60000 });
    return C.connectivityResult({ ok: Boolean(r.reply), provider: ID, depth, latencyMs: Date.now() - started, detail: `ok via ${r.model}`, model: r.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: String(err.message || err).slice(0, 200), errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, available, chat, check, resolveCmd, resolveModel, parseJsonl };
