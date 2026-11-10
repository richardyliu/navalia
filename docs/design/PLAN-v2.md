# Navalia v2.1 — Implementation Plan Close to the Original

> Companion design: [`DESIGN.md`](DESIGN.md)
> Goal: rebuild Lens following the original's **mechanisms** (the shell owns capture, automatic HET, Card / Connections / Access log), not just add a few pages.
> Execution principle: **first get the first version's mechanism loop running efficiently, then debug and optimize item by item against the reference's failures.** This document only covers order and exit conditions.

---

## 0. First-version success criteria

| Dimension | Criterion |
|---|---|
| Capture ownership | TCC shows only one Lens row; Runtime runs with `capture.source="ingest"`; the daemon does not start the AX watcher |
| Capture quality | 100 switches to an excluded App produce 0 frames; pausing until 00:00 the next day produces 0 frames; continuous typing does not produce one frame per keystroke |
| Identity | Card is verifiable offline; Connections are full access; Access log has records; revoking an extension grant returns 403 |
| Broker | 5 tools usable; every call can be found in the Access log; out-of-scope access is audited |
| HET | The automatic pipeline produces tasks; assessor and anchors are separate; weekly report total = sum of entries |
| Privacy | No outbound network requests; private keys/tokens never reach the renderer or logs |
| Engineering | typecheck/build/dist pass; critical paths have unit + contract + E2E tests |

---

## 1. Constraints

- Runtime stays Apache-2.0; **no patch for capture**, capture is owned by Lens.
- Do not copy the product's private code; only reimplement concepts from public behavior and docstrings.
- No cloud, login or public sharing.
- HET is an estimate and must be explainable; automatic judgment, manual override.
- No regression of existing v1 features.
- Progress is not measured by time; done means "mechanism runs + comparison tests pass".

---

## 2. Workstreams and dependencies

```
E1 Lens Capture (native addon + ingest) ─┐
E2 Identity / Card / Broker ─────────────┼─► First version (P0)
E3 HET automatic pipeline ───────────────┘
E4 Experience (Nebula / Rewind / Playbook) ─► Second version (P1)
E5 Hardening ────────────────────────────► Done alongside the first version, continuously extended
```

Dependencies:

- E1's ingest + permissions come before any real data;
- E2's key/Card come before the Broker;
- E3's agent log adapter can run in parallel with E2;
- E4 depends on E1's frames and E2's Card;
- E5 is not done all at once at the end: as each surface is finished, add its tests/packaging.

---

## 3. E1 — Lens Capture (P0)

Goal: reimplement the original shell's capture mechanism inside Lens; Runtime is only responsible for ingest and modeling.

| # | Task | Output | Depends on |
|---|---|---|---|
| E1.1 | N-API addon scaffold (ObjC++, build script) | `persome-lens-native.node` | — |
| E1.2 | AX tree, byte-compatible with Runtime `mac-ax-helper` | `axTree()` + fixtures | E1.1 |
| E1.3 | Permission probing (AX / ScreenCaptureKit) | `permissions()` + TCC flow | E1.1 |
| E1.4 | Screenshots (ScreenCaptureKit/CGWindowList) | `screenshot()` JPEG | E1.3 |
| E1.5 | Coordinator: debounce / min gap / dedup / heartbeat / lock | Same semantics as the original | E1.2 |
| E1.6 | Exclusion picker + pause (including pause until 00:00 the next day) | UI + state | E1.5 |
| E1.7 | Ingest client: serial, 200 tri-state, 5xx retry, 12MiB | `ingest-client.ts` | E1.5 |
| E1.8 | Capture page: status, permissions, recent frames, per-App aggregation, settings | UI | E1.6 |
| E1.9 | Tests: exclusion 0 frames, pause, dedup, ingest tri-state | Tests | All |

Key points:

- Runtime `config.toml` sets `[capture] source="ingest"`; Lens does not run the daemon's watcher.
- Screenshot plaintext stays in memory only; after ingest, Runtime encrypts it to disk.
- During prototyping, the OSS `mac-ax-helper` may be used temporarily; the first release must switch to the addon.
- Build the "minimal working path" first, then fill in the full settings/preview UI.

