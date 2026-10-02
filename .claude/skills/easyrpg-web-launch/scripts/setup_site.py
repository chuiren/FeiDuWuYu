#!/usr/bin/env python3
"""Build a GitHub Pages repo for an EasyRPG web game from the skill template.

Usage:
  python3 setup_site.py --player PLAYER --game GAME_DIR --out REPO_DIR \
      --id ruina --title "Ruina 废都物语" --short-name "废都物语" [--engine rpg2kv150] [--lang zh-CN]

PLAYER is the EasyRPG web build: a directory, .zip or .tar.gz that contains
index.html, index.js and index.wasm (any depth).

Result in REPO_DIR:
  .github/workflows/deploy-web.yml, .gitignore, tools/ (gencache, offline manifest)
  web/index.html (stock shell + small patches), index.js, index.wasm,
  web/sw.js offline.js easyrpg-zip.js saves.js console.js addons.css,
  web/manifest.webmanifest, web/icons/*, web/games/<id>/ (game, minus junk)
"""

import argparse
import json
import os
import re
import shutil
import struct
import sys
import tarfile
import tempfile
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "..", "assets", "template")
DROP = re.compile(r"(^|/)(rpg_rt\.exe|thumbs\.db|desktop\.ini|\.ds_store)$|\.bak$|(^|/)__macosx/", re.I)
ENGINES = {"rpg2k", "rpg2kv150", "rpg2ke", "rpg2k3", "rpg2k3v105", "rpg2k3e"}
GITHUB_FILE_LIMIT = 100 * 1024 * 1024


# ------------------------------------------------------------ player files

def find_player(path, tmp):
    if os.path.isfile(path):
        if zipfile.is_zipfile(path):
            zipfile.ZipFile(path).extractall(tmp)
        else:
            with tarfile.open(path) as t:
                t.extractall(tmp)
        path = tmp
    for d, _, files in os.walk(path):
        if {"index.html", "index.js", "index.wasm"} <= set(files):
            return d
    sys.exit(f"index.html/index.js/index.wasm not found in {path}")


def patch_index_html(html, cfg):
    """Apply the add-on hooks to the stock EasyRPG emscripten shell."""
    def rep(old, new):
        nonlocal html
        if html.count(old) != 1:
            sys.exit(f"index.html: anchor not found (EasyRPG shell changed?):\n{old}")
        html = html.replace(old, new)

    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    rep('<meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>EasyRPG Player</title>',
        f'''<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>{esc(cfg["title"])}</title>
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icons/icon-192.png">
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="{esc(cfg["short_name"])}">''')
    rep("  </style>\n", '  </style>\n  <link rel="stylesheet" href="addons.css">\n')
    rep('<script type="text/javascript" src="index.js"></script>\n',
        '<script type="text/javascript" src="index.js"></script>\n'
        f'<script>window.GAME_CONFIG = {json.dumps({"id": cfg["id"], "title": cfg["title"]}, ensure_ascii=False)};</script>\n'
        '<script src="offline.js"></script>\n<script src="easyrpg-zip.js"></script>\n'
        '<script src="saves.js"></script>\n<script src="console.js"></script>\n')
    rep("window.addEventListener('load', (event) => {\n    createEasyRpgPlayer({",
        "// (waits for offline preparation, see offline.js)\n"
        "window.addEventListener('load', async (event) => {\n"
        "    if (window.EasyRPGOffline) await EasyRPGOffline.beforeStart();\n"
        "    createEasyRpgPlayer({")
    # The game id selects web/games/<id>/ and gives the saves their own
    # IndexedDB (/easyrpg/<id>/Save), so games on one origin don't mix saves
    rep("      game: undefined,", f"      game: {json.dumps(cfg['id'])},")
    rep("      easyrpgPlayer.initApi();\n      canvas.focus();\n",
        "      easyrpgPlayer.initApi();\n      canvas.focus();\n"
        "      window.easyrpgPlayer = Module;\n"
        "      window.dispatchEvent(new CustomEvent('easyrpg-ready', { detail: Module }));\n")
    rep("  const event = new Event(eventType, { bubbles: true });\n  event.code = key;\n",
        "  // A real KeyboardEvent: SDL's lock-key listener calls getModifierState()\n"
        "  const event = new KeyboardEvent(eventType, { bubbles: true, code: key, key: key });\n")
    return html


