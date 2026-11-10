# Persome Lens — GAP vs S1（文章目标）

> Round 2：见 [GAP-vs-S1-R2.md](GAP-vs-S1-R2.md)。本文件是 Round 1 的记录；S1-06 / S1-08 / S1-11 已按 Round 2 Phase 0 审计（GAP-vs-S1-R2 §1）从 DONE 改为 PARTIAL。

状态口径：DONE 只表示该机制已实现，并且有测试或真实运行证据。页面能渲染，或者长得像文章截图，都不算 DONE。

Oracle：S1 文章（mp.weixin.qq.com/s/k5D4zCbwMgZc2RupRYPWqA，镜像 news.qq.com/rain/a/20261104A0E5ZC00）。
**不是** 原版 DMG / S2 访谈。
`docs/test-evidence/REPORT.md` 的 `0.91` 是对 DMG 的加权分，不能用来证明 S1 完成。
冲突时优先 S1，取舍写在本文件和 `DEVIATIONS.md`。

S1 一句话：把电脑上的工作现场变成用户自有的 Personal Database；任何 Agent 动手前通过 MCP 读到“你”的上下文、工作方法和判断。

## 0. 基线（2026-11-05，Phase 0）

| 项 | 结果 |
|---|---|
| git | 非 git 仓库（未 init） |
| `npm run typecheck` | 0 错误 |
| `npm test` | 485 passed / 4 skipped（49 files，3 skipped） |
| `npm run e2e`（`E2E_NO_FOCUS=1`，临时 root） | 22 PASS / 4 SKIP（4 个采集焦点步骤，需要把窗口带到前台，按要求跳过） |

## 1. S1 目标逐条（before → after）

状态：DONE / PARTIAL / BLOCKED / TODO。after 列在每个任务完成后填写。

### U1 Personal Database
| 目标 | Before | After | 状态 |
|---|---|---|---|
| 采集（AX+OCR） | native 采集 + ingest；L2/L3 BLOCKED（CAP-01/08/09） | 未改采集逻辑；L2/L3 仍需真实 TCC 授权与心跳/URL 证据 | BLOCKED（权限/人工） |
| 采集状态可见 | 有权限/排除/暂停，缺 source/OCR/最近帧 | 诊断卡：source（只读 config.toml）、OCR 开关/策略/tier（config + loopback `/health`）、AX/屏幕录制、最近帧、排除、暂停；可复制诊断（token 擦除） | DONE (S1-04) |
| 导入历史（Claude Code / Codex） | 无 | 「导入」页：扫描（异步、逐文件、4000 文件/1 GiB 上限）→ 预览 → 脱敏暂存 + dry-run → `persome import-data --no-build`；临时 root 真实导入 exit 0、1 个文档入库；构建步骤需 Runtime LLM | PARTIAL (S1-07；构建 BLOCKED by LLM 配置) |
| 自然语言提问 | Search 页 | 未改（不在本轮队列） | TODO |
| 每日 auto-list / brief | 无 | 「今天」页：确定性模板（无 LLM），引用原话、复选框、每条推断行「未核实」，复制/导出 .md | DONE (S1-09) |
| 微信群整理 | 无 | 未做（不在本轮队列；需要微信数据源） | TODO |
| 给 Agent 完整来源（证据链） | MOD-07：candidate receipt missing，sources=[] | 抽屉区分直接来源 / 未解析；只显示 Runtime 原因；全局 drop 计数（delta-report，标“非此条专属”）；复现命令无 token；上游补丁草案 | PARTIAL (S1-01；根因在上游) |
| 时间点证据（asOf） | API 有，UI 无 | 抽屉“截至”选择器，ISO 校验（main + renderer） | DONE (S1-03) |
| 欢迎页“X 个项目、Y 个人” / Library | 只有点/面 | 「资料库」：人/项目/技能三栏，“已整理 X 个项目、Y 个人”，只按 Runtime 字段分类，可开证据/关系 | PARTIAL (S1-08)：计数与分类可用（`tests/library/aggregate`）；但没有“画像”（Root / Faces），技能栏只来自 `behavior_patterns`，不读 Lens Workflow store，导入的 / 分享的 `.lensskill` 不显示（`src/main/library/aggregate.ts`）。Round 2：S2-04 |

