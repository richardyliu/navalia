#!/usr/bin/env bash
# Record oracle output for every fixture x mode in native/fixtures/ax.
# Expected files hold the oracle's exact stdout bytes; a failing run (non-zero
# exit, e.g. app not found) is recorded as "<name>.<mode>.expected.exit".
set -euo pipefail
NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="${NATIVE_DIR}/fixtures/ax"
ORACLE="${NATIVE_DIR}/build/oracle/mac-ax-helper-oracle"
[[ -x "${ORACLE}" ]] || "${NATIVE_DIR}/scripts/build-oracle.sh"
cp "${NATIVE_DIR}/build/oracle/helper.sha256" "${FIX}/ORACLE_HELPER_SHA256"
rm -f "${FIX}"/*.expected.json "${FIX}"/*.expected.exit
count=0
for input in "${FIX}"/*.input.json; do
  base="$(basename "${input}" .input.json)"
  while IFS=$'\t' read -r mode args; do
    # shellcheck disable=SC2086
    set +e
    LENS_AX_FIXTURE="${input}" "${ORACLE}" ${args} > "${FIX}/${base}.${mode}.expected.json" 2>/dev/null
    code=$?
    set -e
    if [[ ${code} -ne 0 ]]; then
      rm -f "${FIX}/${base}.${mode}.expected.json"
      echo "${code}" > "${FIX}/${base}.${mode}.expected.exit"
    fi
    count=$((count + 1))
  done < <(node -e '
    for (const m of require(process.argv[1])) console.log(m.name + "\t" + m.args.join(" "))
  ' "${FIX}/modes.json")
done
echo "[record] ${count} cases recorded in ${FIX}"
