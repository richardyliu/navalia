#!/usr/bin/env bash
# Static + launch checks on a packaged Navalia.app (no CDP needed).
#
#   bash tests/e2e/packaged-check.sh "<dist>/mac-arm64/Navalia.app" [seconds]
#
# All checks are [real]. Uses temp PERSOME_ROOT / LENS_STORE_ROOT / --user-data-dir,
# so it can run next to an already running Lens. The perl alarm is the only way
# the launched instance is terminated; no other process is signalled.
set -u
APP="${1:?usage: packaged-check.sh <Navalia.app> [seconds]}"
SECS="${2:-60}"
BIN="$APP/Contents/MacOS/Navalia"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${E2E_TMP:-${TMPDIR:-/tmp}}/navalia-pkg-XXXXXX")"
FAIL=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

pidtree() { # pidtree <root pid> -> comma list of the whole descendant tree
  local all="$1" frontier="$1" next p
  while [ -n "$frontier" ]; do
    next=""
    for p in $frontier; do next="$next $(pgrep -P "$p" | tr '\n' ' ')"; done
    frontier="$(echo $next)"; [ -n "$frontier" ] && all="$all $frontier"
  done
  echo $all | tr ' ' ','
}
# S2-01: a fresh Lens Store shows the onboarding overlay; pre-seed a "skipped" record (0600).
seed_onboarding() {
  mkdir -p "$1"; chmod 700 "$1"
  printf '%s\n' '{"version":1,"outcome":"skipped","lastStep":"welcome","completedAt":null,"skippedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}' > "$1/onboarding.json"
  chmod 600 "$1/onboarding.json"
}
mkroot() { mkdir -p "$1/pr" "$1/store" "$1/ud"; seed_onboarding "$1/store"; printf '[capture]\nsource = "daemon"\n\n[mcp]\nport = 8742\n' > "$1/pr/config.toml"; }
launch() { # launch <dir> <alarm> [extra args...] ; env overrides via LAUNCH_ENV
  local d="$1" a="$2"; shift 2
  env -u ELECTRON_RUN_AS_NODE PERSOME_ROOT="$d/pr" LENS_STORE_ROOT="$d/store" ${LAUNCH_ENV:-} \
    perl -e 'alarm shift; exec @ARGV' "$a" "$BIN" --user-data-dir="$d/ud" "$@" > "$d/out.log" 2>&1
}

# 1. addon outside asar, identical to the build output
NODE="$APP/Contents/Resources/native/navalia-native.node"
if [[ -f "$NODE" ]] && file "$NODE" | grep -q 'Mach-O 64-bit bundle arm64'; then
  pass "[real] addon at Resources/native/navalia-native.node (outside asar, arm64 bundle, sha256 $(shasum -a 256 "$NODE" | cut -c1-12))"
else fail "[real] addon missing or not an arm64 Mach-O bundle"; fi
if (cd "$ROOT" && npx --no-install asar list "$APP/Contents/Resources/app.asar") | grep -q '\.node$'; then
  fail "[real] a .node file is inside app.asar"; else pass "[real] no .node inside app.asar"; fi

# 2. fuses
FUSES="$(cd "$ROOT" && npx --no-install @electron/fuses read --app "$APP" 2>&1)"
echo "$FUSES" > "$TMP/fuses.txt"
for want in "RunAsNode is Disabled" "EnableNodeOptionsEnvironmentVariable is Disabled" \
            "EnableNodeCliInspectArguments is Disabled" "EnableEmbeddedAsarIntegrityValidation is Enabled" \
            "OnlyLoadAppFromAsar is Enabled"; do
  grep -q "$want" <<<"$FUSES" && pass "[real] fuse: $want" || fail "[real] fuse: $want"
done
grep -q "GrantFileProtocolExtraPrivileges is Disabled" <<<"$FUSES" \
  && pass "[real] fuse: GrantFileProtocolExtraPrivileges is Disabled" \
  || echo "WARN [real] GrantFileProtocolExtraPrivileges still Enabled (needs app:// protocol first)"

# 3. signature (ad-hoc expected until a Developer ID exists)
codesign -dv "$APP" > "$TMP/codesign.txt" 2>&1
grep -q '^Identifier=dev.navalia.app' "$TMP/codesign.txt" && pass "[real] bundle signed with identifier dev.navalia.app" \
  || fail "[real] bundle identifier is not dev.navalia.app: $(grep '^Identifier' "$TMP/codesign.txt")"
codesign --verify --deep --strict "$APP" 2>"$TMP/verify.txt" && pass "[real] codesign --verify --deep --strict" \
  || fail "[real] codesign verify: $(cat "$TMP/verify.txt")"
