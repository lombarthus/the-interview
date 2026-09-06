'use strict';

// Vertonung: je Zeile über die Engine (OmniVoice auf GPU, sonst Pocket TTS auf CPU — die Engine
// entscheidet je nach Einstellung und Verfügbarkeit). Jede Zeile wird per ffmpeg auf 24 kHz mono
// s16 normalisiert, in Node zu EINEM PCM-Strom zusammengesetzt (Pausen dazwischen) und als WAV
// (verlustfrei, für spätere Zeilen-Änderungen) + MP3 (Player, Download) mit Zeilendauern abgelegt.
//
// Gleiche Zeile + gleicher Seed = byte-identisches Audio. Deshalb wird bei Änderungen nur die
// betroffene ZEILE neu gesprochen (rerenderLines); alle anderen bleiben byteweise erhalten.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const engine = require('./engine');
const verify = require('./verify');
const paths = require('./paths');
const { spellYears } = require('./years');

const SAMPLE_RATE = 24000;
const BPS = SAMPLE_RATE * 2;
const GAP_SPEAKER_MS = 550;
const GAP_SAME_MS = 250;
const GAP_PART_MS = 1400;
const TAIL_MS = 700;
const MAX_CHUNK = 320;

async function speakChunk({ text, language, voiceName, seed, engineMode, log }) {
  try {
    const r = await engine.generate({ text, language, voiceName, seed, engine: engineMode });
    return { wav: r.wav, engine: /pocket/i.test(r.engine) ? 'pocket' : 'omnivoice', substituted: r.substituted };
  } catch (e) {
    if (log) log(`Engine: ${String(e.message || e).slice(0, 140)}`);
    throw e;
  }
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(paths.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* egal */ } reject(new Error('ffmpeg Zeitüberschreitung')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(new Error(`ffmpeg nicht startbar: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 200)}`)); });
  });
}

async function toPcm(wavBuffer, tmpDir, tag) {
  const inFile = path.join(tmpDir, `${tag}.wav`);
  const outFile = path.join(tmpDir, `${tag}.pcm`);
  fs.writeFileSync(inFile, wavBuffer);
  await runFfmpeg(['-i', inFile, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1', outFile]);
  const pcm = fs.readFileSync(outFile);
  try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch { /* egal */ }
  return pcm;
}
function silence(ms) { return Buffer.alloc(Math.round(SAMPLE_RATE * ms / 1000) * 2); }

// --- Lautstärke-Angleich -------------------------------------------------------------------------
const PEAK_CEIL = 32767 * Math.pow(10, -1 / 20);
function speechStats(pcm) {
  const n = pcm.length >> 1;
  const frame = 480;
  const rmsFrames = [];
  let peak = 0;
  for (let i = 0; i + frame <= n; i += frame) {
    let s = 0;
    for (let k = 0; k < frame; k++) { const v = pcm.readInt16LE((i + k) * 2); s += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    rmsFrames.push(Math.sqrt(s / frame));
  }
  if (!rmsFrames.length) return { rms: 0, peak: 0 };
  const max = Math.max(...rmsFrames);
  const speech = rmsFrames.filter((r) => r >= max * 0.1);
  const rms = Math.sqrt(speech.reduce((a, b) => a + b * b, 0) / speech.length);
  return { rms, peak };
}
function normalizePcm(pcm, targetDb) {
  if (!targetDb || !(targetDb < 0) || pcm.length < 4800) return { pcm, gainDb: 0 };
  const { rms, peak } = speechStats(pcm);
  if (!rms || !peak) return { pcm, gainDb: 0 };
  let gain = (32768 * Math.pow(10, targetDb / 20)) / rms;
  if (peak * gain > PEAK_CEIL) gain = PEAK_CEIL / peak;
  if (Math.abs(gain - 1) < 0.02) return { pcm, gainDb: 0 };
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    let v = Math.round(pcm.readInt16LE(i) * gain);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i);
  }
  return { pcm: out, gainDb: 20 * Math.log10(gain) };
}

function wavHeader(pcmBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcmBytes, 40);
  return h;
}
async function writeOutputs(pcm, tmpDir, { mp3File, wavFile }) {
  const wav = wavFile || path.join(tmpDir, 'full.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  await runFfmpeg(['-i', wav, '-ar', '44100', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '192k', mp3File], 300000);
  if (!wavFile) { try { fs.unlinkSync(wav); } catch { /* egal */ } }
}
async function loadPcm({ wavFile, mp3File }, tmpDir) {
  if (wavFile && fs.existsSync(wavFile)) {
    const buf = fs.readFileSync(wavFile);
    if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.readUInt32LE(24) === SAMPLE_RATE && buf.readUInt16LE(22) === 1) return buf.subarray(44);
  }
  return mp3ToPcm(mp3File, tmpDir);
}
async function mp3ToPcm(mp3File, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `dec-${Date.now()}.pcm`);
  await runFfmpeg(['-i', mp3File, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1', out], 300000);
  const pcm = fs.readFileSync(out);
  try { fs.unlinkSync(out); } catch { /* egal */ }
  return pcm;
}

function chunkText(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_CHUNK) return [t];
  const sentences = t.split(/(?<=[.!?…])\s+(?=[^a-zäöüß])/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > MAX_CHUNK && cur) { out.push(cur.trim()); cur = s; }
    else cur = (cur + ' ' + s).trim();
  }
  if (cur) out.push(cur.trim());
  return out.flatMap((c) => (c.length <= MAX_CHUNK * 1.5 ? [c] : c.match(new RegExp(`.{1,${MAX_CHUNK}}(\\s|$)`, 'g')).map((x) => x.trim()).filter(Boolean)));
}

