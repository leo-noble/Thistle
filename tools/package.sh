#!/usr/bin/env bash
#
# Builds the store-ready zips.
#
# The point of this script is what it leaves out. Zipping the repo folder
# ships the README, the icon generator, and .claude/ inside everyone's
# browser profile — none of which the extension reads. So the list below is
# an allowlist, not an ignore list: a new file has to be named here to be
# published, which fails safe when something private lands in the repo.
#
# LICENSE and THIRD_PARTY_NOTICES.md do stay. MIT requires the notice to
# travel with the code, and the usage bridge is derived from Claude Counter
# under the same terms.
#
# Two zips come out, because the two stores disagree about one key:
#   thistle-<version>.zip         AMO / Firefox — the manifest as written
#   thistle-<version>-chrome.zip  Chrome, Edge, Brave — gecko keys stripped,
#                                 which Chrome only warns about but the Web
#                                 Store reviewer shouldn't have to read past
#
# Usage:  ./tools/package.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Exactly what ships. Directories are taken whole; see the filter below.
SHIP=(
  manifest.json
  LICENSE
  THIRD_PARTY_NOTICES.md
  content
  popup
  icons
)

version="$(node -p "require('./manifest.json').version")"
out="$root/dist"
stage="$out/.stage"

rm -rf "$stage"
mkdir -p "$stage"

for path in "${SHIP[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "missing: $path" >&2
    exit 1
  fi
  # -R copies directories whole; the prune below takes back what shouldn't
  # have come with them.
  cp -R "$path" "$stage/"
done

# icons/ carries the generator, its source art, and the 512px logo the
# README renders — none of which the browser loads. Keep exactly the files
# the manifest names, read out of the manifest so this can't drift when the
# icon set changes.
node -e '
  const fs = require("fs");
  const path = require("path");
  const stage = process.argv[1];
  const m = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
  const keep = new Set(
    [...Object.values(m.icons || {}), ...Object.values(m.action?.default_icon || {})]
      .map((p) => path.basename(p))
  );
  for (const name of fs.readdirSync(path.join(stage, "icons"))) {
    if (!keep.has(name)) fs.rmSync(path.join(stage, "icons", name), { recursive: true });
  }
' "$stage"
# macOS resource forks and editor droppings, wherever they turn up.
find "$stage" -name '.DS_Store' -delete

echo "packaging $version"
echo

# manifest.json has to sit at the root of the archive, not under a folder —
# both stores reject a nested one.
build() {
  local name="$1"
  local zip="$out/$name"
  rm -f "$zip"
  ( cd "$stage" && zip -q -r -X "$zip" . )
  echo "  $name  ($(du -h "$zip" | cut -f1 | tr -d ' '))"
}

build "thistle-$version.zip"

# Chrome build: same tree, minus the Firefox-only manifest keys.
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  delete m.browser_specific_settings;
  fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
' "$stage/manifest.json"

build "thistle-$version-chrome.zip"

rm -rf "$stage"

echo
echo "contents:"
unzip -Z1 "$out/thistle-$version.zip" | sed 's/^/  /'