grep -q 'Signature=adhoc' "$TMP/codesign.txt" && echo "INFO signature is ad-hoc (distribution signing/notarization BLOCKED)"

# 3b. Info.plist permission surface (CAP-10: Accessibility + Screen Recording only)
PL="$APP/Contents/Info.plist"
# S1-FULL meetings (approved): the microphone is the one extra permission, and its text must say
# it is only used for a confirmed 「会议」 recording.
MIC="$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PL" 2>/dev/null)"
case "$MIC" in
  *会议*) pass "[real] NSMicrophoneUsageDescription present and scoped to 会议 recording" ;;
  *) fail "[real] NSMicrophoneUsageDescription missing or not scoped to 会议: '$MIC'" ;;
esac
for key in NSCameraUsageDescription NSAudioCaptureUsageDescription \
           NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$PL" >/dev/null 2>&1 && fail "[real] Info.plist still has $key" \
    || pass "[real] Info.plist has no $key"
done
/usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" "$PL" >/dev/null 2>&1 \
  && fail "[real] Info.plist still sets NSAllowsArbitraryLoads" || pass "[real] Info.plist has no NSAllowsArbitraryLoads"
[ "$(/usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsLocalNetworking" "$PL" 2>/dev/null)" = "true" ] \
  && pass "[real] ATS NSAllowsLocalNetworking = true kept" || fail "[real] ATS NSAllowsLocalNetworking missing"

# 4. ELECTRON_RUN_AS_NODE must not run Node
D="$TMP/runasnode"; mkroot "$D"
LAUNCH_ENV="ELECTRON_RUN_AS_NODE=1 LENS_SCREENSHOT=$D/shot.png" launch "$D" 30 -e "console.log('NODE_RAN_'+1)"
grep -q NODE_RAN_1 "$D/out.log" && fail "[real] ELECTRON_RUN_AS_NODE=1 executed Node" || pass "[real] ELECTRON_RUN_AS_NODE=1 ignored"

# 5. --inspect must not open a Node inspector
D="$TMP/inspect"; mkroot "$D"
LAUNCH_ENV="LENS_SCREENSHOT=$D/shot.png" launch "$D" 30 --inspect=127.0.0.1:0
grep -q 'Debugger listening' "$D/out.log" && fail "[real] --inspect opened a debugger" || pass "[real] --inspect ignored"

# 6. --remote-debugging-port (Chromium switch, not a fuse): should be refused in packaged builds
D="$TMP/rdp"; mkroot "$D"
LAUNCH_ENV="LENS_SCREENSHOT=$D/shot.png" launch "$D" 30 --remote-debugging-port=0
grep -q 'DevTools listening' "$D/out.log" && grep -q '\[lens\] screenshot written' "$D/out.log" \
  && fail "[real] --remote-debugging-port accepted (renderer drivable over CDP)" \
  || pass "[real] --remote-debugging-port refused"

# 7. test-only env overrides are stripped in a packaged build
#    NAVALIA_NATIVE -> a .node whose load-time constructor writes a marker file
#    (discriminating: the loader would dlopen it if the override were honoured).
#    LENS_HET_FAKE_ASSESSOR -> fixture assessor; honoured would leave transport='fixture'
#    rows in het.db. HET here reads ~/.claude/projects read-only (roots are stripped too).
D="$TMP/envstrip"; mkroot "$D"
cat > "$D/marker.c" <<CSRC
#include <stdio.h>
__attribute__((constructor)) static void lens_marker(void) {
  FILE *f = fopen("$D/MARKER", "w"); if (f) { fputs("loaded\n", f); fclose(f); }
}
CSRC
if clang -bundle -undefined dynamic_lookup -o "$D/marker.node" "$D/marker.c" 2>"$D/clang.txt"; then
  LAUNCH_ENV="NAVALIA_NATIVE=$D/marker.node LENS_HET_FAKE_ASSESSOR=$ROOT/tests/fixtures/het/fake-assessor.json" launch "$D" 40
  [ -f "$D/MARKER" ] && fail "[real] NAVALIA_NATIVE honoured: override addon was loaded" \
    || pass "[real] NAVALIA_NATIVE ignored (override .node not loaded)"
  grep -q '\[capture\] inactive: .*daemon' "$D/out.log" && pass "[real] bundled addon still loaded from Resources/native" \
    || fail "[real] capture log after NAVALIA_NATIVE: $(grep '\[capture\]' "$D/out.log")"
  if [ -f "$D/store/het.db" ]; then
    T="$(sqlite3 -readonly "$D/store/het.db" "select group_concat(distinct transport) from agent_calls" 2>&1)"
    case "$T" in
      *fixture*) fail "[real] LENS_HET_FAKE_ASSESSOR honoured (agent_calls transport: $T)" ;;
      *) pass "[real] LENS_HET_FAKE_ASSESSOR ignored (agent_calls transport: ${T:-none})" ;;
    esac
  else fail "[real] no het.db written in the scratch store"; fi
