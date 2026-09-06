'use strict';

// The Interview — Oberfläche (Standalone). Alle Pfade relativ.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* kein JSON */ }
  if (!r.ok) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status, exists: Boolean(j && j.exists) });
  return j;
};
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

const PROVIDERS = [
  { id: 'claude-cli', name: 'Claude Code CLI', desc: 'Abo-Login der Claude-Code-CLI auf diesem PC. Wird nur erkannt, nie verändert.', key: null },
  { id: 'codex-cli', name: 'OpenAI Codex CLI', desc: 'ChatGPT-Abo-Login der Codex-CLI (codex login).', key: null },
  { id: 'anthropic', name: 'Anthropic API', desc: 'Eigener API-Key (console.anthropic.com). Vorgabe claude-opus-5.', key: 'anthropic' },
  { id: 'openai', name: 'OpenAI API', desc: 'Eigener API-Key (platform.openai.com).', key: 'openai' },
  { id: 'gemini', name: 'Google Gemini', desc: 'Eigener API-Key (AI Studio), nur kostenfreie Flash-Modelle mit Rotation.', key: 'gemini' },
  { id: 'local', name: 'Lokales Modell', desc: 'LM Studio, Ollama oder anderer OpenAI-kompatibler Server auf diesem PC. Offline.', key: 'local' },
];
const LABEL = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

const state = {
  config: {}, flavors: [], voices: [], host: null, defaults: {}, engine: null, secrets: null, llmStatus: null,
  hits: [], hit: null, profile: null, language: 'de', flavorId: null, customFlavor: '',
  voiceMode: 'default', guestVoice: '', cloneFile: null, formality: 'sie',
  titleTouched: false, lastLlm: null, connectivity: {}, busy: false, current: null, archive: [], edits: {},
};

