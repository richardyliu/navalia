# DECISIONS — Round 4 (S1-FULL → X3 + 真实验收)

日期：2026-11-06。本文件是本轮的 Approval Ledger。未在此列出的扩展一律视为未批准。

## R4-1 X3：HET 真实 assessor transport —— 批准

| 项 | 决定 |
|---|---|
| 是否开启 | **批准**。默认仍 `assessorEnabled=false`，由用户在 HET 页显式开启 |
| Transport | Runtime `[agent_funding]`（option C）：Lens 主进程 `execFile(<root>/venv/bin/python, ['-I','-c',<固定脚本>])`，调用 `persome.writer.agent_cli.complete`。**不直接 spawn `claude`/`codex`**（否则绕过共享 fcntl 锁与 daily_call_limit） |
| Provider / model | 沿用 `~/.persome/config.toml` 的 `[agent_funding] client/model`；het.db 记录 client / model / anchor_version |
| Budget | 复用 `[agent_funding] daily_call_limit`（按本地日期）；HET 的 `perTickCap` / `perDayCap` 叠加生效；耗尽 → `budget_unavailable`，不重试 |
| 出机数据 | `sendSummariesToAssessor` 默认 false：只发 task id、agent、duration、counts、tool names、signals、file types |
| 用户可选项 | 可显式打开「发送摘要给 assessor」，需二次确认，UI 写明发什么/发给谁/不可撤回 |
| 保留 | Lens 只存 verdict / evidence ids / counts；不存 prompt 原文 |
| 分钟来源 | assessor 只输出 kind/size/complexity/agent_share/adoption/evidence；分钟由 anchors 确定性计算；带 `minutes` 或未知键 → `invalid` |
| UI 语义 | 「估计」+ anchor version；不是 Performance / 绩效分 / 节省时间 |
| Cloud HET | **不批准**：HET 不走 cloud `/v1/chat/completions` |

### R4-1a 观测到的偏差（记录，不处理）

- brief 写 `daily_call_limit = 200`；本机 `~/.persome/config.toml` 实际为 **20000**（2026-11-06 读取，used=7）。
  Lens 不修改 Runtime 配置或 usage 文件。因此本轮的有效上限是 **brief 的自限额**
  （X3 ≤20、Workflow ≤40、云抽取 ≤20、Faces/构建 ≤40）+ HET `perDayCap=20`，而不是 Runtime 的 20000。
  **用户确认（2026-11-06）：20000 是有意修改，brief 中的 200 已过时。** Runtime limit 保持 20000；
  HET 仍受自身 `perTickCap=5` / `perDayCap=20` 约束。

## R4-2 仍不批准

- 新增第三方账号 / OAuth（Google / Notion / Outlook 没有 client id → BLOCKED）。
- X7 Lens 内置 LLM。Workflow 提取只走 Runtime `pattern_detector` 或已批准的 Cloud 抽取路径。
- HET 用 cloud LLM。
- 签名 / 公证 / 自动更新：本机只有 `Apple Development` 证书，无 Developer ID、无发布源 → BLOCKED。

## R4-3 本轮操作约束

- 不改 Runtime 代码、不直接写 `index.db`；上游缺口写 `docs/upstream/*.md`。
- 不伪造 HET 分钟、Workflow steps、Face、云交付、CAP 结果。
- 真实云测试只认环境变量；本机 shell 环境中无 `CLOUD_LLM_*` / SMTP / `CLOUD_SONIOX_API_KEY` → 对应项 BLOCKED。
- 不 push / 不开 PR / 不发布。
