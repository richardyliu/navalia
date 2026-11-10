# MOD-11 — owner alias is merged into `self` without owner confirmation

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MOD-11/2026-11-05-raw.json`)
One window containing "[Notes] profile: I am ryl-dev on GitHub" and an LLM `owner_alias_candidates` item `{alias: ryl-dev, source_kind: explicit_self_identification, confidence: 0.9}` → `owner_aliases` row `status=active, evidence_count=1, decision_source=inferred` immediately. From then on "ryl-dev" resolves to `self` everywhere. Person–person merges (a Chinese-script name and its romanization, e.g. Zhang Wei) correctly wait for an owner correction.

## Root cause
`store/owner_aliases.py::record_candidate`: `active = … or explicit or count >= PROMOTION_SESSIONS`, where `explicit` is true for `explicit_self_identification` with conf ≥ 0.9 and a matching quote. The quote is screen text; it may be someone else's message, a quoted profile, or a test fixture. The second path (2 sessions) also activates without the owner.

## Suggested fix
Keep inferred aliases `pending` and surface them for owner review (CLI `persome owner-aliases` / an MCP-visible pending list); only `user_correction` (or an explicit owner accept) activates. Optionally allow auto-activation behind a config flag that defaults off.

## Repro
`og00b_pipeline.py` phase p1; read `owner_aliases` in the temp index or call `entity_graph("ryl-dev")`.
