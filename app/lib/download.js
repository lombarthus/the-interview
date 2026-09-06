'use strict';

// Datei mit Fortschritt herunterladen und die SHA-256 gegen die eingebettete Summe prüfen.
// Ein Download, dessen Summe nicht passt, wird gelöscht und als Fehler gemeldet — nie ausgeführt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

async function downloadFile(url, dest, { sha256, onProgress, timeoutMs = 60 * 60 * 1000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'TheInterview-Setup/1.0' } });
  if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen: HTTP ${r.status} von ${new URL(url).host}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let done = 0; let lastTick = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (onProgress && Date.now() - lastTick > 500) { lastTick = Date.now(); onProgress({ done, total }); }
    }
  } finally { await new Promise((res) => out.end(res)); }
  const digest = hash.digest('hex');
  if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
    try { fs.unlinkSync(tmp); } catch { /* egal */ }
    throw new Error(`Prüfsumme stimmt nicht (${digest.slice(0, 12)}… statt ${String(sha256).slice(0, 12)}…) — Download verworfen`);
  }
  try { fs.unlinkSync(dest); } catch { /* keine */ }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress({ done, total: total || done });
  return { bytes: done, sha256: digest };
}

// Zip entpacken: Windows 10+ bringt bsdtar (tar.exe) mit, das Zip liest; sonst PowerShell.
function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) return 'tar';
  r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) return 'powershell';
  throw new Error(`Entpacken fehlgeschlagen: ${(r.stderr || r.stdout || '').slice(-300)}`);
}

function findFile(dir, name, depth = 4) {
  if (depth < 0) return '';
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), name, depth - 1); if (f) return f; }
  return '';
}

module.exports = { downloadFile, extractZip, findFile };
