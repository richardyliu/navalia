# Persome Lens — GAP vs S1-FULL（opt-in 云轮收尾，2026-11-06）

上一轮：`GAP-vs-S1-R4.md`（下表「before」列）。本轮架构：`S1-FULL-ARCH.md`。决定：`DECISIONS.md` S1F-1 … S1F-15。偏离：`DEVIATIONS.md` D71 起。
每个 C 项的过程记录在 `docs/design/s1full-log/`（下文简写为 `log/`）。最终门禁数字由 lead 在 2026-11-06 给出，见 §2。

判定规则（本文统一）：
- **DONE**：验收要求的行为有自动测试或真实运行证据，不依赖用户尚未提供的真实账号 / 密钥 / 硬件。
- **PARTIAL**：机制做完并测过，但验收的一部分只在 fake / mock 上验证过，或上游缺接口。
- **BLOCKED**：验收本身需要用户的真实账号、密钥、证书、硬件或批准，当前无法满足。
- 只在 fake / mock 上测过的，一律写明「fake」「mock」。真实 LLM、Soniox、SMTP 收件箱、IMAP 邮箱、Notification Center / Tray / 全局快捷键、真实麦克风、Docker 构建、Developer ID 都**没有**在真实环境验证过，不会记成 DONE。

## 0. 基线（R4 收尾 → 本轮收尾）

| 项 | R4 最终（2026-11-05） | S1-FULL 最终（2026-11-06） |
|---|---|---|
| Lens typecheck | rc=0 | exit 0 |
| Lens vitest | 152 个文件通过、4 跳过；1578 通过 / 5 跳过 / 0 失败 | **194 个文件通过、4 跳过；2042 通过 / 6 跳过 / 0 失败**（lead 收尾修复后最终一次；此前 193 / 2040 连续 2 次） |
| Lens build | rc=0 | OK |
| Lens e2e（`E2E_NO_FOCUS=1`） | 37 PASS / 5 SKIP | **37 PASS / 5 SKIP**，其中包括「云端关闭时 15 s 内没有非 loopback socket」（`tests/e2e/smoke.e2e.mjs:757`） |
| `cloud/` 测试 | 不存在 | **118 / 118 pass**（`cd cloud && npm test`） |
| 上游 pytest | 2622 passed / 0 failed / 1 skipped @ `462361d` | 本轮**没有重跑**（上游没有新提交，见 C22） |
| §15 上游复测 | 63/63（R4 时用 worktree venv） | **63/63**，这次在**部署后的 venv** 上跑（`docs/test-evidence/S1FULL-C22/check_results.txt`） |
| Runtime | `462361d`，schema `2026-11-05.3` | 不变：`462361d` = tag `deploy/2026-11-05-r1r9`，部署 venv 与源码逐字节一致，schema `2026-11-05.3`，无迁移，`/health ok` |
| 真实数据（consolidated 副本） | relation_edges 187 | entries 138 / evo_nodes 96 / captures 3152 / relation_edges 302（`S1FULL-C22/summary.md` §2） |
| 备份 | `20261105-173654-pre-r8`、`20261105-180023-pre-r9` | 新增 `/Users/ryl/Persome Backups/20261106-101058-pre-c22`（`manifest.sha256` 39 个文件，`shasum -c` 0 失败） |

## 1. S1-FULL 目标 / C 项 × before / after

### 1.1 验收目标（brief 的 acceptance 行，§3 计分用）

