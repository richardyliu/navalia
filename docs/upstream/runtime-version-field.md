# Runtime version field: implemented in R10 (`/health` + `/status` carry `schema_revision` and `build_version`)

Status: **implemented and deployed locally** (2026-11-06). Upstream `personal-model-og` branch `og/r10-version-delete`,
commit `7066066` (local tag `deploy/2026-11-06-r10`; not pushed, no PR). Evidence:
`docs/test-evidence/PHASE5/runtime-r10/`. The original problem report is kept at the end of this file.

## What the Runtime returns now

Both routes add these fields. Nothing was removed or renamed.

| field | `/health` (unauthenticated) | `/status` (bearer) | value |
|---|---|---|---|
| `version` | new | already there | `persome.__version__` (`0.3.2`) |
| `schema_revision` | new | new | code constant `store.fts._RUNTIME_SCHEMA_REVISION` (`2026-11-05.3`). It is not read from the owner's `index.db`. |
| `build_version` | new | new | `<version>+g<short-sha>`, plus `.dirty` if the tree had uncommitted tracked changes. It is just `<version>` when the commit is unknown. |
| `build_sha` | new | new | 7-char sha, or `null` |

How the sha gets into the wheel: a hatchling custom build hook (`hatch_build.py`, stdlib only, registered in
`pyproject.toml` `[tool.hatch.build.targets.wheel.hooks.custom]`) writes `persome/_build_info.json` (`git_sha`, `dirty`,
`built_at`). `install.sh --update` builds with `uv build --wheel` from the checkout, so a normal deploy gets stamped.
The hook trusts git only when the build root *is* the repo toplevel. A PyPI stage copy, an sdist, or a machine with no
git therefore gets `git_sha: null`, and the hook never fails the build. A source checkout (tests) falls back to
`git rev-parse` at runtime (`persome/build_info.py`, cached).

`/health` still exposes only build facts, never counts, paths or user data. A test pins its exact key set.

Upstream tests: `tests/test_runtime_identity.py` (9) plus the 4 exact-match `/health` tests in `tests/test_api_routes.py`
were updated. The full offline suite gives **2654 passed / 0 failed / 1 skipped / 17 deselected**.

## Verify

```bash
curl -fsS http://127.0.0.1:8742/health
# … "version":"0.3.2","schema_revision":"2026-11-05.3","build_version":"0.3.2+g7066066","build_sha":"7066066"
TOKEN=… # from ~/.persome/env PERSOME_LOCAL_API_TOKEN, never echo it
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8742/status | python3 -c \
  "import json,sys;d=json.load(sys.stdin)['data'];print({k:d[k] for k in ('version','schema_revision','build_version','build_sha')})"
cat ~/.persome/venv/lib/python3.12/site-packages/persome/_build_info.json   # {"built_at": …, "dirty": false, "git_sha": "7066066"}
```

Real output after the R10 deploy (2026-11-06 15:54 PST) is in `PHASE5/runtime-r10/06-post-deploy-curl.txt`.

## Lens change (T5 "Runtime updated")

`src/main/proactive/sources.ts`, function `runtime()`, now keys T5 off the build identity:

- marker = `schema:<schema_revision>|build:<build_version>` (exported `runtimeRevisionMarker()`, bounded to 64 and 128
  chars). It comes from `/health`, then from `/status` if `/health` has neither field. Only an older Runtime falls back
  to `version:<version>` from `/status`.
- Because `build_version` contains the git sha, a code-only redeploy now changes the marker, as does a schema
  migration. Before R10, T5 fired only when `__version__` was bumped.
- The engine still stores only a hash of the marker, and the first observation is still the baseline. The R10 deploy
  changes the marker (`version:0.3.2` → `schema:2026-11-05.3|build:0.3.2+g7066066`), so T5 fires once after this
  deploy. That is the intended signal.
- On the deployed Runtime, `runtimeRevisionMarker(real /health)` = `schema:2026-11-05.3|build:0.3.2+g7066066`.
- Tests: `tests/proactive/sources.test.ts` covers build change ⇒ marker change, the `/status` fallback, the old
  `version:` fallback, and bounds and non-string input.
- `src/shared/types.ts` `StatusData` has new optional fields `schema_revision`, `build_version` and `build_sha`.

Caveat: the Lens app now running (`dist/mac-arm64/Persome Lens.app`) was packaged before this change. T5 uses the new
marker only after Lens is rebuilt and repackaged. `npm run build` passes.

---

## Original report (2026-11-06, Phase 4), now resolved

Before R10, `GET /health` returned only `{status, ocr, ocr_worker, ocr_enabled, ocr_tier, index, capture_pipeline}`.
`GET /status.version` was `persome.__version__` (`0.3.2`). That value did not change across the R1–R9 deploys, so T5
"upgraded" never fired on a deploy that kept the same `__version__`. The "unreachable" half of T5 was unaffected.
