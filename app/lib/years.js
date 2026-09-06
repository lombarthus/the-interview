'use strict';

// Jahreszahlen fürs Sprechen: bis 1999 „neunzehnhundertneununddreißig“,
// nie „eintausendneunhundert…“; ab 2000 „zweitausendzwölf“, nie „zwanzighundertzwölf“.
// Englisch entsprechend „nineteen thirty-nine“ / „two thousand and five“ / „twenty twelve“.
// Der Prompt verlangt das zwar, aber LLMs liefern trotzdem Ziffern oder die Tausender-Form —
// deshalb läuft diese Umwandlung deterministisch über jede Zeile, bevor sie gesprochen wird,
// und über jede LLM-Zeile, bevor sie gespeichert wird (Untertitel = gesprochener Text).

const DE_ONES = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// 1..99 als Wort. Deutsch: „eins“ nur alleinstehend am Ende, „einundzwanzig“ sonst.
function de99(n) {
  if (n === 0) return '';
  if (n === 1) return 'eins';
  if (n < 20) return DE_ONES[n];
  const o = n % 10;
  const t = Math.floor(n / 10);
  return o ? `${DE_ONES[o]}und${DE_TENS[t]}` : DE_TENS[t];
}
function en99(n) {
  if (n === 0) return '';
  if (n < 20) return EN_ONES[n];
  const o = n % 10;
  const t = Math.floor(n / 10);
  return o ? `${EN_TENS[t]}-${EN_ONES[o]}` : EN_TENS[t];
}

// Ein Jahr 1000–2099 als Wort.
function yearWord(year, lang) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1000 || y > 2099) return null;
  const hi = Math.floor(y / 100);   // 10..20
  const lo = y % 100;
  if (lang === 'de') {
    if (hi >= 20) return `zweitausend${de99(lo)}`;
    if (hi === 10) return `tausend${de99(lo)}`;
    return `${DE_ONES[hi]}hundert${de99(lo)}`;
  }
  if (hi >= 20) return lo === 0 ? 'two thousand' : lo < 10 ? `two thousand and ${en99(lo)}` : `twenty ${en99(lo)}`;
  const head = EN_ONES[hi];
  if (lo === 0) return `${head} hundred`;
  if (lo < 10) return `${head} oh ${en99(lo)}`;
  return `${head} ${en99(lo)}`;
}

// Jahrzehnt („1990er“, „1990s“): nur für volle Zehner ab 20 — sonst bleibt das Token stehen.
function decadeWord(year, lang, suffix) {
  const y = Number(year);
  const lo = y % 100;
  if (lo % 10 !== 0 || lo < 20) return null;
  const base = yearWord(y, lang);
  if (lang === 'de') return `${base}${suffix || 'er'}`;
  return base.replace(/y$/, 'ies');
}

// Alleinstehende vierstellige Zahl 1000–2099, nicht Teil einer größeren Zahl („1.939“, „1939,5“,
// „21939“), nicht vor „%“ / Uhr-Doppelpunkt. Erlaubte Nachsilbe: „er/ern“ (de) bzw. „s“ (en).
const YEAR_RE = /(?<![\d.,:€$£])\b(1\d{3}|20\d{2})(er|ern|s)?\b(?![.,:]\d|\s?%)/g;

// Falsche Wortform aus dem LLM: „eintausendneunhundertneununddreißig“ -> „neunzehnhundert…“.
const DE_BAD_PREFIX_RE = /\b(ein|Ein)?tausend(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun)hundert(?=[a-zäöüß]*\b)/g;
const DE_TEEN = { ein: 'elf', zwei: 'zwölf', drei: 'dreizehn', vier: 'vierzehn', fünf: 'fünfzehn', sechs: 'sechzehn', sieben: 'siebzehn', acht: 'achtzehn', neun: 'neunzehn' };
const EN_BAD_RE = /\b(one thousand,? (?:and )?)(one|two|three|four|five|six|seven|eight|nine) hundred(?: and)?\b/gi;
const EN_TEEN = { one: 'eleven', two: 'twelve', three: 'thirteen', four: 'fourteen', five: 'fifteen', six: 'sixteen', seven: 'seventeen', eight: 'eighteen', nine: 'nineteen' };

function capLike(sample, word) { return /^[A-ZÄÖÜ]/.test(sample) ? word.charAt(0).toUpperCase() + word.slice(1) : word; }

// Jahreszahlen im Text in die gesprochene Form bringen. Nur Ziffernjahre 1000–2099 und die
// bekannten Fehlformen; alles andere (Mengen, Preise, Uhrzeiten) bleibt unberührt.
function spellYears(text, lang) {
  const L = lang === 'de' ? 'de' : 'en';
  let t = String(text || '');
  t = t.replace(YEAR_RE, (m, year, suffix) => {
    if (suffix) { const d = decadeWord(year, L, suffix); return d && ((L === 'de') === (suffix !== 's')) ? d : m; }
    return yearWord(year, L) || m;
  });
  if (L === 'de') {
    t = t.replace(DE_BAD_PREFIX_RE, (m, ein, h) => capLike(m, `${DE_TEEN[h]}hundert`));
    t = t.replace(/\b(zwanzig|Zwanzig)hundert(?=[a-zäöüß]*\b)/g, (m) => capLike(m, 'zweitausend'));
  } else {
    t = t.replace(EN_BAD_RE, (m, _pre, h) => capLike(m, `${EN_TEEN[h.toLowerCase()]} `)).replace(/\s{2,}/g, ' ');
  }
  return t;
}

module.exports = { spellYears, yearWord, decadeWord };
