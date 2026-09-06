'use strict';

// Google Gemini mit eigenem API-Key: nur kostenfreie Flash-Modelle, automatische Rotation, wenn
// ein Modell die Quota meldet (Sperre 10 Minuten). Reihenfolge wie im Launchpad-Pattern.

const C = require('./common');
const secrets = require('../secrets');

const ID = 'gemini';
const LABEL = 'Google Gemini';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_POOL = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite-preview', 'gemini-2.5-flash-preview'];
const EXHAUST_MS = 10 * 60 * 1000;
const exhausted = new Map();

function key() { return secrets.get('gemini'); }
function available() { return Boolean(key()); }
function normalize(m) { return String(m || '').trim().replace(/^models\//, ''); }
function isFree(m) { const s = normalize(m).toLowerCase(); return s.startsWith('gemini-') && s.includes('flash') && !s.includes('pro') && !/image|imagen|veo|tts|audio|embed|embedding/.test(s); }
function pool(env = process.env) {
  const raw = env.INTERVIEW_GEMINI_MODEL_POOL || env.GEMINI_MODEL_POOL || '';
  const list = raw ? raw.split(/[,\s]+/).filter(Boolean) : DEFAULT_POOL;
  return list.map(normalize).filter(isFree);
}

function payload(messages, systemPrompt) {
  const contents = (messages || []).filter((m) => m && m.content).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
  const p = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } };
  if (systemPrompt) p.systemInstruction = { parts: [{ text: String(systemPrompt) }] };
  return p;
}

async function callModel(model, messages, systemPrompt, timeoutMs) {
  const r = await C.httpJson(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key() }, body: payload(messages, systemPrompt), timeoutMs: timeoutMs || 120000 });
  if (!r.ok) throw C.apiError(`Gemini ${model}`, r);
  const parts = (((r.json || {}).candidates || [])[0] || {}).content;
  const text = ((parts && parts.parts) || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`Gemini ${model} lieferte eine leere Antwort`);
  return { provider: ID, model, reply: text };
}

async function chat({ messages, systemPrompt, timeoutMs, model, log }) {
  if (!key()) { const err = new Error('Kein Gemini-API-Key hinterlegt'); err.auth = true; throw err; }
  const list = model ? [normalize(model)] : pool();
  const tried = [];
  for (const m of list) {
    const until = exhausted.get(m);
    if (until && until > Date.now()) { tried.push(`${m}: gesperrt bis ${new Date(until).toLocaleTimeString('de-DE')}`); continue; }
    try { const r = await callModel(m, messages, systemPrompt, timeoutMs); return { ...r, tried }; }
    catch (err) {
      tried.push(`${m}: ${String(err.message || err).slice(0, 120)}`);
      if (log) log(`gemini ${m}: ${String(err.message || err).slice(0, 120)}`);
      if (err.auth) throw Object.assign(err, { tried });
      if (err.quota) exhausted.set(m, Date.now() + EXHAUST_MS);
      // Quota, 404 (Modell weg) oder Serverfehler: nächstes Modell. Andere Fehler ebenso, aber protokolliert.
    }
  }
  const err = new Error(`Gemini: kein Modell antwortete (${tried.join(' | ').slice(0, 300)})`);
  err.quota = tried.length > 0 && tried.every((t) => /quota|429|RESOURCE_EXHAUSTED|gesperrt/i.test(t));
  throw err;
}

async function listModels(timeoutMs = 10000) {
  const r = await C.httpJson(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key() }, timeoutMs });
  if (!r.ok) throw C.apiError('Gemini', r);
  return ((r.json && r.json.models) || []).map((m) => normalize(m.name)).filter(isFree).sort();
}

async function check({ depth = 'cheap', timeoutMs, model } = {}) {
  const started = Date.now();
  if (!key()) return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: 0, detail: 'kein API-Key hinterlegt', errorKind: 'auth' });
  try {
    if (depth === 'cheap') {
      const models = await listModels(timeoutMs || 10000);
      const usable = pool().filter((m) => models.includes(m));
      return C.connectivityResult({ ok: usable.length > 0, provider: ID, depth, latencyMs: Date.now() - started, detail: `${usable.length} Pool-Modelle verfügbar`, model: model || usable[0], models, errorKind: usable.length ? undefined : 'unavailable' });
    }
    const r = await chat({ messages: [{ role: 'user', content: 'Reply with exactly: ping' }], timeoutMs: timeoutMs || 45000, model });
    return C.connectivityResult({ ok: true, provider: ID, depth, latencyMs: Date.now() - started, detail: r.reply.slice(0, 120), model: r.model });
  } catch (err) {
    return C.connectivityResult({ ok: false, provider: ID, depth, latencyMs: Date.now() - started, detail: String(err.message || err).slice(0, 200), errorKind: C.classify(err), error: String(err.message || err) });
  }
}

module.exports = { ID, LABEL, DEFAULT_POOL, available, chat, check, listModels, pool, isFree };
