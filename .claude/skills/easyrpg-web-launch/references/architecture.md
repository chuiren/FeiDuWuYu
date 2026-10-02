# Architecture of the add-ons

Read this when changing the template files or debugging how they hook into EasyRPG.

## Runtime facts (EasyRPG web build, SDL3, Emscripten)

- `index.js` defines `createEasyRpgPlayer(moduleArg)` (MODULARIZE).
  - The stock shell calls it on `load` with `{game, saveFs}`.
  - `pre.js` keeps `moduleArg.game` unless the URL has `?game=`.
  - The game is fetched from `games/<game>/`, and the save mount becomes `/easyrpg/<game>/Save`.
- Game files are fetched lazily by XHR from `games/<id>/<real name>`, UTF-8
  percent-encoded. The lookup goes through `index.json` (gencache v2:
  `{metadata:{version:2,date}, cache:{…}}`).
  - Top-level keys keep their extension (`rpg_rt.ldb`). Sub-folder keys drop it, except `.ini`/`.po`.
  - Keys are lowercased and NFKC-normalised. `ExFont.*` maps to `exfont`.
- `Module.FS` is exported.
  - Saves are an IDBFS mount with auto-persist on file close.
  - `/home/web_user/.config` (settings) is another IDBFS mount shared by all games on the origin.
- Input: SDL3 registers `keydown`/`keyup` handlers. They copy `key`, `code`, `keyCode`,
  `which`, `location`, ctrl/shift/alt/meta, `repeat`.
  - A document-level listener calls `event.getModifierState()`.
  - EasyRPG samples key state per frame.
- Engine detection (`player.cpp`): the exe reader is `#ifndef __EMSCRIPTEN__`. Otherwise:
  - `ldb_id == 2003` → 2k3 (MajorUpdated only if `ultimate_rt_eb.dll` exists).
  - Otherwise 2k (MajorUpdated if `data.version >= 1` or `IsMajorUpdatedTree()`).
  - `EasyRPG.ini [Game] Engine=` (or `--engine`) overrides.
- Patches are detected by files in the game folder: `harmony.dll`, `dynloader.dll`,
  `accord.dll`, `warp.dll`, `destiny.dll`.
- On Scene_File, Shift opens EasyRPG's own Download/Upload Savegame menu (web only).

## Shell (`index.html`) patches — applied by `setup_site.py`
1. Title, PWA metas, manifest link, icons, `addons.css`.
2. `window.GAME_CONFIG = {id, title}`, then the add-on scripts after `index.js`.
3. `load` handler: `await EasyRPGOffline.beforeStart()` before `createEasyRpgPlayer`.
4. `game: '<id>'` in the create call.
5. After the module is ready: `window.easyrpgPlayer = Module` and an `easyrpg-ready` event
   with `detail: Module`.
6. `simulateKeyboardEvent` creates a `KeyboardEvent`.

## Offline: `offline-manifest.json` + `sw.js` + `offline.js`

- **CI** (`tools/gen_offline_manifest.py web --version $SHA`) writes
  `{version, files:[{path,size,sha256}]}` for every file except itself and `sw.js`. It also
  stamps `__BUILD_VERSION__` in `sw.js`, so each deploy changes the worker.
- **`offline.js`** (page side):
  1. Registers `sw.js` (scope `./`) and requests persistent storage.
  2. Fetches the manifest (network-first).
  3. If `<prefix><version>` holds the `__offline-complete__` marker, starts the game and
     deletes other caches with the same prefix.
  4. Otherwise downloads with 4 workers, 3 retries, and size + SHA-256 checks. A file with an
     unchanged hash is copied from an older cache instead of re-downloaded.
  5. Verifies every entry, stores the manifest and the marker, then cleans up.
  - First visit: an overlay with progress and "先在线游玩" (play now; the download continues).
  - An older complete cache present: start immediately and update in the background (pill).
  - No service worker, registration fails, or not a secure context: plain online start.
  - Downloads add `?easyrpg-sw-bypass=1` so an older worker can't answer them from an old cache.
- **`sw.js`**: `skipWaiting` + `clients.claim`.
  - Navigations and the manifest: network-first with a 4 s timeout, then cache.
  - Everything else: own-version cache → network → any cache with the prefix.
  - It never deletes caches.
- **Cache keys** are canonicalised identically in both files (decode, then
  `encodeURIComponent` per path segment), because names contain spaces, `'`, `,` and
  non-ASCII characters.
- **Prefix**: `'easyrpg-res:' + <site path> + ':'`.

## Saves: `saves.js` + `easyrpg-zip.js`
- **💾 Export**: a STORE zip built synchronously (keeps user activation), entries
  `Save/<file>`, named `<id>-save-YYYY-MM-DD-HH-mm.zip`.
  - Normal tab: `<a download>`.
  - Standalone mode: `navigator.share({files})` when `canShare` allows.
- **📂 Import** accepts:
  - a zip with a `Save/` folder anywhere (also inside a wrapper folder);
  - loose top-level files;
  - a single `.lsd`;
  - STORE or DEFLATE (DEFLATE via `DecompressionStream('deflate-raw')`).
- **Import rejects**:
  - absolute paths, drive letters, `.`/`..`/empty segments, control and reserved characters
    (Zip Slip);
  - encrypted zips, more than 1000 entries, or more than 64 MB.
- **Import skips** `__MACOSX`, `._*`, `.DS_Store`, `Thumbs.db`.
- A confirm dialog lists the overwrites. Import then writes with `FS.writeFile`, runs
  `FS.syncfs(false)` and reloads. It merges and never deletes saves.
- Buttons stay disabled until `FS.syncFSRequests === 0` (pitfall 7).

## Console: `console.js`
- The 🎮 toggle sits in `#controls` before the fullscreen button.
  - Panel: arrows on the left; Shift Ctrl Alt / Esc Tab Enter / Z X C A / Space on the right.
  - The stock dpad/apad are hidden while it is open.
- Pointer Events with pointer capture: keydown on `pointerdown`, keyup on `pointerup`,
  `pointercancel` or `lostpointercapture`.
  - Keys are ref-counted per pointer, so multi-touch works.
  - Minimum hold is 100 ms; a modifier's keyup waits for pending keys.
  - Release-all on close, `blur`, `pagehide` and hidden `visibilitychange`.
- `window.EasyRPGInput = {press, release, releaseAll, held, down, keys}` for debugging.
- To add keys, extend `KEYS` (key/code/keyCode/location; set `modifier` for modifier
  flags) and `LAYOUT`.

## Testing checklist
- **Start:** the game starts and the engine log is as intended; no 404s or page exceptions.
- **Offline:** progress, then complete; reload is instant; offline reload works; game maps,
  images and music load from cache.
- **New version:** only changed files download, the old cache is gone, and the offline reload
  serves the new files.
- **Saves:** export with none, then with some; import a deflated zip with overwrite; import a
  traversal zip (rejected, nothing written); cancel; works offline.
- **Console:** every key's DOM event equals the real keyboard's; Shift+Z order; an instant
  tap affects the game; cancel, close and blur release everything.
- **In-game special keys** (from the readme) work, compared with and without the engine
  setting.
- **Never claim iPhone testing that wasn't done.**
