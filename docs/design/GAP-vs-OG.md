# Navalia — GAP vs OG (OG-00 re-baseline + OG-FINAL, 2026-11-05)

The main oracle is the reference document's **§15 test table**; the S1 article is only a secondary reference. `GAP-vs-S1*.md` is used only to check "what already exists", not as OG evidence.
This pass is **OG-00: a read-only re-baseline; `src/` was not changed**. **OG-FINAL (same day, after the implementation round ended)** updated Table 1 rows #1–4, 8, 17, 19, 20, 29, 32 and Table 2, based on the "OG-FINAL 2026-11-05" section of `REPORT.md` and on `docs/test-evidence/OG-FINAL/`. Test evidence is in `docs/test-evidence/OG-00/`; scoring is in the "OG-00 rebaseline 2026-11-05" section of `docs/test-evidence/REPORT.md`.

## 0. Rules

- Levels follow reference §0.3: L0 = an entry point exists; L1 = user-visible behavior matches; L2 = internal mechanism/responsibilities match; L3 = data contract/semantics match.
- The "Level" column records the **highest level supported by evidence**. Anything with only an entry point and no §15 evidence is written as L0 and not raised. Anything with no entry point is written as "—".
- Status:
  - **DONE**: the §15 tests for this surface have PASS evidence and no undeclared FAIL.
  - **PARTIAL**: implemented, but missing L2/L3 evidence, has a FAIL, or covers only part of the behavior.
  - **BLOCKED**: needs an account/cloud, manual TCC authorization, a Developer ID, or a user decision (see `DECISIONS-OG.md`).
  - **TODO**: Lens does not have this surface.
- The baseline snapshot was taken 2026-11-05 10:39–10:42 PST. Other agents were changing `src/` during that window: `src/renderer/src/pages/Home.tsx`, `src/renderer/src/components/home/*`, `src/renderer/src/pages/Rewind.tsx`, `src/main/rewind/*`, `tests/rewind/*` appeared during this baseline (`docs/test-evidence/OG-00/surface-grep.txt`). **This in-progress work earns no score and raises no level**; it is assessed in the next audit round.

## 1. Surfaces × current state

