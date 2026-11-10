# HET-X3 — 真实 assessor transport（Runtime agent_funding）

批准边界见 `DECISIONS-ROUND4.md` R4-1。本文记录实现、预算、出机数据和真实运行。

## 1. Transport

`src/main/het/agentFundingTransport.ts`，名称 `agent_funding`。

- 解释器：`<locate().root>/venv/bin/python`。不存在或不可执行 → 每次调用都返回 `budget_unavailable`，**不 spawn 任何进程**，也不回退到 `claude`。
- 调用：`execFile(python, ['-I','-B','-c', AGENT_FUNDING_SCRIPT])`，`shell:false`，cwd = OS tmpdir，stdout 上限 1 MB。`-B` 防止往 `~/.persome/venv` 写 `.pyc`。
- 固定脚本（字符串常量，不拼接任何输入）从 stdin 读 `{messages:[{role:'user',content:<prompt>}], max_tokens:800}`，执行 `persome.config.load().agent_funding` → `agent_cli.complete(cfg, messages=…, tools=None, max_tokens=…)`，stdout 只打一个 JSON：`{content, client, model}` 或 `{error, message, client, model}`。
  - `config.load()` 读 `paths.root()/config.toml`；设置了 `PERSOME_ROOT` 时 root = 该值。主进程总是设 `PERSOME_ROOT=locate().root`，所以与 `readBudget()` 读的是同一份 config 和 usage 账本。
- 异常映射：`AgentFundingBudgetExceeded`→`quota`；`AgentFundingTimeout`→`offline`；`AgentFundingUnavailable`（未启用 / 可执行文件缺失 / CLI 非零退出）以及 import/config 失败 →`budget_unavailable`；其他 →`error`（只回传异常类名）。
- 子进程 env：白名单与 Runtime 自己的 `agent_cli._PASSTHROUGH_ENV_NAMES` 相同（HOME/USER/PATH/TMPDIR/LANG/LC_*/代理/CA 等），再加 `PERSOME_ROOT`。不传 API key、`NODE_*`、`ELECTRON_*`。PATH 追加 `~/.local/bin:/opt/homebrew/bin:/usr/local/bin`（从 Finder 启动的 app PATH 很短）。
- 超时：Runtime 的 `timeout_seconds`（180 s）先触发并清理 CLI 子进程；Node 侧在 180 s + 15 s 时 kill python（若先 kill python，`claude` 会成为孤儿进程）。
- 日志：从不输出 prompt。stderr 只在出错时取末尾 2 KB，经 `redactForDisplay` 后写入主进程日志。

## 2. Gate 与预算

`src/main/index.ts` HET 段注入 `transport` + `budget` + `assessorMeta`。只有同时满足以下条件才会产生分钟：

1. `het-settings.json` `assessorEnabled === true`（默认 false，主进程从不自动打开）；
2. transport 存在；
3. budget probe：python 存在，且 `readBudget()` 为 `enabled && !exhausted`（否则原因为 `runtime_python_missing` / `not_enabled` / `exhausted`）；
4. HET 自身的 `perTickCap=5`、`perDayCap=20`。`quota`/`offline`/`error` 后进入 15 分钟退避，不会反复重试。

共享预算：每次调用都在 Runtime 内部占用 `$PERSOME_ROOT/.agent-funding-usage.json` 的一个单位（fcntl 锁），与 daemon 共用同一个 `daily_call_limit`。**偏差**：本机 limit 当前是 20000，不是 brief 写的 200（见 R4-1a）。因此实际约束 HET 用量的是 `perDayCap=20`。

## 3. 出机数据

默认（`sendSummariesToAssessor=false`）prompt 只包含：task id、agent、duration_min、stats 计数、tool names、signals、file **types**、evidence event ids。不发送标题、项目路径、文件路径、summary 或原文。实测真实 prompt 长度为 1045–3190 字符。

可选「发送摘要给 assessor」：默认关。打开时必须经过主进程原生确认框（`SEND_SUMMARIES_CONFIRM`），确认框写明会发送什么、发给谁（经 Persome Runtime 配置的 CLI 提供方），以及发出后无法撤回。关闭无需确认。

Lens 侧保存的内容：verdict、evidence ids、计数，以及 `agent_calls.{client, model, anchor_version, input_chars, output_chars}`（schema 迁移 v2）。**不保存** prompt 或模型原始输出（测试会 dump 全表做检查）。

