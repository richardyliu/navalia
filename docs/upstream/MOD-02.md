# MOD-02 — model Lines carry no resolvable evidence; co-occurrence `knows` Lines are promoted with no quote

Target: `personal-model` 0.3.2 (installed `~/.persome/venv`, identical to `b7a28ff`). Status: not filed, not applied. Found by OG-00b (2026-11-05).
Related: `MOD-07.md` (same lineage gap for Points; also explains MOD-01 `sources=[]`).

## Observed
- After `persome model build`, all 14 relation Lines resolve with `sources=[]`, `context=[]` (`resolve_evidence` over stdio MCP).
- 6 of them are `knows` Lines with `label="co-occurs"`, `quote=null`, `source_evidence=null`, `status=active`. They are synthesized by `memory_delta.gate_delta` (`cooccurrence_knows=true`) for every pair of persons in one window, and the build's enrichment promotes them.
- The typed relations the delta actually asserted with a verbatim quote (`Zhang Wei part_of Acme Corp`, label "works at") stay `shadow`, so the model shows "knows (co-occurs)" but not "works at".

## Repro
`PERSOME_ROOT=/tmp/persome-test/<x> PERSOME_LLM_MOCK=1 ~/.persome/venv/bin/python -I docs/test-evidence/_scripts/og00b/og00b_pipeline.py 18792 <out>` then `og00b_lines_probe.py <root> <out.json>`. Evidence: `docs/test-evidence/MOD-02/2026-11-05-raw.json`.

## Suggested fix
1. `_resolve_relation_edge` (evidence.py): emit the edge's stored quote/receipt and, where `source_kind/source_id` exist (event occurrences already have them), a `sources` link.
2. Persist the window/session receipt on every `_upsert_shadow` call from delta apply (not only events), so a Line can be traced to `memory_deltas` / `model_candidate_evidence`.
3. Do not promote co-occurrence `knows` edges without a receipt, or mark them `provenance="cooccurrence"` and keep them out of the evidence-bearing Line set.
