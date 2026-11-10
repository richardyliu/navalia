# Decisions — Round 3（2026-11-05，S1 收尾）

用户在 2026-11-05 拍板。本文件是 Round 3 的 Approval Ledger：本轮代码只在下表的「边界」以内实现。超出边界的需求一律停下，在本文件末尾「越界记录」里登记，不会静默实现。

前序决定：`DECISIONS.md`、`DECISIONS-ROUND2.md`（X1–X10 原始问题）、`DECISIONS-OG.md`（OG-D1..D5）。

## 1. 批准清单

| # | 决定 | 边界 |
|---|---|---|
| X4 | **批准 B：本周 AI 工作计数** | 只给 owner 看；不叫「分数」；不通过 Broker 暴露；每个数字都能点回 HET 任务列表；页面写明「这是计数，不是绩效分，不代表节省时间」。A（HET 分钟）和 C（长程项目完成度）**未选**。 |
| X9 | **批准本机通知** | 需要用户开启，默认关闭；先做 T3/T4/T5，再做 T1/T2；每天最多 3 条；有 quiet hours（默认 22:00–09:00）；通知不含正文；不联网；用户拒绝权限后不再催。 |
| X2 | **批准本地订阅后台扫描** | 只扫用户选的本地文件夹；默认关闭；不递归、不联网；周期扫描需要用户开启；保留手动刷新。 |
| X5 | **批准导入后构建** | 默认关闭；打开前二次确认；提示会调用 Runtime 的 LLM；默认不花钱；失败时显示退出码和 stderr。 |
| X8 | **批准备份可选包含 Access log** | 默认不包含；要用户显式勾选；manifest 写明是否包含；仍然不含私钥（`identity/ed25519.key.enc`）和 `grants.json`。 |

## 2. 未批准 / 仍 BLOCKED

| # | 决定 | 含义 |
|---|---|---|
| X7 | **不批准 Lens 内置 LLM** | Workflow 抽取继续走外部 Agent（复制 prompt、粘贴回 JSON）。R8 结构化 Workflow 和数据重建用 **Runtime 自己的 LLM**（`[agent_funding]`），Lens 不发 LLM 请求。 |
| X1 | **不批准云/账号** | Chat、Meetings、Check-ins 送达、云同步继续 BLOCKED，也不做假的版本。 |
| X3 | **不批准 HET transport** | HET 继续显示「未测量」，这不是 S1 的核心。 |
| OG-D3 / OG-D4 | **仍 BLOCKED** | 没有 Developer ID，也没有发布源；不假装签名、公证或自动更新。 |

## 3. 适用于全部条目的约束

- 本地优先：不引入云、账号、遥测或公网请求。
- 不新增 npm 依赖。
- Lens 不写 Runtime 的 `index.db`，只通过 Runtime 的 CLI、REST API 或 MCP 访问。
- 重建模型或部署 R8 之前必须先备份 `~/.persome`；回滚按 `UPSTREAM-DEPLOY.md` 的 DEPLOY-06 / R7 执行。
- 不伪造 lineage、Workflow 结构、分钟数、通知或 Performance。
- LLM 预算：Runtime 的 `[agent_funding] daily_call_limit = 200`，按**本地日期**计数（`personal-model-og/src/persome/writer/agent_cli.py:318` `_usage_date` 取 `datetime.now().astimezone().date()`）。Lens 和本轮 agent **不**修改上限、**不**重置用量文件；那等于未经授权花钱。

## 4. 越界记录

（发现需要 X1/X3/X7 或超出上表边界的需求时登记在这里。）

| 日期 | 任务 | 需要什么 | 处理 |
|---|---|---|---|
| 2026-11-05 | S1-R4-02 R8 真实运行 | Runtime LLM 额度（当天 200/200 已用完，本地午夜重置） | **BLOCKED（预算）**，没有改上限也没有重置用量。R8 已部署，等额度恢复后跑真实 pattern_detector。 |
| 2026-11-05 | S1-R4-01 lineage | 原计划用 `model build` 重建，但代码和副本实测都表明 `model build` 不会给已有 Point 补关联 | 改为上游确定性回填 R9（Runtime 自己的 CLI，不用 LLM，不由 Lens 写库），属于 Runtime 本地集成，在原批准范围内。已在副本演练、备份后应用到真实数据。 |
| 2026-11-05 | X8 | 原文写「复制 audit.db（一致快照）」 | 实际导出为 JSON（`lens/access-log.json`），因为这样能经过备份的 secret 扫描；仍然默认关、需要显式勾选。DEVIATIONS D68。 |
