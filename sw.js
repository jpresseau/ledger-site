/* The Ledger — service worker.

   Network-first with a cache fallback. Online you always get the freshly
   deployed file (no stale-copy trap); offline the last good copy still opens,
   which is the point of having it on a phone.

   Deliberately narrow: it only ever touches same-origin GETs inside its own
   /ledger/ scope. Receipt reads POST to api.anthropic.com and must reach the
   network untouched, so cross-origin and non-GET requests are never handled. */

var VERSION = 'ledger-v2';
var SHELL = ['./', './index.html', './manifest.webmanifest',
             './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.svg',
             /* v1978: the maskable one was the one left out, and it is the icon Android puts on
                the home screen - so the installed app lost exactly the icon it is installed with. */
             './icon-maskable-512.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(function (c) {
    /* addAll is atomic — one 404 would abort the whole install, and a missing
       icon should not cost us the app shell. */
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }));
});

/* v2081: OURS ONLY. caches.keys() is ORIGIN-WIDE, and six apps share this origin - so this
   swept every cache on it and deleted RC Garage's, HighWall's, Brood Wars' and First Light's
   shell on every single Ledger deploy, costing all four their offline copy. Reproduced in
   Chromium by review. The header above this file already claimed the opposite ("deliberately
   narrow: it only ever touches same-origin GETs inside its own /ledger/ scope") and the fetch
   handler is narrow; these two sweeps never were. Same fault the launcher's teardown was fixed
   for at v1973 - that pass reached the other apps' workers and missed this one entirely, and
   this file's own note is what stopped anybody re-checking. A prefix, because a cache name is
   the only thing a worker can tell its own by. */
var MINE = 'ledger-';
function ledgerCaches(keys) {
  return keys.filter(function (k) { return k.indexOf(MINE) === 0; });
}
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(ledgerCaches(keys).map(function (k) {
      return k === VERSION ? null : caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                        /* API POSTs pass through */
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;         /* api.anthropic.com etc. */
  if (url.pathname.indexOf(new URL('./', self.location).pathname) !== 0) return;
  /* Ledger Cloud's API, where the service serves this page from its own origin
     (server/cloud/web.py): never touched. Its answers are account data and the
     book's ciphertext, and one cached here and replayed offline would be a stale
     manifest the sync engine trusts. A signed request is never ours either. */
  if (url.pathname.indexOf('/v1/') === 0 || req.headers.has('authorization')) return;

  /* `fetch(req)` obeys the browser's own HTTP cache, and Pages serves this file
     with max-age=600 — so "network-first" quietly meant "up to ten minutes
     stale", and no amount of purging the worker's cache helped, because the
     stale copy lived a layer below it. `no-cache` still sends the conditional
     request (a 304 is cheap) but never serves an unrevalidated copy. */
  /* A navigate-mode Request cannot carry an init through the Request
     constructor without silently losing its mode, so navigations are refetched
     by URL instead. Everything else keeps its original Request. */
  var fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'follow' })
    : fetch(req, { cache: 'no-cache' });

  e.respondWith(
    fresh.then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        /* Keyed WITHOUT the query string. The app polls build.txt?t=<time> to
           notice a deploy, and every poll was stored as a new entry — the cache
           grew by one copy per check, for ever. A deep link (?view=receipts)
           is the same page, so it is one entry too. */
        caches.open(VERSION).then(function (c) { c.put(url.origin + url.pathname, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        /* A navigation to any in-scope URL falls back to the cached shell so
           deep links (?view=receipts) still open with no signal. */
        return hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined);
      });
    })
  );
});

/* The in-app ⟳ Refresh button asks for a clean slate before reloading. */
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'PURGE') return;
  /* ...and the same here. A clean slate means THIS app's, not the origin's. */
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(ledgerCaches(keys).map(function (k) { return caches.delete(k); }));
  }).then(function () {
    return self.clients.matchAll().then(function (cs) {
      cs.forEach(function (c) { c.postMessage({ type: 'PURGED' }); });
    });
  }));
});
