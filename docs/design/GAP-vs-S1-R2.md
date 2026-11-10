# Persome Lens — GAP vs S1, Round 2

Oracle：S1 文章（mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA；镜像 news.qq.com/rain/a/20261104A0E5ZC00）。
S2 访谈 / 原版 DMG 是另一个 oracle（`docs/test-evidence/REPORT.md` 的 0.91 只对 DMG）。冲突时 S1 优先，取舍写 `DEVIATIONS.md`。
Round 1 结果：`GAP-vs-S1.md`。默认决策：`DECISIONS-ROUND2.md`。每个任务的明细：`s2-log/S2-xx.md`。

## 0. 基线（2026-11-05，Round 2 Phase 0）

| 项 | 结果 |
|---|---|
| git | 非 git 仓库 |
| `npm run typecheck` | 0 错误 |
| `npm test` | 772 passed / 5 skipped（79 files，4 skipped files） |
| `npm run build` | 通过 |

## 1. Phase 0 审计：Round 1 的 “DONE” 对照代码

| Round 1 标签 | 代码事实 | 修正 |
|---|---|---|
| S1-06 Workflow 任务结构 DONE | `src/main/workflows/runtime.ts` 只从 Runtime skill 文件映射；Runtime 只写 Pattern/Context/Evidence，steps 仅在显式 `Steps:` 时才有。真实 Workflow 绝大多数只有 goal/context/evidence | **PARTIAL**：schema 有，内容空 |
| S1-08 资料库 DONE | `library/aggregate.ts` 只有 人/项目/未分类 + `behavior_patterns` 技能；无“画像”，不读 Lens Workflow store（导入 / 分享的 `.lensskill` 不显示） | **PARTIAL** |
| S1-11 朋友 DONE | 卡片导入 / 周信可用；订阅 `unsupported` | **PARTIAL** |
| S1-02 周报导出“未写明 assessor 关闭” | `src/main/het/weekly.ts` 已有 `assessorNote()`；README Limitations 那句是漂移 | 删 README 旧句 |
| 自然语言提问 / 微信群 | 无 “问” 入口，无 recipe | TODO → S2-03 |
| 首启 | 启动直接进 “总览” | TODO → S2-01 |
| 全量导出 / 备份 | 只有单项导出 | TODO → S2-02 |
| E2E | 新页面无覆盖 | TODO → S2-05 |

## 2. Round 2 计划（每任务 3–5 行）

执行方式：lead 搭脚手架（`s2-log/BRIEF.md` 列出的共享接线），5 个实现 agent + 1 个文档 agent 并行，写集不相交；E2E 与安全审查在实现之后。

- **S2-01 Onboarding**（onboard-ask）：`<LensStore>/onboarding.json`（0600）判定首启；可跳过的步骤：欢迎 → 权限 → 连接 → 导入 → 完成（`libraryHeadline`）；纯状态机测试。
- **S2-02 备份**（backup-import）：`persome model export --out <dir>/model-snapshot.json`（execFile、PERSOME_ROOT）+ 复制 Lens 数据白名单 + manifest；恢复只合并 workflows/peers；私钥 / grants / audit 不进备份；临时目录写完再 rename。
- **S2-03 问**（onboard-ask）：≥4 个固定 prompt 卡片（工具名、复制、去 Connections、"Lens 不调用 LLM"）；微信群 recipe 写明 OCR/AX 限制。
- **S2-04 资料库画像 + Workflow**（library-today）：画像区块（Root / Top 3 Faces / counts → Model）；技能列合并 Workflow store（observed / imported / shared 徽章，去重，深链 Playbook）。
- **S2-05 E2E**（e2e，最后）：今天 / 资料库 / 导入 / 朋友 / Workflow / `.lensskill` / onboarding / 问 / 备份；标 `[real]`/`[mock]`。
- **S2-06 文档**（docs + lead）：GAP-vs-S1 S1-06/08/11 → PARTIAL；README 漂移；DEVIATIONS D32+。
- **S2-07 Workflow 抽取**（workflows）：prompt + schema → 外部 Agent → 粘贴 JSON → 校验保存（user_edited / imported），不覆盖 observed id。
- **S2-08 下一步**（library-today）：只从 `- [ ]` / `TODO:` / `待办：` 与已学 habits；每条「未核实」；不叫 Performance。
- **S2-09 订阅文件夹**（peers-sub）：选文件夹 → 手动刷新 → 验签导入 `.persomecard` / `.lensskill`，hash 去重，默认关闭，不联网。
- **S2-10 导入后构建开关**（backup-import）：默认关；打开二次确认；失败显示退出码 / stderr。
- **S2-11 / S2-12**（docs）：`PERFORMANCE.md`、`upstream/HABIT-3-DATES.md`、`upstream/CAPTURE-L2L3.md`。

