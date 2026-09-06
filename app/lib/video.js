'use strict';

// MP4-Export eines Interviews: schwarzer Grund, neongrüne Echtzeit-Wellenform (ffmpeg showwaves
// mit weichem Leuchten), Logo oben links mit Show-Name und Titel, mittig der gerade gesprochene
// Text mit Sprecher-Kennung und Zähler, vorige Zeile gedimmt darunter. Die Textkarten sind PNGs je
// Zeile (engine/cards.py, Pillow im venv), jede als eigene Bildquelle mit Zeitfenster.
//
// WIEDERAUFNAHME NACH NEUSTART: das Hauptvideo entsteht in Segmenten (segNNN.mp4, nur Video); ein
// vorhandenes Segment ist garantiert vollständig (Umbenennung nach erfolgreichem Encode). Ein
// zweiter Aufruf mit demselben Arbeitsordner macht beim ersten fehlenden Segment weiter.
// Branding kommt aus der Konfiguration (showName, showUrl) und optional aus <home>/logo.png.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const paths = require('./paths');

const DEFAULT_LOGO = path.join(paths.assetsDir, 'logo.png');
const GREEN = '00ff9f';
const BG = '050505';
const W = 1280;
const H = 720;
const FPS = 30;
const END_CARD_SEC = 6;
const END_LOGO = 200;
const SEGMENT_SEC = Math.max(5, Math.round(Number(process.env.INTERVIEW_VIDEO_SEGMENT_SEC) || 60));

const TITLES = /^(kapitän|kapitaen|captain|dr\.?|prof\.?|herr|frau|mr\.?|mrs\.?|ms\.?|sir|lord|lady|könig|koenig|king|queen|königin|kaiser|emperor|prinz|prince|prinzessin|princess|graf|count|freiherr|baron|general|admiral|präsident|president|papst|pope|saint|st\.?|hl\.?)$/i;
function firstName(name) {
  const parts = String(name || 'Gast').trim().split(/\s+/);
  while (parts.length > 1 && TITLES.test(parts[0])) parts.shift();
  return parts[0] || 'Gast';
}

let current = null;
function abortRunning() {
  if (!current) return false;
  try { current.kill('SIGKILL'); } catch { /* weg */ }
  current = null;
  return true;
}

function run(args, cwd, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(paths.ffmpegPath(), ['-hide_banner', '-y', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args], { cwd, windowsHide: true });
    current = child;
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => { const m = /out_time_ms=(\d+)/.exec(String(d)); if (m && onProgress) onProgress(Number(m[1]) / 1e6); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* egal */ } reject(new Error('ffmpeg Zeitüberschreitung')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); if (current === child) current = null; reject(new Error(`ffmpeg nicht startbar: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(t); if (current === child) current = null; if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`)); });
  });
}