## 4. UI

`components/het/AssessorPanel.tsx`：「允许评估」开关（默认关），以及 client/model、今日预算（used/limit）、发送内容说明、「发送摘要给 assessor」开关。各状态的文案：

| 状态 | 文案 |
|---|---|
| disabled | 评估器未启用，0 分钟 |
| no_transport | 本构建没有可用的 assessor transport |
| budget_unavailable | 预算不可用（附原因） |
| 有分钟 | 「估计」+ anchors v<n> +「不是绩效、不是节省时间」 |

## 5. 测试

- `tests/het/agentFundingTransport.test.ts`（27 个）：成功路径（fake exec → verdict → anchors → minutes）；带 `minutes` 或未知键的 verdict → invalid，0 分钟；quota/budget_unavailable/offline/error/被 kill/stdout 乱码/超出 maxBuffer → 只 spawn 一次、进入退避、0 分钟；默认关、预算耗尽、未启用、python 缺失 → 0 次 spawn；日志与 het.db 中都不含 prompt；IPC 确认流程。另有 2 个集成测试，用**真实** `~/.persome/venv/bin/python` 跑固定脚本、配临时 root（`enabled=false`，以及 executable 缺失）→ `budget_unavailable`，0 次 LLM 调用，`~/.persome` 下 usage 文件的 stat 不变。
- `tests/het/c23-transport.test.ts` 已改写：默认关；index.ts 有 readBudget probe；所有 gate 都打开才会调用；HET 不 import cloud 模块，也不出现 `/v1/chat/completions`。
- `tests/e2e/smoke.e2e.mjs`：断言 `transport === 'agent_funding' && assessor.state === 'disabled'`。

## 6. 真实运行（2026-11-06，PST）

方法：用 sqlite `.backup` 把真实 het.db（728 个 `needs_assessment`）复制到 scratchpad，配**真实** transport + 真实 `~/.persome` Runtime，`perTickCap` 先设 1 再设 2；runner 见 `docs/test-evidence/PHASE4/x3/runner.ts`。没有直接在正在运行的打包版 app 上做，原因有二：那个 bundle 是 X3 之前构建的；重新打包会覆盖正在运行的 app 并重置它的 TCC 授权（见 §7）。

| # | task | agent | kind | size | complexity | agent_share | adoption | 分钟（估计） | client / model | anchor |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | het_42fc…f4b4d3d1 | claude-code | coding | s | low | 1.0 | unknown | **5.1** | claude-code / (订阅默认) | v1 |
| 2 | het_f6d6…094696a | claude-code | research | s | medium | 1.0 | unknown | **3.0** | claude-code / (订阅默认) | v1 |
| 3 | het_0bcc…2948ace | claude-code | coding | l | medium | 0.95 | unknown | **27.0** | claude-code / (订阅默认) | v1 |

- 第 1 个任务的分钟可以手算核对：45（coding anchor v1）× 0.5（s）× 0.3（adoption unknown）× 0.75（low）= 5.06 → 5.1。3 个 verdict 都通过了严格 schema 校验，没有出现 `invalid`。
- 调用次数：3 次（X3 自限 20）。usage 计数 9→10→12，由 Runtime 自己记账。单次耗时约 8–12 s。
- 关闭开关后：tick 结果为 `gated: assessor_disabled`，0 次调用，usage 不变。
- 发现：默认隐私模式下，3 个 verdict 的 adoption 都是 `unknown`（任务没有 `git_commit` 等 signal，prompt 里也没有内容），所以分钟都乘了 0.3。这是**有意偏低的估计**，不是度量。
- 证据：`docs/test-evidence/PHASE4/x3/{agent_calls.csv, assessed_tasks.csv, runner.ts}`（不含标题和路径）。

结论：**X3 PASS（transport + gate + UI + 测试 + 真实估计分钟）**。还剩一项：在新打包的 app 里点击 UI 开关、再看 HET 页显示，需要先重新打包（§7）。

## 7. 未完成

- 打包版已重建（2026-11-06 13:49，`e2e:packaged` 30/0/1），新 app 在跑，评估器默认关。还剩：用户在 HET 页点击「允许评估」做 UI 实测。
- `AgentFundingUnavailable` 也包括"CLI 非零退出"（登录过期、断网），这种情况在 UI 上会显示「预算不可用」，原因不够精确。
- Anchors 校准（E3.7）仍需用户审阅。
