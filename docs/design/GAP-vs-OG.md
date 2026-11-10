# Persome Lens — GAP vs OG（OG-00 re-baseline + OG-FINAL，2026-11-05）

主 oracle 是参考文档 **§15 测试表**；S1 文章只作次要参考。`GAP-vs-S1*.md` 只用来查“已经有什么”，不当作 OG 证据。
本次是 **OG-00：只读重新基线，没有改 `src/`**。**OG-FINAL（同日，实现轮结束后）** 更新了 Table 1 的 #1–4、8、17、19、20、29、32 和 Table 2，依据见 `REPORT.md` 的 “OG-FINAL 2026-11-05” 一节和 `docs/test-evidence/OG-FINAL/`。测试证据在 `docs/test-evidence/OG-00/`，评分见 `docs/test-evidence/REPORT.md` 的 “OG-00 rebaseline 2026-11-05” 一节。

## 0. 规则

- 层级用参考 §0.3：L0 = 有入口；L1 = 用户可见行为一致；L2 = 内部机制/职责一致；L3 = 数据契约/语义一致。
- “层级”列写的是**有证据支持的最高层级**。只有入口、没有 §15 证据的，一律写 L0，不往上抬。没有入口的写 “—”。
- 状态：
  - **DONE**：该表面对应的 §15 测试有 PASS 证据，没有未声明的 FAIL。
  - **PARTIAL**：有实现，但缺 L2/L3 证据、有 FAIL，或只覆盖了一部分行为。
  - **BLOCKED**：需要账号/云、人工 TCC 授权、Developer ID 或用户决策（见 `DECISIONS-OG.md`）。
  - **TODO**：Lens 没有这个表面。
- 基线快照时间是 2026-11-05 10:39–10:42 PST。期间其他 agent 正在改 `src/`：`src/renderer/src/pages/Home.tsx`、`src/renderer/src/components/home/*`、`src/renderer/src/pages/Rewind.tsx`、`src/main/rewind/*`、`tests/rewind/*` 是在本次基线过程中出现的（`docs/test-evidence/OG-00/surface-grep.txt`）。**这些在建内容不算分、不提升层级**，下一轮审计再评。

## 1. 表面 × 现状

