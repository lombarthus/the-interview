'use strict';

// Recherche ohne LLM: Wikipedia-Suche (de + en), Volltext-Extrakt, freie Links.
// Die Verdichtung zum Charakterprofil macht danach die LLM-Kette (lib/script.js).
// Wikipedia verlangt einen aussagekräftigen User-Agent; ohne ihn kommt 403.
//
// Freie Links laufen durch einen SSRF-Riegel: keine privaten, link-lokalen oder Loopback-
// Adressen, keine Umleitung dorthin — die App lauscht selbst auf 127.0.0.1 und soll nicht als
// Brücke ins lokale Netz dienen.

const dns = require('dns').promises;
const net = require('net');

const UA = 'TheInterview/1.0 (standalone; local; Node ' + process.version + ')';
const FETCH_TIMEOUT_MS = 12000;
const MAX_EXTRACT_CHARS = 14000;
const MAX_URL_CHARS = 14000;

function wikiApi(lang) { return `https://${lang}.wikipedia.org/w/api.php`; }

async function getJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} von ${new URL(url).host}`);
  return r.json();
}

async function searchWikipedia(query, lang, limit = 6) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    generator: 'search', gsrsearch: query, gsrlimit: String(limit), gsrnamespace: '0',
    prop: 'description|pageimages|extracts', exintro: '1', explaintext: '1', exlimit: String(limit), exchars: '400',
    piprop: 'thumbnail', pithumbsize: '96',
  });
  const j = await getJson(`${wikiApi(lang)}?${params}`);
  const pages = (j.query && j.query.pages) || [];
  return pages
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((p) => ({
      lang, title: p.title, pageid: p.pageid, description: p.description || '',
      extract: String(p.extract || '').replace(/\s+/g, ' ').trim(),
      thumbnail: p.thumbnail && p.thumbnail.source ? p.thumbnail.source : null,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    }))
    .filter((h) => !/begriffsklärung|disambiguation/i.test(h.description || '') && !/may refer to:|steht für:/i.test(h.extract));
}

async function searchAll(query, langs = ['de', 'en']) {
  const results = await Promise.allSettled(langs.map((l) => searchWikipedia(query, l, 5)));
  const hits = []; const errors = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') hits.push(...r.value); else errors.push(`${langs[i]}: ${String(r.reason && r.reason.message || r.reason).slice(0, 120)}`); });
  return { hits, errors };
}

async function fetchWikipediaExtract(title, lang) {
  const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', redirects: '1', prop: 'extracts|description', explaintext: '1', titles: title });
  const j = await getJson(`${wikiApi(lang)}?${params}`, 20000);
  const page = (j.query && j.query.pages && j.query.pages[0]) || null;
  if (!page || page.missing) throw new Error(`Wikipedia (${lang}): Artikel "${title}" nicht gefunden`);
  const text = String(page.extract || '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: page.title, description: page.description || '', text: text.slice(0, MAX_EXTRACT_CHARS), truncated: text.length > MAX_EXTRACT_CHARS, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}` };
}

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ');
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|section|article|blockquote)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  s = s.split('\n').map((l) => l.replace(/[ \t\r]+/g, ' ').trim()).filter((l) => l.length > 1).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return { title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '', text: s };
}

// --- SSRF-Riegel -----------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::' || v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return m4 ? isPrivateIp(m4[1]) : false;
}
async function assertPublicHost(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('Nur öffentliche Internet-Links sind erlaubt');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('Nur öffentliche Internet-Links sind erlaubt'); return; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`Host ${host} ist nicht auflösbar`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Nur öffentliche Internet-Links sind erlaubt');
}

async function fetchUrlText(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { throw new Error('Das ist kein gültiger Link'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http(s)-Links');
  const wm = /^([a-z]{2,3})\.(?:m\.)?wikipedia\.org$/i.exec(u.hostname);
  if (wm && /^\/wiki\//.test(u.pathname)) {
    const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
    const ex = await fetchWikipediaExtract(title, wm[1].toLowerCase());
    return { ...ex, source: 'wikipedia', lang: wm[1].toLowerCase() };
  }
  // Umleitungen von Hand folgen, damit jedes Ziel durch den Riegel geht.
  let r = null;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHost(u);
    r = await fetch(u.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TheInterview/1.0', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'de,en;q=0.8' },
      signal: AbortSignal.timeout(20000), redirect: 'manual',
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
    break;
  }
  if (!r.ok) throw new Error(`Link antwortet mit HTTP ${r.status}${r.status === 403 ? ' (Seite blockt automatische Abrufe — Text bitte von Hand einfügen)' : ''}`);
  const ctype = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 3 * 1024 * 1024) throw new Error('Seite ist größer als 3 MB');
  const raw = buf.toString('utf8');
  const { title, text } = /text\/plain/.test(ctype) ? { title: '', text: raw } : htmlToText(raw);
  const clean = text.trim();
  if (clean.length < 200) throw new Error('Aus dem Link ließ sich kaum Text gewinnen (Seite braucht vermutlich JavaScript) — Text bitte von Hand einfügen');
  return { title, text: clean.slice(0, MAX_URL_CHARS), truncated: clean.length > MAX_URL_CHARS, url: u.toString(), source: 'url' };
}

module.exports = { searchAll, searchWikipedia, fetchWikipediaExtract, fetchUrlText, htmlToText, isPrivateIp, MAX_EXTRACT_CHARS };
