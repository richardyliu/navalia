# MOD-13 — model readiness reason codes are CLI-only; REST does not expose them

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b, confirmed 2026-11-05 (lead).

## Observed
- `persome.model.snapshot.model_status(conn, snapshot_data=…)` computes `issues` =
  `no_points`, `no_lines`, `no_faces`, `no_volumes`, `no_root` (snapshot.py ~L592–618).
  `persome model status` (cli.py `model_status_cmd`) appends `no_completed_build` (build status `not_built`)
  or `build_in_progress` (`building`) and prints `issues: …`.
- `model_status` has no other caller. On an empty temp root served by the real Runtime app (:18794):
  `/openapi.json` paths = `/auth/browser-bootstrap /captures/ingest /health /health-events/import
  /mobile/events/ingest /model /model/evidence /model/graph /model/node /model/share-card /permissions /status`.
  None of `/status`, `/model/graph`, `/model/share-card`, `/model`, `/permissions`, `/model/evidence` contains
  any `no_*` code or an `issues` key. `/model/graph` carries only `model.build.degraded_stages=["model_contract"]`, which build.py (~L515) adds when any one of points / lines / faces / volumes / root is empty — it says *that* a layer is missing, not *which*.
  MCP `get_model_snapshot` returns stats only (MOD-13/2026-11-05-raw.json).

## Minimal upstream change (proposed)
In `persome/api/routes.py` `model_graph()`, after `snapshot = build_live_snapshot(conn, redact=False)`:

```python
from ..model import model_status
status = model_status(conn, snapshot_data=snapshot)
issues = list(status["issues"])
build_status = str(snapshot["build"]["status"])
if build_status == "not_built":
    issues.append("no_completed_build")
elif build_status == "building":
    issues.append("build_in_progress")
payload["model_status"] = {"ready": not issues, "issues": issues}
```

Better: move the two build-status codes into `model_status()` itself so CLI and REST cannot drift, and have
`model_status_cmd` read them from there. No schema bump needed (additive key on the REST payload); the MCP
`get_model_snapshot` result could carry the same key.

## Lens side (done)
`src/renderer/src/lib/modelIssues.ts` reads `model_status.issues` from `/model/graph` if present and renders
each literal code next to a Chinese explanation (Overview Model build card → Degraded reasons; Model page → Degraded reasons card).
Lens never derives codes from counts. Against Runtime 0.3.2 the field is absent, so Lens shows the literal
`degraded_stages` (`model_contract` + explanation) and a note that per-layer codes are printed only by
`persome model status`. Tests: `tests/model/mod13-issues.test.ts`.
