'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (p, opt) => { const r = await fetch(p, opt); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } if (!r.ok) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { exists: Boolean(j && j.exists) }); return j; };
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
let toastTimer = null;
function toast(msg, kind = '', ms = 4000) { const t = $('toast'); t.textContent = msg; t.className = `toast ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }

const STEP_NAMES = { system: 'Systemcheck (GPU, Platz, Werkzeuge)', ffmpeg: 'ffmpeg (Audio/Video-Werkzeug, ≈ 110 MB)', python: 'Python 3.11 in eigener Umgebung (uv)', torch: 'torch (GPU: ≈ 2,8 GB · CPU: ≈ 250 MB)', packages: 'Sprach-Engine (OmniVoice / Pocket TTS / Whisper)', models: 'Modelle laden (GPU: ≈ 6,6 GB · CPU: ≈ 0,9 GB)' };
const PROVIDERS = [
  { id: 'claude-cli', name: 'Claude Code CLI', desc: 'Abo-Login der Claude-Code-CLI auf diesem PC. Nur Erkennung.', key: null },
  { id: 'codex-cli', name: 'OpenAI Codex CLI', desc: 'ChatGPT-Abo-Login der Codex-CLI (codex login).', key: null },
  { id: 'anthropic', name: 'Anthropic API', desc: 'API-Key von console.anthropic.com.', key: 'anthropic' },
  { id: 'openai', name: 'OpenAI API', desc: 'API-Key von platform.openai.com.', key: 'openai' },
  { id: 'gemini', name: 'Google Gemini', desc: 'API-Key aus Google AI Studio (Free-Tier reicht).', key: 'gemini' },
  { id: 'local', name: 'Lokales Modell', desc: 'LM Studio (Vorgabe :1234) oder Ollama — offline, kein Key.', key: 'local' },
];
const state = { status: null, config: null, voices: [], engine: null, cloneFile: null, checks: {} };

function go(page) {
  document.querySelectorAll('#wizTabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.page === page));
  ['tech', 'show', 'voice', 'ai', 'done'].forEach((p) => $(`page-${p}`).classList.toggle('hidden', p !== page));
  if (page === 'voice') loadVoices();
  if (page === 'ai') renderProviders();
  if (page === 'done') renderSummary();
}
document.querySelectorAll('#wizTabs .tab').forEach((t) => { t.onclick = () => go(t.dataset.page); });
document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => go(b.dataset.goto); });

// --- Technik ----------------------------------------------------------------------------------
let pollTimer = null;
async function refreshStatus() {
  try { state.status = await api('api/setup/status'); } catch (e) { $('setupLog').textContent = `Server nicht erreichbar: ${e.message}`; return; }
  const s = state.status;
  $('homePath').textContent = s.home;
  $('forceCpu').checked = Boolean(s.forceCpu);
  $('profileInfo').textContent = s.profile ? `Profil: ${s.profile.toUpperCase()}${s.gpu ? ` · ${s.gpu.name} (${Math.round(s.gpu.vramMb / 1024)} GB)` : ' · keine NVIDIA-GPU'}` : '';
  $('steps').innerHTML = s.steps.map((st, i) => {
    const running = s.running && s.running.step === st.id;
    const cls = running ? 'running' : st.status;
    const prog = running && s.running.progress ? (s.running.progress.total ? `${s.running.progress.label || ''} — ${Math.round(s.running.progress.done / s.running.progress.total * 100)} %` : (s.running.progress.label || '')) : '';
    return `<div class="sstep ${cls}"><span class="sicon">${st.status === 'done' ? '✓' : st.status === 'failed' ? '!' : i + 1}</span><div class="smain"><div class="sname">${esc(STEP_NAMES[st.id])}</div><div class="sdetail">${esc(running ? (prog || `läuft seit ${s.running.seconds} s`) : (st.detail || (st.status === 'pending' ? 'ausstehend' : st.status)))}</div></div><button class="btn small ghost" data-run="${st.id}" ${s.running ? 'disabled' : ''}>${st.status === 'done' ? 'wiederholen' : 'starten'}</button></div>`;
  }).join('');
  $('steps').querySelectorAll('[data-run]').forEach((b) => { b.onclick = async () => { try { await post('api/setup/run', { step: b.dataset.run }); } catch (e) { toast(e.message, 'err'); } refreshStatus(); }; });
  $('runAllBtn').disabled = Boolean(s.running) || s.complete;
  $('runAllBtn').textContent = s.complete ? '✓ Technik ist eingerichtet' : (s.running ? 'läuft …' : '▶ Alles einrichten');
  $('techNext').disabled = !s.complete;
  $('skipLink').classList.toggle('hidden', !(s.complete && s.setupDone));
  if (s.running) $('setupLog').textContent = s.running.log.join('\n'); else if (!s.complete) { const failed = s.steps.find((x) => x.status === 'failed'); if (failed) $('setupLog').textContent = `Schritt „${STEP_NAMES[failed.id]}“ ist fehlgeschlagen: ${failed.detail}\nNoch einmal starten — jeder Schritt setzt dort fort, wo er war.`; }
  $('setupLog').scrollTop = $('setupLog').scrollHeight;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshStatus, s.running ? 1500 : 8000);
}
$('runAllBtn').onclick = async () => { try { await post('api/setup/run', { step: 'all' }); toast('Einrichtung läuft — das dauert je nach Verbindung 5–25 Minuten', 'ok', 6000); } catch (e) { toast(e.message, 'err'); } refreshStatus(); };
$('forceCpu').onchange = async () => { await post('api/setup/force-cpu', { forceCpu: $('forceCpu').checked }); refreshStatus(); };
$('techNext').onclick = () => go('show');

// --- Show & Host ------------------------------------------------------------------------------
async function loadConfig() { state.config = await api('api/config'); $('wHostName').value = state.config.hostName || ''; $('wShowName').value = state.config.showName || ''; }
$('showNext').onclick = async () => {
  const hostName = $('wHostName').value.trim();
  if (!hostName) { toast('Bitte einen Namen für den Host eingeben', 'err'); return; }
  state.config = await api('api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostName, showName: $('wShowName').value.trim() || 'The Interview' }) });
  if (!$('wCloneName').value) $('wCloneName').value = hostName.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  go('voice');
};

// --- Host-Stimme ------------------------------------------------------------------------------
async function loadVoices() {
  try {
    await post('api/engine/start').catch(() => {});
    const v = await api('api/voices');
    state.voices = v.voices; state.engine = v.engine;
    const cur = state.config && state.config.hostVoice;
    $('wVoiceSelect').innerHTML = state.voices.length ? state.voices.map((x) => `<option value="${esc(x.name)}" ${x.name === cur ? 'selected' : ''}>${esc(x.name)} (${esc(x.kind === 'catalog' ? 'Katalog' : x.lang)})</option>`).join('') : '<option value="">— noch keine Stimme —</option>';
    $('wVoiceHint').textContent = state.engine.reachable ? (state.engine.omnivoice && state.engine.omnivoice.available ? 'OmniVoice (GPU) aktiv' : 'Pocket TTS (CPU) aktiv — Katalogstimmen und Klone') : 'Engine startet … (erster Start dauert ein paar Sekunden)';
    if (!state.engine.reachable) setTimeout(loadVoices, 4000);
  } catch (e) { $('wVoiceHint').textContent = `Engine: ${e.message}`; }
}
const dz = $('wDropzone');
dz.onclick = () => $('wFileInput').click();
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) setCloneFile(e.dataTransfer.files[0]); });
$('wFileInput').onchange = () => { if ($('wFileInput').files[0]) setCloneFile($('wFileInput').files[0]); };
function setCloneFile(f) { state.cloneFile = f; $('wDzHeadline').textContent = `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`; updateCloneBtn(); }
$('wCloneName').addEventListener('input', updateCloneBtn);
function updateCloneBtn() { $('wCloneBtn').disabled = !(state.cloneFile && /^[A-Za-z0-9_-]{1,40}$/.test($('wCloneName').value.trim())); }
let mic = { rec: null, chunks: [], timer: null, t0: 0 };
$('wMicBtn').onclick = async () => {
  if (mic.rec && mic.rec.state === 'recording') { mic.rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    mic.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mic.chunks = []; mic.t0 = Date.now();
    mic.rec.ondataavailable = (e) => { if (e.data.size) mic.chunks.push(e.data); };
    mic.rec.onstop = () => { clearInterval(mic.timer); stream.getTracks().forEach((t) => t.stop()); const blob = new Blob(mic.chunks, { type: mic.rec.mimeType || 'audio/webm' }); $('wMicPlayer').src = URL.createObjectURL(blob); $('wMicPlayer').classList.remove('hidden'); $('wMicBtn').textContent = '● Neu aufnehmen'; $('wMicTime').textContent = `${Math.round((Date.now() - mic.t0) / 1000)} s aufgenommen`; setCloneFile(new File([blob], `aufnahme.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`, { type: blob.type })); };
    mic.rec.start(250);
    $('wMicBtn').textContent = '■ Aufnahme beenden';
    mic.timer = setInterval(() => { $('wMicTime').textContent = `${Math.round((Date.now() - mic.t0) / 1000)} s … (15–30 s reichen, einfach frei erzählen)`; }, 500);
  } catch (e) { toast(`Mikrofon: ${e.message}`, 'err', 6000); }
};
$('wCloneBtn').onclick = async () => {
  const name = $('wCloneName').value.trim();
  const run = (overwrite) => api(`api/voices/clone?name=${encodeURIComponent(name)}&language=${encodeURIComponent($('wCloneLang').value)}${overwrite ? '&overwrite=1' : ''}`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(state.cloneFile.name) }, body: state.cloneFile });
  $('wCloneBtn').disabled = true; $('wCloneStatus').textContent = 'Upload …';
  try {
    let r;
    try { r = await run(false); } catch (e) { if (e.exists && confirm(`Die Stimme „${name}“ gibt es schon. Überschreiben?`)) r = await run(true); else throw e; }
    for (;;) {
      const job = await api(`api/jobs/${r.jobId}`);
      $('wCloneStatus').textContent = (job.log || []).slice(-1)[0] || job.status;
      if (job.status === 'done') break;
      if (job.status === 'failed') throw new Error(job.error || 'Klonen fehlgeschlagen');
      await new Promise((res) => setTimeout(res, 1500));
    }
    await loadVoices();
    $('wVoiceSelect').value = name;
    $('wCloneStatus').textContent = `Stimme „${name}“ ist geklont und unten ausgewählt — Probe anhören, dann weiter.`;
    toast('Stimme geklont', 'ok');
  } catch (e) { $('wCloneStatus').textContent = `Fehler: ${e.message}`; toast(e.message, 'err', 8000); }
  updateCloneBtn();
};
$('wPreviewBtn').onclick = async () => {
  const voice = $('wVoiceSelect').value;
  $('wPreviewBtn').disabled = true; $('wVoiceHint').textContent = 'Probe wird gesprochen … (erster Aufruf lädt das Modell, bis zu einer Minute)';
  try { const r = await fetch('api/voices/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice, language: /^(alba)$/.test(voice) ? 'en' : 'de' }) }); if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`); new Audio(URL.createObjectURL(await r.blob())).play(); $('wVoiceHint').textContent = `Probe mit ${r.headers.get('x-engine') || 'Engine'}`; }
  catch (e) { $('wVoiceHint').textContent = `Probe: ${e.message}`; }
  $('wPreviewBtn').disabled = false;
};
$('voiceNext').onclick = async () => {
  const voice = $('wVoiceSelect').value;
  if (!voice) { toast('Bitte eine Stimme klonen oder wählen', 'err'); return; }
  state.config = await api('api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostVoice: voice }) });
  go('ai');
};

// --- KI-Anbieter ------------------------------------------------------------------------------
async function renderProviders() {
  let sec = {}; let st = {};
  try { sec = (await api('api/secrets')).keys; } catch { /* */ }
  try { st = (await api('api/llm/status')).status.providers; } catch { /* */ }
  $('pcards').innerHTML = PROVIDERS.map((p) => {
    const c = state.checks[p.id];
    const ok = c ? c.ok : (st[p.id] && st[p.id].configured);
    const status = c ? (c.pending ? 'wird geprüft …' : (c.detail || (c.ok ? 'ok' : 'nicht erreichbar'))) : (st[p.id] && st[p.id].configured ? 'eingerichtet' : 'nicht eingerichtet');
    const keyRow = p.key ? `<div class="key-row"><input type="password" data-key="${p.key}" placeholder="${sec[p.key] && sec[p.key].present ? `Key hinterlegt (${esc(sec[p.key].masked)})` : (p.id === 'local' ? 'Key nur falls nötig' : 'API-Key einfügen')}" autocomplete="off"><button class="btn small" data-save="${p.key}" data-provider="${p.id}">Speichern</button></div>` : '';
    const urlRow = p.id === 'local' ? `<div class="key-row"><input type="text" data-local-url value="${esc((state.config && state.config.localUrl) || 'http://127.0.0.1:1234/v1')}"></div>` : '';
    return `<div class="pcard ${ok ? 'ok' : ''}"><h4>${esc(p.name)}</h4><div class="desc">${esc(p.desc)}</div>${urlRow}${keyRow}<div class="backend-status"><span class="led ${c ? (c.pending ? 'busy' : c.ok ? 'ok' : 'fail') : (ok ? 'ok' : '')}"></span><span>${esc(status)}</span></div><div class="row" style="margin-top:6px"><button class="btn small ghost" data-check="${p.id}">Test now</button></div></div>`;
  }).join('');
  $('pcards').querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = async () => {
      const inp = $('pcards').querySelector(`input[data-key="${b.dataset.save}"]`);
      if (!inp.value.trim()) { toast('Kein Key eingegeben', 'err'); return; }
      try { await api('api/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b.dataset.save, value: inp.value.trim() }) }); toast('Key verschlüsselt gespeichert', 'ok'); await renderProviders(); check(b.dataset.provider); } catch (e) { toast(e.message, 'err'); }
    };
  });
  const lu = $('pcards').querySelector('input[data-local-url]');
  if (lu) lu.onchange = async () => { state.config = await api('api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localUrl: lu.value.trim() }) }); check('local'); };
  $('pcards').querySelectorAll('[data-check]').forEach((b) => { b.onclick = () => check(b.dataset.check); });
}
async function check(id) {
  state.checks[id] = { pending: true }; renderProviders();
  try { state.checks[id] = await api(`api/llm/connectivity?provider=${id}&depth=cheap`); } catch (e) { state.checks[id] = { ok: false, detail: e.message }; }
  renderProviders();
}
$('aiNext').onclick = async () => {
  const st = (await api('api/llm/status')).status.providers;
  if (!Object.values(st).some((p) => p.configured)) { if (!confirm('Noch kein KI-Anbieter eingerichtet. Ohne Anbieter lässt sich kein Skript schreiben. Trotzdem weiter?')) return; }
  go('done');
};

// --- Fertig -----------------------------------------------------------------------------------
async function renderSummary() {
  const cfg = await api('api/config');
  const st = (await api('api/llm/status')).status.providers;
  const ready = Object.entries(st).filter(([, p]) => p.configured).map(([id]) => (PROVIDERS.find((p) => p.id === id) || {}).name || id);
  $('summary').innerHTML = `<ul><li>Host: <strong>${esc(cfg.hostName)}</strong> mit Stimme <strong>${esc(cfg.hostVoice || 'automatisch')}</strong></li><li>Show: <strong>${esc(cfg.showName)}</strong></li><li>KI-Anbieter: ${ready.length ? esc(ready.join(', ')) : '<span class="badge warn">keiner</span>'}</li><li>Engine: ${state.engine ? (state.engine.omnivoice && state.engine.omnivoice.available ? 'OmniVoice (GPU) + Pocket TTS' : 'Pocket TTS (CPU)') : '?'}</li></ul><p class="muted small">Alles lässt sich später unter ⚙ ändern; der Assistent bleibt dort erreichbar.</p>`;
}
$('finishBtn').onclick = async () => { await post('api/setup/finish'); location.href = '/'; };

(async () => { await refreshStatus(); await loadConfig(); })();