| # | 目标 | R4（before） | S1-FULL（after） | 状态 | 证据 |
|---|---|---|---|---|---|
| G1 | **local-only 零出网**（默认模式） | 本地唯一模式；所有 socket 在 127.0.0.1 | 云端默认关；关闭时每个云入口在发请求前就返回 `disabled`（全局 fetch spy 0 次）；静态扫描：`src/main/cloud` 只有 `client.ts` 调 fetch，connectors 只有 `imap/tls.ts` 用 `node:tls`；真实 Electron dev build 上 e2e 用 lsof 采样整个进程树 15 s，0 个非 loopback socket。打包版本轮没有重跑 `e2e:packaged` | **DONE** | `tests/cloud/disabled.test.ts`、`tests/connectors/no-network.test.ts`、`tests/e2e/smoke.e2e.mjs:757`、`log/C2.md` |
| G2 | **云端 challenge / verify 登录** | BLOCKED（X1 未批准） | Ed25519 设备密钥 challenge → verify → Bearer；audience 绑定、challenge 单次、token 只存 sha256；lead 在 gate 发现并修复**小阶公钥伪造**（S1F-2）；Lens 客户端对真实 `cloud/` 子进程完成登录 → 注销 → 再登录 → 删账号 | **DONE**（TLS / 反向代理 / Docker 是部署项，未验证） | `cloud/test/auth.test.ts`、`tests/cloud/e2e-real-server.test.ts`、`tests/cloud/auth.test.ts`、`log/C0-C1.md` |
| G3 | **Chat：带引用的回答 + 发送前预览 + 写回记忆 + 截图不出机** | BLOCKED | 预览逐条可去掉、renderer 不能注入文本；真实 `cloud/`（**mock LLM**）上：线上 context 与预览逐字节一致，不含 token / `data:image` / `.png` / `screenshots/` / `index.db` / 手机号；引用对应已发送快照；「记住这条」经 native confirm 走 MCP `remember`。openai 适配器只对**测试内 fake 上游**验证 | **PARTIAL**：真实 LLM **未在真实环境验证**（需要用户的 LLM key） | `tests/cloud/e2e-chat-real-server.test.ts`、`tests/cloud/chat.test.ts`、`cloud/test/{chat,llm}.test.ts`、`log/C3-C7.md`、`log/C4.md` |
| G4 | **订阅：测试收件箱收到周信、退订生效、伪造卡片 / 周信被拒、无阅读追踪** | 本地文件夹订阅（D38）；周信只有草稿 | 真实 `cloud/` + **outbox 模式（`.eml` 文件充当测试收件箱）**：双重确认（GET 不确认）、周信送达（List-Unsubscribe + One-Click、无 `<img>`、只有一个 href）、RFC 8058 POST 退订后第二封 0 收件人、伪造卡 / 伪造周信两端都拒、Bob 离线验签。真实 SMTP 只对 **fake SMTP 服务器**验证 | **PARTIAL**：真实收件箱投递 **BLOCKED**（需要用户的 SMTP + SPF/DKIM/DMARC） | `tests/cloud/e2e-subs-real-server.test.ts`、`cloud/test/{letters,subscribe,mail-unit}.test.ts`、`log/C8-C9.md`、`log/C8-C10.md` |
| G5 | **会议：录音 → 转写 → 写回；两端删除；没有同意就不录音** | BLOCKED（PRIV-10 无麦克风） | 真实 `cloud/`（**mock STT**）：无 consent / 拒绝 confirm → 不建会议、mic 拒绝；mic gate 只放行 audio + app URL + 已武装；2×30 s 分片 → ready；服务器音频目录清空、本机音频删除；Markdown → **真实 `persome import-data`（临时根）** imported 1；删除后服务器 404、本机目录消失。Runtime 内按条目删除上游没有接口 | **PARTIAL**：真实麦克风 + MediaRecorder 轮换没跑过；Soniox 只对 fake server；导入内容不能按条目删除（`runtimeRemains: true` 如实提示） | `tests/cloud/e2e-meetings-real-server.test.ts`、`tests/cloud/meetings{,-pure}.test.ts`、`cloud/test/{meetings,stt-soniox}.test.ts`、`log/C12-C14.md`、`log/C13-server.md` |
| G6 | **Workflow 有真实步骤** | PARTIAL（R8 已部署，真实运行 BLOCKED 于 LLM 预算） | 两条路径都做完：上游映射（R8 fixture 有 steps，空上游给 0 个、不编造）；云端抽取（会话预览 → 只发勾选条目 → 严格 zod 校验 → 用户编辑 → 保存，provenance `cloud_extracted`）。但 2026-11-06 真实 `behavior_patterns().skills = []`；云端抽取只在 **mock LLM** 上跑过，mock 的 step 是把条目标题抄过去，不是真实步骤 | **BLOCKED**：真实数据上没有任何一个带真实 steps 的 Workflow；需要 Runtime LLM 额度（R8 pattern_detector）或用户的云端 LLM key | `tests/workflows/cloud-extract{,-real-server}.test.ts`、`log/C15.md`、`log/C18-C15-server.md` |
| G7 | **表现可回溯** | 「本周 AI 工作计数」（X4 = B）已 DONE | C16：按天 / 周的 accepted / rejected / not_agent、会话里的 `git commit` 调用、用户添加仓库的提交；每个数字 = 可点开的行数；读不到的来源是 `null`（「未知 / 未接入」）不是 0；项目只列活动不算进度；只给本人看（静态扫描）。只在 fixture het.db / fixture transcript / 临时 git 仓库上测过；截图是空 store | **DONE**（fixture 验证；真实数据未看过） | `tests/performance/*`、`log/C16-C17.md`、`log/phase4-performance-empty.png` |
| G8 | **通知可以关闭** | X9 本机通知 DONE（T5 部分），没跑过真实 Notification Center | C17：总开关关闭即清 timer、注销快捷键、清空托盘项、丢弃待发事件；默认全关（含 v1 迁移）；上下文不足就沉默并记录原因。全部用 **fake** Notification / globalShortcut / Tray 测试 | **PARTIAL**：关闭语义有测试，但真实 Notification Center / Tray / 全局快捷键**未在真实环境验证** | `tests/proactive/{c17,gates,no-network}.test.ts`、`log/C16-C17.md`、`docs/test-evidence/CAP-L2L3-CHECKLIST.md` B2（NOT RUN） |
| G9 | **共同经历不是字面重合** | 字面重合 + 相关度门槛（D67） | C18：双方签名对象，服务器只转发，客户端每次读都离线验两个签名；陌生签名者不能接受；周信只引用 `visibility:"letters"` 的已接受条目；字面重合降级为「关键词重合（未核实，不是共同经历）」且不进任何信。真实 `cloud/` 两把真实密钥 e2e，并用服务器的 `verifyMomentText` / `verifyAcceptanceText` 交叉验证 Lens 产出的对象 | **DONE** | `tests/cloud/e2e-moments-real-server.test.ts`、`tests/cloud/moments{,-sign,-letter}.test.ts`、`cloud/test/moments.test.ts`、`log/C18-C11.md`、`log/PHASE4-GATE.md` |
| G10 | **连接器：导入 + 删除** | 本地 `.ics` / 健康 CSV-JSON / `.eml` / mbox，只能导入 | C19：每个连接器单独 consent；Apple Health XML/zip、通用 CSV、只读 IMAP（隐式 TLS，**只对 loopback 自签证书 TLS 服务器验证**）；删除：健康记录在**真实 Runtime（临时根）**上删除成功；remember 记忆只在 evomem 写入权限下可删（默认 markdown 下列为剩余）；时间线文档上游没有按来源删除的接口；OAuth 没有 client id | **PARTIAL** | `tests/connectors/{consent,imap,apple-health,csv-import,delete,real-runtime}.test.ts`、`log/C19.md` |
| G11 | **备份能恢复 cards + 历史** | cards 恢复；Workflow 以新 `imp-*` id 恢复且只有最新版本（D36） | C21：manifest 用身份密钥签名；本人签名 → Workflow 按原 id 逐字节恢复全部版本；卡片逐张验签、字节一致；可选 AES-256-GCM（scrypt）单文件加密；篡改 / 错口令 / 截断全部拒绝且不写入。另一身份（新电脑）签名的备份 → 恢复成重新编号的副本（含全部历史） | **DONE**（新电脑后果见 §5 第 9 条） | `tests/backup/c21-archive.test.ts`、`log/C20-C21.md` |
| G12 | **MOD / MEM 复测 PASS 或 BLOCKED** | 63/63（worktree venv） | 部署后 venv 上 63/63 PASS（MOD-01/02/04/07/08/09/11/12/13/14、MEM-05/09/10；MEM-09 按已记录做法在全新根上单独跑）；LLM 全程 mock，证明的是门槛与数据契约，不是模型质量 | **DONE** | `docs/test-evidence/S1FULL-C22/{summary.md,check_results.txt}` |

