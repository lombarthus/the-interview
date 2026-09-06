#!/usr/bin/env node
'use strict';

// Smoke-Tests ohne Netz, ohne Modelle, ohne Engine: reine Logik der App.
//   node tools/smoke.js

const assert = require('assert');
process.env.INTERVIEW_HOME = require('path').join(require('os').tmpdir(), 'the-interview-smoke');

const lang = require('../app/lib/lang');
const { spellYears } = require('../app/lib/years');
const script = require('../app/lib/script');
const verify = require('../app/lib/verify');
const tts = require('../app/lib/tts');
const research = require('../app/lib/research');
const secrets = require('../app/lib/secrets');
const gemini = require('../app/lib/providers/gemini');
const codex = require('../app/lib/providers/codex-cli');
const { Store, DEFAULT_CONFIG } = require('../app/lib/store');
const llm = require('../app/lib/llm');

let n = 0;
function t(name, fn) { fn(); n++; console.log(`ok  ${name}`); }

t('lang: erkennt Deutsch und Englisch', () => {
  assert.strictEqual(lang.detectLang('Das ist ein ganz normaler deutscher Satz mit vielen Wörtern.').lang, 'de');
  assert.strictEqual(lang.detectLang('This is a perfectly normal English sentence with many words.').lang, 'en');
  const c = lang.checkLines([{ speaker: 'Host', text: 'Guten Abend und willkommen zur Sendung.' }, { speaker: 'Guest', text: 'Thank you, it is a pleasure to be here tonight.' }], 'de');
  assert.strictEqual(c.ok, false); assert.strictEqual(c.wrong.length, 1);
});
t('lang: Anrede-Riegel', () => {
  assert.strictEqual(lang.checkFormality([{ text: 'Wie geht es dir heute?' }], 'sie').ok, false);
  assert.strictEqual(lang.checkFormality([{ text: 'Wie geht es Ihnen heute?' }], 'sie').ok, true);
});
t('years: Jahreszahlen', () => {
  assert.strictEqual(spellYears('Im Jahr 1939 begann es.', 'de'), 'Im Jahr neunzehnhundertneununddreißig begann es.');
  assert.strictEqual(spellYears('Seit 2012 ist alles anders.', 'de'), 'Seit zweitausendzwölf ist alles anders.');
  assert.strictEqual(spellYears('In 1905 he wrote it.', 'en'), 'In nineteen oh five he wrote it.');
  assert.strictEqual(spellYears('Es kostet 1.939 Mark.', 'de'), 'Es kostet 1.939 Mark.');
});
t('script: Prompts tragen Host- und Show-Name, nie fremde Marken', () => {
  const sys = script.scriptSystemPrompt('de', 'sie', { hostName: 'Kim', showName: 'Nachtgespräch' });
  assert.ok(sys.includes('Kim') && sys.includes('Nachtgespräch'));
  assert.ok(!/SARC|Arno/.test(sys));
  const d = script.disclaimer('en', 'Kim');
  assert.ok(d.startsWith('Hi, this is Kim.'));
  assert.strictEqual(script.FLAVORS.length, 15);
  assert.ok(!script.FLAVORS.some((f) => /SARC|Arno/.test(f.direction + f.blurb)));
});
t('script: JSON-Parser und Teil-Normalisierung', () => {
  const j = script.extractJson('Hier ist es:\n```json\n{"partTitle":"A","lines":[{"speaker":"Host","text":"Hallo 1999."},{"speaker":"Gast","text":"Hi."}],"summary":"x",}\n```');
  const p = script.normalizePart(j, 0, 'de');
  assert.strictEqual(p.lines[0].speaker, 'Host'); assert.strictEqual(p.lines[1].speaker, 'Guest');
  assert.strictEqual(p.lines[0].text, 'Hallo neunzehnhundertneunundneunzig.');
});
t('script: Planung und Titel', () => {
  const plan = script.planParts({ durationMin: 8, parts: 2 });
  assert.strictEqual(plan.partCount, 2); assert.ok(plan.linesPerPart >= 6);
  assert.strictEqual(script.suggestTitle({ guestName: 'Ada', flavorId: 'reverse', language: 'de', hostName: 'Kim' }), 'Ada fragt Kim');
});
t('verify: Vergleich Skript/Gehörtes', () => {
  assert.strictEqual(verify.compare('Hallo, hier ist der Host.', 'Hallo hier ist ist der Host').ok, false);
  assert.strictEqual(verify.compare('Kapitän Dakkar grüßt.', 'Kapitän Dacker grüßt').ok, true);
  assert.strictEqual(verify.compare('Im Jahr 2026 war es.', 'Im Jahr zweitausendsechsundzwanzig war es').ok, true);
});
t('tts: Lautstärke-Angleich', () => {
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 2000), i * 2);
  const r = tts.normalizePcm(pcm, -18);
  assert.ok(r.gainDb > 0);
  assert.strictEqual(tts.normalizePcm(pcm, 0).gainDb, 0);
});
t('research: SSRF-Riegel', () => {
  const priv = ['127.0.0.1', ['10', '1.2.3'].join('.'), ['192', '168.0.5'].join('.'), ['172', '16.0.1'].join('.'), ['169', '254.1.1'].join('.'), '::1', '::ffff:' + ['10', '0.0.1'].join('.')];
  for (const ip of priv) assert.strictEqual(research.isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860::8888']) assert.strictEqual(research.isPrivateIp(ip), false, ip);
});
t('secrets: Maske und Scrub', () => {
  assert.strictEqual(secrets.mask('AIzaSyABCDEFGHIJKLMNOP'), 'AIza…OP');
  assert.strictEqual(secrets.mask('abc'), '••••');
});
t('gemini: Free-Filter', () => {
  assert.ok(gemini.isFree('gemini-2.5-flash-lite'));
  assert.ok(!gemini.isFree('gemini-2.5-pro'));
  assert.ok(!gemini.isFree('gemini-2.5-flash-preview-tts'));
});
t('codex: JSONL-Parser', () => {
  const out = '{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\n{"type":"turn.completed","model":"gpt-x"}\n';
  const r = codex.parseJsonl(out);
  assert.strictEqual(r.reply, 'pong');
});
t('store: Konfiguration ohne Geheimnisse, Riegel für lokale URL', () => {
  const fs = require('fs'); const path = require('path');
  const dir = path.join(process.env.INTERVIEW_HOME, 'store-test');
  fs.rmSync(dir, { recursive: true, force: true });
  const s = new Store(dir, path.join(dir, 'work'));
  const c = s.saveConfig({ hostName: '  Kim ', localUrl: 'http://evil.example/v1', providerOrder: ['gemini', 'local'], providerModels: { anthropic: 'claude-opus-5' } });
  assert.strictEqual(c.hostName, 'Kim');
  assert.strictEqual(c.localUrl, DEFAULT_CONFIG.localUrl);
  assert.deepStrictEqual(c.providerOrder, ['gemini', 'local']);
  assert.ok(!('anthropicKey' in c));
  const iv = s.create({ title: 'T', guest: { name: 'G', voice: 'v' }, script: null });
  assert.ok(/^[a-z0-9]{12}$/.test(iv.id));
  fs.rmSync(dir, { recursive: true, force: true });
});
t('llm: ohne Provider klare Fehlermeldung', async () => {
  llm.applyConfig({ providerOrder: ['gemini'], providerEnabled: { 'claude-cli': false, 'codex-cli': false, anthropic: false, openai: false, gemini: false, local: false } });
  await llm.runChat({ messages: [{ role: 'user', content: 'x' }] }).then(() => assert.fail('sollte scheitern'), (e) => assert.strictEqual(e.code, 'NO_PROVIDER'));
});
setTimeout(() => console.log(`\n${n} Smoke-Tests ok`), 50);
