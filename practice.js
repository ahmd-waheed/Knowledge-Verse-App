/* Knowledge-Verse reading app: daily practice, the Today queue (I-56, D-41; plan: docs/DAILY_PRACTICE_PLAN.md §15–§16).
   Loaded by the home page only (index.html), after kv.js, srs.js and review.js.
   Items: the practice banks of the dist branch (practice.<bank>.json: shared foundations and each course's own items),
     downloaded by kv.js into the notes cache with their maths already drawn (SVG), so nothing is typeset here.
   One queue a day: foundation items (about 70%), then course items, then my highlight cards (review.js, kind "highlight").
     The day's plan is fixed when I start ('kv:practiceDay'), so a reload or a pause resumes where I was. It stops at
     "Done for today": nothing carries over, and after missed days the plan is 2 lapsed + 3 easy items, never a pile.
   Results: every answer is one attempt in the append-only log (srs.js → practice/device-<name>/<yyyy-mm>.json). Where
     each item stands (interval, due day) is recomputed from the log, so devices can never disagree about it.
   Grading → schedule: right and sure ×2.5 · right, unsure ×1.5 · right but guessed: tomorrow · wrong: tomorrow, and
     wrong-and-sure adds a sibling item of the same rule at the end of today. "Unclear question" undoes the schedule
     effect of that answer and flags the item for the next session. */