| # | OG surface (reference §5) | Lens current state (files) | Level | §15 tests | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | Menu bar presence | OG-04: `src/main/shell/*` (Tray, off by default, `shell-settings.json` 0600) | L0 (implementer evidence) | VIS-09 | `OG-04/README.md`; `OG-FINAL/settings-dom.json` (toggle off by default) | BLOCKED (OG-FINAL: the menu needs a human to look at it; CDP cannot see it) |
| 2 | Global shortcut | OG-04: `globalShortcut`, off by default, `CommandOrControl+Shift+Space` | L0 | VIS-05 | `OG-04/README.md`; `OG-FINAL/settings-dom.json` ("Not registered") | BLOCKED (pressing the shortcut needs a human) |
| 3 | Home › Today | `pages/Home.tsx` "Today" card + `pages/Today.tsx`, `src/main/library/brief.ts` (D29/D35) | L1 | VIS-06 PASS; VIS-07 **FAIL** | `OG-FINAL/home-dom-empty-runtime.json`, `home-dom-no-runtime.json` | PARTIAL (when the Runtime cannot be read, the "Today" / "To-dos" cards show 0 items instead of an error) |
| 4 | Home › HET | `pages/Het.tsx`, `src/main/het/*`, REST `/het/*` (OG-08, D41–D47). The real transport is not wired (X3/D22); in actual use it shows "Not measured" | L3 | HET-01..10 all PASS (HET-05 tested by OG-FINAL on the running app) | `OG-FINAL/het05-app-*`, `HET-0*/2026-11-05-record.txt` | DONE (fixture level; real minutes limited by X3) |
| 5 | Home › Actions | Only Today "Next steps": extracted from `- [ ]` / `TODO:` / the Chinese "to-do:" prefix lines. The original uses `playbook_tasks` (settled event cards → daily task instances, §5.5), a different mechanism | L0 | — | `tests/library/nextSteps.test.ts` | PARTIAL |
| 6 | Home › Memories | `pages/Search.tsx` (Memory / screen / recent), `pages/Model.tsx` Points, `components/RememberDialog.tsx`, `CorrectDialog.tsx`; Runtime tools proxied by `src/main/mcp/client.ts` | L0 (UI); Runtime correction L3 | MEM-01..10 untested; MOD-10 PASS (Runtime path) | `OG-00/mod10-run.json` | PARTIAL |
| 7 | Home › Agents | `pages/Connections.tsx`, one row per Agent, `src/main/broker/agents.ts` | L1 | ID-03/04/05/06 PASS | `ID-03..06/*` | DONE |
| 8 | Home › Heatmap | `pages/Home.tsx` "Activity heatmap": 7 days × 24 h, data is the latest ≤100 `recent_activity` entries (not all captures; the card says so) | L1 | VIS-06 | `OG-FINAL/home-dom-empty-runtime.json` | PARTIAL (data source is only a sample) |
| 9 | Home › Recent | `pages/Search.tsx` "Recent" tab (`recent_activity`) | L0 | — | — | PARTIAL (untested) |
| 10 | Home › Agent reads | Connections → Access log (`components/connections/AccessLogList.tsx`, `AccessChart.tsx`, `src/main/broker/audit.ts`). Lives on the Connections page, not Home | L3 | ID-08/09/10/13 PASS | `ID-08/*`, `ID-09/*`, `ID-10/2026-11-05-*`, `ID-13/*` | DONE (different location) |
| 11 | Home › Connections | Same as #7, #10 | L3 | ID-03..09, 11..13 | Same as above | DONE |
| 12 | Home › Skills | `pages/Library.tsx` skills column, `pages/Playbook.tsx`, `src/main/workflows/*`, `.lensskill` (D25/D30/D37). The original is knowledge.md auto-learning + versions + sharing | L0 | — | `tests/workflows/*` | PARTIAL |
| 13 | Home › Peers | `pages/Peers.tsx`, `src/main/peers/*`: local import of `.persomecard`, subscribed folders (D31/D38). The original goes through the cloud | L0 | — | `tests/peers/*` | PARTIAL (cloud part BLOCKED, X1) |
| 14 | Model › overview | `pages/Model.tsx` (Root / Faces / Volumes / Points), `pages/Overview.tsx` (build status, `degraded_stages`) | L0 | MOD-01..06, 08, 09, 11..14 untested; MOD-13 untested | — | PARTIAL |
| 15 | Model › Personal Card | `pages/Card.tsx`, `components/card/PersonalCard.tsx`, `src/main/identity/card.ts`: local Ed25519 self-signature (D3/D3a), can flip, has as-of | L1 | ID-01 PASS (scored per D3); ID-02 BLOCKED; VIS-02 not tested separately | `ID-01/*` | DONE (per D3); claim flow BLOCKED |
| 16 | Model › Map | Only `components/card/MiniMap.tsx` on the card back; no Model Map that shows points, lines, faces, volumes and root | L0 | VIS-03 | `OG-00/surface-grep.txt` | TODO |
| 17 | Settings | `pages/Settings.tsx`: Runtime diagnostics, menu bar and shortcut, privacy (pause / excluded links / read-only retention / delete / revoke), updates, meeting audio (BLOCKED), backup | L1 | PRIV-02/03/06/07 PASS; CAP-05/06, ID-11 PASS | `OG-FINAL/settings-dom.json`, `settings-shell-privacy.png`, `PRIV-0*/2026-11-05-*` | PARTIAL ("Export a backup first" is off by default, inconsistent with OG-D7; no account section) |
| 18 | First-run | `pages/Onboarding.tsx`, `src/main/onboarding/store.ts` (D32): 5 steps, skippable, no sign-in. "Library preview" is only a `libraryHeadline` count, not the original's evidence-backed `library_preview` model call | L0 | VIS-08 untested; INT-01 BLOCKED | `tests/onboarding/*` | PARTIAL (sign-in BLOCKED) |
| 19 | Rewind | `pages/Rewind.tsx`, `src/main/rewind/*`, sharing `src/main/broker/rewind.ts`: decrypts only in main; BLOCKED without a key; plaintext frames are refused | L1 | VIS-04 PASS (fixture frames); CAP-03 PASS (L3 code path) | `OG-FINAL/rewind-*` | DONE (L1, fixture); real frames need Screen Recording permission |
| 20 | Recovery | `pages/Recovery.tsx`, `src/main/recovery/*`: 11 checks, each with a next step; doctor, start/restart, copy diagnostics; the only destructive action is "Rebuild capture index" (second confirmation, OG-D7b) | L1 | VIS-10 BLOCKED (the updates half); the recovery half is UNKNOWN at the app level | `OG-FINAL/recovery*.png`, `recovery-dom*.json`, `recovery-doctor-dom.json` | PARTIAL ("failure → recovery → no data lost" has not been run in the app) |
| 21 | Swipe Your Card | `pages/Swipe.tsx` + Connections connection flow | L1 | ID-03/04/05 PASS | `ID-03..05/*` | DONE |
| 22 | Connections | `pages/Connections.tsx`: full access only; scoped is the Extension (D1) | L1 | ID-03..07 PASS | `ID-07/*`, `OG-00/static-source-checks.txt` | DONE |
| 23 | Access log | Same as #10. Clearing it does not affect connections | L3 | ID-08..13 PASS | `ID-08..13/*` | DONE |
| 24 | Chat | None. `pages/Ask.tsx` only provides prompt cards, handed to an external Agent to run (D33) | — | INT-02 | — | BLOCKED (cloud, OG-D1) |
| 25 | Meetings | None | — | INT-03, PRIV-10 | — | BLOCKED (cloud + Soniox) |
| 26 | Check-ins | Local drafts only: `src/main/peers/letter.ts` (weekly letter), `src/main/het/weekly.ts` (weekly report export); neither is sent (D2) | L0 | — | `tests/peers/*`, `tests/het/*` | BLOCKED (delivery needs the cloud) |
| 27 | Friends / Peers | Same as #13 | L0 | — | — | PARTIAL / BLOCKED |
| 28 | Wiki / Skills | Same as #12 | L0 | INT-04 BLOCKED | — | PARTIAL |
| 29 | Quick Box | OG-04: separate window `#quickbox`, restricted preload (`src/preload/quickbox.ts`); Quick ask / Quick note / Quick open; does not call an LLM | L1 (window) | VIS-05 BLOCKED (shortcut) | `OG-FINAL/quickbox.png`, `quickbox-dom.json` | PARTIAL |
| 30 | Proactive push | None (X9: not doing it) | — | — | — | TODO (OG-D5) |
| 31 | Daily review | Today brief is generated from a template, no LLM call, every item marked "unverified" (D29). No "draft → evidence → fact check" flow like the original | L0 | — | `tests/library/brief.test.ts` | PARTIAL |
| 32 | Updates | Settings "Updates": shows the current version; "Check for updates" returns BLOCKED directly, makes no network request, does not poll | L1 (BLOCKED state) | VIS-10 | `OG-FINAL/settings-updates-dom.json`, `VIS-10/2026-11-05-*` | BLOCKED (OG-D4 no release source, OG-D3 no Developer ID) |
| 33 | Capture (shell owns TCC) | `pages/Capture.tsx`, `src/main/capture/*`, `native/src/*.mm` | L1 | CAP-05/06/10 PASS; CAP-01/02/07/08/09 BLOCKED; CAP-03/04 untested | `CAP-0{5,6}/*`, `OG-00/CAP-10-static.txt`, `OG-00/CAP-01-ps-live.txt` | PARTIAL (L2/L3 BLOCKED) |
| 34 | Signing / notarization (packaging) | `mac.identity: null` in `package.json`, dist is `Signature=adhoc`, no TeamIdentifier | — | (no §15 ID; affects CAP-01 part 2) | `OG-00/CAP-10-static.txt` | BLOCKED (OG-D3) |
| 35 | Model evidence gating (L2 core) | Owned by upstream Runtime 0.3.2. Lens's EvidenceDrawer shows these receipts as "unresolved" (D20) | L3 FAIL | MOD-07 FAIL; MOD-08 not tested separately | `OG-00/mod07-run.json` | PARTIAL (upstream) |

