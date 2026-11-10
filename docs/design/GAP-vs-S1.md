# Navalia — GAP vs S1 (article goals)

> Round 2: see [GAP-vs-S1-R2.md](GAP-vs-S1-R2.md). This file is the Round 1 record; S1-06 / S1-08 / S1-11 were changed from DONE to PARTIAL by the Round 2 Phase 0 audit (GAP-vs-S1-R2 §1).

Status convention: DONE only means the mechanism is implemented and backed by tests or real-run evidence. A page that renders, or looks like the article's screenshots, does not count as DONE.

Oracle: the S1 article (mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA, mirror news.qq.com/rain/a/20261104A0E5ZC00).
**Not** the original DMG / S2 interview.
The `0.91` in `docs/test-evidence/REPORT.md` is a weighted score against the DMG and cannot be used to prove S1 is complete.
On conflict, S1 wins; trade-offs are written in this file and in `DEVIATIONS.md`.

S1 in one sentence: turn the work happening on your computer into a Personal Database you own; before acting, any Agent reads "your" context, working methods and judgment through MCP.

## 0. Baseline (2026-11-05, Phase 0)

| Item | Result |
|---|---|
| git | Not a git repository (not initialized) |
| `npm run typecheck` | 0 errors |
| `npm test` | 485 passed / 4 skipped (49 files, 3 skipped) |
| `npm run e2e` (`E2E_NO_FOCUS=1`, temporary root) | 22 PASS / 4 SKIP (4 capture focus steps that need the window brought to the front, skipped as required) |

## 1. S1 goals item by item (before → after)

Status: DONE / PARTIAL / BLOCKED / TODO. The After column is filled in once each task is finished.