## 3. S1 目标逐条（Round 1 → Round 2）

状态：DONE = 机制 + 自动化证据（单测 / E2E）；PARTIAL = 机制有、但有已知缺口；BLOCKED = 需要用户决策 / 上游 / 人工权限。“页面看起来像文章”不算 DONE。

### U1 Personal Database
| 目标 | Round 1 | Round 2 | 状态 | 证据 |
|---|---|---|---|---|
| 欢迎 / 首启 | 无 | 5 步可跳过引导（欢迎 / 权限 / 连接 / 导入 / 完成 + `libraryHeadline`），`onboarding.json` 0600，老 Store 不打扰，设置里可重开 | DONE (S2-01) | `tests/onboarding/*`（41）；E2E 2 步 |
| 采集 L2/L3 | BLOCKED | 未改；补人工验收清单 `docs/upstream/CAPTURE-L2L3.md` | BLOCKED（TCC 人工） | — |
| 导入历史 | PARTIAL | +「导入后构建」开关（默认关、不保存、二次确认） | PARTIAL（构建要 Runtime LLM；工具输出/思考/子代理不导入；增长会话重导会重复，D27） | `tests/import/build-after.test.ts`；E2E scan+prepare |
| 自然语言提问 | TODO | 「问」页 4 个 prompt 卡（工具名对照 catalog），交给外部 Agent；Lens 不调 LLM | PARTIAL（Lens 内无回答视图；结果在外部 Agent 里） | `tests/ask/*`；E2E |
| 微信群整理 | TODO | recipe 卡：`search_captures` + `read_recent_capture`，写明 AX/OCR/保留期限制 | PARTIAL（只覆盖屏幕上出现过的内容；OCR 默认关） | `tests/ask/*` |
| 每日 brief + 下一步 | DONE（brief） | 「下一步」只来自 `- [ ]` / `TODO:` / `待办：` + 习惯原文，每条未核实 + 来源 | DONE (S2-08)；主动推送不做（X9） | `tests/library/nextSteps.test.ts`；E2E 导出含 `## 下一步` |
| 资料库 人/项目/画像/技能 | PARTIAL | 画像（Root 原文 + Top3 Faces Runtime 排序 + 计数）；技能合并 Workflow store（观察/导入/分享/编辑/外部抽取徽章），深链 Playbook；分段容错 | DONE (S2-04) | `tests/library/{skills,portrait}`；E2E |
| 全量导出 / 备份 | 无 | 模型快照（`persome model export`）+ Lens 白名单 + sha256 manifest；恢复合并 workflows/peers；私钥/grants/audit 不进备份 | DONE (S2-02)；恢复丢 Workflow 历史（D36） | `tests/backup/*`（25）；E2E 导出 |
| 证据链 | PARTIAL | 未改 | BLOCKED 上游（MOD-07） | — |

### U2 Workflow / Skills
| 目标 | Round 1 | Round 2 | 状态 | 证据 |
|---|---|---|---|---|
| 任务结构有内容 | PARTIAL（大多空） | 外部 Agent 抽取：prompt + zod 派生 JSON Schema → 粘贴回 → 校验 → `ext-*`（不覆盖 `rt-*`）；parser 支持 `###`/纯文本 Steps | PARTIAL：靠用户手动跑外部 Agent；Runtime 观察到的仍为空（上游只写 Pattern/Context/Evidence/Confidence） | `tests/workflows/extract*`、`parse-sections`；E2E 4 steps 的 fixture skill |
| 资料库/Agent 可读 | DONE | 技能列显示 `.lensskill`；Broker `get_workflow` E2E 覆盖 | DONE | E2E |
| 习惯 ≥3 日期 | PARTIAL | 上游提议 `docs/upstream/HABIT-3-DATES.md` | PARTIAL / BLOCKED（X6、X10） | — |
| 越用越厚 / 分享 | DONE | 订阅文件夹可带 `.lensskill`（仅来自已在朋友列表的签名者） | DONE | `tests/peers/subscription.test.ts` |

### U3 Shared moments
| 目标 | Round 1 | Round 2 | 状态 |
|---|---|---|---|
| 朋友卡片 | PARTIAL | E2E 覆盖导入/篡改拒绝 | DONE |
| 每周信 | DONE（草稿） | 未改；不发送 | PARTIAL（无送达，X1） |
| 订阅 | `unsupported` | 本地订阅文件夹，手动刷新，验签，hash 去重，不联网 | PARTIAL（无后台同步，X2） |