### 1.2 C 项明细

| C | 内容 | before（R4） | after | 状态 | 证据 |
|---|---|---|---|---|---|
| C0 | 云架构文档（决策翻转、出境清单、STRIDE、API、保留） | 无 | `S1-FULL-ARCH.md`。（Round 4 复核：ARCH 已写 404，与 `cloud/src/moments.ts` `answerable` 和 `cloud/test/moments.test.ts:282` 一致；剩下的 403 指发起者回应自己的时刻，是正确的） | DONE | `docs/design/S1-FULL-ARCH.md`、`log/PHASE4-GATE.md` |
| C1 | `cloud/` Phase 0：登录 / 会话 / 删账号 / 限流 / 无敏感日志 / 迁移 | 无 | 实现；小阶公钥伪造由 lead 修复（S1F-2）；Dockerfile 已写，**未构建**（Docker daemon 未运行） | DONE（Docker PARTIAL） | `cloud/test/*.test.ts`、`log/C0-C1.md` |
| C2 | Lens 云客户端（默认关、token 加密、SSE、IPC） | 无 | 实现；gate 追加：关闭 / 换服务器时注销服务器会话（3 s）、token 绑定身份指纹、loopback http 只在未打包构建允许 | DONE | `tests/cloud/{config,disabled,auth,ipc,sse}.test.ts`、`log/C2.md`、`log/C3-C7.md` |
| C3 | Chat 上下文组装 + 脱敏 + 上限 | 无 | ≤40 条 / 60 000 字 / 每条 8 000；redaction 顺序固定 | DONE | `tests/cloud/context.test.ts` |
| C4 | 服务器 Chat（SSE、OpenAI-compatible / mock、每日预算） | 无 | 实现；**只对 fake 上游**；真实供应商可能要求 `max_completion_tokens` 或拒绝 `stream_options`（未测） | DONE（真实 LLM 未验证） | `cloud/test/{chat,llm}.test.ts`、`log/C4.md` |
| C5 | 流式 + 本机持久化对话 | 无 | `chat/c-*.json` 0600 | DONE | `tests/cloud/chat.test.ts` |
| C6 | 「记住这条」写回 | 无 | native confirm → MCP `remember`（tags `lens-chat,cloud-chat`） | DONE | `tests/cloud/e2e-chat-real-server.test.ts` |
| C7 | 微信群整理 | 只有给外部 Agent 的 prompt（D33） | 只用本周 WeChat capture 的 `search_captures` 片段，按窗口标题分组；不读完整 capture（避免截图字段）；**真实微信窗口标题行为未核对** [INFERRED] | PARTIAL | `log/C3-C7.md` R3 |
| C8 | 云端名片（发布 / 按指纹获取） | 无 | 服务器验签 + Lens 离线再验 + 走 Peers 导入；e2e 真实服务器 | DONE | `cloud/test/cards.test.ts`、`tests/cloud/cards.test.ts`、`tests/cloud/e2e-subs-real-server.test.ts` |
| C9 | 周信 + 邮件订阅服务器 | 无 | 双重确认、退订 / 抑制、outbox worker、保留期；`nodemailer` 10.2.1（S1F-3）；smtp 模式必须设 pepper（lead 修复，S1F-4） | DONE（真实 SMTP BLOCKED） | `log/C8-C9.md` |
| C10 | 「订阅」页 | 本地文件夹订阅 | 草稿（固定模板、无 LLM）→ 预览将要签名的字节 → native confirm → 签名发布；lead 在 gate 加了**周信草稿脱敏**（`redactForCloud`，`src/main/cloud/subs.ts:283-303`） | DONE | `tests/cloud/subs{,-letter,-view}.test.ts`、`log/C8-C10.md` |
| C11 | 周信加入共同经历 | 引用勾选的字面重合条目 | 只列已接受、双签、`letters` 可见、日期落在窗口内的共同经历；备注默认不附 | DONE | `tests/cloud/moments-letter.test.ts`、`log/C18-C11.md` |
| C12 | 录音（consent + mic gate） | 无（PRIV-10） | 主进程 mic gate；lead 在 gate 发现 `build/after-pack.cjs` 会删掉 `NSMicrophoneUsageDescription`（打包版将无法录音），已修复（S1F-6）。**recorder 浏览器胶水没在 Electron 里跑过，真实麦克风没碰过** | PARTIAL | `tests/cloud/meetings-pure.test.ts`、`log/C12-C14.md` |
| C13 | 分片上传 + 服务器转写 | 无 | mock STT e2e 通过；Soniox 适配器按 2026-11-05 文档实现，只对 fake server | DONE（Soniox BLOCKED） | `cloud/test/{meetings,stt-soniox}.test.ts`、`log/C13-server.md` |
| C14 | 转写 → Markdown → Runtime | 无 | 真实 CLI（临时根）导入成功；按条目删除上游无接口，如实提示 | PARTIAL | `log/C12-C14.md`「Runtime deletion」 |
| C15 | Workflow 自动内容 | 外部 Agent 粘贴（D37） | 见 G6 | PARTIAL（代码）/ 验收 BLOCKED | `log/C15.md` |
| C16 | 表现（B + C，不做 A） | B 计数卡 | 见 G7 | DONE | `log/C16-C17.md` |
| C17 | 主动层扩展（事件触发、门槛、决定日志、快捷键、托盘） | T1–T5 | 见 G8；lead 改了事件语义：「我提议的」共同经历被接受时在 `sync()` 首次看到才发布 | PARTIAL（真实 OS 未验证） | `log/C16-C17.md`、`log/PHASE4-GATE.md` |
| C18 | 共同经历 | 字面重合 | 见 G9；lead 修复第三方 accept/decline 403 → 404 | DONE | `log/C18-C11.md`、`log/C18-C15-server.md`、`log/PHASE4-GATE.md` |
| C19 | 连接器 | 本地文件 | 见 G10 | PARTIAL | `log/C19.md` |
| C20 | 导入完整性 | 工具调用默认关；按 hash 去重 | 工具名 / 命令首行 / 路径默认保留（脱敏）；front matter `dedupe_key`；**真实 CLI** 连续导入两次：`{imported:1}` → `{imported:0, unchanged:1}` | DONE | `tests/import/c20-dedupe.test.ts`、`tests/import/real-runtime.test.ts`、`log/C20-C21.md` |
| C21 | 备份 | 见 G11 before | 见 G11；签名 manifest 门控原 id 恢复是 lead 决定（S1F-11） | DONE | `log/C20-C21.md` |
| C22 | 上游部署 / 复测 | R1–R9 已部署 | 用户 2026-11-06 批准；上游无新提交；先备份；63/63 | DONE | `docs/test-evidence/S1FULL-C22/summary.md` |
| C23 | CAP 人工清单、X3、onboarding 资料库预览、文案 | — | 清单写完，**每一行都是 NOT RUN**；X3 仍 BLOCKED（transport 默认关，有测试钉住）；onboarding 预览读真实计数；W1–W6 文案修改已在代码中（`App.tsx:71`、`Settings.tsx:111`、`LocalClaim.tsx`、`peers/api.ts:318`、`PrivacySection.tsx:70`、`Chat.tsx:129`，本文作者 2026-11-06 grep 核对） | DONE（清单本身）/ X3 BLOCKED | `docs/test-evidence/CAP-L2L3-CHECKLIST.md`、`tests/{onboarding/c23-*,het/c23-transport}.test.ts`、`log/C23.md` |

