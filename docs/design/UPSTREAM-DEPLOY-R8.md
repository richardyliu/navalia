# UPSTREAM-DEPLOY-R8 — Deploying Workflow structuring (R8) to the real `~/.persome` (2026-11-05)

Authorization: DECISIONS-ROUND3 (local deployment allowed; no push, no PR, no release). Evidence: `docs/test-evidence/PHASE3/r8-deploy/`.

## 1. Code

| Item | Value |
|---|---|
| Repository | `~/Documents/GitHub/personal-model-og` |
| Merge | `og/upstream-fixes` fast-forwarded from `03698b5` to `og/r8-workflow-structure` `4e83ce8` (3 commits: `d47d914`, `48ed7ee`, `4e83ce8`) |
| Local tag | `deploy/2026-11-05-r1r8` → `4e83ce8` (not pushed) |
| schema | Unchanged: `2026-11-05.3` (R8 does not change the DB; the structure lives in the skill entry's Markdown and is parsed at read time) |
| Upstream pytest (offline, `env -i`, temporary HOME, `PERSOME_LLM_MOCK=1`) | **2595 passed / 0 failed / 1 skipped / 17 deselected**, no `.persome` under the temporary HOME (`01-pytest-offline.txt`) |

## 2. Backup (DEPLOY-02 procedure)

- Shutdown: `persome stop` (SIGTERM pid 57832) → SIGTERM to every `persome mcp` process (no -9) → confirmed no persome processes, nothing listening on 8742, `lsof index.db` empty. Lens was not running at the time.
- **BACKUP = `/Users/ryl/Persome Backups/20261105-173654-pre-r8`** (chmod 700)
  - `data/`: byte copy of index.db plus -wal/-shm, `index.consolidated.db` (produced via `.backup` from a temporary copy), memory/, backup/, capture-buffer/, config.toml (with .bak), env, HUMAN.md, model-build.json
  - `venv-r7/` (879M): the R1–R7 venv, for rollback
  - The live `index.db` sha256 was identical before and after the copy: `560021a39673b77464487710ce458d4bef2e15a10ca3757b204a1d543a1653cd`
  - consolidated: `quick_check=ok`, schema `2026-11-05.3`, entries 137, evo_nodes 49, captures 2708, relation_edges 187, model_candidate_points 0, relation_edge_evidence 0
  - `manifest.sha256` (16 files, excluding capture-buffer) all OK under `shasum -c`
  - Record: `02-backup.txt`

## 3. Deployment

`PERSOME_INSTALL_HOME="$HOME/.persome" PERSOME_ROOT="$HOME/.persome" bash install.sh --update --no-client-config < /dev/null` → rc=0, took about 50 s (`03-install.txt`).

After deployment (`04-post-deploy.txt`):
- Runtime process pid 95506, OCR worker 95551; `/health` returns `status=ok, ocr=ready, ocr_worker=ready, capture_pipeline=ok`
- `quick_check=ok`, schema `2026-11-05.3`, counts unchanged (137 / 49 / 2708 / 187)
- The installed package contains `persome/writer/workflow_structure.py`, and `prompts/pattern_detector.md` contains the evidence pointer rules
- doctor: only one ⚠, the LLM daily quota is used up (200/200)
- `model status` same as before deployment: points=49 lines=46 faces=0, issues are no_faces / no_volumes / no_root

Note: this shutdown sent SIGTERM to `persome mcp` processes in other Claude Code sessions; those sessions need a restart before they connect to the new venv.

## 4. Real Workflow run — **BLOCKED (LLM budget)**

- Real `behavior_patterns` (read-only connection, `05-behavior_patterns-real.txt`): `skills=0`, `faces=0`, `root=null`. There are no `skills/skill-*.md` files under `memory/`, so there is currently no real Workflow to structure.
- pattern_detector requires a candidate to appear on ≥3 distinct local dates (`pattern_detector.py:37` `MIN_DISTINCT_DATES = 3`). timeline_blocks cover 3 local dates in total: 2026-09-21 (111 blocks), 11-04 (329 blocks), 11-05 (192 blocks). So it is possible in terms of dates, but whether a specific behavior shows up on all 3 days is only known after a real run.
- pattern_detector calls the LLM (step 2, LLM validation), and `[agent_funding]` was at 200/200 for the day. The quota is counted per local date (`agent_cli.py:318`) and resets at local midnight (2026-11-06 00:00 PST). This round did **not** change the cap or reset the usage file (DECISIONS-ROUND3 §3).
- Conclusion: **R8 is deployed, but no real structured Workflow has been produced yet**. No structure was fabricated.

### Verification steps once the quota recovers (for the user or the next round)

```bash
# 1. Confirm the quota
~/.local/bin/persome doctor | grep "Agent-funded"            # expect <200/200
# 2. Let session finalize or build run pattern_detector once (calls the Runtime LLM, spends quota)
~/.local/bin/persome model build
# 3. Read the results (read-only)
~/.persome/venv/bin/python -I -c "import sqlite3,json,os;from persome.mcp import server;c=sqlite3.connect('file:'+os.path.expanduser('~/.persome/index.db')+'?mode=ro',uri=True);d=server._behavior_patterns(c);print(json.dumps([{k:s.get(k) for k in ('steps','artifacts','rules','problems','structure_dropped')} for s in d['skills']],ensure_ascii=False,indent=1))"
# 4. Resolve each steps[].evidence[] with MCP resolve_evidence; view it on the Lens Playbook page
```
Pass criteria: at least one skill has non-empty `steps`, artifacts/rules/problems each have at least one item, and every pointer resolves via `resolve_evidence`. If the LLM does not follow the format, the result is an empty list with `structure_dropped` recorded; that counts as an R8 real-run FAIL, not a fabricated PASS.

## 5. Rollback

R8 did not change the schema, so rolling back the venv is enough:

```bash
B="/Users/ryl/Persome Backups/20261105-173654-pre-r8"; TS=$(date +%Y%m%d-%H%M%S)
~/.local/bin/persome stop; pgrep -f 'persome mcp' | xargs -r kill -TERM
mv ~/.persome/venv ~/.persome/venv.failed-$TS && rsync -a "$B/venv-r7/" ~/.persome/venv/
~/.local/bin/persome start && curl -fsS http://127.0.0.1:8742/health
```
If data needs rolling back, follow `UPSTREAM-DEPLOY.md` DEPLOY-06 step 2 with `BACKUP` set to the path above (`data/index.db` plus wal/shm, or `data/index.consolidated.db`). Earlier rollback points: `20261105-154335-pre-r7` (`venv-r6`), `20261105-145247-pre-r1r6` (`venv-old`, 0.3.2).

## 6. R9 — Lineage backfill for existing data (deployed and applied to real data)

**Why not `persome model build`:** the Point→candidate link is only written when `writer/delta_apply.py` promotes a candidate (`link_point`, around lines 454, 1299, 1368). The `evomem_baseline` stage of `model build` returns `already_initialized` when nodes already exist and does not re-promote existing Points. Measured on a copy (`PHASE3/r9-lineage/model-build-only.txt`): running only `model build` leaves the link rows at 0 and 0, and the usage ledger does not change. So rebuilding the model cannot fill in sources by itself, budget or not.

**Code (personal-model-og, local only):**
- `cc9da48` feat(model): adds a deterministic backfill `persome model backfill-lineage [--apply] [--json]` (`src/persome/model/lineage_backfill.py`), rule version `r9-lineage-1`. It does not call the LLM, does not create new Points or Lines, and does not write new quotes. Dry-run by default. Writes happen in a single `BEGIN IMMEDIATE` transaction inside the model build lock, and it can be rerun safely.
- `462361d` fix(evidence): if a Point is also an entry in `entries` (entry-backed), the entry route also returns its candidate sources (otherwise 10 Points still showed no source).
- Point rules: the candidate must be promoted; the node's filename and label shape must match what promotion generates; the text is identical, or `canonical_text` is identical; link to the root of the version chain for the same text; `root.gmt_created >= promoted_at`; the match is unique on both sides; skip if either side already has a link. `valid_from` is not backfilled, so as_of results already returned do not change.
- Line rules: only use observations in `memory_deltas` that were already applied, whose quote is identical to the quote already stored on the Line; skip closed Lines, multiple intervals with the same key, occurrence Lines, anything that would change shadow geometry, and Lines that already have evidence.
- Merge: `og/upstream-fixes` fast-forward `4e83ce8 → 462361d`, tag `deploy/2026-11-05-r1r9`. pytest offline **2622 passed / 0 failed / 1 skipped / 17 deselected** (`PHASE3/r9-deploy/01-pytest-offline.txt`).

**Backup:** `/Users/ryl/Persome Backups/20261105-180023-pre-r9` (data contains index.db+wal/shm, consolidated, memory/, backup/, capture-buffer/, config, env; plus `venv-r8/`; manifest all OK; live sha identical before and after the copy, `d58de440…a529`; on consolidated `quick_check=ok`, counts 137/49/2708/187, links 0/0). Record: `r9-deploy/02-backup.txt`.

**Deploy and apply:**
1. `install.sh --update --no-client-config` → rc=0 (`03-install.txt`)
2. Stop Runtime and all `persome mcp` (conservative: no other writers during the backfill)
3. `persome model backfill-lineage --json` (dry-run) → Point 38/38 (37 identical, 1 canonical match), Line 129 rows onto 107 edges; skipped: 35 without a quote, 42 occurrence, 3 closed. **Matches** the dry-run on the copy (`04-dryrun.json`).
4. `--apply --json` → wrote 38 and 129 (`05-apply.json`)
5. Verify (`06-post-apply-counts.txt`): `quick_check=ok`, schema unchanged, entries/evo/captures/edges unchanged, edge states unchanged (active 39, shadow 148); another dry-run → 0 to write (safe to rerun)
6. Start Runtime, `/health` ok. Real REST (`07-real-evidence-asof.txt`): **45/49 Points have sources**, 107/187 Lines have sources, as_of results at three points in time are identical to R7
7. Lens view model over the real responses (`08-lens-viewmodel-over-real.txt`): **no "Evidence unresolved" markers at all**

**Remaining gaps:** 4 `topic-agent-findings` l2_fact entries (memories written by `remember`, no candidate; their source is their own entry); 42 occurrence Lines and 3 closed Lines have no window evidence; backfilled Points use `gmt_created` as the as_of start, while Points promoted live use the earliest evidence window; `linked_at` records the backfill time.

**R9 rollback:** the backfill only added rows to two link tables. To undo, restore `index.db` from `20261105-180023-pre-r9/data/` per DEPLOY-06 step 2; to return to the R8 code, replace the venv with `venv-r8/` (same procedure as §5).