### 可计量
| 目标 | 状态 |
|---|---|
| HET 分钟数 | BLOCKED（X3）；页面「未测量」；HET 页去掉 “Performance” 字样（D40） |
| Performance | BLOCKED（X4）：`docs/design/PERFORMANCE.md` 三选项 + 推荐，不实现 |
| 主动层（Tray / 通知 / 快捷键） | 不做（X9） |

## 4. Task log

| 任务 | Agent | 状态 | 关键文件 | 测试 |
|---|---|---|---|---|
| S2-01 Onboarding | onboard-ask | DONE | `src/main/onboarding/store.ts:47-110`、`ipc.ts`；`components/onboarding/flow.ts:51`；`pages/Onboarding.tsx`；Settings 重开（lead） | `tests/onboarding/*` 41 |
| S2-02 备份 | backup-import | DONE | `src/main/backup/service.ts`（`scanForSecrets`、`exportTo`、`validate`、`restore`）；`components/backup/*` | `tests/backup/*` 25 |
| S2-03 问 | onboard-ask | DONE | `components/ask/prompts.ts:39`、`askView.ts`；`pages/Ask.tsx` | `tests/ask/*` 9 |
| S2-04 资料库 | library-today | DONE | `src/main/library/skills.ts`、`aggregate.ts:84-180`、`ipc.ts:44-80`；`components/library/viewModel.ts`；`pages/Library.tsx` | `tests/library/{skills,portrait}` |
| S2-05 E2E | e2e | DONE（37 PASS / 5 SKIP） | `tests/e2e/smoke.e2e.mjs`、mocks、`fixtures/model-graph.json`、`packaged-check.sh`（仅 `bash -n`） | — |
| S2-06 文档 | docs + lead | DONE | `GAP-vs-S1.md`（S1-06/08/11 → PARTIAL）、README、DEVIATIONS D32–D40 | — |
| S2-07 抽取 | workflows | PARTIAL（机制 DONE；内容靠外部 Agent） | `src/main/workflows/extract.ts`、`store.ts:309`、`parse.ts:183-185`；`ExtractPanel.tsx`；`Playbook.tsx` 深链 | `tests/workflows/extract*` 等 31 |
| S2-08 下一步 | library-today | DONE | `src/main/library/brief.ts:199`；`pages/Today.tsx:83-118` | `tests/library/nextSteps` 9 |
| S2-09 订阅 | peers-sub | DONE（本地，手动） | `src/main/peers/subscription.ts`；`components/peers/SubscriptionSection.tsx` | `tests/peers/subscription` 13 |
| S2-10 导入后构建 | backup-import | DONE | `pages/importView.ts:136-204` | `tests/import/build-after` 10 |
| S2-11 Performance | docs | DONE（文档；指标 BLOCKED） | `docs/design/PERFORMANCE.md` | — |
| S2-12 上游 | docs | DONE（文档；未提交） | `docs/upstream/{HABIT-3-DATES,CAPTURE-L2L3}.md` | — |
| 安全审查 + 修复 | security-reviewer + security-fix | M1 M2 L2 L3 L4 已修；L1 L5 记录 | `s2-log/S2-SEC.md` | `tests/security/redact-errors` 等 16 |

## 5. 结论

| 项 | 基线 | 结束 |
|---|---|---|
| typecheck | 0 错误 | 0 错误 |
| `npm test` | 772 passed / 5 skipped（79 files） | 932 passed / 5 skipped（96 files，4 skipped files） |
| `npm run build` | 通过 | 通过 |
| E2E（`E2E_NO_FOCUS=1`） | 22 PASS / 4 SKIP | 37 PASS / 5 SKIP / 0 FAIL（新 SKIP = 备份恢复，理由见 S2-05；恢复由单测覆盖） |

剩余风险：备份对超大快照（>~512 MiB）必失败且同步 I/O 卡 UI（L1）；快照脱敏依赖 Runtime 默认（L5）；`packaged-check.sh` 未在打包产物上实跑；renderer 提供的 `confirm:true` 是 IPC 固有信任边界。

下一步：用户拍板 `DECISIONS-ROUND2.md`；上游 Runtime 输出结构化 Steps/Artifacts/Rules/Problems；打包后跑 `npm run e2e:packaged` 与 CAP-01/08/09 人工清单。
