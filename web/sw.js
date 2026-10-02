/*
 * Service worker for offline play.
 *
 * The page (offline.js) downloads every file listed in offline-manifest.json
 * into the cache "ruina-res-<version>" and verifies it. This worker only
 * serves requests; it never deletes a complete cache (offline.js does that
 * after a newer version has been fully prepared).
 *
 * VERSION is stamped with the Git commit SHA by tools/gen_offline_manifest.py
 * during deployment, so every deploy also changes this file and the browser
 * installs the new worker.
 */
const VERSION = '__BUILD_VERSION__';
const CACHE_PREFIX = 'ruina-res-';
const OWN_CACHE = CACHE_PREFIX + VERSION;
const BYPASS_PARAM = 'ruina-sw-bypass';
const NETWORK_FIRST = ['offline-manifest.json'];
const NETWORK_TIMEOUT_MS = 4000;

// Must match canonicalUrl() in offline.js: cache keys are built from the
// decoded path, so differently-escaped requests for one file share an entry.
function canonicalUrl(url) {
  const u = new URL(url);
  const path = u.pathname.split('/').map(seg => {
    let raw = seg;
    try { raw = decodeURIComponent(seg); } catch (e) { /* keep as is */ }
    return encodeURIComponent(raw);
  }).join('/');
  return u.origin + path;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function resourceCaches() {
  const names = (await caches.keys()).filter(n => n.startsWith(CACHE_PREFIX));
  // Own version first, then the others (newest created last, so reverse)
  names.reverse();
  names.sort((a, b) => (b === OWN_CACHE) - (a === OWN_CACHE));
  return names;
}

async function matchOwn(key) {
  const cache = await caches.open(OWN_CACHE);
  return cache.match(key);
}

async function matchAny(key) {
  for (const name of await resourceCaches()) {
    const cache = await caches.open(name);
    const res = await cache.match(key);
    if (res) return res;
  }
  return undefined;
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(res => { clearTimeout(timer); resolve(res); },
                        err => { clearTimeout(timer); reject(err); });
  });
}

async function networkFirst(request, key) {
  try {
    const res = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (res.ok) return res;
  } catch (e) { /* fall through to cache */ }
  const cached = await matchOwn(key) || await matchAny(key);
  if (cached) return cached;
  return Response.error();
}

async function cacheFirst(request, key) {
  const own = await matchOwn(key);
  if (own) return own;
  try {
    return await fetch(request);
  } catch (e) {
    const any = await matchAny(key);
    if (any) return any;
    throw e;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // offline.js downloads files with this marker so it always gets the
  // deployed file, never an older cached copy
  if (url.searchParams.has(BYPASS_PARAM)) return;

  const rel = url.pathname.slice(scope.pathname.length);

  if (request.mode === 'navigate') {
    const indexKey = canonicalUrl(new URL('index.html', scope).href);
    event.respondWith(networkFirst(request, indexKey));
    return;
  }

  const key = canonicalUrl(request.url);
  if (NETWORK_FIRST.includes(rel)) {
    event.respondWith(networkFirst(request, key));
  } else {
    event.respondWith(cacheFirst(request, key));
  }
});
