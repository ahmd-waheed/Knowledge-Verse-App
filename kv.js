/* Knowledge-Verse reading app: shared library (settings, GitHub access, offline copies of the notes).
   Loaded by the app's home page (index.html) and by every course page the app serves (read/<id>.html).
   Talks only to api.github.com with the token stored on this device; the notes are kept in the
   Cache Storage bucket 'kv-notes', and served offline by the service worker (sw.js).
   Design and setup: docs/READING_APP.md and decision D-18 in the Knowledge-Verse repo. */
(function () {
  'use strict';
  const API = 'https://api.github.com';
  const NOTES_CACHE = 'kv-notes';
  const KEYS = { settings: 'kv:settings', dist: 'kv:dist', cached: 'kv:cached' };
  const DEFAULTS = { owner: 'ahmd-waheed', repo: 'Knowledge-Verse', branch: 'main', distBranch: 'dist', token: '', device: '' };

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  /* ---------- settings ---------- */
  function settings() { return Object.assign({}, DEFAULTS, read(KEYS.settings, {})); }
  function saveSettings(s) { write(KEYS.settings, Object.assign(settings(), s)); }
  const configured = () => { const s = settings(); return !!(s.token && s.owner && s.repo && s.device); };
  const cleanDevice = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const guessDevice = () => /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'phone' : 'laptop';

  /* ---------- GitHub REST API ---------- */
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  async function api(path, opts = {}) {
    const s = settings();
    if (!s.token) throw new ApiError(0, 'No GitHub token on this device (open Settings on the app home page).');
    const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + s.token };
    if (opts.body) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body, cache: 'no-cache', keepalive: !!opts.keepalive }); }
    catch (e) { throw new ApiError(0, navigator.onLine === false ? 'Offline.' : 'GitHub could not be reached.'); }
    if (r.status === 404 && opts.allow404) return null;
    if (!r.ok) {
      let msg = ''; try { msg = (await r.json()).message || ''; } catch (e) {}
      const why = r.status === 401 ? 'the token was refused (expired or revoked?)' : r.status === 403 ? 'access denied or rate limited' : r.status === 404 ? 'not found (does the token give access to this repository?)' : 'error ' + r.status;
      throw new ApiError(r.status, 'GitHub: ' + why + (msg ? ' — ' + msg : ''));
    }
    return r.status === 204 ? null : r.json();
  }
  const repoPath = () => { const s = settings(); return '/repos/' + encodeURIComponent(s.owner) + '/' + encodeURIComponent(s.repo); };
  const b64ToBytes = b64 => { const bin = atob(String(b64).replace(/\s+/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  function bytesToB64(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
  async function blobBytes(sha) { const j = await api(repoPath() + '/git/blobs/' + sha); return b64ToBytes(j.content); }
  async function blobText(sha) { return new TextDecoder().decode(await blobBytes(sha)); }
  async function sha256(bytes) { const h = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join(''); }

  /** Checks the token: the repository must be reachable, private, and writable (annotations are written to it). */
  async function verify() {
    const r = await api(repoPath());
    const dist = await api(repoPath() + '/branches/' + encodeURIComponent(settings().distBranch), { allow404: true });
    return { name: r.full_name, private: !!r.private, push: !!(r.permissions && r.permissions.push), dist: !!dist };
  }

  /* ---------- offline copies of the notes ---------- */
  const distState = () => read(KEYS.dist, { tree: null, index: null, checked: 0 });
  const cachedShas = () => read(KEYS.cached, {});
  // The folder holding index.html, kv.js and host.js (course pages live one level down, in read/). Taken from
  // this script's own address while it loads, so it is right on the home page and on course pages alike.
  const ROOT = new URL('./', (document.currentScript && document.currentScript.src) || location.href).href;
  const courseUrl = id => new URL('read/' + encodeURIComponent(id) + '.html', ROOT).href;

  /** A built course file as the app serves it: the reading-app host script runs before the engine, and math
      comes from the app's own MathJax copy, so the page works offline. */
  function prepare(html) {
    const tags = '<script src="../kv.js"></script><script src="../host.js"></script>\n';
    let out = html, ok = { host: false, mathjax: false };
    out = out.replace(/<meta charset="UTF-8">\n?/i, m => { ok.host = true; return m + tags; });
    if (!ok.host) out = out.replace(/<head>\n?/i, m => { ok.host = true; return m + tags; });
    out = out.replace(/(<script\s+src=")[^"]*\/mathjax@3\/es5\/([^"]+)"/, (m, a, file) => { ok.mathjax = true; return a + '../mathjax/es5/' + file + '"'; });
    return { html: out, ok };
  }

  /** Downloads whatever changed on the dist branch. onProgress(text) reports each step.
      Returns { changed:[ids], removed:[ids], index, warnings:[...] }. Offline or unconfigured: throws ApiError. */
  async function update(onProgress = () => {}, only = null) {
    const st = distState();
    onProgress('Checking GitHub for new notes…');
    const tree = await api(repoPath() + '/git/trees/' + encodeURIComponent(settings().distBranch), { allow404: true });
    if (!tree) throw new ApiError(404, 'The notes have not been published yet (no "' + settings().distBranch + '" branch). It appears after the first push to main.');
    const files = new Map((tree.tree || []).filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
    let index = st.index;
    if (tree.sha !== st.tree || !index) {
      if (!files.has('index.json')) throw new ApiError(0, 'The dist branch has no index.json.');
      index = JSON.parse(await blobText(files.get('index.json')));
    }
    const cache = await caches.open(NOTES_CACHE), have = cachedShas(), changed = [], warnings = [];
    for (const c of index.courses) {
      if (only && c.id !== only) continue;
      if (have[c.id] === c.sha256 && await cache.match(courseUrl(c.id))) continue;
      const sha = files.get(c.file); if (!sha) { warnings.push(c.code + ': file missing on the dist branch'); continue; }
      onProgress('Downloading ' + c.code + ' (' + (c.bytes / 1048576).toFixed(1) + ' MB)…');
      const bytes = await blobBytes(sha);
      if (await sha256(bytes) !== c.sha256) { warnings.push(c.code + ': download corrupted, kept the previous copy'); continue; }
      const p = prepare(new TextDecoder().decode(bytes));
      if (!p.ok.host) warnings.push(c.code + ': could not attach the sync script (annotations will not sync)');
      if (!p.ok.mathjax) warnings.push(c.code + ': math loads from the internet (MathJax tag not found)');
      await cache.put(courseUrl(c.id), new Response(p.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      have[c.id] = c.sha256; write(KEYS.cached, have); changed.push(c.id);
    }
    const removed = [];
    if (!only) for (const id of Object.keys(have)) if (!index.courses.some(c => c.id === id)) { await cache.delete(courseUrl(id)); delete have[id]; removed.push(id); }
    write(KEYS.cached, have);
    write(KEYS.dist, { tree: tree.sha, index, checked: Date.now() });   // courses are compared one by one, so a partial update is safe
    try { await pruneTraces(index); } catch (e) { console.warn('[kv] prune traced pages', e); }
    return { changed, removed, index, warnings };
  }
  /* ---------- traced pages of my typed files (I-34): fetched only when a file is opened, then kept offline ---------- */
  const traceUrl = (path, sha) => new URL('read/' + path.replace(/\.svgz$/, '.svg') + '?v=' + String(sha).slice(0, 16), ROOT).href;
  async function gunzip(buf) { return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  /** The traced page n of a file, as SVG text: from this device if it is here, else from the dist branch (then kept). */
  async function trace(cid, doc, n) {
    const c = ((distState().index || {}).courses || []).find(x => x.id === cid);
    const e = c && c.traces && c.traces[doc] && c.traces[doc][n - 1]; if (!e) return null;
    const url = traceUrl(e.path, e.sha256), cache = await caches.open(NOTES_CACHE);
    const hit = await cache.match(url); if (hit) return hit.text();
    if (!configured() || navigator.onLine === false) return null;
    const s = settings();
    let r;
    try { r = await fetch(API + repoPath() + '/contents/' + e.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(s.distBranch),
                          { headers: { Accept: 'application/vnd.github.raw', Authorization: 'Bearer ' + s.token }, cache: 'no-cache' }); }
    catch (x) { return null; }
    if (!r.ok) throw new ApiError(r.status, 'GitHub: traced page ' + e.path + ': error ' + r.status);
    const bytes = await gunzip(await r.arrayBuffer());
    if (await sha256(bytes) !== e.sha256) throw new ApiError(0, 'traced page corrupted in transit: ' + e.path);
    const text = new TextDecoder().decode(bytes);
    await cache.put(url, new Response(text, { headers: { 'Content-Type': 'image/svg+xml' } }));
    return text;
  }
  /** Forget a file's traced pages on this device (after I removed the traced version), or all of a course's. */
  async function dropTraces(cid, doc) {
    const cache = await caches.open(NOTES_CACHE), pre = new URL('read/files/' + cid + '/' + (doc ? doc + '/' : ''), ROOT).href;
    for (const k of await cache.keys()) if (k.url.startsWith(pre)) await cache.delete(k);
  }
  async function pruneTraces(index) {   // keep only the traced pages the current build lists
    const cache = await caches.open(NOTES_CACHE), keep = new Set(), pre = new URL('read/files/', ROOT).href;
    (index.courses || []).forEach(c => Object.values(c.traces || {}).forEach(l => l.forEach(e => keep.add(traceUrl(e.path, e.sha256)))));
    for (const k of await cache.keys()) if (k.url.startsWith(pre) && !keep.has(k.url)) await cache.delete(k);
  }
  async function forgetNotes() { await caches.delete(NOTES_CACHE); localStorage.removeItem(KEYS.cached); localStorage.removeItem(KEYS.dist); }

  /* ---------- annotations in the repo: courses/<id>/annotations/*.json ---------- */
  const annDir = id => 'courses/' + id + '/annotations';
  const deviceFile = id => annDir(id) + '/device-' + settings().device + '.json';
  async function listAnnotations(id) {
    const list = await api(repoPath() + '/contents/' + annDir(id) + '?ref=' + encodeURIComponent(settings().branch), { allow404: true });
    return (Array.isArray(list) ? list : []).filter(e => e.type === 'file' && /\.json$/i.test(e.name)).map(e => ({ name: e.name, path: e.path, sha: e.sha }));
  }
  async function putFile(path, text, sha, message, keepalive) {
    const body = { message, content: bytesToB64(new TextEncoder().encode(text)), branch: settings().branch };
    if (sha) body.sha = sha;
    const json = JSON.stringify(body);   // keepalive (a write that outlives the page) is limited to 64 KB by browsers
    const r = await api(repoPath() + '/contents/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', body: json, keepalive: keepalive && json.length < 60000 });
    return r && r.content ? r.content.sha : null;
  }

  window.KV = { settings, saveSettings, configured, cleanDevice, guessDevice, api, ApiError, verify, update, forgetNotes, prepare, trace, dropTraces,
                distState, cachedShas, courseUrl, root: ROOT, listAnnotations, blobText, putFile, deviceFile, read, write };
})();