Acceptance:

- TCC has only Lens; exclusion/pause/dedup match the original;
- Failed ingest can be retried without losing frames;
- No disk bloat from one frame per keystroke.

---

## 4. E2 — Identity / Card / Broker (P0)

| # | Task | Output | Depends on |
|---|---|---|---|
| E2.1 | Lens Store + safeStorage key manager | `identity/`, `settings.json` | — |
| E2.2 | Card schema + Ed25519 + RFC 8785 canonical | `card.ts`, `verify` | E2.1 |
| E2.3 | Card builder (full access; extension scopes optional) + front/back/Mini Map | UI | E2.2 |
| E2.4 | Grant store + token hashing + TTL/reads/revoke | `grants.json` | E2.1 |
| E2.5 | Broker MCP (SDK, 127.0.0.1:8750) + 5 tools + scope filter + audit | `broker.ts` | E2.3/E2.4 |
| E2.6 | Connections UI: choose Agent, full access, copy MCP JSON | UI | E2.5 |
| E2.7 | Access log: read records, 30-day stacked chart, clear; revoke/renew as an extension | UI + `audit.db` | E2.5 |
| E2.8 | Swipe: PNG + `.persomecard` + QR code | UI/export | E2.3 |
| E2.9 | Security tests: full access boundary, evidence denial, revocation, token leakage | Tests | All |

Key points:

- **The original's Connections are per-agent full access + Access log**; per-scope was not observed. The first version implements full access.
- If scopes are added, they must be labeled as a Lens extension, never described as "original behavior".
- The original term is **Access log**; `Agent Report` is just an old name.
- Scope naming (extension): `card:read`, `identity:read`, `now:read`, `rewind:read`, `evidence:read`, `reports:read`, `model:search`, `model:ask`, `model:jot`, `model:correct`, `connectors:read`, `connectors:connect`.

Acceptance:

- Card is verifiable offline;
- Connections can connect/disconnect;
- Access log records reads (including empty results); clearing it does not affect connections;
- Without `evidence:read`, quotes cannot be retrieved (extension);
- Revoking an extension grant returns 403.

---

## 5. E3 — HET automatic pipeline (P0)

| # | Task | Output | Depends on |
|---|---|---|---|
| E3.1 | Agent log adapters: Claude Code / Codex | `adapters/` + read-only parsing | — |
| E3.2 | Session watcher + segmenter (timeline + transcript) | `segmenter.ts` + unit tests | E3.1 |
| E3.3 | Assessor (bounded LLM) + Anchors (deterministic minutes) | `assessor.ts` / `anchors.ts` | E3.2 |
| E3.4 | Ledger + tick (segment→assess→promote) | `het.db` + timer | E3.3 |
| E3.5 | HET Dashboard: today/week/month, tasks, override | UI | E3.4 |
| E3.6 | Weekly Review (local, replaces email) | Markdown/HTML export | E3.5 |
| E3.7 | Calibration tests: 20 samples, manually checked | Tests + tuning | All |

Acceptance:

- Tasks are produced automatically; the assessor does not output minutes directly;
- Every task has evidence or `needs_assessment`;
- Weekly report total = sum of entries;
- After a user override, totals are recomputed and an audit record is kept;
- Correction actions are `accepted` / `rejected` / `not_agent`.

---

## 6. E4 — Experience (P1, after the first version runs)

| # | Task |
|---|---|
| E4.1 | Living Model nebula (Canvas/WebGL, 1000 Points <1s) |
| E4.2 | Rewind (screenshot decryption + timeline; needs a Runtime read endpoint) |
| E4.3 | Card flip animation / Mini Map polish |
| E4.4 | Playbook: `behavior_patterns` + `case_extractor` + export |
| E4.5 | Weekly Review visuals and sharing |
| E4.6 | Integration tests |

---

## 7. E5 — Hardening (done alongside the first version, continuously extended)

| # | Task |
|---|---|
| E5.1 | Contract tests + fixtures (Card/Broker/HET/Coordinator) |
| E5.2 | Playwright E2E: exclusion, pause, Card verification, revocation, HET |
| E5.3 | Icon, DMG, notarization, README |
| E5.4 | Demo data + demo script |

