---
name: easyrpg-web-launch
description: Put an RPG Maker 2000/2003 game (RPG_RT.ldb / RPG_RT.exe, ツクール2000/2003, RM2k/RM2k3) online as a browser game with the EasyRPG web player on GitHub Pages — including offline/PWA play on iPhone, save export/import, and an on-screen keyboard for Shift/Esc etc. Use this whenever the user wants to publish, deploy, host, "上线", make a 网页版 / web version of, or play in the browser / on a phone an RPG Maker 2000/2003 game or an EasyRPG game, uploads such a game zip, or reports problems with an EasyRPG web deployment (keys like Shift not working, garbled text or file names, missing images/music, offline cache, saves) — even if they don't name EasyRPG.
---

# Publishing an RPG Maker 2000/2003 game with EasyRPG Web

This skill turns a game folder plus the EasyRPG web player build into a GitHub
Pages site that:
- loads lazily online;
- can be fully cached for offline play (PWA, iPhone home screen);
- can back up saves as a ZIP;
- has a 🎮 virtual keyboard for keys phones lack.

Everything here was worked out on a real launch (Ruina 废都物语, Chinese translation). The
pitfalls in `references/pitfalls.md` each cost real debugging time, so skim them before
starting.

Bundled:
- `scripts/inspect_game.py` — extract + analyse a game (encoding, junk, patches, sizes, readmes)
- `scripts/setup_site.py` — build the repo (template + player + game + patched `index.html` + icons + manifest)
- `scripts/smoke_test.js` — headless Chromium check (start, engine log, 404s, offline, key sequences)
- `assets/template/` — workflow, `tools/gencache.py`, `tools/gen_offline_manifest.py`, web add-ons
  (`sw.js`, `offline.js`, `easyrpg-zip.js`, `saves.js`, `console.js`, `addons.css`)
- `references/pitfalls.md` — symptoms → causes → fixes
- `references/architecture.md` — how the add-ons hook into the EasyRPG runtime, and how to test each piece

## Workflow

### 1. Get the two inputs

- **The game**: usually a zip. Keep the original archive; you may need to re-extract.
- **The EasyRPG web player build** (`index.html`, `index.js`, `index.wasm`): from
  https://easyrpg.org/player/downloads/ (web/emscripten build) or the CI. Sandboxed
  environments often block easyrpg.org, ci.easyrpg.org and wiki.easyrpg.org. If yours does,
  ask the user to upload the build instead of hunting for mirrors; GitHub release pages only
  carry source code. Use the player build as-is: never rebuild or edit `index.js`/`index.wasm`.

### 2. Inspect the game

```bash
python3 scripts/inspect_game.py GAME.zip --extract /tmp/game-x
```

Read the report and the readme files it lists. Decide:
- **Game folder**: the directory containing `RPG_RT.ldb`. Other files in the package
  (launchers, manuals) stay out.
- **Encoding**: which codepage makes the database's file references match the files on disk.
  If `RPG_RT.ini` lacks `[EasyRPG] Encoding=`, EasyRPG guesses; set it when the guess
  could be wrong.
- **File names that look garbled are often correct.** A Japanese game's Shift-JIS names,
  read as GBK on a Chinese PC, look like 攑搒僔僗僥儉 — and a Chinese translation's
  database references exactly those strings. Trust the match count, not your eyes.
  Rename nothing.
- **Junk to drop**: `RPG_RT.exe`, `*.bak`, `Thumbs.db`. **Keep** patch DLLs
  (`Harmony.dll`, `accord.dll`, …): EasyRPG enables patches by their presence.
- **RTP**: if the game needs the RTP (FullPackageFlag≠1, readme says so), copy the RTP
  assets it uses into the game folder. The web player can't use an installed RTP.
- **Size**: no file over 100 MB (GitHub limit); keep the site well under 1 GB.

### 3. Decide the engine version (this breaks Shift if wrong)

EasyRPG's web build **cannot read RPG_RT.exe**, so it guesses the engine from the data. For
RPG Maker 2000 it often logs `Assuming older engine … MajorUpdated=false` (pre-1.50). With
that, "Key Input Processing" events never test Shift, so any game feature on Shift is dead
on every device. Other version-specific behaviour differs too.

Set it explicitly unless you're sure the guess is right. `setup_site.py --engine X` writes
`web/games/<id>/EasyRPG.ini`:

