# MOD-12 — `GET /model/evidence?as_of=T` returns objects that did not exist at T as active

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MOD-12/2026-11-05-raw.json`)
- CLI `persome as-of` and MCP `entity_graph(as_of=…)` return the correct transaction-time version (PASS).
- REST `/model/evidence?ref=<point>&as_of=T`: a Point created at 18:54:58Z is returned `status=active` for `as_of=18:54:55Z` and for `as_of=2026-07-01`. A superseded Point is returned with its *current* status at a T when it was live. Only successor links and nearby captures are cut at T.
- All clocks are ingest time: relation `valid_from` is `datetime.now()` in `delta_apply._apply_relations`, and Points have no `occurred_at`, so `as_of=<the day the evidence was observed>` returns nothing when ingestion lags (backfill, delayed reduction).

## Suggested fix
1. In `evidence.resolve_evidence(…, as_of=T)`: if the object's `gmt_created/created_at > T` return `status="not_yet_recorded"` (or 404-like `missing` with reason); for evo nodes compute status at T with `evomem.as_of.node_as_of`.
2. Pass the session window end as `valid_from` for delta relations and as `occurred_at` for promoted Points.

## Impact on Lens
EvidenceDrawer "View as of then" uses this endpoint. Until fixed, Lens should label it as a history/context cut-off, not "state at T".
