/* =====================================================================
   Satellite Depot Manager — Service Worker (offline shell, Phase 8)
   =====================================================================
   How this pairs with the app's registration code (see the HTML file,
   "PHASE 8 — SERVICE WORKER" section near the bottom):

     navigator.serviceWorker.register(`sw.js?v=${APP_VER}`)

   Bumping APP_VER in the HTML changes this file's own registration URL,
   which the browser treats as "this is a different script, check for an
   update" - so CACHE_NAME below is derived from that same ?v= value
   rather than a separate hardcoded string. Bump APP_VER in one place;
   this file picks it up automatically. Do NOT hardcode a version number
   here - if the two ever drift, the SW can keep serving a stale shell
   after a real update ships.

   Why network-first for the shell, not the more common cache-first:
   this app is a single HTML file with inline CSS/JS - there's no
   separate small manifest of static assets to precache confidently.
   Network-first means an online user always gets the latest shell (and
   thus the latest APP_VER / cache-busting logic) with the cache purely
   as an offline fallback, rather than an offline-first strategy that
   could pin someone to a stale build indefinitely if their SW happens
   to already be "up to date" per its own (older) cache.

   What this deliberately does NOT touch: any request to Firebase Auth
   (identitytoolkit.googleapis.com / securetoken.googleapis.com) or the
   Realtime Database REST endpoint (the databaseURL host). Those must
   always hit the real network so the app's own JS-level offline/retry
   logic (CloudSync, DepotIndex, etc. - already built with their own
   timeout/retry budgets and local-cache fallbacks) stays the single
   source of truth for sync behavior. A service-worker-level cache
   sitting in front of those calls would silently interfere with that -
   e.g. serving a stale RTDB response instead of a real network error,
   which the app's retry/backoff logic is specifically designed to see
   and react to. */

const CACHE_VERSION = new URL(self.location.href).searchParams.get('v') || 'v0';
const CACHE_NAME = 'satellite-depot-shell-' + CACHE_VERSION;

// Hosts that must always go straight to the network, never through this
// cache - Firebase Auth + RTDB REST calls, plus (for completeness, since
// this SW's fetch handler only runs for GET requests by design below)
// the same is true of the Firebase JS SDK's own auxiliary endpoints.
const BYPASS_HOSTS = [
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com'
];

function isBypassHost(url){
  if(BYPASS_HOSTS.includes(url.hostname)) return true;
  // Firebase RTDB hosts vary by project (firebaseio.com and the newer
  // *.firebasedatabase.app), so match by suffix rather than a fixed list
  // of exact hostnames.
  return url.hostname.endsWith('.firebaseio.com') || url.hostname.endsWith('.firebasedatabase.app');
}

self.addEventListener('install', event=>{
  // Don't precache a hardcoded file list - this is a single inline-
  // everything HTML file with no separate manifest of static assets, and
  // hardcoding a filename here risks drifting from however this ends up
  // deployed (root index.html on GitHub Pages, a custom filename, etc).
  // The shell gets cached opportunistically on first successful fetch
  // instead (see the fetch handler below).
  self.skipWaiting(); // don't wait for old tabs to close - the page's own
                       // controllerchange listener handles the reload
});

self.addEventListener('activate', event=>{
  event.waitUntil((async ()=>{
    // Drop every cache from a previous APP_VER - this SW only ever keeps
    // the one matching its own current CACHE_NAME.
    const names = await caches.keys();
    await Promise.all(
      names.filter(n=> n.startsWith('satellite-depot-shell-') && n !== CACHE_NAME)
           .map(n=> caches.delete(n))
    );
    await self.clients.claim(); // take control of already-open tabs immediately
  })());
});

// Lets the page force an already-installed-and-waiting worker to activate
// right away, in response to the "Refresh" button in notifyUpdateReady().
self.addEventListener('message', event=>{
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event=>{
  const req = event.request;

  // Only ever intercept same-page navigations and simple GETs - never
  // POST/PUT/PATCH/DELETE (that's exactly the RTDB write traffic this SW
  // must stay out of), and never cross-origin calls to Firebase.
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(isBypassHost(url)) return;

  // App-shell navigation: network-first, falling back to the cached
  // shell when offline (that's the whole point of Phase 8 - the app
  // still opens with its last-known UI when there's no connection at
  // all, same spirit as Phase 9 step 5's per-depot data cache, just one
  // layer up at the HTML-shell level instead of the data level).
  if(req.mode === 'navigate'){
    event.respondWith((async ()=>{
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      }catch(e){
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req) || await cache.match(new URL('./', self.location).href);
        if(cached) return cached;
        throw e; // no cached shell yet on this device and no network - nothing to serve
      }
    })());
    return;
  }

  // Any other same-origin GET (e.g. this same HTML fetched as a plain
  // resource rather than a navigation, on some WebViews/wrappers) - same
  // network-first-with-cache-fallback treatment, opportunistically
  // populating the cache as things are fetched rather than a fixed
  // precache list.
  if(url.origin === self.location.origin){
    event.respondWith((async ()=>{
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      }catch(e){
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if(cached) return cached;
        throw e;
      }
    })());
  }
  // Anything else (any other cross-origin GET not explicitly bypassed
  // above) is left untouched - falls through to default browser handling.
});