# ------------------------------------------------------------------- icons

def read_xyz(path):
    b = open(path, "rb").read()
    if b[:4] != b"XYZ1":
        raise ValueError("not XYZ")
    w, h = struct.unpack("<HH", b[4:8])
    d = zlib.decompress(b[8:])
    pal = [tuple(d[i * 3:i * 3 + 3]) for i in range(256)]
    px = d[768:768 + w * h]
    return w, h, [[pal[px[y * w + x]] for x in range(w)] for y in range(h)]


def read_png(path):
    d = open(path, "rb").read()
    if d[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not PNG")
    pos, idat, pal = 8, b"", None
    while pos < len(d):
        n = struct.unpack(">I", d[pos:pos + 4])[0]
        t, c = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + n]
        pos += 12 + n
        if t == b"IHDR":
            w, h, bd, ct, _, _, il = struct.unpack(">IIBBBBB", c)
        elif t == b"PLTE":
            pal = [tuple(c[i:i + 3]) for i in range(0, len(c), 3)]
        elif t == b"IDAT":
            idat += c
    if bd != 8 or il or ct not in (2, 3, 6):
        raise ValueError("unsupported PNG variant")
    bpp = {2: 3, 3: 1, 6: 4}[ct]
    raw, stride, prev, rows, i = zlib.decompress(idat), w * bpp, bytearray(w * bpp), [], 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append([pal[line[x]] if ct == 3 else tuple(line[x * bpp:x * bpp + 3]) for x in range(w)])
        prev = line
    return w, h, rows