// ---------------------------------------------------------------------------
// Toast, Job-Leiste, Chips
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, kind = '', ms = 3500) { const t = $('toast'); t.textContent = msg; t.className = `toast ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }
function showJob(title) { $('jobbar').classList.remove('hidden'); $('jobTitle').textContent = title; $('jobFill').className = 'bar-fill indet'; $('jobFill').style.width = '0'; $('jobMeta').textContent = ''; $('jobLog').textContent = ''; }
function updateJob(job) {
  const p = job.progress;
  if (p && p.total) { $('jobFill').className = 'bar-fill'; $('jobFill').style.width = `${Math.round(p.done / p.total * 100)}%`; } else $('jobFill').className = 'bar-fill indet';
  const secs = Math.round(((job.finishedAt || job.now || Date.now()) - (job.startedAt || job.createdAt)) / 1000);
  let meta = p && p.label ? p.label : (job.status === 'queued' ? 'wartet' : 'läuft');
  if (job.status === 'queued' && job.position && job.position.ahead) meta += ` (${job.position.ahead} Lauf davor: ${job.position.aheadKind})`;
  $('jobMeta').textContent = `${meta} · ${secs}s`;
  $('jobLog').textContent = (job.log || []).join('\n');
  $('jobLog').scrollTop = $('jobLog').scrollHeight;
  if (job.llm) reportLlm(job.llm, job.status === 'running');
}
function hideJob() { setTimeout(() => $('jobbar').classList.add('hidden'), 1500); }
$('jobLogBtn').onclick = () => $('jobLog').classList.toggle('hidden');

const OFFLINE_MAX_MS = 5 * 60 * 1000;
const isOffline = (e) => e instanceof TypeError || /^HTTP 50[234]$/.test(String(e && e.message || ''));
async function pollJob(id, { title, onUpdate } = {}) {
  if (title) showJob(title);
  let offlineSince = null;
  for (;;) {
    let job;
    try { job = await api(`api/jobs/${id}`); offlineSince = null; }
    catch (e) {
      if (!isOffline(e)) throw e;
      offlineSince = offlineSince || Date.now();
      const waited = Math.round((Date.now() - offlineSince) / 1000);
      if (Date.now() - offlineSince > OFFLINE_MAX_MS) throw new Error(`Server seit ${waited} s nicht erreichbar`);
      $('jobFill').className = 'bar-fill indet'; $('jobMeta').textContent = `Server nicht erreichbar — warte auf Neustart (${waited} s)`;
      await new Promise((r) => setTimeout(r, 3000)); continue;
    }
    updateJob(job);
    if (onUpdate) onUpdate(job);
    if (job.status === 'done') { hideJob(); return job; }
    if (job.status === 'failed') { hideJob(); throw new Error(job.error || 'Job fehlgeschlagen'); }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const attachedJobs = new Set();
function attachVideoJob(jobId, root) {
  if (attachedJobs.has(jobId)) return;
  attachedJobs.add(jobId);
  pollJob(jobId, { title: 'Video produzieren' })
    .then((job) => toast(`Video fertig (${(job.result.video.bytes / 1048576).toFixed(1)} MB)`, 'ok', 6000))
    .catch((e) => toast(`Video: ${e.message}`, 'err', 10000))
    .finally(() => { attachedJobs.delete(jobId); if (!root || root.id === 'archive') loadArchive(); });
}
function reportLlm(llm, busy) {
  state.lastLlm = llm;
  $('modelText').textContent = `${LABEL[llm.provider] || llm.provider} · ${llm.model || '?'}${llm.fallback ? ' (Fallback)' : ''}`;
  $('modelLed').className = `led ${busy ? 'busy' : (llm.fallback ? 'warn' : 'ok')}`;
}
function updateModelChip() {
  if (state.lastLlm) { reportLlm(state.lastLlm, false); return; }
  const pref = state.config.preferredBackend || 'auto';
  if (pref !== 'auto') { $('modelText').textContent = `${LABEL[pref] || pref} (manuell)`; $('modelLed').className = 'led'; return; }
  const ready = state.llmStatus ? Object.entries(state.llmStatus.providers).filter(([, p]) => p.inAuto).map(([id]) => LABEL[id]) : [];
  $('modelText').textContent = ready.length ? `Auto — ${ready[0]}${ready.length > 1 ? ` (+${ready.length - 1})` : ''}` : 'Kein KI-Anbieter eingerichtet — ⚙';
  $('modelLed').className = ready.length ? 'led' : 'led fail';
}
function updateEngineChip() {
  const e = state.engine;
  if (!e) return;
  const gpu = e.omnivoice && e.omnivoice.available;
  $('engineText').textContent = !e.reachable ? (e.running ? 'Engine startet …' : 'Engine aus') : `${gpu ? 'OmniVoice' : 'Pocket TTS'} · ${gpu ? (e.omnivoice.loaded ? 'bereit' : 'Modell nicht geladen') : (e.pocket && e.pocket.available ? 'CPU' : 'fehlt')}`;
  $('engineLed').className = `led ${!e.reachable ? (e.running ? 'busy' : 'fail') : 'ok'}`;
}
function applyHostName() { document.querySelectorAll('.hostName').forEach((el) => { el.textContent = state.config.hostName || 'Host'; }); $('brandHost').textContent = state.config.hostName || 'Host'; $('brandName').textContent = state.config.showName || 'The Interview'; document.title = state.config.showName || 'The Interview'; }

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $('view-new').classList.toggle('hidden', t.dataset.tab !== 'new');
    $('view-archive').classList.toggle('hidden', t.dataset.tab !== 'archive');
    if (t.dataset.tab === 'archive') loadArchive();
  };
});
function unlock(n) { for (let i = 2; i <= 7; i++) $(`step${i}`).classList.toggle('locked', i > n); }

// ---------------------------------------------------------------------------
// Schritt 1–3
// ---------------------------------------------------------------------------
async function search() {
  const q = $('searchInput').value.trim();
  if (q.length < 2) return;
  $('searchBtn').disabled = true;
  $('hits').innerHTML = '<p class="muted">Suche in Wikipedia (de/en) …</p>';
  $('hitsEmpty').classList.add('hidden');
  try {
    const r = await api(`api/search?q=${encodeURIComponent(q)}`);
    state.hits = r.hits; state.hit = null;
    renderHits();
    if (!r.hits.length) { $('hitsEmpty').textContent = `Kein Treffer für „${q}“${r.errors.length ? ` (${r.errors.join('; ')})` : ''}. Beschreibe den Gast unten selbst oder gib einen Link an.`; $('hitsEmpty').classList.remove('hidden'); $('manualBox').open = true; if (!$('manualName').value) $('manualName').value = q; }
  } catch (e) { $('hits').innerHTML = ''; toast(`Suche fehlgeschlagen: ${e.message}`, 'err'); }
  $('searchBtn').disabled = false;
  updateResearchBtn();
}
function renderHits() {
  $('hits').innerHTML = state.hits.map((h, i) => `<div class="hit ${state.hit === i ? 'is-active' : ''}" data-i="${i}">${h.thumbnail ? `<img src="${esc(h.thumbnail)}" alt="">` : '<div class="noimg">👤</div>'}<div><div class="hit-lang">${esc(h.lang)} · Wikipedia</div><div class="hit-title">${esc(h.title)}</div><div class="hit-desc">${esc(h.description)}</div><div class="hit-extract">${esc(h.extract)}</div></div></div>`).join('');
  $('hits').querySelectorAll('.hit').forEach((el) => { el.onclick = () => { state.hit = Number(el.dataset.i); renderHits(); updateResearchBtn(); }; });
}
function updateResearchBtn() {
  const manual = $('manualUrl').value.trim() || $('manualText').value.trim().length >= 20;
  $('researchBtn').disabled = state.busy || !(state.hit != null || manual);
  $('researchHint').textContent = state.hit != null ? `Treffer: ${state.hits[state.hit].title}` : (manual ? 'eigene Beschreibung / Link' : '');
}
$('searchBtn').onclick = search;
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
['manualUrl', 'manualText'].forEach((id) => $(id).addEventListener('input', () => { if ($(id).value.trim()) { state.hit = null; renderHits(); } updateResearchBtn(); }));
$('researchBtn').onclick = async () => {
  const body = { name: $('manualName').value.trim() };
  if (state.hit != null) { body.hit = { title: state.hits[state.hit].title, lang: state.hits[state.hit].lang }; body.name = body.name || state.hits[state.hit].title; }
  else if ($('manualUrl').value.trim()) body.url = $('manualUrl').value.trim();
  else body.text = $('manualText').value.trim();
  state.busy = true; updateResearchBtn();
  try {
    const { jobId } = await post('api/research', body);
    const job = await pollJob(jobId, { title: 'Recherche' });
    state.profile = job.result.profile;
    state.design = null; $('designPanel').classList.add('hidden'); $('designName').value = ''; $('designStatus').textContent = '';
    renderProfile(); unlock(6); refreshTitle(true);
    toast(`Profil für ${state.profile.name} erstellt`, 'ok');
    $('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(`Recherche: ${e.message}`, 'err', 8000); }
  state.busy = false; updateResearchBtn();
};
function renderProfile() {
  const p = state.profile;
  const list = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">—</span>');
  const conf = { high: 'hoch', medium: 'mittel', low: 'niedrig' }[p.confidence] || p.confidence;
  $('profile').innerHTML = `
    <div class="pbox bio"><h4>${esc(p.name)} <span class="muted">· ${esc(p.kind)} · ${esc(p.era)}</span></h4><div>${esc(p.shortBio)}</div>
      <div class="conf">Quelle: ${esc(p.source ? p.source.kind : '?')}${p.source && p.source.url ? ` · <a href="${esc(p.source.url)}" target="_blank" rel="noopener">Link</a>` : ''} · Belastbarkeit: ${esc(conf)}</div></div>
    <div class="pbox"><h4>Bekannt für</h4>${list(p.knownFor)}</div>
    <div class="pbox"><h4>Sprechweise</h4><div>${esc(p.voiceAndManner) || '<span class="muted">—</span>'}</div></div>
    <div class="pbox"><h4>Fakten</h4>${list(p.facts)}</div>
    <div class="pbox"><h4>Haltungen &amp; Themen</h4>${list(p.opinionsAndThemes)}${p.controversies && p.controversies.length ? `<h4 style="margin-top:8px">Kontroversen</h4>${list(p.controversies)}` : ''}</div>`;
  $('guestName').value = p.name;
  $('themeChips').innerHTML = (p.suggestedThemes || []).map((t) => `<button class="chip" type="button">${esc(t)}</button>`).join('');
  $('themeChips').querySelectorAll('.chip').forEach((c) => { c.onclick = () => { $('themeInput').value = c.textContent; $('themeChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('is-active', x === c)); refreshTitle(); }; });
  updateDefaultVoiceLabel();
}
$('guestName').addEventListener('input', () => { if (state.profile) state.profile.name = $('guestName').value.trim(); refreshTitle(); });
$('themeInput').addEventListener('input', () => refreshTitle());
$('langPills').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { state.language = b.dataset.lang; $('langPills').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b)); $('formalityWrap').classList.toggle('hidden', state.language !== 'de'); updateDefaultVoiceLabel(); refreshTitle(); $('dAccentWrap').classList.toggle('hidden', state.language !== 'en'); state.designKey = null; $('designSaveBtn').disabled = true; };
});
$('formalityPills').querySelectorAll('button').forEach((b) => { b.onclick = () => { state.formality = b.dataset.formality; $('formalityPills').querySelectorAll('button').forEach((x) => x.classList.toggle('is-active', x === b)); }; });

// ---------------------------------------------------------------------------
// Schritt 4: Stimme
// ---------------------------------------------------------------------------
function updateDefaultVoiceLabel() { $('defaultVoiceName').textContent = `(${state.defaults[state.language] || '?'})`; }
function voiceOption(v, cur) { return `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.name)} (${esc(v.kind === 'catalog' ? 'Katalog' : v.lang)})</option>`; }
function renderVoices() {
  const opts = state.voices.map((v) => voiceOption(v, '')).join('');
  $('voiceSelect').innerHTML = opts;
  if (state.guestVoice) $('voiceSelect').value = state.guestVoice;
  $('cfgHostVoice').innerHTML = '<option value="">automatisch (erste Klonstimme, sonst Katalog)</option>' + opts;
  $('cfgGuestDe').innerHTML = '<option value="">Katalog (juergen)</option>' + opts; $('cfgGuestEn').innerHTML = '<option value="">Katalog (alba)</option>' + opts;
  $('hostVoiceName').textContent = state.host && state.host.voice ? state.host.voice : 'automatisch gewählter Stimme';
  updateDefaultVoiceLabel();
  const gpu = state.engine && state.engine.omnivoice && state.engine.omnivoice.available;
  $('designAvail').textContent = gpu ? '' : '— braucht OmniVoice (NVIDIA-GPU), hier nicht verfügbar';
  $('designMode').querySelector('input').disabled = !gpu;
}
document.querySelectorAll('input[name=vmode]').forEach((r) => {
  r.onchange = () => {
    state.voiceMode = r.value;
    $('voiceSelect').disabled = r.value !== 'library';
    $('cloneBox').classList.toggle('hidden', r.value !== 'clone');
    $('designBox').classList.toggle('hidden', r.value !== 'design');
    $('dAccentWrap').classList.toggle('hidden', state.language !== 'en');
    state.guestVoice = r.value === 'library' ? $('voiceSelect').value : (r.value === 'default' ? '' : state.guestVoice);
    if (r.value === 'design' && !state.design && state.profile) $('designSuggestBtn').click();
  };
});
state.design = null; state.designSeed = 7; state.designKey = null;
function designFromForm() {
  const d = { ...(state.design || {}), gender: $('dGender').value, age: $('dAge').value, pitch: $('dPitch').value, accent: state.language === 'en' ? ($('dAccent').value || null) : null, whisper: false };
  d.instruct = [d.gender, d.age, `${d.pitch} pitch`, d.accent ? `${d.accent} accent` : null].filter(Boolean).join(', ');
  return d;
}
function renderDesign(d) {
  $('designPanel').classList.remove('hidden');
  $('designRationale').textContent = `${d.rationale || ''} → ${d.instruct}`;
  $('dGender').value = d.gender; $('dAge').value = d.age; $('dPitch').value = d.pitch; $('dAccent').value = d.accent || '';
  $('dAccentWrap').classList.toggle('hidden', state.language !== 'en');
  const ss = d.speechStyle || {};
  $('speechStyle').innerHTML = `<h4>Sprechweise im Skript</h4><div><strong>Epoche:</strong> ${esc(ss.era || '–')}</div><div><strong>Herkunft:</strong> ${esc(ss.region || 'neutral')}</div><div><strong>Register:</strong> ${esc(ss.register || '–')}</div><div style="margin-top:4px">${(ss.expressions || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>${ss.avoid && ss.avoid.length ? `<div class="muted small">Sagt nie: ${esc(ss.avoid.join(', '))}</div>` : ''}${ss.sample ? `<div class="muted small" style="margin-top:4px">„${esc(ss.sample)}“</div>` : ''}`;
  if (!$('designName').value && state.profile) $('designName').value = `${state.profile.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)}_KI`;
  $('designSaveBtn').disabled = true; $('designPlayer').classList.add('hidden');
}
$('designSuggestBtn').onclick = async () => {
  if (!state.profile) { toast('Erst recherchieren', 'err'); return; }
  $('designSuggestBtn').disabled = true; $('designStatus').textContent = 'Vorschlag wird erzeugt …';
  try {
    const { jobId } = await post('api/voice-design/suggest', { profile: state.profile, language: state.language });
    const job = await pollJob(jobId, { title: 'Stimme entwerfen' });
    state.design = job.result.design; state.designSeed = 7; state.designKey = null;
    renderDesign(state.design);
    $('designStatus').textContent = 'Attribute anpassen, vorhören, übernehmen.';
  } catch (e) { $('designStatus').textContent = `Fehler: ${e.message}`; toast(e.message, 'err', 8000); }
  $('designSuggestBtn').disabled = false;
};
['dGender', 'dAge', 'dPitch', 'dAccent'].forEach((id) => $(id).addEventListener('change', () => { state.design = designFromForm(); $('designRationale').textContent = `${state.design.rationale || ''} → ${state.design.instruct}`; $('designSaveBtn').disabled = true; }));
async function designPreview() {
  const d = designFromForm(); state.design = d;
  $('designPreviewBtn').disabled = true; $('designDiceBtn').disabled = true; $('designStatus').textContent = 'OmniVoice spricht die Probe (ein paar Sekunden) …';
  try {
    const r = await fetch('api/voice-design/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruct: d.instruct, language: state.language, seed: state.designSeed }) });
    if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch { /* egal */ } throw new Error(m); }
    state.designKey = r.headers.get('x-design-key');
    $('designPlayer').src = URL.createObjectURL(await r.blob()); $('designPlayer').classList.remove('hidden'); $('designPlayer').play().catch(() => {});
    $('designSaveBtn').disabled = false;
    $('designStatus').textContent = `Probe (Variante ${state.designSeed}) — gefällt sie, „übernehmen“; sonst 🎲 oder Attribute ändern.`;
  } catch (e) { $('designStatus').textContent = `Fehler: ${e.message}`; toast(`Vorhören: ${e.message}`, 'err', 8000); }
  $('designPreviewBtn').disabled = false; $('designDiceBtn').disabled = false;
}
$('designPreviewBtn').onclick = designPreview;
$('designDiceBtn').onclick = () => { state.designSeed = Math.floor(Math.random() * 100000); designPreview(); };
$('designSaveBtn').onclick = async () => {
  const name = $('designName').value.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { toast('Name: nur Buchstaben, Ziffern, _ und -', 'err'); return; }
  const d = designFromForm();
  const run = (overwrite) => post('api/voice-design/save', { name, instruct: d.instruct, language: state.language, seed: state.designSeed, overwrite });
  $('designSaveBtn').disabled = true;
  try {
    let r;
    try { r = await run(false); } catch (e) { if (e.exists && confirm(`Die Stimme „${name}“ gibt es schon. Überschreiben?`)) r = await run(true); else throw e; }
    await pollJob(r.jobId, { title: `Stimme anlegen: ${name}` });
    try {
      $('designStatus').textContent = 'Referenzclip wird am Satzende geschnitten …';
      const fin = await post('api/voice-design/finalize', { name, language: state.language, refText: r.refText });
      $('designStatus').textContent = fin.recut ? `Referenzclip endet bei ${fin.endSec.toFixed(1)} s am Satzende: „${fin.text}“` : `Hinweis: ${fin.reason}`;
    } catch (e) { toast(`Feinschnitt: ${e.message}`, 'err', 6000); }
    await loadVoices();
    selectLibraryVoice(name); $('designBox').classList.add('hidden');
    $('designStatus').textContent += ` — Stimme „${name}“ ist als Gaststimme gewählt.`;
    toast(`Stimme ${name} angelegt`, 'ok');
  } catch (e) { $('designStatus').textContent = `Fehler: ${e.message}`; toast(`Übernehmen: ${e.message}`, 'err', 8000); $('designSaveBtn').disabled = false; }
};
function selectLibraryVoice(name) {
  state.guestVoice = name;
  document.querySelector('input[name=vmode][value=library]').checked = true;
  state.voiceMode = 'library'; $('voiceSelect').disabled = false; $('voiceSelect').value = name;
}
$('voiceSelect').onchange = () => { state.guestVoice = $('voiceSelect').value; };

// Upload / Mikrofon → Klon
const dz = $('dropzone');
dz.onclick = () => $('fileInput').click();
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) setCloneFile(e.dataTransfer.files[0]); });
$('fileInput').onchange = () => { if ($('fileInput').files[0]) setCloneFile($('fileInput').files[0]); };
function setCloneFile(f) {
  state.cloneFile = f;
  $('dzHeadline').textContent = `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`;
  if (!$('cloneName').value && state.profile) $('cloneName').value = state.profile.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  updateCloneBtn();
}
$('cloneName').addEventListener('input', updateCloneBtn);
function updateCloneBtn() { $('cloneBtn').disabled = !(state.cloneFile && /^[A-Za-z0-9_-]{1,40}$/.test($('cloneName').value.trim())); }

// Mikrofon (MediaRecorder): Aufnahme wird wie eine Datei behandelt.
let mic = { rec: null, chunks: [], timer: null, t0: 0 };
$('micBtn').onclick = async () => {
  if (mic.rec && mic.rec.state === 'recording') { mic.rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    mic.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mic.chunks = []; mic.t0 = Date.now();
    mic.rec.ondataavailable = (e) => { if (e.data.size) mic.chunks.push(e.data); };
    mic.rec.onstop = () => {
      clearInterval(mic.timer);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(mic.chunks, { type: mic.rec.mimeType || 'audio/webm' });
      const file = new File([blob], `aufnahme.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`, { type: blob.type });
      $('micPlayer').src = URL.createObjectURL(blob); $('micPlayer').classList.remove('hidden');
      $('micBtn').textContent = '● Neu aufnehmen';
      $('micTime').textContent = `${Math.round((Date.now() - mic.t0) / 1000)} s aufgenommen`;
      setCloneFile(file);
    };
    mic.rec.start(250);
    $('micBtn').textContent = '■ Aufnahme beenden';
    mic.timer = setInterval(() => { $('micTime').textContent = `${Math.round((Date.now() - mic.t0) / 1000)} s … (15–30 s reichen)`; }, 500);
  } catch (e) { toast(`Mikrofon: ${e.message}`, 'err', 6000); }
};
$('cloneBtn').onclick = async () => {
  const name = $('cloneName').value.trim();
  const run = async (overwrite) => api(`api/voices/clone?name=${encodeURIComponent(name)}&language=${encodeURIComponent($('cloneLang').value)}${overwrite ? '&overwrite=1' : ''}`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(state.cloneFile.name) }, body: state.cloneFile });
  $('cloneBtn').disabled = true; $('cloneStatus').textContent = 'Upload …';
  try {
    let r;
    try { r = await run(false); } catch (e) { if (e.exists && confirm(`Die Stimme „${name}“ gibt es schon. Überschreiben?`)) r = await run(true); else throw e; }
    const job = await pollJob(r.jobId, { title: `Stimme klonen: ${name}`, onUpdate: (j) => { $('cloneStatus').textContent = (j.log || []).slice(-1)[0] || j.status; } });
    await loadVoices();
    selectLibraryVoice(name); $('cloneBox').classList.add('hidden');
    $('cloneStatus').textContent = `Stimme „${name}“ ist geklont (${job.result && job.result.clipSeconds ? `${job.result.clipSeconds} s Clip` : 'fertig'}) und als Gaststimme gewählt.`;
    toast(`Stimme ${name} geklont`, 'ok');
  } catch (e) { $('cloneStatus').textContent = `Fehler: ${e.message}`; toast(`Klonen: ${e.message}`, 'err', 8000); }
  updateCloneBtn();
};

// ---------------------------------------------------------------------------
// Schritt 5–6
// ---------------------------------------------------------------------------
function renderFlavors() {
  $('flavors').innerHTML = state.flavors.map((f) => `<div class="flavor ${state.flavorId === f.id ? 'is-active' : ''}" data-id="${f.id}"><div class="fl-label">${esc(f.label)}</div><div class="fl-blurb">${esc(f.blurb)}</div></div>`).join('');
  $('flavors').querySelectorAll('.flavor').forEach((el) => { el.onclick = () => { state.flavorId = state.flavorId === el.dataset.id ? null : el.dataset.id; if (state.flavorId) { state.customFlavor = ''; $('customFlavor').value = ''; } renderFlavors(); refreshTitle(); updateGenerateBtn(); }; });
}
$('customFlavor').addEventListener('input', () => { state.customFlavor = $('customFlavor').value.trim(); if (state.customFlavor && state.flavorId) { state.flavorId = null; renderFlavors(); } refreshTitle(); updateGenerateBtn(); });
let titleTimer = null;
function refreshTitle(force) {
  if (!state.profile) return;
  if (state.titleTouched && !force) return;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    const qs = new URLSearchParams({ guest: state.profile.name, flavor: state.flavorId || '', custom: state.customFlavor || '', theme: $('themeInput').value.trim(), lang: state.language });
    try { const r = await api(`api/title?${qs}`); $('titleInput').value = r.title; state.titleTouched = false; } catch { /* egal */ }
  }, 150);
}
$('titleInput').addEventListener('input', () => { state.titleTouched = true; });
function updateDuration(fromSlider) {
  const min = Number($('durationRange').value);
  const lines = Math.max(6, Math.round(min * 4.3));
  if (fromSlider) $('partsInput').value = Math.min(6, Math.max(Math.ceil(min / 6), Math.ceil(lines / 18)));
  const parts = Math.max(Number($('partsInput').value) || 1, Math.ceil(lines / 18));
  $('durationLabel').textContent = `${min} Minuten`;
  $('durationEst').textContent = `≈ ${lines} Zeilen in ${parts} Teil${parts === 1 ? '' : 'en'}`;
}
$('durationRange').addEventListener('input', () => updateDuration(true));
$('partsInput').addEventListener('input', () => updateDuration(false));
$('titleResetBtn').onclick = () => refreshTitle(true);
function updateGenerateBtn() {
  const ok = state.profile && (state.flavorId || state.customFlavor);
  $('generateBtn').disabled = !ok || state.busy;
  $('generateHint').textContent = ok ? '' : 'Flavor wählen oder beschreiben';
}
$('generateBtn').onclick = async () => {
  const profile = { ...state.profile };
  if (state.design && $('speechStyleUse').checked) profile.voiceDesign = state.design; else delete profile.voiceDesign;
  const body = {
    profile, language: state.language, formality: state.formality, flavorId: state.flavorId, customFlavor: state.customFlavor,
    theme: $('themeInput').value.trim(), title: $('titleInput').value.trim(), parts: Number($('partsInput').value) || 2, durationMin: Number($('durationRange').value) || 8,
    guestVoice: state.voiceMode === 'library' ? state.guestVoice : '', autoAudio: $('autoAudio').checked, disclaimer: $('disclaimerCheck').checked,
  };
  state.busy = true; updateGenerateBtn(); unlock(7);
  $('result').innerHTML = '<p class="muted">Skript wird geschrieben …</p>';
  $('step7').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const { jobId } = await post('api/generate', body);
    const job = await pollJob(jobId, { title: 'Skript schreiben' });
    state.current = job.result.interview;
    renderResult(state.current, { audioJobId: job.result.audioJobId });
    toast('Skript fertig', 'ok');
    if (job.result.audioJobId) {
      const aj = await pollJob(job.result.audioJobId, { title: 'Vertonung', onUpdate: (j) => renderAudioProgress(j) });
      state.current = aj.result.interview; renderResult(state.current); toast('Audio fertig', 'ok');
    }
  } catch (e) { toast(`Generieren: ${e.message}`, 'err', 10000); $('result').insertAdjacentHTML('afterbegin', `<p class="notice">Fehler: ${esc(e.message)}</p>`); }
  state.busy = false; updateGenerateBtn();
};
function renderAudioProgress(job) { const el = $('audioProgress'); if (!el) return; const p = job.progress; el.textContent = p && p.total ? `Vertonung: ${p.done}/${p.total} Zeilen …` : 'Vertonung startet …'; }

// ---------------------------------------------------------------------------
// Ergebnis / Skript-Editor
// ---------------------------------------------------------------------------
function editsFor(id) { return state.edits[id] || (state.edits[id] = {}); }
function hostOf(iv) { return iv.hostName || state.config.hostName || 'Host'; }
function scriptHtml(iv) {
  if (!iv.script) return '<p class="muted">Kein Skript.</p>';
  const ed = editsFor(iv.id);
  return `<p class="hint-edit">Doppelklick auf eine Zeile zum Bearbeiten — nur geänderte Zeilen werden danach neu gesprochen.</p><div class="script" data-iv="${iv.id}">${iv.script.parts.map((p, pi) => `<div class="part"><h4>${pi + 1}. ${esc(p.partTitle)}</h4>${p.lines.map((l, li) => { const k = `${pi}:${li}`; const t = k in ed ? ed[k] : l.text; return `<div class="line ${l.speaker === 'Host' ? 'host' : 'guest'} ${k in ed ? 'dirty' : ''}" data-part="${pi}" data-index="${li}"><span class="who">${esc(l.speaker === 'Host' ? hostOf(iv) : iv.guest.name)}</span><span class="txt" title="Doppelklick: bearbeiten">${esc(t)}</span></div>`; }).join('')}</div>`).join('')}</div>`;
}
function editbarHtml(iv) {
  const n = Object.keys(editsFor(iv.id)).length;
  if (!n) return '';
  return `<div class="editbar"><strong>${n} geänderte Zeile${n === 1 ? '' : 'n'}</strong><button class="btn primary small" data-apply-edits="${iv.id}">${iv.hasAudio ? '🔊 Geänderte Zeilen neu sprechen' : 'Änderungen speichern'}</button><button class="btn ghost small" data-discard-edits="${iv.id}">Verwerfen</button></div>`;
}
function voiceOptionsHtml(current) {
  if (!state.voices.length) return `<option value="${esc(current || '')}" disabled selected>Stimmen werden geladen …</option>`;
  const known = state.voices.some((v) => v.name === current);
  const missing = current && !known ? `<option value="${esc(current)}" selected>${esc(current)} (nicht mehr in der Bibliothek)</option>` : '';
  return missing + state.voices.map((v) => voiceOption(v, current)).join('');
}
function refreshVoiceSelects() { document.querySelectorAll('select[data-voice-select]').forEach((sel) => { const cur = sel.value; sel.innerHTML = voiceOptionsHtml(cur); if (cur && state.voices.some((v) => v.name === cur)) sel.value = cur; }); }
function voicebarHtml(iv) {
  if (!iv.script) return '';
  return `<div class="voicebar"><span class="muted small">Gaststimme</span><select data-voice-select="${iv.id}">${voiceOptionsHtml(iv.guest.voice)}</select><button class="btn small" data-revoice="${iv.id}" title="Skript bleibt, nur die Zeilen des Gastes werden neu gesprochen">🔁 Mit dieser Stimme neu vertonen</button><button class="btn ghost small" data-render-speaker="${iv.id}" title="Nur die Zeilen des Gastes neu sprechen (gleiche Stimme)">Gast-Zeilen neu sprechen</button><button class="btn ghost small" data-audit="${iv.id}" title="Alle Zeilen mit Whisper nachhören; Zeilen mit Versprechern werden neu gesprochen">🔎 Aussprache prüfen</button><button class="btn ghost small" data-render-full="${iv.id}" title="Alle Zeilen neu sprechen">Komplett neu vertonen</button></div>`;
}
function bindEditing(root, getIv, refresh) {
  root.querySelectorAll('.line .txt').forEach((span) => {
    span.ondblclick = () => {
      const lineEl = span.closest('.line');
      if (lineEl.querySelector('textarea')) return;
      const iv = getIv(lineEl.closest('.script').dataset.iv);
      const pi = Number(lineEl.dataset.part), li = Number(lineEl.dataset.index);
      const k = `${pi}:${li}`;
      const ed = editsFor(iv.id);
      const cur = k in ed ? ed[k] : iv.script.parts[pi].lines[li].text;
      span.hidden = true;
      const box = document.createElement('div');
      box.innerHTML = `<textarea>${esc(cur)}</textarea><div class="edit-actions"><button class="btn small primary">Übernehmen <kbd>⏎</kbd></button><button class="btn small ghost">Abbrechen <kbd>Esc</kbd></button></div>`;
      lineEl.appendChild(box);
      const ta = box.querySelector('textarea'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      const close = () => { box.remove(); span.hidden = false; };
      const commit = () => { const text = ta.value.replace(/\s+/g, ' ').trim(); if (!text) { toast('Eine Zeile darf nicht leer sein', 'err'); return; } if (text === iv.script.parts[pi].lines[li].text) delete ed[k]; else ed[k] = text; close(); refresh(); };
      box.querySelectorAll('button')[0].onclick = commit;
      box.querySelectorAll('button')[1].onclick = close;
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } if (e.key === 'Escape') close(); });
    };
  });
  root.querySelectorAll('[data-discard-edits]').forEach((b) => { b.onclick = () => { state.edits[b.dataset.discardEdits] = {}; refresh(); }; });
  root.querySelectorAll('[data-apply-edits]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.applyEdits;
      const changes = Object.entries(editsFor(id)).map(([k, text]) => ({ part: Number(k.split(':')[0]), index: Number(k.split(':')[1]), text }));
      b.disabled = true;
      try {
        const r = await post(`api/interviews/${id}/lines`, { changes });
        state.edits[id] = {};
        if (r.jobId) { toast(`${r.changed} Zeile(n) gespeichert — werden neu gesprochen`, 'ok'); const job = await pollJob(r.jobId, { title: 'Zeilen neu sprechen' }); toast('Audio aktualisiert', 'ok'); refresh(job.result.interview); }
        else { toast('Änderungen gespeichert', 'ok'); refresh(r.interview); }
      } catch (e) { toast(`Änderung: ${e.message}`, 'err', 8000); b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-audit]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { const { jobId } = await post(`api/interviews/${b.dataset.audit}/audit`); const job = await pollJob(jobId, { title: 'Aussprache prüfen' }); toast(job.result.bad.length ? `${job.result.bad.length} Zeile(n) neu gesprochen` : 'Alle Zeilen sauber', 'ok', 6000); refresh(job.result.interview); }
      catch (e) { toast(`Prüfung: ${e.message}`, 'err', 8000); b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-revoice], [data-render-full], [data-render-speaker]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.revoice || b.dataset.renderFull || b.dataset.renderSpeaker;
      const sel = root.querySelector(`[data-voice-select="${id}"]`);
      const body = { guestVoice: sel ? sel.value : undefined, full: Boolean(b.dataset.renderFull), speaker: b.dataset.renderSpeaker ? 'Guest' : undefined };
      b.disabled = true;
      try {
        const r = await post(`api/interviews/${id}/render`, body);
        if (r.unchanged) { toast('Stimme ist schon gewählt — nichts zu tun', 'ok'); b.disabled = false; return; }
        toast(r.partial ? `${r.lines} Zeilen werden neu gesprochen` : 'Komplett-Vertonung läuft', 'ok');
        const job = await pollJob(r.jobId, { title: r.partial ? 'Stimme wechseln' : 'Vertonung' });
        toast('Audio fertig', 'ok'); refresh(job.result.interview);
      } catch (e) { toast(`Vertonung: ${e.message}`, 'err', 8000); b.disabled = false; }
    };
  });
}
function audioHtml(iv) {
  if (!iv.hasAudio) return '';
  const a = iv.audio || {};
  const eng = a.engines ? `OmniVoice ${a.engines.omnivoice} · Pocket ${a.engines.pocket} Zeilen` : '';
  return `<audio class="player" controls preload="none" src="api/interviews/${iv.id}/audio?t=${a.renderedAt || 0}"></audio>
    <div class="row wrap-row"><a class="btn" href="api/interviews/${iv.id}/download">⬇ MP3 herunterladen</a><a class="btn ghost" href="api/interviews/${iv.id}/wav">WAV</a><a class="btn ghost" href="api/interviews/${iv.id}/script">Skript als Text</a><span class="muted small">${Math.round(a.durationSec || 0)} s · ${esc(eng)}${a.substituted && a.substituted.length ? ` · <span class="badge warn">Ersatzstimme: ${esc(a.substituted.join(', '))}</span>` : ''}</span></div>`;
}
function renderResult(iv, { audioJobId } = {}) {
  const badges = [`<span class="badge">${iv.language === 'de' ? 'Deutsch' : 'English'}</span>`, `<span class="badge">${esc(iv.flavorLabel || 'eigener Flavor')}</span>`, `<span class="badge">Gast: ${esc(iv.guest.voice)}</span>`, `<span class="badge">${esc(hostOf(iv))}: ${esc(iv.hostVoice)}</span>`];
  if (iv.llm) badges.push(`<span class="badge ${iv.llm.fallback ? 'warn' : 'ok'}">${esc(LABEL[iv.llm.provider] || iv.llm.provider)} · ${esc(iv.llm.model)}</span>`);
  $('result').innerHTML = `<div class="result-head"><span class="title">${esc(iv.title)}</span>${badges.join('')}</div>
    ${iv.hasAudio ? audioHtml(iv) : (audioJobId ? '<p id="audioProgress" class="muted">Vertonung startet …</p>' : `<div class="row"><button class="btn" data-render="${iv.id}">🔊 Audio erzeugen</button></div>`)}
    ${audioJobId ? '' : voicebarHtml(iv)}${editbarHtml(iv)}${scriptHtml(iv)}`;
  bindItemButtons($('result'));
  bindEditing($('result'), () => state.current, (updated) => { if (updated) state.current = updated; renderResult(state.current); });
}

// ---------------------------------------------------------------------------
// Archiv
// ---------------------------------------------------------------------------
async function loadArchive() { const r = await api('api/interviews'); state.archive = r.interviews; $('archiveCount').textContent = r.interviews.length; renderArchive(); }
function renderArchive() {
  $('archiveEmpty').classList.toggle('hidden', state.archive.length > 0);
  $('archive').innerHTML = state.archive.map((iv, i) => {
    const a = iv.audio || {};
    return `<div class="aitem" draggable="true" data-id="${iv.id}">
      <div class="aitem-head"><span class="handle" title="ziehen zum Verschieben">⋮⋮</span><span class="atitle" data-title="${iv.id}">${esc(iv.title)}</span>
        <button class="btn small ghost" data-rename="${iv.id}" title="umbenennen">✎</button><button class="btn small ghost" data-up="${iv.id}" ${i === 0 ? 'disabled' : ''} title="nach oben">↑</button><button class="btn small ghost" data-down="${iv.id}" ${i === state.archive.length - 1 ? 'disabled' : ''} title="nach unten">↓</button><button class="btn small ghost danger" data-delete="${iv.id}" title="löschen">🗑</button></div>
      <div class="aitem-meta">${esc(iv.guest.name)} · ${iv.language === 'de' ? `Deutsch (${iv.formality === 'du' ? 'Du' : 'Sie'})` : 'English'} · ${esc(iv.flavorLabel || 'eigener Flavor')} · ${iv.parts} Teil(e), ${iv.lines} Zeilen${iv.durationMin ? ` · Ziel ${iv.durationMin} min` : ''} · ${new Date(iv.createdAt).toLocaleString('de-DE')}${iv.hasAudio ? ` · ${Math.round(a.durationSec || 0)} s` : ' · <span class="badge warn">kein Audio</span>'}${iv.hasVideo ? ' · <span class="badge ok">🎬 Video</span>' : ''}${iv.llm ? ` · ${esc(LABEL[iv.llm.provider] || iv.llm.provider)}` : ''}</div>
      ${iv.hasAudio ? `<audio class="player" controls preload="none" src="api/interviews/${iv.id}/audio?t=${a.renderedAt || 0}"></audio>` : ''}
      <div class="aitem-actions">
        ${iv.hasAudio ? `<a class="btn small" href="api/interviews/${iv.id}/download">⬇ MP3</a>${iv.videoJobId ? `<button class="btn small ghost" data-video="${iv.id}" data-video-job="${iv.videoJobId}" disabled>🎬 Video wird produziert …</button>` : iv.hasVideo ? `<a class="btn small" href="api/interviews/${iv.id}/video?download=1">⬇ MP4-Video</a><a class="btn small ghost" href="api/interviews/${iv.id}/video" target="_blank" rel="noopener">▶ Video ansehen</a><button class="btn small ghost" data-video="${iv.id}" title="Video mit dem aktuellen Audio neu rendern">🎬 Video neu produzieren</button>` : `<button class="btn small ghost" data-video="${iv.id}" title="MP4: Wellenform, Logo, mitlaufender Text">🎬 Video produzieren</button>`}` : `<button class="btn small" data-render="${iv.id}">🔊 Audio erzeugen</button>`}
        <a class="btn small ghost" href="api/interviews/${iv.id}/script">Skript als Text</a>
        <button class="btn small ghost" data-script="${iv.id}">Skript anzeigen</button>
        <button class="btn small ghost" data-regenerate="${iv.id}" title="Neues Skript und Audio mit denselben Einstellungen als neuer Archiv-Eintrag">↻ Neu generieren</button>
      </div>
      <div class="script-slot"></div>
    </div>`;
  }).join('');
  bindItemButtons($('archive'));
  $('archive').querySelectorAll('[data-rename]').forEach((b) => { b.onclick = () => startRename(b.dataset.rename); });
  $('archive').querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => move(b.dataset.up, -1); });
  $('archive').querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => move(b.dataset.down, 1); });
  $('archive').querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      const iv = state.archive.find((x) => x.id === b.dataset.delete);
      if (!confirm(`„${iv.title}“ wirklich löschen? (wandert in den Papierkorb unter work/trash)`)) return;
      try { await api(`api/interviews/${iv.id}`, { method: 'DELETE' }); toast('Gelöscht', 'ok'); await loadArchive(); } catch (e) { toast(e.message, 'err'); }
    };
  });
  $('archive').querySelectorAll('[data-script]').forEach((b) => {
    b.onclick = async () => {
      const item = b.closest('.aitem');
      if (item.classList.contains('open')) { item.classList.remove('open'); b.textContent = 'Skript anzeigen'; return; }
      const slot = item.querySelector('.script-slot');
      const show = async (ivIn) => {
        const iv = ivIn || await api(`api/interviews/${b.dataset.script}`);
        state.archiveFull = state.archiveFull || {}; state.archiveFull[iv.id] = iv;
        slot.innerHTML = voicebarHtml(iv) + editbarHtml(iv) + scriptHtml(iv);
        bindEditing(slot, (id) => state.archiveFull[id], (updated) => { if (updated) loadArchive(); show(updated || null); });
      };
      await show();
      item.classList.add('open'); b.textContent = 'Skript ausblenden';
    };
  });
  $('archive').querySelectorAll('[data-regenerate]').forEach((b) => {
    b.onclick = async () => {
      const iv = state.archive.find((x) => x.id === b.dataset.regenerate);
      if (!confirm(`„${iv.title}“ neu generieren?\n\nGleiche Einstellungen, neues Skript, neues Audio — als neuer Eintrag. Das Original bleibt.`)) return;
      b.disabled = true;
      try {
        const { jobId } = await post(`api/interviews/${iv.id}/regenerate`);
        document.querySelector('.tab[data-tab=new]').click(); unlock(7);
        $('result').innerHTML = '<p class="muted">Skript wird neu geschrieben …</p>'; $('step7').scrollIntoView({ behavior: 'smooth', block: 'start' });
        const job = await pollJob(jobId, { title: 'Neu generieren' });
        state.current = job.result.interview; renderResult(state.current, { audioJobId: job.result.audioJobId });
        if (job.result.audioJobId) { const aj = await pollJob(job.result.audioJobId, { title: 'Vertonung', onUpdate: (j) => renderAudioProgress(j) }); state.current = aj.result.interview; renderResult(state.current); }
        toast('Neu generiert', 'ok'); loadArchive();
      } catch (e) { toast(`Neu generieren: ${e.message}`, 'err', 10000); }
      b.disabled = false;
    };
  });
  let dragId = null;
  $('archive').querySelectorAll('.aitem').forEach((el) => {
    el.addEventListener('dragstart', (e) => { dragId = el.dataset.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $('archive').querySelectorAll('.dragover').forEach((x) => x.classList.remove('dragover')); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', async (e) => { e.preventDefault(); el.classList.remove('dragover'); if (!dragId || dragId === el.dataset.id) return; const ids = state.archive.map((x) => x.id); const from = ids.indexOf(dragId); const to = ids.indexOf(el.dataset.id); ids.splice(from, 1); ids.splice(to, 0, dragId); await saveOrder(ids); });
  });
}
function bindItemButtons(root) {
  root.querySelectorAll('[data-render]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { const { jobId } = await post(`api/interviews/${b.dataset.render}/render`); const job = await pollJob(jobId, { title: 'Vertonung' }); toast('Audio fertig', 'ok'); if (root.id === 'archive') loadArchive(); else { state.current = job.result.interview; renderResult(state.current); } }
      catch (e) { toast(`Vertonung: ${e.message}`, 'err', 8000); b.disabled = false; }
    };
  });
  root.querySelectorAll('[data-video]').forEach((b) => {
    if (b.dataset.videoJob) { attachVideoJob(b.dataset.videoJob, root); return; }
    b.onclick = async () => {
      b.disabled = true;
      try { const { jobId, existing } = await post(`api/interviews/${b.dataset.video}/video`); toast(existing ? 'Video wird schon gerendert — Fortschritt unten' : 'Video wird gerendert — Fortschritt unten', 'ok'); const job = await pollJob(jobId, { title: 'Video produzieren' }); toast(`Video fertig (${(job.result.video.bytes / 1048576).toFixed(1)} MB)`, 'ok', 6000); if (root.id === 'archive') loadArchive(); }
      catch (e) { toast(`Video: ${e.message}`, 'err', 10000); b.disabled = false; }
    };
  });
}
function startRename(id) {
  const span = $('archive').querySelector(`[data-title="${id}"]`);
  const iv = state.archive.find((x) => x.id === id);
  span.innerHTML = `<input type="text" maxlength="120" value="${esc(iv.title)}">`;
  const input = span.querySelector('input'); input.focus(); input.select();
  const commit = async () => { const title = input.value.trim(); if (!title || title === iv.title) { renderArchive(); return; } try { await api(`api/interviews/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }); toast('Umbenannt', 'ok'); } catch (e) { toast(e.message, 'err'); } await loadArchive(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderArchive(); });
  input.addEventListener('blur', commit);
}
async function move(id, dir) { const ids = state.archive.map((x) => x.id); const i = ids.indexOf(id); const j = i + dir; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await saveOrder(ids); }
async function saveOrder(ids) { try { await post('api/interviews/reorder', { ids }); await loadArchive(); } catch (e) { toast(e.message, 'err'); } }

