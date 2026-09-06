'use strict';

// Prompts, Flavors, Titel und Antwort-Parsing. Keine Netz- oder LLM-Aufrufe hier — die kommen
// aus lib/llm.js, damit dieses Modul offline prüfbar bleibt. Host- und Show-Name kommen aus der
// Konfiguration (show = { hostName, showName }); der Sprecher-Schlüssel im Skript ist 'Host'.

const { spellYears } = require('./years');
const NO_TOOLS = 'You have no tools, no web access, no MCP and no files. Work only with the context given in this prompt. Answer with the JSON asked for and nothing else — no prose before or after, no markdown fences.';

const FLAVORS = [
  { id: 'classic', label: 'Klassisch & sachlich', blurb: 'Seriöses Radio-Interview, gut vorbereitet, respektvoll.', direction: 'A classic, well-prepared radio interview. The host is curious, respectful and precise; the guest answers in depth. No gimmicks.' },
  { id: 'late-night', label: 'Late-Night-Show', blurb: 'Locker, mit Studiopublikum, Lacher und Schlagfertigkeit.', direction: 'A late-night talk show with a live studio audience. Warm banter, quick wit, laughs; the host teases gently, the guest plays along. Audience reactions may be mentioned in brackets like [laughter].' },
  { id: 'investigative', label: 'Investigativ & konfrontativ', blurb: 'Der Host bohrt nach, der Gast muss sich erklären.', direction: 'An investigative, confrontational interview. The host presses hard on contradictions and controversies with well-sourced questions; the guest defends, deflects, occasionally concedes. Tense but fair.' },
  { id: 'cozy', label: 'Küchentisch', blurb: 'Warm, persönlich, Kaffee auf dem Tisch, viel Biografie.', direction: 'A cozy kitchen-table conversation with coffee. Personal, warm, biographical; small sensory details; long, unhurried answers; genuine human moments.' },
  { id: 'rapid-fire', label: 'Schnellfeuer', blurb: 'Kurze Fragen, kurze Antworten, hohes Tempo.', direction: 'A rapid-fire round: short punchy questions, short answers, very high tempo, playful pressure, occasional "pass".' },
  { id: 'philosophical', label: 'Philosophisches Tiefgespräch', blurb: 'Langsam, nachdenklich, große Fragen.', direction: 'A slow, reflective philosophical dialogue. Big questions about meaning, legacy, time and doubt; pauses; the guest thinks aloud; the host listens more than they talk.' },
  { id: 'roast', label: 'Roast & Kabarett', blurb: 'Liebevoll gemein, Pointen, Selbstironie.', direction: 'A comedy roast. The host lovingly mocks the guest, the guest fires back with self-irony; punchlines every few lines; never hateful, always affectionate.' },
  { id: 'time-travel', label: 'Zeitreise', blurb: 'Der Gast wird aus seiner Epoche ins Heute geholt.', direction: 'A time-travel show: the guest has just been pulled from their own era into the present day. They react to today\'s world, technology and news with confusion, delight or horror; the host explains and asks what they think.' },
  { id: 'noir', label: 'Film-Noir-Verhör', blurb: 'Regen am Fenster, eine Lampe, ein Verhör.', direction: 'A film-noir interrogation. Rain on the window, one lamp, cigarette smoke. The host is a weary detective, the guest a witness with something to hide; clipped hard-boiled dialogue, voice-over-like asides.' },
  { id: 'dream', label: 'Traumlogik', blurb: 'Surreal, Orte wechseln, Sätze verschieben sich.', direction: 'Dream logic: the studio keeps turning into other places, objects speak briefly, time loops, sentences drift into poetry, yet the emotional core of the conversation stays coherent. Surreal but beautiful.' },
  { id: 'absurd', label: 'Absurdes Theater', blurb: 'Ionesco trifft Radio: Sprache läuft aus dem Ruder.', direction: 'Theatre of the absurd (Ionesco / Beckett). Language slowly breaks down, questions and answers stop matching, rituals repeat, a chair is discussed at length — and yet the guest\'s real biography keeps surfacing through the nonsense.' },
  { id: 'cosmic', label: 'Kosmische Talkshow', blurb: 'Sendung vom Rand eines Schwarzen Lochs.', direction: 'A cosmic talk show broadcast from a station orbiting a black hole. Time dilation, a strange alien audience, cosmic perspective on the guest\'s life and work; grand, funny, slightly unsettling.' },
  { id: 'kids', label: 'Kindersendung', blurb: 'Alles ganz einfach erklärt, für Sechsjährige.', direction: 'A children\'s programme. Everything explained very simply and kindly for six-year-olds, with playful comparisons and a small quiz; the guest is patient and cheerful.' },
  { id: 'therapy', label: 'Therapiesitzung', blurb: 'Der Host ist der Therapeut, der Gast liegt auf der Couch.', direction: 'A therapy session. The host is a calm therapist, the guest lies on the couch and works through their fears, regrets and relationships; gentle probing, silences, one small breakthrough.' },
  { id: 'reverse', label: 'Rollentausch', blurb: 'Der Gast interviewt den Host über seine KI-Talkshow.', direction: 'Role reversal: the GUEST interviews the host about running a talk show whose guests are AI voice clones, about the experiment of talking to history and fiction, and why they invited this guest. The host answers honestly and with humour; the guest\'s own character colours the questions.' },
];

