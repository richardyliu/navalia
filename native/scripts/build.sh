#!/usr/bin/env bash
# Build navalia-native.node against the Electron headers of the Electron
# version installed in node_modules (Node-API, arm64).
#
#   native/scripts/build.sh            # Electron target (default)
#   native/scripts/build.sh --node     # host Node target (same Node-API ABI)
#
# Output: native/build/Release/navalia-native.node
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[native] macOS only" >&2
  exit 1
fi

NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "${NATIVE_DIR}/.." && pwd)"
GYP="${ROOT}/node_modules/node-gyp/bin/node-gyp.js"
if [[ ! -f "${GYP}" ]]; then
  echo "[native] node-gyp not found at ${GYP}; run npm install" >&2
  exit 1
fi

ARCH="${LENS_NATIVE_ARCH:-arm64}"
ARGS=(rebuild --directory "${NATIVE_DIR}" --arch="${ARCH}" --jobs=max)
if [[ "${1:-}" != "--node" ]]; then
  ELECTRON_VERSION="$(node -p "require('${ROOT}/node_modules/electron/package.json').version")"
  ARGS+=(--target="${ELECTRON_VERSION}" --dist-url=https://electronjs.org/headers \
         --devdir="${HOME}/.electron-gyp")
  echo "[native] building for Electron ${ELECTRON_VERSION} (${ARCH})"
else
  echo "[native] building for host Node $(node -v) (${ARCH})"
fi

node "${GYP}" "${ARGS[@]}"
OUT="${NATIVE_DIR}/build/Release/navalia-native.node"
test -f "${OUT}"
echo "[native] ${OUT}"
