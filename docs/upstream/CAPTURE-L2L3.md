# CAPTURE-L2L3 — manual acceptance checklist for CAP-01 / CAP-08 / CAP-09

Status: **BLOCKED in automation.** All three need macOS TCC grants (Accessibility, Screen Recording) that only a human can give in System Settings, and CAP-01 also needs a human to read the TCC list. The last audit recorded all three as BLOCKED (`docs/test-evidence/REPORT.md:20,23,24`). Its "CAP 1.00" family score explicitly says nothing about capture fidelity (`REPORT.md:66`).
This file sits in `docs/upstream/` because the lead put it there. It is a Lens-side acceptance checklist, not a Runtime issue.

Test definitions: CAP-01, CAP-08, CAP-09 and T-CAP-01.

## Safety rules (apply to every step)

- **Use a temp Runtime root under `/tmp/persome-test/`.** Do not point anything at `~/.persome`. The audit scripts refuse other roots (`docs/test-evidence/_scripts/count-buffer.py:7`, `lens-harness.mjs:19,26`).
- The real install currently runs `[capture] source = "daemon"` with its own `mac-ax-watcher` (`REPORT.md:75`). Switching the real root to ingest is the user's decision. It is **not** part of this checklist.
- Never paste tokens into evidence. `~/.persome/env` and the temp root's `env` stay out of `docs/test-evidence/`. The Capture page's 「复制诊断」 output already removes tokens (README Capabilities, "Capture diagnostics").

## Common setup (all three tests)

1. Temp Runtime root `T=/tmp/persome-test/cap-$(date +%Y%m%d)` with `config.toml` containing at least:
   ```toml
   [capture]
   source = "ingest"

   [mcp]
   port = 8761
   ```
   Lens reads the port from `[mcp] port` (`src/main/runtime/paths.ts:21-41`; default 8742). `8761` avoids the real daemon on 8742.
2. Start the Runtime in capture-only mode, as in the last audit (`REPORT.md:83`):
   `PERSOME_ROOT="$T" ~/.persome/venv/bin/persome start --foreground --capture-only`
   Expected first `capture.log` line: `capture source=ingest — OS capture disabled (no watcher / no screenshot grab); serving POST /captures/ingest` (`docs/test-evidence/CAP-01/process-and-config.txt`; Runtime `capture/scheduler.py:1380`).
3. **Which Lens build.** TCC grants attach to the app bundle that asks:
   - **Dev build** (`electron .` / `lens-harness.mjs`): the TCC row will be **"Electron"** (`node_modules/electron/dist/Electron.app`), not "Persome Lens". It is fine for CAP-08/09. For CAP-01 part 2 it proves nothing about the shipped app.
   - **Packaged build** (`dist/mac-arm64/Persome Lens.app`, bundle id `dev.persomelens.app`, README Limitations): required for CAP-01 part 2. It is ad-hoc signed, so grants may need re-granting after every rebuild (README "TCC grants and rebuilds").
   - Launch it through LaunchServices (Finder or `open`), not by running `Contents/MacOS/…` from Terminal. A Terminal launch can make Terminal the responsible process for TCC. That is [my understanding of macOS behaviour, not verified in this repo]. To pass `PERSOME_ROOT` through `open`, use `open -n --env PERSOME_ROOT="$T" "dist/mac-arm64/Persome Lens.app"` (`open --env` needs a recent macOS; not verified on this machine). Lens honours `PERSOME_ROOT` (`src/main/runtime/paths.ts:14-18`).
4. **Grants (human).** Open Lens → 采集 page → request Accessibility, then Screen Recording (IPC `lens:capture:request-accessibility` / `lens:capture:request-screen-recording` / `lens:capture:open-privacy`, `src/main/capture/api.ts:16-18`). In System Settings → Privacy & Security, enable Lens in **Accessibility** and in **Screen Recording**. Quit and relaunch Lens when macOS asks.
5. Confirm on the 采集 page diagnostics card: source `ingest`, Accessibility ✓, Screen Recording ✓, and the 「最近帧」 count rising after an app switch (S1-04; `src/main/capture/diagnostics.ts`). Save 「复制诊断」 output as `diagnostics.txt`.

