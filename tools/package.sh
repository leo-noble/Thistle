#!/usr/bin/env bash
# ============================================================
# Thistle — package.sh
#
# Builds the two loadable archives into dist/, which .gitignore
# excludes: every byte in them is generated from the tracked
# sources, so committing them would only duplicate what the tree
# already says.
#
#   dist/thistle-chrome-<version>.zip
#   dist/thistle-firefox-<version>.zip
#
# Two archives rather than one because the manifests differ.
# Firefox needs browser_specific_settings — the extension id and
# the minimum versions are what let it be signed and installed at
# all — and Chrome logs it as an unrecognised key, so it is
# stripped from the Chrome build rather than shipped as a warning
# every reviewer sees.
#
# Usage: tools/package.sh
# ============================================================
set -euo pipefail

# Resolved from the script's own location, so it can be run from anywhere
# rather than only from the repo root.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

for tool in python3 zip; do
  command -v "$tool" >/dev/null || { echo "package.sh: need $tool on PATH" >&2; exit 1; }
done

version="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"

# What ships. Listed rather than derived by excluding: an allowlist fails by
# leaving something out, which is visible the moment the extension is loaded,
# where a denylist fails by shipping test fixtures or .claude/ and nobody
# notices. Directories are copied whole.
payload=(manifest.json icons content popup)

dist="$root/dist"
stage="$(mktemp -d "${TMPDIR:-/tmp}/thistle-pkg.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$dist"

build() {
  local target="$1"      # chrome | firefox
  local out="$dist/thistle-$target-$version.zip"
  local work="$stage/$target"

  mkdir -p "$work"
  cp -R "${payload[@]}" "$work/"

  # Finder droppings are not part of the extension, and Chrome's reviewer
  # tooling flags them.
  find "$work" -name '.DS_Store' -delete

  if [ "$target" = "chrome" ]; then
    python3 - "$work/manifest.json" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    manifest = json.load(fh)

manifest.pop("browser_specific_settings", None)

with open(path, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY
  fi

  rm -f "$out"
  # -X drops the extra file attributes (uid/gid, resource forks) that would
  # otherwise differ between machines. Entries are fed in sorted so the
  # archive's order is stable too; mtimes still vary, so this is tidy rather
  # than bit-reproducible.
  ( cd "$work" && find . -type f | sed 's|^\./||' | sort | zip -q -X -@ "$out" )

  echo "$target  $(basename "$out")  $(du -h "$out" | cut -f1)  $(unzip -l "$out" | tail -1 | awk '{print $2}') files"
}

build chrome
build firefox

echo
echo "dist/ is gitignored — these are build output, rebuilt from source on every release."
