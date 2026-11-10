# MOD-07 — `model_candidate_evidence` receipts are not resolvable; promoted Points have no sources; drops carry no reason

Target: `personal-model` (OSS Runtime), checked against source at commit `b7a28ff` (v0.3.2 line).
Status: **not filed, not applied**. Re-verified 2026-11-05: still reproduces (see "Current repro"). Lens does not edit the Runtime repo. This doc is the issue text plus a suggested patch.
Supersedes `docs/agents/UPSTREAM-MOD07-DRAFT.md` (same findings, now with root cause and a patch).

## Observed

From the fidelity audit (`docs/test-evidence/MOD-07/run.json`, `receipt-resolve.json`):

1. Deltas with no quote, or with a quote that is not in the source, are dropped (0 index rows, candidates or receipts). This part works.
2. A delta with a verbatim quote is promoted after 2 sessions, and `model_candidate_evidence` rows are stored with quote and window.
3. `resolve_evidence("⟨<digest>:model_candidate_evidence⟩")` returns `kind=unknown`, `status=missing`, `metadata.reason=source_not_found_or_retained`, `receipt_preserved=true`.
4. The promoted Point resolves with `sources=[]`.
5. Drops are recorded only as an integer: `DeltaResult.dropped` / `memory_deltas.dropped`, which `persome delta-report` prints as `dropped=N`. There is no per-item reason.

## Current repro (2026-11-05, OG-03 recheck; also covers MOD-08)

Runtime: installed `~/.persome/venv` persome 0.3.2. `evidence.py`, `writer/memory_delta.py`, `writer/delta_apply.py`, `store/model_candidates.py`, `mcp/server.py` and `api/routes.py` are byte-identical to `personal-model` at `b7a28ff`. Temp root only.

```bash
R=/tmp/persome-test/mod07-recheck-$$; mkdir -p "$R"
PERSOME_ROOT="$R" PERSOME_LLM_MOCK=1 ~/.persome/venv/bin/python -I docs/test-evidence/_scripts/mod07_08_recheck.py > out.json
```

The script drives the Runtime's own pipeline. Only the LLM transport is stubbed, through `run_after_session(llm_call=…)`. It runs 1 no-quote session, 1 fake-quote session and 2 verbatim sessions. It then probes every read surface by calling the function that backs it in-process; it does not go over HTTP or stdio. Output: `docs/test-evidence/MOD-07/2026-11-05-recheck.json`. Records: `MOD-07/2026-11-05-record.txt`, `MOD-08/2026-11-05-record.txt`.

| Probe | Backs | Result (sanitized) |
|---|---|---|
| `resolve_evidence("⟨6fd77af9…:model_candidate_evidence⟩")` | REST `GET /model/evidence`, MCP `resolve_evidence` | `kind=unknown, status=missing, metadata={reason: source_not_found_or_retained, receipt_preserved: true}, sources=[]` |
| `resolve_evidence("6fd77af9…")` (bare digest) | same | `status=missing, receipt_preserved=false` |
| `_read_receipt(entry_id="6fd77af9…")` and with the full `⟨…⟩` | MCP `read_receipt` | `{"error": "entry not found: …"}` (reads `entries` only) |
| `_related_events(entry_id="6fd77af9…")` | MCP `related_events` | `{"error": "entry not found: …"}` (reads `entries` only) |
| `resolve_evidence("<promoted point id>")` | REST/MCP | `kind=point, status=active, sources=[], context=[], history=[]` |
| `model_node(id="<promoted point id>")` | REST `GET /model/node` | the Point's own text and `⟨node:person-zhang-wei.md⟩`, `edges=[]`; no candidate evidence |
| `PRAGMA table_info(memory_deltas)` | n/a (test-root only) | `…, payload, dropped, apply_status, …`, no reason column. `DeltaResult` has only `.dropped`. No `writer.log` line names a reason. |
| MOD-08 controls: capture `cap-mod08`, memory `⟨ent-mod08:people/zhang-wei.md⟩` | REST/MCP | both resolve, with text, timestamp and `metadata.url` for the capture |

