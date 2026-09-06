#!/usr/bin/env node
'use strict';

// Prüfsummen in app/lib/downloads.json gegen die Herausgeber-Dateien verifizieren
// (node SHASUMS256.txt, uv .sha256, ffmpeg release-essentials.sha256). Exit 1 bei Abweichung.
//   node tools/pin-downloads.js

const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'app', 'lib', 'downloads.json');
const dl = JSON.parse(fs.readFileSync(file, 'utf8'));

async function text(url) { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.text(); }
(async () => {
  let bad = 0;
  const shas = await text(dl.node.checksumUrl);
  const nodeLine = shas.split('\n').find((l) => l.includes(path.basename(dl.node.url)));
  const nodeSha = nodeLine ? nodeLine.split(/\s+/)[0] : '';
  console.log(`node   ${nodeSha === dl.node.sha256 ? 'ok' : 'MISMATCH'} ${nodeSha}`); if (nodeSha !== dl.node.sha256) bad++;
  const uvSha = (await text(dl.uv.checksumUrl)).trim().split(/\s+/)[0];
  console.log(`uv     ${uvSha === dl.uv.sha256 ? 'ok' : 'MISMATCH'} ${uvSha}`); if (uvSha !== dl.uv.sha256) bad++;
  const ffSha = (await text(dl.ffmpeg.checksumUrl)).trim().split(/\s+/)[0];
  console.log(`ffmpeg ${ffSha === dl.ffmpeg.sha256 ? 'ok' : 'MISMATCH (gyan.dev hat vermutlich eine neue Version — URL + Summe in downloads.json aktualisieren)'} ${ffSha}`); if (ffSha !== dl.ffmpeg.sha256) bad++;
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
