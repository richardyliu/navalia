# Persome Lens v2.1 — 贴近原版的实施计划

> 配套设计：[`DESIGN.md`](DESIGN.md)
> 目标：按原版的**机制**（壳拥有采集、自动 HET、Card / Connections / Access log）重做 Lens，而不是只加几个页面。
> 执行原则：**先高效跑通第一版机制闭环，再按 reference 的失败项逐项调试优化。** 本文只写顺序与退出条件。

---

## 0. 第一版成功指标

| 维度 | 指标 |
|---|---|
| 采集归属 | TCC 只出现 Lens 一行；Runtime 处于 `capture.source="ingest"`；daemon 不启动 AX watcher |
| 采集质量 | 排除 App 100 次切换 0 帧；暂停到次日 0 点 0 帧；连续输入不产生每键一帧 |
| 身份 | Card 离线可验证；Connections 为 full access；Access log 有记录；撤销扩展 grant 后 403 |
| Broker | 5 工具可用；每次调用可在 Access log 查到；越权有审计 |
| HET | 自动流水线产出任务；assessor 与 anchors 分离；周报总和 = 条目求和 |
| 隐私 | 无出网请求；私钥/token 不进渲染层与日志 |
| 工程 | typecheck/build/dist 通过；关键路径有单元 + 契约 + E2E |

---

## 1. 约束

- Runtime 保持 Apache-2.0；**不为采集打 patch**，采集由 Lens 拥有。
- 不复制产品私有代码；只按公开行为与 docstring 重实现概念。
- 不引入云、登录、公网分享。
- HET 是估算，必须可解释；自动判定，手动 override。
- 现有 v1 功能不回归。
- 不以时间衡量；以“机制跑通 + 对照测试通过”为完成条件。

---

## 2. 工作流与依赖

```
E1 Lens Capture (native addon + ingest) ─┐
E2 Identity / Card / Broker ─────────────┼─► 第一版（P0）
E3 HET 自动流水线 ───────────────────────┘
E4 Experience（星云 / Rewind / Playbook） ─► 第二版（P1）
E5 Hardening ────────────────────────────► 随第一版一起做，持续补
```

依赖：

- E1 的 ingest + 权限先于所有真实数据；
- E2 的 key/Card 先于 Broker；
- E3 的 agent log adapter 可与 E2 并行；
- E4 依赖 E1 的帧与 E2 的 Card；
- E5 不放在最后一次性做：每个面完成就补对应测试/打包。

---

## 3. E1 — Lens Capture（P0）

目标：把原版壳的采集机制在 Lens 里重做，Runtime 只负责 ingest 与建模。

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| E1.1 | N-API addon 脚手架（ObjC++，构建脚本） | `persome-lens-native.node` | — |
| E1.2 | AX tree，字节兼容 Runtime `mac-ax-helper` | `axTree()` + fixtures | E1.1 |
| E1.3 | 权限探测（AX / ScreenCaptureKit） | `permissions()` + TCC 流程 | E1.1 |
| E1.4 | 截图（ScreenCaptureKit/CGWindowList） | `screenshot()` JPEG | E1.3 |
| E1.5 | Coordinator：debounce / min gap / dedup / heartbeat / lock | 与原版同语义 | E1.2 |
| E1.6 | 排除 picker + pause（含暂停到次日 0 点） | UI + 状态 | E1.5 |
| E1.7 | Ingest client：串行、200 三态、5xx 重试、12MiB | `ingest-client.ts` | E1.5 |
| E1.8 | Capture 页面：状态、权限、最近帧、按 App 聚合、设置 | UI | E1.6 |
| E1.9 | 测试：排除 0 帧、pause、去重、ingest 三态 | 测试 | 全部 |

关键点：

- Runtime `config.toml` 写 `[capture] source="ingest"`；Lens 不跑 daemon 的 watcher。
- 截图明文只在内存，ingest 后由 Runtime 加密落盘。
- 原型期允许临时用 OSS `mac-ax-helper`；第一版发布必须切 addon。
- 先做“最小可跑通路”，再补设置/预览的完整 UI。

验收：

- TCC 只有 Lens；排除/暂停/去重与原版一致；
- ingest 失败可重试且不丢帧；
- 不产生每键一帧的磁盘膨胀。