At the same time `model_candidate_evidence` holds 4 rows with the verbatim quote, `window_start` and `window_end`. Both candidates are `promoted`, with `evidence_count=2` and `independent_sessions=2`.

### Is there a read-only fallback Lens could use?

No. No REST, MCP or CLI surface in 0.3.2 reads `model_candidate_evidence`, or links a Point to its candidate:
- `read_receipt` and `related_events` query only `entries`. On a hit they also call `fts.increment_retrieval_counts`, so they are not free of side effects even when they work.
- `/model/node` returns the node itself. `/model/graph` and `get_model_snapshot` do not include candidate evidence.
- `delta-report` exposes counts. Its `payload` heads are counts too.

The only way left is to read `index.db` directly, which is forbidden for Lens. Lens therefore records the fallback as `source=lens_fallback, outcome=none`, with the list of surfaces it checked (`NO_FALLBACK` in `src/renderer/src/components/evidence/model.ts`). It does not invent a result.

### Per-item drop reasons

The upstream gives none. It records only the integer `dropped` per window, and `_quote_ok` merges "no quote" and "quote not in source". Lens shows `已丢弃 N 条（Runtime 未提供逐条原因）`, or the Runtime-wide counter from `delta-report` labelled as not specific to the item.

### Verdict

- **MOD-07: BLOCKED (upstream), L3.** Steps 1, 2 and 4 pass. Step 3 (reason logged) and step 5 (receipt resolvable) fail.
- **MOD-08: BLOCKED (upstream), L3.** Capture and memory receipts resolve. The receipts minted by the evidence gate do not, and promoted Points have no lineage to them.

### What upstream needs to fix (minimum to unblock)

1. A `resolve_evidence` branch for `path_hint == "model_candidate_evidence"` that looks up `evidence_receipt` by the **full** `⟨digest:model_candidate_evidence⟩` string and returns quote, window and session (patch §1 below).
2. Persist Point → candidate lineage at promotion and emit it in `sources` (patch §2).
3. Per-reason drop accounting persisted next to `dropped` (patch §3).

## Root cause (read from source)

- **(3)** `src/persome/evidence.py::resolve_evidence` tries `_resolve_entry`, `_resolve_evo_node`, `_resolve_activity`, `_resolve_capture` and `_resolve_geometry` in that order. None of them reads the `model_candidate_evidence` table (`src/persome/store/model_candidates.py`). The `path_hint` `model_candidate_evidence` is parsed but never routed, so every such receipt falls through to the final `missing` branch. Seeding capture lineage would not change this. The resolver has no branch for this receipt kind.
- **(4)** `_resolve_evo_node` builds `sources` only from `abstracted_from` / `refined_from`. When a candidate is promoted, `writer/delta_apply.py` calls `_apply_assertions` → `EvoMemory.add_direct(content, file_name=…, tags=…)`, which stores no `candidate_key` or evidence receipt on the minted node. The Point therefore has no stored lineage back to its `model_candidate_evidence` rows.
- **(5)** `writer/memory_delta.py::gate_delta` adds `dropped += 1` on every failure branch. Those branches cover entity kind, identity funnel, `_quote_ok`, `conf_ok`, predicate set and participants. It then adds `dropped += entity_duplicates`. Only the sum is persisted (`deltas_store.insert_for_claim(..., dropped=dropped)`). `_quote_ok` also merges "no quote" and "quote not in source" into a single `False`.

## Reproduction

### A. Minimal, uses no real data (what Lens used to confirm the cause)

Uses the Runtime's own `ensure_schema` / `make_evidence_receipt` / `resolve_evidence` on an in-memory SQLite DB. `PERSOME_ROOT` points to an empty temp dir, so `~/.persome` is never touched.

