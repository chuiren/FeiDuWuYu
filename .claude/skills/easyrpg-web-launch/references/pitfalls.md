# Pitfalls: symptom → cause → fix

Each entry was hit for real. Diagnose with the browser console: EasyRPG prints
`Engine configured as: …`, `Patch configuration: …` and `Cannot find …` lines.

## Contents
1. A key (Shift, …) does nothing in-game, on PC and phone
2. A key works from the keyboard but not from on-screen buttons
3. Stock touch pad throws `event.getModifierState is not a function`
4. Images/sounds missing, or 404s for game files
5. File names look garbled
6. Text garbled in-game
7. Saves empty right after start, or import lost
8. Two games on one github.io account interfere
9. First deploy fails: `Get Pages site failed … Not Found`
10. Users still see the old version after a deploy
11. Environment: blocked sites, local testing
12. iOS specifics

---

## 1. A key (Shift, …) does nothing in-game, on PC and phone
**Cause.** Wrong engine version. The web build can't read `RPG_RT.exe`, so EasyRPG guesses.
For RPG Maker 2000 without v1.50 markers it logs `Assuming older engine` and
`MajorUpdated=false`. Then `CommandKeyInputProc` ignores the Shift parameter, because Shift
in "Key Input Processing" was added in 2000 v1.50 (and 2003 v1.05).

**Fix.** Put `EasyRPG.ini` in the game folder:
```
[Game]
Engine=rpg2kv150
```
Use the right value for the game (see SKILL.md step 3). This is the `[Game] Engine` key of
`EasyRPG.ini`, not of `RPG_RT.ini`.

**Verify.** The log says `MajorUpdated=true`. Pressing the key in-game has its effect (Ruina:
Shift on the map opens 交谈/情报/设定的变更), and a run without the ini does not.

## 2. A key works from the keyboard but not from on-screen buttons
**Cause.** The tap was shorter than a frame. EasyRPG samples key state once per frame, so
keydown+keyup in the same frame is invisible to the game.

**Fix.** `console.js` keeps every key down at least 100 ms. When a modifier is released while
another key's keyup is still pending, it waits, keeping the order Shift↓ Z↓ Z↑ Shift↑.

**Verify.** A test should use an *instant* tap (Playwright `page.tap`, or pointerdown and
pointerup back-to-back), not a held press.

## 3. Stock touch pad throws `event.getModifierState is not a function`
**Cause.** The stock shell's `simulateKeyboardEvent` dispatches `new Event()` with `.code` set.
SDL3 has a document-level lock-key listener that calls `event.getModifierState()`.

**Fix.** Create a `KeyboardEvent` (`setup_site.py` patches this). Synthetic events in general
must be real `KeyboardEvent`s. Set `key`, `code` and `location` in the constructor, and
`keyCode`/`which` via `Object.defineProperty`. Modifier flags should reflect held modifiers.

## 4. Images/sounds missing, or 404s for game files
- **`index.json` missing or stale.** EasyRPG resolves extension-less, case-insensitive names
  through `games/<id>/index.json` (gencache). The workflow regenerates it on every deploy.
  Locally, run `tools/gencache.py` after any file change.
- **RTP assets.** The game uses RTP files that aren't in the folder. Copy them in (same
  sub-folders).
- **File-name encoding mismatch.** See 5.
- **Junk removed too eagerly.** Never drop DLLs. `harmony.dll`, `accord.dll`,
  `dynloader.dll` etc. switch patches on.

## 5. File names look garbled
Usually **not** a problem. Translated Japanese games keep Shift-JIS file names. On a
Chinese system they show as GBK mojibake (`System/攑搒僔僗僥儉.xyz`), and the database,
decoded with the game's codepage, references exactly those strings. `inspect_game.py` counts
matches per encoding. If the best encoding matches most non-ASCII names, leave the names
alone.

Only when *no* encoding matches were the names mis-decoded during extraction. Re-extract
with the right codepage for zip entries without the UTF-8 flag.

## 6. Text garbled in-game
EasyRPG guessed the codepage wrong. Set it in `RPG_RT.ini`:
```
[EasyRPG]
Encoding=936
```
Use 932 for Japanese, 949 for Korean, 950 for Big5, 1252 for Western. As a quick test, add
`?encoding=936` to the URL.

## 7. Saves empty right after start, or import lost
**Cause.** The runtime's `preRun` calls `FS.syncfs(true)` asynchronously and doesn't wait for
it. Until it finishes, `Save/` looks empty, and files written before it finishes are dropped
when the load completes.

**Fix.** `saves.js` waits for `FS.syncFSRequests === 0` before enabling 💾/📂 and before
importing.

## 8. Two games on one github.io account interfere
All `https://<user>.github.io/<repo>/` sites share one origin, so they share Cache Storage
and IndexedDB:
- **Caches.** The template's cache names include the site path
  (`easyrpg-res:/<repo>/:<sha>`). An older add-on version that used a fixed prefix will
  delete other sites' caches when it cleans up.
- **Saves.** IDBFS stores saves under the mount path. With `game: undefined` every site uses
  `/easyrpg/Save` and they share saves. The template sets `game: '<id>'` in `index.html`, so
  the path is `/easyrpg/<id>/Save`. Changing the id later "loses" saves; the user must export
  before and import after.

## 9. First deploy fails: `Get Pages site failed … Not Found`
Pages isn't enabled. The user sets Settings → Pages → Source: **GitHub Actions**, then
re-runs the workflow. The workflow token cannot enable Pages itself.

## 10. Users still see the old version after a deploy
Expected for one visit. The page starts from the old complete cache and updates in the
background, showing a corner pill with "离线资源已就绪 ✓". The next reload is the new
version. `sw.js` changes every deploy (the version is stamped), so the browser updates the
worker. If a user is stuck, clear the site data.

## 11. Environment: blocked sites, local testing
- easyrpg.org, ci.easyrpg.org, wiki.easyrpg.org and easyrpg.github.io may be blocked by the
  sandbox; raw.githubusercontent.com usually isn't.
  - **Source:** `EasyRPG/Player` (`src/game_interpreter.cpp`, `src/player.cpp`,
    `resources/emscripten/*`) answers runtime questions.
  - **gencache:** `EasyRPG/Tools/gencache`.
  - **Player build:** ask the user to upload it.
- Service workers only work on `localhost` or https.
- `pkill -f <pattern>` inside the same shell command can kill that shell; kill by PID instead.
- Headless Chromium + `context.setOffline(true)` is fine for offline tests. CDP touch events
  can't lift one finger of several; test multi-touch with explicit `PointerEvent`s with
  distinct `pointerId`s.
- One offline reload right after an update hung once in headless Chromium and never
  reproduced. If you see it, rerun before chasing it.

## 12. iOS specifics (untested on device here — say so to the user)
- **Separate storage.** Safari and the home-screen app don't share storage (cache or saves).
- **Downloads in the home-screen app.** `<a download>` doesn't work in standalone mode;
  `saves.js` uses the share sheet ("Save to Files").
- **Eviction.** Safari may evict data of sites not visited for weeks; home-screen apps are
  exempt. Recommend regular 💾 backups.
- **Safe areas.** `viewport-fit=cover` plus `env(safe-area-inset-*)` keep buttons out of the
  notch.
