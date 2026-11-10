# GAP vs S1-R6（S1 最后一轮收口）

日期：2026-11-06。BLOCKED 全表见 `BLOCKED-BURNDOWN.md`。证据根目录：`docs/test-evidence/PHASE5/`。

## 1. 总表

| 面 | before（R5） | after（R6） | 状态 | 证据 |
|---|---|---|---|---|
| Capture 文本 | 11-06：261 帧 / 0 文本，无诊断 | 根因定位：`capture.log` 最后一个 `ax=True` 在 2026-11-05T22:50Z，之后全部 `ax=False screenshot=False title=''`，app `Signature=adhoc` → TCC 在重签后失效（OCR 配置为开，但没有图可识别）。新增：`textHealth.ts`（帧数 / 文本帧 / 覆盖率 / verdict）、Capture 页红色 banner +「打开系统设置」、截图失败原因枚举（`screen_recording_denied` 等）、`scripts/verify-capture-text.sh`（只读、只输出计数、无文本时 exit 2） | 代码 DONE；**文本未恢复**（等用户重新授权，B1） | `PHASE5/capture-text/` |
| OCR fallback 路径 | 未审计 | 审计：Screen Recording 授权时 AX 空会发 OCR 图（测试覆盖）；无 bug。发现 Lens（AX ≥64 字符跳过 OCR）与 Runtime（有缩进行才算内容）规则不一致 `[INFERRED]` | 记录为 B21 | Agent A 审计；`tests/capture/text-health.test.ts` |
| Workflow | skills=0，原因笼统「数据不足」 | 精确诊断：`pattern_detector` 用本地日期，有效日期 = 2（11-04、11-05）；所有候选被「≥3 日期」闸挡住（app combo 5 个 / title 14 / URL 11，最多 2 日期）。11-06 要算数需在 23:59 PST 前有 `llm` block | **BLOCKED（数据）**，未跑 build（不浪费预算） | `PHASE5/workflow-face/DIAGNOSIS.md` |
| `llm_failed` 原因 | 未知 | 157/157（可见日志）= `agent funding daily call limit reached (200/200)`；当时上限 200，现为 20000。无官方重试 → 上游提案 | 原因 DONE；重试 = 上游 B19 | `docs/upstream/timeline-retry.md` |
| Face | 1 shadow 候选、1 日期 | 结构性阻塞：active 需 provenance `both`，需第 2 个 schema；当前仅 1 个非 event 文件 ≥4 条事实，`cross_domain_probe_state` 0 行。单靠日期不会出 Face | **数据不足（结构性）**，B3 | 同上 |
| X3 | 真实 transport PASS，UI 未点 | UI 点击步骤写成待填表；顺序要求：拿到第 3 日期后再打包（否则 TCC 再失效） | PENDING（用户） | `PHASE4/x3/UI-CHECK.md` |
| Runtime 版本（T5） | `/status.version`=0.3.2 跨部署不变（上游 FAIL） | 上游本地分支 `og/r10-version-delete@7066066`：`/health`、`/status` 增加 `schema_revision`、`build_version`、`build_sha`；已部署；Lens T5 marker = `schema:…|build:…` | DONE（本地；合入待上游） | `PHASE5/runtime-r10/` |
| Runtime 按条目删除 | 只有提案 | 三个路由（事务 + bearer + `memory_deltas` 审计 + 幂等 + 404）；上游 2654 passed；Lens 会议「从 Persome 删除…」、连接器删除改走新接口，旧 Runtime 回退 | DONE（本地）；派生记忆不级联 | 同上 |
| 云账号入口 | 只在 Chat 页 | Settings →「云端」：地址、状态、指纹、登录 / 退出 / 删除（main 原生确认）/ 开关；无新 IPC。没有按功能的云开关（代码里本来就只有全局开关，未虚构） | DONE | `PHASE5/cloud-settings/` |
| 云真实验证 | Chat / SMTP / Soniox / 麦克风未验证 | 不变；每项写成带环境变量的命令 | BLOCKED（用户凭据）B4–B6 | `BLOCKED-BURNDOWN.md` |
| OS / CAP | 需人工 GUI/TCC | 不变；清单 Results 表保持空 | BLOCKED（用户）B7–B8 | `CAP-L2L3-CHECKLIST.md` |
| 测试临时目录 | 每次全量 +169 个目录 | 前缀守卫 helper；全量前后 4136 → 4136；dev E2E 仍保留 1 个 `persome-lens-e2e-*` 产物目录（有意保留，打印路径） | DONE | `PHASE5/tmpdir/` |
| 签名 / 公证 | ad-hoc | 不变；新增 B18（本地自签代码签名身份，防止每次打包丢 TCC） | BLOCKED（用户） | `BLOCKED-BURNDOWN.md` |

## 2. 验证（2026-11-06 16:08 PST，本机）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 |
| `npx vitest run` | 201 files passed / 5 skipped；**2130 passed / 7 skipped / 0 failed** |
| `npm run build` | 0 |
| `npm run e2e`（dev，`out/`） | PASS 41 / SKIP 1 |
| `cd cloud && npm test` | 118 / 118 |
| 上游 `pytest`（agent C） | 2654 passed / 1 skipped / 0 failed |
| `e2e:packaged` | **本轮未跑**：dist 未重新打包（重新打包会重签并丢 TCC，见 B18），上轮 PASS 仍对应当前 `.app` |

基线说明：brief 的 2064/15 已过期；本轮新增测试来自 4 个并行 agent，skip 15→7 未逐一归因。

## 3. 本轮仍未达成的目标

1. `visible_text` **已恢复**：2026-11-06 20:33:38 PST 起 `ax=True`（`tccutil reset` 后重新授权）；Screen Recording 仍未生效。
2. 3 个有效日期 **已拿到**（11-06：77 个 `llm` block）。
3. 第一个真实 Workflow **仍没有**：日期闸已过（5 个候选），但都是标题 / URL 重复，被 LLM 准入规则拒绝（恢复后 9 次自动检测）；Face 另有结构性阻塞。未额外消耗 LLM 预算。
4. X3 UI **未实测**。
