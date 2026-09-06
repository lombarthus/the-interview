'use strict';

// Claude Code CLI (Abo-Login des Bedieners). Reine Textgenerierung ohne Tools und ohne MCP.
// Die CLI wird nur gefunden und aufgerufen, nie verändert. Wer sie nicht installiert hat, hat
// diese Stufe einfach nicht — kein Fehler, die Kette geht weiter.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common');

const ID = 'claude-cli';
const LABEL = 'Claude Code CLI';

function resolveCmd(env = process.env) {
  const explicit = env.INTERVIEW_CLAUDE_CMD || env.CLAUDE_CMD;
  if (explicit) return explicit;
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  // Desktop-App (MSIX): der reale Pfad liegt unter LocalCache, die Junction darüber ist für
  // Fremdprozesse nicht traversierbar.
  try {
    const packagesDir = path.join(localAppData, 'Packages');
    const pkg = fs.readdirSync(packagesDir).find((e) => /^Claude_[a-z0-9]+$/i.test(e));
    if (pkg) {
      const codeDir = path.join(packagesDir, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
      if (fs.existsSync(codeDir)) {
        const versions = fs.readdirSync(codeDir).filter((d) => /^\d+\.\d+/.test(d)).sort((a, b) => {
          const pa = a.split('.').map((n) => parseInt(n, 10) || 0); const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
          return 0;
        });
        for (const v of versions) { const c = path.join(codeDir, v, 'claude.exe'); if (fs.existsSync(c)) return c; }
      }
    }
  } catch { /* dann PATH */ }
  const npmBin = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (fs.existsSync(npmBin)) return npmBin;
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function resolveModel(env = process.env) {
  const raw = env.INTERVIEW_CLAUDE_MODEL || env.CLAUDE_MODEL || '';
  return /^[A-Za-z0-9._-]*$/.test(raw) ? raw : '';
}

// Läuft die App selbst unter einem Claude-Code-Prozess, verweigert die CLI den verschachtelten Start.
const NESTED = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_HOST_SESSION_ID'];
function childEnv(env) { const out = { ...env }; for (const k of NESTED) delete out[k]; return out; }

function extractResult(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return { text: '', model: '' };
  try {
    const j = JSON.parse(s);
    const text = j.result || j.text || '';
    let model = j.model || '';
    if (!model && j.modelUsage && typeof j.modelUsage === 'object') model = Object.keys(j.modelUsage)[0] || '';
    if (j.is_error) { const e = new Error(String(text || 'Claude CLI meldete is_error').slice(0, 500)); e.reported = true; throw e; }
    return { text: String(text).trim(), model: String(model) };
  } catch (e) { if (e.reported) throw e; return { text: s, model: '' }; }
}

function available(env = process.env) {
  const cmd = resolveCmd(env);
  return path.isAbsolute(cmd) ? fs.existsSync(cmd) : true;
}

async function chat({ messages, systemPrompt, timeoutMs, env = process.env, model }) {
  const e = childEnv(env);
  const cmd = resolveCmd(e);
  const m = model || resolveModel(e);
  const args = ['-p', '--output-format', 'json', '--allowed-tools', '', '--strict-mcp-config'];
  if (m) args.push('--model', m);
  const r = await C.runProcess(cmd, args, { input: C.messagesToPrompt(messages, systemPrompt), timeoutMs: timeoutMs || C.DEFAULT_TIMEOUT_MS, env: e, cwd: os.tmpdir() });
  if (r.timedOut) { const err = new Error(`Claude CLI Timeout nach ${timeoutMs || C.DEFAULT_TIMEOUT_MS} ms`); err.timeout = true; throw err; }
  if (r.spawnError) { const err = new Error(`Claude CLI nicht startbar: ${r.stderr.slice(0, 200)}`); err.network = true; throw err; }
  if (r.code !== 0) {
    let reason = '';
    try { const j = JSON.parse(String(r.stdout || '').trim()); reason = String(j.result || j.error || ''); } catch { /* kein JSON */ }
    const err = new Error(`Claude CLI exit ${r.code}: ${(reason || r.stderr || r.stdout).slice(0, 300)}`);
    err.quota = C.isQuotaLike(`${r.stdout}\n${r.stderr}`);
    err.auth = C.isAuthLike(reason) || /\/login/i.test(reason);
    throw err;
  }
  const { text, model: used } = extractResult(r.stdout);
  if (!text) { const err = new Error('Claude CLI lieferte eine leere Antwort'); err.quota = C.isQuotaLike(`${r.stdout}\n${r.stderr}`); throw err; }
  if (C.isQuotaLike(text) && text.length < 400) { const err = new Error(`Claude CLI Quota: ${text.slice(0, 200)}`); err.quota = true; throw err; }
  return { provider: ID, model: used || m || 'claude-code-cli', reply: text };
}

async function check({ depth = 'cheap', env = process.env, timeoutMs } = {}) {
  const started = Date.now();
  const cmd = resolveCmd(env);
  if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: 0, detail: 'Claude CLI nicht gefunden', errorKind: 'unavailable' });
  if (depth === 'cheap') {
    const r = await C.runProcess(cmd, ['--version'], { timeoutMs: timeoutMs || 8000, env: childEnv(env), cwd: os.tmpdir() });
    const latencyMs = Date.now() - started;
    if (r.timedOut) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs, detail: 'Timeout bei claude --version', errorKind: 'timeout' });
    if (r.spawnError || r.code !== 0) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs, detail: 'Claude CLI nicht installiert oder nicht startbar', errorKind: 'unavailable', error: (r.stderr || r.stdout || '').slice(0, 200) });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs, detail: String(r.stdout || '').trim().split('\n')[0] || 'ok', model: resolveModel(env) || undefined });
  }
  try {
    const reply = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ping' }], env, timeoutMs: timeoutMs || 45000 });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: reply.reply.slice(0, 120), model: reply.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: String(err.message || err).slice(0, 200), errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, available, chat, check, resolveCmd, resolveModel };