| Game | `--engine` |
|---|---|
| RPG Maker 2000, v1.50–1.51 ("Value!"/most games after ~2002, or anything using Shift) | `rpg2kv150` |
| RPG Maker 2000, v1.00–1.10 (early games) | `rpg2k` |
| RPG Maker 2000 English (1.61) | `rpg2ke` |
| RPG Maker 2003 v1.00–1.04 | `rpg2k3` |
| RPG Maker 2003 v1.05+ | `rpg2k3v105` |
| RPG Maker 2003 English (1.12) | `rpg2k3e` |

Clues: the readme's key list (Shift ⇒ 2000 ≥1.50 or 2003 ≥1.05), the release year, folders
like `BattleCharSet` (2003). Confirm in step 6 via the `Engine configured as:` log line and
by actually pressing the keys in-game.

### 4. Create the site

Pick a short lowercase ASCII `--id`. It becomes `web/games/<id>/`, the save storage path,
and the backup zip name. Then:

```bash
python3 scripts/setup_site.py --player PLAYER.tar.gz --game /tmp/game-x/…/game \
  --out REPO_DIR --id ruina --title "Ruina 废都物语" --short-name "废都物语" --engine rpg2kv150
```

Look at `web/icons/icon-512.png`. It is the title image letterboxed into a square, so pass
`--icon` for a better source if needed. Add a README for the user: how to play, offline
notes, save backup.

Why a game id instead of `games/default`: every repo of one GitHub user is served from the
same origin (`user.github.io`). Saves (IndexedDB) and caches are per origin. The id keeps
saves apart, and the add-ons put the site path into cache names.

### 5. Test locally before pushing

Simulate the deploy steps, serve, and run the smoke test:

```bash
cd REPO_DIR
for d in web/games/*/; do python3 tools/gencache.py "$d"; done
# copy first: this stamps web/sw.js in place
cp -r web /tmp/site && python3 tools/gen_offline_manifest.py /tmp/site --version test
python3 -m http.server -d /tmp/site 8000 &
NODE_PATH=$(npm root -g) node SKILL_DIR/scripts/smoke_test.js http://localhost:8000/ --out /tmp/shots \
  --keys "Enter*3"
```

Look at the screenshots: Chinese, Japanese or Korean text renders, the title image shows,
and there are no 404s. Then play far enough to reach normal gameplay (`--keys` accepts
`Key*N` and `Key:holdMs`) and press each special key the readme mentions. For example,
Ruina needed `Enter*10,ArrowUp,ArrowLeft,Enter*25,Shift:250` to reach the map and open the
Shift submenu. Run the special-key check with and without `EasyRPG.ini` if you're unsure
about the engine.

Service workers need `localhost` or https. If Playwright's bundled browser is missing, set
`executablePath` or use the preinstalled Chromium. Never run `gen_offline_manifest.py` on the
repo's own `web/`: it stamps `sw.js`, and CI expects the placeholder.

### 6. Publish

1. Create or choose the GitHub repo and push `main`. The workflow runs gencache, the offline
   manifest (version = commit SHA) and deploys `web/`.
2. The first run fails at `configure-pages` with `Get Pages site failed … Not Found` until the
   user sets **Settings → Pages → Source: GitHub Actions**. The workflow token can't do that
   itself. Then re-run the workflow.
3. Site: `https://<user>.github.io/<repo>/`. Report what you verified, and say plainly what
   was **not** tested on a real iPhone (Safari, home-screen mode, Files app).

Tell the user:
- The first online visit downloads everything for offline play, with a progress screen.
- Later deploys only download changed files.
- On iOS, the Safari tab and the home-screen app have separate storage. Open the home-screen
  app once while online, and move saves between them with 💾/📂.

### 7. When the user reports a problem

Go to `references/pitfalls.md` first: most reports (a key doing nothing, garbled text,
missing assets, stale version, saves) are covered there with the diagnostic to run. Diagnose
in the browser with the EasyRPG console log (`Engine configured as`, `Cannot find`, …)
before changing code. Verify the fix by reproducing the user's exact action in the game, not
only at the DOM level.

## Principles

- Wrap the runtime and don't modify it. Shell (`index.html`) edits stay minimal, and
  `setup_site.py` applies them by exact anchors (it fails loudly if the EasyRPG shell
  changed; adapt the anchors then).
- No CDN or external dependencies; everything must work offline.
- Never touch EasyRPG's IndexedDB directly; go through `Module.FS` + `FS.syncfs`.
- Prove behaviour with an in-game effect (a menu opening, a cursor moving), compared against
  a control run. "The event was dispatched" is not proof that the game reacted.
