#!/usr/bin/env bash
# Compile the OSS Runtime's mac-ax-helper.swift into a fixture-driven oracle.
# The OSS file is copied (never modified in place); only its AX C-API call
# sites are rebound to fixture stand-ins (test-oracle/fake-ax.swift).
#
#   OSS_HELPER_SRC=/path/to/mac-ax-helper.swift native/scripts/build-oracle.sh
#
# Output: native/build/oracle/mac-ax-helper-oracle (+ helper.sha256)
set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${OSS_HELPER_SRC:-${HOME}/Documents/GitHub/personal-model/resources/mac-ax-helper.swift}"
OUT_DIR="${NATIVE_DIR}/build/oracle"
mkdir -p "${OUT_DIR}"

if [[ ! -f "${SRC}" ]]; then
  echo "[oracle] OSS helper source not found: ${SRC}" >&2
  exit 1
fi

shasum -a 256 "${SRC}" | awk '{print $1}' > "${OUT_DIR}/helper.sha256"
GEN="${OUT_DIR}/mac-ax-helper.rebound.swift"

# 1) rebind AX C-API calls, 2) rename main() and drop its top-level call.
perl -pe '
  s/\bAXUIElementCopyAttributeValue\b/FakeAXUIElementCopyAttributeValue/g;
  s/\bAXUIElementCopyAttributeNames\b/FakeAXUIElementCopyAttributeNames/g;
  s/\bAXUIElementSetAttributeValue\b/FakeAXUIElementSetAttributeValue/g;
  s/\bAXUIElementCreateApplication\b/FakeAXUIElementCreateApplication/g;
  s/\bCFEqual\(/FakeCFEqual(/g;
  s/\bAXUIElement\b/FakeEl/g;
  s/^func main\(\) \{/func ossHelperMain() {/;
  $_ = "" if /^main\(\)\s*$/;
' "${SRC}" > "${GEN}"

# Every AX element reference must now go through the fake layer.
if grep -nE '\bAXUIElement[A-Za-z]*\b' "${GEN}" | grep -v 'FakeAXUIElement'; then
  echo "[oracle] unrebound AXUIElement reference left in ${GEN}" >&2
  exit 1
fi

CLANG_MODULE_CACHE_PATH="${OUT_DIR}/module-cache" swiftc \
  "${NATIVE_DIR}/test-oracle/fake-ax.swift" "${GEN}" "${NATIVE_DIR}/test-oracle/main.swift" \
  -o "${OUT_DIR}/mac-ax-helper-oracle" -O -swift-version 5 -suppress-warnings
echo "[oracle] ${OUT_DIR}/mac-ax-helper-oracle (helper sha256 $(cat "${OUT_DIR}/helper.sha256"))"