### Surface-level conclusions

- Only the identity-layer foursome (Card / Swipe / Connections / Access log) reached DONE, and Access log reached L3.
- Capture stops at L1: every L2/L3 test that could prove "the shell owns TCC" is BLOCKED.
- The original main-window shape (Home with multiple tabs + Model Map + Rewind + menu bar / shortcut / Quick Box + Recovery + Updates) is entirely missing in the baseline. Currently it is just "a single window + multiple pages in a sidebar".
- Cloud-related surfaces (Chat / Meetings / Check-in delivery / sign-in / skill billing) are not introduced per X1 and are marked BLOCKED; do not dress them up as DONE.
- **OG-FINAL update**: Home (11 cards), Rewind, Recovery, menu bar / shortcut / Quick Box, and Settings privacy / updates are all implemented. Model Map (VIS-03) is still TODO. HET reached DONE (fixture level). New L1 defect: when the Runtime cannot be read, Home "Today" / "To-dos" show 0 items (VIS-07 FAIL).

## 2. §15 test IDs × status

Levels are taken from §15.2 (ID-01 recorded as L1). Status: PASS / FAIL / BLOCKED / TODO (Lens has no corresponding surface) / UNTESTED (implemented or owned by the Runtime, but not run per §15).
"OG-00" column: **R** = rerun in this pass; **S** = only a static source / build-artifact review in this pass (not a UI run); **C** = carried over from the 2026-11-04 result, not rerun. OG-FINAL adds two values: **OG-FINAL** = observed by the auditor in person in the OG-FINAL session; **IM** = a record written by the implementer on 2026-11-05, not rerun by the auditor (the cited unit tests all pass in the 1200-test gate).

