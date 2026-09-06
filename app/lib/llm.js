'use strict';

// LLM-Kette der Standalone-Version. „auto“ probiert die Provider in der Reihenfolge aus der
// Konfiguration (Vorgabe: Claude CLI → Codex CLI → Anthropic → OpenAI → Gemini → lokal), aber nur
// die, die eingerichtet sind (CLI vorhanden + eingeloggt, Key hinterlegt, lokaler Server gesetzt).
// Quota-/Auth-/Netzfehler → nächste Stufe; jeder Versuch steht im Job-Protokoll.
// Eine manuelle Wahl (only=<id>) schaltet den Fallback ab.

const providers = {
  'claude-cli': require('./providers/claude-cli'),
  'codex-cli': require('./providers/codex-cli'),
  anthropic: require('./providers/anthropic'),
  openai: require('./providers/openai'),
  gemini: require('./providers/gemini'),
  local: require('./providers/local'),
};
const local = providers.local;

const PROVIDERS = Object.keys(providers);
const BACKENDS = ['auto', ...PROVIDERS];
const DEFAULT_ORDER = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'gemini', 'local'];
const DEFAULT_TIMEOUT_MS = 240000;
const LABELS = Object.fromEntries(PROVIDERS.map((id) => [id, providers[id].LABEL]));

let settings = { order: DEFAULT_ORDER.slice(), models: {}, enabled: {}, localUrl: local.DEFAULT_URL, localModel: '' };

// Aus der App-Konfiguration übernehmen (store.config): Reihenfolge, gewählte Modelle, lokale URL.
function applyConfig(config = {}) {
  const order = Array.isArray(config.providerOrder) ? config.providerOrder.filter((p) => PROVIDERS.includes(p)) : [];
  for (const p of DEFAULT_ORDER) if (!order.includes(p)) order.push(p);
  settings.order = order;
  settings.models = { ...(config.providerModels || {}) };
  settings.enabled = { ...(config.providerEnabled || {}) };
  settings.localUrl = config.localUrl || local.DEFAULT_URL;
  settings.localModel = config.localModel || '';
  local.configure({ url: settings.localUrl, model: settings.localModel });
}

function isEnabled(id) { return settings.enabled[id] !== false; }
function isConfigured(id) {
  const p = providers[id];
  try { return p.available(); } catch { return false; }
}
function modelFor(id) { const m = String(settings.models[id] || '').trim(); return /^[A-Za-z0-9._:\/-]*$/.test(m) ? m : ''; }

async function runChat({ messages, systemPrompt, only = null, timeoutMs, log } = {}) {
  const attempts = [];
  const note = (line) => { attempts.push(line); if (typeof log === 'function') log(line); };
  const chain = only && only !== 'auto' ? [only] : settings.order.filter((id) => isEnabled(id) && isConfigured(id));
  if (!chain.length) {
    const err = new Error('Kein KI-Anbieter eingerichtet — unter ⚙ einen API-Key eintragen, eine CLI einloggen oder ein lokales Modell starten');
    err.code = 'NO_PROVIDER'; err.attempts = attempts; throw err;
  }
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const p = providers[id];
    if (!p) { note(`${id}: unbekannter Provider`); continue; }
    try {
      const r = await p.chat({ messages, systemPrompt, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS, model: modelFor(id) || undefined, log });
      return { ok: true, provider: id, model: r.model, reply: r.reply, fallback: i > 0, attempts };
    } catch (err) {
      lastErr = err;
      note(`${LABELS[id]}: ${String(err.message || err).slice(0, 300)}`);
      if (only && only !== 'auto') break;
    }
  }
  const err = new Error(lastErr ? String(lastErr.message || lastErr) : 'Kein Provider antwortete');
  err.attempts = attempts; err.quota = Boolean(lastErr && lastErr.quota); err.auth = Boolean(lastErr && lastErr.auth);
  throw err;
}

async function checkConnectivity({ provider, depth = 'cheap' } = {}) {
  const p = providers[provider];
  if (!p) { const err = new Error(`Unbekannter Provider: ${provider}`); err.code = 'BAD_PROVIDER'; throw err; }
  return p.check({ depth, model: modelFor(provider) || undefined });
}

function status() {
  return {
    order: settings.order,
    providers: Object.fromEntries(PROVIDERS.map((id) => [id, { label: LABELS[id], configured: isConfigured(id), enabled: isEnabled(id), model: modelFor(id) || (providers[id].DEFAULT_MODEL || ''), inAuto: isEnabled(id) && isConfigured(id) }])),
    local: local.get(),
  };
}
function providerLabel(id) { return LABELS[id] || id || '?'; }

module.exports = { PROVIDERS, BACKENDS, DEFAULT_ORDER, DEFAULT_TIMEOUT_MS, LABELS, applyConfig, runChat, checkConnectivity, status, providerLabel, providers };