async function speakLineOnce({ text, language, voiceName, seed, engineMode, tmpDir, tag, log, stats }) {
  const chunks = chunkText(text);
  const pieces = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const r = await speakChunk({ text: chunks[ci], language, voiceName, seed, engineMode, log });
    if (stats) { stats.engines[r.engine]++; if (r.substituted) stats.substituted.add(`${voiceName} → ${r.substituted}`); }
    pieces.push(await toPcm(r.wav, tmpDir, `${tag}-${ci}`));
    if (ci < chunks.length - 1) pieces.push(silence(180));
  }
  return Buffer.concat(pieces);
}

const VERIFY_SEED_STEP = 1000;
const VERIFY_ATTEMPTS = 3;
async function checkSpeech(pcm, text, language, tmpDir, tag) {
  const wavFile = path.join(tmpDir, `${tag}-verify.wav`);
  fs.writeFileSync(wavFile, Buffer.concat([wavHeader(pcm.length), pcm]));
  try { const heard = await verify.transcribe(path.resolve(wavFile), language); return verify.compare(text, heard); }
  finally { try { fs.unlinkSync(wavFile); } catch { /* egal */ } }
}
async function renderOneLine({ text, language, voiceName, seed, engineMode, tmpDir, tag, log, stats, normalizeDb, verifySpeech }) {
  text = spellYears(text, language);
  let best = null;
  for (let attempt = 0; attempt < (verifySpeech ? VERIFY_ATTEMPTS : 1); attempt++) {
    const s = seed + attempt * VERIFY_SEED_STEP;
    const speech = await speakLineOnce({ text, language, voiceName, seed: s, engineMode, tmpDir, tag: `${tag}-a${attempt}`, log, stats });
    if (!verifySpeech) { best = { speech }; break; }
    let check;
    try { check = await checkSpeech(speech, text, language, tmpDir, `${tag}-a${attempt}`); verify.note('checked'); }
    catch (e) { if (log) log(`Aussprache-Prüfung nicht möglich (${String(e.message || e).slice(0, 80)}) — Zeile bleibt ungeprüft`); best = { speech }; break; }
    const score = check.inserted.length * 3 + check.missing.length;
    if (!best || score < best.score) best = { speech, score, check, seed: s };
    if (check.ok) break;
    verify.note('failed');
    if (log) log(`Versprecher in „${text.slice(0, 50)}…“: ${check.stutter.length ? `Stottern „${check.stutter.join(' ')}“` : check.inserted.length ? `eingefügt „${check.inserted.join(' ')}“` : `${check.missing.length} Wörter fehlen`} (gehört: „${check.heard.slice(0, 160)}“)${attempt + 1 < VERIFY_ATTEMPTS ? ' — neuer Versuch mit anderem Seed' : ' — beste Fassung wird behalten'}`);
    if (attempt + 1 < VERIFY_ATTEMPTS) verify.note('retried');
  }
  if (stats && best.check && best.seed !== seed) stats.reseeded = (stats.reseeded || 0) + 1;
  if (stats && best.check && !best.check.ok) stats.unresolved = (stats.unresolved || 0) + 1;
  const norm = normalizePcm(best.speech, normalizeDb);
  if (stats && norm.gainDb) stats.gains.push(norm.gainDb);
  return norm.pcm;
}

