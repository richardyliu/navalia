# UPSTREAM-DEPLOY-R8 — Workflow 结构化（R8）部署到真实 `~/.persome`（2026-11-05）

授权：DECISIONS-ROUND3（本地部署可以；不 push、不开 PR、不发布）。证据：`docs/test-evidence/PHASE3/r8-deploy/`。

## 1. 代码

| 项 | 值 |
|---|---|
| 仓库 | `~/Documents/GitHub/personal-model-og` |
| 合并 | `og/upstream-fixes` 从 `03698b5` fast-forward 到 `og/r8-workflow-structure` `4e83ce8`（3 个提交：`d47d914`、`48ed7ee`、`4e83ce8`） |
| 本地 tag | `deploy/2026-11-05-r1r8` → `4e83ce8`（没有 push） |
| schema | 不变：`2026-11-05.3`（R8 不改 DB，结构放在 skill entry 的 Markdown 里，读的时候再解析） |
| 上游 pytest（offline，`env -i`、临时 HOME、`PERSOME_LLM_MOCK=1`） | **2595 passed / 0 failed / 1 skipped / 17 deselected**，临时 HOME 下没有 `.persome`（`01-pytest-offline.txt`） |

## 2. 备份（DEPLOY-02 流程）

- 停机：`persome stop`（SIGTERM pid 57832）→ 对所有 `persome mcp` 进程发 SIGTERM（不用 -9）→ 确认没有 persome 进程、8742 没有监听、`lsof index.db` 为空。Lens 当时没有运行。
- **BACKUP = `/Users/ryl/Persome Backups/20261105-173654-pre-r8`**（chmod 700）
  - `data/`：index.db 加 -wal/-shm 的字节拷贝、`index.consolidated.db`（从临时副本 `.backup` 得到）、memory/、backup/、capture-buffer/、config.toml（含 .bak）、env、HUMAN.md、model-build.json
  - `venv-r7/`（879M）：R1–R7 的 venv，用于回滚
  - 拷贝前后 live `index.db` 的 sha256 相同，都是 `560021a39673b77464487710ce458d4bef2e15a10ca3757b204a1d543a1653cd`
  - consolidated：`quick_check=ok`，schema `2026-11-05.3`，entries 137、evo_nodes 49、captures 2708、relation_edges 187、model_candidate_points 0、relation_edge_evidence 0
  - `manifest.sha256`（16 个文件，不含 capture-buffer）用 `shasum -c` 校验全部 OK
  - 记录：`02-backup.txt`

## 3. 部署

`PERSOME_INSTALL_HOME="$HOME/.persome" PERSOME_ROOT="$HOME/.persome" bash install.sh --update --no-client-config < /dev/null` → rc=0，耗时约 50 s（`03-install.txt`）。

部署后（`04-post-deploy.txt`）：
- Runtime 进程 pid 95506，OCR worker 95551；`/health` 返回 `status=ok, ocr=ready, ocr_worker=ready, capture_pipeline=ok`
- `quick_check=ok`，schema `2026-11-05.3`，计数不变（137 / 49 / 2708 / 187）
- 安装后的包里有 `persome/writer/workflow_structure.py`，`prompts/pattern_detector.md` 含证据指针规则
- doctor：只有一项 ⚠，是 LLM 日额度用完（200/200）
- `model status` 和部署前一样：points=49 lines=46 faces=0，issues 为 no_faces / no_volumes / no_root

注意：本次停机向其它 Claude Code 会话里的 `persome mcp` 进程发了 SIGTERM，那些会话要重启后才会连到新的 venv。

## 4. 真实 Workflow 运行 — **BLOCKED（LLM 预算）**

- 真实 `behavior_patterns`（只读连接，`05-behavior_patterns-real.txt`）：`skills=0`、`faces=0`、`root=null`。`memory/` 下没有任何 `skills/skill-*.md`，所以现在没有真实的 Workflow 可以结构化。
- pattern_detector 要求候选出现在 ≥3 个不同的本地日期（`pattern_detector.py:37` `MIN_DISTINCT_DATES = 3`）。timeline_blocks 一共覆盖 3 个本地日期：2026-09-21（111 块）、11-04（329 块）、11-05（192 块）。所以从日期上讲是可能的，但某个具体行为能不能在 3 天都出现，要等真实运行才知道。
- pattern_detector 要调 LLM（第 2 步 LLM 校验），而 `[agent_funding]` 当天 200/200 已用完。额度按本地日期计（`agent_cli.py:318`），在本地午夜（2026-11-06 00:00 PST）重置。本轮**没有**改上限，也没有重置用量文件（DECISIONS-ROUND3 §3）。
- 结论：**R8 已部署，真实结构化 Workflow 还没有跑出来**。没有伪造任何结构。

### 额度恢复后的验证步骤（用户或下一轮执行）

```bash
# 1. 确认额度
~/.local/bin/persome doctor | grep "Agent-funded"            # 期望 <200/200
# 2. 让 session finalize 或 build 跑一次 pattern_detector（会调用 Runtime LLM，花额度）
~/.local/bin/persome model build
# 3. 读结果（只读）
~/.persome/venv/bin/python -I -c "import sqlite3,json,os;from persome.mcp import server;c=sqlite3.connect('file:'+os.path.expanduser('~/.persome/index.db')+'?mode=ro',uri=True);d=server._behavior_patterns(c);print(json.dumps([{k:s.get(k) for k in ('steps','artifacts','rules','problems','structure_dropped')} for s in d['skills']],ensure_ascii=False,indent=1))"
# 4. 每个 steps[].evidence[] 用 MCP resolve_evidence 解析；在 Lens 的 Playbook 页查看
```
通过标准：至少一个 skill 的 `steps` 非空，artifacts/rules/problems 各至少一项，每个指针都能被 `resolve_evidence` 解析。如果 LLM 没按格式输出，结果就是空列表并记 `structure_dropped`，这算 R8 真实运行 FAIL，不算伪造的 PASS。