### CAP
| ID | Level | Status | OG-00 | Evidence / reason |
|---|---|---|---|---|
| CAP-01 | L2 | BLOCKED | S (ps) | `CAP-01/process-and-config.txt`; `OG-00/CAP-01-ps-live.txt`: no `mac-ax-*` process on this machine right now; the real root's `capture.source` was not read (reading it is forbidden). Part 2 (TCC) needs a human |
| CAP-02 | L2 | BLOCKED | — | Capturing AX text needs AX permission; OCR is off by default |
| CAP-03 | L3 | PASS | OG-FINAL | `CAP-03/2026-11-05-og02.md`; oracle test rerun 3/3 in this session |
| CAP-04 | L1 | PASS (simulated duration) | OG-FINAL | `CAP-04/2026-11-05-og02.md` |
| CAP-05 | L1 | PASS | C | `CAP-05/run.log` |
| CAP-06 | L1 | PASS | C | `CAP-06/*` |
| CAP-07 | L1 | PASS (logic + recorded fixture; real-device password entry pending a human) | IM | `CAP-07/2026-11-05-og02.md` |
| CAP-08 | L2 | BLOCKED | C | `CAP-08/heartbeat-watch.log`; needs AX permission + 11 minutes idle |
| CAP-09 | L3 | BLOCKED | C | Needs AX permission; D13 |
| CAP-10 | L1 | PASS | S | `OG-00/CAP-10-static.txt`: only `AXIsProcessTrusted*`, `CG*ScreenCaptureAccess`; the dist Info.plist no longer has camera/mic usage strings |

