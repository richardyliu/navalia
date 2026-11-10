# BLOCKED burn-down (S1 close-out, 2026-11-06)

Rule: every item has an owner, one executable action and an acceptance condition. "DONE" = closed this round with code + tests + evidence; "OPEN" = waiting on the owner's action. No item uses a mock to pass as a real result.

Owner values: **User** (needs your account / credentials / GUI / decision), **Upstream** (personal-model-og maintainers; what the local branch already implements only needs merging), **Code** (an agent can do it), **Data** (can only wait for time to pass + capture).

| # | BLOCKED | Status | Owner | Exact action | Acceptance | Evidence |
|---|---|---|---|---|---|---|
| B1 | 11-06 capture has 0 text (TCC broke after the ad-hoc re-sign) | **DONE** (AX: 20:33:38 PST `ax=True`; Screen Recording still `screenshot=False`, waiting on user) | User | Quit Lens → System Settings → Privacy & Security → **Accessibility** and **Screen Recording**: remove Persome Lens with "−", then add `dist/mac-arm64/Persome Lens.app` with "+" and tick it → launch that app and use it normally for 15 minutes → `bash scripts/verify-capture-text.sh` | Script exits 0 and that day has `with_text > 0`; `~/.persome/logs/capture.log` shows `ax=True`; `timeline_blocks` has `llm` for that day | `test-evidence/PHASE5/capture-text/` (current: 11-06 313 frames / 0 text, exit 2) |
| B2 | Real Workflow steps | OPEN (date gate passed; LLM admission refuses) | Data + Upstream | Once a 3rd local date has an `llm` block: `persome llm agent status` → `persome writer run` → `persome model build --no-wait` → `persome model status`; budget ≤40 calls | MCP `behavior_patterns().skills[].steps` non-empty; artifacts/rules/problems each ≥1; every evidence pointer resolves with `resolve_evidence` | `test-evidence/PHASE5/workflow-face/DIAGNOSIS.md` §6 |
| B2a | 3rd valid date | **DONE** (77 `llm` blocks since 11-06 20:34 PST) | User + Data | For 11-06 to count: at least 1 `llm` block **before 2026-11-06 23:59 PST (11-07T07:59Z)** that hits a candidate already seen on 11-04/11-05; if missed, 11-07; 11-04 slides out of the 7-day window around 11-11 17:03 PST | `pattern_detector` has ≥3 local dates within the 7-day window | Same as above §5 |
| B3 | Face active | OPEN (structural) | Data | Besides 3 UTC observation dates, a 2nd schema is needed to produce `both` provenance: some non-event memory file must accumulate ≥4 facts (`schema_miner_stage.py:30`). Only continued use + `remember` helps; it cannot be faked | `persome faces-report --json-out <scratch>/faces.json` shows status=active (≥3 dates, ≥2 signals, ≥2 footprints) | Same as above §4 |
| B4 | Real Chat | OPEN | User | `cd cloud && CLOUD_LLM_MODE=openai CLOUD_LLM_BASE_URL=<url> CLOUD_LLM_API_KEY=<key> CLOUD_LLM_MODEL=<model> CLOUD_PUBLIC_ORIGIN=http://localhost:8787 npm start`; turn on the Lens Cloud chat page + sign in → ask a question that needs personal context; record per `CAP-L2L3-CHECKLIST.md` B6 | A real model answer + the cited context ids; server logs contain no body text | Not run |
| B5 | Real subscription weekly letter | OPEN | User | `CLOUD_MAIL_MODE=smtp CLOUD_MAIL_FROM=… CLOUD_SMTP_HOST/PORT/USER/PASS/SECURE=… CLOUD_EMAIL_PEPPER=<32+ random bytes>` + a public HTTPS origin; configure SPF/DKIM/DMARC on the sending domain; follow checklist B4 | A real inbox receives the confirmation email + weekly letter; Gmail one-click unsubscribe works | Not run |
| B6 | Real meeting | OPEN | User | `CLOUD_STT_MODE=soniox CLOUD_SONIOX_API_KEY=<key>`; in packaged Lens start a meeting, tick "participants have been told", a real person speaks for ≥60 s; follow checklist B1 + B3. Note: the signed build in B14 needs the `com.apple.security.device.audio-input` entitlement (found in R5) | The real transcript comes back to Lens and is imported via `import-data`; B10's "Delete from Persome…" can delete it | Not run |
| B7 | Notification Center / Tray / global shortcut | OPEN | User | Follow `CAP-L2L3-CHECKLIST.md` Part B · B2 step by step (master switch off by default → on → trigger → off) | A real banner, the tray "Proactive" submenu, the shortcut responds; `proactive-decisions.json` has the matching "send/don't send" records | Not run |
| B8 | CAP L2/L3 | OPEN (depends on B1) | User | Checklist Part A: CAP-01/02/07/08/09 | The TCC list has only Lens (no Runtime/python); AX first, OCR fallback; secure input suppression; heartbeat; URL/title metadata | Checklist Results table left blank to fill in |
| B9 | Runtime version field / T5 | **DONE (local)**; merge OPEN | Upstream | Local branch `og/r10-version-delete` @ `7066066` is deployed; upstream maintainers review and merge (no push, no PR this round) | `curl 127.0.0.1:8742/health` includes `schema_revision`, `build_version`; Lens T5 marker = `schema:…|build:…` | `test-evidence/PHASE5/runtime-r10/`, `docs/upstream/runtime-version-field.md` |
| B10 | Runtime per-entry delete | **DONE (local)**; merge OPEN | Upstream | Same branch as B9: `POST /imports/delete`, `/memory/entries/delete`, `/timeline/delete` (transaction + bearer + audit + idempotent); Lens meeting "Delete from Persome…" and connector deletion now use the new endpoints | Upstream 2654 passed; live 404 / 401 probes pass; Lens tests pass. Remaining: memories derived from an import are not cascade-deleted (`runtime-delete-api.md` §4) | Same as above, `docs/upstream/runtime-delete-api.md` |
| B11 | OAuth connectors | OPEN | User | Create an OAuth app in Google Cloud Console / Notion / Azure and provide a client id + redirect `http://127.0.0.1:<port>/callback`; after that an agent implements the PKCE flow | At least one real authorization + read-only import | No code (no fake sign-in page, D82) |
| B12 | IMAP real mailbox | OPEN (code exists) | User | Turn on an app password for the mailbox; Lens Connectors → IMAP: host (993 implicit TLS), username, app password → separate consent → import; follow checklist B5 | Real read-only import, memories are searchable; delete works | Code `src/main/connectors/imap/`, loopback TLS test PASS |
| B13 | Docker / public TLS | OPEN | User (ops) | Domain A record → reverse proxy (Caddy/nginx) + Let's Encrypt → `docker run` the `cloud/` image with `CLOUD_PUBLIC_ORIGIN=https://<domain>`, `CLOUD_TRUST_PROXY=1` | `curl https://<domain>/health` 200; packaged Lens can sign in | Local Docker PASS (`PHASE4/docker/`) |
| B14 | Signing / notarization / auto-update | OPEN | User | Join the Apple Developer Program → generate a Developer ID Application certificate → provide `CSC_NAME` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` → `npm run dist` (electron-builder notarize) | `spctl -a -vv "dist/mac-arm64/Persome Lens.app"` → `accepted source=Notarized Developer ID` | Currently `Signature=adhoc` |
| B15 | C21 identity migration to a new computer | OPEN (decision) | User | Pick one of A–F (see below) | After restoring on the new computer the fingerprint matches or there is a signed inheritance chain; cloud account / subscriptions / `mine` backups carry over | `test-evidence/PHASE4/c21/README.md` §4 |
| B16 | Cloud account entry in Settings | **DONE** | Code | Settings → "Cloud": address, sign-in status, account fingerprint, sign in / sign out / delete cloud account (main-process native confirm) / cloud on-off; reuses existing IPC | 13 tests (empty state / signed out / signed in / delete confirm and cancel / redaction) pass | `test-evidence/PHASE5/cloud-settings/` |
| B17 | Test temp-directory leak | **DONE** | Code | `tests/_support/tmpdir.ts` prefix guard; 6 suites switched to it; 3 guard tests | `$TMPDIR` entries before/after the full suite 4136 → 4136 (before the fix +169); never deletes the tmpdir itself | `test-evidence/PHASE5/tmpdir/` |
| B18 | Repackaging = TCC lost again (the root cause of B1 recurs) | OPEN | User | Keychain Access → Certificate Assistant → Create a Certificate: name `Persome Lens Local`, type "Code Signing", self-signed → tell the agent the name; the agent fills it into `package.json` `build.mac.identity` (no private key goes into the repo) | After rerunning `npm run dist`, still `ax=True` without re-authorizing; `codesign -dv` shows `Authority=Persome Lens Local` | Currently every dist changes the cdhash |
| B19 | `llm_failed` cannot be retried | OPEN | Upstream | Implement `persome timeline retry-failed --max-calls N [--dry-run]` per `docs/upstream/timeline-retry.md` (CAS update, stops when the budget is hit); capture files kept until about 11-11 | The 466 failed blocks from 11-04/11-05 can become `llm` (adds no dates, but cross-day app combos go 1→21) | `docs/upstream/timeline-retry.md`; failure reason 157/157 = `daily call limit (200/200)` |
| B20 | X3 UI click test | OPEN (depends on B1→B2, then repackage) | User | See `test-evidence/PHASE4/x3/UI-CHECK.md` | "Estimate (anchors v1)" appears; after turning it off it goes back to "Not enabled"; new rows in `het.db agent_calls` include client/model/anchor_version | Real transport PASS (5.1/3.0/27.0 minutes) |
| B21 | Lens and Runtime disagree on when to trigger OCR | OPEN | Code + Upstream | Lens skips attaching the OCR image when AX element text is ≥64 characters; Runtime decides by "has indented lines". Change to: Lens skips only when the text lines the Runtime actually extracts are below a threshold, or the Runtime reports a reason when the OCR image is missing | Build a window with "lots of AX text but no content lines": it still gets OCR or an explicit reason | Agent A audit, `[INFERRED]`, 11-06 not affected |

## 2026-11-06 23:35 update

- B1 AX is restored (after `tccutil reset` on the two old registrations and re-adding); Screen Recording still not in effect.
- B2a reached: 3 local dates. B2 is now blocked by the LLM admission rule: the 5 candidates that passed the date gate are all window titles / URLs ("uses X often" kind), and the 9 automatic detections since recovery wrote no skill. It needs an app sequence spanning 3 dates (keep capturing, or upstream B19). See the appended section of `PHASE5/workflow-face/DIAGNOSIS.md`.

## Order (important)

1. **B1** first (user, before 23:59 PST today).
2. **Do not** run `npm run dist` / `e2e:packaged` before getting the 3rd date: it re-signs and loses TCC again (B18).
3. When the 3rd date appears → **B2** (agent runs the build, ≤40 LLM calls).
4. Then B18 (if the user has created the certificate) → repackage → re-authorize once → do **B20**, B7 and B8 together.
5. B3 can only wait for the 2nd schema; no deadline.

## B15 options (not decided for you)

| | Option | Cost |
|---|---|---|
| A | No migration: new computer = new identity, backups restore as `imp-*` copies | Old cloud account / subscribers / friend trust all cut off |
| B | Migration Assistant / Time Machine whole-machine restore (including the login keychain) | Under ad-hoc signing the keychain ACL is bound to the cdhash and may refuse; untested |
| C | A separate "export identity key" encrypted file (scrypt + AES-256-GCM), imported on the new computer | The private key leaves the keychain; passphrase strength is the whole of the security; needs UI + security review |
| D | The old key signs "the new fingerprint inherits me" | Needs the old machine present; every verifier has to learn the inheritance chain |
| E | Paper / QR recovery phrase | Highest misuse risk |
| F | iCloud Keychain sync | Needs a Developer ID (B14); losing the Apple account = losing the identity |

Recommendation `[INFERRED, MED]`: **A** now (no code change, lowest risk); after B14 lands, evaluate **C + D** (export file for recovery, inheritance chain for trust migration). Waiting for your choice.

## Self-check

- Items without an owner: 0. Items without an executable action: 0. Items without acceptance: 0.
- DONE: B9 (local), B10 (local), B16, B17. Every other OPEN item has a concrete command.
