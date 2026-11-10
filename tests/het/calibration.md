# HET calibration (E3.7)

Status: **UNKNOWN** — pending the user's review. Nothing here is validated; the estimate column is
the implementing agent's own guess, not a measurement.

- Tasks are synthetic descriptions (no real transcript content).
- Anchor minutes = `DEFAULT_ANCHORS` v1 × size units × complexity factor at adoption `confirmed` (weight 1.0),
  so the comparison isolates kind/size/complexity. Real tasks are further multiplied by the adoption weight
  (strong 0.85, weak 0.55, unknown 0.3).
- Buckets: size xs/s/m/l/xl = 0.25/0.5/1/2/4 anchor units; complexity low/medium/high = 0.75/1/1.5 (DEVIATIONS D7).
- Ratio = estimate ÷ anchor. > 1 means the anchors under-count compared with the estimate.
- Locked by `tests/het/calibration.test.ts` (anchor column and ratios must match `calibration.data.ts`).

| id | task | kind | size | complexity | anchor min | estimate min | ratio |
|---|---|---|---|---|---|---|---|
| C01 | Fix a typo and a broken link in a README | writing | xs | low | 5.6 | 3 | 0.54 |
| C02 | Write a ~500-word release note from a changelog | writing | m | medium | 30.0 | 45 | 1.50 |
| C03 | Draft a ~2000-word design doc with trade-offs | writing | xl | high | 180.0 | 240 | 1.33 |
| C04 | Translate ~1000 words of user docs | writing | l | medium | 60.0 | 60 | 1.00 |
| C05 | Rename a variable across 3 files | coding | xs | low | 8.4 | 10 | 1.19 |
| C06 | Fix an off-by-one bug and add a regression test (~15 lines) | coding | xs | medium | 11.3 | 45 | 3.98 |
| C07 | Add a CLI flag with tests (~80 lines) | coding | s | medium | 22.5 | 60 | 2.67 |
| C08 | Implement a parser/adapter with tests (~400 lines) | coding | l | high | 135.0 | 240 | 1.78 |
| C09 | Build a new subsystem with storage + UI (~1200 lines) | coding | xl | high | 270.0 | 960 | 3.56 |
| C10 | Look up one API detail and answer | research | xs | low | 3.8 | 5 | 1.32 |
| C11 | Compare 3 libraries and recommend one | research | s | medium | 10.0 | 45 | 4.50 |
| C12 | Survey ~10 sources into a sourced brief | research | l | high | 60.0 | 180 | 3.00 |
| C13 | Review a short doc and leave comments | review | s | low | 7.5 | 10 | 1.33 |
| C14 | Review a ~150-line PR | review | m | medium | 20.0 | 30 | 1.50 |
| C15 | Review a ~1500-line PR touching auth | review | xl | high | 120.0 | 150 | 1.25 |
| C16 | Restart a service and clear a full disk | ops | xs | low | 1.9 | 5 | 2.63 |
| C17 | Set up a CI workflow from scratch | ops | m | high | 15.0 | 60 | 4.00 |
| C18 | Migrate a database with backup and verification | ops | l | high | 30.0 | 90 | 3.00 |
| C19 | Summarise a 30-minute meeting into notes + actions | meeting | m | medium | 1.0 | 15 | 15.00 |
| C20 | Prepare a short meeting agenda | meeting | s | low | 0.4 | 10 | 25.00 |

## Largest disagreements and the factor I would adjust (proposals, not applied)

1. **C19, C20 (meeting, ratio 15–25).** This is a unit mismatch, not a tuning problem. The meeting anchor is
   "1 min per minute" (DESIGN §5.6), but the assessor emits a size bucket, so `m` is read as 1 minute. Fix:
   either derive meeting size deterministically from attended minutes (D6 timeline) instead of a bucket,
   or redefine the meeting anchor unit to "per meeting" at about 15 min.
2. **C11, C12 (research, ratio 3.0–4.5).** The research anchor (20 min per 5 sources) is low for
   comparison and synthesis work. Adjust the **research anchor 20 → 40**.
3. **C17, C18, C16 (ops, ratio 2.6–4.0).** "10 min per task" fits trivial ops only. Adjust the **ops anchor 10 → 25**,
   or let `high` complexity weigh more for ops.
4. **C06, C09 (coding, ratio 3.6–4.0).** Two different failures. C06: debugging time dominates and line
   count barely matters, so `xs` × `medium` under-counts. C09: the size curve tops out at 4 units. Adjust
   the **size curve** (xs 0.25 → 0.5, xl 4 → 8) rather than the coding anchor. This also moves the other kinds,
   so re-check writing (C01 is already over-counted at 0.54).

Overall: outside meetings, the median ratio is about 1.5–2 (anchors under-count), and writing is the
closest kind. One more caveat: my estimates are a single unvalidated opinion, so the user's review decides.
