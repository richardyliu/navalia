# Navalia — GAP vs S1, Round 2

Oracle: the S1 article (mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA; mirror news.qq.com/rain/a/20261104A0E5ZC00).
The S2 interview / original DMG is a separate oracle (the 0.91 in `docs/test-evidence/REPORT.md` applies only to the DMG). On conflict, S1 wins; trade-offs go in `DEVIATIONS.md`.
Round 1 results: `GAP-vs-S1.md`. Default decisions: `DECISIONS-ROUND2.md`. Per-task details: `s2-log/S2-xx.md`.

## 0. Baseline (2026-11-05, Round 2 Phase 0)

| Item | Result |
|---|---|
| git | Not a git repository |
| `npm run typecheck` | 0 errors |
| `npm test` | 772 passed / 5 skipped (79 files, 4 skipped files) |
| `npm run build` | Passes |

## 1. Phase 0 audit: Round 1 "DONE" checked against the code

| Round 1 label | Code fact | Correction |
|---|---|---|
| S1-06 Workflow task structure DONE | `src/main/workflows/runtime.ts` only maps from Runtime skill files; Runtime only writes Pattern/Context/Evidence, and steps exist only when `Steps:` is written explicitly. The vast majority of real Workflows have only goal/context/evidence | **PARTIAL**: schema exists, content empty |
| S1-08 Library DONE | `library/aggregate.ts` has only people/projects/unclassified + `behavior_patterns` skills; no "Profile", does not read the Lens Workflow store (imported / shared `.lensskill` files are not shown) | **PARTIAL** |
| S1-11 Peers DONE | Card import / weekly letter work; subscriptions `unsupported` | **PARTIAL** |
| S1-02 weekly report export "does not state the assessor is off" | `src/main/het/weekly.ts` already has `assessorNote()`; the README Limitations sentence is drift | Delete the old README sentence |
| Natural-language questions / WeChat groups | No "Ask" entry point, no recipe | TODO → S2-03 |
| First launch | Launch goes straight to "Overview" | TODO → S2-01 |
| Full export / backup | Only per-item export | TODO → S2-02 |
| E2E | New pages not covered | TODO → S2-05 |

## 2. Round 2 plan (3–5 lines per task)

How it runs: the lead builds the scaffolding (the shared wiring listed in `s2-log/BRIEF.md`), 5 implementation agents + 1 docs agent run in parallel with non-overlapping write sets; E2E and security review come after implementation.

- **S2-01 Onboarding** (onboard-ask): `<LensStore>/onboarding.json` (0600) decides first launch; skippable steps: Welcome → Permissions → Connect → Import → Done (`libraryHeadline`); pure state machine tests.
- **S2-02 Backup** (backup-import): `persome model export --out <dir>/model-snapshot.json` (execFile, PERSOME_ROOT) + copy an allowlist of Lens data + manifest; restore only merges workflows/peers; private keys / grants / audit are not backed up; write to a temporary directory, then rename.
- **S2-03 Ask** (onboard-ask): ≥4 fixed prompt cards (tool names, copy, go to Connections, "Lens does not call an LLM"); the WeChat group recipe states the OCR/AX limits.
- **S2-04 Library profile + Workflow** (library-today): Profile block (Root / Top 3 Faces / counts → Model); the skills column merges the Workflow store (observed / imported / shared badges, dedup, deep link to Playbook).
- **S2-05 E2E** (e2e, last): Today / Library / Import / Peers / Workflow / `.lensskill` / onboarding / Ask / Backup; labeled `[real]`/`[mock]`.
- **S2-06 Docs** (docs + lead): GAP-vs-S1 S1-06/08/11 → PARTIAL; README drift; DEVIATIONS D32+.
- **S2-07 Workflow extraction** (workflows): prompt + schema → external Agent → paste JSON → validate and save (user_edited / imported), never overwrites an observed id.
- **S2-08 Next steps** (library-today): only from `- [ ]` / `TODO:` / the Chinese to-do prefix and learned habits; every item "unverified"; not called Performance.
- **S2-09 Subscription folder** (peers-sub): choose a folder → manual refresh → verify and import `.persomecard` / `.lensskill`, hash dedup, off by default, no network.
- **S2-10 Build-after-import switch** (backup-import): off by default; turning it on needs a second confirmation; failures show exit code / stderr.
- **S2-11 / S2-12** (docs): `PERFORMANCE.md`, `upstream/HABIT-3-DATES.md`, `upstream/CAPTURE-L2L3.md`.