### 1.3 仍然 BLOCKED 的老项

| 项 | 状态 |
|---|---|
| CAP L2/L3（TCC 人工） | BLOCKED（不变）；清单 `CAP-L2L3-CHECKLIST.md` Part A 全部 NOT RUN |
| HET 分钟（X3） | BLOCKED（未批准 transport） |
| 签名 / 公证 / 自动更新 | BLOCKED（没有 Developer ID） |

## 2. 门禁（最终，lead 2026-11-06）

| 项 | 结果 |
|---|---|
| `cd cloud && npm test` | **118 / 118 pass** |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 194 个文件通过 / 4 跳过；**2042 通过 / 6 跳过 / 0 失败**（最终；此前 193 / 2040 连续 2 次）。输出：`docs/test-evidence/S1FULL-FINAL/` |
| `npm run build` | OK |
| `E2E_NO_FOCUS=1 npm run e2e` | **37 PASS / 5 SKIP**，含「no non-loopback sockets over 15 s」（云端关闭） |
| 真实 `cloud/` 子进程 e2e（vitest） | `tests/cloud/e2e-real-server`、`e2e-chat-real-server`、`e2e-subs-real-server`、`e2e-meetings-real-server`、`e2e-moments-real-server`、`tests/workflows/cloud-extract-real-server`（LLM / STT / 邮件均为 mock / outbox） |
| C22 §15 复测（部署后 venv） | **63 / 63 PASS** |

