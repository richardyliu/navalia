# Persome Lens — GAP vs S1, Round 4（S1 收尾，2026-11-05）

上一轮：`GAP-vs-S1-R3.md`。批准范围：`DECISIONS-ROUND3.md`。
Oracle：S1 文章（https://mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA）。本轮没有重读原文，三个 use case 的划分沿用 R2/R3 的拆法：U1 证据链 / 个人数据库，U2 习惯与 Workflow，U3 Agent 读取 / Performance。[INFERRED]
证据目录：`docs/test-evidence/PHASE3/`。

## 0. 基线（Phase 0）

| 项 | 值 |
|---|---|
| Lens typecheck / vitest / build | rc=0 / 139 个文件通过、4 跳过，**1457 通过 / 5 跳过 / 0 失败** / rc=0（`PHASE3/00-baseline/`）。这一轮没有出现 `/bin/ps` 或 `sandbox-exec` 的环境失败 |
| Runtime | R1–R7 @ `03698b5`，schema `2026-11-05.3`，`/health` ok |
| 真实数据 | Points 49、Lines 46（`model status`），relation_edges 187，`model_candidate_points` 0，`relation_edge_evidence` 0，Faces 0，skills 0 |
| LLM 预算 | `[agent_funding]` 当天 200/200 已用完，按本地日期计（`agent_cli.py:318`），2026-11-06 00:00 PST 重置 |
| 备份 | `20261105-173654-pre-r8`（R8 前）、`20261105-180023-pre-r9`（R9 前），都是停机后的字节拷贝，`quick_check=ok`，manifest 全部 OK |

## 1. S1 目标 × before / after

| 目标 | R3 状态 | R4 状态 | 证据 / 验收 |
|---|---|---|---|
| **U1 证据链：旧数据有来源** | PARTIAL：49/49 个 Point `sources=[]` | **DONE（有空缺）**：上游 R9 确定性回填已部署并应用到真实数据。**45/49 个 Point、107/187 条 Line** 有直接来源（quote + session + window）；as_of 三个时间点的结果和 R7 一致；Lens 视图模型对真实响应没有任何「证据未解析」标记。空缺：4 条 `remember` 记忆没有候选，42 条 occurrence Line 和 3 条已关闭的 Line 没有窗口证据。备注：任务原本写的是用 `model build` 重建，但它不会补已有对象（代码和副本实测都证实），所以改用 R9 | `r9-deploy/05..08`、`r9-lineage/` |
| U1「查看当时」as-of（MOD-12） | PASS | **PASS（不变）** | `r9-deploy/07-real-evidence-asof.txt` |
| U1 §15 上游 | 63/63 | **63/63**（@`462361d`）；MEM-09 的问题是测试脚本让它和 MEM-10 共用根，已按原始做法单独运行，见 REPORT | `r9-deploy/09-rerun15/` |
| **U2 Workflow 有结构** | PARTIAL（R8 只在 fixture 上通过，没有部署） | **PARTIAL**：R8 已部署（`4e83ce8`，pytest 2595/0）；真实 `behavior_patterns.skills = 0`，**真实运行 BLOCKED（LLM 预算）**。timeline 覆盖 3 个本地日期（09-21、11-04、11-05），所以额度恢复后有可能跑出第一个 Workflow。没有伪造任何结构 | `r8-deploy/`、`UPSTREAM-DEPLOY-R8.md` §4 |
| U2 习惯 ≥3 日期 | 临时根 PASS；真实 Face 0 | 不变（真实数据仍然没有 Face） | — |
| **U3 Performance（X4 = B）** | 计数卡已有 | **DONE**：「本周 AI 工作计数」写明「这是计数，不是绩效分，不代表节省时间」；每个数字都能点回 HET 过滤后的列表；有空态和错误态；测试证明它不经过 Broker 的 MCP 或 REST，也不进 Card 和周信。注意：已有的 OG-08 HET REST（`/het/tasks`）能让有 HET 授权的 Agent 自己数出这些数字，要不要收紧需要用户决定 | `PHASE3/X4-X9/`、`s1-log/S1-R4-04-05.md` |
| **主动层（X9）** | 只有文档 | **DONE（T5 部分）**：T3/T4/T5/T1/T2 全部默认关；每天最多 3 条，有 cooldown、dedupe、quiet hours 22–09；文案只有数字；有静态和运行时的无网络测试。**T5「已升级」在真实 Runtime 上触发不了**：`/health` 没有 `schema_revision`，`/status` 仍然报 `0.3.2`。通知权限只能间接判断。没有在真实 Notification Center 里跑过 | `PHASE3/X4-X9/summary.md`、D69 |
| X2 订阅后台扫描 | 只有手动 | **DONE**：默认关，5–1440 分钟，只扫一层，不联网，退出时停止 | `connectors-backup/`、`s1-log/S1-R4-06-07-10.md` |
| X5 导入后构建 | 已有开关 | **DONE**：确认默认关、需要二次确认、会花 LLM 预算、失败时显示退出码和 stderr，补了测试 | 同上 |
| X8 备份包含 Access log | 不包含 | **DONE（偏离）**：默认关；manifest v3 有 `includes_access_log`；导出 JSON，不复制 `audit.db` 文件（D68）；永远不含私钥和 grants | 同上 |
| S1-R4-07 `.eml` / mbox | 没有 | **DONE**：本地解析器、每封一条记忆、按 Message-ID 去重、附件只记文件名 | 同上、D70 |
| S1-R4-08 OCR 可操作 | 只显示状态 | **DONE**：分步骤命令可复制，说明微信内容依赖 OCR；Lens 不写 `config.toml` | `ocr-shared-readme/` |
| S1-R4-09 Shared moments 门槛 | 前 3 条，没有阈值 | **DONE**：Runtime 不返回相关度分数，所以改成要求字面重合（以后有分数时用 `score ≥ 0.5`）；周信只引用勾选的条目 | 同上、D67 |
| S1-R4-10 导入/备份完整性 | 有上游限制 | **DONE（上游限制不变）**：用稳定 key 去重；cards 和 Workflow 历史的备份/恢复有测试；文案写明快照不是原始 DB | `connectors-backup/` |
| S1-R4-11 README / hermetic | — | **DONE**：README 去掉了过时的说法；新增 `host-probe`，在受限沙箱里跳过并写明原因 | `ocr-shared-readme/` |
| CAP L2/L3 | BLOCKED（TCC 人工） | **BLOCKED（不变）**：这一轮没有人工 TCC 验收 | `docs/upstream/CAPTURE-L2L3.md` |
| HET 分钟 | 未测量 | **未测量**（X3 未批准） | — |
| 签名 / 公证 / 自动更新 | BLOCKED | **BLOCKED**（没有 Developer ID，OG-D3/D4） | — |
| Chat / Meetings / 云同步 | BLOCKED | **BLOCKED**（X1 未批准） | — |