function flavorById(id) { return FLAVORS.find((f) => f.id === id) || null; }

function profilePrompt({ name, sourceText, sourceKind, sourceUrl }) {
  const system = `You are a research editor preparing a character brief for a fictional radio interview. ${NO_TOOLS}`;
  const user = `Build a character brief for the interview guest "${name || 'unknown'}" from the source material below.
Source kind: ${sourceKind}${sourceUrl ? ` (${sourceUrl})` : ''}.

Return exactly this JSON object (English keys, values in the language of the source material, German if the source is German):
{
  "name": "canonical name",
  "kind": "real person | fictional character | historical figure | other",
  "era": "when they lived/live or the work they come from",
  "shortBio": "3-5 sentences",
  "knownFor": ["3-6 short items"],
  "facts": ["8-14 concrete, quotable facts (dates, works, events, numbers)"],
  "voiceAndManner": "how they speak: register, pace, humour, typical phrases, accent notes — 2-4 sentences",
  "opinionsAndThemes": ["5-8 stances, obsessions or recurring themes"],
  "controversies": ["0-4 items, empty array if none"],
  "relationships": ["0-6 important people with one-line relation"],
  "suggestedThemes": ["6 interview themes, each max 8 words"],
  "confidence": "high | medium | low — how well the source supports this brief"
}
If the source is thin, say so in "confidence" and keep facts to what the source supports; do not invent biography.

SOURCE MATERIAL:
"""
${sourceText}
"""`;
  return { system, user };
}