---

## 4. E2 — Identity / Card / Broker（P0）

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| E2.1 | Lens Store + safeStorage key manager | `identity/`、`settings.json` | — |
| E2.2 | Card schema + Ed25519 + RFC 8785 canonical | `card.ts`、`verify` | E2.1 |
| E2.3 | Card builder（full access；扩展 scope 可选）+ 正面/背面/Mini Map | UI | E2.2 |
| E2.4 | Grant store + token 哈希 + TTL/reads/revoke | `grants.json` | E2.1 |
| E2.5 | Broker MCP（SDK，127.0.0.1:8750）+ 5 工具 + scope filter + audit | `broker.ts` | E2.3/E2.4 |
| E2.6 | Connections UI：选 Agent、full access、复制 MCP JSON | UI | E2.5 |
| E2.7 | Access log：读取记录、30 天堆叠、清空；撤销/续期作为扩展 | UI + `audit.db` | E2.5 |
| E2.8 | Swipe：PNG + `.persomecard` + 二维码 | UI/导出 | E2.3 |
| E2.9 | 安全测试：full access 边界、evidence 拒绝、撤销、token 泄漏 | 测试 | 全部 |

关键点：

- **原版 Connections 是 per-agent full access + Access log**，没有观察到 per-scope；第一版先按 full access 实现。
- 如果要加 scope，必须标注为 Lens 扩展，不能写成“原版行为”。
- 原版术语是 **Access log**；`Agent Report` 只是旧称呼。
- Scope 命名（扩展）：`card:read`、`identity:read`、`now:read`、`rewind:read`、`evidence:read`、`reports:read`、`model:search`、`model:ask`、`model:jot`、`model:correct`、`connectors:read`、`connectors:connect`。

验收：

- Card 离线可验证；
- Connections 可连接/断开；
- Access log 记录读取（含空结果），清空不影响连接；
- 没有 `evidence:read` 拿不到 quote（扩展）；
- 撤销扩展 grant 后 403。

---

## 5. E3 — HET 自动流水线（P0）

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| E3.1 | Agent log adapters：Claude Code / Codex | `adapters/` + 只读解析 | — |
| E3.2 | Session watcher + segmenter（timeline + transcript） | `segmenter.ts` + 单测 | E3.1 |
| E3.3 | Assessor（有界 LLM）+ Anchors（确定性分钟） | `assessor.ts` / `anchors.ts` | E3.2 |
| E3.4 | Ledger + tick（segment→assess→promote） | `het.db` + 定时器 | E3.3 |
| E3.5 | HET Dashboard：今日/周/月、任务、override | UI | E3.4 |
| E3.6 | Weekly Review（本地，替代邮件） | Markdown/HTML 导出 | E3.5 |
| E3.7 | 校准测试：20 条样本，人工核对 | 测试 + 调整 | 全部 |

验收：

- 自动产出任务；assessor 不直接给分钟；
- 每条任务有 evidence 或 `needs_assessment`；
- 周报总和 = 条目求和；
- 用户 override 后重算并留审计；
- 修正动作是 `accepted` / `rejected` / `not_agent`。

---

## 6. E4 — Experience（P1，第一版跑通后再做）

| # | 任务 |
|---|---|
| E4.1 | Living Model 星云（Canvas/WebGL，1000 Points <1s） |
| E4.2 | Rewind（截图解密 + 时间轴；需要 Runtime 读取口） |
| E4.3 | Card 翻面动画 / Mini Map 打磨 |
| E4.4 | Playbook：`behavior_patterns` + `case_extractor` + 导出 |
| E4.5 | Weekly Review 视觉与分享 |
| E4.6 | 集成测试 |

---

## 7. E5 — Hardening（随第一版做，持续补）

| # | 任务 |
|---|---|
| E5.1 | 契约测试 + fixtures（Card/Broker/HET/Coordinator） |
| E5.2 | Playwright E2E：排除、暂停、Card 验证、撤销、HET |
| E5.3 | 图标、DMG、公证、README |
| E5.4 | 演示数据 + demo 脚本 |

---

## 8. 第一版执行顺序（机制优先）