## CAP-01 — the shell owns TCC; the Runtime does not (L2)

Definition: only Lens appears in TCC; the Runtime has no AX watcher; `source=ingest`. **Pass = parts 1 + 2 + 3 together. Part 3 alone does not count**.

| Part | Command / step | Expected |
|---|---|---|
| 1 Processes | `ps -axo pid,ppid,command \| grep -Ei 'persome\|electron\|mac-ax' \| grep -v grep` and, for every `mac-ax-*` pid, its parent (`ps -o pid,command -p <ppid>`) | Lens main + Electron helpers; the temp Runtime is `python … persome start --foreground --capture-only` with **no** `mac-ax-watcher` / `mac-ax-helper` child. A `mac-ax-watcher` whose parent is the *real* daemon (`~/.persome`, `source=daemon`) is not attached to Lens and must be recorded as such (as in the audit: pid 96891 → 96886) |
| 2 TCC (human) | System Settings → Privacy & Security → **Accessibility**, then **Screen Recording** | The only Persome-related enabled row is **"Persome Lens"**. No `mac-ax-helper`, `mac-ax-watcher`, "Persome Helper", `python`, or Terminal enabled *for this purpose*. List any other enabled rows; they need not be removed, but a Persome-related one fails the test |
| 3 Config + runtime state | `grep -A2 '^\[capture\]' "$T/config.toml"`; `cat "$T/.runtime-state.json"`; first line of `capture.log` (location under `$T/logs/` assumed, not verified) | `source = "ingest"`; `"capture_mode": "ingest"`; `permissions` = `not_applicable` (as in `CAP-01/process-and-config.txt`); log line "OS capture disabled (no watcher / no screenshot grab)" |
| (Lens side) | Lens capture status via the 采集 page | `runtime.source = "ingest"`, `started: true`, **not** `degraded` once both grants are given (the audit run was degraded: "Accessibility is not granted to Persome Lens") |

Evidence to save in `docs/test-evidence/CAP-01/`:
- `process-and-config-<date>.txt` (part 1 + 3 output, same shape as the existing file)
- `tcc-accessibility.png`, `tcc-screen-recording.png` (full pane, both scrolled to show every enabled row)
- `diagnostics.txt` (copied, token-free)
- the §15.3 record with `target:` = packaged build hash / Lens version + Runtime version

Why it is BLOCKED in automation: an agent cannot read or change the TCC list without Full Disk Access (and Lens deliberately never asks for FDA, CAP-10). Granting requires a human click in System Settings. The dev build would also show "Electron", not "Persome Lens".

## CAP-08 — dedup / heartbeat (L2)

Definition: type continuously for 1 minute → **not one frame per key**; a **heartbeat** exists.

What the code should do (`src/main/capture/coordinator.ts:1-30`, `ACTIVE_TUNING = TUNING_SPEC` at `:99`, values at `:70-78`): value-change/text-input triggers debounce 3 s; min gap 2 s; same-surface dedup 5 s (deferred, not dropped); a pending trigger flushes at most 30 s after the burst starts; heartbeat after **10 min** without a capture; lock/pause cancels the heartbeat.

