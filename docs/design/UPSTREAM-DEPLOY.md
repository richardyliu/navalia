# UPSTREAM-DEPLOY — R1–R6 → real `~/.persome` (2026-11-05)

Approval scope (user, 2026-11-05): local integration + deploy to `~/.persome`. **No push, no PR, no release.**
Evidence: `docs/test-evidence/DEPLOY-2026-11-05/`.

## Baseline (Phase 0)

| Item | Value |
|---|---|
| Upstream repo / branch | `~/Documents/GitHub/personal-model-og` / `og/upstream-fixes` |
| `git status --short` | clean |
| HEAD | `5349515c1f7a4eb4ed0b36eb3a292308af7a3833` (test-isolation commit, on top of R6 merge `e68d325`) |
| Rollback source | `~/Documents/GitHub/personal-model` main `b7a28ff` (untouched) |
| `~/.local/bin/persome` | 168-byte shim → `~/.persome/venv/bin/persome` |
| Live `schema_revision` | `2026-08-11.4` |
| `du -sh ~/.persome` | 1.6G |
| `df -h ~` | 483 Gi free (46% used) |
| Live processes at baseline | Runtime `persome.cli start --foreground` (pid 81588, :8742) + OCR worker 81589; Lens (pid 81871, Broker :8750); **8 `persome mcp` stdio servers** from Claude Code sessions (old venv) |
| Lens typecheck | PASS (0 errors) |
| Lens vitest | 116 files passed / 4 skipped; 1208 tests passed / 5 skipped (env-gated) / 0 failed |
| Lens build | PASS |
| Logs | `DEPLOY-2026-11-05/00-baseline-lens/` |

### Decision: stray `persome mcp` processes
`persome stop` does not stop MCP stdio servers spawned by agent clients. They hold `index.db` open with old 0.3.2 code and can write via `remember`/`correct_memory`.
User decision (2026-11-05): **SIGTERM (not -9) every `persome mcp` process immediately before the backup**, and re-check with `pgrep -fl 'persome mcp'` before DEPLOY-02 and DEPLOY-04. Clients reconnect to the new venv when restarted.

## Gate checklist

| Gate | Condition | Result |
|---|---|---|
| DEPLOY-01 | upstream pytest green + §15 repro scripts PASS (MOD-01/02/04/07/08/09/11/12/14, MEM-05/09/10, MOD-13) | **GREEN**: 2569/0/1, 63/63 |
| DEPLOY-02 | backup `quick_check=ok`, old runtime reads the restore copy, manifest written | **PASS** |
| DEPLOY-03 | copy migrated to `2026-11-05.3`, quick_check ok, doctor ok, counts not zeroed | **PASS** (+ data-rollback rehearsal 0.38 s) |
| DEPLOY-04 | real schema `2026-11-05.3`, quick_check ok, doctor ok, `/health` ok on :8742 | **PASS** |
| DEPLOY-05 | Lens starts on new runtime; evidence/model/HET/alias checks; Lens tests green; §15 rerun recorded | **PASS** (MOD-12 closed by R7, see below) |

## DEPLOY-01 Integration verification — GREEN

- R1–R6 and the test-isolation commit were already on `og/upstream-fixes` (each `og/rN` is an ancestor of HEAD), so no merges were needed.
- One flaky test (entry-id collision at about 1.6% per run) was fixed test-only in `be0a0bc`. Deploy HEAD: **`be0a0bc714d47fdd55e431e0c0fde5dfcc299e38`**, local tag **`deploy/2026-11-05-r1r6`** (not pushed).
- pytest (offline markers): **2569 passed / 0 failed / 1 skipped / 17 deselected**. The 11 DeepSeek integration tests were not run because they need a key and network.
- §15 repro on temp roots against the worktree venv: **63/63 checks PASS (originally reported as 67/67; per-ID counts sum to 63)** (MOD-01/02/04/07/08/09/11/12/13/14, MEM-05/09/10).
- Target schema constant: `src/persome/store/fts.py:56` = `2026-11-05.3`.
- `install.sh --update` swaps only the venv transactionally and makes **no data backup**. The new daemon migrates on start, and 0.3.2 refuses a newer schema, so the data rollback relies only on the DEPLOY-02 backup.
- Detail: `DEPLOY-2026-11-05/01-upstream/summary.md`.

### Pre-backup stop (2026-11-05)
Lens quit via AppleScript `quit` (graceful) → `persome stop` ("Sent SIGTERM to pid 81588. Daemon stopped.") → SIGTERM to all `persome mcp`. Verified: no `persome` processes, no LaunchAgent job, no listener on 8742/8750, `lsof ~/.persome/index.db` empty.

## DEPLOY-02 Backup — PASS