```bash
TMP=$(mktemp -d)
cat > "$TMP/mod07_min.py" <<'EOF'
import sqlite3, json
from persome.store import model_candidates as mc
from persome.evidence import resolve_evidence
conn = sqlite3.connect(":memory:")
mc.ensure_schema(conn)
key = mc.make_candidate_key(candidate_kind="assertion", subject="Zhang Wei", text="approved the budget")
receipt = mc.make_evidence_receipt(candidate_key=key, session_id="s1",
    window_start="2026-03-01T10:00:00+00:00", window_end="2026-03-01T10:30:00+00:00")
conn.execute("INSERT INTO model_candidate_evidence (evidence_receipt, candidate_key, session_id, window_start,"
  " window_end, source_kind, quote, confidence, payload_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  (receipt, key, "s1", "2026-03-01T10:00:00+00:00", "2026-03-01T10:30:00+00:00", "assertion",
   "Zhang Wei approved the budget", 0.9, "x", "2026-03-01T10:31:00+00:00"))
print("stored rows:", conn.execute("select count(*) from model_candidate_evidence where evidence_receipt=?", (receipt,)).fetchone()[0])
out = resolve_evidence(conn, receipt)
print(json.dumps({k: out[k] for k in ("reference","kind","status","metadata","sources")}, ensure_ascii=False, indent=1))
EOF
cd "$TMP" && PERSOME_ROOT="$TMP/root" ~/Documents/GitHub/personal-model/.venv/bin/python "$TMP/mod07_min.py"
```

Output observed on 2026-11-05:

```text
stored rows: 1
{
 "reference": "⟨3505cbb0aafbb790800bd84a1427faad:model_candidate_evidence⟩",
 "kind": "unknown",
 "status": "missing",
 "metadata": { "reason": "source_not_found_or_retained", "receipt_preserved": true },
 "sources": []
}
```

The row exists, and the resolver still reports it as not found.

### B. Full gate run (fidelity audit)

`PERSOME_ROOT=<tmp> PERSOME_LLM_MOCK=1 ~/.persome/venv/bin/python -I docs/test-evidence/_scripts/mod07_gate.py`. This runs no-quote, fake-quote and verbatim cases, 2 sessions each. Evidence is in `docs/test-evidence/MOD-07/`.

### C. From a live Runtime (owner's shell; the token is read from `env` and never printed)

```bash
(set -a; . ~/.persome/env; curl -sG -H "Authorization: Bearer $PERSOME_LOCAL_API_TOKEN" \
  --data-urlencode 'ref=⟨<digest>:model_candidate_evidence⟩' http://127.0.0.1:8742/model/evidence)
persome delta-report --limit 20     # shows only dropped=N per window
```

The Lens EvidenceDrawer has a copy button for both commands.

## Impact

- The evidence chain breaks one hop from the claim. The owner can see that a Point was promoted but cannot reach the quote and window that justified it. T-MOD-07 step 5 fails.
- Any client that counts `sources` will report "0 sources" for a grounded Point. A client that renders `missing` naively will imply the evidence expired, but the row is still stored.
- Owners and auditors cannot tell "the model gave no quote" from "the quote was fabricated" or "confidence was below the floor". T-MOD-07 step 3 fails.
- Lens mitigation (S1-01, OG-03): the drawer shows these receipts as **证据未解析** with the Runtime's own reason and never counts them as sources. A Point with `sources=[]` is no longer shown with a bare 「无」. It gets an explicit **证据未解析** row with its ref, the text 「Runtime 为这条 Point 返回了空的 sources（sources=[]），没有给出原因」, the MOD-07 note and a labelled `Lens 回退：无`. When only a count exists the drawer shows `已丢弃 N 条（Runtime 未提供逐条原因）`, and it offers the repro commands. Lens cannot fix the root cause, because it must not read or write `index.db`.

## Suggested patch (description + diff sketch; NOT applied)

### 1. Resolve `model_candidate_evidence` receipts (`src/persome/evidence.py`)

