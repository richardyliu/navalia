# Persome Lens v2.1 — 贴近原版的设计文档

> 版本：v2.1 Draft（fidelity-first）
> 日期：2026-11-04
> 目标：让 Lens 的**设计理念、机制、数据流**尽可能贴近原版，而不是做一个“看起来像”的查看器。
> 基线：v1 查看器已实现，见 `DESIGN-v1-archive.md`；v2.0 初稿已被本版取代。

---

## 0. 与原版的机制对照（先承认差异）

### 0.1 完全一致的部分

| 机制 | 原版 | Lens v2.1 |
|---|---|---|
| 证据门控 | 模型输出 quote，代码回查 receipt | 沿用 Runtime，UI 展示 sources/context 分离 |
| 模型层级 | Point / Line / Face / Volume / Root | 沿用 Runtime |
| 本地优先 | 原始数据本地、可暂停、可删除 | 沿用 |
| Agent 中立 | MCP | 沿用 |
| 可纠正 | supersede + correction | 沿用 |
| 身份 | Personal Card / Swipe / Access log | 同一套 UI 语义 |
| 性能 | HET（Human Equivalent Time） | 同一套定义与账本 |

### 0.2 初稿偏离、本版修正的部分

| 机制 | 原版做法 | 初稿 | v2.1 修正 |
|---|---|---|---|
| **采集归属** | **Electron 壳拥有 OS capture 与 TCC**，Runtime 用 `capture.source="ingest"`，不持有权限 | 给 Runtime 打 patch、让 daemon 采集 | **改为 Lens 拥有 capture**，自建 native addon + ingest client；Runtime 不再采集 |
| 按 App 排除 | 壳的 `excluded-app-picker`，在采集前丢弃 | Runtime patch | Lens capture coordinator 直接丢弃 |
| 暂停 | 壳的 `capture-pause`（可暂停到次日 0 点） | `persome pause` CLI | Lens 自己管理暂停状态 |
| HET | **自动**：agent logs → segmenter → assessor → anchors → tick | 手动确认 + 强证据 | 改为自动流水线，手动只做 override |
| 授权 | 产品当前是 per-agent **full access** + Access log；没有观察到 per-scope | 自造 `profile.read` 等 | 先实现 full access + Access log；scope 作为 Lens 扩展，明确标注非原版 |
| Card | Personal Card + Swipe + Connections | 自造签名 JSON | UI 语义对齐；签名导出作为扩展 |
| 周报 | check-ins + 邮件 | 无 | 本地 Weekly Review 替代（明确 deviation） |

### 0.3 仍然存在的差异（诚实列出）

| 差异 | 原因 | 处理 |
|---|---|---|
| Runtime 私有模型模块（Minute Archive / 账本 / graph induction / world / funnel） | 只在产品私有分支，62k 行 | v2.0 用 OSS 模型；v2.1 重实现 `world`/person lineage；archive/ledger 延后 |
| 聊天 / 会议 / 好友 / 邮件 | 依赖官方云端 + Soniox | 不做；本地替代见 §10 |
| 公网 Card 分享 | 需要云与合规 | 只做本地 `.persomecard` + PNG |
| 移动端 | 产品也没有正式交付 | 不做 |

---

## 1. 北极星

访谈定义：

> “中立、第三方、开源的 Personal Context Layer，提供可追溯、可纠正、由本人控制的个人上下文的**采集、建模、可视化**与基于个人上下文的**输出服务**。”

四条原则：Local-first、Evidence-first、User-owned、Agent-neutral。

五个面：

| 原服务 | v2.1 面 |
|---|---|
| 采集 | **Capture Plane（Lens 拥有）** |
| 建模 | Context Plane（Runtime，ingest 模式） |
| 可视化 | Experience Plane（Living Model / Rewind / Card） |
| 输出 | **Identity & Authorization Plane**（Card / Swipe / Connections / Access log / Broker） |
| 性能 | **Performance Plane**（HET） |

---

## 2. 总架构：壳拥有采集，Runtime 只做建模

这正是原版的核心架构，也是 v2.1 最大的修正。

