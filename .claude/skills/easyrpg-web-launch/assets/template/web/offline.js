/*
 * Offline preparation for the EasyRPG web player.
 *
 * Downloads every file listed in offline-manifest.json (generated at deploy
 * time) into Cache Storage "<CACHE_PREFIX><version>", verifies it, then marks the
 * version complete. sw.js serves the cached files so the game runs offline.
 *
 * index.html calls EasyRPGOffline.beforeStart() and only starts EasyRPG once it
 * resolves: immediately when this version is already prepared (or offline
 * support is unavailable), otherwise after preparation finishes or the player
 * chooses to play online right away.
 */
(function () {
  'use strict';

  const base = new URL('./', document.baseURI);
  // Several sites on one origin (user.github.io/<repo>/) share Cache Storage,
  // so cache names include the site path. Must match sw.js.
  const CACHE_PREFIX = 'easyrpg-res:' + base.pathname + ':';
  const TITLE = (window.GAME_CONFIG && window.GAME_CONFIG.title) || document.title;
  const MARKER = '__offline-complete__';
  const MANIFEST = 'offline-manifest.json';
  const BYPASS_PARAM = 'easyrpg-sw-bypass';
  const HASH_HEADER = 'X-EasyRPG-Sha256';
  const CONCURRENCY = 4;
  const RETRIES = 3;

  // Must match canonicalUrl() in sw.js
  function canonicalUrl(url) {
    const u = new URL(url);
    const path = u.pathname.split('/').map(seg => {
      let raw = seg;
      try { raw = decodeURIComponent(seg); } catch (e) { /* keep as is */ }
      return encodeURIComponent(raw);
    }).join('/');
    return u.origin + path;
  }

  function fileUrl(path) {
    return canonicalUrl(new URL(path.split('/').map(encodeURIComponent).join('/'), base).href);
  }

  function formatMB(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function supported() {
    return 'serviceWorker' in navigator && 'caches' in window && window.isSecureContext;
  }

  // ---------------------------------------------------------------- UI

  let overlay, pill;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.assign(node, attrs || {});
    for (const child of children || []) node.append(child);
    return node;
  }

  function showOverlay() {
    if (overlay) return overlay;
    overlay = el('div', { id: 'offline-overlay' }, [
      el('div', { className: 'offline-box' }, [
        el('div', { className: 'offline-title', textContent: TITLE }),
        el('div', { className: 'offline-text', id: 'offline-text', textContent: '正在检查离线资源…' }),
        el('div', { className: 'offline-bar' }, [el('div', { id: 'offline-bar-fill' })]),
        el('div', { className: 'offline-detail', id: 'offline-detail' }),
        el('div', { className: 'offline-actions', id: 'offline-actions' }),
      ]),
    ]);
    document.body.append(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function setActions(buttons) {
    const box = document.getElementById('offline-actions');
    if (!box) return;
    box.replaceChildren(...buttons.map(([label, onClick]) =>
      el('button', { type: 'button', textContent: label, onclick: onClick })));
  }

  function showPill(text) {
    if (!pill) {
      pill = el('div', { id: 'offline-pill' });
      document.body.append(pill);
    }
    pill.textContent = text;
  }

  function hidePillLater() {
    if (pill) setTimeout(() => { pill?.remove(); pill = null; }, 4000);
  }

  function report(state) {
    const pct = state.totalBytes ? Math.floor(state.doneBytes * 100 / state.totalBytes) : 0;
    const text = document.getElementById('offline-text');
    if (text) {
      text.textContent = state.phase === 'verify' ? '正在校验离线资源…'
        : (state.update ? '发现新版本，正在更新离线资源… ' : '正在下载游戏以便离线游玩… ') + pct + '%';
      document.getElementById('offline-bar-fill').style.width = pct + '%';
      document.getElementById('offline-detail').textContent =
        `${formatMB(state.doneBytes)} / ${formatMB(state.totalBytes)}　(${state.doneFiles}/${state.totalFiles} 个文件)`;
    } else {
      showPill(state.phase === 'verify' ? '离线资源校验中…' : `离线资源 ${pct}%`);
    }
  }

  // ------------------------------------------------------- cache logic

  async function fetchManifest() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(MANIFEST, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const manifest = await res.json();
      if (!manifest.version || !Array.isArray(manifest.files)) throw new Error('invalid manifest');
      return manifest;
    } finally {
      clearTimeout(timer);
    }
  }

  async function isComplete(version) {
    const name = CACHE_PREFIX + version;
    if (!(await caches.has(name))) return false;
    const cache = await caches.open(name);
    return !!(await cache.match(fileUrl(MARKER)));
  }

  async function sha256Hex(buffer) {
    if (!crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  async function findInOtherCaches(key, hash, ownName) {
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === ownName) continue;
      const res = await (await caches.open(name)).match(key);
      if (res && res.headers.get(HASH_HEADER) === hash) return res;
    }
    return null;
  }

  async function download(file, key) {
    let lastError;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const url = new URL(key);
        url.searchParams.set(BYPASS_PARAM, '1');
        const res = await fetch(url.href, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${file.path}`);
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength !== file.size) throw new Error('大小不符: ' + file.path);
        const hash = await sha256Hex(buffer);
        if (hash && hash !== file.sha256) throw new Error('校验失败: ' + file.path);
        const headers = { [HASH_HEADER]: file.sha256 };
        const type = res.headers.get('Content-Type');
        if (type) headers['Content-Type'] = type;
        return new Response(buffer, { headers });
      } catch (e) {
        lastError = e;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async function prepare(manifest, onProgress) {
    const ownName = CACHE_PREFIX + manifest.version;
    const hadOther = (await caches.keys()).some(n => n.startsWith(CACHE_PREFIX) && n !== ownName);
    const cache = await caches.open(ownName);
    const state = {
      phase: 'download', update: hadOther,
      totalBytes: manifest.files.reduce((n, f) => n + f.size, 0), doneBytes: 0,
      totalFiles: manifest.files.length, doneFiles: 0,
    };
    onProgress(state);

    const queue = manifest.files.slice();
    async function worker() {
      while (queue.length) {
        const file = queue.shift();
        const key = fileUrl(file.path);
        const existing = await cache.match(key);
        if (!existing || existing.headers.get(HASH_HEADER) !== file.sha256) {
          const reused = await findInOtherCaches(key, file.sha256, ownName);
          await cache.put(key, reused || await download(file, key));
        }
        state.doneBytes += file.size;
        state.doneFiles++;
        onProgress(state);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    state.phase = 'verify';
    onProgress(state);
    for (const file of manifest.files) {
      const res = await cache.match(fileUrl(file.path));
      if (!res || res.headers.get(HASH_HEADER) !== file.sha256) {
        throw new Error('缓存校验失败: ' + file.path);
      }
    }

    // The manifest itself, so an offline start can find the version
    await cache.put(fileUrl(MANIFEST), new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await cache.put(fileUrl(MARKER), new Response(JSON.stringify({
      version: manifest.version, files: state.totalFiles, bytes: state.totalBytes,
      date: new Date().toISOString(),
    })));
  }

  async function cleanup(version) {
    const keep = CACHE_PREFIX + version;
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== keep) await caches.delete(name);
    }
  }

  async function anyComplete() {
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX)) continue;
      if (await (await caches.open(name)).match(fileUrl(MARKER))) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ status

  const status = { mode: 'unsupported', version: null, error: null };

  async function registerWorker() {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      reg.update().catch(() => {});
    } catch (e) {
      console.warn('[offline] service worker registration failed', e);
      return false;
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
    }
    return true;
  }

  /**
   * Resolves when EasyRPG may start.
   */
  function beforeStart() {
    if (!supported()) return Promise.resolve();

    return new Promise(resolve => {
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        hideOverlay();
        resolve();
      };

      (async () => {
        // Without a service worker the cache could never be used
        if (!(await registerWorker())) return start();

        let manifest;
        try {
          manifest = await fetchManifest();
        } catch (e) {
          // Offline without a prepared cache, or the manifest is missing
          // (local development): start normally
          console.warn('[offline] manifest unavailable', e);
          status.mode = (await anyComplete()) ? 'ready' : 'online';
          return start();
        }
        status.version = manifest.version;

        if (await isComplete(manifest.version)) {
          status.mode = 'ready';
          cleanup(manifest.version).catch(() => {});
          return start();
        }

        // An older complete version can keep playing while the update runs
        const canPlayOld = await anyComplete();
        if (!canPlayOld) {
          showOverlay();
          setActions([['先在线游玩', start]]);
        } else {
          start();
        }

        const run = () => {
          status.mode = 'preparing';
          return prepare(manifest, report).then(async () => {
            status.mode = 'ready';
            await cleanup(manifest.version);
            if (started) { showPill('离线资源已就绪 ✓'); hidePillLater(); }
            start();
          });
        };

        const fail = e => {
          console.error('[offline] preparation failed', e);
          status.mode = 'error';
          status.error = String(e && e.message || e);
          const quota = e && e.name === 'QuotaExceededError';
          const msg = (quota ? '存储空间不足，无法保存离线资源。' : '离线资源下载失败：' + status.error);
          if (!started) {
            document.getElementById('offline-text').textContent = msg;
            setActions([['重试', () => run().catch(fail)], ['在线游玩', start]]);
          } else {
            showPill('离线资源未完成（联网时会重试）');
            hidePillLater();
          }
        };

        run().catch(fail);
      })().catch(e => {
        console.error('[offline]', e);
        start();
      });
    });
  }

  window.EasyRPGOffline = { beforeStart, status, fileUrl };
})();
