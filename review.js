/* Knowledge-Verse reading app: my highlights as cards (I-52; since I-56 they are the kind "highlight" of the Today queue).
   Loaded by the home page only (index.html), after kv.js and srs.js.
   Cards: every live highlight of mine in the categories Key Takeaways (cat-blue) and Prove by hand (cat-green), read from each
     course's annotation store in this browser (the engine's autosave slot '<id>-kb:v3'; same origin). A highlight that is
     deleted or resolved is no longer in its store, so its card is gone. Nothing here ever writes to a store.
   Front of a card: course, concept (index.json → toc), and the block's type and title, read from the offline copy of the course
     page and remembered per build ('kv:reviewMeta'); the course's math macros come from the same place.
   Schedule, day and sync: srs.js (KV.srs.schedule is the whole rule; a day starts at 4 am).
   State: 'kv:review' in this browser, local-first. This device's file review/device-<name>.json (repo root, branch main) is
     written only after I graded a card here; every device's file is merged per card, the newest review wins. Those files are
     mine: sessions never edit them (review/README.md). Design: docs/READING_APP.md §1 in the Knowledge-Verse repo. */
(function () {
  'use strict';
  const KV = window.KV;
  const CATS = { 'cat-blue': { label: 'Key Takeaways', color: '#bfdbfe' }, 'cat-green': { label: 'Prove by hand', color: '#bbf7d0' } };
  const SRS = KV.srs, PROVE = 'cat-green', NEW_PER_DAY = 10, CAP_DAYS = SRS.CAP_DAYS;
  const KEY = 'kv:review', MKEY = 'kv:reviewMeta', DIR = 'review', NOTES_CACHE = 'kv-notes';
  const R = { get now() { return SRS.now; }, set now(f) { SRS.now = f; } };   // one clock (srs.js); the tests move it
  const { schedule, today, addDays, daysFrom } = SRS;

  /* ---------- state in this browser ---------- */
  function state() {
    const s = Object.assign({ cards: {}, seen: {}, sha: null, dirty: false }, KV.read(KEY, {}));
    if (!s.cards || typeof s.cards !== 'object') s.cards = {};
    if (!s.seen || typeof s.seen !== 'object') s.seen = {};
    return s;
  }
  const save = s => KV.write(KEY, s);

  /* ---------- cards: my blue and green highlights, from every course's store in this browser ---------- */
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const courses = () => ((KV.distState().index || {}).courses || []);
  const byColor = col => Object.keys(CATS).find(k => CATS[k].color === String(col || '').toLowerCase());
  function legend() {   // my names and colours for the two categories (the one legend, D-25), else the standard ones
    const out = {}, L = KV.read('kb:legend', {}), cats = (L && Array.isArray(L.categories)) ? L.categories : [];
    Object.keys(CATS).forEach(id => { const c = cats.find(x => x && x.id === id) || {}; out[id] = { label: norm(c.label) || CATS[id].label, color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : CATS[id].color }; });
    return out;
  }
  /** { live: [{ id, course, cat, item }], gone: { cardId: 1 } }  (gone: highlights this browser knows were deleted or resolved) */
  function cards() {
    const live = [], gone = {};
    courses().forEach(c => {
      const s = KV.read(c.id + '-kb:v3', null); if (!s || !Array.isArray(s.items)) return;
      const del = s.deleted || {}, here = new Set();
      s.items.forEach(it => {
        if (!it || !it.id || !it.target || (it.kind && it.kind !== 'highlight')) return;
        const cat = CATS[it.cat] ? it.cat : (!it.cat && byColor(it.color)) || null;
        if (!cat || !norm(it.target.exact) || del[it.id] >= (it.updated || 0)) return;
        here.add(it.id); live.push({ id: c.id + '/' + it.id, course: c, cat, item: it });
      });
      Object.keys(del).forEach(k => { if (!here.has(k)) gone[c.id + '/' + k] = 1; });
    });
    return { live, gone };
  }

  /** What to review now (list): due cards first, longest overdue first; then new cards, at most NEW_PER_DAY a day on all my
      devices together, the oldest highlight of each course in turn; last, the cards I failed today, so they come back in
      the same sitting after everything else. */
  function queue() {
    const st = state(), day = today(), due = [], fresh = [], later = [];
    cards().live.forEach(c => { const s = st.cards[c.id]; c.state = s || null; (!s ? fresh : s.due <= day ? due : later).push(c); });
    due.sort((a, b) => a.state.due.localeCompare(b.state.due) || (a.state.last || 0) - (b.state.last || 0));
    later.sort((a, b) => a.state.due.localeCompare(b.state.due));
    // the order of new cards: each course in turn, its oldest highlight first. The cards started today keep their place in
    // the turns, so the order does not change as I go through them.
    const turn = {}, age = (a, b) => (a.item.created || 0) - (b.item.created || 0);
    fresh.concat(due, later).filter(c => !c.state || c.state.first === day).sort(age).forEach(c => { c.turn = turn[c.course.id] = (turn[c.course.id] || 0) + 1; });
    fresh.sort((a, b) => a.turn - b.turn || age(a, b));
    const started = Object.values(st.cards).filter(s => s && s.first === day).length, room = Math.max(0, NEW_PER_DAY - started);
    const next = later.length ? { day: later[0].state.due, inDays: daysFrom(day, later[0].state.due), n: later.filter(c => c.state.due === later[0].state.due).length } : null;
    const failed = c => !c.state.ivl && c.state.due === day, start = fresh.slice(0, room);
    return { day, due, fresh: start, list: due.filter(c => !failed(c)).concat(start, due.filter(failed)), held: Math.max(0, fresh.length - room), later: later.length, next,
             total: due.length + fresh.length + later.length };
  }

  /** I graded a card: 'again', 'good' or 'easy'. Only this starts a write to GitHub. */
  function grade(id, g) {
    const st = state(), day = today(), prev = st.cards[id] || null, r = schedule(prev, g);
    st.cards[id] = { ivl: r.ivl, due: addDays(day, r.days), last: SRS.now(), n: ((prev && prev.n) || 0) + 1,
                     lapses: ((prev && prev.lapses) || 0) + (g === 'again' ? 1 : 0), first: (prev && prev.first) || day };
    st.dirty = true; save(st);
    return st.cards[id];
  }
  const span = d => d <= 0 ? 'today' : d < 30 ? d + (d === 1 ? ' day' : ' days') : Math.round(d / 30) + ' mo';
  /** What each button would do to this card, for its label. */
  const preview = card => ({ good: span(schedule(card.state, 'good').days), easy: span(schedule(card.state, 'easy').days) });

  /* ---------- what a card shows: block type and title, and the course's macros, from the offline copy of the course ---------- */
  // the engine's names for the block types (kb_shell.html, TYPE_LABEL)
  const TYPE = { why: 'Why this matters', idea: 'Idea', definition: 'Definition', theorem: 'Theorem', proposition: 'Proposition', lemma: 'Lemma', corollary: 'Corollary', fact: 'Fact',
    example: 'Example', nonexample: 'Non-example', counterexample: 'Counterexample', edgecase: 'Edge case', misconception: 'Misconception', subtlety: 'Subtlety', assumption: 'Assumption',
    convention: 'Convention', remark: 'Remark', walk: 'Walkthrough', step: 'Step', computation: 'Computation', figure: 'Figure', proof: 'Proof', connection: 'Connection' };
  const typeName = t => TYPE[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');
  const HLX = /^(title|summary|btitle):(.*)$/;   // a highlight on a concept's title or summary, or on a block's title
  const fileOf = t => typeof t.concept === 'string' && t.concept.startsWith('file:') ? t.concept.slice(5) : null;
  function blockId(card) { const t = card.item.target, x = HLX.exec(t.block || ''); return fileOf(t) ? null : x ? (x[1] === 'btitle' ? x[2] : null) : (t.block || null); }
  const decode = s => { const ta = document.createElement('textarea'); ta.innerHTML = s; return ta.value; };
  /** { macros, blocks: { id: [type, title, proves] | null } } for a card's course; reads the course page once per build. */
  async function meta(card) {
    const cid = card.course.id, bid = blockId(card), sha = (KV.cachedShas() || {})[cid] || '', all = KV.read(MKEY, {}), m = all[cid];
    if (m && m.sha === sha && m.blocks && (!bid || bid in m.blocks)) return m;
    const out = (m && m.sha === sha && m.blocks) ? m : { sha, macros: {}, blocks: {} };
    let html = '';
    try { const r = sha && await (await caches.open(NOTES_CACHE)).match(KV.courseUrl(cid)); html = r ? await r.text() : ''; } catch (e) {}
    if (!html) return out;   // the course is not on this device: the card shows its concept only
    const cfg = /<script type="application\/json" id="kb-config">([\s\S]*?)<\/script>/.exec(html);
    try { out.macros = (cfg && JSON.parse(cfg[1]).macros) || {}; } catch (e) {}
    const map = new Map(), tag = /<[a-z]+ class="blk[^"]*"[^>]*>/g;
    for (let t; (t = tag.exec(html));) {
      const a = n => { const x = new RegExp('\\sdata-' + n + '="([^"]*)"').exec(t[0]); return x ? decode(x[1]) : ''; };
      if (a('id')) map.set(a('id'), [a('type'), a('title'), a('for')]);
    }
    const want = id => { if (!id || id in out.blocks) return; const b = map.get(id) || null; out.blocks[id] = b; if (b && b[2]) want(b[2]); };
    want(bid);
    if (!cfg) return out;   // not a page of the engine as I know it: do not remember a guess
    all[cid] = out; KV.write(MKEY, all);
    return out;
  }
  /** The words and the link of a card. m: meta(card). Text only; the page escapes it. */
  function describe(card, m) {
    const it = card.item, t = it.target, c = card.course, L = legend()[card.cat], file = fileOf(t), x = HLX.exec(t.block || '');
    const blocks = (m && m.blocks) || {}, bid = blockId(card), b = bid ? blocks[bid] : null, prove = card.cat === PROVE;
    const entry = (c.toc || []).find(e => e.id === t.concept), enc = encodeURIComponent;
    let concept = file ? 'My file: ' + file : entry ? entry.title : (t.concept || ''), where = '';
    if (x && x[1] === 'title') { concept = entry && entry.area ? 'A concept in ' + entry.area : 'A concept'; where = 'Its title'; }
    else if (x && x[1] === 'summary') where = 'Its one-line summary';
    else if (b) {
      const of = b[0] === 'proof' && b[2] && blocks[b[2]];
      where = of ? 'Proof of ' + typeName(of[0]).toLowerCase() + (of[1] ? ': ' + of[1] : '') : typeName(b[0]) + (b[1] ? ': ' + b[1] : '');
      if (x) where = 'Title of ' + (b[0] ? typeName(b[0]).toLowerCase() : 'a block');
    }
    let hash = '#/p/home';
    if (file) hash = '#/kvfile/' + enc(file) + (t.block ? '/' + enc(t.block) : '');
    else if (t.concept) {
      const stay = prove && b && b[0] === 'proof';   // a proof to do by hand: open its statement, the proof stays closed
      hash = '#/c/' + enc(t.concept) + (x || !bid || it.orphan ? '' : stay ? (b[2] ? '/' + enc(b[2]) : '') : '/' + enc(bid));
    }
    return { code: c.code, cat: L.label, color: L.color, prove, isNew: !card.state, concept, where,
      ask: prove ? 'Prove it on paper. Then check your proof against the notes.' : 'What did you mark here? Say it, then check.',
      text: String(t.exact || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), comment: String(it.comment || '').trim(),
      orphan: !!it.orphan, href: KV.courseUrl(c.id) + hash,
      link: prove ? 'Open the statement in the notes (proof closed)' : 'Open in the notes', macros: (m && m.macros) || {} };
  }

  /* ---------- math: the app's own MathJax, loaded only when a card has a formula ---------- */
  let mj = null, mjMacros = '', chain = Promise.resolve();
  /** Typesets el (a fresh element, never one typeset before) with a course's macros. Resolves true when math was drawn. */
  function typeset(el, macros) {
    if (!el || !/\\\(|\\\[/.test(el.textContent)) return Promise.resolve(false);
    const key = JSON.stringify(macros || {});
    if (!mj) mj = new Promise(res => {
      mjMacros = key;
      window.MathJax = { tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']], macros: macros || {} }, startup: { typeset: false } };
      const s = document.createElement('script'); s.src = new URL('mathjax/es5/tex-mml-chtml.js', KV.root).href; s.async = true;
      s.onload = () => Promise.resolve(window.MathJax.startup && window.MathJax.startup.promise).then(() => res(true), () => res(false));
      s.onerror = () => res(false);   // not there (a copy of the app without MathJax): the formula stays as typed
      document.head.appendChild(s);
    });
    chain = chain.then(() => mj).then(ok => {
      if (!ok || !el.isConnected) return false;
      if (key !== mjMacros) { window.MathJax.config.tex.macros = macros || {}; window.MathJax.startup.getComponents(); window.MathJax.startup.makeMethods(); mjMacros = key; }   // another course: its macros
      return window.MathJax.typesetPromise([el]).then(() => true, () => false);
    }).catch(() => false);
    return chain;
  }

  /* ---------- sync: review/device-<name>.json, one file per device (the mechanism is srs.js → cardSync) ---------- */
  const DAYRE = SRS.DAYRE;
  function mergeCards(into, from) {   // per card, the newest review wins
    let n = 0;
    Object.entries(from && typeof from === 'object' ? from : {}).forEach(([id, c]) => {
      if (!c || !DAYRE.test(c.due || '') || typeof c.last !== 'number') return;
      const cur = into[id]; if (cur && (cur.last || 0) >= c.last) return;
      into[id] = { ivl: +c.ivl || 0, due: c.due, last: c.last, n: +c.n || 1, lapses: +c.lapses || 0, first: DAYRE.test(c.first || '') ? c.first : c.due }; n++;
    });
    return n;
  }
  function fileText(s) {   // one card per line: small, and readable in the repo's history
    const ids = Object.keys(s.cards).sort();
    return '{\n "format": "kv-review", "schema": 1,\n "savedAt": ' + JSON.stringify(new Date().toISOString()) + ', "savedBy": ' + JSON.stringify('reading app, device ' + KV.settings().device) +
      ',\n "cards": {' + (ids.length ? '\n' + ids.map(id => '  ' + JSON.stringify(id) + ': ' + JSON.stringify(s.cards[id])).join(',\n') + '\n ' : '') + '}\n}\n';
  }
  /** Merges every device's file into this browser; writes this device's file only if I graded a card here since the last
      write. Resolves with the number of cards that changed here because of another device. */
  const sync = SRS.cardSync({ dir: DIR, state, save, merge: mergeCards, text: fileText,
    prune: s => { const gone = cards().gone; Object.keys(s.cards).forEach(id => { if (gone[id]) delete s.cards[id]; }); },   // a deleted or resolved highlight has no card
    message: s => { const n = Object.keys(s.cards).length; return 'Review from ' + KV.settings().device + ' (' + n + ' card' + (n === 1 ? '' : 's') + ')'; } });

  /** How many different cards I graded today (the Today queue's daily share of highlights counts them). */
  const gradedToday = () => { const day = today(); return Object.values(state().cards).filter(c => c && SRS.dayOf(c.last || 0) === day).length; };

  KV.review = Object.assign(R, { CATS, gradedToday, NEW_PER_DAY, CAP_DAYS, schedule, today, state, cards, queue, grade, preview, meta, describe, typeset, sync });
})();