### U1 Personal Database
| Goal | Before | After | Status |
|---|---|---|---|
| Capture (AX+OCR) | native capture + ingest; L2/L3 BLOCKED (CAP-01/08/09) | Capture logic unchanged; L2/L3 still need real TCC authorization and heartbeat/URL evidence | BLOCKED (permissions/manual) |
| Capture status visible | Has permissions/exclusion/pause, missing source/OCR/recent frames | Diagnostics card: source (read-only config.toml), OCR switch/policy/tier (config + loopback `/health`), AX/screen recording, recent frames, exclusions, pause; copyable diagnostics (tokens scrubbed) | DONE (S1-04) |
| Import history (Claude Code / Codex) | None | "Import" page: scan (async, per file, 4000 files/1 GiB cap) → preview → redacted staging + dry-run → `persome import-data --no-build`; real import into a temporary root exits 0 with 1 document stored; the build step needs the Runtime LLM | PARTIAL (S1-07; build BLOCKED by LLM configuration) |
| Natural-language questions | Search page | Unchanged (not in this round's queue) | TODO |
| Daily auto-list / brief | None | "Today" page: deterministic template (no LLM), quotes the original words, checkboxes, every inferred line marked "unverified", copy/export .md | DONE (S1-09) |
| WeChat group digest | None | Not done (not in this round's queue; needs a WeChat data source) | TODO |
| Give Agents full sources (evidence chain) | MOD-07: candidate receipt missing, sources=[] | Drawer separates direct sources / unresolved; shows only Runtime's reason; global drop count (delta-report, labeled "not specific to this item"); repro command without token; upstream patch draft | PARTIAL (S1-01; root cause is upstream) |
| Point-in-time evidence (asOf) | In the API, not in the UI | Drawer "As of" picker, ISO validation (main + renderer) | DONE (S1-03) |
| Welcome page "X projects, Y people" / Library | Only points/surfaces | "Library": three columns for people/projects/skills, "Organized X projects and Y people", classified only by Runtime fields, can open evidence/relations | PARTIAL (S1-08): counts and classification work (`tests/library/aggregate`); but there is no "Profile" (Root / Faces), the skills column comes only from `behavior_patterns` and does not read the Lens Workflow store, so imported / shared `.lensskill` files are not shown (`src/main/library/aggregate.ts`). Round 2: S2-04 |

### U2 Workflow / Skills
| Goal | Before | After | Status |
|---|---|---|---|
| Task structure | Playbook is read-only text | zod `Workflow` (goal/inputs/tools/steps/artifacts/rules/problems/evidence/provenance/version/source), mapped from Runtime skills, unmappable fields left empty | PARTIAL (S1-06): the schema is implemented, but the content is mostly empty. Runtime skill entries only contain Pattern / Context / Evidence (the entry format in `personal-model/src/persome/prompts/pattern_detector.md:45-52`), so a real Workflow usually has only goal / context / evidence; steps exist only when `Steps:` is written explicitly (`src/main/workflows/parse.ts:294-295`; DEVIATIONS D25). Round 2: S2-07 (external Agent extraction → paste JSON) |
| Reuse / import / export | None | Local versioned store (keeps the observed original), manual editing, JSON import/export (validation, dedup, new id to prevent takeover) | DONE (S1-06, mechanism; `tests/workflows/*`). Exported content is limited by the row above |
| Agents read via MCP | None | Broker `search_workflows` / `get_workflow` (Lens extension, read-only, scope `model:search`, redacted, audited) | PARTIAL (S1-06): the tools work (`tests/workflows/broker.test.ts`), but the Workflows Agents read mostly have only goal / context / evidence; the "working method" itself is largely missing |
| Habits on ≥3 distinct dates | Not distinguished | <3 dates labeled "Observing"; Faces without dates labeled "Dates unknown"; the date is the write time | PARTIAL (S1-05) |
| Authorized sharing / three-way source | None | `.lensskill` (Ed25519 signature, offline verification, tamper rejection, dedup); badges Observed / Imported / Shared by others; "N skill files. M weeks of judgment." | DONE (S1-10) |

### U3 Shared moments
| Goal | Before | After | Status |
|---|---|---|---|
| Peer cards (Peers) | Only your own card | "Peers" page: import `.persomecard`, offline verification, tamper rejection, version history; Activity shows only local events; Suggestion is literal overlap, labeled "unverified" | PARTIAL (S1-11): manual import and verification work (`tests/peers/*`); subscriptions are not supported (`src/main/peers/api.ts` `SUBSCRIPTION_STATUS.state = 'unsupported'`, DECISIONS X1/X2), so a peer's update requires sending the card file again; Suggestion only does literal overlap, not semantic judgment. Round 2: S2-09 (local subscription folder) |
| Weekly letter draft | None | Deterministic template (last 7 days, original-word quotes, user-written paragraphs), copy/export, not sent | DONE (draft template only; `tests/peers/*`). The parent task S1-11 is PARTIAL overall |
| Subscriptions | None | `unsupported` (DECISIONS X1/X2) | BLOCKED (needs user decision) |

### Measurable (HET)
| Goal | Before | After | Status |
|---|---|---|---|
| HET minutes | transport disabled, page looked like it was working | Defaults to "Assessor off… 0 minutes" + "Unmeasured"; triple gate of `assessorEnabled` + transport injection point + budget; weekly report export states it is "not a measurement" | DONE (S1-02); real minutes BLOCKED (DECISIONS X3) |
| REST `/het/*` | IPC only | Still IPC only, recorded in DEVIATIONS D17 | Not done (trade-off) |

## 2. How it was executed

- Lead (main thread) owns the shared wiring: `src/main/index.ts`, `src/shared/api.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/main/s1/deps.ts`, and this file.
- So subagents could run in parallel with non-overlapping write sets, Phase 0 pre-built the scaffolding: `src/main/{workflows,import,library}/{api,ipc}.ts`, `src/preload/{workflows,import,library}.ts`, `pages/{Today,Library,Import}.tsx`, already wired into index.ts / preload / App.tsx.
- Each task's plan and results were first written to `docs/design/s1-log/S1-xx.md`, then summarized by the lead into the task log below.

## 3. Task log

The plan / changes / tests / leftovers / risks for each task are in `docs/design/s1-log/S1-xx.md` (11 files). Summary:

| Task | Agent | Status | Key changes | New tests |
|---|---|---|---|---|
| S1-01 | evidence + lead | PARTIAL | `components/evidence/model.ts`, `EvidenceDrawer.tsx`, `runtime/deltaReport.ts`, `ipc.ts` `lens:model:delta-report`, `docs/upstream/MOD-07.md` | `tests/evidence/model.test.ts`, `deltaReport.test.ts` |
| S1-02 | het + lead | DONE | `het/service.ts` `assessorGate`, `settings.ts` `assessorEnabled`, `tick.ts`, `ledger.ts` `markGated`, `weekly.ts` `assessorNote`, `pages/Het.tsx` | `tests/het/assessorGate.test.ts`, `weeklyAssessorNote.test.ts` |
| S1-03 | evidence | DONE | `components/evidence/asOf.ts`, `runtime/client.ts` `isValidEvidenceAsOf` | `tests/evidence/asOf.test.ts` |
| S1-04 | capture | DONE | `capture/diagnostics.ts`, `capture/ipc.ts` `lens:capture:diagnostics`, `pages/Capture.tsx` | `tests/capture/diagnostics.test.ts` |
| S1-05 | workflows | PARTIAL | `components/workflows/habit.ts` | `tests/workflows/habit.test.ts` |
| S1-06 | workflows | PARTIAL (schema / store / Broker tools work; Runtime only provides Pattern/Context/Evidence, so Workflow content is mostly empty) | `workflows/{schema,parse,runtime,store,service,search,ipc}.ts`, `broker/{catalog,tools,main}.ts`, `WorkflowPanel.tsx` | `tests/workflows/*` |
| S1-07 | import | PARTIAL | `import/{transcripts,redact,markdown,cli,service,ipc}.ts`, `pages/Import.tsx` | `tests/import/*` (including security) |
| S1-08 | library | PARTIAL (no profile; does not read the Workflow store, imported / shared skills are not shown) | `library/aggregate.ts`, `pages/Library.tsx` | `tests/library/aggregate,ipc` |
| S1-09 | library | DONE | `library/brief.ts`, `pages/Today.tsx` | `tests/library/brief` |
| S1-10 | skillshare | DONE | `skillshare/{package,service}.ts`, workflows import/export entry points | `tests/skillshare/*` |
| S1-11 | peers | PARTIAL (card import / weekly letter draft work; subscriptions unsupported) | `peers/{store,topics,letter,service,ipc}.ts`, `pages/Peers.tsx` | `tests/peers/*` (including no-network) |
| Security review | security-reviewer | 10 items: #1 #2 #3 #4 #5 #6 #7b #9 #10 fixed; #7a #8 recorded, not changed | — | `tests/import/security`, `tests/skillshare/security-fixes`, `deltaReport` |

## 4. Conclusion / next steps

### Numbers at the end
| Item | Baseline | End |
|---|---|---|
| typecheck | 0 errors | 0 errors |
| `npm test` | 485 passed / 4 skipped (49 files) | 772 passed / 5 skipped (79 files); the new skip = `tests/import/real-runtime.test.ts` (needs `LENS_IMPORT_REAL_PERSOME=1` to opt in explicitly) |
| E2E (`E2E_NO_FOCUS=1`) | 22 PASS / 4 SKIP | 22 PASS / 4 SKIP (no regression; E2E does not cover the new S1 pages) |
| New-page render smoke test | — | dev build + mock Runtime + temporary root: Today / Library / Import / Peers / Playbook / Capture / HET / evidence drawer all render; HET shows "Assessor off…" and "Unmeasured". This only proves the pages render, not that the mechanisms work; mechanism status is defined by §1 and the tests |

### Next steps
1. Upstream: submit `docs/upstream/MOD-07.md` and `IMPORT-SOURCE-KEY.md` (needs user consent to publish externally).
2. Add E2E steps for the new S1 pages (import fixture → Library counts, Broker `get_workflow`, `.lensskill` round trip).
3. Ask / natural-language questions, WeChat group digest (not scheduled this round).
4. After the user decides DECISIONS X1–X6: real HET transport, subscription carrier, automatic build after import.
5. Runtime skill entries currently have only Pattern/Context/Evidence: Workflow steps/rules are mostly empty; this needs the upstream pattern_detector to output structured fields, or the user to fill them in manually.
