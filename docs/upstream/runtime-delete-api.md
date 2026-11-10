# Runtime per-item delete API: implemented in R10

Status: **implemented and deployed locally** (2026-11-06). Upstream `personal-model-og` branch `og/r10-version-delete`,
commit `7066066`, local tag `deploy/2026-11-06-r10` (not pushed, no PR). Evidence: `docs/test-evidence/PHASE5/runtime-r10/`.
§5 at the end records how the shipped design differs from the Phase 4 proposal.

## 1. Routes (loopback, bearer token only)

All three routes share the following:

- Auth: the `LocalAPIAuthMiddleware` bearer check, the same as every other mutating route. They are not under
  `/model/`, so the viewer cookie cannot reach them. Missing token → 401.
- Body: `schema_version: 1`, `extra="forbid"`, 1–1000 ids per request (`MAX_HEALTH_EVENTS_PER_REQUEST` convention).
  Ids must match `^[A-Za-z0-9][A-Za-z0-9._:\-]{0,255}$`, so a control character gives 422. The body is capped at 512 KiB
  and strict JSON is required (no NaN/Infinity).
- Transaction: one `BEGIN IMMEDIATE` per request. Memory-entry erase rewrites the Markdown inside the transaction under
  the file lock, and restores the original text if anything fails before `COMMIT`.
- Audit: one `memory_deltas` row per request that deleted something, `session_id = "owner-delete"`, payload
  `{"owner_delete": {kind, by, counts, tombstones: {<namespace>: [ids…]}}}`. This follows the `owner-edit` convention.
  The row holds **ids and counts only**; tests assert that no content or file name ends up in it.
- Idempotent: an id deleted earlier is found through the audit tombstones and returned in `already_deleted` with 200.
  An id that never existed goes in `missing`. If nothing was found and nothing had been deleted before, the response is
  **404** `{"detail": {"error": "not_found", "kind", "missing": [...]}}`.
- FTS: the FTS5 tables already run with `secure-delete`, so deleted rows do not linger in the index. Backups taken before
  a delete still contain the data.
- Response (200):
  `{schema_version, kind, deleted: {<table>: n}, deleted_ids, already_deleted, missing, refused: [{id, reason}], …}`.
- Errors: 423 `memory_writes_frozen` (integrity freeze), 409 `<reason>`, 500 `delete_failed: <ExceptionType>`.

### `POST /imports/delete`

`{"schema_version": 1, "by": "source_key" | "content_sha256" | "session_id", "ids": [...]}`

- Deletes the `source_imports` row(s), their **`import-*`** sessions (never any other session id, even one listed in
  `session_ids`), the `tlb-import-*` timeline blocks, and `skill_observations`.
- `content_sha256` matches every import of exactly those bytes. Lens's meeting `imported.sha256` is that value.
  `session_id` selects the whole document that contains the session.
- Extra fields: `by`, `modeled_sessions` (sessions the writer had already modeled) and `derived_memory`
  (`"retained"` | `"none"`). **Memory derived from modeled sessions is not deleted.** A re-import after the delete
  creates fresh rows.

### `POST /memory/entries/delete`

`{"schema_version": 1, "entry_ids": [...]}`

- Erases the entry block from its Markdown file (the source of truth, so `rebuild_index` cannot bring it back; tested).
  It also deletes the matching rows in `entries` (FTS), `entry_temporal`, `entry_metadata`, `entry_retrieval_stats`,
  `entry_vectors`, `vector_queue`, the shadow `evo_nodes` Point (`node_id = entry_id`) and `model_candidate_points`, and
  updates the `files` row and the frontmatter `entry_count`.
- Scope guard: the route only erases entries tagged `source:agent-run`, which `remember` always adds. Anything else is
  refused:
  - `not_agent_written`: the entry lacks the `source:agent-run` tag
  - `in_supersede_chain`: the entry has a `superseded-by` or `refined-from` link, or another entry links to it
  - `evomem_authority`: the file is routed to the evomem engine. Lens falls back to `/model/edit retire` for these.
  - `source_file_missing`, `not_in_source_file`, `concurrent_change`
- Deltas: `entries`, `markdown_blocks`, `points`, `vectors`.

### `POST /timeline/delete`

`{"schema_version": 1, "by": "block_id" | "source_key" | "content_sha256", "ids": [...]}`

- With `block_id`, it deletes those `timeline_blocks` and their `skill_observations`. The source variants delete only
  the blocks an imported source staged.
- It does **not** cascade to sessions, `source_imports` or memory. Ids already removed through `/imports/delete` count as
  `already_deleted`.

Upstream tests are in `tests/test_owner_delete_api.py` (23). They cover each selector, idempotency and the audit
without content, 404 on unknown ids, re-import after delete, capture sessions never touched, rollback as one
transaction, the timeline routes, erase from Markdown, FTS and rebuild, refusing non-agent memory and evomem files,
Markdown restore on a failed transaction, bearer 401, the 1001-id batch limit, and control characters. The full
offline suite gives **2654 passed / 0 failed / 1 skipped / 17 deselected**. `openapi.json` was regenerated and
`docs/api.md` updated.