(function () {
  'use strict';
  const KV = window.KV, SRS = KV.srs, RV = KV.review;
  const DAY_KEY = 'kv:practiceDay', NOTES_CACHE = 'kv-notes';
  const DEF = { minutes: 12, shortDay: 3, maxItems: 8, maxNewRules: 2, maxHighlights: 6, phases: [] };
  let B = { key: null, items: new Map(), rules: new Map(), banks: [], defs: [] };

  const idx = () => (KV.distState().index || {}).practice || null;
  const cfg = () => Object.assign({}, DEF, (idx() || {}).config || {});
  const courses = () => (idx() || {}).courses || {};

  /** The banks on this device, read once per build from the notes cache. */
  async function load() {
    const p = idx(), have = KV.cachedPractice(), key = JSON.stringify([have, p && p.courses]);
    if (B.key === key) return B;
    const out = { key, items: new Map(), rules: new Map(), banks: [], defs: [] };
    if (p && window.caches) {
      const cache = await caches.open(NOTES_CACHE), used = new Set();
      Object.entries(p.courses || {}).forEach(([cid, c]) => { used.add(cid); (c.foundations || []).forEach(f => used.add(f)); });
      for (const b of p.banks || []) {
        if (!have[b.id] || !used.has(b.id)) continue;   // a bank counts once a course's practice settings name it
        let doc = null; try { const r = await cache.match(KV.practiceUrl(b.id)); doc = r ? await r.json() : null; } catch (e) {}
        if (!doc || doc.format !== 'kv-practice') continue;
        out.banks.push({ id: doc.id, kind: doc.kind, title: doc.title }); if (doc.defs) out.defs.push(doc.defs);
        Object.entries(doc.rules || {}).forEach(([id, r]) => out.rules.set(id, Object.assign({ id, bank: doc.id }, r)));
        (doc.items || []).forEach(it => out.items.set(it.id, Object.assign({ bank: doc.id, bankKind: doc.kind, bankTitle: doc.title }, it)));
      }
    }
    B = out; return B;
  }

  /* ---------- where each item stands: replayed from the attempt log ---------- */
  function examOf(it) {   // the nearest exam ahead among the courses that use the item
    if (!it) return null;
    const cs = courses(), day = SRS.today();
    const dates = Object.entries(cs).filter(([cid, c]) => it.bankKind === 'course' ? cid === it.bank : (c.foundations || []).includes(it.bank)).map(([, c]) => c.examDate).filter(d => d && d >= day).sort();
    return dates[0] || null;
  }
  const gradeOf = a => !a.right ? 'again' : a.conf === 'sure' ? 'good' : a.conf === 'unsure' ? 'ok' : 'hard';
  /** { item id: { ivl, due, last, lastDay, n, lapses, first, right, conf, unclear } } */
  function states(log) {
    const st = {}, prev = {};
    (log || SRS.logAll()).forEach(a => {
      if (!a.item) return;
      if (a.flag === 'unclear') {   // the answer before it does not count for the schedule
        if (a.item in prev) { if (prev[a.item]) st[a.item] = prev[a.item]; else delete st[a.item]; }
        return;
      }
      if (a.flag) return;
      const cur = st[a.item] || null; prev[a.item] = cur ? Object.assign({}, cur) : null;
      const r = SRS.schedule(cur, gradeOf(a), SRS.examCap(a.day, examOf(B.items.get(a.item))));
      st[a.item] = { ivl: r.ivl, due: SRS.addDays(a.day, Math.max(1, r.days)), last: a.t, lastDay: a.day, n: (cur ? cur.n : 0) + 1,
                     lapses: (cur ? cur.lapses : 0) + (a.right ? 0 : 1), first: cur ? cur.first : a.day, right: !!a.right, conf: a.conf };
    });
    return st;
  }
  const answers = log => (log || SRS.logAll()).filter(a => a.item && !a.flag);
  /** A rung-2 item waits until a rung-1 item of its rule was right; rung 3 waits for rung 2 (plan §15.1, item 6). */
  function rungOpen(it, st) {
    if (!it.rule || it.rung <= 1) return true;
    const lower = [...B.items.values()].filter(o => o.rule === it.rule && o.rung < it.rung);
    if (!lower.length) return true;
    const top = Math.max(...lower.map(o => o.rung));   // the rung just below, among those that exist
    return lower.some(o => o.rung === top && st[o.id] && st[o.id].right);
  }

  /* ---------- the day's plan ---------- */
  const dayRec = () => { const r = KV.read(DAY_KEY, null); return r && r.day === SRS.today() ? r : null; };
  const saveRec = r => KV.write(DAY_KEY, r);
  function plan(short) {
    const c = cfg(), day = SRS.today(), log = SRS.logAll(), st = states(log), all = [...B.items.values()].filter(it => rungOpen(it, st));
    const ruleOrder = it => { const r = B.rules.get(it.rule); return r && r.order != null ? r.order : 999; };
    const key = it => [it.bankKind === 'foundation' ? 0 : 1, ruleOrder(it), it.rule || it.concept || '', it.rung, it.id];
    const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
    const due = all.filter(it => st[it.id] && st[it.id].due <= day).sort((a, b) => st[a.id].due.localeCompare(st[b.id].due) || st[a.id].last - st[b.id].last);
    const seenRules = new Set(answers(log).map(a => a.rule).filter(Boolean)), newRules = new Set(), perRule = {};
    const fresh = all.filter(it => !st[it.id]).sort(cmp).filter(it => {   // at most 2 new rules a day, and 2 new items of one rule
      if (!it.rule) return true;
      if (!seenRules.has(it.rule) && !newRules.has(it.rule)) { if (newRules.size >= c.maxNewRules) return false; newRules.add(it.rule); }
      perRule[it.rule] = (perRule[it.rule] || 0) + 1; return perRule[it.rule] <= 2;
    });
    const N = short ? c.shortDay : c.maxItems, isF = it => it.bankKind === 'foundation', days = answers(log).map(a => a.day).filter(d => d < day).sort();
    const lastDay = days[days.length - 1] || null, picks = [], has = it => picks.includes(it), add = it => { if (it && !has(it) && picks.length < N) picks.push(it); };
    if (lastDay && SRS.daysFrom(lastDay, day) >= 2) {   // after missed days: 2 lapsed + 3 easy items, never an overdue count
      due.filter(it => !st[it.id].right).slice(0, 2).forEach(add);
      due.filter(it => st[it.id].right).sort((a, b) => st[b.id].ivl - st[a.id].ivl).slice(0, 3).forEach(add);
      const n = Math.min(N, 5); due.concat(fresh).forEach(it => { if (picks.length < n) add(it); });
      return { ids: picks.map(it => it.id), missed: true };
    }
    const share = Math.max(0, Math.min(1, Math.max(...Object.values(courses()).map(x => +x.foundationShare || 0), 0) || 0.7));
    const side = (f, quota) => { const out = [], list = due.filter(it => isF(it) === f).concat(fresh.filter(it => isF(it) === f)); list.forEach(it => { if (out.length < quota) out.push(it); }); return out; };
    let F = side(true, Math.round(share * N)), C = side(false, N - F.length);
    if (F.length + C.length < N) F = side(true, N - C.length);
    if (!F.some(it => it.kind === 'first-move')) {   // one "first move?" item a day, when one is waiting
      const fm = due.concat(fresh).find(it => isF(it) && it.kind === 'first-move');
      if (fm && F.length) F[F.length - 1] = fm;
    }
    F.concat(C).forEach(add);
    return { ids: picks.map(it => it.id), missed: false };
  }
  /** Starts today (or widens a short day into the full one). Returns the day's record. */
  function start(short) {
    let r = dayRec();
    if (!r) { const p = plan(short); r = { day: SRS.today(), short: !!short, ids: p.ids, extra: [], rules: {}, moreHl: 0, missed: p.missed }; }
    else if (r.short && !short) { const p = plan(false); r.short = false; p.ids.forEach(id => { if (!r.ids.includes(id) && r.ids.length < cfg().maxItems) r.ids.push(id); }); }
    saveRec(r); return r;
  }
  /** "More highlights": widens today's share of highlight cards. */
  function more() { const r = dayRec() || start(false); r.moreHl = (r.moreHl || 0) + cfg().maxHighlights; saveRec(r); return r; }
  const doneToday = () => { const day = SRS.today(); return new Set(answers().filter(a => a.day === day).map(a => a.item)); };
  function left(r) { const done = doneToday(); return r.ids.concat(r.extra || []).filter(id => B.items.has(id) && !done.has(id)).map(id => B.items.get(id)); }
  /** The highlight cards that belong to today: with practice items on the device they share the daily budget
      (maxHighlights, more() widens it); alone, they keep the review rule (everything due, 10 new a day). */
  function hlLeft(r) {
    const q = RV.queue(), day = SRS.today(), failed = c => c.state && !c.state.ivl && c.state.due === day;
    if (!B.items.size) return { list: q.list, waiting: 0 };
    if (!r) return { list: [], waiting: q.list.length };
    const cap = (r.short ? 0 : cfg().maxHighlights) + (r.moreHl || 0), wait = q.list.filter(c => !failed(c)), room = Math.max(0, cap - RV.gradedToday());
    return { list: wait.slice(0, room).concat(q.list.filter(failed)), waiting: Math.max(0, wait.length - room) };
  }
  /** What comes now: { type: 'rule', rule, item } (the card of a rule I have never met, once), { type: 'item', item },
      { type: 'highlight', card }, or null when today is done. */
  function next() {
    const r = dayRec(); if (!r) return null;
    const l = left(r);
    if (l.length) {
      const it = l[0], rule = it.rule && B.rules.get(it.rule);
      if (rule && !r.rules[it.rule] && !answers().some(a => a.rule === it.rule)) return { type: 'rule', rule, item: it };
      return { type: 'item', item: it };
    }
    const h = hlLeft(r).list;
    return h.length ? { type: 'highlight', card: h[0] } : null;
  }
  function ruleShown(id) { const r = dayRec(); if (r) { r.rules[id] = 1; saveRec(r); } }

  /* ---------- answering ---------- */
  const steps = it => it.entries.map((e, i) => [e.m, i]).filter(x => /^\d+$/.test(x[0])).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const sizeOf = s => String(s || '').toLowerCase().replace(/×|\*/g, 'x').replace(/\s+/g, '');
  /** Is this pick right? mc, first-move, spot-error: the entry's index · tf: { v, r } · shape: one size per entry · route: entry indices in my order. */
  function grade(it, pick) {
    const E = it.entries;
    if (it.kind === 'tf') return !!pick && pick.v === it.answer && !!E[pick.r] && E[pick.r].m === 'x';
    if (it.kind === 'shape') return Array.isArray(pick) && E.every((e, i) => sizeOf(pick[i]) === sizeOf(e.m));
    if (it.kind === 'route') return Array.isArray(pick) && JSON.stringify(pick) === JSON.stringify(steps(it));
    return !!E[pick] && E[pick].m === 'x';
  }
  /** A right pick for the item (the tests answer with it). */
  function keyPick(it) {
    const x = it.entries.findIndex(e => e.m === 'x');
    return it.kind === 'tf' ? { v: it.answer, r: x } : it.kind === 'shape' ? it.entries.map(e => e.m) : it.kind === 'route' ? steps(it) : x;
  }
  /** I answered: one attempt goes into the log. Wrong and sure: a sibling item of the same rule joins the end of today. */
  function answer(it, pick, conf, ms) {
    const right = grade(it, pick), r = dayRec() || start(false);
    const a = SRS.logAdd({ item: it.id, rule: it.rule, kind: it.kind, rung: it.rung, pick, right, conf, ms: Math.round(ms || 0), short: r.short || undefined });
    let sibling = null;
    if (!right && conf === 'sure') {
      const done = doneToday(), inPlan = new Set(r.ids.concat(r.extra || []));
      sibling = [...B.items.values()].filter(o => o.id !== it.id && !done.has(o.id) && !inPlan.has(o.id) && (it.rule ? o.rule === it.rule : o.concept && o.concept === it.concept))
        .sort((x, y) => Math.abs(x.rung - it.rung) - Math.abs(y.rung - it.rung) || x.id.localeCompare(y.id))[0] || null;
      if (sibling) { r.extra = (r.extra || []).concat(sibling.id); saveRec(r); }
    }
    return { right, attempt: a, sibling };
  }
  const unclear = it => SRS.logAdd({ item: it.id, rule: it.rule, flag: 'unclear' });

  /** The order in which an item's entries are shown: shuffled the same way all day (mc, first-move, tf reasons, route); as written otherwise. */
  function order(it) {
    const n = it.entries.length, out = [...Array(n).keys()];
    if (it.kind === 'spot-error' || it.kind === 'shape') return out;
    let h = 2166136261; for (const ch of it.id + SRS.today()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const rnd = () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }

  /* ---------- what the home page shows ---------- */
  function phase() {
    const day = SRS.today(), p = (cfg().phases || []).find(x => x && x.from <= day && (!x.to || day <= x.to));
    return p ? { name: p.name, n: SRS.daysFrom(p.from, day) + 1, of: p.to ? SRS.daysFrom(p.from, p.to) + 1 : null } : null;
  }
  /** Today in numbers (after load()). */
  function summary() {
    const r = dayRec(), day = SRS.today(), todays = answers().filter(a => a.day === day), c = cfg();
    const ids = r ? r.ids.concat(r.extra || []).filter(id => B.items.has(id)) : plan(false).ids, rest = r ? left(r).length : ids.length;
    const h = hlLeft(r), hq = RV.queue(), hlPlanned = r ? h.list.length : (B.items.size ? Math.min(h.waiting, c.maxHighlights) : h.list.length);
    const tags = {}; todays.filter(a => !a.right).forEach(a => ((B.items.get(a.item) || {}).tags || []).forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
    return { day, phase: phase(), started: !!r, short: !!(r && r.short), missed: !!(r && r.missed), any: B.items.size > 0 || hq.total > 0,
             items: ids.length, left: rest, hl: hlPlanned, hlWaiting: r ? h.waiting : 0, hlNext: hq.next, hlHeld: hq.held,
             answered: todays.length, right: todays.filter(a => a.right).length, wrongSure: todays.filter(a => !a.right && a.conf === 'sure').length,
             worstTag: Object.keys(tags).sort((a, b) => tags[b] - tags[a])[0] || null,
             moreItems: r && r.short ? plan(false).ids.filter(id => !r.ids.includes(id)).length : 0,
             finished: !!r && !rest && !h.list.length, minutes: Math.max(1, Math.ceil((rest * 50 + hlPlanned * 25) / 60)) };
  }

  KV.practice = { load, cfg, courses, phase, states, plan, start, more, next, ruleShown, grade, keyPick, answer, unclear, order, summary, dayRec, steps,
                  bank: () => B, sync: SRS.logSync, DAY_KEY };
})();