## 2. 门禁（最终）

| 项 | 结果 |
|---|---|
| Lens typecheck / vitest / build | rc=0 / **152 个文件通过、4 跳过；1578 通过 / 5 跳过 / 0 失败** / rc=0（`PHASE3/FINAL/`） |
| Lens e2e（临时目录 + mock Runtime） | **37 PASS / 5 SKIP**（4 个因为 `E2E_NO_FOCUS=1` 不抢焦点；1 个可选） |
| 上游 pytest @ `462361d` | **2622 passed / 0 failed / 1 skipped** |
| §15 上游重跑 | **63/63** |

## 3. 需要用户 / 上游 / 证书的项

1. **LLM 额度（2026-11-06 之后）**：按 `UPSTREAM-DEPLOY-R8.md` §4 跑一次 pattern_detector，确认第一个真实结构化 Workflow。这一步会花 Runtime 额度。
2. **OG-08 HET REST 暴露 correction/signals**：要不要对 Agent 收紧（X4 的「谁能看」）。
3. **T5 升级检测**：需要上游在 `/health` 或 `/status` 里给出 schema revision 或真实版本号（现在 `/status` 报 `0.3.2`，是错的）。
4. CAP L2/L3：在打包好的 app 上做人工 TCC 验收。
5. Developer ID（签名 / 公证）；X1 / X3 / X7 继续不批。
6. 这次停机给其它 Claude Code 会话里的 `persome mcp` 发了 SIGTERM：那些会话要重启后才会连到 R9 代码。
7. 本轮停机前 Lens 就没有在运行，所以屏幕采集从 14:50 以后没有新数据（Lens 是 ingest producer）。要继续积累第 4 个日期的数据，需要用户重新打开 Lens。