## 2. Verify (no real data touched)

```bash
TOKEN=… # from ~/.persome/env PERSOME_LOCAL_API_TOKEN, never echo it
for r in 'imports/delete|{"schema_version":1,"by":"source_key","ids":["0000000000000000000000000000000000000000000000000000000000000000"]}' \
         'memory/entries/delete|{"schema_version":1,"entry_ids":["r10-nonexistent-entry"]}' \
         'timeline/delete|{"schema_version":1,"by":"block_id","ids":["tlb-r10-nonexistent"]}'; do
  curl -s -w '  [HTTP %{http_code}]\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
       -d "${r#*|}" "http://127.0.0.1:8742/${r%%|*}"
done                                   # each: {"detail":{"error":"not_found",…}}  [HTTP 404]
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8742/imports/delete   # 401 without token
```

The real outputs are in `PHASE5/runtime-r10/06-post-deploy-curl.txt`. On the real Runtime, only the 404 path was
exercised. The positive paths were exercised against a real R10 Runtime on temp roots (Lens
`tests/connectors/real-runtime.test.ts`, see §3) and in upstream pytest.

## 3. Lens changes

- **Client**: `src/main/runtime/owner-delete.ts` (zod result schema, 404-body discrimination, zh refusal texts). New
  `RuntimeClient` methods in `src/main/runtime/client.ts`:
  - `deleteImports(by, ids)`
  - `deleteMemoryEntries(ids)`
  - `deleteTimeline(by, ids)`

  A Runtime 404 with the `not_found` body becomes an all-`missing` result. Any other 404 or 405 throws
  `RuntimeError('not_found', …, detail 'endpoint_missing')`, which means a Runtime older than R10.
- **Meetings** (`src/main/cloud/meetings.ts` `deleteFromRuntime`, channel `lens:meetings:delete-from-runtime`, preload
  `meetings.deleteFromRuntime`):
  - UI: a **「从 Persome 删除…」** button in `MeetingDetail.tsx` whenever the meeting's import or remembered summary
    is still in the Runtime.
  - The button shows a native confirm first, listing what will be removed and saying derived memory stays.
  - It then calls `/imports/delete {by:"content_sha256", ids:[imported.sha256]}` and, if a summary was remembered,
    `/memory/entries/delete`.
  - It records `imported.runtimeDeletedAt`, which re-enables import, and clears `summary.rememberedEntryId` unless the
    Runtime refused.
  - The import confirm text, `RUNTIME_DELETE_NOTE` and the meeting-delete note no longer say "the Runtime cannot
    delete".
- **Connectors** (`src/main/connectors/service.ts` `deleteImported`). The existing 「删除」 with native confirm now:
  - erases memory through `/memory/entries/delete`, in batches of up to 1000 ids;
  - falls back to `/model/edit retire` for ids refused with `evomem_authority`, and for every id on a Runtime older
    than R10;
  - treats `missing` ids as gone and says so in the notes;
  - deletes `import-data` timeline docs through `/imports/delete {by:"source_key"}`. Lens computes the key the way the
    Runtime does: `sha256("folder\0" + realpath(<store>/connectors) + "/source\0" + "<kind>/<key>.md")`. Source keys
    the Runtime doesn't know stay listed, because Lens derived those keys itself.

  `postRuntime` now forwards the short `error` code from an object `detail`. The confirm text and `deleteLines` show
  erased and timeline counts.
- **Tests**:
  - `tests/runtime/owner-delete-client.test.ts` (7, loopback HTTP double)
  - `tests/cloud/meetings.test.ts` (+5)
  - `tests/cloud/meetings-pure.test.ts` and `tests/connectors/view.test.ts` (extended)
  - `tests/connectors/delete.test.ts` (+4; the fake Runtime now defaults to pre-R10 behaviour, with `r10: true` for
    the new routes)
  - `tests/connectors/real-runtime.test.ts`: against the **real upstream R10** on a sandboxed temp root,
    markdown-authority erase removes the entry from search, `deleteImported` deletes 3 timeline docs by source key, a
    re-import is new again, and evomem authority still retires.

## 4. Remaining gaps (not done)

- Memory the writer **derived** from an imported, modeled session is not deleted. The response reports this as
  `modeled_sessions`, and the Lens copy says so. A provenance link from derived entries back to sessions does not exist.
- `memory_deltas` rows for imported sessions (extracted payloads) are kept, because lineage and receipts reference them.
- No `GET /imports?content_sha256=` preview route, and `import-data` still prints only counts, not the `source_key`.
- No MCP `forget` tool.
- Entries in a supersede chain are refused rather than erased as a chain.

## 5. Differences from the Phase 4 proposal

The proposal's `cascade:"derived"` and `mode:"retire"` were not built: derived memory is retained and reported, and
retire stays on `/model/edit`. The proposal's `/timeline/delete {block_ids}` became `{by, ids}`, which also supports
deleting by source. The proposal's "unknown id → `missing` with 200" became 404 when nothing at all matched, as the R10
brief required. Mixed batches still return 200.
