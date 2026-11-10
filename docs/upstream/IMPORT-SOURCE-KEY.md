# Upstream note: stable source key for `persome import-data` (S1-07)

Status: proposal, not filed, not applied. Lens does not modify the Runtime repo.

## Problem
Lens S1-07 converts Claude Code / Codex sessions to redacted Markdown under
`<LensStore>/import/staging/<runId>/` and calls
`persome import-data --source folder --path <staging> --no-build`.
The Runtime's dedupe key for folder imports includes the import root path
(see `personal-model/src/persome/cli.py` `import-data` and the folder importer). Because each
Lens run uses its own staging root, a transcript that grew after its first import is stored
again as a new document; its earlier content is duplicated.

Lens mitigates with a local ledger (content hash per session → skip unchanged), but cannot
make a grown session *replace* its earlier document without writing `index.db`, which Lens
must not do.

## Repro
1. Temp `PERSOME_ROOT`; import one fixture session (S1-07 Import page, or `tests/import/real-runtime.test.ts` with `LENS_IMPORT_REAL_PERSOME=1`).
2. Append messages to the source transcript; import again.
3. `source_imports` has two rows for the same transcript; the timeline has both versions.

## Suggested change
Either:
- `import-data --source folder --source-key-from frontmatter`: honour a `source_key:` in the
  Markdown front matter (Lens would write `claude-code:<sessionId>` / `codex:<sessionId>`), and
  treat a changed hash under the same key as an update; or
- a first-class `--source agent-transcript` importer that keys on the session id.