| # | OG 表面（参考 §5） | Lens 现状（文件） | 层级 | §15 测试 | 证据 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 菜单栏常驻 | OG-04：`src/main/shell/*`（Tray，默认关，`shell-settings.json` 0600） | L0（实现者证据） | VIS-09 | `OG-04/README.md`；`OG-FINAL/settings-dom.json`（开关默认关） | BLOCKED（OG-FINAL：菜单要人看，CDP 看不到） |
| 2 | 全局快捷键 | OG-04：`globalShortcut`，默认关，`CommandOrControl+Shift+Space` | L0 | VIS-05 | `OG-04/README.md`；`OG-FINAL/settings-dom.json`（「未注册」） | BLOCKED（按快捷键需要人） |
| 3 | Home › Today | `pages/Home.tsx`「今天」卡片 + `pages/Today.tsx`、`src/main/library/brief.ts`（D29/D35） | L1 | VIS-06 PASS；VIS-07 **FAIL** | `OG-FINAL/home-dom-empty-runtime.json`、`home-dom-no-runtime.json` | PARTIAL（Runtime 读不到时，「今天」/「待办」卡片显示 0 条，不显示错误） |
| 4 | Home › HET | `pages/Het.tsx`、`src/main/het/*`、REST `/het/*`（OG-08，D41–D47）。真实 transport 没接（X3/D22），实际使用中显示「未测量」 | L3 | HET-01..10 全部 PASS（HET-05 OG-FINAL 在运行中的 app 上测过） | `OG-FINAL/het05-app-*`、`HET-0*/2026-11-05-record.txt` | DONE（fixture 级；真实分钟数受 X3 限制） |
| 5 | Home › Actions | 只有 Today「下一步」：从 `- [ ]` / `TODO:` / `待办：` 行抽取。原版是 `playbook_tasks`（已结算事件卡 → 每日任务实例，§5.5），机制不同 | L0 | — | `tests/library/nextSteps.test.ts` | PARTIAL |
| 6 | Home › Memories | `pages/Search.tsx`（记忆 / 屏幕 / 最近）、`pages/Model.tsx` Points、`components/RememberDialog.tsx`、`CorrectDialog.tsx`；Runtime 工具由 `src/main/mcp/client.ts` 代理 | L0（UI）；Runtime 纠正 L3 | MEM-01..10 未测；MOD-10 PASS（Runtime 路径） | `OG-00/mod10-run.json` | PARTIAL |
| 7 | Home › Agents | `pages/Connections.tsx` 每个 Agent 一行，`src/main/broker/agents.ts` | L1 | ID-03/04/05/06 PASS | `ID-03..06/*` | DONE |
| 8 | Home › Heatmap | `pages/Home.tsx`「活动热力图」：7 天 × 24 h，数据是最近 ≤100 条 `recent_activity`（不是全部采集，卡片上写明了） | L1 | VIS-06 | `OG-FINAL/home-dom-empty-runtime.json` | PARTIAL（数据源只有采样） |
| 9 | Home › Recent | `pages/Search.tsx` “最近” 标签（`recent_activity`） | L0 | — | — | PARTIAL（未测） |
| 10 | Home › Agent reads | Connections → Access log（`components/connections/AccessLogList.tsx`、`AccessChart.tsx`，`src/main/broker/audit.ts`）。放在 Connections 页，不在 Home | L3 | ID-08/09/10/13 PASS | `ID-08/*`、`ID-09/*`、`ID-10/2026-11-05-*`、`ID-13/*` | DONE（位置不同） |
| 11 | Home › Connections | 同 #7、#10 | L3 | ID-03..09, 11..13 | 同上 | DONE |
| 12 | Home › Skills | `pages/Library.tsx` 技能栏、`pages/Playbook.tsx`、`src/main/workflows/*`、`.lensskill`（D25/D30/D37）。原版是 knowledge.md 自动学习 + 版本 + 分享 | L0 | — | `tests/workflows/*` | PARTIAL |
| 13 | Home › Peers | `pages/Peers.tsx`、`src/main/peers/*`：本地导入 `.persomecard`，订阅文件夹（D31/D38）。原版走云 | L0 | — | `tests/peers/*` | PARTIAL（云部分 BLOCKED，X1） |
| 14 | Model › overview | `pages/Model.tsx`（Root / Faces / Volumes / Points）、`pages/Overview.tsx`（构建状态、`degraded_stages`） | L0 | MOD-01..06, 08, 09, 11..14 未测；MOD-13 未测 | — | PARTIAL |
| 15 | Model › Personal Card | `pages/Card.tsx`、`components/card/PersonalCard.tsx`、`src/main/identity/card.ts`：本地 Ed25519 自签名（D3/D3a），能翻面，有 as-of | L1 | ID-01 PASS（按 D3 评）；ID-02 BLOCKED；VIS-02 未单独测 | `ID-01/*` | DONE（按 D3）；claim 流程 BLOCKED |
| 16 | Model › Map | 只有卡片背面的 `components/card/MiniMap.tsx`；没有能看到点线面体根的 Model Map | L0 | VIS-03 | `OG-00/surface-grep.txt` | TODO |
| 17 | Settings | `pages/Settings.tsx`：Runtime 诊断、菜单栏与快捷键、隐私（暂停 / 排除链接 / 只读保留期 / 删除 / 撤回）、更新、会议音频（BLOCKED）、备份 | L1 | PRIV-02/03/06/07 PASS；CAP-05/06、ID-11 PASS | `OG-FINAL/settings-dom.json`、`settings-shell-privacy.png`、`PRIV-0*/2026-11-05-*` | PARTIAL（「先导出备份」默认关，和 OG-D7 不一致；没有账号区） |
| 18 | First-run | `pages/Onboarding.tsx`、`src/main/onboarding/store.ts`（D32）：5 步，可跳过，不登录。「资料库预览」只是 `libraryHeadline` 计数，不是原版那种有依据的 `library_preview` 模型调用 | L0 | VIS-08 未测；INT-01 BLOCKED | `tests/onboarding/*` | PARTIAL（登录 BLOCKED） |
| 19 | Rewind | `pages/Rewind.tsx`、`src/main/rewind/*`，共用 `src/main/broker/rewind.ts`：只在 main 解密；没有 key 就 BLOCKED；明文帧拒绝显示 | L1 | VIS-04 PASS（fixture 帧）；CAP-03 PASS（L3 代码路径） | `OG-FINAL/rewind-*` | DONE（L1，fixture）；真实帧需要 Screen Recording 授权 |
| 20 | Recovery | `pages/Recovery.tsx`、`src/main/recovery/*`：11 项检查，每项带下一步；doctor、启动/重启、复制诊断；破坏性操作只有「重建采集索引」（二次确认，OG-D7b） | L1 | VIS-10 BLOCKED（更新那一半）；恢复那一半在 app 层 UNKNOWN | `OG-FINAL/recovery*.png`、`recovery-dom*.json`、`recovery-doctor-dom.json` | PARTIAL（「失败 → 恢复 → 不丢数据」没在 app 里跑过） |
| 21 | Swipe Your Card | `pages/Swipe.tsx` + Connections 连接流程 | L1 | ID-03/04/05 PASS | `ID-03..05/*` | DONE |
| 22 | Connections | `pages/Connections.tsx`：只有 full access；scoped 是 Extension（D1） | L1 | ID-03..07 PASS | `ID-07/*`、`OG-00/static-source-checks.txt` | DONE |
| 23 | Access log | 同 #10。清空不影响连接 | L3 | ID-08..13 PASS | `ID-08..13/*` | DONE |
| 24 | Chat | 无。`pages/Ask.tsx` 只给出 prompt 卡片，交给外部 Agent 运行（D33） | — | INT-02 | — | BLOCKED（云，OG-D1） |
| 25 | Meetings | 无 | — | INT-03、PRIV-10 | — | BLOCKED（云 + Soniox） |
| 26 | Check-ins | 只有本地草稿：`src/main/peers/letter.ts`（周信）、`src/main/het/weekly.ts`（周报导出），都不发送（D2） | L0 | — | `tests/peers/*`、`tests/het/*` | BLOCKED（送达需云） |
| 27 | Friends / Peers | 同 #13 | L0 | — | — | PARTIAL / BLOCKED |
| 28 | Wiki / Skills | 同 #12 | L0 | INT-04 BLOCKED | — | PARTIAL |
| 29 | Quick Box | OG-04：独立窗口 `#quickbox`，preload 受限（`src/preload/quickbox.ts`）；快速问 / 快速记 / 快速打开；不调用 LLM | L1（窗口） | VIS-05 BLOCKED（快捷键） | `OG-FINAL/quickbox.png`、`quickbox-dom.json` | PARTIAL |
| 30 | 主动推送 | 无（X9：不做） | — | — | — | TODO（OG-D5） |
| 31 | Daily review | Today brief 按模板生成，不调 LLM，每条标「未核实」（D29）。没有原版那种“草稿 → 证据 → 事实核查”流程 | L0 | — | `tests/library/brief.test.ts` | PARTIAL |
| 32 | Updates | Settings「更新」：显示当前版本；「检查更新」直接返回 BLOCKED，不发网络请求，不轮询 | L1（BLOCKED 状态） | VIS-10 | `OG-FINAL/settings-updates-dom.json`、`VIS-10/2026-11-05-*` | BLOCKED（OG-D4 没有发布源，OG-D3 没有 Developer ID） |
| 33 | 采集（壳拥有 TCC） | `pages/Capture.tsx`、`src/main/capture/*`、`native/src/*.mm` | L1 | CAP-05/06/10 PASS；CAP-01/02/07/08/09 BLOCKED；CAP-03/04 未测 | `CAP-0{5,6}/*`、`OG-00/CAP-10-static.txt`、`OG-00/CAP-01-ps-live.txt` | PARTIAL（L2/L3 BLOCKED） |
| 34 | 签名 / 公证（打包） | `package.json` 中 `mac.identity: null`，dist 为 `Signature=adhoc`，没有 TeamIdentifier | — | （无 §15 ID；影响 CAP-01 第 2 部分） | `OG-00/CAP-10-static.txt` | BLOCKED（OG-D3） |
| 35 | 模型证据门控（L2 核心） | 上游 Runtime 0.3.2 负责。Lens 的 EvidenceDrawer 把这类 receipt 显示为「未解析」（D20） | L3 FAIL | MOD-07 FAIL；MOD-08 未单独测 | `OG-00/mod07-run.json` | PARTIAL（上游） |

