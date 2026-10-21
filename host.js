/* Knowledge-Verse reading app: the host inside a course page (read/<id>.html).
   Runs before the engine (kb_shell.html, engine 3.4+), which then hands Save / Ctrl+S and the Save button to it.
   Annotations are local-first: the engine autosaves them in this browser; this script merges every file in
   courses/<id>/annotations/ from GitHub into them, and writes this device's complete set back to
   courses/<id>/annotations/device-<name>.json (one file per device, so devices never overwrite each other).
   When: on opening, when the page comes back into view, 90 s after the last change, when the page is hidden,
   when the connection returns, and on Save / Ctrl+S. It also checks for a newer build of the notes.
   The highlight legend is one for every course (I-32): besides each course's file, this device writes its legend to
   annotations/legend/device-<name>.json and every course merges all of those (newest name or color wins). */
(function () {
  'use strict';
  const KV = window.KV;
  const COURSE = decodeURIComponent(location.pathname.split('/').pop().replace(/\.html?$/i, ''));
  const SKEY = 'kv:sync:' + COURSE;
  const IDLE_PUSH_MS = 90 * 1000, PULL_EVERY_MS = 60 * 1000, UPDATE_EVERY_MS = 5 * 60 * 1000;
  const st = Object.assign({ seen: {}, deviceSha: null, pushedHash: null, localDirty: false, last: 0, error: '' }, KV.read(SKEY, {}));
  const persist = () => KV.write(SKEY, st);
  const LKEY = 'kv:legend-sync';   // the shared legend's sync state: one for the device, not per course
  const lst = () => Object.assign({ seen: {}, sha: null, base: null, dirty: false, device: null }, KV.read(LKEY, {}));
  if (st.device !== KV.settings().device) {   // first run here, or the device was renamed: start this device's own file
    if (st.device) st.localDirty = true;
    st.device = KV.settings().device; st.deviceSha = null; persist();
  }
  const loadedSha = (KV.cachedShas() || {})[COURSE] || null;   // the build this page was opened with
  let KB = null, busy = null, syncing = false, timer = null, merging = false, lastPull = 0, lastUpdate = 0, newBuild = false;

  const hash = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36) + ':' + s.length; };
  const storeText = () => JSON.stringify(Object.assign({}, KB.annotations.store, { savedAt: new Date().toISOString(), savedBy: 'reading app, device ' + KV.settings().device }), null, 1);
  const storeHash = () => hash(JSON.stringify(KB.annotations.store));
  const time = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never';
  const toast = m => KB && KB.toast ? KB.toast(m) : console.log('[kv]', m);
  const canSync = () => KV.configured() && navigator.onLine !== false;

  /* ---------- engine hooks ---------- */
  window.KB_HOST = {
    name: 'Knowledge-Verse reading app',
    save() { return syncNow(true); },
    saveState() {
      if (!KV.configured()) return { text: '⟳ Sync off', title: 'Not connected to GitHub: notes are kept in this browser only. Open the app home → Settings.' };
      const where = KV.deviceFile(COURSE);
      if (syncing) return { text: '⟳ Syncing…', title: 'Syncing with GitHub (' + where + ')' };
      if (st.error) return { text: '⚠ Sync', title: 'Last sync failed: ' + st.error + '\nYour notes are safe in this browser. Click to retry.' };
      if (st.localDirty) return { text: '⟳ Sync •', title: (navigator.onLine === false ? 'Offline. ' : '') + 'Changes kept in this browser, not yet on GitHub. They sync automatically; click (or Ctrl+S) to sync now.\nLast synced ' + time(st.last) + '.' };
      return { text: '⟳ Synced', title: 'All notes are on GitHub (' + where + '). Last synced ' + time(st.last) + '. Click to sync now.' };
    },
    pending() { return false; },   // nothing is lost on closing: the browser keeps every change until the next sync
    trace(doc, n) { return KV.trace(COURSE, doc, n); },   // I-34: a traced page of one of my files (SVG text, or null when not available)
    dropTraces(doc) { return KV.dropTraces(COURSE, doc); }   // I-34: I removed a file's traced version: forget it on this device
  };
  const refreshUI = () => { try { KB && KB.annotations.refreshSaveUI(); } catch (e) {} };

  /* ---------- pull: merge every annotation file of this course ---------- */
  async function pull() {
    const list = await KV.listAnnotations(COURSE);
    const mine = KV.deviceFile(COURSE).split('/').pop();
    let merged = 0;
    for (const f of list) {
      if (f.name === mine) st.deviceSha = f.sha;
      if (st.seen[f.name] === f.sha) continue;
      let obj = null;
      try { obj = JSON.parse(await KV.blobText(f.sha)); } catch (e) { console.warn('[kv] skipped unreadable ' + f.path, e); st.seen[f.name] = f.sha; continue; }
      merging = true;
      try { const r = KB.annotations.merge(obj, 'repo:' + f.name); if (r && r.changed) merged++; }
      finally { merging = false; }
      st.seen[f.name] = f.sha;
    }
    if (!list.some(f => f.name === mine)) st.deviceSha = null;
    lastPull = Date.now(); persist();
    return merged;
  }

  /* ---------- the legend shared by every course (I-32) ---------- */
  const legendHash = () => hash(JSON.stringify(KB.annotations.legend()));
  const legendText = () => JSON.stringify(Object.assign({}, KB.annotations.legend(), { savedAt: new Date().toISOString(), savedBy: 'reading app, device ' + KV.settings().device }), null, 1);
  const hasLegend = () => !!(KB && KB.annotations && KB.annotations.legend && KB.annotations.mergeLegend);   // engine 5.1+; older builds skip it
  async function pullLegend() {
    if (!hasLegend()) return;
    const L = lst(), mine = KV.legendFile().split('/').pop();
    if (L.device !== KV.settings().device) { if (L.device) L.dirty = true; L.device = KV.settings().device; L.sha = null; }
    for (const f of await KV.listLegends()) {
      if (f.name === mine) L.sha = f.sha;
      if (L.seen[f.name] === f.sha) continue;
      try { const obj = JSON.parse(await KV.blobText(f.sha)); merging = true; try { KB.annotations.mergeLegend(obj); } finally { merging = false; } }
      catch (e) { console.warn('[kv] skipped unreadable ' + f.path, e); }
      L.seen[f.name] = f.sha;
    }
    if (!L.dirty) L.base = legendHash();   // what GitHub holds now; only a change made here after this is written
    KV.write(LKEY, L);
  }
  async function pushLegend(keepalive = false) {
    if (!hasLegend()) return false;
    let L = lst(); if (!L.dirty) return false;   // only a legend change made on this device starts a write
    const msg = 'Legend from ' + KV.settings().device + ' (' + KB.annotations.legend().categories.length + ' categories)';
    let sha;
    try { sha = await KV.putFile(KV.legendFile(), legendText(), L.sha, msg, keepalive); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      await pullLegend(); L = lst();   // written from another course or browser meanwhile: merge, then write the union
      sha = await KV.putFile(KV.legendFile(), legendText(), L.sha, msg, keepalive);
    }
    L = lst(); L.sha = sha; L.seen[KV.legendFile().split('/').pop()] = sha; L.base = legendHash(); L.dirty = false; KV.write(LKEY, L);
    return true;
  }

  /* ---------- push: this device's complete set → its own file ---------- */
  async function push(keepalive = false) {
    if (!st.localDirty) return false;   // only this device's own changes start a write
    const h = storeHash();
    const s = KB.annotations.store, n = s.items.length, p = s.pageNotes.filter(x => x.text && x.text.trim()).length;
    const msg = 'Annotations: ' + (window.KB_CONFIG ? KB_CONFIG.code : COURSE) + ' from ' + KV.settings().device + ' (' + n + ' highlights, ' + p + ' page notes)';
    let sha;
    try { sha = await KV.putFile(KV.deviceFile(COURSE), storeText(), st.deviceSha, msg, keepalive); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      await pull();   // the file changed elsewhere (same device name in another browser): merge it, then write the union
      sha = await KV.putFile(KV.deviceFile(COURSE), storeText(), st.deviceSha, msg, keepalive);
    }
    st.deviceSha = sha; st.seen[KV.deviceFile(COURSE).split('/').pop()] = sha;
    st.pushedHash = h; st.localDirty = false; persist();
    return true;
  }

  function syncNow(manual = false) {
    if (busy) return busy;
    if (!KV.configured()) { if (manual) toast('Not connected to GitHub yet: open the app home → Settings. Your notes are kept in this browser.'); return Promise.resolve(); }
    if (navigator.onLine === false) { if (manual) toast('Offline: your notes are kept in this browser and sync when you are back online.'); refreshUI(); return Promise.resolve(); }
    clearTimeout(timer);
    syncing = true; refreshUI();
    busy = (async () => {
      try {
        const merged = await pull();
        await pullLegend();
        const pushed = await push();
        await pushLegend();
        st.error = ''; st.last = Date.now(); persist();
        if (manual || merged) toast(merged ? 'Merged notes from ' + merged + ' other file(s) on GitHub.' + (pushed ? ' Synced ✓' : '') : 'Synced ✓ ' + KV.deviceFile(COURSE));
      } catch (e) {
        st.error = e.message || String(e); persist();
        if (manual) toast('Sync failed: ' + st.error + ' Your notes are safe in this browser.');
        console.warn('[kv] sync', e);
      } finally { busy = null; syncing = false; refreshUI(); }
    })();
    return busy;
  }

  /* ---------- newer build of the notes ---------- */
  async function checkUpdate() {
    if (!canSync() || newBuild) return;
    lastUpdate = Date.now();
    try {
      const r = await KV.update(() => {}, COURSE);
      const now = (KV.cachedShas() || {})[COURSE];
      if (loadedSha && now && now !== loadedSha) { newBuild = true; banner(r.index); }
    } catch (e) { console.warn('[kv] update check', e); }
  }
  function banner(index) {
    const c = (index.courses || []).find(x => x.id === COURSE) || {};
    const b = document.createElement('div');
    b.id = 'kvUpdate';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;background:var(--accent,#2563eb);color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:14px/1.3 system-ui,sans-serif;display:flex;gap:12px;align-items:center;max-width:calc(100vw - 32px)';
    b.innerHTML = '<span>New notes downloaded' + (c.contentVersion ? ' (content v' + c.contentVersion + ')' : '') + '.</span>';
    const go = document.createElement('button'); go.textContent = 'Reload';
    go.style.cssText = 'background:#fff;color:#111;border:0;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer';
    go.onclick = async () => { await syncNow(); location.reload(); };
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Later'; x.setAttribute('aria-label', 'Later');
    x.style.cssText = 'background:transparent;color:#fff;border:0;font:inherit;cursor:pointer';
    x.onclick = () => b.remove();
    b.append(go, x); document.body.appendChild(b);
  }

  /* ---------- wiring ---------- */
  window.addEventListener('kb:ready', () => {
    KB = window.KB;
    if (hasLegend()) { const L = lst(); if (!L.base) { L.base = legendHash(); KV.write(LKEY, L); } }   // first open on this device, maybe offline: the legend to compare edits with
    if (window.KB_ID && window.KB_ID !== COURSE) console.warn('[kv] page name and course id differ:', COURSE, window.KB_ID);
    const tools = document.querySelector('#sidebar .tools');
    if (tools && !document.getElementById('kvHome')) {   // a way back to the course list, styled like the engine's own buttons
      const home = document.createElement('button');
      home.id = 'kvHome'; home.textContent = '⌂ Courses'; home.title = 'All courses (Knowledge-Verse app home)';
      home.onclick = () => { location.href = '../index.html'; };
      tools.insertBefore(home, tools.firstChild);
    }
    refreshUI();
    syncNow().then(checkUpdate);
  });
  window.addEventListener('kb:annotations', () => {
    if (merging) return;   // changes that came from GitHub are not this device's to push
    st.localDirty = true; persist(); refreshUI();
    if (hasLegend()) { const L = lst(); if (!L.dirty && L.base && L.base !== legendHash()) { L.dirty = true; KV.write(LKEY, L); } }   // the legend changed here
    clearTimeout(timer); timer = setTimeout(() => syncNow(), IDLE_PUSH_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (!KB) return;
    if (document.visibilityState === 'hidden') {
      if (st.localDirty && canSync() && !busy) push(true).then(() => { st.last = Date.now(); st.error = ''; persist(); }).catch(() => {});
      if (lst().dirty && canSync() && !busy) pushLegend(true).catch(() => {});
    }
    else {
      if (Date.now() - lastPull > PULL_EVERY_MS) syncNow();
      if (Date.now() - lastUpdate > UPDATE_EVERY_MS) checkUpdate();
    }
  });
  window.addEventListener('online', () => { if (KB) setTimeout(() => syncNow().then(checkUpdate), 2000); });   // the connection is often not usable at the very moment the event fires
  window.addEventListener('offline', refreshUI);
})();