// --- Voice Design ---------------------------------------------------------------
const DESIGN = {
  gender: ['male', 'female'],
  age: ['child', 'teenager', 'young adult', 'middle-aged', 'elderly'],
  pitch: ['very low', 'low', 'moderate', 'high', 'very high'],
  accent: ['American', 'Australian', 'British', 'Canadian', 'Chinese', 'Indian', 'Japanese', 'Korean', 'Portuguese', 'Russian'],
};
function voiceDesignPrompt({ profile, language }) {
  const system = `You cast voices for a fictional radio interview. ${NO_TOOLS}`;
  const user = `Design the voice and the manner of speaking for the interview guest below. The interview is spoken in ${language === 'de' ? 'GERMAN' : 'ENGLISH'}.

The TTS engine can shape a voice ONLY with these attributes:
- gender: ${DESIGN.gender.join(' | ')}
- age: ${DESIGN.age.join(' | ')}  (the age the guest has in the interview's fiction — for a historical figure, the age of their most famous years)
- pitch: ${DESIGN.pitch.join(' | ')}
- accent (ENGLISH interviews only, else null): ${DESIGN.accent.join(' | ')} — pick the nearest fit (e.g. a German speaking English: no fitting accent → null; a Russian → Russian; a Londoner → British)
- whisper: true | false (almost always false)
Everything else — era, region, dialect colour, rhetoric — cannot be done by the voice and must be carried by the WORDS. Describe that in "speechStyle": how this person would talk in ${language === 'de' ? 'German' : 'English'} in the fiction: era-appropriate register and vocabulary (Shakespeare does not speak like a 2026 podcaster), regional flavour through idioms, greetings and word choice (a Bavarian says "Servus" and "Grüß Gott", a Hamburg native "Moin", a Berliner "wa?"), typical rhythm and sentence length, favourite expressions. IMPORTANT for TTS: standard spelling only — no phonetic dialect writing, at most a few dialect WORDS.

Return exactly this JSON:
{
  "gender": "...", "age": "...", "pitch": "...", "accent": "... or null", "whisper": false,
  "rationale": "1-2 sentences why (in ${language === 'de' ? 'German' : 'English'})",
  "speechStyle": {
    "era": "period the speech should sound like",
    "region": "regional origin and how it colours the speech, or 'neutral'",
    "register": "formal/informal, pace, sentence length, rhetoric",
    "expressions": ["4-8 typical words, greetings or idioms in ${language === 'de' ? 'German' : 'English'}"],
    "avoid": ["2-4 things this person would never say (e.g. modern slang, anglicisms)"],
    "sample": "one typical sentence in ${language === 'de' ? 'German' : 'English'}, standard spelling"
  }
}

GUEST PROFILE:
${JSON.stringify(profile, null, 1).slice(0, 7000)}`;
  return { system, user };
}
function normalizeVoiceDesign(raw, language) {
  const pick = (v, list, def) => (list.includes(String(v || '').toLowerCase().trim()) ? String(v).toLowerCase().trim() : def);
  const accentRaw = String(raw.accent || '').replace(/\s*accent$/i, '').trim();
  const accent = language === 'en' ? (DESIGN.accent.find((a) => a.toLowerCase() === accentRaw.toLowerCase()) || null) : null;
  const ss = raw.speechStyle && typeof raw.speechStyle === 'object' ? raw.speechStyle : {};
  const arr = (v, n) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n) : []);
  return {
    gender: pick(raw.gender, DESIGN.gender, 'male'), age: pick(raw.age, DESIGN.age, 'middle-aged'), pitch: pick(raw.pitch, DESIGN.pitch, 'moderate'),
    accent, whisper: Boolean(raw.whisper), rationale: String(raw.rationale || '').slice(0, 400),
    speechStyle: { era: String(ss.era || '').slice(0, 200), region: String(ss.region || '').slice(0, 300), register: String(ss.register || '').slice(0, 300), expressions: arr(ss.expressions, 8), avoid: arr(ss.avoid, 4), sample: String(ss.sample || '').slice(0, 300) },
  };
}
function instructFromDesign(d) {
  const parts = [d.gender, d.age, `${d.pitch} pitch`];
  if (d.accent) parts.push(`${d.accent} accent`);
  if (d.whisper) parts.push('whisper');
  return parts.join(', ');
}
// Referenztext für den Klon einer entworfenen Stimme (~13 s), kurze Sätze mit Satzenden bei
// ~1/4/6/9/12 s — der 6-s-Clip wird dann exakt an einem Satzende geschnitten.
const DESIGN_REF_TEXT = {
  de: 'Guten Abend. Schön, dass wir heute Zeit für dieses Gespräch haben. Ich freue mich auf Ihre Fragen. Ehrlich gesagt bin ich sehr gespannt. Fangen wir einfach an.',
  en: 'Good evening. I am glad we have time for this conversation today. I look forward to your questions. Honestly, I am quite curious. Let us simply begin.',
};
function refTextAtSentenceEnd(text, words, { min = 3.5, max = 7.8, target = 6.0 } = {}) {
  const toks = String(text).split(/\s+/).filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let wi = 0;
  const ends = [];
  for (let ti = 0; ti < toks.length && wi < words.length; ti++) {
    let found = -1;
    for (let k = wi; k < Math.min(words.length, wi + 3); k++) if (norm(words[k].w) === norm(toks[ti])) { found = k; break; }
    if (found < 0) continue;
    wi = found + 1;
    if (/[.!?…]$/.test(toks[ti])) ends.push({ ti, end: Number(words[found].e) || 0 });
  }
  const ok = ends.filter((e) => e.end >= min && e.end <= max);
  if (!ok.length) return null;
  ok.sort((a, b) => Math.abs(a.end - target) - Math.abs(b.end - target));
  return { text: toks.slice(0, ok[0].ti + 1).join(' '), endSec: ok[0].end, candidates: ends.map((e) => e.end) };
}
function speechStyleBlock(profile, language) {
  const d = profile && profile.voiceDesign;
  const ss = d && d.speechStyle;
  if (!ss || !(ss.era || ss.region || ss.register)) return '';
  return `\nGUEST'S MANNER OF SPEAKING (follow it in every guest line, standard spelling, no phonetic dialect):
- Era: ${ss.era || '-'}
- Region: ${ss.region || 'neutral'}
- Register: ${ss.register || '-'}
- Typical expressions: ${(ss.expressions || []).join(', ') || '-'}
- Never says: ${(ss.avoid || []).join(', ') || '-'}
- Example: ${ss.sample || '-'}
All of it in ${language === 'de' ? 'GERMAN' : 'ENGLISH'}.\n`;
}