这些数字来自 lead 的最终运行；本文作者没有重跑，仓库里也没有对应的单独证据目录（每个 Phase gate 的中间数字在各 `log/*.md` 末尾）。

各 Phase gate 的中间数字（来自 log，用于看趋势）：Phase 1 cloud 61、vitest 1730；Phase 2 cloud 86、vitest 1777；Phase 3 cloud 108、vitest 1832；Phase 4 cloud 118、vitest 1930。

gate 中 lead 做的修复：
1. 小阶 Ed25519 公钥可伪造签名（单位点 + `R=单位点, S=0` 256/256 通过）→ `isWeakPublicKey` 拒绝（S1F-2，`log/C0-C1.md`）。
2. `build/after-pack.cjs` 删除 `NSMicrophoneUsageDescription` → 打包版无法录音 → 从删除列表移除（S1F-6，`log/C12-C14.md`）。
3. smtp 模式必须设置 `CLOUD_EMAIL_PEPPER`（S1F-4）。
4. 周信草稿逐字引用本机记忆（含路径 / id）→ 加 `redactForCloud`（`src/main/cloud/subs.ts:283`）。
5. 第三方 accept / decline 共同经历 403 → 404，不泄露存在（`log/PHASE4-GATE.md`）。
6. 共同经历接受事件改为「我提议的被接受」时发布（`log/PHASE4-GATE.md`）。
7. `e2e-subs-real-server` 偶发失败的根因：测试对整封邮件做 header unfold，把 QP 软换行合并导致 UTF-8 解码失败；只是测试代码问题，改为只 unfold header 块，之后连续 8 次通过（`log/PHASE4-GATE.md`）。
8. 备份按原 id 恢复只对「用户自己的身份签名的 manifest」开放（C21 修订，S1F-11）。

## 3. 计分

权重：12 个验收目标每个权重 1。理由：brief 没有给权重；任何加权都需要我替用户判断哪个目标更重要，而且容易被调成「刚好过线」。DONE = 1，PARTIAL = 0.5，BLOCKED = 0。