// ---------------------------------------------------------------------------
// Einstellungen: Provider-Karten mit Keys, Modellen, Reihenfolge
// ---------------------------------------------------------------------------
function ledClass(r) { if (!r) return ''; if (r.pending) return 'busy'; if (r.ok) return 'ok'; return r.errorKind === 'quota' ? 'warn' : 'fail'; }
function renderBackends() {
  const pref = state.config.preferredBackend || 'auto';
  const order = (state.config.providerOrder || []).filter((id) => LABEL[id]);
  for (const p of PROVIDERS) if (!order.includes(p.id)) order.push(p.id);
  const enabled = state.config.providerEnabled || {};
  const models = state.config.providerModels || {};
  const sec = (state.secrets && state.secrets.keys) || {};
  const st = (state.llmStatus && state.llmStatus.providers) || {};
  const autoActive = pref === 'auto';
  const auto = `<label class="backend ${autoActive ? 'is-active' : ''}"><input type="radio" name="backend" value="auto" ${autoActive ? 'checked' : ''}><div class="backend-main"><div class="backend-name">Auto<span class="rec-badge">Empfohlen</span></div><div class="backend-desc">Erster eingerichteter Anbieter in der Reihenfolge unten; fällt bei Quota oder Login-Problemen weiter.</div></div></label>`;
  const cards = order.map((id, i) => {
    const p = PROVIDERS.find((x) => x.id === id);
    const r = state.connectivity[id];
    const s = st[id] || {};
    const status = r ? `${r.pending ? 'wird geprüft…' : (r.detail || r.error || (r.ok ? 'erreichbar' : 'nicht erreichbar'))}${r.latencyMs && !r.pending ? ` · ${r.latencyMs} ms` : ''}` : (s.configured ? 'eingerichtet, noch nicht geprüft' : 'nicht eingerichtet');
    const keyRow = p.key ? `<div class="key-row"><input type="password" data-key="${p.key}" placeholder="${sec[p.key] && sec[p.key].present ? `Key hinterlegt (${esc(sec[p.key].masked)}${sec[p.key].source && sec[p.key].source.startsWith('env') ? ', aus Umgebung' : ''}) — neuen eingeben zum Ersetzen` : (id === 'local' ? 'API-Key (nur falls der Server einen verlangt)' : 'API-Key eingeben')}" autocomplete="off"><button type="button" class="btn small" data-save-key="${p.key}">Key speichern</button>${sec[p.key] && sec[p.key].present && sec[p.key].source === 'stored' ? `<button type="button" class="btn small ghost" data-clear-key="${p.key}">löschen</button>` : ''}</div>` : '';
    const modelList = (r && r.models) || [];
    const modelRow = id === 'local'
      ? `<div class="key-row"><input type="text" data-local-url value="${esc(state.config.localUrl || '')}" placeholder="http://127.0.0.1:1234/v1"><input type="text" data-model="${id}" list="models-${id}" value="${esc(models[id] || '')}" placeholder="Modell (leer = erstes geladene)"><datalist id="models-${id}">${modelList.map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>`
      : `<div class="key-row"><input type="text" data-model="${id}" list="models-${id}" value="${esc(models[id] || '')}" placeholder="Modell (leer = ${esc(s.model || 'Vorgabe')})"><datalist id="models-${id}">${modelList.map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>`;
    return `<div class="backend ${pref === id ? 'is-active' : ''}" data-provider="${id}">
      <input type="radio" name="backend" value="${id}" ${pref === id ? 'checked' : ''} title="Nur diesen Anbieter (kein Fallback)">
      <div class="backend-main">
        <div class="backend-name">${i + 1}. ${esc(p.name)} <label class="inline-check" title="In der Auto-Kette berücksichtigen"><input type="checkbox" data-enabled="${id}" ${enabled[id] === false ? '' : 'checked'}> in Auto</label></div>
        <div class="backend-desc">${esc(p.desc)}</div>
        ${keyRow}${modelRow}
        <div class="backend-status"><span class="led ${ledClass(r)}"></span><span>${esc(status)}</span></div>
      </div>
      <div class="backend-btns"><button type="button" data-check="${id}" data-depth="cheap">Test now</button><button type="button" data-check="${id}" data-depth="deep">Deep test</button><button type="button" data-move="${id}" data-dir="-1" title="früher in der Kette">▲</button><button type="button" data-move="${id}" data-dir="1" title="später in der Kette">▼</button></div>
    </div>`;
  }).join('');
  $('backends').innerHTML = auto + cards;
  $('backends').querySelectorAll('input[name=backend]').forEach((input) => { input.onchange = async () => { await saveConfig({ preferredBackend: input.value }); renderBackends(); confirmBackendChoice(input.value); }; });
  $('backends').querySelectorAll('button[data-check]').forEach((btn) => { btn.onclick = (e) => { e.preventDefault(); runCheck(btn.dataset.check, btn.dataset.depth); }; });
  $('backends').querySelectorAll('button[data-move]').forEach((btn) => {
    btn.onclick = async () => { const o = order.slice(); const i = o.indexOf(btn.dataset.move); const j = i + Number(btn.dataset.dir); if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; await saveConfig({ providerOrder: o }); renderBackends(); };
  });
  $('backends').querySelectorAll('input[data-enabled]').forEach((cb) => { cb.onchange = async () => { await saveConfig({ providerEnabled: { ...(state.config.providerEnabled || {}), [cb.dataset.enabled]: cb.checked } }); await loadLlmStatus(); renderBackends(); }; });
  $('backends').querySelectorAll('button[data-save-key]').forEach((btn) => {
    btn.onclick = async () => {
      const input = $('backends').querySelector(`input[data-key="${btn.dataset.saveKey}"]`);
      const value = input.value.trim();
      if (!value) { toast('Kein Key eingegeben', 'err'); return; }
      try { state.secrets = await api('api/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: btn.dataset.saveKey, value }) }); input.value = ''; toast('Key verschlüsselt gespeichert', 'ok'); await loadLlmStatus(); renderBackends(); runCheck(btn.closest('[data-provider]').dataset.provider, 'cheap'); }
      catch (e) { toast(`Key: ${e.message}`, 'err', 6000); }
    };
  });
  $('backends').querySelectorAll('button[data-clear-key]').forEach((btn) => {
    btn.onclick = async () => { if (!confirm('Key wirklich löschen?')) return; state.secrets = await api('api/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: btn.dataset.clearKey, value: '' }) }); await loadLlmStatus(); renderBackends(); };
  });
  $('backends').querySelectorAll('input[data-model]').forEach((inp) => { inp.onchange = async () => { await saveConfig({ providerModels: { ...(state.config.providerModels || {}), [inp.dataset.model]: inp.value.trim() } }); }; });
  const lu = $('backends').querySelector('input[data-local-url]');
  if (lu) lu.onchange = async () => { await saveConfig({ localUrl: lu.value.trim() }); runCheck('local', 'cheap'); };
}
function confirmBackendChoice(id) {
  const banner = $('backendBanner');
  banner.classList.remove('hidden');
  const r = state.connectivity[id];
  if (id !== 'auto' && r && !r.ok && !r.pending) banner.textContent = `⚠ ${LABEL[id]} aktiviert — aber gerade nicht erreichbar: ${r.detail || r.error || ''}. Trotzdem aktiv, kein Fallback.`;
  else banner.textContent = `✓ ${id === 'auto' ? 'Auto' : LABEL[id]} aktiviert${id === 'auto' ? ' — volle Fallback-Kette' : ' — kein automatischer Fallback'}`;
  state.lastLlm = null; updateModelChip();
}
async function runCheck(provider, depth) {
  state.connectivity[provider] = { pending: true }; renderBackends();
  try { const r = await api(`api/llm/connectivity?provider=${encodeURIComponent(provider)}&depth=${depth}`); state.connectivity[provider] = { ...r, checkedAt: Date.now() }; }
  catch (e) { state.connectivity[provider] = { ok: false, detail: e.message, checkedAt: Date.now() }; }
  renderBackends();
}
function checkAll(depth) { const st = (state.llmStatus && state.llmStatus.providers) || {}; PROVIDERS.forEach((p) => { if (!st[p.id] || st[p.id].configured) runCheck(p.id, depth); }); }
async function saveConfig(patch) { state.config = await api('api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); applyHostName(); }
async function loadLlmStatus() { try { const r = await api('api/llm/status'); state.llmStatus = r.status; } catch { /* egal */ } updateModelChip(); }
function renderEngineBox() {
  const e = state.engine;
  if (!e) return;
  const rows = [];
  rows.push(`Gerät: <strong>${esc(e.device || (e.running ? 'startet …' : 'aus'))}</strong>${e.reachable ? '' : ' — Engine nicht erreichbar'}`);
  if (e.omnivoice) rows.push(`OmniVoice (GPU, Klon + Design): ${e.omnivoice.available ? (e.omnivoice.loaded ? 'geladen' : 'verfügbar, nicht geladen') : 'nicht verfügbar (keine CUDA-GPU)'}${e.omnivoice.error ? ` — ${esc(e.omnivoice.error)}` : ''}`);
  if (e.pocket) rows.push(`Pocket TTS (CPU): ${e.pocket.available ? `bereit${e.pocket.loaded && e.pocket.loaded.length ? ` (${e.pocket.loaded.join(', ')})` : ''}` : 'nicht installiert'}`);
  if (e.asr) rows.push(`Whisper (Klon-Schnitt, Aussprache-Riegel): ${e.asr.available ? `${e.asr.backend} · ${e.asr.model}${e.asr.loaded ? ' (geladen)' : ''}` : 'nicht installiert'}`);
  const hf = state.secrets && state.secrets.keys && state.secrets.keys.hf;
  const cpuOnly = e.pocket && e.pocket.available && !(e.omnivoice && e.omnivoice.available);
  if (cpuOnly) rows.push(`Stimmen klonen mit Pocket TTS: ${e.pocket.cloning === false ? '<span class="badge warn">gesperrt</span> — die Klon-Gewichte sind bei Hugging Face freigabepflichtig' : e.pocket.cloning === true ? '<span class="badge ok">frei</span>' : 'wird beim ersten Sprechen geprüft'}. Kostenloses Konto anlegen, auf <a href="https://huggingface.co/kyutai/pocket-tts" target="_blank" rel="noopener">huggingface.co/kyutai/pocket-tts</a> die Bedingungen akzeptieren, dann einen Token (Lesen) hier eintragen:`);
  $('engineBox').innerHTML = rows.map((r) => `<div>${r}</div>`).join('') + (cpuOnly ? `<div class="key-row"><input type="password" id="hfTokenInput" placeholder="${hf && hf.present ? `Token hinterlegt (${esc(hf.masked)}) — neuen eingeben zum Ersetzen` : 'Hugging-Face-Token (hf_…)'}" autocomplete="off"><button class="btn small" id="hfTokenSave">Token speichern</button>${hf && hf.present && hf.source === 'stored' ? '<button class="btn small ghost" id="hfTokenClear">löschen</button>' : ''}</div>` : '') + `<div class="row" style="margin-top:8px"><button class="btn small" id="engineStartBtn">Engine ${e.reachable ? 'neu starten' : 'starten'}</button>${e.omnivoice && e.omnivoice.available && !e.omnivoice.loaded ? '<button class="btn small ghost" id="engineLoadBtn">OmniVoice laden</button>' : ''}</div>`;
  const hs = $('hfTokenSave'); if (hs) hs.onclick = async () => { const v = $('hfTokenInput').value.trim(); if (!v) { toast('Kein Token eingegeben', 'err'); return; } try { state.secrets = await api('api/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'hf', value: v }) }); toast('Token verschlüsselt gespeichert — Engine startet neu', 'ok', 6000); setTimeout(async () => { await loadVoices(); renderEngineBox(); }, 6000); } catch (err) { toast(`Token: ${err.message}`, 'err', 6000); } };
  const hc = $('hfTokenClear'); if (hc) hc.onclick = async () => { state.secrets = await api('api/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'hf', value: '' }) }); renderEngineBox(); };
  $('engineStartBtn').onclick = async () => { try { if (e.reachable) await post('api/engine/stop'); await post('api/engine/start'); toast('Engine läuft', 'ok'); } catch (err) { toast(`Engine: ${err.message}`, 'err', 8000); } await loadVoices(); renderEngineBox(); };
  const lb = $('engineLoadBtn'); if (lb) lb.onclick = async () => { lb.disabled = true; try { await post('api/engine/load'); toast('OmniVoice geladen', 'ok'); } catch (err) { toast(`OmniVoice: ${err.message}`, 'err', 8000); } await loadVoices(); renderEngineBox(); };
}
function renderVoiceList() {
  const clones = state.voices.filter((v) => v.kind === 'clone');
  $('voiceList').innerHTML = clones.length ? `<h4>Klonstimmen</h4>${clones.map((v) => `<div class="voice-row"><span>${esc(v.name)} <span class="muted small">(${esc(v.lang)})</span></span><button class="btn small ghost" data-preview-voice="${esc(v.name)}">▶ Probe</button><button class="btn small ghost danger" data-delete-voice="${esc(v.name)}">🗑</button></div>`).join('')}` : '<p class="muted small">Noch keine Klonstimmen — im Schritt „Stimme des Gastes“ oder im Setup-Assistenten anlegen.</p>';
  $('voiceList').querySelectorAll('[data-delete-voice]').forEach((b) => { b.onclick = async () => { if (!confirm(`Stimme „${b.dataset.deleteVoice}“ löschen?`)) return; try { await api(`api/voices/${encodeURIComponent(b.dataset.deleteVoice)}`, { method: 'DELETE' }); toast('Stimme gelöscht', 'ok'); await loadVoices(); renderVoiceList(); } catch (e) { toast(e.message, 'err'); } }; });
  $('voiceList').querySelectorAll('[data-preview-voice]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { const r = await fetch('api/voices/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: b.dataset.previewVoice, language: state.language }) }); if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`); new Audio(URL.createObjectURL(await r.blob())).play(); } catch (e) { toast(`Probe: ${e.message}`, 'err', 6000); } b.disabled = false; }; });
}
async function openSettings() {
  $('settingsBackdrop').classList.remove('hidden');
  try { state.secrets = await api('api/secrets'); } catch { /* egal */ }
  await loadLlmStatus();
  renderBackends(); renderEngineBox(); renderVoiceList();
  $('cfgHostName').value = state.config.hostName || ''; $('cfgShowName').value = state.config.showName || ''; $('cfgShowUrl').value = state.config.showUrl || ''; $('cfgHostVoice').value = state.config.hostVoice || '';
  $('cfgTts').value = state.config.ttsEngine; $('cfgGuestDe').value = state.config.defaultGuestVoiceDe || ''; $('cfgGuestEn').value = state.config.defaultGuestVoiceEn || '';
  $('cfgParts').value = state.config.parts; $('cfgDuration').value = state.config.durationMin; $('cfgNorm').value = state.config.normalizeDb; $('cfgVerify').checked = state.config.verifyTts !== false; $('cfgUpdates').checked = Boolean(state.config.checkUpdates);
  checkAll('cheap');
}
$('settingsBtn').onclick = openSettings; $('modelChip').onclick = openSettings; $('engineChip').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsBackdrop').classList.add('hidden');
$('settingsBackdrop').addEventListener('click', (e) => { if (e.target === $('settingsBackdrop')) $('settingsBackdrop').classList.add('hidden'); });
$('settingsSave').onclick = async () => {
  try {
    await saveConfig({ hostName: $('cfgHostName').value, showName: $('cfgShowName').value, showUrl: $('cfgShowUrl').value, hostVoice: $('cfgHostVoice').value, ttsEngine: $('cfgTts').value, defaultGuestVoiceDe: $('cfgGuestDe').value, defaultGuestVoiceEn: $('cfgGuestEn').value, parts: Number($('cfgParts').value), durationMin: Number($('cfgDuration').value), normalizeDb: Number($('cfgNorm').value), verifyTts: $('cfgVerify').checked, checkUpdates: $('cfgUpdates').checked });
    $('partsInput').value = state.config.parts; $('durationRange').value = state.config.durationMin; updateDuration(false);
    await loadVoices();
    toast('Einstellungen gespeichert', 'ok');
    $('settingsBackdrop').classList.add('hidden');
  } catch (e) { toast(e.message, 'err'); }
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function loadVoices() {
  const v = await api('api/voices');
  state.voices = v.voices; state.host = v.host; state.defaults = v.defaults; state.engine = v.engine;
  renderVoices(); refreshVoiceSelects(); updateEngineChip();
  const notes = [];
  if (!v.engine.reachable) notes.push('Sprach-Engine nicht erreichbar (unter ⚙ starten)');
  else if (!(v.engine.asr && v.engine.asr.available)) notes.push('Kein Whisper in der Engine — Klonen nicht möglich');
  $('cloneStatus').textContent = notes.length ? `Hinweis: ${notes.join(' · ')}` : '';
}
async function loadUpdate() {
  try { const u = await api('api/update'); if (u && u.newer) { $('updateBar').innerHTML = `Neue Version ${esc(u.latest)} verfügbar (installiert: ${esc(u.current)}) — <a href="${esc(u.url)}" target="_blank" rel="noopener">Release ansehen</a>`; $('updateBar').classList.remove('hidden'); } } catch { /* egal */ }
}
(async () => {
  try {
    const [cfg, fl] = await Promise.all([api('api/config'), api('api/flavors')]);
    state.config = cfg; state.flavors = fl.flavors; applyHostName();
    $('partsInput').value = cfg.parts; $('durationRange').value = cfg.durationMin || 8; updateDuration(false); $('autoAudio').checked = cfg.autoAudio !== false;
    renderFlavors();
    await Promise.all([loadVoices(), loadArchive(), loadLlmStatus()]);
    loadUpdate();
    try { const v = await api('api/version'); $('aboutVersion').textContent = v.version || ''; if (v.homepage && !/YOUR-GITHUB-USER/.test(v.homepage)) $('aboutLink').href = v.homepage; else $('aboutLink').classList.add('hidden'); } catch { /* egal */ }
    setInterval(async () => { try { state.engine = await api('api/engine/status'); updateEngineChip(); } catch { /* egal */ } }, 15000);
  } catch (e) { toast(`Start: ${e.message}`, 'err', 8000); }
  updateResearchBtn(); updateGenerateBtn();
})();