// --- Skript ------------------------------------------------------------------

function disclaimer(language, hostName) {
  return language === 'de'
    ? `Hallo, hier ist ${hostName}. Was ihr gleich hört, ist eine fiktive Aufnahme. Alle Stimmen in diesem Gespräch sind KI-generiert, auch die meines Gastes. Das Interview hat so nie stattgefunden und dient ausschließlich Bildungszwecken.`
    : `Hi, this is ${hostName}. What you are about to hear is a fictional recording. Every voice in this conversation is AI-generated, including my guest's. This interview never took place and is for educational purposes only.`;
}

const LANG_LABEL = { de: 'GERMAN (Deutsch)', en: 'ENGLISH' };
function languageRule(language) {
  const L = LANG_LABEL[language] || 'ENGLISH';
  const other = language === 'de' ? 'English' : 'German';
  return `LANGUAGE RULE (absolute): every spoken line, every part title and the summary must be in ${L}. The character brief, the theme and the previous-part summaries may be written in ${other} — that is source material only: translate, never copy or switch. Not one line in ${other}. A single line in another language makes the entire answer invalid and it will be rejected.`;
}
function formalityRule(language, formality, hostName) {
  if (language !== 'de') return '';
  if (formality === 'du') return `ADDRESS RULE (absolute, German): ${hostName} and the guest address each other with the informal "du" (du/dich/dir/dein) in EVERY line of EVERY part. Never "Sie"/"Ihnen"/"Ihr" as a form of address. Mixed or switching address makes the answer invalid.`;
  return `ADDRESS RULE (absolute, German): ${hostName} and the guest address each other with the formal "Sie" (Sie/Ihnen/Ihr/Ihre) in EVERY line of EVERY part. Never "du"/"dich"/"dir"/"dein" between them. Mixed or switching address makes the answer invalid.`;
}
function yearRule(language) {
  return language === 'de'
    ? 'YEAR RULE (German): years before 2000 are spoken with "hundert": 1939 = "neunzehnhundertneununddreißig", 1616 = "sechzehnhundertsechzehn" — NEVER "eintausendneunhundert…". From 2000 on use "tausend": 2012 = "zweitausendzwölf", 2026 = "zweitausendsechsundzwanzig" — NEVER "zwanzighundert…". Always write years as words in exactly this form.'
    : 'YEAR RULE (English): years before 2000 are spoken in pairs: 1939 = "nineteen thirty-nine", 1905 = "nineteen oh five" — never "one thousand nine hundred…". 2000–2009 = "two thousand (and) five"; from 2010 on "twenty twelve", "twenty twenty-six". Always write years as words in exactly this form.';
}
function scriptSystemPrompt(language, formality, show) {
  const hostName = show.hostName || 'Host';
  const showName = show.showName || 'The Interview';
  const langName = language === 'de' ? 'German (Deutsch, natürliches gesprochenes Deutsch)' : 'English (natural spoken English)';
  return `You write scripts for "${showName}", a fictional talk show produced entirely with AI voices. The host is ${hostName} (curious, dry humour, well prepared, hosts a talk show whose guests are voice clones of real, historical or fictional people). The guest is played by an AI voice clone. Everything is fiction and will be labelled as such. ${NO_TOOLS}

${languageRule(language)}
${formalityRule(language, formality, hostName)}
${yearRule(language)}

Write ALL spoken text in ${langName}. Lines are spoken by a text-to-speech engine: write numbers as words where a human would say them, avoid parentheses, URLs, emojis, stage directions inside the spoken text (a short bracketed cue like [laughter] is allowed at most once per part), and keep each line between one and five sentences. The host's lines carry the speaker key "Host", the guest's lines the speaker key "Guest".`;
}

