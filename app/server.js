'use strict';

// The Interview — Standalone-Server (127.0.0.1:3113).
//
//   1. Gast suchen (Wikipedia de/en) oder Text/Link liefern   -> lib/research.js
//   2. LLM verdichtet das zu einem Charakterprofil            -> lib/llm.js + lib/script.js
//   3. Sprache, Stimme (Klon, Design, Katalog), Flavor, Titel
//   4. LLM schreibt das Skript in Teilen                      -> lib/script.js
//   5. Engine vertont (OmniVoice/Pocket), MP3+WAV ins Archiv   -> lib/tts.js + lib/engine.js
//   6. Video-Export, Zeilen-Editor, Archiv                    -> lib/video.js, lib/store.js
//
// Node ohne npm-Abhängigkeiten. Bindet ausschließlich an 127.0.0.1. Keys nur über lib/secrets.js.
// Env: INTERVIEW_PORT (3113), INTERVIEW_HOME (Datenordner), INTERVIEW_ENGINE_PORT (3114),
//      INTERVIEW_FFMPEG_PATH, INTERVIEW_PYTHON, INTERVIEW_NO_BROWSER=1.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const paths = require('./lib/paths');
paths.ensureDirs();
const llm = require('./lib/llm');
const secrets = require('./lib/secrets');
const engine = require('./lib/engine');
const research = require('./lib/research');
const scriptLib = require('./lib/script');
const tts = require('./lib/tts');
const { Store } = require('./lib/store');
const lang = require('./lib/lang');
const video = require('./lib/video');
const verify = require('./lib/verify');
const setup = require('./lib/setup');
const VERSION = require('./version.json');

const PORT = Number(process.env.INTERVIEW_PORT || 3113);
const HOST = '127.0.0.1';
const PUBLIC = paths.publicDir;
const MAX_UPLOAD = 300 * 1024 * 1024;
const VOICE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RE = /^[a-z0-9]{12}$/;

const store = new Store(paths.dataDir, paths.workDir);
llm.applyConfig(store.config);
const show = () => ({ hostName: store.config.hostName, showName: store.config.showName, showUrl: store.config.showUrl });

// --- Jobs: zwei Warteschlangen (LLM und TTS/ffmpeg), je eine gleichzeitig -------------------
const jobs = new Map();
const queues = { llm: { running: null, items: [] }, tts: { running: null, items: [] } };
function newJob(kind, extra = {}) {
  const id = extra.id || crypto.randomBytes(6).toString('hex');
  const job = { id, kind, status: 'queued', log: [], progress: null, result: null, error: null, llm: null, createdAt: Date.now(), ...extra };
  jobs.set(id, job);
  if (jobs.size > 200) { const oldest = [...jobs.keys()].slice(0, jobs.size - 200); oldest.forEach((k) => jobs.delete(k)); }
  return job;
}
function jlog(job, line) {
  const l = secrets.scrub(String(line || '').trim());
  if (!l) return;
  job.log.push(`${new Date().toLocaleTimeString('de-DE')} ${l}`);
  if (job.log.length > 300) job.log.shift();
}
function enqueue(queueName, job, fn) { queues[queueName].items.push({ job, fn }); pump(queueName); }
function pump(queueName) {
  const q = queues[queueName];
  if (q.running || !q.items.length) return;
  const { job, fn } = q.items.shift();
  q.running = job; job.status = 'running'; job.startedAt = Date.now();
  Promise.resolve().then(() => fn(job))
    .then((result) => { job.result = result == null ? job.result : result; job.status = 'done'; })
    .catch((e) => { job.status = 'failed'; job.error = secrets.scrub(String(e && e.message || e)).slice(0, 600); jlog(job, `Fehler: ${job.error}`); if (e && e.attempts) job.attempts = e.attempts; })
    .finally(() => { job.finishedAt = Date.now(); q.running = null; pump(queueName); });
}
function queuePosition(job) {
  for (const [name, q] of Object.entries(queues)) {
    const i = q.items.findIndex((x) => x.job.id === job.id);
    if (i >= 0) return { queue: name, ahead: i + (q.running ? 1 : 0), aheadKind: q.running ? q.running.kind : null };
  }
  return null;
}

// --- LLM-Aufruf mit Live-Anzeige ------------------------------------------------------------
async function chat(job, { system, user, timeoutMs }) {
  const res = await llm.runChat({ messages: [{ role: 'user', content: user }], systemPrompt: system, only: store.config.preferredBackend, timeoutMs: timeoutMs || llm.DEFAULT_TIMEOUT_MS, log: (l) => jlog(job, l) });
  job.llm = { provider: res.provider, model: res.model, fallback: Boolean(res.fallback), attempts: res.attempts || [] };
  jlog(job, `${llm.providerLabel(res.provider)} · ${res.model}${res.fallback ? ' (Fallback aktiv)' : ''}`);
  return res.reply;
}