## 3. S1 goals item by item (Round 1 → Round 2)

Status: DONE = mechanism + automated evidence (unit tests / E2E); PARTIAL = mechanism exists but has known gaps; BLOCKED = needs a user decision / upstream / manual permissions. "The page looks like the article" does not count as DONE.

### U1 Personal Database
| Goal | Round 1 | Round 2 | Status | Evidence |
|---|---|---|---|---|
| Welcome / first launch | None | 5-step skippable onboarding (Welcome / Permissions / Connect / Import / Done + `libraryHeadline`), `onboarding.json` 0600, existing Stores are not disturbed, can be reopened from Settings | DONE (S2-01) | `tests/onboarding/*` (41); 2 E2E steps |
| Capture L2/L3 | BLOCKED | Unchanged; added a manual acceptance checklist `docs/upstream/CAPTURE-L2L3.md` | BLOCKED (manual TCC) | — |
| Import history | PARTIAL | + "Build after import" switch (off by default, not saved, second confirmation) | PARTIAL (build needs the Runtime LLM; tool output/thinking/subagents are not imported; re-importing a growing session duplicates it, D27) | `tests/import/build-after.test.ts`; E2E scan+prepare |
| Natural-language questions | TODO | "Ask" page with 4 prompt cards (tool names checked against the catalog), handed to an external Agent; Lens does not call an LLM | PARTIAL (no answer view inside Lens; results live in the external Agent) | `tests/ask/*`; E2E |
| WeChat group digest | TODO | Recipe card: `search_captures` + `read_recent_capture`, states the AX/OCR/retention limits | PARTIAL (only covers content that appeared on screen; OCR is off by default) | `tests/ask/*` |
| Daily brief + next steps | DONE (brief) | "Next steps" come only from `- [ ]` / `TODO:` / the Chinese to-do prefix + habit original text, each item unverified + source | DONE (S2-08); proactive push not done (X9) | `tests/library/nextSteps.test.ts`; E2E export contains the Next steps heading |
| Library people/projects/profile/skills | PARTIAL | Profile (Root original text + Top3 Faces in Runtime order + counts); skills merge the Workflow store (observed/imported/shared/edited/external-extraction badges), deep link to Playbook; per-section fault tolerance | DONE (S2-04) | `tests/library/{skills,portrait}`; E2E |
| Full export / backup | None | Model snapshot (`persome model export`) + Lens allowlist + sha256 manifest; restore merges workflows/peers; private keys/grants/audit are not backed up | DONE (S2-02); restore drops Workflow history (D36) | `tests/backup/*` (25); E2E export |
| Evidence chain | PARTIAL | Unchanged | BLOCKED upstream (MOD-07) | — |

### U2 Workflow / Skills
| Goal | Round 1 | Round 2 | Status | Evidence |
|---|---|---|---|---|
| Task structure has content | PARTIAL (mostly empty) | External Agent extraction: prompt + zod-derived JSON Schema → paste back → validate → `ext-*` (does not overwrite `rt-*`); parser supports `###`/plain-text Steps | PARTIAL: relies on the user running an external Agent manually; what Runtime observes is still empty (upstream only writes Pattern/Context/Evidence/Confidence) | `tests/workflows/extract*`, `parse-sections`; E2E fixture skill with 4 steps |
| Readable by Library/Agents | DONE | Skills column shows `.lensskill`; Broker `get_workflow` covered by E2E | DONE | E2E |
| Habits on ≥3 dates | PARTIAL | Upstream proposal `docs/upstream/HABIT-3-DATES.md` | PARTIAL / BLOCKED (X6, X10) | — |
| Grows with use / sharing | DONE | Subscription folder can carry `.lensskill` (only from signers already in the peer list) | DONE | `tests/peers/subscription.test.ts` |

### U3 Shared moments
| Goal | Round 1 | Round 2 | Status |
|---|---|---|---|
| Peer cards | PARTIAL | E2E covers import/tamper rejection | DONE |
| Weekly letter | DONE (draft) | Unchanged; not sent | PARTIAL (no delivery, X1) |
| Subscriptions | `unsupported` | Local subscription folder, manual refresh, signature verification, hash dedup, no network | PARTIAL (no background sync, X2) |