| # | 目标 | 状态 | 分 |
|---|---|---|---|
| G1 | local-only 零出网 | DONE | 1 |
| G2 | 云端 challenge / verify | DONE | 1 |
| G3 | Chat | PARTIAL | 0.5 |
| G4 | 订阅 | PARTIAL | 0.5 |
| G5 | 会议 | PARTIAL | 0.5 |
| G6 | Workflow 真实步骤 | BLOCKED | 0 |
| G7 | 表现可回溯 | DONE | 1 |
| G8 | 通知可关闭 | PARTIAL | 0.5 |
| G9 | 共同经历非字面重合 | DONE | 1 |
| G10 | 连接器导入 + 删除 | PARTIAL | 0.5 |
| G11 | 备份恢复 cards + 历史 | DONE | 1 |
| G12 | MOD / MEM 复测 | DONE | 1 |

计算：DONE 6 个 × 1 = 6；PARTIAL 5 个 × 0.5 = 2.5；BLOCKED 1 个 × 0 = 0。合计 6 + 2.5 + 0 = **8.5 / 12 = 70.8%**（8.5 ÷ 12 = 0.70833…）。

**Lead 复核**：权重与算术正确。唯一有争议的是 G6（Workflow 真实 steps）：抽取机制已完整实现并在真实 `cloud/`（mock LLM）上端到端跑通，缺的是真实数据 + 真实 LLM 的一次运行（需要 LLM key 或 Runtime 额度）——lead 判为 PARTIAL 而非 BLOCKED，得 9 / 12 = **75.0%**。两种判法都**未达 90%**；不为凑数调整权重。

**没有达到 brief 的 90% 目标。**

敏感性（不改变结论）：如果把 G6 记为 PARTIAL、G8 记为 DONE（这是我能找到的最宽松但仍能自圆其说的判法），合计 7 + 2.5 = 9.5 / 12 = 79.2%，仍低于 90%。差距主要来自需要用户真实账号 / 密钥 / 硬件的项（LLM、SMTP、Soniox、麦克风、通知中心），以及上游缺少按条目删除的接口。

## 4. 什么会离开这台 Mac，怎么预览，怎么删除

来源：`S1-FULL-ARCH.md` §4 / §8 与各 log。所有云功能默认关闭；只有在设置里填了服务器地址、确认开启、登录之后，被开启的那一项才发请求。

| 数据 | 功能 | 去哪 | 发送前怎么预览 | 怎么删除 | 服务器保留 |
|---|---|---|---|---|---|
| Ed25519 公钥 + 签名 | 登录 | 你的 `cloud/` | 云端面板（`CloudSetup.tsx`，Chat / 订阅 / 会议共用）登录后显示账号指纹（= 身份指纹，`fingerprintShort`）——lead 收尾补上 | 云端面板「删除云端账号…」→ `DELETE /v1/account`（renderer `confirm:true` + 主进程 native confirm）——lead 收尾补上，`tests/cloud/cloudsetup-account.test.ts` | 账号存续期 |
| Bearer token（服务器只存 sha256） | 全部云 API | 你的 `cloud/` | 不展示 | 退出登录 / 关闭云端（会先尝试注销）/ 删账号 | 30 d 或注销 |
| Chat 上下文条目 + 问题 | 云端对话 | `cloud/` → LLM 供应商 | 发送前逐条显示将发送的完整文本，可去掉 | 服务器不落盘；本机 `chat/c-*.json` 在 Lens 里删 | 0（只在请求内存）；`chat_usage` 只有计数 |
| Workflow 抽取的会话片段 | Playbook「云端抽取」 | `cloud/` → LLM 供应商 | 同 Chat 的逐条预览 | 服务器不落盘 | 0 |
| 会议音频分片（~30 s） | 会议 | `cloud/`；soniox 模式再到 Soniox | 开始前勾选「已告知参会者」+ native confirm；录音中常驻指示 | 会议详情「删除」（服务器 + 本机）；删账号 | 转写成功即删，最长 24 h；Soniox 侧 best effort 删除 |
| 会议标题 + 转写 | 会议 | `cloud/` | 结果回到本机显示 | 同上 | 7 d 后整条删除 |
| 会议摘要用的转写片段（可选） | 会议 | `cloud/` → LLM | 逐条勾选 | 服务器不落盘 | 0 |
| 签名的周信 | 订阅 | `cloud/` → SMTP → 订阅者邮箱 | 发布前显示将要签名的完整字节 | 发出后无法撤回；删账号 | 正文在投递终态后 30 d 删除；投递记录 90 d |
| 订阅者邮箱 | 订阅 | 订阅者自己提交到 `cloud/` | 发布者只看到打码地址 | 退订 / 发布者移除 / 删账号 | 退订后只留 HMAC |
| 签名的个人卡片 | 订阅页「发布卡片」 | `cloud/`，持有指纹的人可取 | 显示可读字段 + 原文 | 「撤回」`DELETE /v1/cards` | 最近 20 版 |
| 签名的共同经历 + 接受 | 朋友页 | `cloud/`（对方可见） | 发起 / 接受前显示完整内容 | 任一方删除，双方都删；对方本机副本要等对方同步后自己删 | 直到删除 |
| IMAP 登录与只读读取 | 连接器（IMAP） | 你填写的 IMAP 主机（993，隐式 TLS） | 单独 consent；读出的邮件先预览再写入 | 撤销同意即删除保存的凭据 | 不经过 `cloud/` |

