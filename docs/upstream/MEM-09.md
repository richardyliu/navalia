# MEM-09 — `verify_fact` cannot tell the current version: version updates are never flagged and `age_days` ignores `occurred_at`

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MEM-09/2026-11-05-raw.json`)
- Entries "Atlas current release version is 0.2" (occurred_at −40 d) and "… is 0.3" (occurred_at −1 d). `verify_fact("… is 0.2")` returns 0.2 first, both `age_days=0`, `stale=false`, no contradiction.
- `contradiction_check.find_candidate_pairs` only judges pairs with char-bigram similarity in [0.30, 0.92]; this pair is 0.931, treated as a near-duplicate and never judged. So the most common "current version" update can never reach the ledger.
- `mcp/server._age_days` uses the write `timestamp` even when `occurred_at` is present.
(The contradiction leg works: an in-band ownership conflict is returned with `conflicted=true`, reason and competing claim.)

## Suggested fix
1. `_age_days`: prefer `occurred_at` when present (and sort evidence by it).
2. Route high-similarity pairs that differ in a number/version/date token to the judge instead of dropping them as duplicates (or add a deterministic "same template, different value" rule).