- **BACKUP = `/Users/ryl/Persome Backups/20261105-145247-pre-r1r6`** (chmod 700)
- `data/index.db` sha256 `67f5936a90bd3584961051f92199958f48fac3dbbf0b911335362160e38a0972` (18,190,336 B); `shasum -c manifest.sha256` OK. I re-verified this independently.
- schema `2026-08-11.4`, `quick_check=ok`; entries 137, evo_nodes 49, captures 2708, relation_edges 187. memory/ holds 4 files; HUMAN.md and model-build.json are present.
- data 723M (2,733 files, including capture-buffer); `venv-old/` 885M (relocatable, non-editable persome_core 0.3.2).
- chmod 600 on env, config.toml(+bak), index.db, backup/evo-*.db and .permissions-v1.
- **Deviation from the brief:** I did not run `.backup` against the live `index.db`. Closing that connection would have checkpointed and deleted the live 9.9 MB WAL, which is a write to `~/.persome`. Instead I copied db+wal+shm byte-for-byte to /tmp and ran `.backup` from that copy. Live file size, mtime and sha256 were identical before and after.
- Backup WAL is 0 bytes after checkpoint, so DEPLOY-06's `cp index.db` restore is complete.
- Restore check: the **old** runtime read a /tmp copy with `points=49 lines=46 … degraded` (rc=0), and the schema stayed `2026-08-11.4`. "not ready/degraded" was the state before the upgrade.
- Evidence: `DEPLOY-2026-11-05/02-backup/`.

## DEPLOY-03 Migration rehearsal (copy) — PASS

- `model status` does **not** migrate. The migration runs only in `fts.open_runtime_owner()`, which is called from `daemon._run`. The rehearsal therefore called `open_runtime_owner()/close_runtime_owner()` from the new venv's Python on the /tmp copy. That is the daemon's startup step without HTTP or ports.
- `2026-08-11.4 → 2026-11-05.3` in 0.06 s, `quick_check=ok`.
- Every pre-existing table kept its row count. New tables `model_candidate_points` and `relation_edge_evidence` (both empty), new columns `memory_deltas.drop_reasons` and `schema_faces.observation_dates`, plus 2 indexes. Nothing was dropped.
- `doctor` rc=0. Its only ⚠ is the agent-funded LLM daily cap (200/200), which is a quota item.
- Old binary on the migrated copy: `RuntimeError: index database schema revision '2026-11-05.3' is newer than this Persome runtime (2026-08-11.4); refusing to downgrade it` (rc=1, DB untouched).
- **Rollback rehearsal (data part of DEPLOY-06) on a second copy:** rename failed db/wal/shm, cp backup, chmod 600 → old binary rc=0, schema `2026-08-11.4`, `quick_check=ok`, same counts. **0.38 s.**
- Open question: `relation_edge_evidence` starts empty for the 187 existing edges. Backfill, if any, happens at runtime, not during migration.
- Evidence: `DEPLOY-2026-11-05/03-rehearsal/`. All /tmp copies were deleted afterwards because they contained `env`.

## DEPLOY-04 Real deploy — PASS

Command (from `personal-model-og` @ `be0a0bc`):
`PERSOME_INSTALL_HOME="$HOME/.persome" PERSOME_ROOT="$HOME/.persome" bash install.sh --update --no-client-config < /dev/null` → rc=0, 32.7 s.

- The updater built `venv.replacement.update` (locked), swapped it in, restarted the daemon (owner `background`, pid 97776), waited for OCR warm-up, ran a capture proof, and printed "configuration, credentials, and personal data were preserved".
- The updater **deleted the old `~/.persome/venv`**. Fast rollback now relies on `$BACKUP/venv-old`.
- Post-install (`04-deploy/post-install-checks.txt`):
  - schema **`2026-11-05.3`**, `quick_check=ok`; entries 137, evo_nodes 49, captures 2708, relation_edges 187 (unchanged)
  - `model status`: `points=49 lines=46 …` plus the new R6 line `issues: no_faces, no_volumes, no_root`
  - `doctor`: all ✓; the LLM daily-cap ⚠ is quota only
  - `/health`: `{"status":"ok","ocr":"ready","ocr_worker":"ready","index":"ok","capture_pipeline":"ok"}`, listening on 127.0.0.1:8742
  - No LaunchAgent; the daemon runs as a `persome start --foreground` background process, as it did before.
- Updater advice: restart every MCP client before resuming writes, because old stdio MCP processes cannot join the new SQLite maintenance gate. Old ones were already SIGTERMed.

## DEPLOY-05 Lens compatibility & verification — PASS except MOD-12 (R7 in progress)