### U2 Workflow / Skills
| 目标 | Before | After | 状态 |
|---|---|---|---|
| 任务结构 | Playbook 只读文本 | zod `Workflow`（goal/inputs/tools/steps/artifacts/rules/problems/evidence/provenance/version/source），从 Runtime skills 映射，不可映射留空 | PARTIAL (S1-06)：schema 已实现，但内容大多是空的。Runtime skill 条目只写 Pattern / Context / Evidence（`personal-model/src/persome/prompts/pattern_detector.md:45-52` 的条目格式），所以真实 Workflow 一般只有 goal / context / evidence；steps 只在显式写了 `Steps:` 时才有（`src/main/workflows/parse.ts:294-295`；DEVIATIONS D25）。Round 2：S2-07（外部 Agent 抽取 → 粘贴 JSON） |
| 可复用 / 导入 / 导出 | 无 | 本地版本化 store（保留观察原件）、手动编辑、JSON 导入导出（校验、去重、新 id 防顶替） | DONE (S1-06，机制；`tests/workflows/*`)。导出的内容受上一行限制 |
| Agent 通过 MCP 读 | 无 | Broker `search_workflows` / `get_workflow`（Lens extension，只读，scope `model:search`，脱敏，审计） | PARTIAL (S1-06)：工具可用（`tests/workflows/broker.test.ts`），但 Agent 读到的 Workflow 大多只有 goal / context / evidence，“工作方法”本身基本缺失 |
| 习惯 ≥3 个不同日期 | 未区分 | <3 日期标「观察中」；Faces 无日期标「日期未知」；日期是写入时间 | PARTIAL (S1-05) |
| 授权分享 / 来源三分 | 无 | `.lensskill`（Ed25519 签名、离线验签、篡改拒绝、去重）；徽章 来自观察 / 导入 / 别人分享；“N 个技能文件，M 周的判断。” | DONE (S1-10) |

### U3 Shared moments
| 目标 | Before | After | 状态 |
|---|---|---|---|
| 朋友卡片（Peers） | 只有自己的卡 | 「朋友」页：导入 `.persomecard`，离线验签、篡改拒绝、历史版本；Activity 只显示本机事件；Suggestion 为字面重合，标「未核实」 | PARTIAL (S1-11)：手动导入与验签可用（`tests/peers/*`）；不支持订阅（`src/main/peers/api.ts` `SUBSCRIPTION_STATUS.state = 'unsupported'`，DECISIONS X1/X2），朋友更新必须重新发一次卡片文件；Suggestion 只做字面重合，不是语义判断。Round 2：S2-09（本地订阅文件夹） |
| 每周信草稿 | 无 | 确定性模板（最近 7 天、原话引用、用户自写段落），复制/导出，不发送 | DONE（只做到草稿模板；`tests/peers/*`）。所属任务 S1-11 整体为 PARTIAL |
| 订阅 | 无 | `unsupported`（DECISIONS X1/X2） | BLOCKED（需用户决策） |

### 可计量（HET）
| 目标 | Before | After | 状态 |
|---|---|---|---|
| HET 分钟数 | transport disabled，页面像在工作 | 默认「评估器未启用…0 分钟」+「未测量」；`assessorEnabled` + transport 注入点 + 预算三重门；周报导出写明“不是测量结果” | DONE (S1-02)；真实分钟数 BLOCKED（DECISIONS X3） |
| REST `/het/*` | 只有 IPC | 仍只有 IPC，写入 DEVIATIONS D17 | 不做（取舍） |

## 2. 执行方式

- Lead（主线程）拥有共享接线：`src/main/index.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`、`src/main/s1/deps.ts`、本文件。
- 为了让 subagent 并行而写集不冲突，Phase 0 预先搭好脚手架：`src/main/{workflows,import,library}/{api,ipc}.ts`、`src/preload/{workflows,import,library}.ts`、`pages/{Today,Library,Import}.tsx`，并在 index.ts / preload / App.tsx 中接好。
- 每个任务的计划和结果先写到 `docs/design/s1-log/S1-xx.md`，最后由 lead 汇总到下面的 task log。

## 3. Task log

每个任务的计划 / 改动 / 测试 / 遗留 / 风险见 `docs/design/s1-log/S1-xx.md`（11 份）。摘要：

