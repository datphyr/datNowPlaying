#!/usr/bin/env bash
# Build a loadable extension archive: manifest.json + src/ + icons/ inside one
# top-level folder, so unzipping and pointing "Load unpacked" at the result
# works as-is.
#
#   bash scripts/package.sh [tag]
#
# The optional tag only names the output (default: "dev"). Used both locally and
# by the release workflow. Prefers `zip`; falls back to Python's zipfile so it
# runs on a bare machine too.
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-dev}"
name="datNowPlaying-${tag}"
archive="dist/${name}.zip"

rm -rf "dist/${name}" "$archive"
mkdir -p "dist/${name}"
cp manifest.json "dist/${name}/"
cp -r src icons "dist/${name}/"

if command -v zip >/dev/null 2>&1; then
  ( cd dist && zip -qr "${name}.zip" "$name" )
else
  python3 -c '
import os, sys, zipfile
name = sys.argv[1]
root = os.path.join("dist", name)
with zipfile.ZipFile(os.path.join("dist", name + ".zip"), "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, filenames in os.walk(root):
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            z.write(full, os.path.relpath(full, "dist"))
' "$name"
fi
rm -rf "dist/${name}"

echo "built ${archive}"
python3 -c 'import sys, zipfile; [print(" ", n) for n in zipfile.ZipFile(sys.argv[1]).namelist()]' "$archive"