### 表面层面的结论

- 只有身份层四件套（Card / Swipe / Connections / Access log）达到 DONE，其中 Access log 到了 L3。
- 采集停在 L1：凡是能证明“壳拥有 TCC”的 L2/L3 测试，全部 BLOCKED。
- 原版主窗口的形态（Home 多标签 + Model Map + Rewind + 菜单栏 / 快捷键 / Quick Box + Recovery + Updates）在基线中全部缺失。目前只是“单窗口 + 侧栏多页面”。
- 云相关表面（Chat / Meetings / Check-ins 送达 / 登录 / 技能计费）按 X1 不引入，标 BLOCKED，不要包装成 DONE。
- **OG-FINAL 更新**：Home（11 张卡片）、Rewind、Recovery、菜单栏 / 快捷键 / Quick Box、Settings 隐私 / 更新都已有实现。Model Map（VIS-03）仍然 TODO。HET 到了 DONE（fixture 级）。新的 L1 缺陷：Runtime 读不到时，Home「今天」/「待办」显示 0 条（VIS-07 FAIL）。

## 2. §15 测试 ID × 状态

层级取自 §15.2（ID-01 记 L1）。状态：PASS / FAIL / BLOCKED / TODO（Lens 没有对应表面）/ UNTESTED（有实现或属于 Runtime，但没有按 §15 跑过）。
“OG-00” 列：**R** = 本次重跑；**S** = 本次只做了静态源码 / 产物复核（不算 UI 运行）；**C** = 沿用 2026-11-04 的结果，没有重跑。OG-FINAL 新增两个值：**OG-FINAL** = 审计员在 OG-FINAL 会话里亲自观察到的；**IM** = 2026-11-05 实现者写的记录，审计员没有重跑（引用的单测在 1200 项测试的门禁里都通过了）。

