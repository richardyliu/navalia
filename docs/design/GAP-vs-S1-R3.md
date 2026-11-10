# Navalia — GAP vs S1, Round 3 (after DEPLOY-2026-11-05)

> Auditor draft, located at `docs/test-evidence/DEPLOY-2026-11-05/05-verify/GAP-vs-S1-R3.md`. The auditor can only write to `docs/test-evidence/**`, so it was not placed directly in `docs/design/`; the lead publishes it with `cp` (command at the end of this file).

Starting point: `docs/design/GAP-vs-S1-R2.md` (2026-11-05 Round 2). This round only changes the rows that concern the upstream Runtime: R1–R6 have been deployed to the real `~/.persome` (be0a0bc, tag `deploy/2026-11-05-r1r6`, schema `2026-11-05.3`). All other rows are the same as in R2 and are not repeated here; see R2.
Evidence: `docs/test-evidence/DEPLOY-2026-11-05/05-verify/` (`records.txt`, `evidence-sha256.txt`).

R2 contains no "FIX READY / NOT DEPLOYED" wording; the rows in R2 that depend on upstream are "Evidence chain BLOCKED upstream (MOD-07)" and "Habit ≥3 dates PARTIAL / BLOCKED (X6, X10)". The table below updates them one by one.

## 1. S1 goals that depend on upstream (R2 → R3)

| Goal | R2 status | R3 status | Reason | Evidence |
|---|---|---|---|---|
| Evidence chain (U1) | BLOCKED upstream (MOD-07) | **PARTIAL (deployed)** | Code: on the real Runtime, 296/296 candidate receipts resolve (including quote, session, window); in the §15 rerun MOD-01/02/07/08 all pass. Real data: all 49 Points and 46 Lines have `sources=[]`, because this data was built before the deploy (0.3.2, 08:49Z); the new link tables `model_candidate_points` / `relation_edge_evidence` have 0 rows and were not backfilled. Existing objects will only get sources after a post-deploy rebuild or an upstream backfill. Lens shows "Evidence unresolved / no_sources" for these Points, with a version-specific explanation. | `BF-real-runtime-summary.txt`, `BCF-lens-viewmodel-over-real.txt`, `I-rerun15/check_results.txt` |
| Habit ≥3 dates (U2) | PARTIAL / BLOCKED (X6, X10) | **DEPLOYED / PASS (temp root)** | The Runtime only promotes a Face to active with ≥3 distinct dates; with 2 dates it stays shadow; `behavior_patterns` returns `observation_dates`; Lens labels each Face "Stable habit · 3 distinct dates / Observing / Dates unknown". **Real data currently has 0 Faces**, so this could only be verified on a temp root. | `I-rerun15/faces3/`, `E-habit-labels.txt`, `E-real-behavior-patterns-counts.json` |
| "Why it is incomplete" (U1 degradation explanation, MOD-13) | Lens only shows `model_contract` + "CLI only" | **DEPLOYED / PASS** | The real `/model/graph` returns `issues=[no_faces,no_volumes,no_root]`; the running Model page shows the reason codes verbatim with a Chinese explanation. | `C-model-page-issues-dom.json` |
| "View as of then" as-of (evidence drawer, MOD-12) | Lens marks the gap with D48 | **DEPLOYED / PASS (R7)** | After the R7 (`03698b5`) deploy, at T=2026-11-01 all 49/49 Points return `not_yet_effective`; at T=11-06, 42 are active and 7 superseded. The gap for the 14 entry-backed Points on be0a0bc is fixed. | `07-r7-deploy/mod12-real-recheck.txt` |
| Owner alias confirmation (MOD-11) | Upstream auto-activates | **DEPLOYED / PASS** | Activation happens only after user confirmation, after which entity_graph resolves it to self; after rejection it does not resolve, and the Agent suggesting it again does not reopen it. Real data has 0 aliases (all/pending/active/rejected are all 0). | `G-owner-aliases-real-rest.txt`, `G-temp-reject/` |
| Agent paged memory reads (MEM-10) | Lens truncates at 50k, no cursor | **DEPLOYED / PASS** | Real Runtime via Broker: with `limit=2`, has_more=true; the cursor is 84 characters, byte-for-byte identical to the Runtime's original value, not scrubbed; page 2 has 0 overlap with page 1; a 59,735-character page is delivered in full. | `H-broker-paging-real.json` |
| Resident layer not mixed into search (MEM-05) / fact verification (MEM-09) / conflict supersede (MOD-09) / entity types (MOD-14) | FAIL (upstream) | **DEPLOYED / PASS (temp root)** | §15 rerun all passes. Known MOD-14 limitation: entity_graph does not resolve organization names. | `I-rerun15/check_results.txt` |
| Workflow task structure has content (U2) | PARTIAL (upstream only writes Pattern/Context/Evidence) | **PARTIAL (unchanged)** | R1–R6 do not touch pattern_detector's structured output. | — |
| Capture L2/L3 (U1) | BLOCKED (manual TCC) | **BLOCKED (unchanged)** | Unrelated to the deploy; still needs manual authorization. | — |

