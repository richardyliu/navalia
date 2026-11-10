#!/usr/bin/env bash
# Live byte diff: OSS mac-ax-helper vs addon axTree() on the same frontmost app.
# Needs Accessibility for the responsible process (the terminal when run from
# one). Only the top-level "timestamp" line is normalized (second precision,
# the two reads are not simultaneous). Keep the frontmost window static.
#   native/scripts/live-diff.sh [helper flags, e.g. --focused-window-only --depth 100]
set -euo pipefail
NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${OSS_HELPER_SRC:-${HOME}/Documents/GitHub/personal-model/resources/mac-ax-helper.swift}"
OUT="${NATIVE_DIR}/build/live-diff"
mkdir -p "${OUT}"
if [[ ! -x "${OUT}/mac-ax-helper" || "${SRC}" -nt "${OUT}/mac-ax-helper" ]]; then
  CLANG_MODULE_CACHE_PATH="${OUT}/module-cache" swiftc "${SRC}" -o "${OUT}/mac-ax-helper" \
    -O -target arm64-apple-macos12.0 -swift-version 5 -suppress-warnings
fi
"${OUT}/mac-ax-helper" --check-accessibility || { echo "[live-diff] Accessibility not granted (exit 2)" >&2; exit 2; }
"${OUT}/mac-ax-helper" "$@" > "${OUT}/helper.json"
node - "${NATIVE_DIR}/build/Release/navalia-native.node" "${OUT}/addon.json" "$@" <<'JS'
const [addonPath, outPath, ...flags] = process.argv.slice(2)
const o = {}
for (let i = 0; i < flags.length; i++) {
  const f = flags[i]
  if (f === '--all-visible') o.allVisible = true
  else if (f === '--focused-window-only') o.focusedWindowOnly = true
  else if (f === '--raw') o.raw = true
  else if (f === '--no-force-app-ax') o.forceAppAccessibility = false
  else if (f === '--depth') o.maxDepth = Number(flags[++i])
  else if (f === '--timeout') o.timeout = Number(flags[++i])
  else if (f === '--app-name') o.appName = flags[++i]
}
require(addonPath).axTree(o).then((json) => require('fs').writeFileSync(outPath, json + '\n'))
JS
norm() { sed -E 's/^  "timestamp" : "[^"]*"/  "timestamp" : "<ts>"/' "$1"; }
if diff <(norm "${OUT}/helper.json") <(norm "${OUT}/addon.json") > "${OUT}/diff.txt"; then
  echo "[live-diff] identical ($(wc -c < "${OUT}/helper.json") bytes)"
else
  echo "[live-diff] DIFFERENT, see ${OUT}/diff.txt" >&2
  exit 1
fi