function gapAfterMs(flat, i) {
  const next = flat[i + 1];
  if (!next) return 0;
  if (next.first) return GAP_PART_MS;
  return next.speaker !== flat[i].speaker ? GAP_SPEAKER_MS : GAP_SAME_MS;
}
function flattenScript(script) {
  const flat = [];
  script.parts.forEach((p, pi) => p.lines.forEach((l, li) => flat.push({ speaker: l.speaker, text: l.text, part: pi, index: li, first: li === 0 })));
  return flat;
}
const seedFor = (speaker, seeds) => (speaker === 'Host' ? seeds.Host : seeds.Guest);

async function renderInterview({ script, language, voices, seeds, engineMode, tmpDir, outFile, wavFile, log, onProgress, normalizeDb, verifySpeech }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const flat = flattenScript(script);
  const total = flat.length;
  const stats = { engines: { omnivoice: 0, pocket: 0 }, substituted: new Set(), gains: [] };
  const pieces = [];
  const lineDurations = [];
  for (let i = 0; i < total; i++) {
    const line = flat[i];
    const speech = await renderOneLine({ text: line.text, language, voiceName: voices[line.speaker] || voices.Guest, seed: seedFor(line.speaker, seeds), engineMode, tmpDir, tag: `l${i}`, log, stats, normalizeDb, verifySpeech });
    const gap = silence(gapAfterMs(flat, i));
    pieces.push(speech, gap);
    lineDurations.push((speech.length + gap.length) / BPS);
    if (onProgress) onProgress({ done: i + 1, total, speaker: line.speaker, engine: stats.engines });
    if (log && (i === 0 || (i + 1) % 5 === 0 || i + 1 === total)) log(`${i + 1}/${total} Zeilen gesprochen (OmniVoice ${stats.engines.omnivoice}, Pocket ${stats.engines.pocket})`);
  }
  pieces.push(silence(TAIL_MS));
  const pcm = Buffer.concat(pieces);
  if (log && normalizeDb) log(`Lautstärke-Angleich auf ${normalizeDb} dBFS: ${stats.gains.length} Zeilen angepasst${stats.gains.length ? ` (${Math.min(...stats.gains).toFixed(1)} … ${Math.max(...stats.gains).toFixed(1)} dB)` : ''}`);
  if (log && verifySpeech) log(`Aussprache geprüft: ${total} Zeilen, ${stats.reseeded || 0} neu gesprochen${stats.unresolved ? `, ${stats.unresolved} trotz 3 Versuchen auffällig (siehe oben)` : ''}`);
  await writeOutputs(pcm, tmpDir, { mp3File: outFile, wavFile });
  return { mp3File: outFile, durationSec: pcm.length / BPS, lineDurations, engines: stats.engines, substituted: [...stats.substituted], normalized: stats.gains.length, reseeded: stats.reseeded || 0, unresolved: stats.unresolved || 0 };
}

