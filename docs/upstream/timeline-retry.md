# timeline-retry — re-normalize `llm_failed` timeline blocks

Target: `personal-model` Runtime, read-only at `/Users/ryl/Documents/GitHub/personal-model-og` branch `og/upstream-fixes` HEAD `462361d` (2026-11-05).
Status: **proposal only. Not applied, not submitted.** Lens does not edit the Runtime repo.
Evidence: `docs/test-evidence/PHASE5/workflow-face/DIAGNOSIS.md` (305 + 161 `llm_failed` blocks on 2026-11-04/05, mostly from the 200/day agent-funding cap).

## Problem

A timeline window whose LLM call fails is stored for good as `normalization_status='llm_failed'` with heuristic entries (`src/persome/timeline/aggregator.py:667-720`). Nothing ever retries it:

| # | Where | Why the block is stuck |
|---|---|---|
| 1 | `timeline/tick.py:31-46` `_run_once` | Only builds windows after `store.get_latest_end`, so past windows are never revisited. |
| 2 | `timeline/aggregator.py:602` → `timeline/store.py:166` `has_window` | Any existing row for the window, whatever its status, makes `produce_block_for_window` return `None`. |
| 3 | `timeline/store.py:179` `INSERT OR IGNORE` + `UNIQUE(start_time,end_time)` | Even a forced call cannot replace the row. |
| 4 | `cli.py:3494` `persome timeline tick` | Same `_run_once`; no flag for failed windows. |

Consumers exclude these blocks (`MODEL_ELIGIBLE_NORMALIZATION_STATUSES = {"legacy","llm","imported"}`, `timeline/store.py:95`; `writer/pattern_detector.py:265,330`). A transient outage (budget cap, provider `exited 1`) therefore removes those minutes from habit and date evidence forever. Here that cut a 2-date dataset that could have been richer: 1 → 21 app combos spanning both dates (DIAGNOSIS §5).

## Minimal change

### 1. `timeline/aggregator.py`: factor out the LLM step, add `renormalize_block`

Move the body from `system_text = …` (`:655`) through the `normalization_status` decision (`:720`) into `_normalize(cfg, parsed, start, end) -> (entries, skill_hints, action_trace, status)`. `produce_block_for_window` keeps calling it unchanged. Add:

```python
RETRYABLE_STATUSES = ("llm_failed", "llm_malformed")

def renormalize_block(cfg: Config, *, start: datetime, end: datetime) -> str | None:
    """Re-run the timeline LLM for one existing retryable window. Returns new status or None."""
    with fts_store.cursor() as conn:
        row = conn.execute(
            "SELECT normalization_status FROM timeline_blocks"
            " WHERE persome_epoch(start_time)=persome_epoch(?) AND persome_epoch(end_time)=persome_epoch(?)",
            (start.isoformat(), end.isoformat()),
        ).fetchone()
    if row is None or row[0] not in RETRYABLE_STATUSES:
        return None                                   # idempotent: llm/metadata_only/absent untouched
    parsed = _load_captures(captures_in_window(start, end))
    if not parsed:
        return None                                   # buffer evicted → stays llm_failed (honest)
    entries, hints, trace, status = _normalize(cfg, parsed, start, end)
    if status != "llm":
        return status                                 # do not overwrite with another failure
    with fts_store.cursor() as conn:
        cur = conn.execute(
            "UPDATE timeline_blocks SET entries=?, skill_hints=?, action_trace=?, normalization_status='llm'"
            " WHERE persome_epoch(start_time)=persome_epoch(?) AND persome_epoch(end_time)=persome_epoch(?)"
            "   AND normalization_status IN ('llm_failed','llm_malformed')",   # compare-and-set
            (json.dumps(entries), json.dumps(hints), json.dumps(trace), start.isoformat(), end.isoformat()),
        )
        if cur.rowcount == 1:
            session_store.set_system_state(conn, "model_structure_dirty", "1")
    return status
```

Do not touch `apps_used`, `capture_count`, `focus_*`, `attention_*`: they are computed deterministically from the same captures. Skill-hint echo (`_echo_skill_hints`) only runs on a successful update.

### 2. `timeline/tick.py`: `retry_failed(cfg, *, since, until, max_calls)`

```python
def retry_failed(cfg, *, since: datetime, until: datetime, max_calls: int) -> dict[str, int]:
    rows = SELECT start_time,end_time FROM timeline_blocks
           WHERE normalization_status IN ('llm_failed','llm_malformed')
             AND persome_epoch(start_time) >= persome_epoch(:since)
             AND persome_epoch(end_time)   <= persome_epoch(:until)
           ORDER BY persome_epoch(start_time) LIMIT :max_calls
    # sequential (no ThreadPool) so the cap is exact; stop on AgentFundingBudgetExceeded
```

- **Budget cap.** `max_calls` is required and hard (default 20, max 500). One LLM call per block, no tool loop. Before the loop, read `agent_cli.usage_status(cfg.agent_funding)` and clamp to `remaining`. On the first `AgentFundingBudgetExceeded`, stop at once rather than burn the cap again (the failure mode that created these rows).
- **Idempotency.** The status filter plus the compare-and-set `UPDATE` (§1) means a re-run, a crash midway, or a race with the live tick never double-writes or downgrades a row. Rows already `llm` are never selected.
- **Data availability.** Retry only works while the capture buffer still holds the files: `buffer_retention_hours` (168h here), `buffer_max_mb` eviction. Report `skipped_no_captures` separately.

### 3. CLI (`cli.py`, next to `timeline_tick_cmd` at `:3494`)

```
persome timeline retry-failed --since 2026-11-04 --until 2026-11-06 --max-calls 20 [--dry-run]
```

`--dry-run` prints per-local-date counts of retryable rows and buffer coverage, and makes 0 LLM calls. Output: `retried=…, upgraded=…, still_failed=…, skipped_no_captures=…, calls=…`.

### 4. Downstream

- Set `model_structure_dirty` (above) so the daemon refresh (`session/tick.py:576-603`) rebuilds.
- Already-modeled sessions are **not** re-reduced (that would repeat memory_delta calls). The pattern detector reads `timeline_blocks`/`captures` directly over its 7-day lookback (`pattern_detector.py:254-345`), so upgraded blocks count at the next session finalization. A follow-up could add an opt-in `--remodel-sessions`.

### 5. Tests (upstream `tests/test_timeline_blocks.py`)

1. `llm_failed` row + buffer present + fake LLM success → status `llm`, entries replaced, second run is a no-op (0 LLM calls).
2. Row `llm` / `metadata_only` → never selected.
3. Fake LLM raises `AgentFundingBudgetExceeded` on call 2 of 5 → loop stops, 1 upgraded, 4 untouched.
4. Buffer evicted → `skipped_no_captures`, row unchanged.
5. Concurrent `UPDATE` race → the CAS loser has rowcount 0 and the status is unchanged.

## Cost for the current data (if it existed)

| Scope | Retryable rows | LLM calls |
|---|---|---|
| 11-04 local | 305 | ≤305 |
| 11-05 local | 161 | ≤161 |
| Both | 466 | ≤466 (1 per block) |

That is far above a 40-call task budget. A capped run (`--max-calls 20`, spread over both dates) would upgrade ≤20 blocks. Picking blocks whose app combo also appears on the other date maximizes date-spanning candidates. The retry adds evidence; it does **not** add dates (11-04 and 11-05 are already valid). See DIAGNOSIS §5.
