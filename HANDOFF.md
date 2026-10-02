# FeiDuWuYu / Ruina Web — Handoff

## Project

- GitHub: https://github.com/chuiren/FeiDuWuYu, branch `main`
- Deployment: GitHub Pages (Settings → Pages → Source: GitHub Actions), https://chuiren.github.io/FeiDuWuYu/
- Web root: `web/`

Goal: turn the EasyRPG Web version of 废都物语 / Ruina into a reliable offline/PWA
experience on iPhone, with local save backup and mobile keyboard controls.

Core principle: wrap the existing EasyRPG runtime with an offline/PWA layer,
safe save backup and mobile input controls. Do not rebuild the runtime.

## Structure

```
web/
  index.html            EasyRPG shell (small edits, see below)
  index.js, index.wasm  EasyRPG runtime — generated, unmodified
  games/default/        game data (~880 files / ~33 MB); index.json generated at deploy
  sw.js                 service worker (VERSION stamped at deploy)
  offline.js            offline download/verify/version logic + progress UI
  ruina-zip.js          minimal ZIP writer/reader (no dependencies)
  saves.js              💾 export / 📂 import saves
  console.js            🎮 virtual keyboard
  addons.css            styles for the three add-ons
  manifest.webmanifest  PWA manifest
  icons/                app icons (made from the game's title image)
  offline-manifest.json generated at deploy — not committed
tools/
  gencache.py               index.json generator (port of EasyRPG gencache)
  gen_offline_manifest.py   offline-manifest.json + sw.js version stamp
.github/workflows/deploy-web.yml
```

Deploy workflow: checkout → gencache for each game → `gen_offline_manifest.py web --version ${{ github.sha }}`
→ upload `web/` → deploy.

## Changes to index.html (the only edits to the stock EasyRPG files)

- `<head>`: title, viewport-fit=cover, manifest link, icons, apple-mobile-web-app metas, `addons.css`.
- Loads `offline.js`, `ruina-zip.js`, `saves.js`, `console.js` after `index.js`.
- Start-up awaits `RuinaOffline.beforeStart()` before `createEasyRpgPlayer(...)`.
- After the module is ready: `window.easyrpgPlayer = Module` and an `easyrpg-ready` event
  (`detail` = Module), used by the add-ons.
- `simulateKeyboardEvent` (stock touch pad) now creates a `KeyboardEvent` instead of a plain
  `Event`. The plain Event made SDL's document-level lock-key listener throw
  `event.getModifierState is not a function` on every touch press.

`index.js` / `index.wasm` are untouched.

## 1. Offline / PWA — implemented

Runtime facts: EasyRPG loads game files by XHR from `games/default/<real name>` (UTF-8
percent-encoded), lazily; the service worker intercepts them.

- `offline-manifest.json` = `{version, files: [{path, size, sha256}]}` for every file in
  `web/` except itself and `sw.js`. Version = Git commit SHA.
- `offline.js` (page side):
  - Registers `sw.js`, requests persistent storage.
  - Fetches the manifest (network first). If that version is complete → start at once and delete
    other caches.
  - Otherwise downloads into `ruina-res-<version>` with 4 workers, retries, size + SHA-256
    checks. Files unchanged since an older cache (same hash) are copied, not re-downloaded.
    It then verifies every entry, stores the manifest and a `__offline-complete__` marker, and
    deletes the old caches.
  - First visit: full-screen progress with a "先在线游玩" button (play online at once, download
    continues). With an older complete version present, the game starts immediately and the
    update runs in the background (small progress pill).
  - No service worker support, registration failure, or a non-secure context → normal online
    start, nothing downloaded.
  - Downloads use `?ruina-sw-bypass=1` so the worker never answers them from an older cache.
- `sw.js`: `skipWaiting` + `clients.claim`.
  - Navigations and `offline-manifest.json`: network first (4 s timeout), else the cached copy.
  - Everything else: own-version cache → network → any older cache.
  - Cache keys are canonicalised (decode, then `encodeURIComponent` each path segment) in both
    files, so differently escaped URLs match.
  - The worker never deletes caches; `offline.js` deletes them only after a newer version is
    complete.

## 2. Save export / import — implemented

Runtime facts: `Module.FS` is exported. Saves are in the IDBFS mount `/easyrpg/Save`
(`<cwd>/Save`; cwd is `/easyrpg[/<game>]`). The runtime's IDBFS auto-persists on file close.
The stock `preRun` loads saves with an async `FS.syncfs(true)` that the start-up does not
wait for.

- 💾 builds `ruina-save-YYYY-MM-DD-HH-mm.zip` with entries `Save/<file>`. It is a STORE zip built
  synchronously, so the click keeps user activation. Download is via `<a download>`; in
  standalone (home-screen) mode it uses the share sheet ("Save to Files") when
  `navigator.canShare` allows.
