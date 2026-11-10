# Navalia — GAP vs S1-FULL (opt-in cloud round wrap-up, 2026-11-06)

Previous round: `GAP-vs-S1-R4.md` (the "before" column below). This round's architecture: `S1-FULL-ARCH.md`. Decisions: `DECISIONS.md` S1F-1 … S1F-15. Deviations: `DEVIATIONS.md` from D71 on.
The process log for each C item is in `docs/design/s1full-log/` (abbreviated below as `log/`). The final gate numbers were given by the lead on 2026-11-06; see §2.

Verdict rules (used throughout this document):
- **DONE**: the behavior the acceptance criteria require has automated tests or real-run evidence, and does not depend on real accounts / keys / hardware the user has not yet provided.
- **PARTIAL**: the mechanism is built and tested, but part of the acceptance was verified only against a fake / mock, or the upstream lacks an interface.
- **BLOCKED**: the acceptance itself needs the user's real account, key, certificate, hardware or approval, and cannot currently be met.
- Anything tested only against a fake / mock is always labeled "fake" or "mock". Real LLM, Soniox, an SMTP inbox, an IMAP mailbox, Notification Center / Tray / global shortcuts, a real microphone, the Docker build and Developer ID have **not** been verified in a real environment, and are never counted as DONE.

## 0. Baseline (R4 wrap-up → this round's wrap-up)

