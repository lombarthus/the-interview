'use strict';

// OpenAI Chat Completions mit eigenem API-Key. Dasselbe Wire-Format nutzt auch der lokale
// Provider (LM Studio / Ollama), deshalb ist der Aufruf hier parametrisiert (baseUrl, key, label).

const C = require('./common');
const secrets = require('../secrets');

const ID = 'openai';
const LABEL = 'OpenAI API';
const BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5-mini';

function key() { return secrets.get('openai'); }
function available() { return Boolean(key()); }

async function chatCompletions({ baseUrl, apiKey, label, model, messages, systemPrompt, timeoutMs, temperature }) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: String(systemPrompt) });
  for (const m of messages || []) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  const body = { model, messages: msgs };
  if (typeof temperature === 'number') body.temperature = temperature;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const r = await C.httpJson(`${baseUrl}/chat/completions`, { method: 'POST', headers, body, timeoutMs: timeoutMs || C.DEFAULT_TIMEOUT_MS });
  if (!r.ok) throw C.apiError(label, r);
  const j = r.json || {};
  const choice = (j.choices || [])[0];
  let text = choice && choice.message && choice.message.content;
  if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  text = String(text || '').trim();
  if (!text) throw new Error(`${label} lieferte eine leere Antwort`);
  return { model: j.model || model, reply: text };
}

async function listModelsAt(baseUrl, apiKey, label, timeoutMs = 10000) {
  const r = await C.httpJson(`${baseUrl}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, timeoutMs });
  if (!r.ok) throw C.apiError(label, r);
  return ((r.json && r.json.data) || []).map((x) => x.id).filter(Boolean).sort();
}

async function chat({ messages, systemPrompt, timeoutMs, model }) {
  const k = key();
  if (!k) { const err = new Error('Kein OpenAI-API-Key hinterlegt'); err.auth = true; throw err; }
  const r = await chatCompletions({ baseUrl: BASE, apiKey: k, label: 'OpenAI', model: model || DEFAULT_MODEL, messages, systemPrompt, timeoutMs });
  return { provider: ID, ...r };
}

async function check({ depth = 'cheap', timeoutMs, model } = {}) {
  const started = Date.now();
  if (!key()) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: 0, detail: 'kein API-Key hinterlegt', errorKind: 'auth' });
  try {
    if (depth === 'cheap') {
      const models = (await listModelsAt(BASE, key(), 'OpenAI', timeoutMs || 10000)).filter((id) => /^(gpt|o\d|chatgpt)/.test(id));
      return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: `${models.length} Modelle sichtbar`, model: model || DEFAULT_MODEL, models });
    }
    const r = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ping' }], timeoutMs: timeoutMs || 45000, model });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: r.reply.slice(0, 120), model: r.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: String(err.message || err).slice(0, 200), errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, DEFAULT_MODEL, available, chat, check, chatCompletions, listModelsAt };
