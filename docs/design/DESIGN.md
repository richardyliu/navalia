# Navalia v2.1 — design document close to the original

> Version: v2.1 Draft (fidelity-first)
> Date: 2026-11-04
> Goal: make Lens's **design ideas, mechanisms and data flow** as close to the original as possible, rather than building a viewer that only "looks like" it.
> Baseline: the v1 viewer is implemented, see `DESIGN-v1-archive.md`; the v2.0 first draft is superseded by this version.

---

## 0. Mechanism comparison with the original (admitting the differences first)

### 0.1 Parts that are fully identical

| Mechanism | Original | Lens v2.1 |
|---|---|---|
| Evidence gating | Model outputs a quote, code looks up the receipt | Reuses the Runtime; UI shows sources/context separately |
| Model levels | Point / Line / Face / Volume / Root | Reuses the Runtime |
| Local-first | Raw data local, pausable, deletable | Reused |
| Agent-neutral | MCP | Reused |
| Correctable | supersede + correction | Reused |
| Identity | Personal Card / Swipe / Access log | Same UI semantics |
| Performance | HET (Human Equivalent Time) | Same definitions and ledger |

### 0.2 Parts where the first draft deviated and this version corrects

| Mechanism | Original approach | First draft | v2.1 correction |
|---|---|---|---|
| **Capture ownership** | **The Electron shell owns OS capture and TCC**; the Runtime uses `capture.source="ingest"` and holds no permissions | Patch the Runtime so the daemon captures | **Lens owns capture instead**, with its own native addon + ingest client; the Runtime no longer captures |
| Exclude by app | The shell's `excluded-app-picker`, dropped before capture | Runtime patch | The Lens capture coordinator drops directly |
| Pause | The shell's `capture-pause` (can pause until 00:00 the next day) | `persome pause` CLI | Lens manages pause state itself |
| HET | **Automatic**: agent logs → segmenter → assessor → anchors → tick | Manual confirmation + strong evidence | Switch to the automatic pipeline; manual only for overrides |
| Authorization | The product today is per-agent **full access** + Access log; no per-scope observed | Invented `profile.read` and similar | Implement full access + Access log first; scopes as a Lens extension, clearly labelled as not original |
| Card | Personal Card + Swipe + Connections | Invented signed JSON | Align UI semantics; signed export as an extension |
| Weekly report | check-ins + email | None | Replaced by a local Weekly Review (explicit deviation) |

### 0.3 Differences that still exist (listed honestly)

| Difference | Reason | Handling |
|---|---|---|
| Runtime private model modules (Minute Archive / ledger / graph induction / world / funnel) | Only in the product's private branch, 62k lines | v2.0 uses the OSS model; v2.1 reimplements `world`/person lineage; archive/ledger deferred |
| Chat / meetings / friends / email | Depend on the official cloud + Soniox | Not built; local replacements in §10 |
| Public Card sharing | Needs cloud and compliance | Only local `.persomecard` + PNG |
| Mobile | The product has no official release either | Not built |

---

## 1. North star

Definition from the interview:

> "A neutral, third-party, open-source Personal Context Layer that provides **capture, modeling, visualization** of traceable, correctable, self-controlled personal context, plus **output services** built on that personal context."

Four principles: Local-first, Evidence-first, User-owned, Agent-neutral.

Five planes:

| Original service | v2.1 plane |
|---|---|
| Capture | **Capture Plane (owned by Lens)** |
| Modeling | Context Plane (Runtime, ingest mode) |
| Visualization | Experience Plane (Living Model / Rewind / Card) |
| Output | **Identity & Authorization Plane** (Card / Swipe / Connections / Access log / Broker) |
| Performance | **Performance Plane** (HET) |

---

## 2. Overall architecture: the shell owns capture, the Runtime only models

This is exactly the original's core architecture, and the biggest correction in v2.1.

