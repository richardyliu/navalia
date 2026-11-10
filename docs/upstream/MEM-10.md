# MEM-10 — `read_memory` has no cursor or size bound

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MEM-10/2026-11-05-raw.json`)
A 400-entry file (~260 chars per entry): `read_memory(path)` returns all entries, 176,566 chars; `tail_n=100000` is clamped to 500, so the same 176,566 chars. Other tools are bounded (search 50, search_captures 50, recent_activity 200, get_model_snapshot limit ≤ 100 with cursor and a byte budget, section=full refused).

## Suggested fix
Give `read_memory` a default `limit` (e.g. 50 entries) plus an opaque `cursor`, and the same result byte budget `model_projection` uses; return `has_more/next_cursor`.