## 5. 回滚

R8 没有改 schema，只回滚 venv 就够了：

```bash
B="/Users/ryl/Persome Backups/20261105-173654-pre-r8"; TS=$(date +%Y%m%d-%H%M%S)
~/.local/bin/persome stop; pgrep -f 'persome mcp' | xargs -r kill -TERM
mv ~/.persome/venv ~/.persome/venv.failed-$TS && rsync -a "$B/venv-r7/" ~/.persome/venv/
~/.local/bin/persome start && curl -fsS http://127.0.0.1:8742/health
```
需要回滚数据时，按 `UPSTREAM-DEPLOY.md` DEPLOY-06 第 2 步执行，`BACKUP` 用上面的路径（`data/index.db` 加 wal/shm，或者 `data/index.consolidated.db`）。更早的回滚点：`20261105-154335-pre-r7`（`venv-r6`）、`20261105-145247-pre-r1r6`（`venv-old`，0.3.2）。

## 6. R9 — 现有数据 lineage 回填（已部署并应用到真实数据）

**为什么不用 `persome model build`：** Point→candidate 的关联只会在 `writer/delta_apply.py` 提升候选时写入（`link_point`，约第 454、1299、1368 行）。`model build` 的 `evomem_baseline` 阶段在已有节点时返回 `already_initialized`，不会重新提升已有的 Point。在副本上实测（`PHASE3/r9-lineage/model-build-only.txt`）：只跑 `model build`，关联行仍是 0 和 0，用量账本没有变化。所以重建模型本身补不了来源，不管有没有预算。

**代码（personal-model-og，只在本地）：**
- `cc9da48` feat(model)：新增确定性回填 `persome model backfill-lineage [--apply] [--json]`（`src/persome/model/lineage_backfill.py`），规则版本 `r9-lineage-1`。不调 LLM、不新建 Point 或 Line、不写新的 quote。默认只演练（dry-run）。写入在模型构建锁内的一个 `BEGIN IMMEDIATE` 事务里完成，可重复执行。
- `462361d` fix(evidence)：如果一个 Point 同时是 `entries` 里的条目（entry-backed），走 entry 路由时也返回它的候选来源（否则有 10 个 Point 仍然显示没有来源）。
- Point 规则：候选必须是 promoted；节点的文件名和标签形状要和提升时生成的一致；文本完全相同，或 `canonical_text` 相同；关联到同一文本的版本链根；`root.gmt_created >= promoted_at`；两边都是唯一匹配；任一边已有关联的不处理。不补写 `valid_from`，避免改变已经返回过的 as_of 结果。
- Line 规则：只用 `memory_deltas` 里已经应用过的观察，且 quote 和 Line 上已存的 quote 完全相同；遇到关闭的 Line、同 key 的多个区间、occurrence Line、会改变 shadow 几何的情况，以及已有证据的 Line，一律跳过。
- 合入：`og/upstream-fixes` fast-forward `4e83ce8 → 462361d`，tag `deploy/2026-11-05-r1r9`。pytest offline **2622 passed / 0 failed / 1 skipped / 17 deselected**（`PHASE3/r9-deploy/01-pytest-offline.txt`）。

**备份：** `/Users/ryl/Persome Backups/20261105-180023-pre-r9`（data 里有 index.db+wal/shm、consolidated、memory/、backup/、capture-buffer/、config、env；另有 `venv-r8/`；manifest 全部 OK；拷贝前后 live sha 相同，都是 `d58de440…a529`；consolidated 上 `quick_check=ok`，计数 137/49/2708/187，关联 0/0）。记录：`r9-deploy/02-backup.txt`。

**部署和应用：**
1. `install.sh --update --no-client-config` → rc=0（`03-install.txt`）
2. 停 Runtime 和所有 `persome mcp`（保守做法，回填时没有其它写入方）
3. `persome model backfill-lineage --json`（演练）→ Point 38/38（37 个完全相同、1 个 canonical 相同），Line 129 行写到 107 条边上；跳过：35 条没有 quote、42 条 occurrence、3 条已关闭。和副本演练结果**一致**（`04-dryrun.json`）。
4. `--apply --json` → 写入 38 和 129（`05-apply.json`）
5. 验证（`06-post-apply-counts.txt`）：`quick_check=ok`，schema 不变，entries/evo/captures/edges 不变，边状态不变（active 39、shadow 148）；再跑一次演练 → 0 条要写（可重复执行）
6. 启动 Runtime，`/health` ok。真实 REST（`07-real-evidence-asof.txt`）：**45/49 个 Point 有来源**，107/187 条 Line 有来源，as_of 三个时间点的结果和 R7 完全相同
7. Lens 视图模型处理真实响应（`08-lens-viewmodel-over-real.txt`）：**没有任何「证据未解析」标记**

**剩下的空缺：** 4 条 `topic-agent-findings` l2_fact（`remember` 写入的记忆，没有候选，它的来源就是自己的条目）；42 条 occurrence Line 和 3 条已关闭的 Line 没有窗口证据；回填的 Point 用 `gmt_created` 作为 as_of 起点，现场提升的 Point 用最早的证据窗口；`linked_at` 记录的是回填时间。

**R9 回滚：** 回填只往两张关联表里加了行。要撤销，按 DEPLOY-06 第 2 步从 `20261105-180023-pre-r9/data/` 恢复 `index.db`；要回到 R8 代码，用 `venv-r8/` 替换 venv（做法同 §5）。