const LINES_PER_MIN = 4.3;
const WORDS_PER_MIN = 140;
const MAX_LINES_PER_PART = 18;

function planParts({ durationMin, parts }) {
  const minutes = Math.min(30, Math.max(3, Number(durationMin) || 8));
  const totalLines = Math.max(6, Math.round(minutes * LINES_PER_MIN));
  let partCount = Math.min(8, Math.max(1, Math.round(Number(parts) || 1)));
  partCount = Math.max(partCount, Math.ceil(totalLines / MAX_LINES_PER_PART));
  partCount = Math.min(partCount, Math.max(1, Math.floor(totalLines / 6)));
  return { minutes, totalLines, partCount, linesPerPart: Math.ceil(totalLines / partCount), minutesPerPart: minutes / partCount, wordsPerPart: Math.round(minutes / partCount * WORDS_PER_MIN) };
}
function suggestParts(durationMin) { return Math.min(6, Math.max(1, Math.ceil((Number(durationMin) || 8) / 6))); }

function scriptPartPrompt({ profile, language, flavor, customFlavor, theme, title, partIndex, partCount, storySoFar, linesPerPart, minutesPerPart, wordsPerPart, languageWarning, formality, formalityWarning, show }) {
  const hostName = (show && show.hostName) || 'Host';
  const direction = customFlavor ? `Custom flavour requested by the user: ${customFlavor}` : `Flavour "${flavor.label}": ${flavor.direction}`;
  const brief = JSON.stringify(profile, null, 1).slice(0, 9000);
  const partWord = partCount > 1 ? `This is part ${partIndex + 1} of ${partCount}.` : 'This is a single-part interview.';
  const structure = partCount > 1
    ? (partIndex === 0 ? `Part 1 opens the show: ${hostName} welcomes the listeners and the guest, sets the theme, first exchanges. End the part on an open question or a teaser for the next part.`
      : partIndex === partCount - 1 ? `This is the final part: deepen, then bring the conversation to a satisfying close; ${hostName} thanks the guest and signs off to the listeners.`
        : 'A middle part: no re-introduction, pick up where the previous part ended, go deeper, end on a hook.')
    : 'Open the show, develop the theme, and close it with a proper sign-off.';
  return `${languageRule(language)}${languageWarning ? `\nWARNING: your previous attempt for this part contained lines in the wrong language and was rejected. Write this part again, entirely in ${LANG_LABEL[language]}.` : ''}
${formalityRule(language, formality, hostName)}${formalityWarning ? `\nWARNING: your previous attempt for this part mixed the forms of address ("${formality === 'du' ? 'Sie' : 'du'}" appeared) and was rejected. Use only "${formality === 'du' ? 'du' : 'Sie'}" this time.` : ''}

${partWord}
Show title: "${title}"
Host: ${hostName}
Theme of the conversation: ${theme || 'the guest\'s life and work'}
${direction}
${speechStyleBlock(profile, language)}Target length: about ${linesPerPart} lines and roughly ${wordsPerPart || Math.round(linesPerPart * 32)} words of spoken text in total (≈ ${minutesPerPart ? minutesPerPart.toFixed(1) : '?'} minutes when read aloud). Alternate: ${hostName} asks, the guest answers; the guest may also ask back. Guest answers should carry real substance from the brief.
${structure}
${storySoFar ? `\nWhat happened in the previous parts (do not repeat it):\n${storySoFar}\n` : ''}
CHARACTER BRIEF OF THE GUEST:
${brief}

Return exactly this JSON object (all three text fields in ${LANG_LABEL[language]}):
{
  "partTitle": "short title of this part, in ${LANG_LABEL[language]}",
  "lines": [ { "speaker": "Host" | "Guest", "text": "spoken text in ${LANG_LABEL[language]}" }, ... ],
  "summary": "2-3 sentences in ${LANG_LABEL[language]} of what was said in this part, for continuity"
}`;
}