### CAP
| ID | 层级 | 状态 | OG-00 | 证据 / 原因 |
|---|---|---|---|---|
| CAP-01 | L2 | BLOCKED | S（ps） | `CAP-01/process-and-config.txt`；`OG-00/CAP-01-ps-live.txt`：本机现在没有 `mac-ax-*` 进程，真实 root 的 `capture.source` 未读取（禁止读）。第 2 部分（TCC）需要人工 |
| CAP-02 | L2 | BLOCKED | — | 需要 AX 授权才能抓 AX 文本；OCR 默认关闭 |
| CAP-03 | L3 | PASS | OG-FINAL | `CAP-03/2026-11-05-og02.md`；oracle 测试在本次会话里重跑 3/3 |
| CAP-04 | L1 | PASS（模拟时长） | OG-FINAL | `CAP-04/2026-11-05-og02.md` |
| CAP-05 | L1 | PASS | C | `CAP-05/run.log` |
| CAP-06 | L1 | PASS | C | `CAP-06/*` |
| CAP-07 | L1 | PASS（逻辑 + 录制 fixture；真机输入密码待人工） | IM | `CAP-07/2026-11-05-og02.md` |
| CAP-08 | L2 | BLOCKED | C | `CAP-08/heartbeat-watch.log`；需要 AX 授权 + 11 分钟空闲 |
| CAP-09 | L3 | BLOCKED | C | 需要 AX 授权；D13 |
| CAP-10 | L1 | PASS | S | `OG-00/CAP-10-static.txt`：只有 `AXIsProcessTrusted*`、`CG*ScreenCaptureAccess`；dist 的 Info.plist 里已经没有 camera/mic usage 字符串 |