---

## 8. First-version execution order (mechanism first)

| Order | What to do | Exit condition |
|---|---|---|
| 1 | E1.1–E1.5: addon + AX + permissions + screenshots + coordinator | Frames are produced reliably and can be ingested |
| 2 | E1.6–E1.9: exclusion/pause/ingest/UI/tests | Exclusion 0 frames, pause 0 frames, no lost frames |
| 3 | E2.1–E2.3: key + Card + Card UI | Card can be signed/verified |
| 4 | E2.4–E2.6: Grant + Broker + Connections | An Agent can read the Card through the Broker |
| 5 | E2.7–E2.9: Access log + Swipe + security tests | Reads are recorded; revocation takes effect |
| 6 | E3.1–E3.4: adapters + segmenter + assessor/anchors + ledger | Tasks are produced automatically |
| 7 | E3.5–E3.7: Dashboard + Weekly Review + calibration | Tasks can be viewed, corrected and exported |
| 8 | Integration + E2E + DMG | The full chain runs; key tests pass |

Principles:

- After each order item is finished, run the real chain once; do not wait to "write everything, then integrate";
- The first version does not chase E4; E4 is added item by item after the first version is stable;
- Add tests/docs as each item is finished; do not pile tests up at the end;
- When a blocker appears, record it first; do not silently degrade.

---

## 9. Test matrix

| Layer | Content |
|---|---|
| Unit | AX fixture byte compatibility, coordinator dedup, ingest tri-state, canonical JSON, Ed25519, token hashing, scope filter, HET formula |
| Contract | Card schema, Broker 5 tools, Runtime ingest contract, HET ledger |
| Integration | exclusion → 0 frames; pause → 0 frames; Card → verify; grant → revoke → 403 |
| E2E | Complete capture, Card, Connections, HET, Weekly Review without network |
| Security | No token/private key leakage; full access boundary; out-of-scope 403 + audit |

---

## 10. Decision record

| # | Decision | Alternative | Reason |
|---|---|---|---|
| D1 | Lens owns capture (native addon + ingest) | patch Runtime | Matches the original; one TCC row; exclusion/pause/dedup inside the shell |
| D2 | HET automatic pipeline | Manual confirmation | The original `het/` is automatic; manual is only for override |
| D3 | Full access + Access log first; scopes as an extension | Per-scope directly | The original is currently full access; no evidence for scopes |
| D4 | Card UI aligned with the original + signed export extension | Signed JSON only | The original Card is an identity object |
| D5 | Weekly Review is local | Email | No cloud; explicit deviation |
| D6 | Do not copy private modules | Port directly | Legal and maintenance risk; only reimplement concepts |

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| High native addon complexity | High | Do the AX fixture and minimal path first; allow helper fallback during prototyping |
| TCC permission behavior changes | High | Probe on every launch; clear guidance; keep helper fallback |
| Inaccurate HET automatic judgment | Medium | Separate assessor and anchors; manual override; only show items with evidence |
| Scope leakage | High | Clear default full access boundary; contract tests; audit |
| Rewind decryption permissions | Medium | Negotiate a read endpoint with Runtime; otherwise defer to P1 |
| Private key loss | Medium | Encrypted backup/import |
| Insufficient quota | Low | HET/capture/Card/Broker do not depend on the LLM; the assessor can queue |

---

## 12. Five things to start right away

1. Create the `persome-lens-native` addon scaffold that outputs minimal JSON from `axTree()`;
2. Use the JSON from the OSS `mac-ax-helper` as a byte-level fixture for comparison;
3. Implement the coordinator + ingest client and switch Runtime to `source="ingest"`;
4. Implement Lens Store + Card schema + Ed25519 signing/verification;
5. Write a spike of the Claude Code / Codex transcript adapter to confirm the HET input is usable.

After these 5, the capture and identity mechanisms are isomorphic to the original; then hook up the Broker and HET, and finally debug and optimize item by item.

---

## 13. Out of scope

- Cloud accounts, cloud sync, social friends, email, meeting transcription;
- Public Card links;
- Teams/enterprise;
- Directly copying the product's private runtime code.
