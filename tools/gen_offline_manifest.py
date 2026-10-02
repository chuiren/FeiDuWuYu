#!/usr/bin/env python3
"""Generate web/offline-manifest.json and stamp the service worker version.

Lists every file the site serves (runtime, add-ons, game data, the generated
index.json) with its size and SHA-256, so offline.js can download, verify and
reuse unchanged files across versions. Run it after tools/gencache.py.

Usage: python3 tools/gen_offline_manifest.py WEB_DIR --version VERSION
"""

import argparse
import hashlib
import json
import os

MANIFEST = "offline-manifest.json"
SERVICE_WORKER = "sw.js"
VERSION_PLACEHOLDER = "__BUILD_VERSION__"
# Not cached by offline.js: the manifest itself, and the service worker
# (the browser keeps and updates that on its own)
EXCLUDE = {MANIFEST, SERVICE_WORKER}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("web_dir")
    parser.add_argument("--version", required=True, help="cache version, e.g. the Git commit SHA")
    args = parser.parse_args()

    files = []
    for root, dirs, names in os.walk(args.web_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, args.web_dir).replace(os.sep, "/")
            if rel in EXCLUDE:
                continue
            with open(path, "rb") as f:
                data = f.read()
            files.append({"path": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    manifest = {"version": args.version, "files": files}
    with open(os.path.join(args.web_dir, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    sw_path = os.path.join(args.web_dir, SERVICE_WORKER)
    with open(sw_path, encoding="utf-8") as f:
        sw = f.read()
    if VERSION_PLACEHOLDER not in sw:
        raise SystemExit(f"{sw_path}: version placeholder not found (already stamped?)")
    with open(sw_path, "w", encoding="utf-8") as f:
        f.write(sw.replace(VERSION_PLACEHOLDER, args.version))

    total = sum(f["size"] for f in files)
    print(f"{MANIFEST}: version {args.version}, {len(files)} files, {total / 1048576:.1f} MB")


if __name__ == "__main__":
    main()