else fail "[real] could not build marker.node: $(cat "$D/clang.txt")"; fi

# 8. normal launch: addon loads, Broker listens on 8750 (LENS_BROKER_PORT ignored), only loopback sockets
D="$TMP/run"; mkroot "$D"
HOLDER="$(lsof -nP -iTCP:8750 -sTCP:LISTEN -Fpc 2>/dev/null | tr '\n' ' ')"
# LENS_BROKER_PORT=0 must be stripped: the Broker has to come up on 8750 anyway.
LAUNCH_ENV="LENS_BROKER_PORT=0" launch "$D" $((SECS + 8)) &
PID=$!
BAD=0; N=0; end=$((SECONDS + SECS)); : > "$D/sockets.txt"
while [ $SECONDS -lt $end ]; do
  sleep 1; N=$((N + 1))
  pids="$(pidtree "$PID")"
  lsof -nP -a -p "$pids" -i 2>/dev/null | awk 'NR>1{print $8, $9, $10}' >> "$D/sockets.txt"
  if [ $N -eq 10 ]; then
    lsof -nP -iTCP:8750 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2, $9}' > "$D/listen8750.txt"
    ps -o command= -p "$(awk '{print $1}' "$D/listen8750.txt" | head -1)" > "$D/cmd.txt" 2>/dev/null
    echo "$pids" > "$D/pids.txt"
  fi
done
wait "$PID" 2>/dev/null
grep -q '\[capture\] inactive: .*daemon' "$D/out.log" && pass "[real] addon loaded (capture inactive because source=daemon)" \
  || fail "[real] capture log: $(grep '\[capture\]' "$D/out.log")"
LPID="$(awk '{print $1}' "$D/listen8750.txt" 2>/dev/null | head -1)"
if [ -n "$HOLDER" ]; then
  echo "SKIP [real] Broker on 127.0.0.1:8750: port already held before launch ($HOLDER); packaged builds ignore LENS_BROKER_PORT"
elif [ -n "$LPID" ]; then
  if grep -q "$APP" <<<"$(cat "$D/cmd.txt" 2>/dev/null)"; then pass "[real] Broker listening on 127.0.0.1:8750 despite LENS_BROKER_PORT=0 (pid $LPID, this bundle)"
  else fail "[real] 127.0.0.1:8750 held by pid $LPID, not this bundle: $(cat "$D/cmd.txt")"; fi
else fail "[real] Broker not listening on 127.0.0.1:8750"; fi
NONLOOP="$(sort -u "$D/sockets.txt" | grep -vE '^(TCP|UDP) (127\.0\.0\.1|\[::1\]):[0-9]+( |->(127\.0\.0\.1|\[::1\]):[0-9]+)' )"
if [ -n "$NONLOOP" ]; then fail "[real] non-loopback sockets: $NONLOOP"; else
  pass "[real] ${N} s of lsof samples over the process tree: loopback only ($(sort -u "$D/sockets.txt" | tr '\n' ';'))"; fi

# 9. loopback traffic with the trimmed plist: Runtime client + ingest against a [mock]
#    Runtime (source = "ingest"), Broker auth on 8750. A blank focus-target window
#    (bundle dev.navalia.e2e.focus) is brought to the front once to trigger a frame.
D="$TMP/loopback"; mkdir -p "$D/store" "$D/ud"; seed_onboarding "$D/store"
node "$ROOT/tests/e2e/mock-runtime-cli.mjs" "$D/pr" "$D/runtime.json" > "$D/mock.log" 2>&1 &
MOCK=$!
for _ in $(seq 1 50); do grep -q MOCK_RUNTIME_READY "$D/mock.log" && break; sleep 0.1; done
FOCUS_APP="$(bash "$ROOT/tests/e2e/focus-target/build.sh" "$D/focus" 2>"$D/focus-build.txt")"
HOLDER9="$(lsof -nP -iTCP:8750 -sTCP:LISTEN -Fp 2>/dev/null | tr '\n' ' ')"
env -u ELECTRON_RUN_AS_NODE PERSOME_ROOT="$D/pr" LENS_STORE_ROOT="$D/store" \
  perl -e 'alarm shift; exec @ARGV' 30 "$BIN" --user-data-dir="$D/ud" > "$D/out.log" 2>&1 &