- 📂 accepts the exported zip, any zip with a `Save/` folder (also inside a wrapper folder),
  loose files at the zip root, or a single `.lsd`. STORE and DEFLATE are supported; DEFLATE
  needs `DecompressionStream`.
  - Rejects absolute paths, drive letters, `.`/`..`/empty segments, control and reserved
    characters (Zip Slip), encrypted entries, >1000 entries or >64 MB. Skips `__MACOSX`, `._*`,
    `.DS_Store`, `Thumbs.db`.
  - A confirm dialog lists every file and the existing saves that would be overwritten. It
    then writes with `FS.writeFile`, calls `FS.syncfs(false)`, and reloads.
  - It merges and never deletes saves missing from the zip.
- The buttons stay disabled until `FS.syncFSRequests === 0`, i.e. the initial save load has
  finished; import waits for it too. Without this, saves read right after start-up were empty,
  and an import could be wiped by the pending load.
- IndexedDB is never touched directly.

## 3. Console / virtual keyboard — implemented

Runtime facts: SDL3 registers `keydown`/`keyup` handlers. They copy `key`, `code`, `keyCode`,
`which`, `location`, `ctrl/shift/alt/metaKey`, `repeat` into the wasm event struct. A
document-level SDL listener calls `event.getModifierState()`.

- 🎮 toggles a panel: arrows on the left; Shift Ctrl Alt / Esc Tab Enter / Z X C A / Space on
  the right.
- Each key dispatches a real `KeyboardEvent` on the canvas (bubbles to document and window).
  `key`, `code` and `location` go through the constructor, `keyCode`/`which` through
  defineProperty, and the modifier flags reflect the currently held console modifiers.
- Pointer Events: keydown on `pointerdown` (with pointer capture), keyup on
  `pointerup`/`pointercancel`/`lostpointercapture`. A key is counted per pointer, so
  multi-touch works and a key held by two fingers releases only when both lift.
- Everything is released on console close, window `blur`, `pagehide` and `visibilitychange`
  (hidden).
- The stock dpad/apad are hidden while the console is open and restored afterwards.
- `window.RuinaInput` = `{press, release, releaseAll, held, keys}` for debugging.

## Testing done (headless Chromium + Playwright, local server, CI-like build)

Done:
- Offline: first visit with progress → verified complete cache (892 files, 40.7 MB). Reload
  starts in ~0.3–0.5 s without the overlay. Browser offline mode: game starts and plays from
  the title through the opening scenes (images, music, sound requests all from cache).
- New version: the game starts at once from the old cache. Only the changed file was
  downloaded. The old cache was deleted, the new worker activated, and the offline reload
  serves the new file.
- Saves:
  - Export with no saves shows an alert. Export produced a valid zip.
  - Import of a DEFLATE zip with a wrapper folder: the confirmation listed the overwrite,
    data persisted across the reload, existing other saves were kept.
  - A `Save/../../evil.lsd` zip was rejected with nothing written.
  - Cancel changes nothing.
  - Offline import and export work.
- Console: for all 15 keys and for hold-Shift/tap-Z, the DOM events match real keyboard input
  field for field. Cancel, close-while-held and blur release everything. Console ↑/↓ moves
  EasyRPG menu cursors. Stock touch pad works with no exceptions. Layout checked at 844×390.

Not done:
- **No testing on a real iPhone/iPad.** Safari, PWA standalone mode and the Files app are untested.
- Real in-game saves (written by EasyRPG itself) were not round-tripped; tests used synthetic
  files in the Save dir.
- Chromium's simulated multi-touch (CDP) could not lift one finger individually, so the
  multi-finger case was tested with explicit PointerEvents.
- Once, an offline reload right after a version update hung in headless Chromium. Three
  further identical runs passed and it was not reproducible.

## iOS notes

- Safari and the home-screen app have **separate storage** (cache and saves). After adding to
  the home screen, open it once online to prepare offline data. Use 💾/📂 to move saves between
  them.
- Safari may evict storage of sites not visited for a while; the home-screen app is exempt.
  Keep save backups.

## Development rules

1. Read this file, inspect the current repository state, don't assume earlier changes landed.
2. Smallest safe changes; reuse existing code; no CDN dependencies.
3. Don't rewrite generated EasyRPG files (`index.js`, `index.wasm`).
4. Keep the systems separate: Cache Storage (runtime + game) ↔ service worker; IDBFS
   (saves) ↔ EasyRPG; console ↔ keyboard events ↔ EasyRPG.
5. Update this file after significant changes.

Local test: `python3 tools/gencache.py web/games/default`, copy `web/` to a scratch dir, run
`gen_offline_manifest.py <dir> --version test` there (it stamps `sw.js` in place, so don't run
it on the repo's `web/`), then `python3 -m http.server -d <dir>`. Service workers need
localhost or https.
