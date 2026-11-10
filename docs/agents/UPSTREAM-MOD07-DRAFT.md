# Draft upstream issue (NOT filed — needs user approval)

Target: personal-model (OSS runtime) v0.3.2

**Title:** Promoted Points from `model_candidate_evidence` receipts are not resolvable; dropped deltas carry no reason

**Observed** (Lens fidelity audit, `docs/test-evidence/MOD-07/`):
1. Deltas without a quote, and with a quote not present in the source, are dropped correctly (0 index rows / candidates / receipts).
2. A delta with a verbatim quote is promoted after 2 sessions (2 Points), and receipts are stored with the verbatim quote + window.
3. **But** `resolve_evidence(<⟨…:model_candidate_evidence⟩ receipt>)` returns `missing` / `source_not_found_or_retained`, and the promoted Point resolves with `sources=[]`.
4. Dropped deltas are logged only as `dropped=N`, no per-item reason.

**Expected:** promoted Points resolve back to their receipt (quote + app/window/URL/time); drop logs name the reason (`no_quote` / `quote_not_in_source`).

**Repro:** `PERSOME_ROOT=<tmp> PERSOME_LLM_MOCK=1 ~/.persome/venv/bin/python -I docs/test-evidence/_scripts/mod07_gate.py`
(Caveat: timeline blocks seeded without capture lineage; the resolver does not appear to recognise this receipt kind at all.)