```
┌──────────────────────────── Persome Lens (owner shell) ───────────────────────┐
│                                                                               │
│  Capture Plane        native addon (AX/screenshot/TCC) · coordinator          │
│                       exclusions · pause · ingest client                      │
│  Identity Plane       Personal Card · Swipe · Connections · Access log     │
│                       Broker MCP :8750 (scoped)                               │
│  Performance Plane    HET: agent-log adapters · segmenter · assessor · tick   │
│  Experience Plane     Living Model · Rewind · Evidence · Search · Playbook    │
│                                                                               │
│  Lens Store  ~/Library/Application Support/Persome Lens/                      │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ POST /captures/ingest (frames)                 │ scoped MCP :8750
                │ owner MCP :8742 / REST                         │
        ┌───────▼─────────┐                            ┌────────▼─────────┐
        │ Persome Runtime │◄──── Broker proxies ───────│ Trusted Agents   │
        │ ingest + model  │      and filters           │ Claude · Codex … │
        └───────┬─────────┘                            └──────────────────┘
                │
        ┌───────▼─────────┐
        │ ~/.persome      │
        └─────────────────┘
```

关键点：

- **TCC 归 Lens**：native addon 跑在 Electron main 里，System Settings 只出现一行 Lens。
- Runtime 配置 `capture.source = "ingest"`，不启动 AX watcher，不申请权限。
- Runtime 仍然是模型/证据/检索的唯一事实源；Lens 不直接写 `index.db`。
- 第三方 Agent 只连 Lens Broker（8750），不直连 Runtime（8742）。

### 2.1 决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 采集 | **Lens-owned + ingest** | 与原版一致；TCC 单一行；排除/暂停/去重都在壳内 |
| Runtime patch | **不需要**（采集）；删除区间可后续最小 patch | 采集不再依赖 Runtime |
| HET | Lens 侧自动流水线 | 原版 `het/` 是私有模块；按同一逻辑重实现 |
| Scope | 原版命名 | 见 §4.2 |
| Card | UI 对齐原版 + Ed25519 导出扩展 | 原版 Card 是身份对象；签名是本地可携带的增强 |
| 周报 | 本地 Weekly Review | 替代云邮件；明确 deviation |

---

## 3. Capture Plane（Lens 拥有）

### 3.1 Native addon

`persome-lens-native.node`（N-API，ObjC++），跑在 Electron main：

| 能力 | 说明 |
|---|---|
| `axTree()` | 输出与 Runtime `mac-ax-helper` **字节兼容**的 JSON（apps → windows → elements；含 bundle_id、window title、focused role/value、subrole） |
| `frontmost()` | 前台 App/窗口元数据 |
| `screenshot()` | ScreenCaptureKit / CGWindowList，返回 JPEG bytes |
| `permissions()` | `AXIsProcessTrusted`、`SCShareableContent`（真实探测，注册 Lens） |
| `urlHandlers()` | Safari/Chrome 当前 URL（AX 不可得时） |

为什么是 addon 而不是 Swift helper：TCC 把权限授予**发起调用的进程**；独立 helper 会变成第二个 TCC 主体，正是原版要避免的。

> 原型期可临时调用 OSS 的 `mac-ax-helper` 跑通 ingest，但 v2.0 发布必须换成 addon。

### 3.2 Coordinator（原版同款语义）

从 Runtime daemon 移到 Lens：

- `debounceMs=3000`，紧急事件 500ms；
- `minCaptureGapSeconds=2`；
- `dedupIntervalSeconds=1`，`sameWindowDedupSeconds=5`；
- `heartbeatMinutes=10`；
- `pauseOnLock=true`；
- 同一 surface 的 Activation/Focus 合并规则与 Runtime 一致。

### 3.3 排除与暂停

- 排除：bundle id + app name，双清单；在抓取前判断，**不生成帧、不调用 ingest**。
- App 选择器：`NSOpenPanel` 选 `.app`，读 `Info.plist` 的 `CFBundleIdentifier`（与原版 `excluded-app-picker` 同逻辑）。
- 暂停：立即暂停 / 暂停到次日 0 点；状态写 `settings.json`，重启后保留。
- 权限：Screen Recording 探测必须等用户显式同意（否则会提前注册 TCC）；Accessibility 可自由探测。

### 3.4 Ingest client

`POST http://127.0.0.1:8742/captures/ingest`，Bearer token：

- body ≤ 12 MiB；
- **串行**发送（Runtime 全局锁，>16 并发 503）；
- 200 有三种结果：written / deduped / skipped（paused/locked），必须分别处理；
- 5xx 重试 250 / 1000 / 3000ms；4xx 不重试；
- 失败帧进有界重试队列，不阻塞采集。

### 3.5 截图与保留

