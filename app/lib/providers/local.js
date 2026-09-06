'use strict';

// Lokales Modell über eine OpenAI-kompatible Schnittstelle: LM Studio (Vorgabe, :1234),
// Ollama (:11434/v1), llama.cpp-Server, vLLM … URL und Modell stellt der Bediener im ⚙ ein.
// Kein Key nötig; ein optionaler Key (manche Server verlangen einen) liegt in secrets.

const C = require('./common');
const secrets = require('../secrets');
const openai = require('./openai');

const ID = 'local';
const LABEL = 'Lokales Modell (LM Studio / Ollama)';
const DEFAULT_URL = 'http://127.0.0.1:1234/v1';

let cfg = { url: DEFAULT_URL, model: '' };
function configure({ url, model }) {
  if (url) cfg.url = String(url).replace(/\/+$/, '');
  if (typeof model === 'string') cfg.model = model.trim();
}
function available() { return true; }   // wird per Verbindung geprüft, nicht per Key

async function pickModel(timeoutMs) {
  if (cfg.model) return cfg.model;
  const models = await openai.listModelsAt(cfg.url, secrets.get('local'), 'Lokal', timeoutMs || 8000);
  const usable = models.filter((m) => !/embed|whisper|tts|rerank/i.test(m));
  if (!usable.length) throw new Error('Lokaler Server hat kein Modell geladen');
  return usable[0];
}

async function chat({ messages, systemPrompt, timeoutMs, model }) {
  const m = model || await pickModel();
  const r = await openai.chatCompletions({ baseUrl: cfg.url, apiKey: secrets.get('local'), label: 'Lokal', model: m, messages, systemPrompt, timeoutMs: timeoutMs || C.DEFAULT_TIMEOUT_MS, temperature: 0.7 });
  return { provider: ID, ...r };
}

async function check({ depth = 'cheap', timeoutMs, model } = {}) {
  const started = Date.now();
  try {
    const models = await openai.listModelsAt(cfg.url, secrets.get('local'), 'Lokal', timeoutMs || 6000);
    if (depth === 'cheap') return C.connectivityResult({ ok: models.length > 0, provider: ID, depth, latencyMs: Date.now() - started, detail: models.length ? `${models.length} Modell(e) an ${cfg.url}` : `Server an ${cfg.url} antwortet, aber kein Modell geladen`, model: model || cfg.model || models[0], models, errorKind: models.length ? undefined : 'unavailable' });
    const r = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ping' }], timeoutMs: timeoutMs || 90000, model });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: r.reply.slice(0, 120), model: r.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: `${cfg.url}: ${String(err.message || err).slice(0, 160)}`, errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, DEFAULT_URL, configure, available, chat, check, get: () => ({ ...cfg }) };