Steps:
1. Common setup, with Accessibility granted (without AX there are no `AXValueChanged` events; that is why the audit could not run it, `REPORT.md:76`).
2. Note `T0=$(date -u +%Y-%m-%dT%H:%M:%S)`. Focus a TextEdit document. Type continuously for 60 s (≈ 200–300 keystrokes). Do not switch apps.
3. Count: `python3 -I docs/test-evidence/_scripts/count-buffer.py "$T" "$T0"`. It prints `frames`, `by_bundle` and `by_trigger` from `$T/capture-buffer/*.json`.
4. **Heartbeat:** keep the machine unlocked with the screensaver and display sleep off. Touch nothing for ≥ 11 min. (Moving the mouse is fine only if no click or app switch happens. To be safe, don't touch it.) Re-run step 3 with a new `T0`.

Expected:
- Step 3: TextEdit frames for the typing minute are **far below the keystroke count**. From the tuning, one surface can be captured at most once per 5 s, so roughly ≤ 13 frames for 60 s (computed from `sameWindowDedupMs = 5000` plus an activation frame; an upper bound, not a target). The Runtime may dedupe more (`deduped` in `ingest_capture`, Runtime `capture/scheduler.py:548-564`).
- Step 4: at least one frame with `trigger.event_type = "heartbeat"` (`coordinator.ts:41`), about 10 min after the last capture.

Evidence to save in `docs/test-evidence/CAP-08/`: `typing-60s.json` (count-buffer output), `heartbeat-idle.json`, the keystroke estimate and how it was obtained, `diagnostics.txt`, and the §15.3 record. Keep the existing `heartbeat-watch.log` as the inconclusive earlier run.

Why it is BLOCKED in automation: AX value-change events need the Accessibility grant (human). The heartbeat needs ≥10 min with **no** user activity, and the earlier 14-min watch never got a 10-min silence (`CAP-08/heartbeat-watch.log`: 45 activation frames). Coordinator unit tests (`tests/capture/coordinator.test.ts`, fake clock) cover the logic only, not real event delivery.

## CAP-09 — source metadata (L3)

Definition: the capture JSON has **app / window / URL / timestamp**.

What Lens sends (`src/main/capture/frame.ts:8-15`): `timestamp`, `trigger`, `window_meta{app_name,title,bundle_id}`, optional `ax_tree` / `ax_metadata` / `screenshot`. **Lens does not send a URL.** It reads `AXURL` into Lens-local metadata only (`frame.ts:38-39,110-115`; DEVIATIONS D13), because the OSS ingest body has no url field (Runtime `api/models.py:56`). The Runtime derives `url` from the AX tree (`capture/s1_parser.py:156` → `_extract_url` `:412` → `browser_detect.address_bar_url` `:424`). I have **not** verified end to end that the ingest path (`capture/scheduler.py:548` `ingest_capture` → `:492` `build_ingest_capture`) runs that parser; `build_ingest_capture` does not call it directly [INFERRED, MED]. This test is where that gets confirmed.

Steps:
1. Common setup with **both** grants.
2. `T0=…`; activate in turn: Safari on `https://example.com` (already loaded; Lens must not cause network access, and the page should be open before the test), Chrome on the same page if installed, TextEdit with a named document, Finder.
3. `ls -t "$T/capture-buffer" | head`; for each new frame: `python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sorted(d)); print(json.dumps({"timestamp": d.get("timestamp"), "window_meta": d.get("window_meta"), "url": d.get("url"), "capture_source": d.get("capture_source"), "ax_unavailable": d.get("ax_unavailable")}, ensure_ascii=False))' <file>`. `timestamp` and `window_meta.{app_name,bundle_id,title}` are the keys the audit read from buffer frames (`count-buffer.py:15-19`, `REPORT.md:96`). The location of `url` / `capture_source` / `ax_unavailable` in the buffer JSON is **assumed** (top level). Read `sorted(d)` first and adjust.

Expected: every frame has a timestamp, an app (name + bundle), a non-empty window title, `capture_source` = `ingest`, and for the browser frames a `url` equal to the page URL. `ax_unavailable` must be absent/false (the audit frames had `ax_unavailable=true`, title `""`, no url).

Evidence to save in `docs/test-evidence/CAP-09/` (new directory): one buffer JSON per app (screenshots stripped or the file hashed, not committed, if it contains screen content), `keys.txt`, and the §15.3 record. Record the result per app, e.g. Safari PASS / Chrome FAIL if only one browser yields a URL.

Why it is BLOCKED in automation: window titles and URLs come from the AX tree, which needs the Accessibility grant (human). Screenshots need Screen Recording. Without them the frame carries only app, bundle and timestamp (`REPORT.md:77`).

## After the run

- Update `docs/test-evidence/REPORT.md` (lead / fidelity auditor; not this doc's owner) with the new records and hashes (`_logs/evidence-sha256.txt`).
- If CAP-09 shows no URL even with AX, that is a Runtime ingest-path question. Write it up as a separate upstream note; Lens should not start sending a URL field the OSS body doesn't define.
