#!/usr/bin/env python3
"""Inspect an RPG Maker 2000/2003 game before putting it on the web.

Usage:
  python3 inspect_game.py GAME.zip --extract OUT_DIR   # extract, then inspect
  python3 inspect_game.py GAME_DIR                      # inspect an extracted game

Reports: the game folder(s) (where RPG_RT.ldb is), RPG_RT.ini settings, which
text encoding makes the database's file references match the files on disk,
files that should not be uploaded, files that must be kept (patch DLLs),
oversized files, and readme files worth reading (controls such as Shift,
RTP requirements, engine version hints).
"""

import argparse
import os
import re
import sys
import zipfile

CANDIDATE_ENCODINGS = ["cp936", "cp932", "cp949", "big5", "cp1252", "cp1251"]
ASSET_DIRS = ["Backdrop", "Battle", "Battle2", "BattleCharSet", "BattleWeapon", "CharSet", "ChipSet",
              "FaceSet", "Frame", "GameOver", "Monster", "Movie", "Music", "Panorama", "Picture",
              "Sound", "System", "System2", "Title"]
RM2003_ONLY_DIRS = {"battle2", "battlecharset", "battleweapon", "frame", "system2"}
DROP = re.compile(r"(^|/)(rpg_rt\.exe|thumbs\.db|desktop\.ini|\.ds_store)$|\.bak$|(^|/)__macosx/", re.I)
PATCH_FILES = {  # EasyRPG enables these patches when the file exists — keep them
    "harmony.dll": "Ineluki Key Patch",
    "dynloader.dll": "DynRPG",
    "accord.dll": "Maniac Patch",
    "warp.dll": "Power Mode 2003",
    "destiny.dll": "Destiny Patch",
    "ultimate_rt_eb.dll": "RPG Maker 2003 English (1.12)",
}
GITHUB_FILE_LIMIT = 100 * 1024 * 1024


def extract(zip_path, out_dir):
    """Extract keeping names as the archive declares them.

    Entries with the UTF-8 flag are decoded as UTF-8 (Python does this).
    Others are decoded as cp437 by Python; for non-ASCII names we report the
    most plausible legacy encoding and use it. Never "repair" names that look
    garbled: they may be exactly what the game's database references (see
    the encoding check below).
    """
    z = zipfile.ZipFile(zip_path)
    legacy = [i for i in z.infolist() if not i.flag_bits & 0x800 and not i.filename.isascii()]
    chosen = None
    if legacy:
        raw = [i.filename.encode("cp437") for i in legacy]
        for enc in CANDIDATE_ENCODINGS:
            try:
                for r in raw:
                    r.decode(enc)
                chosen = enc
                break
            except UnicodeDecodeError:
                continue
        print(f"[zip] {len(legacy)} entries without UTF-8 flag; decoding their names as {chosen}")
    for info in z.infolist():
        name = info.filename
        if info in legacy and chosen:
            name = name.encode("cp437").decode(chosen)
        target = os.path.normpath(os.path.join(out_dir, name))
        if not target.startswith(os.path.abspath(out_dir)) and not target.startswith(out_dir):
            sys.exit(f"unsafe path in zip: {name}")
        if name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as src, open(target, "wb") as dst:
            dst.write(src.read())
    print(f"[zip] extracted {len(z.infolist())} entries to {out_dir}")


def find_game_roots(root):
    return sorted(d for d, _, files in os.walk(root) if any(f.lower() == "rpg_rt.ldb" for f in files))


def read_ini(game):
    path = next((os.path.join(game, f) for f in os.listdir(game) if f.lower() == "rpg_rt.ini"), None)
    if not path:
        return {}, None
    data = open(path, "rb").read()
    values = {}
    for enc in ["utf-8"] + CANDIDATE_ENCODINGS:
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    for line in text.splitlines():
        m = re.match(r"\s*([^=;\[]+?)\s*=\s*(.*)", line)
        if m:
            values[m.group(1).lower()] = m.group(2).strip()
    return values, text


