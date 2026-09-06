'use strict';

// Aussprache-Riegel: jede gesprochene Zeile wird mit Whisper nachgehört (Engine, /transcribe) und
// mit dem Skripttext verglichen. Eingefügte Wörter (Stottern wie „hier ist ist“, Fremdwörter aus
// dem Referenzclip) oder viele fehlende Wörter → die Zeile wird mit anderem Seed neu gesprochen.

const engine = require('./engine');

let stats = { checked: 0, failed: 0, retried: 0 };
let lastStatus = null;

async function available() {
  const s = await engine.status();
  lastStatus = s;
  return Boolean(s.reachable && s.asr && s.asr.available);
}
async function transcribe(wavFile, lang) { return engine.transcribe(wavFile, lang); }

// --- Vergleich Skript <-> Gehörtes ---------------------------------------------------------------
const NUM_DE = /^(null|eins?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)$/;
function tokens(text) {
  return String(text || '').toLowerCase()
    .replace(/[„“"'’‘»«()\[\]]/g, ' ')
    .replace(/[-–—/]/g, ' ')
    .replace(/[.,;:!?…]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/ß/g, 'ss'));
}
function charDist(a, b) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > 3) return 99;
  let prev = new Array(m + 1); for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}
function similar(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2) return true;
  const L = Math.min(a.length, b.length);
  if (L >= 4 && charDist(a, b) <= (L >= 8 ? 2 : 1)) return true;
  const NUMWORD = /(zig|ssig|hundert|tausend|zehn|elf|zwölf|zwoelf|teen|ty|hundred|thousand|million)$|^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/;
  if (/\d/.test(a) && (/\d/.test(b) || NUM_DE.test(b) || NUMWORD.test(b))) return true;
  if (/\d/.test(b) && (NUM_DE.test(a) || NUMWORD.test(a))) return true;
  return false;
}
// Wort-Levenshtein mit Rückverfolgung. ERSETZUNGEN sind erlaubt (Whisper verhört Eigennamen), ein
// Versprecher ist eine reine EINFÜGUNG oder viele fehlende Wörter (Zeile abgebrochen).
function compare(expected, heard) {
  const a = tokens(expected), b = tokens(heard);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const sub = dp[i - 1][j - 1] + (similar(a[i - 1], b[j - 1]) ? 0 : 1);
    dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
  }
  const insertedAt = [], missing = [], replaced = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (similar(a[i - 1], b[j - 1]) ? 0 : 1)) {
      if (!similar(a[i - 1], b[j - 1])) replaced.push(`${a[i - 1]}→${b[j - 1]}`);
      i--; j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) { insertedAt.push(j - 1); j--; }
    else { missing.push(a[i - 1]); i--; }
  }
  insertedAt.reverse(); missing.reverse(); replaced.reverse();
  const joinsToExpected = (jj) => {
    const left = jj > 0 ? b[jj - 1] + b[jj] : null;
    const right = jj + 1 < m ? b[jj] + b[jj + 1] : null;
    return a.some((x) => (left && similar(x, left)) || (right && similar(x, right)));
  };
  const missingLeft = [...missing];
  const realInserted = [];
  for (const jj of insertedAt) {
    const w = b[jj];
    if (/\d/.test(w) || w.length <= 1) continue;
    const k = missingLeft.findIndex((x) => similar(x, w));
    if (k >= 0) { missingLeft.splice(k, 1); continue; }
    if (joinsToExpected(jj)) continue;
    realInserted.push(w);
  }
  missing.length = 0; missing.push(...missingLeft);
  const stutter = realInserted.filter((w) => a.some((x) => x === w || (w.length >= 2 && x.startsWith(w))));
  const missRatio = n ? missing.length / n : 0;
  const ok = realInserted.length === 0 && missRatio <= 0.15;
  return { ok, inserted: realInserted, stutter, missing, replaced, missRatio: Number(missRatio.toFixed(2)), heard: String(heard || '').trim(), words: n };
}

function status() { return { available: Boolean(lastStatus && lastStatus.reachable && lastStatus.asr && lastStatus.asr.available), asr: lastStatus ? lastStatus.asr : null, stats: { ...stats } }; }
function note(kind) { stats[kind]++; }

module.exports = { available, transcribe, compare, status, note, tokens };
