# Persome Lens — GAP vs S1, Round 3（DEPLOY-2026-11-05 之后）

> 审计员草稿，位于 `docs/test-evidence/DEPLOY-2026-11-05/05-verify/GAP-vs-S1-R3.md`。审计员只能写 `docs/test-evidence/**`，所以没有直接放进 `docs/design/`；由 lead 执行 `cp` 发布（命令见文末）。

起点：`docs/design/GAP-vs-S1-R2.md`（2026-11-05 Round 2）。本轮只改与上游 Runtime 有关的行：R1–R6 已部署到真实 `~/.persome`（be0a0bc，tag `deploy/2026-11-05-r1r6`，schema `2026-11-05.3`）。其余行与 R2 相同，这里不重复，见 R2。
证据：`docs/test-evidence/DEPLOY-2026-11-05/05-verify/`（`records.txt`、`evidence-sha256.txt`）。

R2 里没有出现 “FIX READY / NOT DEPLOYED” 字样；R2 中依赖上游的行是「证据链 BLOCKED 上游（MOD-07）」和「习惯 ≥3 日期 PARTIAL / BLOCKED（X6、X10）」，下表逐条更新。

## 1. 依赖上游的 S1 目标（R2 → R3）

| 目标 | R2 状态 | R3 状态 | 理由 | 证据 |
|---|---|---|---|---|
| 证据链（U1） | BLOCKED 上游（MOD-07） | **PARTIAL（已部署）** | 代码：真实 Runtime 上 296/296 条 candidate 回执都能解析（含 quote、session、窗口）；§15 重跑中 MOD-01/02/07/08 全部通过。真实数据：49 个 Point 和 46 条 Line 全部 `sources=[]`，因为这批数据是部署前（0.3.2，08:49Z）构建的，新的关联表 `model_candidate_points` / `relation_edge_evidence` 为 0 行，也没有回填。要等部署后重新构建或上游回填，现有对象才会有来源。Lens 对这些 Point 显示「证据未解析 / no_sources」，并附带区分版本的说明。 | `BF-real-runtime-summary.txt`、`BCF-lens-viewmodel-over-real.txt`、`I-rerun15/check_results.txt` |
| 习惯 ≥3 日期（U2） | PARTIAL / BLOCKED（X6、X10） | **DEPLOYED / PASS（临时根）** | Runtime 只有在 ≥3 个不同日期时才把 Face 升为 active，2 个日期时仍是 shadow；`behavior_patterns` 返回 `observation_dates`；Lens 按 Face 标「稳定习惯 · 3 个不同日期 / 观察中 / 日期未知」。**真实数据目前 Face 为 0**，所以只能在临时根上验证。 | `I-rerun15/faces3/`、`E-habit-labels.txt`、`E-real-behavior-patterns-counts.json` |
| 「为什么不完整」（U1 降级说明，MOD-13） | Lens 只显示 `model_contract` +「仅 CLI」 | **DEPLOYED / PASS** | 真实 `/model/graph` 返回 `issues=[no_faces,no_volumes,no_root]`；运行中的 Model 页逐字显示原因码和中文解释。 | `C-model-page-issues-dom.json` |
| 「查看当时」as-of（证据抽屉，MOD-12） | Lens 用 D48 标注缺口 | **DEPLOYED / PASS（R7）** | R7（`03698b5`）部署后，T=2026-11-01 时 49/49 个 Point 都返回 `not_yet_effective`，T=11-06 时 42 个 active、7 个 superseded。在 be0a0bc 上 14 个 entry-backed Point 的缺口已修复。 | `07-r7-deploy/mod12-real-recheck.txt` |
| owner 别名确认（MOD-11） | 上游自动激活 | **DEPLOYED / PASS** | 只有用户确认才会激活，确认后 entity_graph 解析为 self；拒绝后不解析，Agent 再次建议也不会重新打开。真实数据别名为 0（all/pending/active/rejected 都是 0）。 | `G-owner-aliases-real-rest.txt`、`G-temp-reject/` |
| Agent 分页读记忆（MEM-10） | Lens 在 50k 处截断，没有 cursor | **DEPLOYED / PASS** | 真实 Runtime 经 Broker：`limit=2` 时 has_more=true；cursor 84 字符，与 Runtime 原值逐字节相同，没有被 scrub；第 2 页与第 1 页 0 重叠；一页 59,735 字符完整送达。 | `H-broker-paging-real.json` |
| 常驻层不混入 search（MEM-05）/ 事实核验（MEM-09）/ 冲突 supersede（MOD-09）/ 实体类型（MOD-14） | FAIL（上游） | **DEPLOYED / PASS（临时根）** | §15 重跑全部通过。MOD-14 已知的限制：entity_graph 不解析组织名。 | `I-rerun15/check_results.txt` |
| Workflow 任务结构有内容（U2） | PARTIAL（上游只写 Pattern/Context/Evidence） | **PARTIAL（不变）** | R1–R6 不涉及 pattern_detector 的结构化输出。 | — |
| 采集 L2/L3（U1） | BLOCKED（TCC 人工） | **BLOCKED（不变）** | 与部署无关，仍然需要人工授权。 | — |

