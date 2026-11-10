# MOD-09 — conflicting assertions coexist as live Points; repeated "ended" mints a zero-length edge

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MOD-09/2026-11-05-raw.json`)
- Idempotency is fine (window replay → `already_processed`; `apply_persisted_delta` replay → 0 effects; identical 3rd session → no new nodes).
- Two sessions say "I left Acme Corp … joined Beta Labs". The `part_of Acme Corp` edge is closed (good). But Points "Zhang Wei works at Acme Corp" and "Zhang Wei works at Beta Labs" are both `is_latest=1`, `active`, `superseded_by=[]`, `conflicted=0`. Nothing supersedes or even flags the old Point.
- The second `ended: true` observation, with no open edge left, makes `end_edge_with_effect` create a new edge with `valid_from == valid_to` (zero-length "fact").

## Root cause (source)
- `writer/delta_apply.py::_apply_assertions` only dedups exact text; there is no subject/predicate-level conflict check. Contradiction marking exists only in `writer/contradiction_check.py` (nightly, default OFF, entries layer only) and never supersedes by design.
- `store/relation_edges.end_edge_with_effect` creates a closed edge when no open one exists.

## Suggested fix
1. When a relation for the same `(src, predicate, label)` is ended and a new one opened in the same delta, look up assertion Points on the same subject that mention the old `dst` and either supersede them (keeping the receipt) or set `conflicted=1` and enqueue a `memory_contradictions` row.
2. In `end_edge_with_effect`, if no open edge exists, record the end observation on the latest closed edge instead of creating a zero-length one.

## Repro
`og00b_pipeline.py` phases p3/p4 (see record).
