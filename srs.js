/* Knowledge-Verse reading app: spaced repetition shared by everything that comes back on a schedule (I-56, D-41).
   Loaded by the home page (index.html) after kv.js, before review.js (my highlights, kind "highlight") and practice.js (items).
   Here: the day (it starts at 4 am), the schedule (one function: the whole rule), the cap an exam puts on an interval,
   the sync of a per-card state file (one file per device, the newest review of a card wins: review/device-<name>.json),
   and the sync of an append-only attempt log (practice/device-<name>/<yyyy-mm>.json, merged by the union of attempt ids).
   Device files are mine: the app writes only this device's, sessions never edit any. Design: docs/READING_APP.md §1. */
(function () {
  'use strict';
  const KV = window.KV;
  const CAP_DAYS = 180, DAY_STARTS_H = 4;
  const S = { now: () => Date.now() };   // the tests move this clock

  /* ---------- days ---------- */
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dayOf = ms => iso(new Date(ms - DAY_STARTS_H * 3600000));   // a late night still counts as that day
  const today = () => dayOf(S.now());
  const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
  const daysFrom = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const DAYRE = /^\d{4}-\d\d-\d\d$/;

  /* ---------- the schedule: this function is the whole rule (FSRS can replace it later) ----------
     card: what is stored for it (ivl = its interval in days; 0 or missing = new, or failed and not yet passed again).
     grade: 'again' (failed: today again), 'hard' (back tomorrow, the interval starts over at 1 day),
            'ok' (×1.5), 'good' (×2.5), 'easy' (×4). First pass: 1 day, or 4 days on Easy. Never more than 180 days.
     maxDays (optional): an exam is near, so the interval may not be longer than this (examCap below).
     Returns the new interval and in how many days the card is due. */
  function schedule(card, grade, maxDays) {
    if (grade === 'again') return { ivl: 0, days: 0 };
    if (grade === 'hard') return { ivl: 1, days: 1 };
    const prev = (card && card.ivl) || 0, f = grade === 'easy' ? 4 : grade === 'ok' ? 1.5 : 2.5;
    let ivl = Math.min(CAP_DAYS, prev ? prev * f : (grade === 'easy' ? 4 : 1));
    if (maxDays != null) ivl = Math.max(1, Math.min(ivl, maxDays));
    return { ivl: Math.round(ivl * 100) / 100, days: Math.max(1, Math.round(ivl)) };
  }
  /** Exam-aware spacing (plan §15.1): an interval is at most 0.2 × the days to the exam, and nothing is due after exam − 2 days.
      Returns the longest interval allowed for a review done on `day`, or null when no exam is ahead. */
  function examCap(day, exam) {
    if (!exam || !DAYRE.test(exam)) return null;
    const left = daysFrom(day, exam); if (left <= 0) return null;
    return Math.max(1, Math.min(Math.floor(0.2 * left), left - 2));
  }

  /* ---------- sync of a per-card state file: <dir>/device-<name>.json, the newest review of a card wins ----------
     o: { dir, state(), save(s), merge(cards, fromFile) → n changed, prune(s), text(s), message(s) }
     The state holds { cards, seen: { file name: sha }, sha, dirty }. This device's file is written only when dirty. */
  function cardSync(o) {
    let busy = null;
    return function sync(keepalive = false) {
      if (busy) return busy;
      busy = (async () => {
        const mine = 'device-' + KV.settings().device + '.json', path = o.dir + '/' + mine; let merged = 0;
        for (let attempt = 0; ; attempt++) {
          const list = (await KV.listDir(o.dir)).filter(f => /^device-.+\.json$/.test(f.name)), seen = o.state().seen, got = {};
          for (const f of list) {
            if (seen[f.name] === f.sha) continue;
            try { got[f.name] = { sha: f.sha, obj: JSON.parse(await KV.blobText(f.sha)) }; } catch (e) { got[f.name] = { sha: f.sha, obj: null }; }
          }
          let s = o.state();   // read again: I may have graded a card while the requests ran
          for (const [name, g] of Object.entries(got)) { s.seen[name] = g.sha; if (g.obj) merged += o.merge(s.cards, g.obj.cards); }
          Object.keys(s.seen).forEach(n => { if (!list.some(f => f.name === n)) delete s.seen[n]; });
          const remote = list.find(f => f.name === mine); s.sha = remote ? remote.sha : null;
          if (s.dirty && o.prune) o.prune(s);
          o.save(s);
          if (!s.dirty) break;
          const sent = JSON.stringify(s.cards);
          try {
            const sha = await KV.putFile(path, o.text(s), s.sha, o.message(s), keepalive);
            const cur = o.state(); cur.sha = sha; cur.seen[mine] = sha; cur.dirty = JSON.stringify(cur.cards) !== sent; o.save(cur);   // a card graded during the write goes up next time
            break;
          } catch (e) { if (attempt || (e.status !== 409 && e.status !== 422)) throw e; }   // my file changed elsewhere (this device's name in another browser): merge it, then write
        }
        return merged;
      })().finally(() => { busy = null; });
      return busy;
    };
  }

  /* ---------- the attempt log: practice/device-<name>/<yyyy-mm>.json, append-only, merged by the union of attempt ids ----------
     In this browser ('kv:practice'): { log: { attempt id: attempt }, dirty: { 'yyyy-mm': 1 }, seen: { path: sha }, dirs: { folder: sha } }.
     An attempt: { id, t (ms), n (this device's running number), day, dev, item, … } (practice.js says what else). Nothing is ever removed or rewritten:
     this device's file for a month is every attempt of this device in that month, so two browsers with one device
     name, a cleared browser, or a write that raced another all end with the union. */
  const LOG_KEY = 'kv:practice', LOG_DIR = 'practice';
  function logState() {
    const s = Object.assign({ log: {}, dirty: {}, seen: {}, dirs: {} }, KV.read(LOG_KEY, {}));
    ['log', 'dirty', 'seen', 'dirs'].forEach(k => { if (!s[k] || typeof s[k] !== 'object') s[k] = {}; });
    return s;
  }
  const logSave = s => KV.write(LOG_KEY, s);
  const newId = () => KV.settings().device + '-' + S.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  /** Appends one attempt of this device (id, time, day and device are filled in here) and returns it. */
  function logAdd(a) {
    const s = logState(), t = S.now(), day = dayOf(t);
    const dev = KV.settings().device || 'this-device', n = Object.values(s.log).reduce((m, x) => x.dev === dev && x.n > m ? x.n : m, 0) + 1;
    const rec = Object.assign({ id: newId(), t, n, day, dev }, a);   // n: this device's running number, so two attempts in one millisecond keep their order
    s.log[rec.id] = rec; s.dirty[day.slice(0, 7)] = 1; logSave(s);
    return rec;
  }
  const byTime = (a, b) => a.t - b.t || (a.n || 0) - (b.n || 0) || String(a.id).localeCompare(String(b.id));
  const logAll = () => Object.values(logState().log).sort(byTime);
  const logDirty = () => Object.keys(logState().dirty).length > 0;
  function mergeLog(into, list) {
    let n = 0;
    (Array.isArray(list) ? list : []).forEach(a => { if (a && typeof a.id === 'string' && typeof a.t === 'number' && DAYRE.test(a.day || '') && !into[a.id]) { into[a.id] = a; n++; } });
    return n;
  }
  function logText(dev, month, list) {   // one attempt per line: small, and readable in the repo's history
    return '{\n "format": "kv-practice-log", "schema": 1, "device": ' + JSON.stringify(dev) + ', "month": ' + JSON.stringify(month) +
      ',\n "savedAt": ' + JSON.stringify(new Date().toISOString()) + ',\n "attempts": [' + (list.length ? '\n' + list.map(a => '  ' + JSON.stringify(a)).join(',\n') + '\n ' : '') + ']\n}\n';
  }
  let logBusy = null;
  /** Reads every device's months that changed, then writes this device's months that have new attempts.
      Resolves with the number of attempts that arrived from other devices. */
  function logSync(keepalive = false) {
    if (logBusy) return logBusy;
    logBusy = (async () => {
      const dev = KV.settings().device, mineDir = 'device-' + dev; let merged = 0;
      for (let attempt = 0; ; attempt++) {
        const top = (await KV.listEntries(LOG_DIR)).filter(e => e.type === 'dir' && /^device-.+$/.test(e.name)), st = logState(), got = [], shas = {}, dirSha = {};
        for (const d of top) {
          dirSha[d.name] = d.sha;
          if (st.dirs[d.name] === d.sha && !(d.name === mineDir && Object.keys(st.dirty).length)) continue;   // nothing new in that device's folder
          for (const f of (await KV.listEntries(LOG_DIR + '/' + d.name)).filter(e => e.type === 'file' && /^\d{4}-\d\d\.json$/.test(e.name))) {
            if (d.name === mineDir) shas[f.name.slice(0, 7)] = f.sha;
            if (st.seen[f.path] === f.sha) continue;
            let obj = null; try { obj = JSON.parse(await KV.blobText(f.sha)); } catch (e) {}
            got.push({ path: f.path, sha: f.sha, obj });
          }
        }
        let s = logState();   // read again: I may have answered while the requests ran
        got.forEach(g => { s.seen[g.path] = g.sha; if (g.obj) merged += mergeLog(s.log, g.obj.attempts); });
        s.dirs = dirSha; logSave(s);
        const months = Object.keys(s.dirty).sort(); if (!months.length) break;
        try {
          for (const m of months) {
            const list = Object.values(s.log).filter(a => a.dev === dev && a.day.slice(0, 7) === m).sort(byTime), path = LOG_DIR + '/' + mineDir + '/' + m + '.json';
            const sha = await KV.putFile(path, logText(dev, m, list), shas[m] || null, 'Practice from ' + dev + ' (' + m + ': ' + list.length + ' attempt' + (list.length === 1 ? '' : 's') + ')', keepalive);
            const cur = logState(); cur.seen[path] = sha; delete cur.dirs[mineDir];   // my folder changed: list it again next time
            if (!Object.values(cur.log).some(a => a.dev === dev && a.day.slice(0, 7) === m && !list.some(x => x.id === a.id))) delete cur.dirty[m];   // an answer given during the write goes up next time
            logSave(cur);
          }
          break;
        } catch (e) {
          if (attempt || (e.status !== 409 && e.status !== 422)) throw e;   // my file changed elsewhere: read it, then write the union
          const cur = logState(); delete cur.dirs[mineDir]; logSave(cur);
        }
      }
      return merged;
    })().finally(() => { logBusy = null; });
    return logBusy;
  }

  KV.srs = Object.assign(S, { CAP_DAYS, DAY_STARTS_H, DAYRE, iso, dayOf, today, addDays, daysFrom, schedule, examCap, cardSync,
                              logState, logAdd, logAll, logDirty, logSync, LOG_KEY });
})();
