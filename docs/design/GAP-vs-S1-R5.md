# GAP vs S1-R5 (Round 4: X3 + real acceptance)

Date: 2026-11-06. Approval boundary: `DECISIONS-ROUND4.md`. Evidence root: `docs/test-evidence/PHASE4/`.

## 1. Summary table

| ID | Item | before (S1-FULL) | after (Round 4) | Status | Evidence |
|---|---|---|---|---|---|
| X3-01..03 | HET real transport + gate + UI | No transport, 0 minutes | `agentFundingTransport.ts` (Runtime python → `agent_cli.complete`); off by default; budget probe; AssessorPanel; het.db v2 records client/model/anchor_version | DONE | `HET-X3.md`, `tests/het/agentFundingTransport.test.ts` (27) |
| X3-04 | Real estimated minutes | None | 3 real calls on a copy of the real het.db → 5.1 / 3.0 / 27.0 minutes (estimates, anchor v1, claude-code); 0 calls after turning the toggle off | PASS (packaged build rebuilt; UI click awaits the user) | `PHASE4/x3/` |
| S1-R5-01 | First real structured Workflow | skills=0 | Ran one real `persome model build` (1 LLM call); skills still 0. Root cause: the usable timeline blocks in the 7-day window cover only 2 dates (11-04/05 mostly `llm_failed`, when the 200/200 quota was exhausted; 11-06 all `metadata_only`), so they cannot pass the ≥3-date threshold. Cloud extraction fallback: no `CLOUD_LLM_*` | **BLOCKED (insufficient data)** | `PHASE4/workflow/` |
| S1-R5-02 | Real Face / 3 days | faces=0 | 1 shadow candidate: observed once, 1 date (11-06); 4 of the 5 promotion criteria are not met. Lens's "Stable habit / Observing / Dates unknown" label logic is covered by code and tests | **Insufficient data** | `PHASE4/face/` |
| S1-R5-03 | Evidence chain gaps | 45/49 Points, 107/187 Lines | Recounted from `/model/graph`: Points 88/96 and Lines 110/110 have sources; `remember` Points now show "Source = this memory"; the remaining 4 Points and 138 shadow edges are recorded as a limitation (not fabricated) | PASS | `PHASE4/evidence-chain/`, `tests/evidence/r5-remember-self-source.test.ts` |
| S1-R5-04 | Real Chat | mock | No `CLOUD_LLM_*`; the packaged build only accepts `https://` cloud addresses | BLOCKED | `PHASE4/cloud/` |
| S1-R5-05 | Real subscription / SMTP | mock | No SMTP relay / DKIM / `CLOUD_EMAIL_PEPPER` | BLOCKED | `PHASE4/cloud/` |
| S1-R5-06 | Real meetings | fake STT | No `CLOUD_SONIOX_API_KEY`, and nobody at the microphone; the signed build is also missing the `com.apple.security.device.audio-input` entitlement | BLOCKED | `PHASE4/cloud/`, `PHASE4/packaging/` |
| S1-R5-07 | Notification Center / Tray / shortcuts / CAP TCC | Not verified | Needs a person operating the GUI; a manual checklist has been written; TCC.db cannot be read without Full Disk Access. T5: `/status.version` is the package version 0.3.2 and does not change across deploys → upstream note | BLOCKED (T5 = upstream FAIL) | `PHASE4/os-cap/`, `docs/upstream/runtime-version-field.md` |
| P4 | Runtime per-entry deletion | No API | Upstream proposal: `POST /imports/delete`, `/memory/entries/delete`, `/timeline/delete` | Upstream BLOCKED | `docs/upstream/runtime-delete-api.md` |
| P4 | OAuth (Google/Notion/Outlook) | None | No client id, and not approved; the UI states in four places that OAuth is not supported | BLOCKED | `PHASE4/connectors/` |
| P4 | IMAP real mailbox | Not verified | The code only has `tls.connect` (993, TLS1.2+, certificate verification, no STARTTLS / plaintext path); 22/22 tests pass; no real mailbox credentials | Code PASS / real BLOCKED | `PHASE4/connectors/` |
| P4 | Docker / TLS | Not built | Image build passes; local container `/health` 200; login → chat (mock) → delete account round trip passes; container cleaned up. TLS / reverse proxy / multi-process rate limiting / backups are ops responsibilities | Docker PASS / deploy BLOCKED | `PHASE4/docker/` |
| P4 | Packaging / signing / notarization / updates | Not checked | Static checks pass (microphone usage, native outside the asar, fuses consistent). Currently ad hoc signed, rejected by `spctl`. No Developer ID | Signing BLOCKED | `PHASE4/packaging/` |
| P4 | `e2e:packaged` | — | Repackaged after user consent (ad hoc, unsigned): **30 PASS / 0 FAIL / 1 SKIP**. The old assertion "Info.plist must not contain NSMicrophoneUsageDescription" was outdated (S1-FULL approved meeting recording); it now reads "must be present, and the copy must be limited to meeting recording". The new app has been launched, het.db migrated to v2, assessor off by default | PASS | `PHASE4/packaging/e2e-packaged.log` |
| P4 | C21 new computer | Undecided | Private keys are not in backups (48/48); restoring under a new identity only yields `imp-*`; migration options A–F pending; the old cloud account is bound to the old key | Tests PASS / decision pending | `PHASE4/c21/` |
| P4 | Cleanup | 136 (actually 13) | Deleted 39 `lens-upstream-*` (more were created while tests ran), using a prefix + parent-directory guard. About 3000 other `lens-*` test leftovers were left alone | PASS | `PHASE4/cleanup/` |
| P4 | Docs | ARCH 403 outdated | ARCH is actually already at 404; the statement in GAP has been corrected. The entry point for deleting the cloud account is only on the Chat page; Settings suggestions are in the notes | PASS | `PHASE4/settings-cloud-account.md` |

## 2. Verification

- `npm run typecheck`: exit 0
- `npx vitest run`: 196 files passed / 5 skipped; **2072 passed / 7 skipped / 0 failed** (baseline 2042/7)
- `npm run build`: exit 0
- `npm run e2e`: **41 PASS / 1 SKIP**
- `cd cloud && npm test`: 118/118
- LLM usage (Runtime usage ledger): Phase 2 used 1 call; X3 used 3 calls; the daemon itself used about 1 in the meantime. Usage went from 7 to 12.

## 3. Pending user decisions

1. ~~Repackage~~ (done). Remaining: actually click "Allow assessment" on the HET page as a UI test; the new bundle may need Screen Recording / Accessibility re-authorized.
2. ~~daily_call_limit~~: the user confirmed 20000 is in effect (R4-1a).
3. C21 key migration options A–F.
4. Whether to submit `runtime-version-field.md` / `runtime-delete-api.md` upstream.
5. Provide `CLOUD_LLM_*` / SMTP+DKIM / Soniox key and a public TLS domain for real cloud acceptance.
6. Whether to fix the test temp directory leak (`tests/connectors/upstream.ts` and `tests/peers/fixtures.ts` do no cleanup).
7. Workflow / Face: needs valid captures with text on ≥3 dates. This requires that daily_call_limit no longer runs out early, and that `metadata_only` captures like those on 11-06 carry text.