function pythonOrThrow() {
  const py = paths.venvPython();
  if (!py) throw new Error('Python-venv fehlt — Setup-Assistent ausführen');
  return py;
}
// Wortmarke als PNG (engine/wordmark.py): einmal je Text+Größe, gecacht im Arbeitsordner.
function ensureWordmark(text, size) {
  const key = crypto.createHash('sha1').update(`${text}|${size}|${GREEN}`).digest('hex').slice(0, 12);
  const dir = path.join(paths.workDir, 'wordmarks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `wm-${key}.png`);
  if (fs.existsSync(file)) return file;
  const r = spawnSync(pythonOrThrow(), [path.join(paths.engineDir, 'wordmark.py'), text, String(size), file, `#${GREEN}`], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`Wortmarke konnte nicht erzeugt werden: ${(r.stderr || r.stdout || '').slice(-200)}`);
  return file;
}
function logoFile() {
  const custom = path.join(paths.home, 'logo.png');
  return fs.existsSync(custom) ? custom : DEFAULT_LOGO;
}

function segmentPlan(durationSec, segmentSec = SEGMENT_SEC) {
  const n = Math.max(1, Math.ceil(durationSec / segmentSec));
  return Array.from({ length: n }, (_, k) => { const start = k * segmentSec; return { index: k, start, length: Math.min(segmentSec, durationSec - start), file: `seg${String(k).padStart(3, '0')}.mp4` }; });
}
function segmentsDone(tmpDir, durationSec, segmentSec = SEGMENT_SEC) {
  const plan = segmentPlan(durationSec, segmentSec);
  return { done: plan.filter((s) => fs.existsSync(path.join(tmpDir, s.file))).length, total: plan.length };
}
function finish(tmpDir, partName, finalName) {
  const target = path.join(tmpDir, finalName);
  try { fs.unlinkSync(target); } catch { /* keine */ }
  fs.renameSync(path.join(tmpDir, partName), target);
}
function fontFile(name) {
  const dir = process.env.INTERVIEW_FONT_DIR || 'C:/Windows/Fonts';
  for (const f of [name, 'segoeui.ttf', 'arial.ttf']) { const p = `${dir}/${f}`; if (fs.existsSync(p)) return p; }
  return `${dir}/${name}`;
}

async function renderVideo({ audioFile, lines, lineDurations, guestName, hostName, title, show, tmpDir, outFile, durationSec, log, onProgress, segmentSec = SEGMENT_SEC }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const logo = logoFile();
  if (!fs.existsSync(logo)) throw new Error(`Logo fehlt: ${logo}`);
  const exists = (name) => fs.existsSync(path.join(tmpDir, name));
  const showName = (show && show.showName) || 'The Interview';
  const showUrl = (show && show.showUrl) || '';
  const endLine1 = showUrl ? (lines.some((l) => /[äöüß]/i.test(l.text)) ? 'Mehr unter' : 'More at') : showName;

  fs.copyFileSync(ensureWordmark(showName, 30), path.join(tmpDir, 'wm.png'));
  fs.copyFileSync(ensureWordmark(endLine1, 44), path.join(tmpDir, 'line1.png'));
  if (showUrl) fs.copyFileSync(ensureWordmark(showUrl.toUpperCase(), 44), path.join(tmpDir, 'url.png'));
  fs.copyFileSync(logo, path.join(tmpDir, 'logo.png'));
  const audio = 'audio' + path.extname(audioFile);
  if (!exists(audio) || fs.statSync(path.join(tmpDir, audio)).size !== fs.statSync(audioFile).size) fs.copyFileSync(audioFile, path.join(tmpDir, audio));
  if (!lines.every((_, i) => exists(path.join('cards', `card${i}.png`)))) {
    fs.writeFileSync(path.join(tmpDir, 'cards.json'), JSON.stringify({ lines: lines.map((l) => ({ speaker: l.speaker, text: l.text })), guest: firstName(guestName), host: String(hostName || 'Host'), language: 'de' }), 'utf8');
    const cardsRes = spawnSync(pythonOrThrow(), [path.join(paths.engineDir, 'cards.py'), path.join(tmpDir, 'cards.json'), path.join(tmpDir, 'cards')], { windowsHide: true, encoding: 'utf8' });
    if (cardsRes.status !== 0) throw new Error(`Textkarten konnten nicht erzeugt werden: ${(cardsRes.stderr || cardsRes.stdout || '').slice(-300)}`);
  }

  const starts = []; { let t = 0; for (const d of lineDurations) { starts.push(t); t += d; } }
  const cards = lines.map((_, i) => ({ i, s: starts[i], e: i + 1 < lines.length ? starts[i + 1] - 0.05 : starts[i] + lineDurations[i] }));
  const font = fontFile('bahnschrift.ttf').replace(/:/g, '\\:');
  const titleTxt = String(title || '').replace(/[\\'%:]/g, ' ').slice(0, 90);

  const plan = segmentPlan(durationSec, segmentSec);
  const already = plan.filter((s) => exists(s.file)).length;
  const resumed = already > 0;
  if (log) log(`ffmpeg: ${W}x${H} @ ${FPS} fps, ${lines.length} Textkarten, ${Math.round(durationSec)} s in ${plan.length} Segment(en) à ${segmentSec} s${resumed ? ` — ${already} schon fertig, weiter ab Segment ${already + 1}` : ''}`);
  for (const seg of plan) {
    if (exists(seg.file)) continue;
    const S = seg.start;
    const E = seg.start + seg.length;
    const segCards = cards.filter((c) => c.e > S && c.s < E);
    const cardInputs = segCards.flatMap((c) => ['-loop', '1', '-i', `cards/card${c.i}.png`]);
    const cardChain = segCards.map((c, j) => `[${j === 0 ? 'titled' : `c${j - 1}`}][${3 + j}:v]overlay=0:0:enable='between(t,${(c.s - S).toFixed(3)},${(c.e - S).toFixed(3)})'[c${j}]`);
    const last = segCards.length ? `c${segCards.length - 1}` : 'titled';
    const filter = [
      `[0:a]atrim=start=${S}:end=${E.toFixed(3)},asetpts=PTS-STARTPTS,aformat=channel_layouts=mono,showwaves=s=${W}x${H}:mode=cline:colors=0x${GREEN}:rate=${FPS}:scale=cbrt,format=rgba,split[wa][wb]`,
      `[wa]gblur=sigma=22,colorchannelmixer=aa=0.5[glow]`,
      `[wb]gblur=sigma=3,colorchannelmixer=aa=0.55[soft]`,
      `color=c=0x${BG}:s=${W}x${H}:r=${FPS}[bg]`,
      `[bg][glow]overlay=0:0:shortest=1:format=auto[g1]`,
      `[g1][soft]overlay=0:0:format=auto[base]`,
      `[1:v]scale=56:56[logo]`,
      `[base][logo]overlay=28:22[withlogo]`,
      `[withlogo][2:v]overlay=96:28[marked]`,
      `[marked]drawtext=fontfile='${font}':text='${titleTxt}':fontcolor=0x${GREEN}@0.55:fontsize=18:x=96:y=64[titled]`,
      ...cardChain,
      `[${last}]format=yuv420p[v]`,
    ].join(';');
    const args = ['-i', audio, '-loop', '1', '-i', 'logo.png', '-loop', '1', '-i', 'wm.png', ...cardInputs, '-filter_complex', filter, '-map', '[v]', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', seg.length.toFixed(3), 'seg.part.mp4'];
    if (log) log(`Segment ${seg.index + 1}/${plan.length}: ${Math.round(S)}–${Math.round(E)} s, ${segCards.length} Karte(n)`);
    await run(args, tmpDir, Math.max(300000, seg.length * 8000), onProgress ? (sec) => onProgress(S + sec) : null);
    finish(tmpDir, 'seg.part.mp4', seg.file);
  }

  if (!exists('end.mp4')) {
    if (log) log(`Abbinder (${END_CARD_SEC} s) wird gerendert …`);
    const endTop = Math.round(H * 0.28);
    const endFilter = [
      `color=c=0x${BG}:s=${W}x${H}:r=${FPS}:d=${END_CARD_SEC}[bg]`,
      `[0:v]scale=${END_LOGO}:${END_LOGO}[logo]`,
      `[bg][logo]overlay=(W-w)/2:${endTop}:shortest=1[l]`,
      showUrl ? `[l][1:v]overlay=(W-w)/2:${endTop + END_LOGO + 40}[l1]` : `[l][1:v]overlay=(W-w)/2:${endTop + END_LOGO + 60},format=yuv420p[v]`,
      ...(showUrl ? [`[l1][2:v]overlay=(W-w)/2:${endTop + END_LOGO + 104},format=yuv420p[v]`] : []),
    ].join(';');
    const inputs = ['-loop', '1', '-i', 'logo.png', '-loop', '1', '-i', 'line1.png'];
    if (showUrl) inputs.push('-loop', '1', '-i', 'url.png');
    await run([...inputs, '-filter_complex', endFilter, '-map', '[v]', '-an', '-t', String(END_CARD_SEC), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS), 'end.part.mp4'], tmpDir, 120000);
    finish(tmpDir, 'end.part.mp4', 'end.mp4');
  }

  const totalSec = durationSec + END_CARD_SEC;
  if (log) log(`${plan.length} Segment(e) + Abbinder werden zusammengefügt, Audio wird gemischt …`);
  fs.writeFileSync(path.join(tmpDir, 'list.txt'), plan.map((s) => `file '${s.file}'`).concat(["file 'end.mp4'"]).join('\n') + '\n');
  await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-i', audio, '-filter_complex', '[1:a]aformat=channel_layouts=mono,apad[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '24000', '-ac', '1', '-t', totalSec.toFixed(3), '-movflags', '+faststart', 'out.part.mp4'], tmpDir, Math.max(300000, totalSec * 2000));
  finish(tmpDir, 'out.part.mp4', 'out.mp4');
  fs.copyFileSync(path.join(tmpDir, 'out.mp4'), outFile);
  const bytes = fs.statSync(outFile).size;
  return { file: outFile, bytes, seconds: totalSec, resumed, segments: plan.length };
}

module.exports = { renderVideo, segmentPlan, segmentsDone, abortRunning, W, H, FPS, SEGMENT_SEC, END_CARD_SEC };
