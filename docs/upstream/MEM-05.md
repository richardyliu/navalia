# MEM-05 — Face/Volume propositions leak into `search`, including Faces the resident gate rejected

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MEM-05/2026-11-05-raw.json`)
`behavior_patterns` docstring: "This layer is NOT reachable via `search` … searching for 'behavior pattern' finds nothing". Observed: `search("behavior pattern Friday review ritual")` and `search(<central proposition>)` return `schema-project-atlas.md`, `schema-user-preferences.md`, `schema-xdomain-…md` entries. On the first sample day those Faces were still `shadow` (`behavior_patterns.faces=[]`), so `search` served regularities that had not passed the two-signal/resampling gate.

## Root cause
`writer/schema_miner_stage._persist_schema` and `cross_domain_sweeper._persist_cross_schema` write `schema-*.md` entries; files born `stable` (confidence ≥ 0.6) are `active`, independent of `schema_faces.status`, so they are indexed and returned by the normal entries search.

## Suggested fix
Exclude `prefix='schema'` from default `search` (opt-in via `paths=['schema-*.md']`), or gate the file status on `schema_faces.status='active'` instead of the miner confidence. Fix the docstring either way.