```
┌──────────────────────────── Persome Lens (owner shell) ───────────────────────┐
│                                                                               │
│  Capture Plane        native addon (AX/screenshot/TCC) · coordinator          │
│                       exclusions · pause · ingest client                      │
│  Identity Plane       Personal Card · Swipe · Connections · Access log     │
│                       Broker MCP :8750 (scoped)                               │
│  Performance Plane    HET: agent-log adapters · segmenter · assessor · tick   │
│  Experience Plane     Living Model · Rewind · Evidence · Search · Playbook    │
│                                                                               │
│  Lens Store  ~/Library/Application Support/Persome Lens/                      │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ POST /captures/ingest (frames)                 │ scoped MCP :8750
                │ owner MCP :8742 / REST                         │
        ┌───────▼─────────┐                            ┌────────▼─────────┐
        │ Persome Runtime │◄──── Broker proxies ───────│ Trusted Agents   │
        │ ingest + model  │      and filters           │ Claude · Codex … │
        └───────┬─────────┘                            └──────────────────┘
                │
        ┌───────▼─────────┐
        │ ~/.persome      │
        └─────────────────┘
```

Key points:

- **TCC belongs to Lens**: the native addon runs in the Electron main process, so System Settings shows only one Lens row.
- The Runtime is configured with `capture.source = "ingest"`; it starts no AX watcher and requests no permissions.
- The Runtime is still the single source of truth for model/evidence/retrieval; Lens never writes `index.db` directly.
- Third-party agents connect only to the Lens Broker (8750), never directly to the Runtime (8742).

### 2.1 Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Capture | **Lens-owned + ingest** | Same as the original; a single TCC row; exclusion/pause/dedup all in the shell |
| Runtime patch | **Not needed** (for capture); range deletion may get a minimal patch later | Capture no longer depends on the Runtime |
| HET | Automatic pipeline on the Lens side | The original `het/` is a private module; reimplement the same logic |
| Scope | Original naming | See §4.2 |
| Card | UI aligned with the original + Ed25519 export extension | The original Card is an identity object; signing is a local, portable enhancement |
| Weekly report | Local Weekly Review | Replaces cloud email; explicit deviation |

---

## 3. Capture Plane (owned by Lens)

### 3.1 Native addon

`persome-lens-native.node` (N-API, ObjC++), running in the Electron main process:

