# HABIT-3-DATES — admit a habit only with evidence on ≥3 distinct dates

Target: `personal-model` (OSS Runtime), checked read-only against the working tree at commit `b7a28ff` (2026-08-11, v0.3.2 line), the same commit as `MOD-07.md`.
Status: **not submitted, not applied. Submitting it needs user approval (DECISIONS-ROUND2 X10; the rule itself is X6).** Lens does not edit the Runtime repo. This doc is the issue text plus a suggested patch.
Related: DEVIATIONS D24, `docs/design/s1-log/S1-05.md`, Lens `src/renderer/src/components/workflows/habit.ts`.

## Motivation

The S1 article treats a behaviour as a stable habit only when it has evidence on at least 3 different dates (as summarized in GAP-vs-S1 U2 and D24; I did not re-read the article for this note). The Runtime admits a behaviour at **two observations, and none of its gates counts calendar dates**. Lens works around this by labelling anything under 3 dates "Observing (fewer than 3 distinct dates)", and anything without dates (every Face) "Dates unknown" (S1-05). That leaves the Runtime and every other MCP client still treating 2-observation patterns as established.

## Current behaviour (verified in source)

| # | Where | What it does |
|---|---|---|
| 1 | `src/persome/prompts/pattern_detector.md:20` | Admission rule given to the LLM: "At least two independent observations support it. Repetition inside one long session is one observation." It counts observations, not dates. |
| 2 | `src/persome/config.py:201` (`PatternDetectorConfig.min_occurrences: int = 2`), documented default at `config.py:740` | Candidate pre-filter only. Used in `writer/pattern_detector.py:80` → `_collect_candidates` (`:116-180`) → `_find_repeated_app_sequences` (`:316`), `_find_repeated_captures_field` (`:382`), `_find_time_clusters` (`:441`). Each compares a raw **count** of blocks / captures / sessions with `min_occurrences`. Two blocks one minute apart pass. |
| 3 | `src/persome/store/schema_faces.py:683` (`maybe_promote(..., min_observations: int = 2)`), checked at `:705` | Face/Volume residency gate: `observations >= 2 ∧ len(footprints) >= 2 ∧ stability >= 0.6` (+ provenance). `observations` is a monotone counter (`:71`, `+1` at `:575`). No date is stored per observation. Callers use the default: `writer/schema_miner_stage.py:432`, `writer/cross_domain_sweeper.py:532,545,555,566`. |
| 4 | `src/persome/mcp/server.py:378` `_behavior_patterns`, faces serialized at `:449-457` | Exposes `signature, level, provenance, observations, confidence`. No dates, so a client cannot apply a date rule to Faces. |

Notes from reading the code:

- In (2), `_find_time_clusters` groups by `(hour, weekday)` (`pattern_detector.py:433`) over `lookback_days = 7` (`config.py:199`, used at `pattern_detector.py:71`). In a 7-day window each weekday occurs at most twice, and usually once, so **a time cluster can never reach 3 distinct dates under the current lookback**. A date rule must change either the key or the lookback for this category (see patch §2).
- In (3), the moments when Face observations are counted are extractor runs (schema miner / sweeper). The dates of those runs approximate, but are not, the dates the behaviour happened. A per-observation date recorded at write time is still better than no date. The exact fix (dates of the member facts) is out of scope here.
- `schema_faces._now()` returns UTC (`schema_faces.py:124-125`). A "distinct date" must be bucketed in the owner's local timezone, or a late-evening habit in UTC+8 splits across two UTC dates.

## Suggested patch (minimal; NOT applied)

### 1. Prompt (`src/persome/prompts/pattern_detector.md`)

```diff
-1. At least two independent observations support it. Repetition inside one long session is one observation.
+1. Independent observations on at least three distinct local calendar dates support it. Repetition inside one session, or several sessions on the same date, counts as one date.
```

In the entry-format example (`pattern_detector.md:45-52`), have `**Evidence**` list the dates, e.g. `5 sessions on 4 dates (2026-08-03, 08-04, 08-06, 08-07); receipts …`. Lens already parses the Chinese "N distinct dates" phrase / "across N days" as a declared-text fallback (S1-05 §3), so listing explicit dates lets clients verify the claim instead of trusting it.

### 2. Candidate pre-filter (`config.py`, `writer/pattern_detector.py`)

```diff
 @dataclass
 class PatternDetectorConfig:
@@
     min_occurrences: int = 2
+    # Distinct local calendar dates a candidate must span before LLM validation.
+    # 1 restores the pre-change behaviour.
+    min_distinct_dates: int = 3
```

Add the same key under `[pattern_detector]` in the documented default (`config.py:736-741`).