async function rerenderLines({ script, language, voices, seeds, engineMode, tmpDir, indexes, existing, outFile, wavFile, log, onProgress, normalizeDb, verifySpeech }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const flat = flattenScript(script);
  if (existing.lineDurations.length !== flat.length) throw new Error(`Zeilendauern (${existing.lineDurations.length}) passen nicht zum Skript (${flat.length} Zeilen) — bitte komplett neu vertonen`);
  const todo = new Set(indexes);
  const stats = { engines: { omnivoice: 0, pocket: 0 }, substituted: new Set(), gains: [] };
  let oldAdjusted = 0;
  const pieces = [];
  const lineDurations = [];
  let cursor = 0;
  let done = 0;
  for (let i = 0; i < flat.length; i++) {
    const oldBytes = Math.round(existing.lineDurations[i] * BPS) & ~1;
    if (todo.has(i)) {
      const line = flat[i];
      const speech = await renderOneLine({ text: line.text, language, voiceName: voices[line.speaker] || voices.Guest, seed: seedFor(line.speaker, seeds), engineMode, tmpDir, tag: `r${i}`, log, stats, normalizeDb, verifySpeech });
      const gap = silence(gapAfterMs(flat, i));
      pieces.push(speech, gap);
      lineDurations.push((speech.length + gap.length) / BPS);
      done++;
      if (onProgress) onProgress({ done, total: todo.size, speaker: line.speaker, engine: stats.engines });
      if (log) log(`Zeile ${i + 1} (${line.speaker === 'Host' ? 'Host' : 'Gast'}) neu gesprochen — ${(speech.length / BPS).toFixed(1)} s`);
    } else {
      const slice = existing.pcm.subarray(cursor, Math.min(existing.pcm.length, cursor + oldBytes));
      const norm = normalizePcm(slice, normalizeDb);
      if (norm.gainDb) oldAdjusted++;
      pieces.push(norm.pcm);
      lineDurations.push(existing.lineDurations[i]);
    }
    cursor += oldBytes;
  }
  pieces.push(silence(TAIL_MS));
  const pcm = Buffer.concat(pieces);
  if (log && normalizeDb) log(`Lautstärke-Angleich auf ${normalizeDb} dBFS: ${stats.gains.length} neue + ${oldAdjusted} bestehende Zeilen angepasst`);
  if (log && verifySpeech) log(`Aussprache geprüft: ${todo.size} Zeilen, ${stats.reseeded || 0} mit anderem Seed${stats.unresolved ? `, ${stats.unresolved} trotz 3 Versuchen auffällig` : ''}`);
  await writeOutputs(pcm, tmpDir, { mp3File: outFile, wavFile });
  return { mp3File: outFile, durationSec: pcm.length / BPS, lineDurations, engines: stats.engines, substituted: [...stats.substituted], rerendered: todo.size, normalized: stats.gains.length + oldAdjusted, reseeded: stats.reseeded || 0, unresolved: stats.unresolved || 0 };
}

async function auditLines({ script, language, pcm, lineDurations, tmpDir, log, onProgress }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const flat = flattenScript(script);
  const bad = [];
  let cursor = 0;
  for (let i = 0; i < flat.length; i++) {
    const bytes = Math.round(lineDurations[i] * BPS) & ~1;
    const slice = pcm.subarray(cursor, Math.min(pcm.length, cursor + bytes));
    cursor += bytes;
    const check = await checkSpeech(slice, flat[i].text, language, tmpDir, `audit${i}`);
    verify.note('checked');
    if (!check.ok) { bad.push(i); verify.note('failed'); if (log) log(`Zeile ${i + 1} (${flat[i].speaker === 'Host' ? 'Host' : 'Gast'}): ${check.stutter.length ? `Stottern „${check.stutter.join(' ')}“` : check.inserted.length ? `eingefügt „${check.inserted.join(' ')}“` : `${check.missing.length} Wörter fehlen`} — gehört: „${check.heard.slice(0, 160)}“`); }
    if (onProgress) onProgress({ done: i + 1, total: flat.length, bad: bad.length });
  }
  return { bad, total: flat.length };
}

function slicePcm(pcm, startSec, endSec) {
  const a = Math.max(0, Math.min(pcm.length, Math.round(startSec * BPS) & ~1));
  const b = Math.max(a, Math.min(pcm.length, Math.round(endSec * BPS) & ~1));
  return pcm.subarray(a, b);
}
function ffmpegAvailable() {
  try { const { spawnSync } = require('child_process'); return spawnSync(paths.ffmpegPath(), ['-version'], { windowsHide: true }).status === 0; } catch { return false; }
}

module.exports = { SAMPLE_RATE, renderInterview, rerenderLines, auditLines, flattenScript, normalizePcm, speechStats, loadPcm, slicePcm, mp3ToPcm, chunkText, ffmpegAvailable, wavHeader, runFfmpeg };
