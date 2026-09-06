'use strict';

// Sprachprüfung ohne LLM: Deutsch oder Englisch anhand von Funktionswörtern. Die App kennt nur
// diese zwei Sprachen, also reicht eine Stoppwort-Zählung — sie ist deterministisch, schnell und
// hat keine Quota. Zweck: ein Skript, das die Zielsprache verlässt (beobachtet:
// Teil 4 eines englischen Interviews kam auf Deutsch), darf nie gespeichert oder vertont werden.

const DE = new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'sie', 'wir', 'ihr', 'ein', 'eine', 'einen', 'einem', 'einer', 'mit', 'auf', 'für', 'von', 'zu', 'im', 'in', 'den', 'dem', 'des', 'auch', 'aber', 'oder', 'wie', 'was', 'wenn', 'dass', 'noch', 'schon', 'sich', 'mich', 'dich', 'uns', 'euch', 'wird', 'werden', 'wurde', 'hat', 'haben', 'habe', 'sind', 'war', 'waren', 'kann', 'können', 'muss', 'müssen', 'nur', 'sehr', 'mehr', 'als', 'doch', 'ja', 'nein', 'nicht', 'keine', 'kein', 'jetzt', 'hier', 'dann', 'denn', 'weil', 'über', 'unter', 'nach', 'vor', 'bei', 'aus', 'ganz', 'immer', 'wieder', 'diese', 'dieser', 'dieses', 'mein', 'meine', 'dein', 'deine', 'sein', 'seine', 'ihre', 'unsere', 'gibt', 'geht', 'macht', 'sagen', 'sagt', 'heute', 'morgen', 'gestern', 'zwischen', 'ohne', 'gegen', 'durch', 'also', 'etwas', 'nichts', 'alles', 'man', 'wer', 'wo', 'warum', 'welche', 'welcher']);
const EN = new Set(['the', 'and', 'is', 'not', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'a', 'an', 'with', 'on', 'for', 'of', 'to', 'in', 'at', 'by', 'from', 'that', 'this', 'these', 'those', 'also', 'but', 'or', 'how', 'what', 'if', 'still', 'already', 'myself', 'yourself', 'us', 'will', 'would', 'was', 'were', 'has', 'have', 'had', 'are', 'can', 'could', 'must', 'should', 'only', 'very', 'more', 'than', 'yes', 'no', 'now', 'here', 'then', 'because', 'about', 'under', 'after', 'before', 'over', 'out', 'quite', 'always', 'again', 'my', 'your', 'his', 'her', 'our', 'their', 'there', 'gives', 'goes', 'makes', 'say', 'says', 'today', 'tomorrow', 'yesterday', 'between', 'without', 'against', 'through', 'so', 'something', 'nothing', 'everything', 'one', 'who', 'where', 'why', 'which', 'do', 'does', 'did', 'been', 'being', 'just', 'like', 'into', 'as', 'me', 'him', 'them', 'its', 'when', 'while', 'never', 'ever']);

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-zäöüß'\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

// Liefert { lang: 'de'|'en'|null, de, en, words }. null = zu wenig Signal (kurze Zeile, Namen, Zahlen).
function detectLang(text) {
  const t = tokens(text);
  let de = 0;
  let en = 0;
  for (const w of t) { if (DE.has(w)) de++; if (EN.has(w)) en++; }
  // Umlaute/ß sind ein starkes Deutsch-Signal, das Stoppwörter nicht brauchen.
  const umlauts = (String(text || '').match(/[äöüß]/gi) || []).length;
  de += Math.min(3, umlauts);
  const total = de + en;
  if (t.length < 4 || total < 2) return { lang: null, de, en, words: t.length };
  if (de >= 2 * en && de >= 2) return { lang: 'de', de, en, words: t.length };
  if (en >= 2 * de && en >= 2) return { lang: 'en', de, en, words: t.length };
  return { lang: null, de, en, words: t.length };
}

// Zeilen gegen die Zielsprache prüfen. Eine Zeile gilt als falsch, wenn sie eindeutig die andere
// Sprache ist. Kurze Zeilen ohne Signal (Namen, „Ja.“) zählen nicht.
function checkLines(lines, language) {
  const other = language === 'de' ? 'en' : 'de';
  const wrong = [];
  let judged = 0;
  lines.forEach((l, i) => {
    const d = detectLang(l.text);
    if (!d.lang) return;
    judged++;
    if (d.lang === other) wrong.push({ index: i, speaker: l.speaker, detected: d.lang, text: String(l.text).slice(0, 120) });
  });
  return { ok: wrong.length === 0, wrong, judged, total: lines.length };
}

// Anrede (nur Deutsch): formality 'sie' verbietet du/dich/dir/dein*, 'du' verbietet die Höflichkeitsform.
// „Sie/Ihr“ am Satzanfang ist mehrdeutig (sie = they/she, ihr = her/their) und zählt nicht; „Ihnen“
// großgeschrieben mitten im Satz ist eindeutig die Anrede. Der Fiktions-Hinweis (Hörer-„ihr“) wird
// vom Aufrufer nicht mitgeprüft.
const INFORMAL = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|deins)\b/i;
const FORMAL_MID = /[^.!?…"„“»]\s+(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;
function checkFormality(lines, formality) {
  if (formality !== 'du' && formality !== 'sie') return { ok: true, wrong: [], judged: lines.length, total: lines.length };
  const wrong = [];
  lines.forEach((l, i) => {
    const t = String(l.text || '');
    const bad = formality === 'sie' ? INFORMAL.exec(t) : FORMAL_MID.exec(t);
    if (bad) wrong.push({ index: i, speaker: l.speaker, found: (bad[1] || bad[0]).trim(), text: t.slice(0, 120) });
  });
  return { ok: wrong.length === 0, wrong, judged: lines.length, total: lines.length };
}

module.exports = { detectLang, checkLines, checkFormality };
