# GAP vs S1-R6 (final S1 wrap-up round)

Date: 2026-11-06. The full BLOCKED table is in `BLOCKED-BURNDOWN.md`. Evidence root: `docs/test-evidence/PHASE5/`.

## 1. Summary table

| Area | before (R5) | after (R6) | Status | Evidence |
|---|---|---|---|---|
| Capture text | 11-06: 261 frames / 0 text, no diagnostics | Root cause found: the last `ax=True` in `capture.log` is at 2026-11-05T22:50Z; after that everything is `ax=False screenshot=False title=''`, and the app has `Signature=adhoc` → TCC stopped working after re-signing (OCR is configured on, but there is no image to recognize). Added: `textHealth.ts` (frames / text frames / coverage / verdict), a red banner on the Capture page + "Open System Settings", an enum of screenshot failure reasons (`screen_recording_denied` etc.), `scripts/verify-capture-text.sh` (read-only, prints counts only, exit 2 when there is no text) | Code DONE; **text not restored** (waiting for the user to re-authorize, B1) | `PHASE5/capture-text/` |
| OCR fallback path | Not audited | Audit: with Screen Recording granted, an empty AX result sends an image to OCR (covered by tests); no bug. Found that Lens (skips OCR when AX ≥64 characters) and the Runtime (only lines with indentation count as content) use inconsistent rules `[INFERRED]` | Recorded as B21 | Agent A audit; `tests/capture/text-health.test.ts` |
| Workflow | skills=0, vague reason "insufficient data" | Precise diagnosis: `pattern_detector` uses local dates, valid dates = 2 (11-04, 11-05); every candidate is blocked by the "≥3 dates" gate (5 app combos / 14 titles / 11 URLs, at most 2 dates each). For 11-06 to count, it needs an `llm` block before 23:59 PST | **BLOCKED (data)**, build not run (to avoid wasting budget) | `PHASE5/workflow-face/DIAGNOSIS.md` |
| `llm_failed` reason | Unknown | 157/157 (visible logs) = `agent funding daily call limit reached (200/200)`; the limit was 200 then, now 20000. No official retry → upstream proposal | Reason DONE; retry = upstream B19 | `docs/upstream/timeline-retry.md` |
| Face | 1 shadow candidate, 1 date | Structurally blocked: active needs provenance `both`, which needs a 2nd schema; currently only 1 non-event file has ≥4 facts, and `cross_domain_probe_state` has 0 rows. Dates alone will not produce a Face | **Insufficient data (structural)**, B3 | Same as above |
| X3 | Real transport PASS, UI not clicked | UI click steps written up as a form to fill in; ordering requirement: repackage only after the 3rd date is in (otherwise TCC breaks again) | PENDING (user) | `PHASE4/x3/UI-CHECK.md` |
| Runtime version (T5) | `/status.version`=0.3.2, unchanged across deploys (upstream FAIL) | Upstream local branch `og/r10-version-delete@7066066`: `/health` and `/status` add `schema_revision`, `build_version`, `build_sha`; deployed; Lens T5 marker = `schema:…|build:…` | DONE (local; merge pending upstream) | `PHASE5/runtime-r10/` |
| Runtime per-entry deletion | Proposal only | Three routes (transaction + bearer + `memory_deltas` audit + idempotent + 404); upstream 2654 passed; Lens meeting "Delete from Persome…" and connector deletion now use the new API, falling back on older Runtimes | DONE (local); derived memories do not cascade | Same as above |
| Cloud account entry point | Chat page only | Settings → "Cloud": address, status, fingerprint, sign in / sign out / delete (main-process native confirmation) / toggle; no new IPC. There are no per-feature cloud toggles (the code only ever had a global toggle; none were invented) | DONE | `PHASE5/cloud-settings/` |
| Real cloud verification | Chat / SMTP / Soniox / microphone not verified | Unchanged; each item written up as a command with environment variables | BLOCKED (user credentials) B4–B6 | `BLOCKED-BURNDOWN.md` |
| OS / CAP | Needs manual GUI/TCC | Unchanged; the checklist Results table stays empty | BLOCKED (user) B7–B8 | `CAP-L2L3-CHECKLIST.md` |
| Test temp directories | +169 directories per full run | Prefix-guarded helper; 4136 → 4136 before and after a full run; dev E2E still keeps 1 `persome-lens-e2e-*` artifact directory (kept on purpose, path printed) | DONE | `PHASE5/tmpdir/` |
| Signing / notarization | ad-hoc | Unchanged; added B18 (a local self-signed code signing identity, so TCC is not lost on every repackage) | BLOCKED (user) | `BLOCKED-BURNDOWN.md` |

## 2. Verification (2026-11-06 16:08 PST, this machine)

| Command | Result |
|---|---|
| `npm run typecheck` | 0 |
| `npx vitest run` | 201 files passed / 5 skipped; **2130 passed / 7 skipped / 0 failed** |
| `npm run build` | 0 |
| `npm run e2e` (dev, `out/`) | PASS 41 / SKIP 1 |
| `cd cloud && npm test` | 118 / 118 |
| Upstream `pytest` (agent C) | 2654 passed / 1 skipped / 0 failed |
| `e2e:packaged` | **Not run this round**: dist was not repackaged (repackaging re-signs and loses TCC, see B18); last round's PASS still applies to the current `.app` |

Baseline note: the brief's 2064/15 is out of date; the new tests this round come from 4 parallel agents, and the skip drop 15→7 was not attributed one by one.

## 3. Goals still not met this round

1. `visible_text` **restored**: `ax=True` since 2026-11-06 20:33:38 PST (re-authorized after `tccutil reset`); Screen Recording still not in effect.
2. 3 valid dates **obtained** (11-06: 77 `llm` blocks).
3. First real Workflow **still missing**: the date gate is passed (5 candidates), but all are title / URL repeats and were rejected by the LLM admission rule (9 automatic detections after recovery); Face has a separate structural block. No extra LLM budget was spent.
4. X3 UI **not tested by hand**.
