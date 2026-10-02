#!/usr/bin/env python3
"""Generate index.json for the EasyRPG web player.

Python port of EasyRPG's gencache (https://github.com/EasyRPG/Tools/tree/master/gencache),
so the file index can be built without compiling the C++ tool.

The web player downloads game files on demand over HTTP and looks them up
through this index: keys are the lowercased, NFKC-normalized names (without
extension below the top level), values are the real file names on the server.

Usage: python3 tools/gencache.py [-p] [-o OUTPUT] [-r DEPTH] [DIRECTORY]
"""

import argparse
import datetime
import json
import os
import sys
import unicodedata

KEEP_EXTENSIONS = (".ini", ".po")


def normalize(name):
    return unicodedata.normalize("NFKC", name.lower())


def strip_ext(name):
    pos = name.rfind(".")
    return name if pos == -1 else name[:pos]


def parse_dir(path, depth, first=False):
    # Matches the C++ tool: an exhausted depth yields nothing and is skipped
    if depth == 0:
        return None

    result = {}
    if not first:
        result["_dirname"] = os.path.basename(path)

    with os.scandir(path) as entries:
        for entry in entries:
            name = entry.name
            key = normalize(name)

            if name == "_dirname":
                print("Skipping _dirname: File conflicts with reserved keyword!", file=sys.stderr)
                continue

            if entry.is_dir(follow_symlinks=False):
                sub = parse_dir(os.path.join(path, name), depth - 1)
                if sub:
                    result[key] = sub
            elif entry.is_symlink() or entry.is_file(follow_symlinks=False):
                if first or key.endswith(KEEP_EXTENSIONS):
                    # ExFont is a special file in the main directory, needs to be renamed
                    if strip_ext(key) == "exfont":
                        key = "exfont"
                    result[key] = name
                else:
                    result[strip_ext(key)] = name

    return result


def main():
    parser = argparse.ArgumentParser(description="JSON cache generator for EasyRPG Player web builds")
    parser.add_argument("directory", nargs="?", default=".")
    parser.add_argument("-p", "--pretty", action="store_true", help="pretty print the JSON contents")
    parser.add_argument("-o", "--output", default=None, help='output file (default: "<directory>/index.json")')
    parser.add_argument("-r", "--recurse", type=int, default=4, help="recursion depth (default: 4)")
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        parser.error(f'Not a directory: "{args.directory}"')

    output = args.output or os.path.join(args.directory, "index.json")
    out = {
        "metadata": {"version": 2, "date": datetime.date.today().isoformat()},
        "cache": parse_dir(args.directory, args.recurse, first=True),
    }

    with open(output, "w", encoding="utf-8") as f:
        if args.pretty:
            json.dump(out, f, ensure_ascii=False, sort_keys=True, indent=2)
        else:
            json.dump(out, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    print(f'JSON cache has been written to "{output}".')


if __name__ == "__main__":
    main()