- 截图随帧发给 Runtime，由 Runtime 用 `PERSOME_SCREENSHOT_KEY` AES-256-GCM 加密落盘；
- Lens 不持久化明文截图（内存中只保留到 ingest 完成）；
- 保留期、截图剥离、OCR 开关仍由 Runtime `[capture]` 配置控制，Lens 只写配置 + 重启。

### 3.6 删除

- v2.0：Lens 删除自己 `capture-buffer` 中命中区间的帧，然后调 `persome rebuild-captures-index`；
- 明确提示：**派生 memory/Points 不会自动删除**；
- v2.1：如需要精确清理索引，提交一个最小 Runtime patch（`clean captures --since/--until`）。

### 3.7 验收

- 排除 1Password 后 100 次前台切换 0 帧、0 ingest；
- 暂停到次日 0 点后 0 帧；
- 连续输入不产生每键一帧（coordinator 生效）；
- TCC 列表只出现 Lens 一行（或明确标注原型期 helper）。

---

## 4. Identity & Authorization Plane

### 4.1 原版语义

- **Personal Card**：正面身份摘要，背面 Mini Map；可翻面。
- **Swipe Your Card**：把 Card 的授权切片给 AI。
- **Connections**：管理已连接的 Agent（原版字符串是 Connections）。
- **Access log**：记录 AI 怎样读取了上下文（原版字符串是 Access log）。

Lens 保留这四个名字与交互，不另造概念。“Agent Report”只是 Access log 的旧称呼，交付时用 **Access log**。

### 4.2 Access（原版 full access；scope 是 Lens 扩展）

> **原版事实**：原版的 Connections 只有 `full access` + Access log，没有 per-scope 选择。下面这张表是 Lens 的**扩展**，参考同产品家族的 Card 壳，不是原版行为；实现时必须标注。

| scope（Lens 扩展） | 允许读取 | 默认 |
|---|---|---|
| `card:read` | Card 摘要 | ✅ 公开 |
| `identity:read` | 身份与 Root | ✅ 公开 |
| `now:read` | 当前上下文 | 授权 |
| `rewind:read` | 截图历史 | 授权 |
| `evidence:read` | receipts + 原文 | 高敏，默认拒绝 |
| `reports:read` | AI 使用回执 | 授权 |
| `model:search` | 检索 | 授权 |
| `model:ask` | 问答式读取 | 授权 |
| `model:jot` | 写入短记忆 | 授权 |
| `model:correct` | 纠正 | 高敏 |
| `connectors:read` | 连接器数据 | 授权 |
| `connectors:connect` | 新建连接 | 高敏 |

`PUBLIC_SCOPES = ["card:read", "identity:read"]`，与原版公开卡片一致。

### 4.3 Card

- UI：Personal Card 正面/背面、翻面、Mini Map；数据来自 `/model/graph` + `/model/share-card`。
- **本地可携带扩展**：生成 `.persomecard`（Ed25519 签名，RFC 8785 canonical JSON），用于离线分享/导入验证。
- Card 默认不含 quote；只有 `evidence:read` 的授权切片才带 receipt。
- 私钥 `safeStorage` 加密，0600；公钥在 Card 里，验证端不需要 Lens。

### 4.4 Broker（Connections 的本地执行点，Lens 扩展）

Runtime MCP（8742）是 owner-only 全量；第三方 Agent 一律连 Lens Broker（8750）：

> 2026-11-04 更新（用户决定，DEVIATIONS D19）：Broker 为 **full access**，暴露 26 个工具（2026-11-05 DEPLOY-05 起为 29 个：22 个 OSS + 3 个 Rewind + 4 个 Lens 扩展）；下表是 scope 扩展下的映射（full access 不受 scope 限制）。权威来源：`src/main/broker/catalog.ts` 的 `TOOL_CATALOG`。

