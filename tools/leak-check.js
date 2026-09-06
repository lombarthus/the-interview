#!/usr/bin/env node
'use strict';

// Leak-Check: sucht Geheimnisse, persönliche Pfade und verbotene Dateien.
//
//   node tools/leak-check.js            gestagete Dateien (Pre-Commit-Hook)
//   node tools/leak-check.js --all      ganzer Arbeitsbaum (git ls-files)
//   node tools/leak-check.js --history  zusätzlich die komplette Git-Historie (git log -p --all)
//   node tools/leak-check.js --files a b c
//
// Muster: tools/leak-check.config.json (im Repo, generisch) + tools/leak-check.local.json
// (NICHT im Repo, persönliche Wortliste: Benutzername, E-Mail, Hostnamen, Stimmnamen …).
// Exit 1 bei Treffern. Läuft ohne Abhängigkeiten.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
const cfg = loadJson(path.join(__dirname, 'leak-check.config.json'), {});
const local = loadJson(path.join(__dirname, 'leak-check.local.json'), {});
const secretPatterns = (cfg.secretPatterns || []).map((p) => ({ name: p.name, re: new RegExp(p.pattern, p.flags || 'g') }));
const words = [...(cfg.forbiddenWords || []), ...(local.forbiddenWords || [])].filter(Boolean);
const wordRes = words.map((w) => ({ name: `Wort „${w.length > 24 ? w.slice(0, 24) + '…' : w}“`, re: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }));
const badExt = new Set((cfg.forbiddenExtensions || []).map((e) => e.toLowerCase()));
const badNames = (cfg.forbiddenFileNames || []).map((n) => new RegExp(n, 'i'));
const allowFiles = new Set(cfg.allowFiles || []);
const allowTokens = (cfg.allowTokens || []).map((r) => new RegExp(r));   // bekannte harmlose Token (z. B. Archivnamen)
const ENTROPY_MIN_LEN = cfg.entropy && cfg.entropy.minLength || 32;
const ENTROPY_MIN = cfg.entropy && cfg.entropy.minBits || 4.2;
const BINARY_OK = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.woff', '.woff2']);

function git(argsList) { const r = spawnSync('git', argsList, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }); if (r.status !== 0) throw new Error(`git ${argsList[0]}: ${(r.stderr || '').trim()}`); return r.stdout; }
function listFiles() {
  if (flag('--files')) return args.slice(args.indexOf('--files') + 1);
  try {
    if (flag('--all')) return git(['ls-files']).split('\n').filter(Boolean);
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
  } catch { // kein Git-Repo (z. B. vor git init): ganzen Baum nehmen
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['.git', 'node_modules', 'runtime', 'dist', 'work', '__pycache__'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(ROOT, p).replace(/\\/g, '/')); } };
    walk(ROOT);
    return out;
  }
}
function entropy(s) {
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
const findings = [];
function scanText(label, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of secretPatterns) { p.re.lastIndex = 0; if (p.re.test(line)) findings.push({ file: label, line: i + 1, what: p.name, snippet: line.trim().slice(0, 80) }); }
    for (const w of wordRes) { w.re.lastIndex = 0; if (w.re.test(line)) findings.push({ file: label, line: i + 1, what: w.name, snippet: line.trim().slice(0, 80) }); }
    // Hochentropische Token (Keys ohne bekanntes Präfix) — nur außerhalb von Prüfsummen-Dateien.
    if (!/sha256|checksum|integrity|SUMS/i.test(label)) {
      for (const tok of line.match(/[A-Za-z0-9+/_\-=]{32,}/g) || []) {
        if (/^[0-9a-f]{32,64}$/i.test(tok)) continue;             // Hex-Hashes (Prüfsummen, Git) sind keine Keys
        if (/^[A-Za-z_\-]+$/.test(tok) || /^[0-9]+$/.test(tok)) continue;
        if (allowTokens.some((re) => re.test(tok))) continue;
        if (tok.length >= ENTROPY_MIN_LEN && entropy(tok) >= ENTROPY_MIN) findings.push({ file: label, line: i + 1, what: 'hochentropisches Token (Key?)', snippet: tok.slice(0, 16) + '…' });
      }
    }
  });
}
function scanFileName(rel) {
  const ext = path.extname(rel).toLowerCase();
  const base = path.basename(rel);
  if (allowFiles.has(rel)) return;
  if (badExt.has(ext)) findings.push({ file: rel, line: 0, what: `verbotene Dateiendung ${ext}`, snippet: '' });
  for (const re of badNames) if (re.test(base)) findings.push({ file: rel, line: 0, what: `verbotener Dateiname (${re.source})`, snippet: '' });
}

const files = listFiles();
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
  scanFileName(rel);
  if (BINARY_OK.has(path.extname(rel).toLowerCase())) continue;
  if (rel === 'tools/leak-check.config.json' || rel === 'tools/leak-check.local.json') continue;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  if (buf.includes(0)) { findings.push({ file: rel, line: 0, what: 'Binärdatei (nicht erlaubt außer PNG/ICO)', snippet: '' }); continue; }
  scanText(rel, buf.toString('utf8'));
}
if (flag('--history')) {
  try {
    const log = git(['log', '-p', '--all', '--no-color']);
    let file = '(history)';
    log.split(/\r?\n/).forEach((line, i) => {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m) { file = `history:${m[1]}`; return; }
      if (!line.startsWith('+') || line.startsWith('+++')) return;
      if (/^history:tools\/leak-check\.(config|local)\.json$/.test(file)) return;   // die Wortliste selbst ist kein Leak
      scanText(file, line.slice(1));
    });
    // Dateinamen in der Historie
    const names = git(['log', '--all', '--name-only', '--pretty=format:']).split('\n').filter(Boolean);
    for (const n of new Set(names)) scanFileName(n);
  } catch (e) { console.log(`(Historie übersprungen: ${e.message})`); }
}
const uniq = new Map();
for (const f of findings) uniq.set(`${f.file}:${f.line}:${f.what}`, f);
const list = [...uniq.values()];
if (list.length) {
  console.error(`LEAK-CHECK: ${list.length} Treffer — Commit/Build abgelehnt\n`);
  for (const f of list.slice(0, 200)) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.what}${f.snippet ? `  → ${f.snippet}` : ''}`);
  if (list.length > 200) console.error(`  … und ${list.length - 200} weitere`);
  process.exit(1);
}
console.log(`leak-check: ${files.length} Datei(en)${flag('--history') ? ' + Historie' : ''} geprüft, 0 Treffer`);