**永不出机**（任何模式）：截图原图、Runtime `index.db`、Ed25519 私钥、Runtime token、Broker token、Access log 原文、未经预览的内容。服务器**不是端到端加密**：运营方技术上能读到 Chat（请求内存中）、转写、周信、订阅者邮箱、共同经历内容。

本机侧删除仍有上游限制：写进 Runtime 的会议 Markdown、connector 写入的 remember 记忆（默认 markdown 写入权限）和时间线文档不能按条目删除，只能用「设置 → 隐私」的整体删除或 `persome clean …`，界面会列出剩余内容。

## 5. 需要用户决定的事

1. **X3 HET transport**：仍未批准。批准需要：每日调用 / token 预算与耗尽行为；固定的供应商与模型（按 anchor 版本钉住、温度 0）；哪些文本出机、给谁、对方保留条款（建议与 Chat 一样逐条预览）；是否复用云端 `/v1/chat/completions` 加 `task:"het_assess"`（只在 X3 批准且云端已开时）；分钟显示为「估计」+ anchor 版本。未批准前 HET 与 `src/main/cloud` 互不 import，有测试（`tests/het/c23-transport.test.ts`）。打包版里 `LENS_HET_FAKE_ASSESSOR` 在运行时被忽略，但 fixture 代码仍在 bundle 里。
2. **上游按条目删除**：Runtime 需要「按 entry id 删除 Markdown 记忆」和「按来源删除导入的时间线文档」的接口，否则会议导入、connector 记忆、导入文档只能整体删。是否向上游提。
3. **OAuth client ID**（Google / Notion / Outlook）：没有，相关连接器 BLOCKED。
4. **SMTP / DKIM**：真实周信投递需要 SMTP relay、From 域名的 SPF / DKIM / DMARC，以及生产 `CLOUD_EMAIL_PEPPER`。
5. **Soniox key**：真实转写需要 `CLOUD_SONIOX_API_KEY`；适配器未对真实 API 跑过。
6. **LLM key**：真实 Chat / Workflow 抽取 / 会议摘要需要 `CLOUD_LLM_*`；另外 Runtime 侧 R8 pattern_detector 需要 Runtime LLM 额度才能产出第一个真实结构化 Workflow。
7. **Developer ID**：签名 / 公证 / 自动更新仍 BLOCKED。
8. **遗留的临时目录**：`$TMPDIR` 里有 136 个 `lens-upstream-*` 目录（共约 34 MB），来自连接器真实 Runtime 测试（`tests/connectors/upstream.ts:38` 的 `tempRoot` 只建不删）。lead 的清理命令被权限分类器拦下，需要你决定是否删除。
9. **C21 新电脑后果**：身份私钥不进备份。在新电脑（新身份、没有旧密钥的退休记录）上恢复时，所有备份都是「别人签名」，Workflow 会恢复成重新编号的 `imp-*` 副本（历史完整，但 id 变了、provenance 是 `imported`）。只有同一身份或同一 store 上重置身份后，才能按原 id 恢复。是否接受，或者是否要设计私钥迁移。
10. **Docker / 部署**：`cloud/Dockerfile` 未构建；TLS、反向代理、多实例限流、服务器备份轮换都是部署项。
11. ~~删除云账号的入口~~ **已补（lead，收尾）**：云端面板登录后有「删除云端账号…」按钮和账号指纹显示（`src/renderer/src/components/chat/CloudSetup.tsx`）。仍未有独立的「设置 → 云端」页；云端面板目前只出现在 Chat / 订阅 / 会议页。
12. **人工清单**：`CAP-L2L3-CHECKLIST.md` 的 Part A（TCC）和 Part B（麦克风、通知、Soniox、SMTP、IMAP、LLM、Docker 等）需要人来跑。

## 6. 事故（如实记录）