def read_bmp(path):
    d = open(path, "rb").read()
    if d[:2] != b"BM":
        raise ValueError("not BMP")
    off = struct.unpack("<I", d[10:14])[0]
    w, h, _, bits, comp = struct.unpack("<iiHHI", d[18:34])
    if comp or bits not in (8, 24):
        raise ValueError("unsupported BMP variant")
    pal = [(d[54 + i * 4 + 2], d[54 + i * 4 + 1], d[54 + i * 4]) for i in range(256)] if bits == 8 else None
    stride = ((w * bits // 8) + 3) & ~3
    rows = []
    for y in range(abs(h)):
        r = d[off + y * stride: off + (y + 1) * stride]
        rows.append([pal[r[x]] if bits == 8 else (r[x * 3 + 2], r[x * 3 + 1], r[x * 3]) for x in range(w)])
    if h > 0:
        rows.reverse()
    return w, abs(h), rows


def read_image(path):
    for reader in (read_xyz, read_png, read_bmp):
        try:
            return reader(path)
        except (ValueError, struct.error, zlib.error, IndexError):
            continue
    raise ValueError(f"cannot read image {path}")


def write_png(path, rows):
    h, w = len(rows), len(rows[0])
    raw = b"".join(b"\0" + bytes(c for px in r for c in px) for r in rows)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def make_icons(source, out_dir):
    """Letterbox the whole image into squares (nearest neighbour)."""
    w, h, px = read_image(source)
    side = max(w, h)
    ox, oy = (side - w) // 2, (side - h) // 2
    bg = px[0][0]
    os.makedirs(out_dir, exist_ok=True)
    for size, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        rows = []
        for Y in range(size):
            y = Y * side // size - oy
            rows.append([px[y][x] if 0 <= y < h and 0 <= (x := X * side // size - ox) < w else bg
                         for X in range(size)])
        write_png(os.path.join(out_dir, name), rows)


def find_title_image(game):
    for d in os.listdir(game):
        if d.lower() == "title" and os.path.isdir(os.path.join(game, d)):
            for f in sorted(os.listdir(os.path.join(game, d))):
                try:
                    read_image(os.path.join(game, d, f))
                    return os.path.join(game, d, f)
                except ValueError:
                    continue
    return None


# -------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--player", required=True)
    ap.add_argument("--game", required=True, help="folder containing RPG_RT.ldb")
    ap.add_argument("--out", required=True, help="repo working tree to fill")
    ap.add_argument("--id", required=True, help="short lowercase ASCII id: web/games/<id>/, save storage, zip name")
    ap.add_argument("--title", required=True)
    ap.add_argument("--short-name", required=True, help="home-screen name")
    ap.add_argument("--engine", choices=sorted(ENGINES), help="written to EasyRPG.ini [Game] Engine=")
    ap.add_argument("--lang", default="zh-CN")
    ap.add_argument("--icon", help="image for the app icon (xyz/png/bmp); default: first Title image")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.id):
        sys.exit("--id must be lowercase ASCII letters, digits, - or _")
    if not os.path.isfile(os.path.join(args.game, "RPG_RT.ldb")) and not any(
            f.lower() == "rpg_rt.ldb" for f in os.listdir(args.game)):
        sys.exit(f"{args.game} has no RPG_RT.ldb")

    out, web = args.out, os.path.join(args.out, "web")
    os.makedirs(web, exist_ok=True)

    # template: workflow, tools, add-ons
    for item in (".github", "tools", ".gitignore"):
        src = os.path.join(TEMPLATE, item)
        dst = os.path.join(out, item)
        shutil.copytree(src, dst, dirs_exist_ok=True) if os.path.isdir(src) else shutil.copy2(src, dst)
    for f in os.listdir(os.path.join(TEMPLATE, "web")):
        shutil.copy2(os.path.join(TEMPLATE, "web", f), web)

    # player
    with tempfile.TemporaryDirectory() as tmp:
        pdir = find_player(args.player, tmp)
        for f in ("index.js", "index.wasm"):
            shutil.copy2(os.path.join(pdir, f), web)
        html = open(os.path.join(pdir, "index.html"), encoding="utf-8").read()
    cfg = {"id": args.id, "title": args.title, "short_name": args.short_name}
    with open(os.path.join(web, "index.html"), "w", encoding="utf-8") as f:
        f.write(patch_index_html(html, cfg))

    # game
    dest = os.path.join(web, "games", args.id)
    copied, dropped, total = 0, [], 0
    for d, _, files in os.walk(args.game):
        for name in files:
            src = os.path.join(d, name)
            rel = os.path.relpath(src, args.game).replace(os.sep, "/")
            if DROP.search(rel):
                dropped.append(rel)
                continue
            size = os.path.getsize(src)
            if size > GITHUB_FILE_LIMIT:
                sys.exit(f"{rel} is {size / 1048576:.0f} MB — over GitHub's 100 MB file limit")
            os.makedirs(os.path.join(dest, os.path.dirname(rel)), exist_ok=True)
            shutil.copy2(src, os.path.join(dest, rel))
            copied += 1
            total += size

    if args.engine:
        ini = os.path.join(dest, "EasyRPG.ini")
        text = open(ini, encoding="utf-8").read() if os.path.exists(ini) else ""
        if re.search(r"(?mi)^\s*Engine\s*=", text):
            text = re.sub(r"(?mi)^\s*Engine\s*=.*$", f"Engine={args.engine}", text)
        elif re.search(r"(?mi)^\[Game\]", text):
            text = re.sub(r"(?mi)^\[Game\]\s*$", f"[Game]\r\nEngine={args.engine}", text, count=1)
        else:
            text = f"[Game]\r\nEngine={args.engine}\r\n" + text
        with open(ini, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    manifest = {
        "name": args.title, "short_name": args.short_name, "lang": args.lang,
        "start_url": "./", "scope": "./", "display": "fullscreen",
        "background_color": "#000000", "theme_color": "#000000",
        "icons": [{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"}],
    }
    with open(os.path.join(web, "manifest.webmanifest"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    icon_src = args.icon or find_title_image(args.game)
    if icon_src:
        make_icons(icon_src, os.path.join(web, "icons"))
        print(f"icons: from {icon_src} (check web/icons/icon-512.png; pass --icon to change)")
    else:
        print("icons: no readable Title image — add web/icons/{icon-192,icon-512,apple-touch-icon}.png by hand")

    print(f"game: {copied} files, {total / 1048576:.1f} MB -> {os.path.relpath(dest, out)}")
    if dropped:
        print(f"dropped ({len(dropped)}): " + ", ".join(dropped[:10]) + (" …" if len(dropped) > 10 else ""))
    print("engine:", f"EasyRPG.ini Engine={args.engine}" if args.engine else "auto-detect (no --engine)")
    print(f"done: {out}")


if __name__ == "__main__":
    main()