APPPID=$!
sleep 10
[ -n "$FOCUS_APP" ] && "$FOCUS_APP/Contents/MacOS/LensE2EFocus" 4 > /dev/null 2>&1
sleep 3
BROKER_CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' http://127.0.0.1:8750/mcp)"
wait "$APPPID" 2>/dev/null
kill -TERM "$MOCK" 2>/dev/null; wait "$MOCK" 2>/dev/null
grep -q '\[capture\] started' "$D/out.log" && pass "[real] capture started against the [mock] Runtime ($(grep '\[capture\]' "$D/out.log"))" \
  || fail "[real] capture did not start: $(grep '\[capture\]' "$D/out.log")"
GETS="$(node -e 'const r=require(process.argv[1]);console.log(Object.entries(r.byRoute).filter(([k])=>k.startsWith("GET ")).reduce((a,[,v])=>a+v,0))' "$D/runtime.json" 2>/dev/null)"
[ "${GETS:-0}" -gt 0 ] && pass "[real] Runtime client reached the [mock] Runtime over loopback ($GETS GET requests)" \
  || fail "[real] no Runtime client request reached the [mock] Runtime"
FOC="$(node -e 'const r=require(process.argv[1]);console.log(r.frames.filter(f=>f.bundle_id==="dev.navalia.e2e.focus").length)' "$D/runtime.json" 2>/dev/null)"
[ "${FOC:-0}" -gt 0 ] && pass "[real] ingest: $FOC frame(s) of the focus target posted to the [mock] Runtime" \
  || fail "[real] ingest: no focus-target frame reached the [mock] Runtime ($(cat "$D/runtime.json" 2>/dev/null | tr -d '\n' | cut -c1-200))"
if [ -n "$HOLDER9" ]; then echo "SKIP [real] Broker auth check: 8750 held before launch ($HOLDER9)"
elif [ "$BROKER_CODE" = "401" ]; then pass "[real] Broker answers an unauthenticated call with 401"
else fail "[real] Broker unauthenticated call returned '$BROKER_CODE'"; fi

# 10. self-exclusion (opt-in: PKG_SELFEX=1, it moves focus on the desktop for ~1 min).
#     This packaged Lens and a dev Lens (this checkout) side by side, each against its own
#     [mock] ingest Runtime; focus is switched between them and Finder. Switching uses the
#     focus-target helper (--activate <pid>, macOS cooperative activation) and Lens's own
#     second-instance handler, never `open`/AppleScript by bundle id (that could address
#     the user's installed Lens). macOS may refuse activation while the user is working,
#     so the frontmost pid is sampled: without proof that a Lens window was frontmost, the
#     "0 frames of Lens" results are reported UNKNOWN, not PASS.
if [ "${PKG_SELFEX:-0}" != "1" ]; then
  echo "SKIP [real] self-exclusion side-by-side check (set PKG_SELFEX=1; moves desktop focus)"
else
D="$TMP/selfex"; mkdir -p "$D/pkg/store" "$D/pkg/ud" "$D/dev/store" "$D/dev/ud"; seed_onboarding "$D/pkg/store"; seed_onboarding "$D/dev/store"
HOLDER10="$(lsof -nP -iTCP:8750 -sTCP:LISTEN -Fp 2>/dev/null | tr '\n' ' ')"
[ -n "$HOLDER10" ] && echo "INFO 8750 held before launch ($HOLDER10): the packaged Broker will not start; capture is unaffected"
node "$ROOT/tests/e2e/mock-runtime-cli.mjs" "$D/pkg/pr" "$D/pkg/runtime.json" > "$D/pkg/mock.log" 2>&1 & MOCKP=$!
node "$ROOT/tests/e2e/mock-runtime-cli.mjs" "$D/dev/pr" "$D/dev/runtime.json" > "$D/dev/mock.log" 2>&1 & MOCKD=$!
for _ in $(seq 1 50); do grep -q READY "$D/pkg/mock.log" && grep -q READY "$D/dev/mock.log" && break; sleep 0.1; done
FOCUS="$(bash "$ROOT/tests/e2e/focus-target/build.sh" "$D/focus" 2>/dev/null)/Contents/MacOS/LensE2EFocus"
EL="$(cd "$ROOT" && node -p 'require("electron")')"
devlaunch() { env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS PERSOME_ROOT="$D/dev/pr" LENS_STORE_ROOT="$D/dev/store" LENS_BROKER_PORT=0 \
  LENS_HET_CLAUDE_ROOT= LENS_HET_CODEX_ROOT= perl -e 'alarm shift; exec @ARGV' "$1" "$EL" "$ROOT" --user-data-dir="$D/dev/ud"; }