1. **Phase 1：`$TMPDIR` 顶层内容被删**。C3-C7 agent 早期的测试清理对 `path.dirname(mkdtemp 目录)` 做了递归删除，也就是对 `os.tmpdir()` 本身。约 2026-11-05 21:36，删掉了用户 `$TMPDIR` 下能删的顶层内容（约 20 个 macOS 守护进程缓存目录被清空），在目录本身上 EPERM 停下。**不可恢复**。仓库、`~/.persome`、Lens Store 不在 `$TMPDIR` 下，未受影响。之后所有新测试的清理都加了前缀守卫并拒绝删除 `os.tmpdir()` 本身（`log/C3-C7.md` INCIDENT）。是否所有守护进程都已恢复，没有核实。
2. **Phase 2：一个 agent 运行了 `pkill -f "src/server.ts"`**。这会杀掉同一台机器上所有匹配该命令行的进程，不只是它自己的测试服务器（lead 记录；log 中没有更多细节）。
3. **136 个 `lens-upstream-*` 临时目录（约 34 MB）** 留在 `$TMPDIR`，见 §5 第 8 条。

## Final report

### (1) 每个 Phase 的状态

| Phase | 内容 | 状态 |
|---|---|---|
| Phase 0 | C0 架构、C1 `cloud/` 登录、C2 Lens 云客户端 | DONE（Docker 未构建） |
| Phase 1 | C3–C7 Chat（+ C4 服务器） | DONE，C7 PARTIAL；真实 LLM 未验证 |
| Phase 2 | C8 名片、C9 周信服务器、C10 订阅页 | DONE；真实 SMTP 收件箱 BLOCKED |
| Phase 3 | C12–C14 会议（+ C13 服务器） | PARTIAL：真实麦克风 / Soniox 未验证，Runtime 按条目删除上游无接口 |
| Phase 4 | C15 Workflow、C16 表现、C17 主动层、C18 共同经历、C11 周信共同经历 | C16 / C18 / C11 DONE；C17 PARTIAL（真实 OS 未验证）；C15 代码完成、验收 BLOCKED（无真实 steps） |
| Phase 5 | C19 连接器、C20 导入、C21 备份、C22 部署复测、C23 清单 / X3 / onboarding / 文案 | C20 / C21 / C22 DONE；C19 PARTIAL；C23 清单完成但全部 NOT RUN，X3 BLOCKED |

计分：**8.5 / 12 = 70.8%，未达 90%**（§3）。

### (2) 云端 Chat / 会议 / 订阅的端到端证据

都是 Lens 客户端代码对**真实 `cloud/` 子进程**的 vitest e2e；第三方一律 mock：
- Chat：`tests/cloud/e2e-chat-real-server.test.ts`（mock LLM）。问「我这周在做什么」，线上 context 与预览逐字节一致；不含 token / 截图 / `index.db` / 手机号；引用对应已发送快照；「记住这条」经 native confirm 走 MCP `remember`；服务器输出不含问题、上下文和回答。
- 会议：`tests/cloud/e2e-meetings-real-server.test.ts`（mock STT）。consent / confirm 门、mic gate、2 个分片 → ready、两端音频删除、Markdown 导入、删除后服务器 404 + 本机目录消失 + `runtimeRemains` 提示。另有真实 `persome import-data`（临时根）导入成功（`log/C12-C14.md` Phase 3 gate）。
- 订阅：`tests/cloud/e2e-subs-real-server.test.ts`（outbox `.eml` 充当测试收件箱）。卡片 / 周信签名两端互验、伪造被拒、双重确认、投递、RFC 8058 退订、抑制、无追踪像素。

真实 LLM、真实 Soniox、真实 SMTP 收件箱、真实麦克风：**都没有跑过**。

### (3) 出机数据与预览 / 删除

见 §4。要点：默认什么都不出机（e2e lsof 15 s 验证）；每个云功能单独开启；发送的内容在发送前逐条或逐字节预览；服务器非端到端加密；Runtime 内的写入有一部分不能按条目删除。

### (4) 测试数字

cloud 118/118；typecheck exit 0；vitest 194 文件 / 4 跳过，2042 通过 / 6 跳过 / 0 失败（最终；此前 193 / 2040 连续 2 次）；build OK；e2e 37 PASS / 5 SKIP；§15 复测 63/63（部署后 venv）。详见 §2。

### (5) 未完成项与待决定

未完成：真实环境验证（LLM、Soniox、SMTP、IMAP 真实邮箱、麦克风、通知中心 / 托盘 / 快捷键、Docker、打包版 e2e）；Workflow 真实步骤；Runtime 按条目删除；OAuth；CAP L2/L3；签名公证；删除云账号没有 UI 入口。
待决定：§5 的 12 项（X3、上游删除接口、OAuth、SMTP/DKIM、Soniox key、LLM key、Developer ID、临时目录清理、C21 新电脑后果、部署、删除云账号入口、人工清单）。


> Round 4（2026-11-06）后续见 `GAP-vs-S1-R5.md`。