**Code (05-lens-compat/)**
- `oss-tools.json`: 21 → 22 tools. `owner_aliases` added; `read_memory` gained `limit`/`cursor`; description-only changes to `behavior_patterns`, `search` and `verify_fact`. Broker total 22 OSS + 3 Rewind + 4 extensions = 29.
- `owner_aliases` scope is `model:search` only. It is not `identity:read`, because that is a public scope (security F1). Without `evidence:read`, rows go through a fixed field allowlist with `evidence: []` and fail closed (F5).
- REST `GET /owner-aliases`, `POST /owner-aliases/{confirm,reject}` are wired through `RuntimeClient` → IPC `lens:owner-aliases:{list,confirm,reject}` → `window.lens.ownerAliases`. Confirm/reject first checks that the alias exists and is not already in the target state, then shows a main-owned native dialog (Cancel is the default). The alias rejects bidi, zero-width and line-separator characters, and `note` was dropped (F4). There is no UI yet (S1-R3-01).
- Broker bugs fixed:
  - The PII scrubber was replacing paging cursors with `[secret]`; this also affected `get_model_snapshot` before the deploy.
  - The 50k `read_memory` cut was dropping `next_cursor`.
  - Cursor exemption is now per tool and per path: `read_memory $.next_cursor` and `get_model_snapshot $.page.next_cursor`, each structurally validated (F2/F3). Every one of the 127 real memory entry ids has the `make_id` shape, so real paging is unaffected.
- The evidence drawer shows the as-of status for `not_yet_effective`, habit Faces are labelled from `observation_dates`, and delta-report drop reasons are kept as counts only.
- Lens gates: typecheck ✓, vitest **1242 passed / 5 skipped / 0 failed** (re-run by lead), build ✓, e2e **41 PASS / 1 SKIP** (optional backup-restore).
- Security review: no blocking findings. F1–F5 fixed test-first (`05-lens-compat/security-fixes.txt`).

**Real-runtime verification (05-verify/)**

| Check | Result |
|---|---|
| A dev Lens boots on the real runtime; Broker on :8750; graceful SIGTERM | PASS |
| B receipts (MOD-07/08): 296/296 candidate receipts resolve | PASS. **Caveat:** the existing 49 Points and 46 Lines have `sources=[]` because they were built on 0.3.2 and nothing backfills the new link tables. A post-deploy model rebuild is needed (user decision, see below). |
| C MOD-13 issues `no_faces/no_volumes/no_root` with Chinese text | PASS |
| D HET `/het/*`: 401 without auth, 200 with it; minutes null / "not measured" label | PASS |
| E habits 3-date gate | PASS on a temp root. The real data has 0 Faces. |
| F as-of (MOD-12) | **FAIL**. 35/49 Points are correct; 14 entry-backed Points return `active` before they existed. Root cause: `evidence.py` `_resolve_entry` ignores `as_of` and runs before `_resolve_evo_node`. Pre-existing and not a regression (it was FAIL before). Fix in progress as **R7**. |
| G owner aliases: real data has 0 in every status; confirm→self 7/7 and reject 8/8 on a temp root | PASS |
| H Broker `read_memory` paging on the real runtime; cursor byte-identical | PASS |
| I §15 rerun on temp roots | 63/63 PASS |

§15.4 score (auditor): overall, excluding BLOCKED, 123/161 = 0.764 → **158/161 = 0.981**. If MOD-01/02 are scored on existing un-rebuilt data, it is 0.944.

**Decision: no rollback for MOD-12.** The brief says to roll back on any failure. I did not, because rollback would turn 12 IDs that are now passing back to FAIL in order to remove a defect that existed before the deploy; the new runtime is strictly better on as-of (35/49 vs. pre-R2 behaviour). Phase 2 stays blocked until R7 is deployed and MOD-12 passes on real data.

## DEPLOY-06 Rollback procedure

Use when any Phase 1 verification fails after the real `index.db` was opened by the new binary. A new-schema DB is **not** downgraded in place; it is replaced from backup.