## 2. Phase 2（S1-R3-01..09）— 2026-11-05 收尾

Lead 最终门禁（`docs/test-evidence/PHASE2-FINAL/`）：typecheck ✓；vitest 1457 通过 / 5 跳过 / 0 失败（含第二轮安全修复，见 `s1-log/S1-R3-SEC.md`）；build ✓；e2e 41 通过 / 1 跳过（可选项）。

| ID | 标题 | 状态 |
|---|---|---|
| S1-R3-01 | Owner alias UI（R3 配套） | **DONE**（只用 mock 验证；真实数据里有 0 个别名）（`s1-log/S1-R3-01.md`） |
| S1-R3-02 | Broker 工具目录刷新 | **DONE**（29 个工具都有 scope、描述和审计；model:search 授权能读到 pending 别名；read_memory 分 3 页，cursor 原样往返）（`s1-log/S1-R3-02.md`） |
| S1-R3-03 | Workflow 自动内容 | **PARTIAL**：上游分支 `og/r8-workflow-structure`（4e83ce8）在 fixture 上测试通过（4 个步骤、3 个产物、1 条规则、1 个问题，都能追溯到证据），Lens 已映射。还没有部署，也还没有真实 LLM 运行；部署需要用户批准，而今天的 LLM 日上限已用完（`s1-log/S1-R3-03.md`） |
| S1-R3-04 | AI 工作计数视图（Option B） | **DONE**（只是计数，不是绩效分；commit 信号 = Agent 的 shell 命令里匹配到 `git commit`）（`s1-log/S1-R3-04.md`） |
| S1-R3-05 | Shared moments 深度 | **DONE**（共同话题和共同经历都标「未核实」并能链回证据；语义匹配用的是 Runtime 搜索的前 3 条，没有相关度阈值）（`s1-log/S1-R3-05.md`） |
| S1-R3-06 | Personal Database 完整性（导入/备份） | **DONE**，有一处上游限制：同一来源重新导入不会产生重复，但 Runtime 不能就地覆盖旧版本（旧的时间线块会保留）（`s1-log/S1-R3-06.md`） |
| S1-R3-07 | 本地连接器（.ics / 健康 CSV·JSON） | **DONE**（在临时根上用真实 Runtime 验收，网络隔离）；.eml 没有做（`s1-log/S1-R3-07.md`） |
| S1-R3-08 | 主动层 / 长程 project | **DONE（只有文档）**：`PROACTIVE.md`；X9/X4 没批，所以什么都没实现（`s1-log/S1-R3-08.md`） |
| S1-R3-09 | Ask / 微信闭环 | **DONE**（保存到记忆要先预览，有一次性 token 和 main 侧确认；Capture、Ask、Search 都显示 OCR 状态和微信警告）（`s1-log/S1-R3-09.md`） |

建议在 Phase 2 定义中加入以下两条（根据本轮发现）：
- ~~上游：`_resolve_entry` 要支持 as-of 状态~~ → R7 已修复并部署。
- 现有数据的来源怎么补：部署后重新构建，或者上游提供回填（`model_candidate_points` / `relation_edge_evidence`）。

## 3. 本轮门禁

| 项 | 结果 |
|---|---|
| `npm run typecheck` | rc=0 |
| `npx vitest run` | 119 个文件通过 / 4 个跳过；1242 个测试通过 / 5 个跳过 / 0 失败 |
| dev Lens 连真实 Runtime | 启动无报错；Broker 在 127.0.0.1:8750；SIGTERM 后 1 秒内全部退出 |
| §15 上游重跑 | 63/63 PASS（01-upstream 写的 “67/67” 是加法错误，逐项相加是 63） |

发布：`cp docs/test-evidence/DEPLOY-2026-11-05/05-verify/GAP-vs-S1-R3.md docs/design/GAP-vs-S1-R3.md`