| Item | R4 final (2026-11-05) | S1-FULL final (2026-11-06) |
|---|---|---|
| Lens typecheck | rc=0 | exit 0 |
| Lens vitest | 152 files passed, 4 skipped; 1578 passed / 5 skipped / 0 failed | **194 files passed, 4 skipped; 2042 passed / 6 skipped / 0 failed** (final run after the lead's wrap-up fixes; before that, 193 / 2040 twice in a row) |
| Lens build | rc=0 | OK |
| Lens e2e (`E2E_NO_FOCUS=1`) | 37 PASS / 5 SKIP | **37 PASS / 5 SKIP**, including "no non-loopback socket within 15 s while cloud is off" (`tests/e2e/smoke.e2e.mjs:757`) |
| `cloud/` tests | did not exist | **118 / 118 pass** (`cd cloud && npm test`) |
| Upstream pytest | 2622 passed / 0 failed / 1 skipped @ `462361d` | **not re-run** this round (no new upstream commits, see C22) |
| §15 upstream retest | 63/63 (in R4, with the worktree venv) | **63/63**, this time on the **deployed venv** (`docs/test-evidence/S1FULL-C22/check_results.txt`) |
| Runtime | `462361d`, schema `2026-11-05.3` | Unchanged: `462361d` = tag `deploy/2026-11-05-r1r9`, deployed venv byte-identical to source, schema `2026-11-05.3`, no migration, `/health ok` |
| Real data (consolidated copy) | relation_edges 187 | entries 138 / evo_nodes 96 / captures 3152 / relation_edges 302 (`S1FULL-C22/summary.md` §2) |
| Backups | `20261105-173654-pre-r8`, `20261105-180023-pre-r9` | Added `/Users/ryl/Persome Backups/20261106-101058-pre-c22` (`manifest.sha256` 39 files, `shasum -c` 0 failures) |

## 1. S1-FULL goals / C items × before / after

### 1.1 Acceptance goals (the brief's acceptance lines, used for scoring in §3)

| # | Goal | R4 (before) | S1-FULL (after) | Status | Evidence |
|---|---|---|---|---|---|
| G1 | **local-only, zero outbound traffic** (default mode) | Local was the only mode; every socket on 127.0.0.1 | Cloud off by default; when off, every cloud entry point returns `disabled` before sending a request (global fetch spy: 0 calls); static scan: in `src/main/cloud` only `client.ts` calls fetch, and among connectors only `imap/tls.ts` uses `node:tls`; e2e on a real Electron dev build samples the whole process tree with lsof for 15 s, 0 non-loopback sockets. `e2e:packaged` was not re-run on the packaged build this round | **DONE** | `tests/cloud/disabled.test.ts`, `tests/connectors/no-network.test.ts`, `tests/e2e/smoke.e2e.mjs:757`, `log/C2.md` |
| G2 | **Cloud challenge / verify sign-in** | BLOCKED (X1 not approved) | Ed25519 device-key challenge → verify → Bearer; audience binding, single-use challenges, token stored only as sha256; at the gate the lead found and fixed **small-order public key forgery** (S1F-2); the Lens client completes sign-in → sign-out → sign-in again → delete account against a real `cloud/` child process | **DONE** (TLS / reverse proxy / Docker are deployment items, not verified) | `cloud/test/auth.test.ts`, `tests/cloud/e2e-real-server.test.ts`, `tests/cloud/auth.test.ts`, `log/C0-C1.md` |
| G3 | **Chat: answers with citations + preview before sending + write back to memory + screenshots never leave the machine** | BLOCKED | Preview items can be removed one by one, and the renderer cannot inject text; on a real `cloud/` (**mock LLM**): the context on the wire is byte-identical to the preview and contains no token / `data:image` / `.png` / `screenshots/` / `index.db` / phone numbers; citations map to the sent snapshot; "Remember this" goes through a native confirm to MCP `remember`. The openai adapter was verified only against an **in-test fake upstream** | **PARTIAL**: real LLM **not verified in a real environment** (needs the user's LLM key) | `tests/cloud/e2e-chat-real-server.test.ts`, `tests/cloud/chat.test.ts`, `cloud/test/{chat,llm}.test.ts`, `log/C3-C7.md`, `log/C4.md` |
| G4 | **Subscriptions: test inbox receives the weekly letter, unsubscribe works, forged cards / letters rejected, no read tracking** | Local folder subscriptions (D38); weekly letters only as drafts | Real `cloud/` + **outbox mode (`.eml` files act as the test inbox)**: double opt-in (GET does not confirm), weekly letter delivered (List-Unsubscribe + One-Click, no `<img>`, only one href), after an RFC 8058 POST unsubscribe the second letter has 0 recipients, forged cards / forged letters rejected on both ends, Bob verifies signatures offline. Real SMTP verified only against a **fake SMTP server** | **PARTIAL**: delivery to a real inbox **BLOCKED** (needs the user's SMTP + SPF/DKIM/DMARC) | `tests/cloud/e2e-subs-real-server.test.ts`, `cloud/test/{letters,subscribe,mail-unit}.test.ts`, `log/C8-C9.md`, `log/C8-C10.md` |
| G5 | **Meetings: record → transcribe → write back; delete on both ends; no recording without consent** | BLOCKED (PRIV-10, no microphone) | Real `cloud/` (**mock STT**): no consent / declined confirm → no meeting created, mic denied; the mic gate allows only audio + app URL + armed; 2×30 s chunks → ready; server audio directory emptied, local audio deleted; Markdown → **real `persome import-data` (temp root)** imported 1; after deletion the server returns 404 and the local directory is gone. Upstream has no interface for deleting individual entries inside the Runtime | **PARTIAL**: real microphone + MediaRecorder rotation never run; Soniox only against a fake server; imported content cannot be deleted per entry (`runtimeRemains: true` says so honestly) | `tests/cloud/e2e-meetings-real-server.test.ts`, `tests/cloud/meetings{,-pure}.test.ts`, `cloud/test/{meetings,stt-soniox}.test.ts`, `log/C12-C14.md`, `log/C13-server.md` |
| G6 | **Workflows have real steps** | PARTIAL (R8 deployed, real run BLOCKED on LLM budget) | Both paths built: upstream mapping (the R8 fixture has steps; an empty upstream yields 0, nothing invented); cloud extraction (session preview → send only ticked items → strict zod validation → user edits → save, provenance `cloud_extracted`). But on 2026-11-06 the real `behavior_patterns().skills = []`; cloud extraction has only run on a **mock LLM**, whose steps just copy the item titles and are not real steps | **BLOCKED**: no Workflow on real data has real steps; needs Runtime LLM quota (R8 pattern_detector) or the user's cloud LLM key | `tests/workflows/cloud-extract{,-real-server}.test.ts`, `log/C15.md`, `log/C18-C15-server.md` |
| G7 | **Traceable Performance** | "AI work counts this week" (X4 = B) already DONE | C16: accepted / rejected / not_agent by day / week, `git commit` calls in sessions, commits in repos the user added; each number = the count of rows you can open; unreadable sources are `null` ("unknown / not connected"), not 0; projects list activity only, no progress; visible to the owner only (static scan). Tested only on a fixture het.db / fixture transcript / temporary git repo; the screenshot is of an empty store | **DONE** (fixture-verified; real data not reviewed) | `tests/performance/*`, `log/C16-C17.md`, `log/phase4-performance-empty.png` |
| G8 | **Notifications can be turned off** | X9 local notifications DONE (T5 partial), never run on the real Notification Center | C17: turning off the master switch clears timers, unregisters shortcuts, empties tray items and drops pending events; everything off by default (including the v1 migration); stays silent and records the reason when context is insufficient. All tested with **fake** Notification / globalShortcut / Tray | **PARTIAL**: the off semantics are tested, but the real Notification Center / Tray / global shortcuts are **not verified in a real environment** | `tests/proactive/{c17,gates,no-network}.test.ts`, `log/C16-C17.md`, `docs/test-evidence/CAP-L2L3-CHECKLIST.md` B2 (NOT RUN) |
| G9 | **Shared moments are not literal overlap** | Literal overlap + relevance threshold (D67) | C18: objects signed by both parties; the server only relays, and the client verifies both signatures offline on every read; unknown signers cannot be accepted; weekly letters cite only accepted items with `visibility:"letters"`; literal overlap is demoted to "Keyword overlap (Unverified, not shared moments)" and never goes into any letter. e2e on a real `cloud/` with two real keys, cross-checking the objects Lens produces with the server's `verifyMomentText` / `verifyAcceptanceText` | **DONE** | `tests/cloud/e2e-moments-real-server.test.ts`, `tests/cloud/moments{,-sign,-letter}.test.ts`, `cloud/test/moments.test.ts`, `log/C18-C11.md`, `log/PHASE4-GATE.md` |
| G10 | **Connectors: import + delete** | Local `.ics` / health CSV-JSON / `.eml` / mbox, import only | C19: separate consent per connector; Apple Health XML/zip, generic CSV, read-only IMAP (implicit TLS, **verified only against a loopback TLS server with a self-signed certificate**); deletion: health records deleted successfully on a **real Runtime (temp root)**; remember memories can be deleted only with evomem write permission (under the default markdown they are listed as remaining); upstream has no interface to delete timeline documents by source; no client id for OAuth | **PARTIAL** | `tests/connectors/{consent,imap,apple-health,csv-import,delete,real-runtime}.test.ts`, `log/C19.md` |
| G11 | **Backups restore cards + history** | Cards restored; Workflows restored under new `imp-*` ids with only the latest version (D36) | C21: manifest signed with the identity key; signed by the owner → Workflows restored byte-for-byte under their original ids with all versions; each card's signature verified, bytes identical; optional AES-256-GCM (scrypt) single-file encryption; tampering / wrong passphrase / truncation all rejected with nothing written. A backup signed by another identity (new computer) → restored as renumbered copies (with full history) | **DONE** (for the new-computer consequence see §5 item 9) | `tests/backup/c21-archive.test.ts`, `log/C20-C21.md` |
| G12 | **MOD / MEM retests PASS or BLOCKED** | 63/63 (worktree venv) | 63/63 PASS on the deployed venv (MOD-01/02/04/07/08/09/11/12/13/14, MEM-05/09/10; MEM-09 run separately on a fresh root, as previously documented); LLM mocked throughout, so this proves thresholds and data contracts, not model quality | **DONE** | `docs/test-evidence/S1FULL-C22/{summary.md,check_results.txt}` |

### 1.2 C item details

| C | Content | before (R4) | after | Status | Evidence |
|---|---|---|---|---|---|
| C0 | Cloud architecture doc (decision reversal, outbound data list, STRIDE, API, retention) | none | `S1-FULL-ARCH.md`. (Round 4 review: ARCH now says 404, consistent with `answerable` in `cloud/src/moments.ts` and `cloud/test/moments.test.ts:282`; the remaining 403 is for the initiator responding to their own moment, which is correct) | DONE | `docs/design/S1-FULL-ARCH.md`, `log/PHASE4-GATE.md` |
| C1 | `cloud/` Phase 0: sign-in / sessions / account deletion / rate limiting / no sensitive logs / migrations | none | Implemented; small-order public key forgery fixed by the lead (S1F-2); Dockerfile written, **not built** (Docker daemon not running) | DONE (Docker PARTIAL) | `cloud/test/*.test.ts`, `log/C0-C1.md` |
| C2 | Lens cloud client (off by default, encrypted token, SSE, IPC) | none | Implemented; added at the gate: sign out of the server session when turning off / switching servers (3 s), token bound to the identity fingerprint, loopback http allowed only in unpackaged builds | DONE | `tests/cloud/{config,disabled,auth,ipc,sse}.test.ts`, `log/C2.md`, `log/C3-C7.md` |
| C3 | Chat context assembly + redaction + limits | none | ≤40 items / 60 000 chars / 8 000 per item; fixed redaction order | DONE | `tests/cloud/context.test.ts` |
| C4 | Server Chat (SSE, OpenAI-compatible / mock, daily budget) | none | Implemented; **only against a fake upstream**; real providers may require `max_completion_tokens` or reject `stream_options` (untested) | DONE (real LLM not verified) | `cloud/test/{chat,llm}.test.ts`, `log/C4.md` |
| C5 | Streaming + locally persisted conversations | none | `chat/c-*.json` 0600 | DONE | `tests/cloud/chat.test.ts` |
| C6 | "Remember this" write-back | none | native confirm → MCP `remember` (tags `lens-chat,cloud-chat`) | DONE | `tests/cloud/e2e-chat-real-server.test.ts` |
| C7 | WeChat group digest | Only a prompt for an external Agent (D33) | Uses only `search_captures` snippets from this week's WeChat captures, grouped by window title; never reads full captures (to avoid screenshot fields); **real WeChat window-title behavior not checked** [INFERRED] | PARTIAL | `log/C3-C7.md` R3 |
| C8 | Cloud cards (publish / fetch by fingerprint) | none | Server verifies signatures + Lens re-verifies offline + imports through Peers; e2e against a real server | DONE | `cloud/test/cards.test.ts`, `tests/cloud/cards.test.ts`, `tests/cloud/e2e-subs-real-server.test.ts` |
| C9 | Weekly letter + email subscription server | none | Double opt-in, unsubscribe / suppression, outbox worker, retention; `nodemailer` 10.2.1 (S1F-3); smtp mode requires a pepper (lead fix, S1F-4) | DONE (real SMTP BLOCKED) | `log/C8-C9.md` |
| C10 | "Subscriptions" page | Local folder subscriptions | Draft (fixed template, no LLM) → preview the bytes to be signed → native confirm → sign and publish; at the gate the lead added **weekly letter draft redaction** (`redactForCloud`, `src/main/cloud/subs.ts:283-303`) | DONE | `tests/cloud/subs{,-letter,-view}.test.ts`, `log/C8-C10.md` |
| C11 | Shared moments in weekly letters | Cites ticked literal-overlap items | Lists only shared moments that are accepted, double-signed, `letters`-visible and dated within the window; notes not attached by default | DONE | `tests/cloud/moments-letter.test.ts`, `log/C18-C11.md` |
| C12 | Recording (consent + mic gate) | none (PRIV-10) | Main-process mic gate; at the gate the lead found that `build/after-pack.cjs` strips `NSMicrophoneUsageDescription` (the packaged build would be unable to record), fixed (S1F-6). **The recorder browser glue has never run inside Electron, and a real microphone has never been touched** | PARTIAL | `tests/cloud/meetings-pure.test.ts`, `log/C12-C14.md` |
| C13 | Chunked upload + server transcription | none | mock STT e2e passes; Soniox adapter implemented per the 2026-11-05 docs, only against a fake server | DONE (Soniox BLOCKED) | `cloud/test/{meetings,stt-soniox}.test.ts`, `log/C13-server.md` |
| C14 | Transcript → Markdown → Runtime | none | Imported successfully with the real CLI (temp root); upstream has no per-entry deletion interface, which the UI states honestly | PARTIAL | `log/C12-C14.md` "Runtime deletion" |
| C15 | Automatic Workflow content | Paste from an external Agent (D37) | See G6 | PARTIAL (code) / acceptance BLOCKED | `log/C15.md` |
| C16 | Performance (B + C, not A) | B count card | See G7 | DONE | `log/C16-C17.md` |
| C17 | Proactive layer extensions (event triggers, thresholds, decision log, shortcuts, tray) | T1–T5 | See G8; the lead changed the event semantics: a shared moment "I proposed" being accepted is published the first time `sync()` sees it | PARTIAL (real OS not verified) | `log/C16-C17.md`, `log/PHASE4-GATE.md` |
| C18 | Shared moments | Literal overlap | See G9; the lead changed third-party accept/decline from 403 → 404 | DONE | `log/C18-C11.md`, `log/C18-C15-server.md`, `log/PHASE4-GATE.md` |
| C19 | Connectors | Local files | See G10 | PARTIAL | `log/C19.md` |
| C20 | Import completeness | Tool calls off by default; dedupe by hash | Tool names / first line of commands / paths kept by default (redacted); front matter `dedupe_key`; **real CLI** importing twice in a row: `{imported:1}` → `{imported:0, unchanged:1}` | DONE | `tests/import/c20-dedupe.test.ts`, `tests/import/real-runtime.test.ts`, `log/C20-C21.md` |
| C21 | Backup | See G11 before | See G11; gating original-id restore on a signed manifest was the lead's decision (S1F-11) | DONE | `log/C20-C21.md` |
| C22 | Upstream deploy / retest | R1–R9 deployed | Approved by the user on 2026-11-06; no new upstream commits; backed up first; 63/63 | DONE | `docs/test-evidence/S1FULL-C22/summary.md` |
| C23 | CAP manual checklist, X3, onboarding library preview, copy | — | Checklist written, **every row is NOT RUN**; X3 still BLOCKED (transport off by default, pinned by a test); onboarding preview reads real counts; W1–W6 copy changes are in the code (`App.tsx:71`, `Settings.tsx:111`, `LocalClaim.tsx`, `peers/api.ts:318`, `PrivacySection.tsx:70`, `Chat.tsx:129`, checked by grep by the author of this document on 2026-11-06) | DONE (the checklist itself) / X3 BLOCKED | `docs/test-evidence/CAP-L2L3-CHECKLIST.md`, `tests/{onboarding/c23-*,het/c23-transport}.test.ts`, `log/C23.md` |

### 1.3 Older items still BLOCKED

| Item | Status |
|---|---|
| CAP L2/L3 (TCC, manual) | BLOCKED (unchanged); Part A of the checklist `CAP-L2L3-CHECKLIST.md` is all NOT RUN |
| HET minutes (X3) | BLOCKED (transport not approved) |
| Signing / notarization / auto-update | BLOCKED (no Developer ID) |

## 2. Gates (final, lead 2026-11-06)

| Item | Result |
|---|---|
| `cd cloud && npm test` | **118 / 118 pass** |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 194 files passed / 4 skipped; **2042 passed / 6 skipped / 0 failed** (final; before that, 193 / 2040 twice in a row). Output: `docs/test-evidence/S1FULL-FINAL/` |
| `npm run build` | OK |
| `E2E_NO_FOCUS=1 npm run e2e` | **37 PASS / 5 SKIP**, including "no non-loopback sockets over 15 s" (cloud off) |
| Real `cloud/` child-process e2e (vitest) | `tests/cloud/e2e-real-server`, `e2e-chat-real-server`, `e2e-subs-real-server`, `e2e-meetings-real-server`, `e2e-moments-real-server`, `tests/workflows/cloud-extract-real-server` (LLM / STT / email all mock / outbox) |
| C22 §15 retest (deployed venv) | **63 / 63 PASS** |

These numbers come from the lead's final run; the author of this document did not re-run them, and the repo has no separate evidence directory for them (the intermediate numbers for each Phase gate are at the end of each `log/*.md`).

Intermediate numbers per Phase gate (from the logs, to show the trend): Phase 1 cloud 61, vitest 1730; Phase 2 cloud 86, vitest 1777; Phase 3 cloud 108, vitest 1832; Phase 4 cloud 118, vitest 1930.

Fixes the lead made at the gates:
1. Small-order Ed25519 public keys could forge signatures (identity point + `R=identity point, S=0` passed 256/256) → rejected by `isWeakPublicKey` (S1F-2, `log/C0-C1.md`).
2. `build/after-pack.cjs` stripped `NSMicrophoneUsageDescription` → the packaged build could not record → removed from the strip list (S1F-6, `log/C12-C14.md`).
3. smtp mode must set `CLOUD_EMAIL_PEPPER` (S1F-4).
4. Weekly letter drafts quoted local memories verbatim (including paths / ids) → added `redactForCloud` (`src/main/cloud/subs.ts:283`).
5. Third-party accept / decline of a shared moment 403 → 404, so existence is not leaked (`log/PHASE4-GATE.md`).
6. The shared-moment accepted event is now published when "a moment I proposed was accepted" (`log/PHASE4-GATE.md`).
7. Root cause of the intermittent `e2e-subs-real-server` failure: the test unfolded headers across the whole email, merging QP soft line breaks and breaking UTF-8 decoding; a test-code-only problem, changed to unfold only the header block, after which it passed 8 times in a row (`log/PHASE4-GATE.md`).
8. Restoring backups under original ids is allowed only for "manifests signed by the user's own identity" (C21 revision, S1F-11).

## 3. Scoring

Weights: each of the 12 acceptance goals has weight 1. Reason: the brief gives no weights; any weighting would require me to judge for the user which goals matter more, and is easy to tune so it "just passes". DONE = 1, PARTIAL = 0.5, BLOCKED = 0.

| # | Goal | Status | Score |
|---|---|---|---|
| G1 | local-only, zero outbound traffic | DONE | 1 |
| G2 | Cloud challenge / verify | DONE | 1 |
| G3 | Chat | PARTIAL | 0.5 |
| G4 | Subscriptions | PARTIAL | 0.5 |
| G5 | Meetings | PARTIAL | 0.5 |
| G6 | Workflow real steps | BLOCKED | 0 |
| G7 | Traceable Performance | DONE | 1 |
| G8 | Notifications can be turned off | PARTIAL | 0.5 |
| G9 | Shared moments are not literal overlap | DONE | 1 |
| G10 | Connector import + delete | PARTIAL | 0.5 |
| G11 | Backups restore cards + history | DONE | 1 |
| G12 | MOD / MEM retests | DONE | 1 |

Calculation: 6 DONE × 1 = 6; 5 PARTIAL × 0.5 = 2.5; 1 BLOCKED × 0 = 0. Total 6 + 2.5 + 0 = **8.5 / 12 = 70.8%** (8.5 ÷ 12 = 0.70833…).

**Lead review**: weights and arithmetic are correct. The only contested item is G6 (Workflow real steps): the extraction mechanism is fully implemented and runs end to end on a real `cloud/` (mock LLM); what is missing is one run with real data + a real LLM (needs an LLM key or Runtime quota). The lead rates it PARTIAL rather than BLOCKED, giving 9 / 12 = **75.0%**. Under either rating the result is **below 90%**; the weights are not adjusted to make the numbers work.

**The brief's 90% target was not met.**

Sensitivity (does not change the conclusion): counting G6 as PARTIAL and G8 as DONE (the most lenient rating I can find that still holds together), the total is 7 + 2.5 = 9.5 / 12 = 79.2%, still below 90%. The gap comes mainly from items that need the user's real accounts / keys / hardware (LLM, SMTP, Soniox, microphone, Notification Center), plus the upstream lacking a per-entry deletion interface.

## 4. What leaves this Mac, how to preview it, how to delete it

Sources: `S1-FULL-ARCH.md` §4 / §8 and the logs. All cloud features are off by default; a feature sends requests only after a server address has been entered in settings, it has been confirmed and turned on, and the user has signed in.

| Data | Feature | Where it goes | How to preview before sending | How to delete | Server retention |
|---|---|---|---|---|---|
| Ed25519 public key + signature | Sign-in | your `cloud/` | After sign-in the cloud panel (`CloudSetup.tsx`, shared by Chat / Subscriptions / Meetings) shows the account fingerprint (= identity fingerprint, `fingerprintShort`), added by the lead at wrap-up | Cloud panel "Delete cloud account…" → `DELETE /v1/account` (renderer `confirm:true` + main-process native confirm), added by the lead at wrap-up, `tests/cloud/cloudsetup-account.test.ts` | for the life of the account |
| Bearer token (server stores only sha256) | All cloud APIs | your `cloud/` | not shown | Sign out / turn off cloud (tries to sign out first) / delete account | 30 d or until sign-out |
| Chat context items + question | Cloud chat | `cloud/` → LLM provider | Before sending, each item's full text to be sent is shown and can be removed | Not stored on the server; local `chat/c-*.json` deleted in Lens | 0 (in request memory only); `chat_usage` holds counts only |
| Session snippets for Workflow extraction | Playbook "Cloud extracted" | `cloud/` → LLM provider | Same per-item preview as Chat | Not stored on the server | 0 |
| Meeting audio chunks (~30 s) | Meetings | `cloud/`; in soniox mode, also Soniox | Before starting, tick that participants have been told + native confirm; a persistent indicator while recording | "Delete" in meeting details (server + local); delete account | Deleted once transcription succeeds, at most 24 h; best-effort deletion on the Soniox side |
| Meeting title + transcript | Meetings | `cloud/` | Results shown locally when they come back | Same as above | Whole record deleted after 7 d |
| Transcript snippets for the meeting summary (optional) | Meetings | `cloud/` → LLM | Ticked item by item | Not stored on the server | 0 |
| Signed weekly letter | Subscriptions | `cloud/` → SMTP → subscribers' mailboxes | The full bytes to be signed are shown before publishing | Cannot be recalled once sent; delete account | Body deleted 30 d after delivery reaches a final state; delivery records 90 d |
| Subscriber email addresses | Subscriptions | Submitted by subscribers themselves to `cloud/` | The publisher sees only masked addresses | Unsubscribe / removed by the publisher / delete account | Only an HMAC kept after unsubscribing |
| Signed personal card | Subscriptions page "publish card" | `cloud/`, retrievable by anyone holding the fingerprint | Readable fields + raw text shown | "Withdraw" `DELETE /v1/cards` | Latest 20 versions |
| Signed shared moments + acceptances | Peers page | `cloud/` (visible to the other party) | Full content shown before proposing / accepting | Deleted for both when either side deletes; the other party's local copy is deleted only after they sync and delete it themselves | Until deleted |
| IMAP sign-in and read-only reads | Connectors (IMAP) | The IMAP host you enter (993, implicit TLS) | Separate consent; fetched emails are previewed before being written | Revoking consent deletes the saved credentials | Does not go through `cloud/` |

**Never leaves the machine** (in any mode): original screenshots, the Runtime `index.db`, the Ed25519 private key, the Runtime token, the Broker token, raw Access log text, anything not previewed. The server is **not end-to-end encrypted**: the operator can technically read Chat (in request memory), transcripts, weekly letters, subscriber email addresses and shared-moment content.

Local deletion still has upstream limits: meeting Markdown written into the Runtime, remember memories written by connectors (default markdown write permission) and timeline documents cannot be deleted per entry, only by the full deletion in "Settings → Privacy" or `persome clean …`; the UI lists what remains.

## 5. Decisions needed from the user

1. **X3 HET transport**: still not approved. Approval needs: a daily call / token budget and behavior on exhaustion; a fixed provider and model (pinned per anchor version, temperature 0); which text leaves the machine, to whom, and the recipient's retention terms (suggested: per-item preview, as in Chat); whether to reuse the cloud `/v1/chat/completions` with `task:"het_assess"` (only if X3 is approved and cloud is on); minutes shown as "Estimate" + anchor version. Until approved, HET and `src/main/cloud` do not import each other, enforced by a test (`tests/het/c23-transport.test.ts`). In the packaged build `LENS_HET_FAKE_ASSESSOR` is ignored at runtime, but the fixture code is still in the bundle.
2. **Upstream per-entry deletion**: the Runtime needs interfaces to "delete a Markdown memory by entry id" and "delete imported timeline documents by source"; otherwise meeting imports, connector memories and imported documents can only be deleted wholesale. Whether to raise this upstream.
3. **OAuth client ID** (Google / Notion / Outlook): none, so those connectors are BLOCKED.
4. **SMTP / DKIM**: real weekly letter delivery needs an SMTP relay, SPF / DKIM / DMARC for the From domain, and a production `CLOUD_EMAIL_PEPPER`.
5. **Soniox key**: real transcription needs `CLOUD_SONIOX_API_KEY`; the adapter has not been run against the real API.
6. **LLM key**: real Chat / Workflow extraction / meeting summaries need `CLOUD_LLM_*`; separately, on the Runtime side, R8 pattern_detector needs Runtime LLM quota to produce the first real structured Workflow.
7. **Developer ID**: signing / notarization / auto-update still BLOCKED.
8. **Leftover temp directories**: `$TMPDIR` holds 136 `lens-upstream-*` directories (about 34 MB in total), from the connectors' real-Runtime tests (`tempRoot` in `tests/connectors/upstream.ts:38` creates them but never deletes them). The lead's cleanup command was blocked by the permission classifier; you need to decide whether to delete them.
9. **C21 new-computer consequence**: the identity private key is not included in backups. When restoring on a new computer (new identity, no retirement record for the old key), every backup counts as "signed by someone else", and Workflows are restored as renumbered `imp-*` copies (full history, but changed ids and provenance `imported`). Only the same identity, or a reset identity on the same store, can restore under the original ids. Whether to accept this, or design private key migration.
10. **Docker / deployment**: `cloud/Dockerfile` not built; TLS, reverse proxy, multi-instance rate limiting and server backup rotation are all deployment items.
11. ~~Entry point for deleting the cloud account~~ **Added (lead, at wrap-up)**: after sign-in the cloud panel has a "Delete cloud account…" button and shows the account fingerprint (`src/renderer/src/components/chat/CloudSetup.tsx`). There is still no separate "Settings → Cloud" page; the cloud panel currently appears only on the Chat / Subscriptions / Meetings pages.
12. **Manual checklist**: Part A (TCC) and Part B (microphone, notifications, Soniox, SMTP, IMAP, LLM, Docker, etc.) of `CAP-L2L3-CHECKLIST.md` need a person to run them.

## 6. Incidents (recorded as they happened)

1. **Phase 1: top-level contents of `$TMPDIR` deleted**. Early test cleanup by the C3-C7 agent recursively deleted `path.dirname(the mkdtemp directory)`, that is, `os.tmpdir()` itself. Around 2026-11-05 21:36 it deleted every deletable top-level item under the user's `$TMPDIR` (about 20 macOS daemon cache directories were emptied) and stopped with EPERM on the directory itself. **Not recoverable**. The repo, `~/.persome` and the Lens Store are not under `$TMPDIR` and were unaffected. Since then every new test's cleanup has a prefix guard and refuses to delete `os.tmpdir()` itself (`log/C3-C7.md` INCIDENT). Whether all daemons have recovered was not checked.
2. **Phase 2: an agent ran `pkill -f "src/server.ts"`**. This kills every process on the machine whose command line matches, not just its own test server (recorded by the lead; the logs have no further detail).
3. **136 `lens-upstream-*` temp directories (about 34 MB)** left in `$TMPDIR`; see §5 item 8.

## Final report

### (1) Status of each Phase

| Phase | Content | Status |
|---|---|---|
| Phase 0 | C0 architecture, C1 `cloud/` sign-in, C2 Lens cloud client | DONE (Docker not built) |
| Phase 1 | C3–C7 Chat (+ C4 server) | DONE, C7 PARTIAL; real LLM not verified |
| Phase 2 | C8 cards, C9 weekly letter server, C10 Subscriptions page | DONE; real SMTP inbox BLOCKED |
| Phase 3 | C12–C14 Meetings (+ C13 server) | PARTIAL: real microphone / Soniox not verified, upstream has no Runtime per-entry deletion interface |
| Phase 4 | C15 Workflow, C16 Performance, C17 proactive layer, C18 shared moments, C11 shared moments in weekly letters | C16 / C18 / C11 DONE; C17 PARTIAL (real OS not verified); C15 code complete, acceptance BLOCKED (no real steps) |
| Phase 5 | C19 connectors, C20 import, C21 backup, C22 deploy retest, C23 checklist / X3 / onboarding / copy | C20 / C21 / C22 DONE; C19 PARTIAL; C23 checklist complete but all NOT RUN, X3 BLOCKED |

Score: **8.5 / 12 = 70.8%, below 90%** (§3).

### (2) End-to-end evidence for cloud Chat / Meetings / Subscriptions

All are vitest e2e tests of the Lens client code against a **real `cloud/` child process**; every third party is mocked:
- Chat: `tests/cloud/e2e-chat-real-server.test.ts` (mock LLM). Asks "what am I working on this week"; the context on the wire is byte-identical to the preview; no token / screenshots / `index.db` / phone numbers; citations map to the sent snapshot; "Remember this" goes through a native confirm to MCP `remember`; server output contains none of the question, context or answer.
- Meetings: `tests/cloud/e2e-meetings-real-server.test.ts` (mock STT). consent / confirm gates, mic gate, 2 chunks → ready, audio deleted on both ends, Markdown import, after deletion the server returns 404 + the local directory is gone + the `runtimeRemains` notice. Separately, a real `persome import-data` (temp root) import succeeded (`log/C12-C14.md` Phase 3 gate).
- Subscriptions: `tests/cloud/e2e-subs-real-server.test.ts` (outbox `.eml` files act as the test inbox). Card / weekly letter signatures verified by both ends, forgeries rejected, double opt-in, delivery, RFC 8058 unsubscribe, suppression, no tracking pixel.

Real LLM, real Soniox, a real SMTP inbox, a real microphone: **none of them have been run**.

### (3) Outbound data and preview / deletion

See §4. Key points: by default nothing leaves the machine (verified by e2e lsof over 15 s); each cloud feature is turned on separately; sent content is previewed item by item or byte for byte before sending; the server is not end-to-end encrypted; some writes inside the Runtime cannot be deleted per entry.

### (4) Test numbers

cloud 118/118; typecheck exit 0; vitest 194 files / 4 skipped, 2042 passed / 6 skipped / 0 failed (final; before that, 193 / 2040 twice in a row); build OK; e2e 37 PASS / 5 SKIP; §15 retest 63/63 (deployed venv). Details in §2.

### (5) Unfinished items and pending decisions

Unfinished: verification in real environments (LLM, Soniox, SMTP, a real IMAP mailbox, microphone, Notification Center / tray / shortcuts, Docker, packaged-build e2e); real Workflow steps; Runtime per-entry deletion; OAuth; CAP L2/L3; signing and notarization; no UI entry point for deleting the cloud account.
Pending decisions: the 12 items in §5 (X3, upstream deletion interface, OAuth, SMTP/DKIM, Soniox key, LLM key, Developer ID, temp directory cleanup, C21 new-computer consequence, deployment, cloud account deletion entry point, manual checklist).


> For what follows Round 4 (2026-11-06), see `GAP-vs-S1-R5.md`.
