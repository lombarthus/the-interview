'use strict';

// Laufzeitzustand: config.json (Einstellungen, ohne Geheimnisse — Keys liegen in secrets.js)
// und das Archiv archive/<id>/ (interview.json + audio.wav/mp3 + video.mp4) mit archive/index.json
// für die Reihenfolge. Nichts wird hart gelöscht — gelöschte Interviews wandern nach work/trash/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  // Show
  hostName: 'Alex',              // Name des Hosts im Skript und in der Oberfläche
  showName: 'The Interview',     // Name der Show (Video-Abbinder, Prompts)
  showUrl: '',                   // optional, steht im Video-Abbinder
  hostVoice: '',                 // Stimme des Hosts (Name aus voices/), leer = erste vorhandene
  defaultGuestVoiceDe: '',
  defaultGuestVoiceEn: '',
  // KI
  preferredBackend: 'auto',      // auto | claude-cli | codex-cli | anthropic | openai | gemini | local
  providerOrder: ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'gemini', 'local'],
  providerModels: {},            // { anthropic: 'claude-opus-5', openai: 'gpt-5-mini', ... }
  providerEnabled: {},           // { 'codex-cli': false } schließt eine Stufe aus „Auto“ aus
  localUrl: 'http://127.0.0.1:1234/v1',
  localModel: '',
  // Skript & Audio
  ttsEngine: 'auto',             // auto (OmniVoice -> Pocket) | omnivoice | pocket
  parts: 2,
  durationMin: 8,
  linesPerPart: 12,
  autoAudio: true,
  normalizeDb: -18,
  verifyTts: true,
  seedHost: 123,
  seedGuest: 124,
  // App
  setupDone: false,
  checkUpdates: false,           // Opt-in: GitHub-Releases-API beim Start fragen
  openBrowser: true,
};

class Store {
  constructor(dataDir, workDir) {
    this.dataDir = dataDir;
    this.workDir = workDir;
    this.archiveDir = path.join(dataDir, 'archive');
    this.trashDir = path.join(workDir, 'trash');
    this.configFile = path.join(dataDir, 'config.json');
    this.indexFile = path.join(this.archiveDir, 'index.json');
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.mkdirSync(this.trashDir, { recursive: true });
    this.config = { ...DEFAULT_CONFIG, ...this._readJson(this.configFile, {}) };
  }

  _readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  _writeJson(file, obj) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }

  saveConfig(patch) {
    const next = { ...this.config };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_CONFIG)) continue;
      const def = DEFAULT_CONFIG[k];
      if (Array.isArray(def)) { if (Array.isArray(v)) next[k] = v.map((x) => String(x).slice(0, 40)).slice(0, 20); }
      else if (def && typeof def === 'object') { if (v && typeof v === 'object' && !Array.isArray(v)) { const o = {}; for (const [kk, vv] of Object.entries(v)) if (/^[a-z0-9-]{1,20}$/i.test(kk)) o[kk] = typeof vv === 'boolean' ? vv : String(vv == null ? '' : vv).slice(0, 120); next[k] = o; } }
      else if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) next[k] = n; }
      else if (typeof def === 'boolean') next[k] = Boolean(v);
      else next[k] = String(v == null ? '' : v).slice(0, k === 'localUrl' || k === 'showUrl' ? 200 : 80);
    }
    if (!['auto', 'claude-cli', 'codex-cli', 'anthropic', 'openai', 'gemini', 'local'].includes(next.preferredBackend)) next.preferredBackend = 'auto';
    if (!['auto', 'omnivoice', 'pocket'].includes(next.ttsEngine)) next.ttsEngine = 'auto';
    next.parts = Math.min(6, Math.max(1, Math.round(next.parts)));
    next.durationMin = Math.min(30, Math.max(3, Math.round(next.durationMin)));
    next.normalizeDb = next.normalizeDb === 0 ? 0 : Math.min(-6, Math.max(-30, Math.round(next.normalizeDb)));
    next.linesPerPart = Math.min(30, Math.max(4, Math.round(next.linesPerPart)));
    next.hostName = next.hostName.trim() || DEFAULT_CONFIG.hostName;
    next.showName = next.showName.trim() || DEFAULT_CONFIG.showName;
    if (next.localUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(next.localUrl)) next.localUrl = DEFAULT_CONFIG.localUrl; // lokal heißt lokal
    this.config = next;
    this._writeJson(this.configFile, next);
    return next;
  }

  _readIndex() { const idx = this._readJson(this.indexFile, { order: [] }); return Array.isArray(idx.order) ? idx.order : []; }
  _writeIndex(order) { this._writeJson(this.indexFile, { order }); }
  dirFor(id) { return path.join(this.archiveDir, id); }
  fileFor(id, name) { return path.join(this.archiveDir, id, name); }

  read(id) {
    if (!/^[a-z0-9]{12}$/.test(String(id))) return null;
    const j = this._readJson(this.fileFor(id, 'interview.json'), null);
    if (!j) return null;
    const audio = this.fileFor(id, 'audio.mp3');
    j.hasAudio = fs.existsSync(audio);
    j.audioBytes = j.hasAudio ? fs.statSync(audio).size : 0;
    j.hasVideo = fs.existsSync(this.fileFor(id, 'video.mp4'));
    if (!j.hasVideo) j.video = null;
    return j;
  }
  write(interview) {
    fs.mkdirSync(this.dirFor(interview.id), { recursive: true });
    const { hasAudio, audioBytes, hasVideo, ...persist } = interview;
    persist.updatedAt = Date.now();
    this._writeJson(this.fileFor(interview.id, 'interview.json'), persist);
    return this.read(interview.id);
  }
  create(fields) {
    const id = crypto.randomBytes(6).toString('hex');
    const interview = { id, createdAt: Date.now(), ...fields };
    this.write(interview);
    const order = this._readIndex().filter((x) => x !== id);
    order.unshift(id);
    this._writeIndex(order);
    return this.read(id);
  }
  update(id, patch) { const cur = this.read(id); if (!cur) return null; return this.write({ ...cur, ...patch, id }); }
  list() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* leer */ }
    const known = new Set(dirs);
    const order = this._readIndex().filter((id) => known.has(id));
    for (const d of dirs) if (!order.includes(d)) order.push(d);
    return order.map((id) => this.read(id)).filter(Boolean);
  }
  reorder(ids) {
    const existing = new Set(this.list().map((i) => i.id));
    const next = ids.filter((id) => existing.has(id));
    for (const id of existing) if (!next.includes(id)) next.push(id);
    this._writeIndex(next);
    return next;
  }
  remove(id) {
    const cur = this.read(id);
    if (!cur) return null;
    const target = path.join(this.trashDir, `${id}-${Date.now()}`);
    fs.renameSync(this.dirFor(id), target);
    this._writeIndex(this._readIndex().filter((x) => x !== id));
    return target;
  }
}

module.exports = { Store, DEFAULT_CONFIG };