```diff
+def _resolve_candidate_evidence(
+    conn: sqlite3.Connection, *, original: str, identifier: str, receipt: str | None,
+    path_hint: str | None, as_of: datetime | None,
+) -> dict[str, Any] | None:
+    if path_hint != "model_candidate_evidence" or not _table_exists(conn, "model_candidate_evidence"):
+        return None
+    canonical = receipt or f"⟨{identifier}:model_candidate_evidence⟩"
+    row = conn.execute(
+        "SELECT e.candidate_key, e.session_id, e.window_start, e.window_end, e.source_kind,"
+        " e.quote, e.confidence, e.created_at, c.status, c.text"
+        " FROM model_candidate_evidence e LEFT JOIN model_candidates c USING(candidate_key)"
+        " WHERE e.evidence_receipt = ?", (canonical,),
+    ).fetchone()
+    if row is None:
+        return None
+    return _base(
+        reference=original, canonical_reference=canonical, kind="candidate_evidence",
+        identifier=identifier, status="available", label=_short_label(row[9], "Model candidate evidence"),
+        summary=_trim(row[5]), timestamp=str(row[3]), path="model_candidate_evidence",
+        metadata={"candidate_key": row[0], "session_id": row[1], "window_start": row[2],
+                  "window_end": row[3], "source_kind": row[4], "confidence": row[6],
+                  "candidate_status": row[8], "quote": row[5]},
+        context=_nearby_capture_links(conn, str(row[3]), as_of=as_of),
+    )
@@ def resolve_evidence(
     resolvers = (
+        lambda: _resolve_candidate_evidence(
+            conn, original=original, identifier=identifier, receipt=receipt,
+            path_hint=path_hint, as_of=cutoff,
+        ),
         lambda: _resolve_entry(
```

Note: `model_candidate_evidence.evidence_receipt` stores the full `⟨digest:model_candidate_evidence⟩` string, so the lookup must use the canonical receipt and not the bare digest.

### 2. Link promoted Points to their candidate evidence

Option A, smallest change: add a mapping table `model_candidate_points(candidate_key TEXT, node_id TEXT, PRIMARY KEY(candidate_key, node_id))`. Write to it in `delta_apply._apply_assertions` when the minted/reinforced node comes from a promoted candidate. Then in `_resolve_evo_node`:

```diff
+    if _table_exists(conn, "model_candidate_points"):
+        for (key,) in conn.execute(
+            "SELECT candidate_key FROM model_candidate_points WHERE node_id=?", (identifier,)
+        ):
+            for ev in candidates_store.evidence_for(conn, key):
+                if as_of is not None and not _at_or_before(ev.created_at, as_of):
+                    continue
+                sources.append(_link(relation="candidate_evidence", kind="candidate_evidence",
+                    identifier=ev.evidence_receipt, reference=ev.evidence_receipt,
+                    label=_short_label(ev.quote, "Model candidate evidence"),
+                    timestamp=ev.window_end, status="available"))
```

Option B: store the `candidate_key` on the evo node, in `refined_from` or a new column. That is more invasive.

### 3. Per-reason drop accounting (`src/persome/writer/memory_delta.py`, `store/memory_deltas.py`)

- Split `_quote_ok` into a reason: `no_quote` | `quote_not_in_source` | `None`.
- Change `gate_delta` to return `(clean, dropped, drop_reasons: dict[str, int])`. Use these keys: `no_quote`, `quote_not_in_source`, `below_confidence`, `unknown_kind`, `unknown_predicate`, `unresolved_identity`, `self_identity`, `conflicting_lifecycle`, `duplicate`. `dropped == sum(drop_reasons.values())` keeps old readers working.
- Add a `drop_reasons TEXT` (JSON) column to `memory_deltas`, written in `insert_for_claim`. Expose it in `delta-report` (text and `--json-out`) and, optionally, in `GET /model/evidence` metadata for a Point's originating windows.

### Tests to add upstream

- `resolve_evidence(⟨…:model_candidate_evidence⟩)` → `status=available` with the quote and window.
- A promoted Point's `sources` contains its candidate receipts, and `as_of` before `created_at` hides them.
- A no-quote item increments `drop_reasons.no_quote` and a fabricated quote increments `drop_reasons.quote_not_in_source`.