### MOD
| ID | 层级 | 状态 | OG-00 | 证据 / 原因 |
|---|---|---|---|---|
| MOD-01 | L3 | FAIL | R（OG-00b） | `MOD-01/2026-11-05-record.txt`：Point 只有入库时间（created_at），`occurred_at` 为空；MCP/REST `resolve_evidence` 全部 `sources=[]`。根因同 MOD-07（上游 `docs/upstream/MOD-07.md`） |
| MOD-02 | L3 | FAIL | R（OG-00b） | `MOD-02/…`：14 条关系 Line 有类型，但 0 条能解析出来源；6 条 `knows`（co-occurs）没有 quote 也被升为 active；带原文的 `part_of "works at"` 仍是 shadow。上游 `docs/upstream/MOD-02.md` |
| MOD-03 | L3 | PASS | R（OG-00b） | `MOD-03/…`：只有一次采样 → shadow；两种信号 + 第二天重采样 → active（按 OSS 口径；门控数的是提取信号和构建日期，不是会话）。LLM 传输为 mock |
| MOD-04 | L3 | FAIL | R（OG-00b） | `MOD-04/…`：证据只有 2 个日期，Face 已升为常驻行为模式；习惯预筛 `min_occurrences=2` 放行 2 日期模式。与 D24 预期一致；上游提案 `docs/upstream/HABIT-3-DATES.md` |
| MOD-05 | L3 | PASS | R（OG-00b） | `MOD-05/…`：两个领域融合为 level-2 Volume，置信度 0.75，第二次采样后 active。LLM 传输为 mock |
| MOD-06 | L1 | PASS | R（OG-00b） | `MOD-06/…`：空库 build 后 root=null，HUMAN.md 明说没有 Root；Lens 模型页 Root 显示 forming、「还没有 Root」 |
| MOD-07 | L3 | FAIL | R | `OG-00/mod07-run.json`、`MOD-07/2026-11-05-record.txt`：门控 ✓；receipt 解析不了，丢弃原因只有一个整数。根因在上游。OG-FINAL 按 FAIL 计（OG-00b 记的是 BLOCKED-upstream，两种算法见 REPORT） |
| MOD-08 | L3 | FAIL | R（OG-00b） | `MOD-08/2026-11-05-record.txt`：model-evidence receipt 解析不了（和 MOD-07 同根） |
| MOD-09 | L3 | FAIL | R（OG-00b） | `MOD-09/…`：重复 apply 幂等 ✓；关系边冲突会关闭旧边并保留 ✓；但冲突的 Point（「在 Acme」/「在 Beta Labs」）同时为最新，没有 supersede，也没标 conflicted。上游 `docs/upstream/MOD-09.md` |
| MOD-10 | L3 | PASS | R | `OG-00/mod10-run.json`：applied；旧行 `superseded=1` 保留；记录了理由 |
| MOD-11 | L3 | FAIL | R（OG-00b） | `MOD-11/…`：人和人合并要等用户纠正 ✓；他人说的话没记成用户 ✓；但 owner 别名 `ryl-dev` 只凭 1 次会话就自动并入 self，没有确认。上游 `docs/upstream/MOD-11.md` |
| MOD-12 | L3 | FAIL | R（OG-00b） | `MOD-12/…`：CLI `as-of` 和 MCP `entity_graph(as_of)` 正确 ✓；REST `/model/evidence?as_of` 把 T 时还不存在的 Point 当 active 返回（Lens「查看当时」用的就是它）。时间轴是入库时间。上游 `docs/upstream/MOD-12.md` |
| MOD-13 | L1 | **FAIL**（上游） | R（lead 2026-11-05 复测） | `MOD-13/2026-11-05-rerun-*`：用户决定要求逐字原因码。Runtime 0.3.2 的 REST 不返回 no_faces/no_volumes/no_root（只有 CLI `persome model status` 打印），只有 `degraded_stages=["model_contract"]`。Lens 现在逐字显示 Runtime 返回的代码 + 中文解释（`model_status.issues`），不自行推算；对 0.3.2 显示 model_contract + 「仅 CLI」说明。上游提案 `docs/upstream/MOD-13.md` |
| MOD-14 | L3 | FAIL | R（OG-00b） | `MOD-14/…`：写入时类型正确（artifact→tool-，事件为 event）；`entity-retype` 只改文件名，边的端点类型和 person-entity 标签不变；按显示名调用会报错。上游 `docs/upstream/MOD-14.md` |