def encoding_match(game):
    """Which encoding makes the database/map file references match the asset files."""
    blobs = []
    for f in os.listdir(game):
        if f.lower().endswith((".ldb", ".lmu", ".lmt")):
            blobs.append(open(os.path.join(game, f), "rb").read())
    data = b"".join(blobs)
    assets = []
    for d in os.listdir(game):
        p = os.path.join(game, d)
        if os.path.isdir(p) and d.lower() in {a.lower() for a in ASSET_DIRS}:
            assets += [os.path.splitext(f)[0] for f in os.listdir(p) if not f.lower().endswith(".db")]
    non_ascii = [a for a in assets if not a.isascii()]
    results = []
    for enc in CANDIDATE_ENCODINGS:
        text = data.decode(enc, errors="replace")
        hit = sum(1 for a in non_ascii if a in text)
        results.append((hit, enc))
    results.sort(reverse=True)
    ascii_hits = sum(1 for a in assets if a.isascii() and a.encode() in data)
    return results, len(non_ascii), ascii_hits, len(assets) - len(non_ascii)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("path", help="game .zip or extracted directory")
    ap.add_argument("--extract", metavar="OUT_DIR", help="extract the zip here first")
    args = ap.parse_args()

    root = args.path
    if zipfile.is_zipfile(root):
        if not args.extract:
            sys.exit("pass --extract OUT_DIR for a zip")
        extract(root, args.extract)
        root = args.extract

    games = find_game_roots(root)
    if not games:
        sys.exit("no RPG_RT.ldb found — not an RPG Maker 2000/2003 game (or a packed/encrypted one)")
    print(f"\n[games] {len(games)} game folder(s):")
    for g in games:
        print("  ", g)

    for game in games:
        print(f"\n===== {game}")
        ini, _ = read_ini(game)
        if ini:
            print(f"[ini] GameTitle={ini.get('gametitle')!r}  Encoding={ini.get('encoding', '(not set)')}  "
                  f"FullPackageFlag={ini.get('fullpackageflag', '(not set)')}")
            if ini.get("fullpackageflag") != "1":
                print("      FullPackageFlag != 1: the game may rely on the RTP (runtime package);"
                      " the web player cannot load an installed RTP — RTP assets it uses must be copied in")
        else:
            print("[ini] no RPG_RT.ini")

        dirs = {d.lower() for d in os.listdir(game) if os.path.isdir(os.path.join(game, d))}
        print("[engine] folders suggest", "RPG Maker 2003" if dirs & RM2003_ONLY_DIRS else "RPG Maker 2000",
              "— EasyRPG's web build cannot read RPG_RT.exe, decide the version (see SKILL.md step 3)")

        results, n_non_ascii, ascii_hits, n_ascii = encoding_match(game)
        print(f"[names] ASCII asset names referenced in data: {ascii_hits}/{n_ascii}")
        if n_non_ascii:
            best_hit, best_enc = results[0]
            print(f"[names] non-ASCII asset names found in data, per encoding: "
                  + ", ".join(f"{e}={h}" for h, e in results[:4]) + f"  (of {n_non_ascii})")
            if best_hit == 0:
                print("        none match: file names are probably mis-decoded (re-extract with another"
                      " encoding) or the data references other files")
            else:
                print(f"        -> database text encoding is most likely {best_enc}"
                      f" (EasyRPG codepage {best_enc[2:] if best_enc.startswith('cp') else best_enc});"
                      " file names on disk already match it — do not rename them")

        drop, keep_patches, big, total, count = [], [], [], 0, 0
        for d, _, files in os.walk(game):
            for f in files:
                p = os.path.join(d, f)
                rel = os.path.relpath(p, game).replace(os.sep, "/")
                size = os.path.getsize(p)
                total += size
                count += 1
                if DROP.search(rel):
                    drop.append(rel)
                if f.lower() in PATCH_FILES:
                    keep_patches.append(f"{rel} ({PATCH_FILES[f.lower()]})")
                if size > GITHUB_FILE_LIMIT:
                    big.append(f"{rel} ({size / 1048576:.0f} MB)")
        print(f"[size] {count} files, {total / 1048576:.1f} MB")
        if drop:
            print(f"[drop] not needed on the web ({len(drop)}): " + ", ".join(drop[:8]) + (" …" if len(drop) > 8 else ""))
        if keep_patches:
            print("[keep] patch marker files — EasyRPG enables the patch when these exist: " + ", ".join(keep_patches))
        if big:
            print("[size] over GitHub's 100 MB file limit: " + ", ".join(big))
        for extra in ["Font", "easyrpg.soundfont", "EasyRPG.ini"]:
            if any(x.lower() == extra.lower() for x in os.listdir(game)):
                print(f"[extra] has {extra}")

    readmes = [os.path.join(d, f) for d, _, files in os.walk(root) for f in files
               if f.lower().endswith((".txt", ".htm", ".html")) and "manual" not in d.lower()]
    if readmes:
        print("\n[readme] read these for controls (Shift, F-keys), RTP needs and version hints:")
        for r in readmes[:10]:
            print("  ", r)


if __name__ == "__main__":
    main()