// --- Titel (ohne LLM, sofort) -------------------------------------------------
function suggestTitle({ guestName, flavorId, customFlavor, theme, language, hostName }) {
  const g = guestName || (language === 'de' ? 'ein Gast' : 'a guest');
  const h = hostName || 'Host';
  const t = theme ? theme.trim() : '';
  const de = {
    classic: `Im Gespräch mit ${g}`, 'late-night': `Late Night mit ${g}`, investigative: `Nachgefragt: ${g}`, cozy: `Am Küchentisch mit ${g}`,
    'rapid-fire': `Schnellfeuer: ${g}`, philosophical: `${g} und die großen Fragen`, roast: `Roast: ${g}`, 'time-travel': `${g} im Jahr ${new Date().getFullYear()}`,
    noir: `Verhör: ${g}`, dream: `${g}, geträumt`, absurd: `Ein Stuhl, ein Mikrofon und ${g}`, cosmic: `${g} am Ereignishorizont`,
    kids: `${g} für Kinder erklärt`, therapy: `${g} auf der Couch`, reverse: `${g} fragt ${h}`,
  };
  const en = {
    classic: `In Conversation with ${g}`, 'late-night': `Late Night with ${g}`, investigative: `Hard Questions for ${g}`, cozy: `Kitchen Table with ${g}`,
    'rapid-fire': `Rapid Fire: ${g}`, philosophical: `${g} and the Big Questions`, roast: `Roasting ${g}`, 'time-travel': `${g} in ${new Date().getFullYear()}`,
    noir: `The Interrogation of ${g}`, dream: `${g}, Dreamed`, absurd: `A Chair, a Microphone and ${g}`, cosmic: `${g} at the Event Horizon`,
    kids: `${g}, Explained for Kids`, therapy: `${g} on the Couch`, reverse: `${g} Interviews ${h}`,
  };
  const table = language === 'de' ? de : en;
  let base = customFlavor ? `${g}: ${customFlavor.split(/[.!?\n]/)[0].trim().slice(0, 40)}` : (table[flavorId] || table.classic);
  if (t) base += ` — ${t}`;
  return base.slice(0, 120);
}

// --- Parsing -----------------------------------------------------------------
function extractJson(text) {
  const s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [fence ? fence[1] : null, s].filter(Boolean);
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    const body = c.slice(start, end + 1);
    try { return JSON.parse(body); } catch { /* nächster Kandidat */ }
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { /* weiter */ }
  }
  throw new Error('Antwort enthielt kein lesbares JSON');
}

function normalizeProfile(raw, fallbackName) {
  const arr = (v, max) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);
  return {
    name: String(raw.name || fallbackName || 'Gast').trim().slice(0, 80),
    kind: String(raw.kind || '').slice(0, 60),
    era: String(raw.era || '').slice(0, 160),
    shortBio: String(raw.shortBio || '').slice(0, 1500),
    knownFor: arr(raw.knownFor, 8),
    facts: arr(raw.facts, 16),
    voiceAndManner: String(raw.voiceAndManner || '').slice(0, 800),
    opinionsAndThemes: arr(raw.opinionsAndThemes, 10),
    controversies: arr(raw.controversies, 6),
    relationships: arr(raw.relationships, 8),
    suggestedThemes: arr(raw.suggestedThemes, 8),
    confidence: /^(high|medium|low)$/i.test(String(raw.confidence || '')) ? String(raw.confidence).toLowerCase() : 'medium',
  };
}

// Sprecher-Schlüssel: alles, was nach Gast aussieht, ist 'Guest'; der Rest ist 'Host' (auch wenn
// das Modell den Host-Namen als speaker schreibt).
function normalizePart(raw, partIndex, language) {
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .map((l) => ({ speaker: /guest|gast/i.test(String(l.speaker || '')) ? 'Guest' : 'Host', text: spellYears(String(l.text || '').replace(/\s+/g, ' ').trim(), language) }))
    .filter((l) => l.text.length > 0);
  if (lines.length < 2) throw new Error(`Teil ${partIndex + 1}: das Skript hat zu wenige Zeilen`);
  return { partTitle: String(raw.partTitle || `Teil ${partIndex + 1}`).slice(0, 120), lines, summary: String(raw.summary || '').slice(0, 800) };
}

module.exports = { FLAVORS, flavorById, disclaimer, LINES_PER_MIN, languageRule, formalityRule, DESIGN, DESIGN_REF_TEXT, refTextAtSentenceEnd, voiceDesignPrompt, normalizeVoiceDesign, instructFromDesign, planParts, suggestParts, profilePrompt, yearRule, scriptSystemPrompt, scriptPartPrompt, suggestTitle, extractJson, normalizeProfile, normalizePart, spellYears };