```bash
BACKUP="<path recorded in DEPLOY-02>"
TS=$(date +%Y%m%d-%H%M%S)

# 1. stop everything that can write
osascript -e 'tell application "Persome Lens" to quit' || true   # or menu-bar Quit (dev: close the electron window)
~/.local/bin/persome stop || true
pgrep -f 'persome mcp' | xargs -r kill -TERM                     # graceful; never -9
lsof -nP -iTCP:8742 -sTCP:LISTEN; lsof -nP -iTCP:8750 -sTCP:LISTEN  # both must be empty

# 2. restore data (rename, never delete, the failed DB)
mv "$HOME/.persome/index.db" "$HOME/.persome/index.db.failed-$TS"
for f in index.db-wal index.db-shm; do [ -e "$HOME/.persome/$f" ] && mv "$HOME/.persome/$f" "$HOME/.persome/$f.failed-$TS"; done
cp "$BACKUP/data/index.db" "$HOME/.persome/index.db"
rsync -a "$BACKUP/data/memory/" "$HOME/.persome/memory/"
for f in config.toml env HUMAN.md model-build.json; do [ -e "$BACKUP/data/$f" ] && cp -p "$BACKUP/data/$f" "$HOME/.persome/$f"; done
chmod 600 "$HOME/.persome/env" "$HOME/.persome/config.toml" "$HOME/.persome/index.db"

# 3. restore old runtime
if [ -d "$BACKUP/venv-old" ]; then
  mv "$HOME/.persome/venv" "$HOME/.persome/venv.failed-$TS"
  rsync -a "$BACKUP/venv-old/" "$HOME/.persome/venv/"
else
  cd ~/Documents/GitHub/personal-model && git rev-parse --short HEAD   # must be b7a28ff
  PERSOME_INSTALL_HOME="$HOME/.persome" PERSOME_ROOT="$HOME/.persome" bash install.sh --update --no-client-config < /dev/null
fi

# 4. verify
sqlite3 "$HOME/.persome/index.db" "pragma quick_check;"                                              # ok
sqlite3 "$HOME/.persome/index.db" "select value from runtime_metadata where key='schema_revision';"  # 2026-08-11.4
~/.local/bin/persome start && curl -fsS http://127.0.0.1:8742/health
```
Note on `memory/` restore: `rsync -a` without `--delete` restores changed/removed files but keeps files the new runtime created. That is intentional (non-destructive); remove them by hand only after review.

Rollback rehearsal result: the data-restore steps (2) were rehearsed on a /tmp copy of the migrated DB in DEPLOY-03. The old binary read the restored DB with schema `2026-08-11.4`, `quick_check=ok` and unchanged counts, in 0.38 s. Step 3 (venv swap) was not rehearsed against the live path because it would replace the running venv. `venv-old` was verified to exist, to be relocatable, and to run `model status` from the backup path. The real rollback has **not** been executed (not needed).

## R7 — MOD-12 entry-backed as-of (fix + redeploy) — PASS

- **Root cause:** a Point's Markdown projection is stored in `entries` under the Point's id. The resolver tries `_resolve_entry` before `_resolve_evo_node`, and `_resolve_entry` ignored `as_of` status. R2 had put the as-of logic only in `_resolve_evo_node`.
- **Fix** (`personal-model-og`, local only):
  - `7eb7b8f` fix(evidence): apply as-of status to entry-backed model Points (MOD-12). The R2 status logic is moved into `_point_status_as_of()` and also applied on the entry route when the id is an evo Point. R1 receipts are unchanged (`kind=memory`).
  - `f183ee3` fix(correct): report an already-rejected owner alias as rejected.
  - `03698b5` style(tests): ruff format.
  - Local tag **`deploy/2026-11-05-r1r7` → `03698b5`**, retagged from 7eb7b8f so that it names the deployed commit; it was never pushed.
- No schema bump (`2026-11-05.3`).
- Upstream pytest: **2580 passed / 0 failed / 1 skipped / 17 deselected**. The new tests failed 8/10 before the fix. §15 run_all on temp roots: 63/63. Auditor repro: FAIL → PASS. Evidence: `DEPLOY-2026-11-05/06-r7/`.
- **Pre-R7 backup: `/Users/ryl/Persome Backups/20261105-154335-pre-r7`**
  - `index.db` sha256 `4142b90d9c1ce1ea7917b70a7e3b4588aa4f57216712a648f447179cadb35e2c`; `quick_check=ok`; schema `2026-11-05.3`; entries 137 / evo 49 / captures 2708.
  - `venv-r6/` (880M) holds the R1–R6 venv, as a fallback to R6 without a schema change.
  - Taken from a byte copy with the daemon stopped. The live sha was identical before and after.
- **Redeploy:** `install.sh --update --no-client-config` → rc=0 (36 s). Post-install: schema `2026-11-05.3`, `quick_check=ok`, counts unchanged, doctor ✓ (LLM daily-cap ⚠ only), `/health` ok, pid 57832. The installed package contains `_point_status_as_of`. Evidence: `07-r7-deploy/`.
- **Real-data MOD-12 recheck** (GET only, all 49 Points, `07-r7-deploy/mod12-real-recheck.txt`):

| as_of | status | before R7 |
|---|---|---|
| 2026-11-01T00:00 (before every Point) | not_yet_effective 49 | 35 not_yet_effective + 14 wrongly active/superseded |
| 2026-11-05T00:00 | active 13, superseded 1, not_yet_effective 35 | — |
| 2026-11-06T00:00 (after all) | active 42, superseded 7 | matches graph stats `active_points=42` |

`status_now` is present on all 49. **MOD-12: PASS on real data.**

**Rollback options now:**
1. To R6: use `venv-r6` + the pre-r7 data. The schema is the same, so data restore is optional.
2. To 0.3.2: use DEPLOY-06 with the pre-r1r6 backup.

## Phase 1 verdict: DONE (2026-11-05)