// --- Stimmen --------------------------------------------------------------------------------
function listCloneVoices() {
  let dirs = [];
  try { dirs = fs.readdirSync(paths.voicesDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
  return dirs.map((e) => {
    const d = path.join(paths.voicesDir, e.name);
    if (!fs.existsSync(path.join(d, 'audio.wav'))) return null;
    let lg = 'any';
    try { lg = fs.readFileSync(path.join(d, 'lang.txt'), 'utf8').trim() || 'any'; } catch { /* keine Angabe */ }
    let mtime = 0;
    try { mtime = fs.statSync(path.join(d, 'audio.wav')).mtimeMs; } catch { /* egal */ }
    return { name: e.name, lang: lg, kind: 'clone', modifiedAt: mtime };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
let catalogCache = { at: 0, list: [] };
async function catalogVoices() {
  if (Date.now() - catalogCache.at < 60000) return catalogCache.list;
  try {
    const st = await engine.status();
    if (!st.reachable) return catalogCache.list;
    const r = await fetch(`${engine.URL_BASE}/voices`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    catalogCache = { at: Date.now(), list: (j.voices || []).filter((v) => v.kind === 'catalog') };
  } catch { /* Engine aus */ }
  return catalogCache.list;
}
async function allVoices() { return [...listCloneVoices(), ...(await catalogVoices())]; }
function cloneExists(name) { return VOICE_RE.test(String(name || '')) && fs.existsSync(path.join(paths.voicesDir, name, 'audio.wav')); }
async function voiceExists(name) { if (cloneExists(name)) return true; return (await catalogVoices()).some((v) => v.name === name); }
const CATALOG_DEFAULT = { de: 'juergen', en: 'alba' };
async function resolveVoices({ guestVoice, language }, job) {
  const voices = await allVoices();
  const has = (n) => Boolean(n) && voices.some((v) => v.name === n);
  let guest = has(guestVoice) ? guestVoice : '';
  if (!guest) {
    const def = language === 'de' ? store.config.defaultGuestVoiceDe : store.config.defaultGuestVoiceEn;
    if (guestVoice && job) jlog(job, `Stimme "${guestVoice}" gibt es nicht — nehme ${def || 'Vorgabe'}`);
    guest = has(def) ? def : (has(CATALOG_DEFAULT[language]) ? CATALOG_DEFAULT[language] : (voices[0] ? voices[0].name : ''));
  }
  let host = has(store.config.hostVoice) ? store.config.hostVoice : '';
  if (!host) host = voices.find((v) => v.kind === 'clone' && v.name !== guest) ? voices.find((v) => v.kind === 'clone' && v.name !== guest).name : (has(CATALOG_DEFAULT[language]) ? CATALOG_DEFAULT[language] : guest);
  if (!guest || !host) throw new Error('Keine Stimme verfügbar — im Setup eine Host-Stimme anlegen oder die Engine starten');
  return { Host: host, Guest: guest };
}

// --- Voice Design ------------------------------------------------------------------------------
const DESIGN_DIR = path.join(paths.workDir, 'design');
fs.mkdirSync(DESIGN_DIR, { recursive: true });
function designKey(instruct, language, seed) { return crypto.createHash('sha1').update(`${instruct}|${language}|${seed}`).digest('hex').slice(0, 16); }
async function designClip({ instruct, language, seed }) {
  const key = designKey(instruct, language, seed);
  const file = path.join(DESIGN_DIR, `${key}.wav`);
  if (fs.existsSync(file)) return { file, wav: fs.readFileSync(file), cached: true };
  const st = await engine.ensureRunning();
  if (!st.omnivoice || !st.omnivoice.available) throw Object.assign(new Error('Voice Design braucht OmniVoice und damit eine NVIDIA-GPU — auf diesem Rechner nicht verfügbar'), { status: 503 });
  const r = await engine.generate({ text: scriptLib.DESIGN_REF_TEXT[language], language, instruct, seed, engine: 'omnivoice' });
  fs.writeFileSync(file, r.wav);
  return { file, wav: r.wav, cached: false };
}
async function finalizeDesignVoice({ name, language, refText }) {
  const text = refText || scriptLib.DESIGN_REF_TEXT[language];
  const j = await engine.words(name);
  const words = j.words;
  if (!Array.isArray(words) || !words.length) throw new Error('Keine Wortzeiten von der Engine');
  const pick = scriptLib.refTextAtSentenceEnd(text, words);
  if (!pick) return { recut: false, reason: 'kein Satzende zwischen 3,5 und 7,8 s gefunden', candidates: [] };
  const r = await engine.recut(name, { text: pick.text, language });
  const done = await engine.waitJob(r.jobId);
  let refNow = '';
  try { refNow = fs.readFileSync(path.join(paths.voicesDir, name, 'ref.txt'), 'utf8').trim(); } catch { /* egal */ }
  if (refNow.includes('\uFFFD')) throw new Error(`Transkript der Stimme „${name}“ enthält Ersatzzeichen statt Umlauten`);
  return { recut: true, text: pick.text, endSec: pick.endSec, candidates: pick.candidates, clipSeconds: done.result && done.result.clipSeconds, refText: refNow, log: (done.log || []).slice(-3) };
}
function runVoiceDesign(job, body) {
  return (async () => {
    const profile = body.profile && typeof body.profile === 'object' ? body.profile : null;
    if (!profile) throw new Error('Kein Profil — erst recherchieren');
    const language = body.language === 'de' ? 'de' : 'en';
    jlog(job, `Stimme und Sprechweise für ${profile.name || 'den Gast'} werden entworfen (${language.toUpperCase()}) …`);
    const { system, user } = scriptLib.voiceDesignPrompt({ profile, language });
    const design = scriptLib.normalizeVoiceDesign(scriptLib.extractJson(await chat(job, { system, user })), language);
    design.instruct = scriptLib.instructFromDesign(design);
    design.language = language;
    jlog(job, `Vorschlag: ${design.instruct} — ${design.rationale}`);
    return { design, llm: job.llm };
  })();
}

// --- Recherche-Job ----------------------------------------------------------------------------
function runResearch(job, body) {
  return (async () => {
    let sourceText = ''; let sourceKind = ''; let sourceUrl = '';
    let name = String(body.name || '').trim().slice(0, 120);
    if (body.hit && body.hit.title) {
      const lg = /^(de|en)$/.test(String(body.hit.lang)) ? body.hit.lang : 'en';
      jlog(job, `Wikipedia (${lg}): "${body.hit.title}" wird gelesen …`);
      const ex = await research.fetchWikipediaExtract(String(body.hit.title), lg);
      sourceText = ex.text; sourceKind = `Wikipedia ${lg}`; sourceUrl = ex.url; name = name || ex.title;
      jlog(job, `${ex.text.length} Zeichen Artikeltext${ex.truncated ? ' (gekürzt)' : ''}`);
    } else if (body.url) {
      jlog(job, `Link wird gelesen: ${String(body.url).slice(0, 100)}`);
      const ex = await research.fetchUrlText(String(body.url));
      sourceText = ex.text; sourceKind = ex.source === 'wikipedia' ? `Wikipedia ${ex.lang}` : 'Web-Link'; sourceUrl = ex.url; name = name || ex.title;
      jlog(job, `${ex.text.length} Zeichen Text${ex.truncated ? ' (gekürzt)' : ''}`);
    } else if (body.text && String(body.text).trim().length >= 20) {
      sourceText = String(body.text).trim().slice(0, research.MAX_EXTRACT_CHARS); sourceKind = 'Beschreibung des Nutzers';
      jlog(job, `${sourceText.length} Zeichen eigene Beschreibung`);
    } else throw new Error('Bitte einen Treffer wählen, einen Link angeben oder mindestens 20 Zeichen Beschreibung eingeben');
    if (!name) name = 'Gast';
    jlog(job, 'Charakterprofil wird verdichtet …');
    const { system, user } = scriptLib.profilePrompt({ name, sourceText, sourceKind, sourceUrl });
    const reply = await chat(job, { system, user });
    const profile = scriptLib.normalizeProfile(scriptLib.extractJson(reply), name);
    profile.source = { kind: sourceKind, url: sourceUrl || null, chars: sourceText.length };
    jlog(job, `Profil fertig: ${profile.name} (${profile.kind || '?'}, Vertrauen ${profile.confidence})`);
    return { profile, llm: job.llm };
  })();
}

// --- Skript-Job ---------------------------------------------------------------------------------
function runGenerate(job, body) {
  return (async () => {
    const profile = body.profile && typeof body.profile === 'object' ? scriptLib.normalizeProfile(body.profile, body.profile.name) : null;
    if (!profile) throw new Error('Kein Charakterprofil — erst recherchieren');
    if (body.profile.voiceDesign) profile.voiceDesign = body.profile.voiceDesign;
    const language = body.language === 'de' ? 'de' : 'en';
    const formality = language === 'de' ? (body.formality === 'du' ? 'du' : 'sie') : null;
    const flavor = scriptLib.flavorById(String(body.flavorId || ''));
    const customFlavor = String(body.customFlavor || '').trim().slice(0, 600);
    if (!flavor && !customFlavor) throw new Error('Bitte einen Flavor wählen oder einen eigenen beschreiben');
    const theme = String(body.theme || '').trim().slice(0, 200);
    const plan = scriptLib.planParts({ durationMin: body.durationMin || store.config.durationMin, parts: body.parts || store.config.parts });
    const partCount = plan.partCount;
    const linesPerPart = plan.linesPerPart;
    const disclaimer = Boolean(body.disclaimer);
    const sh = show();
    const title = String(body.title || '').trim().slice(0, 120) || scriptLib.suggestTitle({ guestName: profile.name, flavorId: flavor ? flavor.id : '', customFlavor, theme, language, hostName: sh.hostName });

    const voices = await resolveVoices({ guestVoice: body.guestVoice, language }, job);
    const interview = store.create({
      title, language, guest: { name: profile.name, voice: voices.Guest }, hostVoice: voices.Host, hostName: sh.hostName,
      flavorId: flavor ? flavor.id : null, flavorLabel: flavor ? flavor.label : null, customFlavor: customFlavor || null, theme,
      disclaimer, durationMin: plan.minutes, formality, profile, script: null, llm: null, audio: null, status: 'script',
    });
    job.interviewId = interview.id;
    jlog(job, `Interview ${interview.id}: "${title}" — Ziel ${plan.minutes} min ≈ ${plan.totalLines} Zeilen in ${partCount} Teil(en), ${language.toUpperCase()}${formality ? ` (${formality === 'du' ? 'Duzen' : 'Siezen'})` : ''}, Gast-Stimme ${voices.Guest}, Host ${voices.Host}`);

    const system = scriptLib.scriptSystemPrompt(language, formality, sh);
    const parts = [];
    let storySoFar = '';
    for (let i = 0; i < partCount; i++) {
      job.progress = { done: i, total: partCount, label: `Teil ${i + 1} von ${partCount} wird geschrieben` };
      jlog(job, `Teil ${i + 1}/${partCount} wird geschrieben …`);
      let part = null; let languageWarning = false; let formalityWarning = false;
      for (let attempt = 0; attempt < 3 && !part; attempt++) {
        const user = scriptLib.scriptPartPrompt({ profile, language, flavor, customFlavor, theme, title, partIndex: i, partCount, storySoFar, linesPerPart, minutesPerPart: plan.minutesPerPart, wordsPerPart: plan.wordsPerPart, languageWarning, formality, formalityWarning, show: sh });
        let candidate;
        try { candidate = scriptLib.normalizePart(scriptLib.extractJson(await chat(job, { system, user })), i, language); }
        catch (e) { if (attempt === 2) throw e; jlog(job, `Antwort unbrauchbar (${String(e.message).slice(0, 80)}) — Versuch ${attempt + 2}`); continue; }
        const check = lang.checkLines(candidate.lines, language);
        const fcheck = lang.checkFormality(candidate.lines, formality);
        if (check.ok && fcheck.ok) { part = candidate; break; }
        if (!check.ok) { languageWarning = true; jlog(job, `SPRACHFEHLER in Teil ${i + 1}: ${check.wrong.length} von ${check.judged} Zeilen nicht ${language.toUpperCase()} — Teil wird neu geschrieben (Versuch ${attempt + 2} von 3)`); }
        if (!fcheck.ok) { formalityWarning = true; jlog(job, `ANREDE-FEHLER in Teil ${i + 1}: ${fcheck.wrong.length} Zeile(n) mit „${fcheck.wrong[0].found}“ — Teil wird neu geschrieben (Versuch ${attempt + 2} von 3)`); }
        if (attempt === 2) throw new Error(`Teil ${i + 1} kam dreimal mit ${!check.ok ? 'falscher Sprache' : 'gemischter Anrede'} — Skript verworfen. Anderes Backend wählen (⚙) oder erneut versuchen.`);
      }
      parts.push(part);
      storySoFar += `Part ${i + 1} "${part.partTitle}": ${part.summary}\n`;
      jlog(job, `Teil ${i + 1}: "${part.partTitle}", ${part.lines.length} Zeilen`);
    }
    if (disclaimer) parts[0].lines.unshift({ speaker: 'Host', text: scriptLib.disclaimer(language, sh.hostName) });
    const finalCheck = lang.checkLines(parts.flatMap((p) => p.lines), language);
    if (!finalCheck.ok) throw new Error(`Sprachprüfung des Gesamtskripts fehlgeschlagen (${finalCheck.wrong.length} Zeile(n)) — Skript verworfen`);
    const finalF = lang.checkFormality(parts.flatMap((p) => p.lines).slice(disclaimer ? 1 : 0), formality);
    if (!finalF.ok) throw new Error(`Anrede-Prüfung des Gesamtskripts fehlgeschlagen (${finalF.wrong.length} Zeile(n)) — Skript verworfen`);
    jlog(job, `Sprachprüfung: ${finalCheck.judged} Zeilen geprüft, alle ${language.toUpperCase()}`);
    const script = { theme, parts };
    job.progress = { done: partCount, total: partCount, label: 'Skript fertig' };
    const saved = store.update(interview.id, { script, llm: job.llm, status: 'script-done' });
    let audioJobId = null;
    if (body.autoAudio !== false) {
      const aj = newJob('audio', { interviewId: interview.id });
      audioJobId = aj.id;
      enqueue('tts', aj, (j) => runAudio(j, interview.id, {}));
      jlog(job, 'Vertonung eingereiht');
    }
    return { interviewId: interview.id, interview: saved, audioJobId, llm: job.llm };
  })();
}
function bodyFromInterview(iv, overrides = {}) {
  return {
    profile: iv.profile, language: iv.language, flavorId: iv.flavorId, customFlavor: iv.customFlavor || '', theme: iv.theme || '',
    title: iv.title, parts: iv.script ? iv.script.parts.length : store.config.parts, durationMin: iv.durationMin || store.config.durationMin,
    guestVoice: iv.guest && iv.guest.voice, autoAudio: true, disclaimer: Boolean(iv.disclaimer), formality: iv.formality || 'sie', ...overrides,
  };
}

// --- Vertonungs-Job --------------------------------------------------------------------------------
function runAudio(job, interviewId, { onlyLines = null, voices: voiceOverride = null } = {}) {
  return (async () => {
    const iv = store.read(interviewId);
    if (!iv || !iv.script) throw new Error('Interview oder Skript fehlt');
    if (voiceOverride) { if (voiceOverride.Guest) iv.guest.voice = voiceOverride.Guest; if (voiceOverride.Host) iv.hostVoice = voiceOverride.Host; }
    const lines = iv.script.parts.reduce((n, p) => n + p.lines.length, 0);
    const lc = lang.checkLines(iv.script.parts.flatMap((p) => p.lines), iv.language);
    if (!lc.ok) throw new Error(`Skript verlässt die Sprache ${iv.language.toUpperCase()} in ${lc.wrong.length} Zeile(n) — nicht vertont. Skript korrigieren oder neu generieren.`);
    const voices = { Host: iv.hostVoice, Guest: iv.guest.voice };
    if (!(await voiceExists(voices.Guest)) || !(await voiceExists(voices.Host))) {
      const r = await resolveVoices({ guestVoice: voices.Guest, language: iv.language }, job);
      voices.Host = (await voiceExists(voices.Host)) ? voices.Host : r.Host;
      voices.Guest = (await voiceExists(voices.Guest)) ? voices.Guest : r.Guest;
    }
    const st = await engine.ensureRunning();
    const engineMode = store.config.ttsEngine;
    jlog(job, `${lines} Zeilen — Engine: ${st.device || '?'}, OmniVoice ${st.omnivoice && st.omnivoice.available ? (st.omnivoice.loaded ? 'bereit' : 'wird geladen') : 'nicht verfügbar'}, Pocket ${st.pocket && st.pocket.available ? 'bereit' : 'aus'} — Modus ${engineMode}`);
    if (engineMode === 'omnivoice' && !(st.omnivoice && st.omnivoice.available)) throw new Error('OmniVoice ist auf diesem Rechner nicht verfügbar (Einstellung: nur OmniVoice)');
    if (st.omnivoice && st.omnivoice.available && !st.omnivoice.loaded && engineMode !== 'pocket') { jlog(job, 'OmniVoice-Modell wird in den VRAM geladen (erstes Mal dauert ~30 s) …'); try { await engine.load(); } catch (e) { jlog(job, `OmniVoice-Laden fehlgeschlagen: ${String(e.message || e).slice(0, 120)} — Pocket übernimmt`); } }
    store.update(interviewId, { status: 'audio' });
    const tmpDir = path.join(paths.workDir, 'tts', job.id);
    const outFile = store.fileFor(interviewId, 'audio.mp3');
    const wavFile = store.fileFor(interviewId, 'audio.wav');
    const seeds = { Host: store.config.seedHost, Guest: store.config.seedGuest };
    const verifySpeech = Boolean(store.config.verifyTts) && await verify.available();
    if (store.config.verifyTts && !verifySpeech) jlog(job, 'Aussprache-Riegel aus: kein Whisper in der Engine');
    const common = { script: iv.script, language: iv.language, voices, seeds, engineMode, tmpDir, outFile, wavFile, log: (l) => jlog(job, l), normalizeDb: store.config.normalizeDb, verifySpeech };
    let res;
    const partial = Array.isArray(onlyLines) && onlyLines.length && iv.hasAudio && iv.audio && Array.isArray(iv.audio.lineDurations) && iv.audio.lineDurations.length === lines;
    if (partial) {
      jlog(job, `${onlyLines.length} von ${lines} Zeilen werden neu gesprochen, der Rest bleibt`);
      job.progress = { done: 0, total: onlyLines.length, label: 'Zeilen werden neu gesprochen' };
      const pcm = await tts.loadPcm({ wavFile, mp3File: outFile }, tmpDir);
      res = await tts.rerenderLines({ ...common, indexes: onlyLines, existing: { pcm, lineDurations: iv.audio.lineDurations }, onProgress: (p) => { job.progress = { done: p.done, total: p.total, label: `Zeile ${p.done} von ${p.total} neu (${p.speaker})` }; } });
      res.engines = { omnivoice: (iv.audio.engines ? iv.audio.engines.omnivoice : 0) + res.engines.omnivoice, pocket: (iv.audio.engines ? iv.audio.engines.pocket : 0) + res.engines.pocket };
    } else {
      if (onlyLines && onlyLines.length) jlog(job, 'Kein passendes Audio für eine Teil-Neuvertonung — komplett neu');
      job.progress = { done: 0, total: lines, label: 'Vertonung läuft' };
      res = await tts.renderInterview({ ...common, onProgress: (p) => { job.progress = { done: p.done, total: p.total, label: `Zeile ${p.done} von ${p.total} (${p.speaker})` }; } });
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* egal */ }
    const audio = { durationSec: res.durationSec, lineDurations: res.lineDurations, engines: res.engines, substituted: res.substituted, renderedAt: Date.now(), voices };
    try { fs.unlinkSync(store.fileFor(interviewId, 'video.mp4')); } catch { /* keins da */ }
    const saved = store.update(interviewId, { audio, video: null, hostVoice: voices.Host, guest: { ...iv.guest, voice: voices.Guest }, status: 'done' });
    jlog(job, `fertig: ${Math.round(res.durationSec)} s${partial ? ` (${res.rerendered} Zeile(n) neu)` : `, OmniVoice ${res.engines.omnivoice} / Pocket ${res.engines.pocket} Zeilen`}${res.substituted.length ? `, ERSATZSTIMME: ${res.substituted.join(', ')}` : ''}`);
    return { interviewId, interview: saved, audio };
  })();
}

function runAudit(job, interviewId) {
  return (async () => {
    const iv = store.read(interviewId);
    if (!iv || !iv.script || !iv.hasAudio || !iv.audio) throw new Error('Interview braucht Skript und Audio');
    await engine.ensureRunning();
    if (!(await verify.available())) throw new Error('Kein Whisper in der Engine');
    const tmpDir = path.join(paths.workDir, 'audit', job.id);
    const wavFile = store.fileFor(interviewId, 'audio.wav');
    const pcm = await tts.loadPcm({ wavFile, mp3File: store.fileFor(interviewId, 'audio.mp3') }, tmpDir);
    const lines = iv.script.parts.reduce((n, p) => n + p.lines.length, 0);
    if (iv.audio.lineDurations.length !== lines) throw new Error('Zeilendauern passen nicht zum Skript — erst komplett neu vertonen');
    jlog(job, `${lines} Zeilen werden nachgehört (Whisper) …`);
    job.progress = { done: 0, total: lines, label: 'Aussprache wird geprüft' };
    const { bad } = await tts.auditLines({ script: iv.script, language: iv.language, pcm, lineDurations: iv.audio.lineDurations, tmpDir, log: (l) => jlog(job, l), onProgress: (p) => { job.progress = { done: p.done, total: p.total, label: `Zeile ${p.done} von ${p.total} geprüft, ${p.bad} auffällig` }; } });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* egal */ }
    if (!bad.length) { jlog(job, 'Alle Zeilen sauber — nichts zu tun'); return { interviewId, bad: [], interview: iv }; }
    jlog(job, `${bad.length} auffällige Zeile(n) werden neu gesprochen …`);
    const res = await runAudio(job, interviewId, { onlyLines: bad });
    return { ...res, bad };
  })();
}

// --- Video-Export (Segmente, Wiederaufnahme nach Neustart) ---------------------------------------
const VIDEO_WORK = path.join(paths.workDir, 'video');
function videoJobFile(jobId) { return path.join(VIDEO_WORK, jobId, 'job.json'); }
function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function persistVideoJob(job, patch = {}) {
  try {
    fs.mkdirSync(path.join(VIDEO_WORK, job.id), { recursive: true });
    const prev = readJsonFile(videoJobFile(job.id)) || {};
    const next = { ...prev, id: job.id, kind: 'video', interviewId: job.interviewId, audioRenderedAt: job.audioRenderedAt, createdAt: job.createdAt, status: job.status, updatedAt: Date.now(), ...patch };
    const tmp = `${videoJobFile(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, videoJobFile(job.id));
  } catch (e) { console.error(`[interview] Video-Job ${job.id} nicht gesichert: ${String(e.message || e).slice(0, 120)}`); }
}
function activeVideoJob(interviewId) {
  for (const j of jobs.values()) if (j.kind === 'video' && j.interviewId === interviewId && (j.status === 'queued' || j.status === 'running')) return j;
  return null;
}
function startVideoJob(iv) {
  const existing = activeVideoJob(iv.id);
  if (existing) return { job: existing, existing: true };
  const job = newJob('video', { interviewId: iv.id, audioRenderedAt: iv.audio ? iv.audio.renderedAt : null });
  persistVideoJob(job);
  enqueue('tts', job, (j) => runVideo(j, iv.id));
  return { job, existing: false };
}
function runVideo(job, interviewId) {
  return (async () => {
    const tmpDir = path.join(VIDEO_WORK, job.id);
    try {
      persistVideoJob(job, { status: 'running', startedAt: job.startedAt });
      const iv = store.read(interviewId);
      if (!iv || !iv.script || !iv.hasAudio || !iv.audio) throw new Error('Interview braucht Skript und Audio');
      if (job.audioRenderedAt && iv.audio.renderedAt !== job.audioRenderedAt) throw new Error('Audio wurde inzwischen neu erzeugt — Video bitte neu starten');
      const flat = tts.flattenScript(iv.script);
      if (flat.length !== iv.audio.lineDurations.length) throw new Error('Zeilendauern passen nicht zum Skript — erst neu vertonen');
      const outFile = store.fileFor(interviewId, 'video.mp4');
      const wav = store.fileFor(interviewId, 'audio.wav');
      const audioFile = fs.existsSync(wav) ? wav : store.fileFor(interviewId, 'audio.mp3');
      const total = Math.round(iv.audio.durationSec);
      if (job.resumed) { const seg = video.segmentsDone(tmpDir, iv.audio.durationSec); jlog(job, `Wiederaufnahme: ${seg.done} von ${seg.total} Segment(en) waren vor dem Neustart fertig`); job.progress = { done: Math.min(total, seg.done * video.SEGMENT_SEC), total, label: `Video wird fortgesetzt (${seg.done}/${seg.total} Segmente fertig)` }; }
      else job.progress = { done: 0, total, label: 'Video wird gerendert' };
      const res = await video.renderVideo({
        audioFile, lines: flat, lineDurations: iv.audio.lineDurations, guestName: iv.guest.name, hostName: iv.hostName || store.config.hostName, title: iv.title, show: show(), tmpDir, outFile, durationSec: iv.audio.durationSec,
        log: (l) => jlog(job, l), onProgress: (sec) => { job.progress = { done: Math.min(Math.round(sec), total), total, label: `Video: ${Math.round(sec)} / ${total} s gerendert` }; },
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* egal */ }
      const saved = store.update(interviewId, { video: { renderedAt: Date.now(), bytes: res.bytes, seconds: res.seconds, forAudioRenderedAt: iv.audio.renderedAt } });
      jlog(job, `fertig: video.mp4, ${(res.bytes / 1048576).toFixed(1)} MB${res.resumed ? ' (nach Neustart fortgesetzt)' : ''}`);
      return { interviewId, interview: saved, video: saved.video };
    } catch (e) {
      persistVideoJob(job, { status: 'failed', error: String(e && e.message || e).slice(0, 600), finishedAt: Date.now() });
      throw e;
    }
  })();
}
function resumeVideoJobs() {
  let dirs = [];
  try { dirs = fs.readdirSync(VIDEO_WORK, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return 0; }
  const pending = [];
  for (const d of dirs) {
    const j = readJsonFile(path.join(VIDEO_WORK, d, 'job.json'));
    if (!j || j.kind !== 'video' || j.id !== d || !/^[a-f0-9]{12}$/.test(d) || !ID_RE.test(String(j.interviewId || ''))) continue;
    if (j.status !== 'queued' && j.status !== 'running') continue;
    if ((j.resumes || 0) >= 5) { persistVideoJob({ id: j.id, interviewId: j.interviewId, audioRenderedAt: j.audioRenderedAt, createdAt: j.createdAt, status: 'failed' }, { error: 'zu viele Wiederanläufe nach Neustart' }); continue; }
    pending.push(j);
  }
  pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let n = 0;
  for (const j of pending) {
    const iv = store.read(j.interviewId);
    if (!iv || !iv.hasAudio || !iv.audio || (j.audioRenderedAt && iv.audio.renderedAt !== j.audioRenderedAt) || activeVideoJob(j.interviewId)) { try { fs.rmSync(path.join(VIDEO_WORK, j.id), { recursive: true, force: true }); } catch { /* egal */ } continue; }
    const job = newJob('video', { id: j.id, interviewId: j.interviewId, audioRenderedAt: j.audioRenderedAt || iv.audio.renderedAt, createdAt: j.createdAt || Date.now(), resumed: true, resumedAt: Date.now() });
    jlog(job, `Nach Neustart wieder eingereiht (ursprünglich gestartet ${new Date(job.createdAt).toLocaleString('de-DE')})`);
    persistVideoJob(job, { status: 'queued', resumedAt: job.resumedAt, resumes: (j.resumes || 0) + 1 });
    enqueue('tts', job, (jj) => runVideo(jj, j.interviewId));
    n++;
  }
  return n;
}

// --- Klon-Job (Engine-Job spiegeln, damit die Oberfläche eine App-Job-ID pollt) --------------------
function runClone(job, { name, language, buffer, filename, overwrite }) {
  return (async () => {
    await engine.ensureRunning();
    jlog(job, `Upload ${(buffer.length / 1048576).toFixed(1)} MB → Engine …`);
    const r = await engine.clone({ name, language, buffer, filename, overwrite });
    job.progress = { done: 0, total: 1, label: 'Aufnahme wird abgehört und geschnitten' };
    let seen = 0;
    const t0 = Date.now();
    for (;;) {
      const ej = await engine.job(r.jobId);
      for (const l of (ej.log || []).slice(seen)) jlog(job, l.replace(/^\d\d:\d\d:\d\d\s/, ''));
      seen = (ej.log || []).length;
      if (ej.status === 'done') { catalogCache.at = 0; return { name, ...ej.result }; }
      if (ej.status === 'failed') throw new Error(ej.error || 'Klonen fehlgeschlagen');
      if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('Klonen dauert zu lange');
      await new Promise((res) => setTimeout(res, 1500));
    }
  })();
}

// --- Update-Hinweis (nur Opt-in) --------------------------------------------------------------------
let updateCache = { at: 0, result: null };
async function checkUpdate() {
  if (!store.config.checkUpdates || !VERSION.repo || /YOUR-GITHUB-USER/.test(VERSION.repo)) return { enabled: false };
  if (Date.now() - updateCache.at < 6 * 3600 * 1000) return updateCache.result;
  try {
    const r = await fetch(`https://api.github.com/repos/${VERSION.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': `TheInterview/${VERSION.version}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    updateCache = { at: Date.now(), result: { enabled: true, current: VERSION.version, latest, newer: latest && latest !== VERSION.version, url: j.html_url || '' } };
  } catch { updateCache = { at: Date.now(), result: { enabled: true, current: VERSION.version, error: 'GitHub nicht erreichbar' } }; }
  return updateCache.result;
}

// --- HTTP-Hilfen -------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); }
function json(res, code, obj) { send(res, code, JSON.stringify(obj)); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 2 * 1024 * 1024) {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Ungültiges JSON'), { status: 400 }); }
}
function streamFile(req, res, file, { download = false, name = 'audio.mp3', mime = 'audio/mpeg' } = {}) {
  const size = fs.statSync(file).size;
  const head = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (download) head['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && !download) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
    if (start >= size || end >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  return fs.createReadStream(file).pipe(res);
}
function safeName(raw) { const n = String(raw || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); return VOICE_RE.test(n) ? n : ''; }
function safeFilename(s) { return String(s || 'interview').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 _.-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'interview'; }
// Nur Anfragen aus dem eigenen Browser-Tab: fremde Origins bekommen kein API (kein CORS, Same-Origin-Riegel).
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
}

// --- Server ----------------------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const m = req.method;
  try {
    if (p.startsWith('/api/') && !originOk(req)) return json(res, 403, { error: 'Fremde Origin' });
    if (p === '/api/health') {
      const es = await engine.status();
      return json(res, 200, { ok: true, app: 'the-interview', version: VERSION.version, port: PORT, home: paths.home, ffmpeg: tts.ffmpegAvailable(), engine: { reachable: es.reachable, device: es.device, omnivoice: es.omnivoice, pocket: es.pocket, asr: es.asr }, setup: { complete: setup.techComplete(), done: Boolean(store.config.setupDone) }, voices: listCloneVoices().length, interviews: store.list().length, queues: { llm: { running: queues.llm.running ? queues.llm.running.kind : null, waiting: queues.llm.items.length }, tts: { running: queues.tts.running ? queues.tts.running.kind : null, waiting: queues.tts.items.length } } });
    }

    // --- Konfiguration, Keys, LLM ---
    if (p === '/api/config' && m === 'GET') return json(res, 200, store.config);
    if (p === '/api/config' && m === 'PUT') { const cfg = store.saveConfig(await readJson(req)); llm.applyConfig(cfg); return json(res, 200, cfg); }
    if (p === '/api/secrets' && m === 'GET') return json(res, 200, secrets.status());
    if (p === '/api/secrets' && m === 'PUT') {
      const body = await readJson(req);
      if (!secrets.NAMES.includes(body.name)) return json(res, 400, { error: 'name muss einer von ' + secrets.NAMES.join(', ') + ' sein' });
      secrets.set(body.name, body.value);
      return json(res, 200, secrets.status());
    }
    if (p === '/api/llm/status' && m === 'GET') return json(res, 200, { status: llm.status(), preferredBackend: store.config.preferredBackend });
    if (p === '/api/llm/connectivity' && m === 'GET') {
      const provider = url.searchParams.get('provider') || '';
      const depth = url.searchParams.get('depth') || 'cheap';
      if (!llm.PROVIDERS.includes(provider)) return json(res, 400, { error: `provider muss einer von ${llm.PROVIDERS.join(', ')} sein` });
      if (depth !== 'cheap' && depth !== 'deep') return json(res, 400, { error: 'depth muss cheap oder deep sein' });
      return json(res, 200, await llm.checkConnectivity({ provider, depth }));
    }
    if (p === '/api/update' && m === 'GET') return json(res, 200, await checkUpdate());
    if (p === '/api/version' && m === 'GET') return json(res, 200, VERSION);

    // --- Setup-Assistent ---
    if (p === '/api/setup/status' && m === 'GET') return json(res, 200, { ...setup.status(), setupDone: Boolean(store.config.setupDone), config: { hostName: store.config.hostName, showName: store.config.showName, hostVoice: store.config.hostVoice } });
    if (p === '/api/setup/run' && m === 'POST') {
      const body = await readJson(req);
      const step = String(body.step || 'all');
      if (step === 'all') { setup.runAll(Number(body.from) || 0).catch(() => { /* Status trägt den Fehler */ }); return json(res, 202, { started: 'all' }); }
      if (!setup.STEPS.includes(step)) return json(res, 400, { error: 'unbekannter Schritt' });
      setup.runStep(step).catch(() => { /* Status trägt den Fehler */ });
      return json(res, 202, { started: step });
    }
    if (p === '/api/setup/force-cpu' && m === 'POST') { const body = await readJson(req); setup.setForceCpu(Boolean(body.forceCpu)); return json(res, 200, setup.status()); }
    if (p === '/api/setup/finish' && m === 'POST') { const cfg = store.saveConfig({ setupDone: true }); return json(res, 200, cfg); }

    // --- Engine ---
    if (p === '/api/engine/status' && m === 'GET') return json(res, 200, await engine.status());
    if (p === '/api/engine/start' && m === 'POST') { try { return json(res, 200, await engine.ensureRunning()); } catch (e) { return json(res, 503, { error: String(e.message || e), log: engine.logTail().slice(-20) }); } }
    if (p === '/api/engine/stop' && m === 'POST') return json(res, 200, { stopped: engine.stop() });
    if (p === '/api/engine/load' && m === 'POST') { await engine.ensureRunning(); return json(res, 200, await engine.load()); }
    if (p === '/api/engine/log' && m === 'GET') return json(res, 200, { log: engine.logTail() });

    // --- Stammdaten ---
    if (p === '/api/flavors' && m === 'GET') return json(res, 200, { flavors: scriptLib.FLAVORS.map(({ id, label, blurb }) => ({ id, label, blurb })) });
    if (p === '/api/title' && m === 'GET') return json(res, 200, { title: scriptLib.suggestTitle({ guestName: url.searchParams.get('guest') || '', flavorId: url.searchParams.get('flavor') || '', customFlavor: url.searchParams.get('custom') || '', theme: url.searchParams.get('theme') || '', language: url.searchParams.get('lang') === 'de' ? 'de' : 'en', hostName: store.config.hostName }) });
    if (p === '/api/voices' && m === 'GET') {
      const es = await engine.status();
      return json(res, 200, { voices: await allVoices(), host: { voice: store.config.hostVoice, name: store.config.hostName }, defaults: { de: store.config.defaultGuestVoiceDe || CATALOG_DEFAULT.de, en: store.config.defaultGuestVoiceEn || CATALOG_DEFAULT.en }, engine: { reachable: es.reachable, device: es.device, omnivoice: es.omnivoice, pocket: es.pocket, asr: es.asr } });
    }
    // Probe sprechen (Setup-Assistent: Host-Stimme anhören; ⚙: Stimme testen)
    if (p === '/api/voices/preview' && m === 'POST') {
      const body = await readJson(req);
      const language = body.language === 'de' ? 'de' : 'en';
      const voice = String(body.voice || '');
      if (voice && !VOICE_RE.test(voice)) return json(res, 400, { error: 'ungültiger Stimmname' });
      const st = await engine.ensureRunning();
      if (st.omnivoice && st.omnivoice.available && !st.omnivoice.loaded && store.config.ttsEngine !== 'pocket' && cloneExists(voice)) { try { await engine.load(); } catch { /* Pocket übernimmt */ } }
      const text = String(body.text || (language === 'de' ? `Hallo, hier ist ${store.config.hostName}. Willkommen bei ${store.config.showName}.` : `Hello, this is ${store.config.hostName}. Welcome to ${store.config.showName}.`)).slice(0, 300);
      const r = await engine.generate({ text, language, voiceName: voice || undefined, seed: Number(body.seed) || store.config.seedHost, engine: store.config.ttsEngine });
      return send(res, 200, r.wav, 'audio/wav', { 'x-engine': r.engine });
    }
    if (p === '/api/voices/clone' && m === 'POST') {
      const name = String(url.searchParams.get('name') || '');
      if (!VOICE_RE.test(name)) return json(res, 400, { error: 'Name fehlt oder ungültig (Buchstaben, Ziffern, _ und -)' });
      if (cloneExists(name) && url.searchParams.get('overwrite') !== '1') return json(res, 409, { error: `Stimme "${name}" gibt es schon`, exists: true });
      const body = await readBody(req, MAX_UPLOAD);
      if (body.length < 1000) return json(res, 400, { error: 'Datei ist leer oder zu klein' });
      const job = newJob('clone', { voiceName: name });
      enqueue('tts', job, (j) => runClone(j, { name, language: url.searchParams.get('language') || 'auto', buffer: body, filename: decodeURIComponent(req.headers['x-filename'] || 'upload.bin'), overwrite: url.searchParams.get('overwrite') === '1' }));
      return json(res, 202, { jobId: job.id, name });
    }
    const mVoice = /^\/api\/voices\/([A-Za-z0-9_-]{1,40})$/.exec(p);
    if (mVoice && m === 'DELETE') {
      if (!cloneExists(mVoice[1])) return json(res, 404, { error: 'Stimme nicht gefunden' });
      await engine.ensureRunning();
      const r = await engine.deleteVoice(mVoice[1]);
      if (store.config.hostVoice === mVoice[1]) store.saveConfig({ hostVoice: '' });
      return json(res, 200, r);
    }

    // --- Suche & Recherche ---
    if (p === '/api/search' && m === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (q.length < 2) return json(res, 400, { error: 'Mindestens zwei Zeichen' });
      return json(res, 200, { query: q, ...(await research.searchAll(q)) });
    }
    if (p === '/api/voice-design/suggest' && m === 'POST') { const body = await readJson(req); const job = newJob('voice-design'); enqueue('llm', job, (j) => runVoiceDesign(j, body)); return json(res, 202, { jobId: job.id }); }
    if (p === '/api/voice-design/preview' && m === 'POST') {
      const body = await readJson(req);
      const instruct = String(body.instruct || '').replace(/[^A-Za-z ,-]/g, '').trim().slice(0, 120);
      if (!instruct) return json(res, 400, { error: 'instruct fehlt' });
      const language = body.language === 'de' ? 'de' : 'en';
      const seed = Number.isFinite(Number(body.seed)) ? Math.abs(Math.round(Number(body.seed))) : 7;
      const clip = await designClip({ instruct, language, seed });
      return send(res, 200, clip.wav, 'audio/wav', { 'x-design-key': designKey(instruct, language, seed), 'x-cached': clip.cached ? '1' : '0' });
    }
    if (p === '/api/voice-design/save' && m === 'POST') {
      const body = await readJson(req);
      const name = safeName(body.name);
      if (!name) return json(res, 400, { error: 'Name fehlt oder ungültig (Buchstaben, Ziffern, _ und -)' });
      if (cloneExists(name) && !body.overwrite) return json(res, 409, { error: `Stimme "${name}" gibt es schon`, exists: true });
      const instruct = String(body.instruct || '').replace(/[^A-Za-z ,-]/g, '').trim().slice(0, 120);
      const language = body.language === 'de' ? 'de' : 'en';
      const seed = Number.isFinite(Number(body.seed)) ? Math.abs(Math.round(Number(body.seed))) : 7;
      const clip = await designClip({ instruct, language, seed });
      const job = newJob('clone', { voiceName: name });
      enqueue('tts', job, (j) => runClone(j, { name, language, buffer: clip.wav, filename: `design-${name}.wav`, overwrite: Boolean(body.overwrite) }));
      return json(res, 202, { jobId: job.id, name, instruct, seed, refText: scriptLib.DESIGN_REF_TEXT[language] });
    }
    if (p === '/api/voice-design/finalize' && m === 'POST') {
      const body = await readJson(req);
      const name = safeName(body.name);
      if (!name || !cloneExists(name)) return json(res, 404, { error: 'Stimme nicht gefunden' });
      const language = body.language === 'de' ? 'de' : 'en';
      await engine.ensureRunning();
      return json(res, 200, await finalizeDesignVoice({ name, language, refText: body.refText }));
    }
    if (p === '/api/research' && m === 'POST') { const body = await readJson(req); const job = newJob('research'); enqueue('llm', job, (j) => runResearch(j, body)); return json(res, 202, { jobId: job.id }); }
    if (p === '/api/generate' && m === 'POST') { const body = await readJson(req); const job = newJob('generate'); enqueue('llm', job, (j) => runGenerate(j, body)); return json(res, 202, { jobId: job.id }); }

    // --- Jobs ---
    const mJob = /^\/api\/jobs\/([a-f0-9]{12})$/.exec(p);
    if (mJob && m === 'GET') {
      const job = jobs.get(mJob[1]);
      if (!job) return json(res, 404, { error: 'unbekannter Job' });
      return json(res, 200, { ...job, position: job.status === 'queued' ? queuePosition(job) : null, now: Date.now() });
    }

    // --- Archiv ---
    if (p === '/api/interviews' && m === 'GET') return json(res, 200, { interviews: store.list().map(({ profile, script, ...rest }) => ({ ...rest, lines: script ? script.parts.reduce((n, x) => n + x.lines.length, 0) : 0, parts: script ? script.parts.length : 0, videoJobId: (activeVideoJob(rest.id) || {}).id || null })) });
    if (p === '/api/interviews/reorder' && m === 'POST') { const body = await readJson(req); if (!Array.isArray(body.ids)) return json(res, 400, { error: 'ids fehlt' }); return json(res, 200, { order: store.reorder(body.ids.map(String).filter((x) => ID_RE.test(x))) }); }
    const mIv = /^\/api\/interviews\/([a-z0-9]{12})(?:\/(audio|download|wav|render|script|lines|regenerate|video|audit))?$/.exec(p);
    if (mIv) {
      const id = mIv[1];
      const action = mIv[2] || '';
      const iv = store.read(id);
      if (!iv) return json(res, 404, { error: 'Interview nicht gefunden' });
      if (!action && m === 'GET') return json(res, 200, { ...iv, videoJobId: (activeVideoJob(id) || {}).id || null });
      if (!action && m === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
        if (body.script && typeof body.script === 'object' && Array.isArray(body.script.parts)) {
          const parts = body.script.parts.map((pt, i) => scriptLib.normalizePart(pt, i, iv.language));
          const lc = lang.checkLines(parts.flatMap((x) => x.lines), iv.language);
          if (!lc.ok) return json(res, 400, { error: `Skript enthält ${lc.wrong.length} Zeile(n) in der falschen Sprache`, wrong: lc.wrong });
          patch.script = { theme: iv.script ? iv.script.theme : '', parts };
          if (iv.audio) { patch.audio = null; for (const f of ['audio.mp3', 'audio.wav']) { try { fs.unlinkSync(store.fileFor(id, f)); } catch { /* egal */ } } patch.status = 'script-done'; }
        }
        return json(res, 200, store.update(id, patch));
      }
      if (!action && m === 'DELETE') {
        if (queues.tts.running && queues.tts.running.interviewId === id) return json(res, 409, { error: 'Für dieses Interview läuft gerade die Vertonung — kurz warten' });
        return json(res, 200, { ok: true, movedTo: store.remove(id) });
      }
      if (action === 'audio' && m === 'GET') { if (!iv.hasAudio) return json(res, 404, { error: 'kein Audio' }); return streamFile(req, res, store.fileFor(id, 'audio.mp3')); }
      if (action === 'download' && m === 'GET') { if (!iv.hasAudio) return json(res, 404, { error: 'kein Audio' }); return streamFile(req, res, store.fileFor(id, 'audio.mp3'), { download: true, name: `${safeFilename(iv.title)}.mp3` }); }
      if (action === 'wav' && m === 'GET') { const f = store.fileFor(id, 'audio.wav'); if (!fs.existsSync(f)) return json(res, 404, { error: 'kein WAV' }); return streamFile(req, res, f, { download: true, name: `${safeFilename(iv.title)}.wav`, mime: 'audio/wav' }); }
      if (action === 'audit' && m === 'POST') { if (!iv.hasAudio) return json(res, 400, { error: 'erst Audio erzeugen' }); const job = newJob('audit', { interviewId: id }); enqueue('tts', job, (j) => runAudit(j, id)); return json(res, 202, { jobId: job.id }); }
      if (action === 'video' && m === 'GET') { if (!iv.hasVideo) return json(res, 404, { error: 'kein Video — erst „Video produzieren“' }); return streamFile(req, res, store.fileFor(id, 'video.mp4'), { download: url.searchParams.get('download') === '1', name: `${safeFilename(iv.title)}.mp4`, mime: 'video/mp4' }); }
      if (action === 'video' && m === 'POST') { if (!iv.hasAudio) return json(res, 400, { error: 'erst Audio erzeugen' }); const { job, existing } = startVideoJob(iv); return json(res, 202, { jobId: job.id, existing }); }
      if (action === 'script' && m === 'GET') {
        const hostName = iv.hostName || store.config.hostName;
        const txt = [`Title:  ${iv.title}`, `Host:   ${hostName}`, `Guest:  ${iv.guest.name}`, `Lang:   ${iv.language}`, `Flavor: ${iv.flavorLabel || iv.customFlavor || ''}`, '-'.repeat(40), '']
          .concat(iv.script ? iv.script.parts.flatMap((pt, i) => [`== ${i + 1}. ${pt.partTitle} ==`, ...pt.lines.map((l) => `${l.speaker === 'Host' ? hostName : iv.guest.name}: ${l.text}`), '']) : ['(kein Skript)']).join('\n');
        return send(res, 200, txt, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(iv.title))}.txt` });
      }
      if (action === 'render' && m === 'POST') {
        if (!iv.script) return json(res, 400, { error: 'kein Skript' });
        const body = await readJson(req);
        const voices = {};
        if (body.guestVoice) { if (!(await voiceExists(body.guestVoice))) return json(res, 400, { error: `Stimme "${body.guestVoice}" gibt es nicht` }); voices.Guest = body.guestVoice; }
        if (body.hostVoice) { if (!(await voiceExists(body.hostVoice))) return json(res, 400, { error: `Stimme "${body.hostVoice}" gibt es nicht` }); voices.Host = body.hostVoice; }
        let onlyLines = null;
        if (!body.full && iv.hasAudio && iv.audio && (voices.Guest || voices.Host || body.speaker)) {
          const flat = tts.flattenScript(iv.script);
          const changed = new Set();
          if (voices.Guest && voices.Guest !== iv.guest.voice) changed.add('Guest');
          if (voices.Host && voices.Host !== iv.hostVoice) changed.add('Host');
          if (body.speaker === 'Guest' || body.speaker === 'Host') changed.add(body.speaker);
          if (!changed.size) return json(res, 200, { ok: true, unchanged: true, interview: iv });
          onlyLines = flat.map((l, i) => (changed.has(l.speaker) ? i : -1)).filter((i) => i >= 0);
        }
        const job = newJob('audio', { interviewId: id });
        enqueue('tts', job, (j) => runAudio(j, id, { onlyLines, voices: Object.keys(voices).length ? voices : null }));
        return json(res, 202, { jobId: job.id, partial: Boolean(onlyLines), lines: onlyLines ? onlyLines.length : null });
      }
      if (action === 'lines' && m === 'POST') {
        if (!iv.script) return json(res, 400, { error: 'kein Skript' });
        const body = await readJson(req);
        const changes = Array.isArray(body.changes) ? body.changes : [];
        if (!changes.length) return json(res, 400, { error: 'keine Änderungen' });
        const parts = iv.script.parts.map((pt) => ({ ...pt, lines: pt.lines.map((l) => ({ ...l })) }));
        const flat = tts.flattenScript(iv.script);
        const idx = [];
        for (const c of changes) {
          const pi = Number(c.part), li = Number(c.index);
          const text = String(c.text || '').replace(/\s+/g, ' ').trim();
          if (!parts[pi] || !parts[pi].lines[li]) return json(res, 400, { error: `Zeile ${pi}/${li} gibt es nicht` });
          if (!text) return json(res, 400, { error: 'Eine Zeile darf nicht leer sein' });
          if (text === parts[pi].lines[li].text) continue;
          parts[pi].lines[li].text = scriptLib.spellYears(text, iv.language);
          idx.push(flat.findIndex((f) => f.part === pi && f.index === li));
        }
        if (!idx.length) return json(res, 200, { ok: true, unchanged: true, interview: iv });
        const changedLines = idx.map((i) => ({ speaker: flat[i].speaker, text: parts[flat[i].part].lines[flat[i].index].text }));
        const lc = lang.checkLines(changedLines, iv.language);
        if (!lc.ok) return json(res, 400, { error: `${lc.wrong.length} geänderte Zeile(n) sind nicht ${iv.language.toUpperCase()}`, wrong: lc.wrong });
        const fc = lang.checkFormality(changedLines, iv.formality);
        if (!fc.ok) return json(res, 400, { error: `Anrede passt nicht: „${fc.wrong[0].found}“, das Interview ${iv.formality === 'du' ? 'duzt' : 'siezt'}`, wrong: fc.wrong });
        const saved = store.update(id, { script: { ...iv.script, parts }, status: iv.hasAudio ? 'audio-stale' : iv.status });
        if (!iv.hasAudio || body.render === false) return json(res, 200, { ok: true, interview: saved, changed: idx.length });
        const job = newJob('audio', { interviewId: id });
        enqueue('tts', job, (j) => runAudio(j, id, { onlyLines: idx }));
        return json(res, 202, { jobId: job.id, changed: idx.length, interview: saved });
      }
      if (action === 'regenerate' && m === 'POST') {
        if (!iv.profile) return json(res, 400, { error: 'Interview hat kein Profil' });
        const body = await readJson(req);
        const job = newJob('generate');
        enqueue('llm', job, (j) => runGenerate(j, bodyFromInterview(iv, body && typeof body === 'object' ? body : {})));
        return json(res, 202, { jobId: job.id });
      }
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Unbekannter Endpunkt' });

    // --- statische Oberfläche ---
    if (m !== 'GET' && m !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    if (p === '/' && !(store.config.setupDone && setup.techComplete())) { res.writeHead(302, { Location: '/setup.html' }); return res.end(); }
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(path.join(PUBLIC, file));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    const status = e && e.status || 500;
    console.error(`[interview] ${m} ${p} -> ${secrets.scrub(String(e && e.message || e)).slice(0, 200)}`);
    if (!res.headersSent) return json(res, status, { error: secrets.scrub(String(e && e.message || e)).slice(0, 400) });
    res.end();
  }
});

function shutdown() {
  if (video.abortRunning()) console.log('[interview] ffmpeg (Video) beim Stopp beendet — der Job wird nach dem nächsten Start fortgesetzt');
  engine.stop();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, shutdown);

server.listen(PORT, HOST, () => {
  console.log(`[interview] The Interview ${VERSION.version} — http://${HOST}:${PORT}  Daten: ${paths.home}`);
  const resumed = resumeVideoJobs();
  if (resumed) console.log(`[interview] ${resumed} Video-Job(s) nach Neustart fortgesetzt`);
  if (setup.techComplete() && engine.available()) { try { engine.start(); console.log('[interview] Engine wird gestartet …'); } catch (e) { console.log(`[interview] Engine-Start: ${String(e.message || e)}`); } }
  else console.log('[interview] Setup unvollständig — Assistent unter /setup.html');
  if (store.config.openBrowser && !process.env.INTERVIEW_NO_BROWSER) {
    const u = `http://${HOST}:${PORT}/`;
    try { if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch { /* egal */ }
  }
});
