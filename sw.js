/* Knowledge-Verse reading app: service worker (offline).
   - The app itself (pages, scripts, icons, the MathJax copy) is cached at install, under a name that changes
     with every published version, so a new version replaces the old one in one step.
   - Course pages read/<id>.html are never on the server: kv.js stores them in the 'kv-notes' cache after
     downloading them from the private repo, and this worker serves them from there.
   - Requests to other sites (api.github.com) are not touched.
   tools/publish_app.py fills in the version and the file list when it publishes the app. */
const VERSION = "2026-10-09-a3626a82";
const APP_CACHE = 'kv-app-' + VERSION;
const NOTES_CACHE = 'kv-notes';
const PRECACHE = [
"./",
"host.js",
"icon-192.png",
"icon-512.png",
"icon.svg",
"index.html",
"kv.js",
"manifest.webmanifest",
"mathjax/LICENSE",
"mathjax/es5/input/tex/extensions/action.js",
"mathjax/es5/input/tex/extensions/all-packages.js",
"mathjax/es5/input/tex/extensions/ams.js",
"mathjax/es5/input/tex/extensions/amscd.js",
"mathjax/es5/input/tex/extensions/autoload.js",
"mathjax/es5/input/tex/extensions/bbox.js",
"mathjax/es5/input/tex/extensions/boldsymbol.js",
"mathjax/es5/input/tex/extensions/braket.js",
"mathjax/es5/input/tex/extensions/bussproofs.js",
"mathjax/es5/input/tex/extensions/cancel.js",
"mathjax/es5/input/tex/extensions/cases.js",
"mathjax/es5/input/tex/extensions/centernot.js",
"mathjax/es5/input/tex/extensions/color.js",
"mathjax/es5/input/tex/extensions/colortbl.js",
"mathjax/es5/input/tex/extensions/colorv2.js",
"mathjax/es5/input/tex/extensions/configmacros.js",
"mathjax/es5/input/tex/extensions/empheq.js",
"mathjax/es5/input/tex/extensions/enclose.js",
"mathjax/es5/input/tex/extensions/extpfeil.js",
"mathjax/es5/input/tex/extensions/gensymb.js",
"mathjax/es5/input/tex/extensions/html.js",
"mathjax/es5/input/tex/extensions/mathtools.js",
"mathjax/es5/input/tex/extensions/mhchem.js",
"mathjax/es5/input/tex/extensions/newcommand.js",
"mathjax/es5/input/tex/extensions/noerrors.js",
"mathjax/es5/input/tex/extensions/noundefined.js",
"mathjax/es5/input/tex/extensions/physics.js",
"mathjax/es5/input/tex/extensions/require.js",
"mathjax/es5/input/tex/extensions/setoptions.js",
"mathjax/es5/input/tex/extensions/tagformat.js",
"mathjax/es5/input/tex/extensions/textcomp.js",
"mathjax/es5/input/tex/extensions/textmacros.js",
"mathjax/es5/input/tex/extensions/unicode.js",
"mathjax/es5/input/tex/extensions/upgreek.js",
"mathjax/es5/input/tex/extensions/verb.js",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_AMS-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Calligraphic-Bold.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Calligraphic-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Fraktur-Bold.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Fraktur-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Main-Bold.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Main-Italic.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Main-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Math-BoldItalic.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Math-Italic.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Math-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_SansSerif-Bold.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_SansSerif-Italic.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_SansSerif-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Script-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Size1-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Size2-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Size3-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Size4-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Typewriter-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Vector-Bold.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Vector-Regular.woff",
"mathjax/es5/output/chtml/fonts/woff-v2/MathJax_Zero.woff",
"mathjax/es5/tex-mml-chtml.js",
"sw.js"
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(PRECACHE.map(p => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('kv-app-') && k !== APP_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const scope = () => new URL(self.registration.scope);
function notDownloaded(id) {
  const html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Not downloaded</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 16px">' +
    '<h1 style="font-size:1.3em">' + id.replace(/[<&]/g, '') + ' is not on this device yet</h1>' +
    '<p>Open the app home while online: it downloads the notes, and they then work offline.</p><p><a href="../index.html">Go to the app home</a></p>';
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scope().pathname)) return;
  const rel = url.pathname.slice(scope().pathname.length);
  if (/^read\/[^/]+\.html$/.test(rel)) {   // a course page: only ever from the notes cache
    const key = new URL(url.pathname, url.origin).href;
    e.respondWith(caches.open(NOTES_CACHE).then(c => c.match(key)).then(r => r || notDownloaded(decodeURIComponent(rel.slice(5, -5)))));
    return;
  }
  // the app's own files: cache first (they change only with a new version), network as a fallback
  e.respondWith(caches.match(e.request, { ignoreSearch: true, cacheName: APP_CACHE })
    .then(r => r || fetch(e.request).catch(() => (rel === '' || rel === 'index.html') ? caches.match('index.html', { cacheName: APP_CACHE }) : Response.error())));
});