### MEM
| ID | 层级 | 状态 | OG-00 | 证据 / 原因 |
|---|---|---|---|---|
| MEM-01 | L3 | BLOCKED | R（OG-00b） | `MEM-01/…`：没有向量时降级为 BM25 ✓；向量这一半需要 embeddings 端点和 key（账号/凭据） |
| MEM-02 | L3 | PASS | R（OG-00b） | `MEM-02/…`：path/timestamp/age_days/content 都有（age_days 按写入时间算） |
| MEM-03 | L3 | PASS | R（OG-00b） | `MEM-03/…`：经 REST ingest 写入采集；snippet 有高亮，带 file_stem |
| MEM-04 | L1 | PASS | R（OG-00b） | `MEM-04/…`：Lens 证据抽屉把「直接来源」和「邻近上下文（不是直接证据）」分开显示 |
| MEM-05 | L3 | FAIL | R（OG-00b） | `MEM-05/…`：behavior_patterns 有 root/faces/skills 字段 ✓；但 `search` 能搜到 Face/Volume 文本，包括还没通过门控的 Face。上游 `docs/upstream/MEM-05.md` |
| MEM-06 | L3 | PASS | R（OG-00b） | `MEM-06/…` |
| MEM-07 | L3 | PASS | R（OG-00b） | `MEM-07/…`：新条目重启后仍在，带 `source:agent-run` |
| MEM-08 | L3 | PASS | R（OG-00b） | `MEM-08/…`：supersede，旧条目划线保留，可查到 |
| MEM-09 | L3 | FAIL | R（OG-00b） | `MEM-09/…`：矛盾能显示 ✓；版本更新（0.2→0.3）不会被标记，age_days 不看 occurred_at，给不出当前版本。上游 `docs/upstream/MEM-09.md` |
| MEM-10 | L3 | FAIL | R（OG-00b） | `MEM-10/…`：其他工具都有上限；`read_memory` 没有 cursor 也没有大小上限（400 条 = 176,566 字符）。上游 `docs/upstream/MEM-10.md` |
| MEM-11 | L3 | PASS（dev build） | C | `MEM-11/token-scan.txt` |

### ID
| ID | 层级 | 状态 | OG-00 | 证据 / 原因 |
|---|---|---|---|---|
| ID-01 | L1 | PASS（按 D3） | C | `ID-01/*` |
| ID-02 | L1 | BLOCKED | IM | 没有账号（D3 / OG-D1）；`ID-02/2026-11-05-record.txt` |
| ID-03..06 | L1 | PASS | C | `ID-03..06/*` |
| ID-07 | L1 | PASS | C + S | `ID-07/*`；`OG-00/static-source-checks.txt` |
| ID-08 / ID-09 | L3 | PASS | C | `ID-08/*`、`ID-09/*` |
| ID-10 | L1 | PASS | C | `ID-10/2026-11-05-record.txt`（OG-07） |
| ID-11 / ID-12 | L1 | PASS | C | `ID-11/*`、`ID-12/*` |
| ID-13 | L3 | PASS | C + S | `ID-13/ui-copy.txt`；`OG-00/static-source-checks.txt` |

### HET
| ID | 层级 | 状态 | OG-00 | 证据 / 原因 |
|---|---|---|---|---|
| HET-01 | L1 | PASS | C + S | `OG-00/static-source-checks.txt`：`src/main/het/api.ts:11` 与 §5.6 逐字节一致 |
| HET-02 | L3 | PASS | R | `OG-00/HET-02-het-audit.json`（sha 与 11-04 相同 c882a68c） |
| HET-03 | L2 | PASS | R | `OG-00/HET-03-het-audit.json`（fixtures） |
| HET-04 | L3 | PASS | R | `OG-00/HET-04-het-audit.json` |
| HET-05 | L3 | **PASS** | OG-FINAL | `OG-FINAL/het05-app-*`：在运行中的 app 上调 REST `/het/*`，401 / 上限 / cursor / timezone / Access log 都对；D17/D18 |
| HET-06 | L3 | PASS | IM + OG-FINAL | `HET-06/2026-11-05-record.txt`；app 返回里看到 start/end/agent/kind/minutes（evidence 字段要带 `include_activity`） |
| HET-07 | L2 | PASS | R | `OG-00/HET-07-het-audit.json` |
| HET-08 | L1 | PASS | IM | `HET-08/2026-11-05-record.txt`；UI 上的 retry 已接线（`lens:het:retry`） |
| HET-09 | L1 | PASS | C + S | `OG-00/static-source-checks.txt` |
| HET-10 | L1 | PASS | C | `HET-10/ui-evidence-counts.json` |