| Capability | Description |
|---|---|
| `axTree()` | Outputs JSON **byte-compatible** with the Runtime's `mac-ax-helper` (apps → windows → elements; including bundle_id, window title, focused role/value, subrole) |
| `frontmost()` | Frontmost app/window metadata |
| `screenshot()` | ScreenCaptureKit / CGWindowList, returns JPEG bytes |
| `permissions()` | `AXIsProcessTrusted`, `SCShareableContent` (real probes, registering Lens) |
| `urlHandlers()` | Current Safari/Chrome URL (when AX can't provide it) |

Why an addon rather than a Swift helper: TCC grants permission to **the process that makes the call**; a separate helper would become a second TCC subject, which is exactly what the original avoids.

> During prototyping, the OSS `mac-ax-helper` may be called temporarily to get ingest working, but the v2.0 release must switch to the addon.

### 3.2 Coordinator (same semantics as the original)

Moved from the Runtime daemon to Lens:

- `debounceMs=3000`, urgent events 500ms;
- `minCaptureGapSeconds=2`;
- `dedupIntervalSeconds=1`, `sameWindowDedupSeconds=5`;
- `heartbeatMinutes=10`;
- `pauseOnLock=true`;
- Activation/Focus merge rules for the same surface match the Runtime.

### 3.3 Exclusion and pause

- Exclusion: bundle id + app name, two lists; checked before capture, so **no frame is produced and ingest is not called**.
- App picker: `NSOpenPanel` to choose a `.app`, reading `CFBundleIdentifier` from `Info.plist` (same logic as the original `excluded-app-picker`).
- Pause: pause now / pause until 00:00 the next day; state written to `settings.json`, kept across restarts.
- Permissions: the Screen Recording probe must wait for explicit user consent (otherwise it registers TCC early); Accessibility can be probed freely.

### 3.4 Ingest client

`POST http://127.0.0.1:8742/captures/ingest`, Bearer token:

- body ≤ 12 MiB;
- sent **serially** (Runtime global lock, 503 above 16 concurrent);
- a 200 has three outcomes: written / deduped / skipped (paused/locked), each handled separately;
- 5xx retried at 250 / 1000 / 3000ms; 4xx not retried;
- failed frames go into a bounded retry queue and never block capture.

### 3.5 Screenshots and retention

- Screenshots are sent to the Runtime with the frame, and the Runtime encrypts them to disk with `PERSOME_SCREENSHOT_KEY` AES-256-GCM;
- Lens never persists plaintext screenshots (kept in memory only until ingest completes);
- Retention, screenshot stripping and the OCR switch are still controlled by the Runtime `[capture]` config; Lens only writes the config + restarts.

### 3.6 Deletion

- v2.0: Lens deletes the frames in the matching range from its own `capture-buffer`, then calls `persome rebuild-captures-index`;
- Explicit notice: **derived memory/Points are not deleted automatically**;
- v2.1: if precise index cleanup is needed, submit a minimal Runtime patch (`clean captures --since/--until`).

### 3.7 Acceptance

- With 1Password excluded, 100 frontmost switches produce 0 frames and 0 ingests;
- 0 frames after pausing until 00:00 the next day;
- Continuous typing does not produce one frame per keystroke (coordinator in effect);
- The TCC list shows only one Lens row (or clearly labels the prototype helper).

---

## 4. Identity & Authorization Plane

### 4.1 Original semantics

- **Personal Card**: an identity summary on the front, a Mini Map on the back; can be flipped.
- **Swipe Your Card**: slices the Card's authorization out to an AI.
- **Connections**: manages connected agents (the original string is Connections).
- **Access log**: records how AI read the context (the original string is Access log).

Lens keeps these four names and interactions and invents no new concepts. "Agent Report" is only an old name for the Access log; ship it as **Access log**.

### 4.2 Access (original: full access; scopes are a Lens extension)

> **Original fact**: the original Connections have only `full access` + Access log, with no per-scope choice. The table below is a Lens **extension**, modelled on the Card shell from the same product family, not original behaviour; the implementation must label it.

| scope (Lens extension) | Allows reading | Default |
|---|---|---|
| `card:read` | Card summary | ✅ Public |
| `identity:read` | Identity and Root | ✅ Public |
| `now:read` | Current context | Granted |
| `rewind:read` | Screenshot history | Granted |
| `evidence:read` | receipts + raw text | High sensitivity, denied by default |
| `reports:read` | AI usage receipts | Granted |
| `model:search` | Retrieval | Granted |
| `model:ask` | Question-style reads | Granted |
| `model:jot` | Write short memories | Granted |
| `model:correct` | Corrections | High sensitivity |
| `connectors:read` | Connector data | Granted |
| `connectors:connect` | Create connections | High sensitivity |

`PUBLIC_SCOPES = ["card:read", "identity:read"]`, matching the original public card.

### 4.3 Card

- UI: Personal Card front/back, flip, Mini Map; data from `/model/graph` + `/model/share-card`.
- **Local portable extension**: generates a `.persomecard` (Ed25519-signed, RFC 8785 canonical JSON) for offline sharing/import verification.
- The Card carries no quotes by default; only an authorization slice with `evidence:read` includes receipts.
- Private key encrypted with `safeStorage`, 0600; the public key is in the Card, so verifiers don't need Lens.

### 4.4 Broker (local enforcement point for Connections, Lens extension)

The Runtime MCP (8742) is owner-only and unrestricted; third-party agents always connect to the Lens Broker (8750):

> 2026-11-04 update (user decision, DEVIATIONS D19): the Broker is **full access** and exposes 26 tools (29 since DEPLOY-05 on 2026-11-05: 22 OSS + 3 Rewind + 4 Lens extensions); the table below is the mapping under the scope extension (full access is not restricted by scope). Authoritative source: `TOOL_CATALOG` in `src/main/broker/catalog.ts`.

| Tool | scope (extension) |
|---|---|
| Read-only retrieval tools among the 22 OSS tools (`search`, `search_captures`, `verify_fact`, `behavior_patterns`, `entity_graph`, `get_model_snapshot`, `list_memories`, `read_memory`, `related_events`, `get_schema`, `query_health_metrics`, `get_pending_model_work`) | `model:search` |
| `current_context`, `recent_activity`, `attention_trajectory`, `read_recent_capture` | `now:read` |
| `resolve_evidence`, `read_receipt` | `evidence:read` |
| `remember` | `model:jot` |
| `correct_memory` | `model:correct` (uses the LLM; refused when budget is exhausted) |
| `process_pending_model_work` | `model:ask` (uses the LLM; refused when budget is exhausted) |
| `search_rewind`, `rewind_frames`, `view_rewind_screenshot` (shapes defined by Lens) | `rewind:read` |
| `owner_aliases` (OSS, added in Runtime schema 2026-11-05.3, read-only) | `model:search` (the public scope `identity:read` is not accepted: the list includes pending / rejected names that may belong to someone else); without `evidence:read`, only fixed fields are kept (alias, alias_key, status, confidence, evidence_count, first/last_seen_at, activated_at, decision_source) and `evidence[]` is emptied (extension) |
| `card_get` (Lens extension) | `card:read` + `identity:read` |
| `usage_report` (Lens extension) | `reports:read` |

- Auth: `Authorization: Bearer <grant token>`; only the token's SHA-256 is stored;
- Filtering: fields trimmed by scope + PII scrubbing;
- Audit: `audit.db` records every call (grant, tool, args hash, returned ids, result), shown in the Access log;
- Revocation/expiry takes effect immediately.

### 4.5 Swipe

- Choose a scope slice → generate a Card (visual + `.persomecard`);
- The QR code holds only `card_id` + the public-key fingerprint, no data;
- Share by local file/AirDrop; no public links.

### 4.6 Acceptance

- Cards verifiable offline;
- Reads under `PUBLIC_SCOPES` return only card/identity;
- No quotes without `evidence:read`;
- 403 within 1s after revocation, visible in the Access log.

---

## 5. Performance Plane — HET (automatic pipeline)

### 5.1 Pipeline identical to the original

The structure of the original `het/`: **agent logs → session watcher → segmenter → assessor → anchors → tick → ledger**. Lens implements it in the same order.

```
agent transcripts ─┐
timeline blocks ───┼─► segmenter ─► assessor (LLM, bounded) ─► anchors (deterministic)
broker audit ──────┘                                      │
                                                          ▼
                                                   het_tasks ledger
                                                          │
                                                    tick / dashboard
```

### 5.2 Agent log adapters

| Agent | Location | Parsing |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | session id, time, user/assistant messages, tool calls |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | session, turn, commands |
| Cursor Agent | Optional, later | — |

Transcripts are read-only; full text is not copied, only the summaries and references needed to judge tasks.

### 5.3 Segmentation

- Timeline session boundaries + agent transcript times form the skeleton;
- Merge consecutive activity in the same project/surface;
- Detect agent involvement: transcript exists + time overlap + same project;
- Output `HetTask` (start/end/title/project/agent/kind).

### 5.4 Judgement (assessor)

- One **bounded LLM call** per settled task (can use a Claude subscription/API; when budget runs out the task stays at `needs_assessment`, no guessing);
- Output: type, complexity, agent share, whether adopted, adoption evidence;
- Minutes are computed deterministically by `anchors`; the model never gives a number directly.

### 5.5 Adoption

| State | Source | Weight |
|---|---|---:|
| `confirmed` | User override | 1.0 |
| `strong` | Assessor found explicit adoption evidence (commit/edit/send) | 0.85 |
| `weak` | Only indirect references | 0.55 |
| `unknown` | No evidence | 0.3 |
| `rejected` | User override | 0 |

v2.1 judges automatically by default; the user can override on the HET page.

### 5.6 Anchors (deterministic minutes)

| kind | Unit | Default |
|---|---|---:|
| research | per 5 sources/pages | 20 |
| writing | per 500 words | 30 |
| coding | per 200 lines/PR | 45 |
| review | per document/PR | 20 |
| ops | per task | 10 |
| meeting | per minute | 1 |

```
minutes = anchor(kind) × size_factor × adoption_weight × complexity_factor
```

### 5.7 Ledger and UI

- `het.db`: `het_tasks` / `het_events` / `het_anchors` / `agent_calls`;
- Today/week/month, task list, pending confirmation, Anchors, Weekly Review;
- Every entry has expandable evidence; anything unexplainable is excluded from totals.

### 5.8 Acceptance

- The automatic pipeline produces tasks on 20 samples, with type/adoption checked by hand;
- Every task has evidence or `needs_assessment`;
- Weekly report total = sum of entries;
- After a user override, recompute and keep the audit trail.

---

## 6. Experience Plane

| Module | Version | Description |
|---|---|---|
| Card flip + Mini Map | v2.0 | Data from the Card |
| Living Model nebula | v2.1 | `/model/graph`, 1000 Points <1s |
| Rewind | v2.1 | Needs decrypted reads from the Runtime; OSS has none, so either a minimal patch or decryption in Lens (depends on who owns the key) |
| Playbook | v2.1 | `behavior_patterns` + `case_extractor` |
| **Weekly Review** | v2.0 | Local replacement for check-in emails: this week's HET, projects, evidence, a draft letter to friends; exports Markdown/HTML, never sent |

---

## 7. Security and privacy

- Private key in safeStorage; grant tokens stored only as hashes;
- The Broker listens only on 127.0.0.1; deny by default;
- v2.1 makes no outbound requests (the Weekly Review is not sent);
- Screenshots encrypted in the Runtime; Lens writes no plaintext to disk;
- TCC belongs only to Lens;
- Audit can be exported/cleared; the HET ledger can be deleted as a whole.

---

## 8. Delivery order (mechanisms first)

The first version chases only a closed mechanism loop for the three P0 planes; each plane must run and be testable before moving to the next. Done means "works end to end + comparison tests".

| Order | Deliverable | Done when |
|---|---|---|
| 1 | Capture: native addon + coordinator + ingest + exclusion/pause | TCC belongs to Lens; `source=ingest`; exclusion/pause/dedup testable |
| 2 | Identity: Card / Swipe / Connections / Access log / Broker | Card verifiable; connect/disconnect works; Access log has records |
| 3 | HET: agent logs → segmenter → assessor → anchors → ledger | Tasks produced automatically; pending not counted; corrections take effect |
| 4 | Integration: three planes wired together + tests + DMG | Full chain runs; key tests pass |
| P1 | Experience: nebula / Rewind / Playbook / Weekly Review | Added one by one once P0 is stable |

> After the first version ships, debug and optimise the failures in the test list one by one; don't skip L2/L3 to save time.

---

## 9. Acceptance (v2.0)

- [ ] TCC has only one Lens row; the Runtime is in ingest mode;
- [ ] Exclusion/pause/dedup/heartbeat semantics match the original;
- [ ] All four screens Card/Swipe/Connections/Access log exist;
- [ ] Connections default to full access; the Access log records reads (including empty results), and clearing it does not affect connections;
- [ ] The scope extension is tested separately: PUBLIC_SCOPES give only card/identity; evidence denied by default;
- [ ] HET produces tasks automatically, with assessor + anchors separated;
- [ ] No outbound requests; no private key/token leaks;
- [ ] Critical-path tests pass.

---

## 10. Explicit deviations

| Original | Lens v2.1 | Reason |
|---|---|---|
| Chat | None | Cloud inference; replaced by Broker + external agents |
| Meeting transcription | None | Soniox + cloud |
| Friend cards/social | None | Needs a cloud account; replaced by local `.persomecard` |
| Weekly report email | **Weekly Review (local)** | No email sent, only a local report |
| Skill extraction | None | Cloud `/v1/skill-extractions` |
| Cloud sync | None | Local-first |
| Minute Archive / ledger / world / funnel | v2.0 uses the OSS model; v2.1 reimplements world/person lineage | Private branch, code can't be copied |

These deviations must be stated clearly in product copy; never pretend it is "the same as the original".

---

## 11. Mapping to the original text

| Original text | Where it lands |
|---|---|
| "An ID card for a person's digital world" | Personal Card + Swipe + signed export |
| "Let every agent read the same you" | Broker + scope |
| "Capture, modeling, visualization, output" | Capture Plane / Runtime / Living Model / Broker |
| "Traceable, correctable, controlled by the person" | Evidence / Correct / grant revoke |
| "N×N shadows" | Multiple Connections / multiple grants |
| "Context → Performance" | HET automatic pipeline + Weekly Review |
| "Make something agents want" | Broker 5 tools + Access log |

---

## 12. Kept from v1

Overview / Model / Evidence / Search / Playbook / Settings / remember / correct / build / budget notices, all kept; v2.1 layers Capture, Identity and HET on top.