| 工具 | scope（扩展） |
|---|---|
| OSS 22 个工具中的只读检索类（`search`、`search_captures`、`verify_fact`、`behavior_patterns`、`entity_graph`、`get_model_snapshot`、`list_memories`、`read_memory`、`related_events`、`get_schema`、`query_health_metrics`、`get_pending_model_work`） | `model:search` |
| `current_context`、`recent_activity`、`attention_trajectory`、`read_recent_capture` | `now:read` |
| `resolve_evidence`、`read_receipt` | `evidence:read` |
| `remember` | `model:jot` |
| `correct_memory` | `model:correct`（耗 LLM，额度不足拒绝） |
| `process_pending_model_work` | `model:ask`（耗 LLM，额度不足拒绝） |
| `search_rewind`、`rewind_frames`、`view_rewind_screenshot`（形状 Lens 自定） | `rewind:read` |
| `owner_aliases`（OSS，Runtime schema 2026-11-05.3 新增，只读） | `model:search`（不接受公开 scope `identity:read`：列表含待确认 / 已拒绝的、可能属于他人的名字）；没有 `evidence:read` 时只保留固定字段（alias、alias_key、status、confidence、evidence_count、first/last_seen_at、activated_at、decision_source），`evidence[]` 置空（扩展） |
| `card_get`（Lens 扩展） | `card:read` + `identity:read` |
| `usage_report`（Lens 扩展） | `reports:read` |

- 鉴权：`Authorization: Bearer <grant token>`；token 只存 SHA-256；
- 过滤：按 scope 裁剪字段 + PII 清洗；
- 审计：`audit.db` 记录每次调用（grant、tool、args hash、返回 id、结果），Access log 展示；
- 撤销/过期立即生效。

### 4.5 Swipe

- 选择 scope 切片 → 生成 Card（可视化 + `.persomecard`）；
- 二维码只含 `card_id` + 公钥指纹，不含数据；
- 本地文件/AirDrop 分享；公网链接不做。

### 4.6 验收

- Card 离线可验证；
- `PUBLIC_SCOPES` 的读取只返回 card/identity；
- 没有 `evidence:read` 拿不到 quote；
- 撤销后 1s 内 403，Access log 可见。

---

## 5. Performance Plane — HET（自动流水线）

### 5.1 与原版一致的流水线

原版 `het/` 的结构：**agent logs → session watcher → segmenter → assessor → anchors → tick → ledger**。Lens 按同样顺序实现。

```
agent transcripts ─┐
timeline blocks ───┼─► segmenter ─► assessor (LLM, bounded) ─► anchors (deterministic)
broker audit ──────┘                                      │
                                                          ▼
                                                   het_tasks ledger
                                                          │
                                                    tick / dashboard
```

### 5.2 Agent log adapters

| Agent | 位置 | 解析 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | session id、时间、用户/助手消息、工具调用 |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | session、turn、命令 |
| Cursor Agent | 可选，后续 | — |

只读 transcript；不复制全文，只保留任务判定所需的摘要与引用。

### 5.3 切分

- 以 timeline session 边界 + agent transcript 时间为骨架；
- 合并同一项目/同一 surface 的连续活动；
- 识别 agent 参与：transcript 存在 + 时间重叠 + 同项目；
- 产出 `HetTask`（start/end/title/project/agent/kind）。

### 5.4 判定（assessor）

- 每个已结算任务一次**有界 LLM 调用**（可用 Claude 订阅/API；预算不足则任务停在 `needs_assessment`，不猜）；
- 输出：类型、复杂度、agent 占比、是否被采纳、采纳证据；
- 分钟数由 `anchors` 确定性计算，不让模型直接给数字。

### 5.5 采纳

| 状态 | 来源 | 权重 |
|---|---|---:|
| `confirmed` | 用户 override | 1.0 |
| `strong` | assessor 找到明确采纳证据（提交/编辑/发送） | 0.85 |
| `weak` | 只有间接引用 | 0.55 |
| `unknown` | 无证据 | 0.3 |
| `rejected` | 用户 override | 0 |

v2.1 默认自动判定；用户可在 HET 页 override。

### 5.6 Anchors（确定性分钟）

| kind | 单位 | 默认 |
|---|---|---:|
| research | 每 5 个来源/页 | 20 |
| writing | 每 500 字 | 30 |
| coding | 每 200 行/PR | 45 |
| review | 每份文档/PR | 20 |
| ops | 每个任务 | 10 |
| meeting | 每分钟 | 1 |

```
minutes = anchor(kind) × size_factor × adoption_weight × complexity_factor
```

### 5.7 账本与 UI

- `het.db`：`het_tasks` / `het_events` / `het_anchors` / `agent_calls`；
- 今日/周/月、任务列表、待确认、Anchors、Weekly Review；
- 每条可展开 evidence；无法解释的不进总数。

### 5.8 验收

- 自动流水线在 20 条样本上产出任务，人工核对类型/采纳；
- 每条任务有 evidence 或 `needs_assessment`；
- 周报总和 = 条目求和；
- 用户 override 后重算，保留审计。

