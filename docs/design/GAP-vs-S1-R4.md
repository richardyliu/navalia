# Navalia — GAP vs S1, Round 4 (S1 wrap-up, 2026-11-05)

Previous round: `GAP-vs-S1-R3.md`. Approved scope: `DECISIONS-ROUND3.md`.
Oracle: the S1 article (https://mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA). The original was not reread this round; the split into three use cases follows R2/R3: U1 evidence chain / personal database, U2 habits and Workflow, U3 Agent reads / Performance. [INFERRED]
Evidence directory: `docs/test-evidence/PHASE3/`.

## 0. Baseline (Phase 0)

| Item | Value |
|---|---|
| Lens typecheck / vitest / build | rc=0 / 139 files passed, 4 skipped, **1457 passed / 5 skipped / 0 failed** / rc=0 (`PHASE3/00-baseline/`). No `/bin/ps` or `sandbox-exec` environment failures this round |
| Runtime | R1–R7 @ `03698b5`, schema `2026-11-05.3`, `/health` ok |
| Real data | Points 49, Lines 46 (`model status`), relation_edges 187, `model_candidate_points` 0, `relation_edge_evidence` 0, Faces 0, skills 0 |
| LLM budget | `[agent_funding]` 200/200 used for the day, counted by local date (`agent_cli.py:318`); resets 2026-11-06 00:00 PST |
| Backups | `20261105-173654-pre-r8` (before R8), `20261105-180023-pre-r9` (before R9), both byte copies taken with the service stopped, `quick_check=ok`, manifest all OK |

## 1. S1 goals × before / after

| Goal | R3 status | R4 status | Evidence / acceptance |
|---|---|---|---|
| **U1 evidence chain: old data has sources** | PARTIAL: 49/49 Points `sources=[]` | **DONE (with gaps)**: the upstream R9 deterministic backfill is deployed and applied to real data. **45/49 Points and 107/187 Lines** have direct sources (quote + session + window); as_of results at three points in time match R7; the Lens view model shows no "Evidence unresolved" markers on the real response. Gaps: 4 `remember` memories have no candidates, and 42 occurrence Lines and 3 closed Lines have no window evidence. Note: the task originally said to rebuild with `model build`, but that does not fill in existing objects (confirmed by both the code and a test on a copy), so R9 was used instead | `r9-deploy/05..08`, `r9-lineage/` |
| U1 "View as of then" as-of (MOD-12) | PASS | **PASS (unchanged)** | `r9-deploy/07-real-evidence-asof.txt` |
| U1 §15 upstream | 63/63 | **63/63** (@`462361d`); the MEM-09 problem was the test script sharing a root with MEM-10; it was run separately as originally done, see REPORT | `r9-deploy/09-rerun15/` |
| **U2 Workflow has structure** | PARTIAL (R8 passed only on fixtures, not deployed) | **PARTIAL**: R8 deployed (`4e83ce8`, pytest 2595/0); real `behavior_patterns.skills = 0`, **real run BLOCKED (LLM budget)**. The timeline covers 3 local dates (09-21, 11-04, 11-05), so a first Workflow may come out once the quota resets. No structure was fabricated | `r8-deploy/`, `UPSTREAM-DEPLOY-R8.md` §4 |
| U2 habit ≥3 dates | Temp root PASS; real Faces 0 | Unchanged (real data still has no Face) | — |
| **U3 Performance (X4 = B)** | Count card exists | **DONE**: "AI work counts this week" states "These are counts, not a rating of your work, and do not represent time saved"; every number links back to the HET filtered list; there are empty and error states; tests prove it goes through neither the Broker's MCP nor REST, and does not enter the Card or the weekly letter. Note: the existing OG-08 HET REST (`/het/tasks`) lets an Agent with HET access count these numbers itself; whether to tighten that is the user's call | `PHASE3/X4-X9/`, `s1-log/S1-R4-04-05.md` |
| **Proactive layer (X9)** | Docs only | **DONE (T5 partial)**: T3/T4/T5/T1/T2 all off by default; at most 3 per day, with cooldown, dedupe, quiet hours 22–09; copy contains numbers only; static and runtime no-network tests. **T5 "upgraded" cannot fire on the real Runtime**: `/health` has no `schema_revision`, and `/status` still reports `0.3.2`. Notification permission can only be inferred indirectly. Not run in the real Notification Center | `PHASE3/X4-X9/summary.md`, D69 |
| X2 subscription background scan | Manual only | **DONE**: off by default, 5–1440 minutes, scans one level only, no network, stops on quit | `connectors-backup/`, `s1-log/S1-R4-06-07-10.md` |
| X5 build after import | Toggle exists | **DONE**: confirmed off by default, needs a second confirmation, spends LLM budget, shows exit code and stderr on failure; tests added | Same as above |
| X8 backup includes Access log | Not included | **DONE (deviation)**: off by default; manifest v3 has `includes_access_log`; exports JSON rather than copying the `audit.db` file (D68); never includes private keys or grants | Same as above |
| S1-R4-07 `.eml` / mbox | None | **DONE**: local parser, one memory per message, dedupe by Message-ID, attachments recorded by filename only | Same as above, D70 |
| S1-R4-08 OCR actionable | Status only | **DONE**: step-by-step commands can be copied; explains that WeChat content depends on OCR; Lens does not write `config.toml` | `ocr-shared-readme/` |
| S1-R4-09 Shared moments threshold | Top 3, no threshold | **DONE**: the Runtime returns no relevance score, so a literal overlap is required instead (`score ≥ 0.5` once scores exist); the weekly letter only cites checked items | Same as above, D67 |
| S1-R4-10 Import/backup completeness | Has an upstream limitation | **DONE (upstream limitation unchanged)**: dedupe by stable key; backup/restore of cards and Workflow history is tested; copy states that the snapshot is not the raw DB | `connectors-backup/` |
| S1-R4-11 README / hermetic | — | **DONE**: removed outdated claims from the README; added `host-probe`, which skips in a restricted sandbox and states why | `ocr-shared-readme/` |
| CAP L2/L3 | BLOCKED (manual TCC) | **BLOCKED (unchanged)**: no manual TCC acceptance this round | `docs/upstream/CAPTURE-L2L3.md` |
| HET minutes | Not measured | **Not measured** (X3 not approved) | — |
| Signing / notarization / auto-update | BLOCKED | **BLOCKED** (no Developer ID, OG-D3/D4) | — |
| Chat / Meetings / cloud sync | BLOCKED | **BLOCKED** (X1 not approved) | — |

## 2. Gate (final)

| Item | Result |
|---|---|
| Lens typecheck / vitest / build | rc=0 / **152 files passed, 4 skipped; 1578 passed / 5 skipped / 0 failed** / rc=0 (`PHASE3/FINAL/`) |
| Lens e2e (temp dir + mock Runtime) | **37 PASS / 5 SKIP** (4 because `E2E_NO_FOCUS=1` avoids stealing focus; 1 optional) |
| Upstream pytest @ `462361d` | **2622 passed / 0 failed / 1 skipped** |
| §15 upstream rerun | **63/63** |

## 3. Items needing the user / upstream / a certificate

1. **LLM quota (after 2026-11-06)**: run pattern_detector once per `UPSTREAM-DEPLOY-R8.md` §4 to confirm the first real structured Workflow. This step spends Runtime quota.
2. **OG-08 HET REST exposes correction/signals**: whether to tighten it for Agents (the "who can see it" part of X4).
3. **T5 upgrade detection**: needs upstream to provide a schema revision or a real version number in `/health` or `/status` (right now `/status` reports `0.3.2`, which is wrong).
4. CAP L2/L3: manual TCC acceptance on the packaged app.
5. Developer ID (signing / notarization); X1 / X3 / X7 remain unapproved.
6. This shutdown sent SIGTERM to `persome mcp` in other Claude Code sessions: those sessions need a restart before they connect to the R9 code.
7. Lens was already not running before this round's shutdown, so screen capture has had no new data since 14:50 (Lens is the ingest producer). To keep accumulating data for a 4th date, the user needs to reopen Lens.
