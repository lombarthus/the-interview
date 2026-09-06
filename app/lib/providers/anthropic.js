'use strict';

// Anthropic Messages API mit eigenem API-Key des Bedieners. Roh-HTTP statt SDK, weil die App
// bewusst ohne npm-Abhängigkeiten ausgeliefert wird (nur node.exe im Installer).
// Modell-Vorgabe claude-opus-5; die Liste der verfügbaren Modelle kommt aus GET /v1/models und
// ist im ⚙ wählbar. Server-seitige Refusal-Fallbacks sind eingeschaltet (fallbacks:"default"):
// lehnt der Klassifizierer eine Anfrage ab, übernimmt in derselben Anfrage ein anderes Modell.

const C = require('./common');
const secrets = require('../secrets');

const ID = 'anthropic';
const LABEL = 'Anthropic API';
const BASE = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-opus-5';
const VERSION = '2023-06-01';

function key() { return secrets.get('anthropic'); }
function available() { return Boolean(key()); }
function headers(extra = {}) { return { 'x-api-key': key(), 'anthropic-version': VERSION, ...extra }; }

async function chat({ messages, systemPrompt, timeoutMs, model }) {
  const k = key();
  if (!k) { const err = new Error('Kein Anthropic-API-Key hinterlegt'); err.auth = true; throw err; }
  const m = model || DEFAULT_MODEL;
  const body = {
    model: m, max_tokens: 16000,
    messages: (messages || []).map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '') })),
  };
  if (systemPrompt) body.system = String(systemPrompt);
  const attempt = async (withFallbacks) => {
    const b = withFallbacks ? { ...body, fallbacks: 'default' } : body;
    const h = withFallbacks ? headers({ 'anthropic-beta': 'server-side-fallback-2026-07-01' }) : headers();
    return C.httpJson(`${BASE}/v1/messages`, { method: 'POST', headers: h, body: b, timeoutMs: timeoutMs || C.DEFAULT_TIMEOUT_MS });
  };
  let r = await attempt(true);
  // Unbekannter Beta-Header oder Parameter auf einem älteren Modell: ohne Fallbacks wiederholen.
  if (!r.ok && r.status === 400 && /fallback|beta/i.test(r.text)) r = await attempt(false);
  if (!r.ok) throw C.apiError('Anthropic', r);
  const j = r.json || {};
  if (j.stop_reason === 'refusal') throw new Error(`Anthropic: Anfrage abgelehnt (${(j.stop_details && j.stop_details.category) || 'refusal'})`);
  const text = (Array.isArray(j.content) ? j.content : []).filter((c) => c.type === 'text').map((c) => c.text || '').join('').trim();
  if (!text) throw new Error('Anthropic lieferte eine leere Antwort');
  return { provider: ID, model: j.model || m, reply: text };
}

async function listModels(timeoutMs = 10000) {
  const r = await C.httpJson(`${BASE}/v1/models?limit=100`, { headers: headers(), timeoutMs });
  if (!r.ok) throw C.apiError('Anthropic', r);
  return ((r.json && r.json.data) || []).map((x) => x.id).filter(Boolean).sort();
}

async function check({ depth = 'cheap', timeoutMs, model } = {}) {
  const started = Date.now();
  if (!key()) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: 0, detail: 'kein API-Key hinterlegt', errorKind: 'auth' });
  try {
    if (depth === 'cheap') {
      const models = await listModels(timeoutMs || 10000);
      return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: `${models.length} Modelle sichtbar`, model: model || DEFAULT_MODEL, models });
    }
    const r = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ping' }], timeoutMs: timeoutMs || 45000, model });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: r.reply.slice(0, 120), model: r.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: String(err.message || err).slice(0, 200), errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, DEFAULT_MODEL, available, chat, check, listModels };