---

## 6. Experience Plane

| 模块 | 版本 | 说明 |
|---|---|---|
| Card 翻面 + Mini Map | v2.0 | 数据来自 Card |
| Living Model 星云 | v2.1 | `/model/graph`，1000 Points <1s |
| Rewind | v2.1 | 需要 Runtime 提供解密读取；OSS 无，需最小 patch 或 Lens 解密（取决于 key 归属） |
| Playbook | v2.1 | `behavior_patterns` + `case_extractor` |
| **Weekly Review** | v2.0 | 本地替代 check-ins 邮件：本周 HET、项目、证据、给朋友的信草稿；导出 Markdown/HTML，不发送 |

---

## 7. 安全与隐私

- 私钥 safeStorage；grant token 只存哈希；
- Broker 只监听 127.0.0.1；默认拒绝；
- v2.1 无出网请求（Weekly Review 不发送）；
- 截图在 Runtime 加密；Lens 不落盘明文；
- TCC 只归 Lens；
- 审计可导出/清空；HET 账本可整体删除。

---

## 8. 交付顺序（机制优先）

第一版只追三个 P0 面的机制闭环；每完成一面就应可运行、可测，再进下一面。以“跑通 + 对照测试”为完成条件。

| 顺序 | 交付 | 完成标志 |
|---|---|---|
| 1 | Capture：native addon + coordinator + ingest + 排除/暂停 | TCC 归 Lens；`source=ingest`；排除/暂停/去重可测 |
| 2 | Identity：Card / Swipe / Connections / Access log / Broker | Card 可验证；连接/断开可用；Access log 有记录 |
| 3 | HET：agent logs → segmenter → assessor → anchors → ledger | 自动产出任务；pending 不计入；修正生效 |
| 4 | 集成：三面串起来 + 测试 + DMG | 全链路可跑；关键测试通过 |
| P1 | Experience：星云 / Rewind / Playbook / Weekly Review | 在 P0 稳定后逐项加 |

> 第一版交付后，按测试清单的失败项逐项调试优化；不要为了赶进度跳过 L2/L3。

---

## 9. 验收（v2.0）

- [ ] TCC 只有 Lens 一行；Runtime 处于 ingest 模式；
- [ ] 排除/暂停/去重/心跳与原版语义一致；
- [ ] Card/Swipe/Connections/Access log 四个界面齐全；
- [ ] Connections 默认 full access；Access log 记录读取（含空结果），清空不影响连接；
- [ ] scope 扩展单独测试：PUBLIC_SCOPES 只给 card/identity；evidence 默认拒绝；
- [ ] HET 自动产出任务，assessor + anchors 分离；
- [ ] 无出网请求；私钥/token 不泄漏；
- [ ] 关键路径测试通过。

---

## 10. 明确 deviation

| 原版 | Lens v2.1 | 原因 |
|---|---|---|
| 聊天 | 无 | 云推理；用 Broker + 外部 Agent 替代 |
| 会议转写 | 无 | Soniox + 云 |
| 好友卡片/社交 | 无 | 需要云账号；用本地 `.persomecard` 替代 |
| 周报邮件 | **Weekly Review（本地）** | 不发邮件，只生成本地报告 |
| 技能抽取 | 无 | 云 `/v1/skill-extractions` |
| 云同步 | 无 | 本地优先 |
| Minute Archive / 账本 / world / funnel | v2.0 用 OSS 模型；v2.1 重实现 world/person lineage | 私有分支，不能复制代码 |

这些 deviation 必须在产品文案里说清楚，不能假装“和原版一样”。

---

## 11. 与原文对应

| 原文 | 落点 |
|---|---|
| “一个人数字世界的身份证” | Personal Card + Swipe + 签名导出 |
| “让每个 Agent 都读到同一个你” | Broker + scope |
| “采集、建模、可视化、输出” | Capture Plane / Runtime / Living Model / Broker |
| “可追溯、可纠正、由本人控制” | Evidence / Correct / grant revoke |
| “N×N 影子” | 多 Connections / 多 grant |
| “Context → Performance” | HET 自动流水线 + Weekly Review |
| “Make something agents want” | Broker 5 工具 + Access log |

---

## 12. v1 保留

Overview / Model / Evidence / Search / Playbook / Settings / remember / correct / build / 额度提示，全部保留；v2.1 在其上叠加 Capture、Identity、HET。