## 2. Phase 2 (S1-R3-01..09) — wrap-up on 2026-11-05

Lead final gate (`docs/test-evidence/PHASE2-FINAL/`): typecheck ✓; vitest 1457 passed / 5 skipped / 0 failed (including the second round of security fixes, see `s1-log/S1-R3-SEC.md`); build ✓; e2e 41 passed / 1 skipped (optional).

| ID | Title | Status |
|---|---|---|
| S1-R3-01 | Owner alias UI (R3 companion) | **DONE** (verified with mocks only; real data has 0 aliases) (`s1-log/S1-R3-01.md`) |
| S1-R3-02 | Broker tool catalog refresh | **DONE** (all 29 tools have a scope, description and audit; a model:search grant can read pending aliases; read_memory over 3 pages, cursor round-trips unchanged) (`s1-log/S1-R3-02.md`) |
| S1-R3-03 | Workflow automatic content | **PARTIAL**: the upstream branch `og/r8-workflow-structure` (4e83ce8) passes its tests on fixtures (4 steps, 3 artifacts, 1 rule, 1 question, all traceable to evidence), and Lens maps it. Not deployed yet, and no real LLM run yet; deploying needs user approval, and today's LLM daily limit is used up (`s1-log/S1-R3-03.md`) |
| S1-R3-04 | AI work count view (Option B) | **DONE** (counts only, not a performance score; commit signal = `git commit` matched in the Agent's shell commands) (`s1-log/S1-R3-04.md`) |
| S1-R3-05 | Shared moments depth | **DONE** (shared topics and shared experiences are both labeled "Unverified" and link back to evidence; semantic matching uses the top 3 Runtime search results, with no relevance threshold) (`s1-log/S1-R3-05.md`) |
| S1-R3-06 | Personal Database completeness (import/backup) | **DONE**, with one upstream limitation: re-importing the same source creates no duplicates, but the Runtime cannot overwrite the old version in place (old timeline blocks remain) (`s1-log/S1-R3-06.md`) |
| S1-R3-07 | Local connectors (.ics / health CSV/JSON) | **DONE** (accepted on a temp root with the real Runtime, network isolated); .eml not done (`s1-log/S1-R3-07.md`) |
| S1-R3-08 | Proactive layer / long-range project | **DONE (docs only)**: `PROACTIVE.md`; X9/X4 were not approved, so nothing was implemented (`s1-log/S1-R3-08.md`) |
| S1-R3-09 | Ask / WeChat loop | **DONE** (saving to memory requires a preview first, with a one-time token and main-side confirmation; Capture, Ask and Search all show OCR status and the WeChat warning) (`s1-log/S1-R3-09.md`) |

Suggested additions to the Phase 2 definition (based on this round's findings):
- ~~Upstream: `_resolve_entry` should support as-of status~~ → fixed and deployed in R7.
- How to fill in sources for existing data: rebuild after the deploy, or have upstream provide a backfill (`model_candidate_points` / `relation_edge_evidence`).

## 3. This round's gate

| Item | Result |
|---|---|
| `npm run typecheck` | rc=0 |
| `npx vitest run` | 119 files passed / 4 skipped; 1242 tests passed / 5 skipped / 0 failed |
| dev Lens against the real Runtime | Starts with no errors; Broker on 127.0.0.1:8750; everything exits within 1 second of SIGTERM |
| §15 upstream rerun | 63/63 PASS (the "67/67" written in 01-upstream is an addition error; summing item by item gives 63) |

Publish: `cp docs/test-evidence/DEPLOY-2026-11-05/05-verify/GAP-vs-S1-R3.md docs/design/GAP-vs-S1-R3.md`