| 任务 | Agent | 状态 | 关键改动 | 新增测试 |
|---|---|---|---|---|
| S1-01 | evidence + lead | PARTIAL | `components/evidence/model.ts`、`EvidenceDrawer.tsx`、`runtime/deltaReport.ts`、`ipc.ts` `lens:model:delta-report`、`docs/upstream/MOD-07.md` | `tests/evidence/model.test.ts`、`deltaReport.test.ts` |
| S1-02 | het + lead | DONE | `het/service.ts` `assessorGate`、`settings.ts` `assessorEnabled`、`tick.ts`、`ledger.ts` `markGated`、`weekly.ts` `assessorNote`、`pages/Het.tsx` | `tests/het/assessorGate.test.ts`、`weeklyAssessorNote.test.ts` |
| S1-03 | evidence | DONE | `components/evidence/asOf.ts`、`runtime/client.ts` `isValidEvidenceAsOf` | `tests/evidence/asOf.test.ts` |
| S1-04 | capture | DONE | `capture/diagnostics.ts`、`capture/ipc.ts` `lens:capture:diagnostics`、`pages/Capture.tsx` | `tests/capture/diagnostics.test.ts` |
| S1-05 | workflows | PARTIAL | `components/workflows/habit.ts` | `tests/workflows/habit.test.ts` |
| S1-06 | workflows | PARTIAL（schema / store / Broker 工具可用；Runtime 只给 Pattern/Context/Evidence，Workflow 内容大多为空） | `workflows/{schema,parse,runtime,store,service,search,ipc}.ts`、`broker/{catalog,tools,main}.ts`、`WorkflowPanel.tsx` | `tests/workflows/*` |
| S1-07 | import | PARTIAL | `import/{transcripts,redact,markdown,cli,service,ipc}.ts`、`pages/Import.tsx` | `tests/import/*`（含 security） |
| S1-08 | library | PARTIAL（无画像；不读 Workflow store，导入 / 分享的技能不显示） | `library/aggregate.ts`、`pages/Library.tsx` | `tests/library/aggregate,ipc` |
| S1-09 | library | DONE | `library/brief.ts`、`pages/Today.tsx` | `tests/library/brief` |
| S1-10 | skillshare | DONE | `skillshare/{package,service}.ts`、workflows 导入/导出入口 | `tests/skillshare/*` |
| S1-11 | peers | PARTIAL（卡片导入 / 周信草稿可用；订阅 unsupported） | `peers/{store,topics,letter,service,ipc}.ts`、`pages/Peers.tsx` | `tests/peers/*`（含 no-network） |
| 安全审查 | security-reviewer | 10 项：#1 #2 #3 #4 #5 #6 #7b #9 #10 已修；#7a #8 记录不改 | — | `tests/import/security`、`tests/skillshare/security-fixes`、`deltaReport` |

## 4. 结论 / 下一步

### 结束时数字
| 项 | 基线 | 结束 |
|---|---|---|
| typecheck | 0 错误 | 0 错误 |
| `npm test` | 485 passed / 4 skipped（49 files） | 772 passed / 5 skipped（79 files）；新增 skip = `tests/import/real-runtime.test.ts`（需 `LENS_IMPORT_REAL_PERSOME=1` 显式开启） |
| E2E（`E2E_NO_FOCUS=1`） | 22 PASS / 4 SKIP | 22 PASS / 4 SKIP（无回归；E2E 未覆盖 S1 新页面） |
| 新页面渲染冒烟 | — | dev build + mock Runtime + 临时 root：今天 / 资料库 / 导入 / 朋友 / Playbook / 采集 / HET / 证据抽屉均渲染；HET 显示「评估器未启用…」「未测量」。只证明页面能渲染，不证明对应机制可用；机制状态以 §1 和测试为准 |

### 下一步
1. 上游：提交 `docs/upstream/MOD-07.md`、`IMPORT-SOURCE-KEY.md`（需用户同意对外发布）。
2. 为 S1 新页面加 E2E 步骤（导入 fixture → 资料库计数、Broker `get_workflow`、`.lensskill` 往返）。
3. Ask / 自然语言提问、微信群整理（本轮未排）。
4. 用户拍板 DECISIONS X1–X6 后：HET 真实 transport、订阅载体、导入后自动构建。
5. Runtime skill 条目目前只有 Pattern/Context/Evidence：Workflow 的 steps/rules 大多为空，需上游 pattern_detector 输出结构化字段，或用户手动补。