### VIS
| ID | 层级 | 状态 | 原因 |
|---|---|---|---|
| VIS-01 | L0 | PASS（按“路由”算；要求独立窗口则 FAIL） | 单窗口 + 路由；Quick Box 是独立窗口 |
| VIS-02 | L1 | PASS | ID-01 翻面证据（11-04 UI） |
| VIS-03 | L1 | TODO | 没有 Model Map |
| VIS-04 | L1 | PASS（fixture 帧） | `OG-FINAL/rewind-*`：没有 key 时 BLOCKED；有 key 时在 main 解密；明文帧拒绝显示 |
| VIS-05 | L1 | BLOCKED | Quick Box 窗口可以打开（`OG-FINAL/quickbox.png`）；按快捷键要人工 |
| VIS-06 | L1 | PASS | `OG-FINAL/home-dom-empty-runtime.json` |
| VIS-07 | L1 | PASS | app 复测（`VIS-07/2026-11-05-rerun-*`）：Runtime 读不到时，「今天」/「待办」显示读取失败原因，不再显示 0 条 |
| VIS-08 | L1 | BLOCKED | 要人工撤销 TCC 授权 |
| VIS-09 | L0 | BLOCKED | 菜单栏已实现（OG-04）；打开菜单要人看 |
| VIS-10 | L1 | BLOCKED | 更新：OG-D4/D3；恢复：检查和动作都在，但「失败 → 恢复」在 app 层 UNKNOWN |

### INT / PRIV
| ID | 层级 | 状态 | 原因 / 证据 |
|---|---|---|---|
| INT-01..06 | L1 | BLOCKED | 云 / 账号 / 第三方连接器（X1 / OG-D1） |
| PRIV-01 | L2 | UNTESTED | 需要抓包；CSP `connect-src 'self'` 只是旁证 |
| PRIV-02 | L1 | PASS（模拟到期） | `PRIV-02/2026-11-05-record.txt`；`OG-FINAL/settings-dom.json` |
| PRIV-03 | L1 | PASS | `PRIV-03/2026-11-05-record.txt` |
| PRIV-04 | L2 | UNTESTED | `src/main/het/redact.ts`、`identity/redact.ts` 有单测；Runtime egress 没测 |
| PRIV-05 | L3 | PASS（事实已记录） | `OG-FINAL/priv05-fact.txt`：index.db 是明文 SQLite，截图是密封的 |
| PRIV-06 | L1 | PASS | `PRIV-06/2026-11-05-record.txt`（真实 `persome clean` 跑在临时 root 上；撤回） |
| PRIV-07 | L1 | PASS | `PRIV-07/2026-11-05-record.txt` + ID-11 |
| PRIV-08 | L3 | PASS（dev build） | `MEM-11/token-scan.txt` |
| PRIV-09 | L3 | PASS（事实已记录） | `OG-00/CAP-10-static.txt`：dist Info.plist 现在是 `NSAllowsLocalNetworking` + 127.0.0.1/localhost 例外，**不再有** `NSAllowsArbitraryLoads`（11-04 的记录已过时） |
| PRIV-10 | L2 | BLOCKED | 没有会议功能（云） |

### 汇总（[COMPUTED]，OG-FINAL `docs/test-evidence/OG-FINAL/score.txt`；OG-00 的值放在括号里）

| 视图 | 数值 |
|---|---|
| §15.4 DMG 加权，原始 30 个 ID（11-04 口径） | 64/67 = **0.955**（0.910） |
| §15.4 DMG 加权，今天所有已测 ID | 123/161 = **0.764** |
| OG 覆盖，按条数 | 51/84 = **0.607**（25/84 = 0.298） |
| OG 覆盖，加权 | 123/208 = **0.591**（0.293） |
| 严格口径（只有实现者证据的 PASS 算 UNTESTED） | 43/84；106/208 = 0.510 |
| L2/L3 测试（42 个） | PASS 22，FAIL 12，BLOCKED 6，UNTESTED 2；加权 66/126 = 0.524 |
| 状态分布 | PASS 51 · FAIL 13 · BLOCKED 17 · TODO 1 · UNTESTED 2（OG-00：25 · 2 · 13 · 5 · 39） |

0.955 只是可比口径，不是 OG 完成度。12 个 L2/L3 FAIL 都是上游 Runtime 的 MOD/MEM 行为。采集的 L2/L3 仍然全部 BLOCKED，要等人工 TCC 授权。依赖解读的判定（MOD-13、MOD-11、MOD-07/08、VIS-07、VIS-01），两种算法都列在 REPORT 里。