### MOD
| ID | Level | Status | OG-00 | Evidence / reason |
|---|---|---|---|---|
| MOD-01 | L3 | FAIL | R (OG-00b) | `MOD-01/2026-11-05-record.txt`: Points have only ingest time (created_at), `occurred_at` is empty; MCP/REST `resolve_evidence` returns `sources=[]` throughout. Same root cause as MOD-07 (upstream `docs/upstream/MOD-07.md`) |
| MOD-02 | L3 | FAIL | R (OG-00b) | `MOD-02/…`: 14 relation Lines have types, but 0 resolve to a source; 6 `knows` (co-occurs) edges were promoted to active without a quote; `part_of "works at"` with the original text is still shadow. Upstream `docs/upstream/MOD-02.md` |
| MOD-03 | L3 | PASS | R (OG-00b) | `MOD-03/…`: a single sample → shadow; two signals + a resample the next day → active (per the OSS definition; the gate counts extraction signals and build dates, not sessions). LLM transport is a mock |
| MOD-04 | L3 | FAIL | R (OG-00b) | `MOD-04/…`: evidence has only 2 dates, yet the Face was promoted to a resident behavior pattern; the habit prefilter `min_occurrences=2` lets a 2-date pattern through. Matches the D24 expectation; upstream proposal `docs/upstream/HABIT-3-DATES.md` |
| MOD-05 | L3 | PASS | R (OG-00b) | `MOD-05/…`: two domains fused into a level-2 Volume, confidence 0.75, active after the second sample. LLM transport is a mock |
| MOD-06 | L1 | PASS | R (OG-00b) | `MOD-06/…`: after building an empty store root=null, HUMAN.md states there is no Root; the Lens model page shows Root as forming, "No Root / Volume / Face yet" |
| MOD-07 | L3 | FAIL | R | `OG-00/mod07-run.json`, `MOD-07/2026-11-05-record.txt`: gate ✓; the receipt cannot be resolved, and the drop reason is just an integer. Root cause is upstream. OG-FINAL counts it as FAIL (OG-00b recorded BLOCKED-upstream; both scorings are in REPORT) |
| MOD-08 | L3 | FAIL | R (OG-00b) | `MOD-08/2026-11-05-record.txt`: the model-evidence receipt cannot be resolved (same root as MOD-07) |
| MOD-09 | L3 | FAIL | R (OG-00b) | `MOD-09/…`: repeated apply is idempotent ✓; a conflicting relation edge closes and keeps the old edge ✓; but conflicting Points ("at Acme" / "at Beta Labs") are both latest, with no supersede and no conflicted mark. Upstream `docs/upstream/MOD-09.md` |
| MOD-10 | L3 | PASS | R | `OG-00/mod10-run.json`: applied; old row kept with `superseded=1`; reason recorded |
| MOD-11 | L3 | FAIL | R (OG-00b) | `MOD-11/…`: merging two people waits for a user correction ✓; what others said is not recorded as the user ✓; but the owner alias `ryl-dev` was auto-merged into self after a single session, without confirmation. Upstream `docs/upstream/MOD-11.md` |
| MOD-12 | L3 | FAIL | R (OG-00b) | `MOD-12/…`: CLI `as-of` and MCP `entity_graph(as_of)` are correct ✓; REST `/model/evidence?as_of` returns Points that did not yet exist at T as active (this is what Lens's "view as of then" uses). The timeline is ingest time. Upstream `docs/upstream/MOD-12.md` |
| MOD-13 | L1 | **FAIL** (upstream) | R (lead retest 2026-11-05) | `MOD-13/2026-11-05-rerun-*`: the user decided to require verbatim reason codes. Runtime 0.3.2's REST does not return no_faces/no_volumes/no_root (only the CLI `persome model status` prints them), only `degraded_stages=["model_contract"]`. Lens now shows the codes returned by the Runtime verbatim + an explanation (`model_status.issues`), without inferring them itself; for 0.3.2 it shows model_contract + a "CLI only" note. Upstream proposal `docs/upstream/MOD-13.md` |
| MOD-14 | L3 | FAIL | R (OG-00b) | `MOD-14/…`: types are correct at write time (artifact→tool-, events as event); `entity-retype` only renames the file, the edge endpoint types and person-entity labels stay the same; calling it by display name errors. Upstream `docs/upstream/MOD-14.md` |

### MEM
| ID | Level | Status | OG-00 | Evidence / reason |
|---|---|---|---|---|
| MEM-01 | L3 | BLOCKED | R (OG-00b) | `MEM-01/…`: without vectors it degrades to BM25 ✓; the vector half needs an embeddings endpoint and key (account/credentials) |
| MEM-02 | L3 | PASS | R (OG-00b) | `MEM-02/…`: path/timestamp/age_days/content all present (age_days computed from write time) |
| MEM-03 | L3 | PASS | R (OG-00b) | `MEM-03/…`: captures written via REST ingest; snippets are highlighted, with file_stem |
| MEM-04 | L1 | PASS | R (OG-00b) | `MEM-04/…`: the Lens evidence drawer shows "Direct sources" and "Nearby context (not direct evidence)" separately |
| MEM-05 | L3 | FAIL | R (OG-00b) | `MEM-05/…`: behavior_patterns has root/faces/skills fields ✓; but `search` can find Face/Volume text, including Faces that have not passed the gate. Upstream `docs/upstream/MEM-05.md` |
| MEM-06 | L3 | PASS | R (OG-00b) | `MEM-06/…` |
| MEM-07 | L3 | PASS | R (OG-00b) | `MEM-07/…`: new entries survive a restart, with `source:agent-run` |
| MEM-08 | L3 | PASS | R (OG-00b) | `MEM-08/…`: supersede; the old entry is kept struck through and can be found |
| MEM-09 | L3 | FAIL | R (OG-00b) | `MEM-09/…`: contradictions are shown ✓; version updates (0.2→0.3) are not flagged, age_days ignores occurred_at, and it cannot give the current version. Upstream `docs/upstream/MEM-09.md` |
| MEM-10 | L3 | FAIL | R (OG-00b) | `MEM-10/…`: all other tools have limits; `read_memory` has neither a cursor nor a size limit (400 entries = 176,566 characters). Upstream `docs/upstream/MEM-10.md` |
| MEM-11 | L3 | PASS (dev build) | C | `MEM-11/token-scan.txt` |

### ID
| ID | Level | Status | OG-00 | Evidence / reason |
|---|---|---|---|---|
| ID-01 | L1 | PASS (per D3) | C | `ID-01/*` |
| ID-02 | L1 | BLOCKED | IM | No account (D3 / OG-D1); `ID-02/2026-11-05-record.txt` |
| ID-03..06 | L1 | PASS | C | `ID-03..06/*` |
| ID-07 | L1 | PASS | C + S | `ID-07/*`; `OG-00/static-source-checks.txt` |
| ID-08 / ID-09 | L3 | PASS | C | `ID-08/*`, `ID-09/*` |
| ID-10 | L1 | PASS | C | `ID-10/2026-11-05-record.txt` (OG-07) |
| ID-11 / ID-12 | L1 | PASS | C | `ID-11/*`, `ID-12/*` |
| ID-13 | L3 | PASS | C + S | `ID-13/ui-copy.txt`; `OG-00/static-source-checks.txt` |

### HET
| ID | Level | Status | OG-00 | Evidence / reason |
|---|---|---|---|---|
| HET-01 | L1 | PASS | C + S | `OG-00/static-source-checks.txt`: `src/main/het/api.ts:11` is byte-for-byte identical to §5.6 |
| HET-02 | L3 | PASS | R | `OG-00/HET-02-het-audit.json` (sha same as 11-04, c882a68c) |
| HET-03 | L2 | PASS | R | `OG-00/HET-03-het-audit.json` (fixtures) |
| HET-04 | L3 | PASS | R | `OG-00/HET-04-het-audit.json` |
| HET-05 | L3 | **PASS** | OG-FINAL | `OG-FINAL/het05-app-*`: REST `/het/*` called on the running app; 401 / limits / cursor / timezone / Access log all correct; D17/D18 |
| HET-06 | L3 | PASS | IM + OG-FINAL | `HET-06/2026-11-05-record.txt`; start/end/agent/kind/minutes seen in the app's response (the evidence field needs `include_activity`) |
| HET-07 | L2 | PASS | R | `OG-00/HET-07-het-audit.json` |
| HET-08 | L1 | PASS | IM | `HET-08/2026-11-05-record.txt`; the retry in the UI is wired up (`lens:het:retry`) |
| HET-09 | L1 | PASS | C + S | `OG-00/static-source-checks.txt` |
| HET-10 | L1 | PASS | C | `HET-10/ui-evidence-counts.json` |

### VIS
| ID | Level | Status | Reason |
|---|---|---|---|
| VIS-01 | L0 | PASS (counted as "routes"; FAIL if separate windows are required) | Single window + routes; Quick Box is a separate window |
| VIS-02 | L1 | PASS | ID-01 flip evidence (11-04 UI) |
| VIS-03 | L1 | TODO | No Model Map |
| VIS-04 | L1 | PASS (fixture frames) | `OG-FINAL/rewind-*`: BLOCKED without a key; decrypted in main with a key; plaintext frames refused |
| VIS-05 | L1 | BLOCKED | The Quick Box window opens (`OG-FINAL/quickbox.png`); pressing the shortcut needs a human |
| VIS-06 | L1 | PASS | `OG-FINAL/home-dom-empty-runtime.json` |
| VIS-07 | L1 | PASS | App retest (`VIS-07/2026-11-05-rerun-*`): when the Runtime cannot be read, "Today" / "To-dos" show the read-failure reason instead of 0 items |
| VIS-08 | L1 | BLOCKED | Needs a human to revoke TCC permission |
| VIS-09 | L0 | BLOCKED | Menu bar implemented (OG-04); opening the menu needs a human to look |
| VIS-10 | L1 | BLOCKED | Updates: OG-D4/D3; recovery: checks and actions exist, but "failure → recovery" is UNKNOWN at the app level |

### INT / PRIV
| ID | Level | Status | Reason / evidence |
|---|---|---|---|
| INT-01..06 | L1 | BLOCKED | Cloud / account / third-party connectors (X1 / OG-D1) |
| PRIV-01 | L2 | UNTESTED | Needs packet capture; CSP `connect-src 'self'` is only circumstantial evidence |
| PRIV-02 | L1 | PASS (simulated expiry) | `PRIV-02/2026-11-05-record.txt`; `OG-FINAL/settings-dom.json` |
| PRIV-03 | L1 | PASS | `PRIV-03/2026-11-05-record.txt` |
| PRIV-04 | L2 | UNTESTED | `src/main/het/redact.ts`, `identity/redact.ts` have unit tests; Runtime egress not tested |
| PRIV-05 | L3 | PASS (fact recorded) | `OG-FINAL/priv05-fact.txt`: index.db is plaintext SQLite; screenshots are sealed |
| PRIV-06 | L1 | PASS | `PRIV-06/2026-11-05-record.txt` (real `persome clean` run on a temporary root; revoke) |
| PRIV-07 | L1 | PASS | `PRIV-07/2026-11-05-record.txt` + ID-11 |
| PRIV-08 | L3 | PASS (dev build) | `MEM-11/token-scan.txt` |
| PRIV-09 | L3 | PASS (fact recorded) | `OG-00/CAP-10-static.txt`: the dist Info.plist is now `NSAllowsLocalNetworking` + 127.0.0.1/localhost exceptions, and **no longer has** `NSAllowsArbitraryLoads` (the 11-04 record is out of date) |
| PRIV-10 | L2 | BLOCKED | No meetings feature (cloud) |

### Summary ([COMPUTED], OG-FINAL `docs/test-evidence/OG-FINAL/score.txt`; OG-00 values in parentheses)

| View | Value |
|---|---|
| §15.4 DMG weighted, original 30 IDs (11-04 definition) | 64/67 = **0.955** (0.910) |
| §15.4 DMG weighted, all IDs tested today | 123/161 = **0.764** |
| OG coverage, by count | 51/84 = **0.607** (25/84 = 0.298) |
| OG coverage, weighted | 123/208 = **0.591** (0.293) |
| Strict definition (PASS backed only by implementer evidence counts as UNTESTED) | 43/84; 106/208 = 0.510 |
| L2/L3 tests (42) | PASS 22, FAIL 12, BLOCKED 6, UNTESTED 2; weighted 66/126 = 0.524 |
| Status distribution | PASS 51 · FAIL 13 · BLOCKED 17 · TODO 1 · UNTESTED 2 (OG-00: 25 · 2 · 13 · 5 · 39) |

0.955 is only a comparable figure, not OG completeness. All 12 L2/L3 FAILs are upstream Runtime MOD/MEM behavior. Capture L2/L3 are still all BLOCKED, waiting on manual TCC authorization. For verdicts that depend on interpretation (MOD-13, MOD-11, MOD-07/08, VIS-07, VIS-01), both scorings are listed in REPORT.