### Measurable
| Goal | Status |
|---|---|
| HET minutes | BLOCKED (X3); page shows "Unmeasured"; the word "Performance" removed from the HET page (D40) |
| Performance | BLOCKED (X4): `docs/design/PERFORMANCE.md` with three options + a recommendation, not implemented |
| Proactive layer (Tray / notifications / shortcuts) | Not done (X9) |

## 4. Task log

| Task | Agent | Status | Key files | Tests |
|---|---|---|---|---|
| S2-01 Onboarding | onboard-ask | DONE | `src/main/onboarding/store.ts:47-110`, `ipc.ts`; `components/onboarding/flow.ts:51`; `pages/Onboarding.tsx`; reopen from Settings (lead) | `tests/onboarding/*` 41 |
| S2-02 Backup | backup-import | DONE | `src/main/backup/service.ts` (`scanForSecrets`, `exportTo`, `validate`, `restore`); `components/backup/*` | `tests/backup/*` 25 |
| S2-03 Ask | onboard-ask | DONE | `components/ask/prompts.ts:39`, `askView.ts`; `pages/Ask.tsx` | `tests/ask/*` 9 |
| S2-04 Library | library-today | DONE | `src/main/library/skills.ts`, `aggregate.ts:84-180`, `ipc.ts:44-80`; `components/library/viewModel.ts`; `pages/Library.tsx` | `tests/library/{skills,portrait}` |
| S2-05 E2E | e2e | DONE (37 PASS / 5 SKIP) | `tests/e2e/smoke.e2e.mjs`, mocks, `fixtures/model-graph.json`, `packaged-check.sh` (only `bash -n`) | — |
| S2-06 Docs | docs + lead | DONE | `GAP-vs-S1.md` (S1-06/08/11 → PARTIAL), README, DEVIATIONS D32–D40 | — |
| S2-07 Extraction | workflows | PARTIAL (mechanism DONE; content relies on an external Agent) | `src/main/workflows/extract.ts`, `store.ts:309`, `parse.ts:183-185`; `ExtractPanel.tsx`; `Playbook.tsx` deep link | `tests/workflows/extract*` etc. 31 |
| S2-08 Next steps | library-today | DONE | `src/main/library/brief.ts:199`; `pages/Today.tsx:83-118` | `tests/library/nextSteps` 9 |
| S2-09 Subscriptions | peers-sub | DONE (local, manual) | `src/main/peers/subscription.ts`; `components/peers/SubscriptionSection.tsx` | `tests/peers/subscription` 13 |
| S2-10 Build after import | backup-import | DONE | `pages/importView.ts:136-204` | `tests/import/build-after` 10 |
| S2-11 Performance | docs | DONE (docs; metrics BLOCKED) | `docs/design/PERFORMANCE.md` | — |
| S2-12 Upstream | docs | DONE (docs; not submitted) | `docs/upstream/{HABIT-3-DATES,CAPTURE-L2L3}.md` | — |
| Security review + fixes | security-reviewer + security-fix | M1 M2 L2 L3 L4 fixed; L1 L5 recorded | `s2-log/S2-SEC.md` | `tests/security/redact-errors` etc. 16 |

## 5. Conclusion

| Item | Baseline | End |
|---|---|---|
| typecheck | 0 errors | 0 errors |
| `npm test` | 772 passed / 5 skipped (79 files) | 932 passed / 5 skipped (96 files, 4 skipped files) |
| `npm run build` | Passes | Passes |
| E2E (`E2E_NO_FOCUS=1`) | 22 PASS / 4 SKIP | 37 PASS / 5 SKIP / 0 FAIL (the new SKIP = backup restore, reason in S2-05; restore is covered by unit tests) |

Remaining risks: backup is certain to fail on very large snapshots (>~512 MiB) and its synchronous I/O freezes the UI (L1); snapshot redaction relies on Runtime defaults (L5); `packaged-check.sh` has not actually been run on a packaged build; the `confirm:true` supplied by the renderer is an inherent IPC trust boundary.

Next steps: the user decides on `DECISIONS-ROUND2.md`; upstream Runtime outputs structured Steps/Artifacts/Rules/Problems; after packaging, run `npm run e2e:packaged` and the CAP-01/08/09 manual checklist.