pkglaunch() { env -u ELECTRON_RUN_AS_NODE PERSOME_ROOT="$D/pkg/pr" LENS_STORE_ROOT="$D/pkg/store" \
  perl -e 'alarm shift; exec @ARGV' "$1" "$BIN" --user-data-dir="$D/pkg/ud"; }
frontpid() { lsappinfo info -only pid "$(lsappinfo front)" 2>/dev/null | sed 's/[^0-9]//g'; }
devlaunch 80 > "$D/dev/out.log" 2>&1 &
pkglaunch 80 > "$D/pkg/out.log" 2>&1 &
sleep 8
DEVPID="$(pgrep -f "$EL $ROOT --user-data-dir=$D/dev/ud" | head -1)"
PKGPID="$(pgrep -f "$BIN --user-data-dir=$D/pkg/ud" | head -1)"
( while :; do frontpid; sleep 0.3; done ) > "$D/front.txt" 2>/dev/null & SAMPLER=$!
for round in 1 2; do
  open -a Finder; sleep 3
  "$FOCUS" --activate "$DEVPID" >> "$D/activate.log" 2>&1; devlaunch 10 >> "$D/dev/second.log" 2>&1; sleep 3
  open -a Finder; sleep 3
  "$FOCUS" --activate "$PKGPID" >> "$D/activate.log" 2>&1; pkglaunch 10 >> "$D/pkg/second.log" 2>&1; sleep 3
done
open -a Finder; sleep 3
kill "$SAMPLER" 2>/dev/null
kill -TERM "$PKGPID" "$DEVPID" 2>/dev/null; sleep 3
kill -TERM "$MOCKP" "$MOCKD" 2>/dev/null; wait "$MOCKP" "$MOCKD" 2>/dev/null
DEVFRONT="$(grep -cx "$DEVPID" "$D/front.txt")"; PKGFRONT="$(grep -cx "$PKGPID" "$D/front.txt")"
echo "INFO frontmost samples: dev Lens $DEVFRONT, packaged Lens $PKGFRONT (of $(wc -l < "$D/front.txt")); activator: $(tr '\n' ' ' < "$D/activate.log" | grep -o 'ACTIVATE [0-9]* [a-z]*' | tr '\n' ' ')"
count() { node -e 'const r=require(process.argv[1]);const c={};for(const f of r.frames)c[f.bundle_id]=(c[f.bundle_id]||0)+1;console.log(JSON.stringify(c))' "$1" 2>/dev/null; }
PKGC="$(count "$D/pkg/runtime.json")"; DEVC="$(count "$D/dev/runtime.json")"
echo "INFO frames seen by packaged Lens: $PKGC; by dev Lens: $DEVC"
grep -q '\[capture\] started' "$D/pkg/out.log" && grep -q '\[capture\] started' "$D/dev/out.log" \
  && pass "[real] both instances captured against their own [mock] Runtime" \
  || fail "[real] capture not started (pkg: $(grep '\[capture\]' "$D/pkg/out.log"); dev: $(grep '\[capture\]' "$D/dev/out.log"))"
for who in pkg dev; do
  C="$(count "$D/$who/runtime.json")"
  grep -q '"com.apple.finder"' <<<"$C" && pass "[real] $who Lens posted Finder frame(s) (positive control)" \
    || fail "[real] $who Lens posted no Finder frame (positive control failed): $C"
done
verdict() { # verdict <frontmost samples of the target> <label> <frames json> <bundle>
  if grep -q "\"$4\"" <<<"$3"; then fail "[real] $2: frame(s) posted: $3"
  elif [ "$1" -gt 0 ]; then pass "[real] $2: 0 frames while it was frontmost ($1 samples)"
  else echo "UNKNOWN [real] $2: 0 frames, but the target was never frontmost (macOS refused activation); not evidence"; fi
}
verdict "$PKGFRONT" "dev Lens never posts packaged Lens (dev.navalia.app)" "$DEVC" "dev.navalia.app"
verdict "$PKGFRONT" "packaged Lens never posts itself (dev.navalia.app)" "$PKGC" "dev.navalia.app"
verdict "$DEVFRONT" "dev Lens never posts itself (own Electron.app path)" "$DEVC" "com.github.Electron"
if grep -q '"com.github.Electron"' <<<"$PKGC"; then
  echo "INFO packaged Lens posted com.github.Electron frame(s): a dev Lens is not matched from a packaged build (self-exclusion.ts design); may also be other dev Electron apps"
fi
fi
echo "artifacts: $TMP"
exit $FAIL