In `_collect_candidates` (or in each `_find_*` helper), after counting keep only the candidates whose example timestamps span `>= min_distinct_dates` local dates:

```diff
+def _local_dates(timestamps: Iterable[str]) -> set[date]:
+    out: set[date] = set()
+    for ts in timestamps:
+        try:
+            out.add(datetime.fromisoformat(ts).astimezone().date())
+        except (TypeError, ValueError):
+            continue
+    return out
```

Caveat: the helpers keep only `examples[:5]` (`pattern_detector.py:322,388,449`). Count dates over **all** matching timestamps before truncating, not over the 5 examples.

For `time_clusters`, either key on `hour` alone, or keep `(hour, weekday)` and require `lookback_days >= 15` for that category. Otherwise, as noted above, it can never pass.

### 3. Face residency (`store/schema_faces.py`)

```diff
 _EXTRA_COLUMNS: tuple[tuple[str, str], ...] = (
     ("anchors", "TEXT NOT NULL DEFAULT '[]'"),
+    # Distinct local dates (YYYY-MM-DD) on which an observation was recorded.
+    ("observation_dates", "TEXT NOT NULL DEFAULT '[]'"),
 )
```

- In `_record_face` (`:486`), on INSERT write `[local_date(now)]`. On UPDATE (`:574-588`), union in `local_date(now)` and keep the list sorted and capped (e.g. last 60 dates).
- `maybe_promote` (`:679`):

```diff
 def maybe_promote(
     conn, face_id, *, min_observations: int = 2,
+    min_distinct_dates: int = 3,
     stability_threshold: float = STABILITY_THRESHOLD,
 ) -> bool:
@@
     if (
         provenance_ready
         and row["observations"] >= min_observations
+        and len(set(json.loads(row["observation_dates"] or "[]"))) >= min_distinct_dates
         and len(footprints) >= 2
```

- **Migration.** Existing `ACTIVE` rows are unaffected, because `maybe_promote` returns early for ACTIVE (`:697-698`). Existing `shadow` rows start at `[]` and need 3 new dated observations. That is the conservative choice; backfilling from `created_at` would invent dates.

### 4. Expose dates (`mcp/server.py` `_behavior_patterns`, `model/snapshot.py:250`)

Add `"observation_dates": [...]` next to `"observations"`. That lets Lens (and any MCP client) show "Stable habit · N distinct dates" for Faces instead of "Dates unknown".

## Tests to add upstream

Style follows `tests/test_schema_faces.py::TestStabilityGateAndPromotion` and `tests/test_pattern_detector.py::test_collect_candidates_finds_app_sequences` (which today passes `min_occurrences=2`).

- `pattern_detector._collect_candidates`: 3 timeline blocks with the same app set **on one date** → no `app_sequences` candidate; the same 3 blocks on 3 dates → one candidate. Repeat for `repeated_titles` / `repeated_urls`.
- Dates are counted before `examples[:5]` truncation: 6 hits on day 1 + 1 hit each on days 2 and 3 → passes.
- Local-date bucketing: two timestamps 23:30 and 00:30 local (same UTC date or not, depending on tz) count as 2 local dates. Run with a fixed `TZ`.
- `min_distinct_dates=1` reproduces today's candidate set (back-compat).
- `schema_faces`: both-provenance, stable footprints, `observations=3`, all recorded on one date → `maybe_promote` is False. The same on 3 dates (monkeypatch `_now`) → True, idempotent.
- `ensure_schema` on a pre-change DB adds `observation_dates` with `'[]'`. An ACTIVE row stays ACTIVE. A shadow row does not promote until 3 dated observations.
- `_behavior_patterns()` output includes `observation_dates` for each face.
- Prompt regression: the admission rule text says "three distinct" (a string assertion, so the rule can't silently drift back).

## Impact and trade-offs

- **Fewer, later habits.** A real habit needs at least 3 days to appear, and cold start gets slower. The prompt already says "Cold start should bias toward skipping" (`pattern_detector.md:25`), so this is the same direction, only stricter.
- **The LLM stays the final judge in (1).** A prompt rule is not enforced. Pass (2) guarantees that what the LLM sees already spans 3 dates, but the LLM can still write a pattern from `event_memory` candidates, which have no count gate (`pattern_detector.py:176-178`). A deterministic post-check on written `skill-*.md` evidence dates would close that gap. It is larger and not proposed here.
- **Face dates are write dates** (see the notes above). That is honest when labelled, and imperfect.

## What Lens does until then

Unchanged (X6): Lens labels by distinct dates it can derive itself, says "Observing" / "Dates unknown", and never writes the Runtime.