| 顺序 | 做什么 | 退出条件 |
|---|---|---|
| 1 | E1.1–E1.5：addon + AX + 权限 + 截图 + coordinator | 能稳定产出帧，能 ingest |
| 2 | E1.6–E1.9：排除/暂停/ingest/UI/测试 | 排除 0 帧、pause 0 帧、不丢帧 |
| 3 | E2.1–E2.3：key + Card + Card UI | Card 可签/可验 |
| 4 | E2.4–E2.6：Grant + Broker + Connections | Agent 能通过 Broker 读 Card |
| 5 | E2.7–E2.9：Access log + Swipe + 安全测试 | 读取有记录；撤销生效 |
| 6 | E3.1–E3.4：adapters + segmenter + assessor/anchors + ledger | 自动产出任务 |
| 7 | E3.5–E3.7：Dashboard + Weekly Review + 校准 | 任务可看、可修正、可导出 |
| 8 | 集成 + E2E + DMG | 全链路可跑，关键测试通过 |

原则：

- 每个顺序项完成就运行一次真实链路，不要等“全部写完再联调”；
- 第一版不追 E4；E4 在第一版稳定后逐项加；
- 每完成一项就补测试/文档，不把测试堆到最后；
- 遇到 blocker 先记录，不要静默降级。

---

## 9. 测试矩阵

| 层 | 内容 |
|---|---|
| 单元 | AX fixture 字节兼容、coordinator 去重、ingest 三态、canonical JSON、Ed25519、token 哈希、scope filter、HET 公式 |
| 契约 | Card schema、Broker 5 工具、Runtime ingest 契约、HET 账本 |
| 集成 | 排除 → 0 帧；暂停 → 0 帧；Card → 验证；grant → 撤销 → 403 |
| E2E | 无网络完成采集、Card、Connections、HET、Weekly Review |
| 安全 | token/私钥不泄漏；full access 边界；越权 403 + 审计 |

---

## 10. 决策记录

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | Lens 拥有采集（native addon + ingest） | patch Runtime | 与原版一致；TCC 一行；排除/暂停/去重在壳内 |
| D2 | HET 自动流水线 | 手动确认 | 原版 `het/` 是自动；手动只做 override |
| D3 | 先 full access + Access log；scope 作为扩展 | 直接 per-scope | 原版当前是 full access；scope 无证据 |
| D4 | Card UI 对齐原版 + 签名导出扩展 | 只做签名 JSON | 原版 Card 是身份对象 |
| D5 | Weekly Review 本地 | 邮件 | 无云；明确 deviation |
| D6 | 不复制私有模块 | 直接移植 | 法律与维护风险；只重实现概念 |

---

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Native addon 复杂度高 | 高 | 先做 AX fixture 与最小通路；原型期允许 helper fallback |
| TCC 权限行为变化 | 高 | 每次启动探测；明确引导；保留 helper fallback |
| HET 自动判定不准 | 中 | assessor 与 anchors 分离；人工 override；只展示有证据的 |
| Scope 泄漏 | 高 | 默认 full access 边界清晰；契约测试；审计 |
| Rewind 解密权限 | 中 | 与 Runtime 协商读取口；否则 P1 延后 |
| 私钥丢失 | 中 | 加密备份/导入 |
| 额度不足 | 低 | HET/采集/Card/Broker 不依赖 LLM；assessor 可排队 |

---

## 12. 立即开始的 5 件事

1. 建 `persome-lens-native` addon 脚手架，输出 `axTree()` 的最小 JSON；
2. 用 OSS `mac-ax-helper` 的 JSON 做字节级 fixture 对照；
3. 实现 coordinator + ingest client，把 Runtime 切到 `source="ingest"`；
4. 实现 Lens Store + Card schema + Ed25519 签名/验证；
5. 写 Claude Code / Codex transcript adapter 的 spike，确认 HET 输入可用。

完成这 5 件后，采集与身份的机制就与原版同构；之后再接 Broker 与 HET，最后逐项调试优化。

---

## 13. 不做什么

- 云账号、云同步、好友社交、邮件、会议转写；
- 公网 Card 链接；
- 团队/企业；
- 直接复制产品私有 runtime 代码。
