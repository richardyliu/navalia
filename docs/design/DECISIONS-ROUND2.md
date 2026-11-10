# Decisions — Round 2（2026-11-05）

Round 2 在拍板前一律按下表“默认值”执行。默认值都是本地、无账号、无云、Lens 不调用 LLM。
表中“待拍板”是用户需要回答的问题；回答前代码不会越过默认值。

| # | 问题 | Round 2 默认值（已实现） | 待拍板 |
|---|---|---|---|
| X1 | 云 / 账号 | 不引入服务端、账号、遥测、公网请求。卡片 / 技能 / 备份只做本地文件交换（`.persomecard`、`.lensskill`、备份目录） | 是否引入任何服务端（自建 / 第三方）；身份担保方式（当前自签名，DEVIATIONS D3a） |
| X2 | 订阅 | 「本地订阅文件夹」：用户选一个本地 / iCloud 文件夹；默认关闭；手动「刷新」扫描 `.persomecard` / `.lensskill`，验签后导入，按文件 hash 去重；不后台轮询、不联网（S2-09） | 是否接受共享文件夹作为正式订阅载体；是否允许后台定时扫描 |
| X3 | HET | 保持默认关闭，不接真实 transport；页面继续「未测量」 | 是否授权真实 LLM transport（预算、模型、数据出境范围）；HET 是否保留一级导航 |
| X4 | Performance | 不定义、不实现指标。`docs/design/PERFORMANCE.md` 列 3 个选项与推荐，标 BLOCKED。Today 的「下一步」不叫 Performance（S2-08） | 选哪个定义（HET 时间 / 任务效果 / 长程项目完成度），谁能看 |
| X5 | 导入后构建 | `import-data` 默认 `--no-build`；Import 页「导入后构建」开关默认关闭，打开需二次确认并提示会调用 Runtime 的 LLM（S2-10） | 是否允许默认开启 |
| X6 | 习惯阈值 | 不改 Runtime；Lens 继续标「观察中（未满 3 个不同日期）」；上游提议 `docs/upstream/HABIT-3-DATES.md` | 是否向上游提交该提议 |
| X7 | Workflow 自动抽取 | **Lens 不调 LLM。** 「从会话 / 文本抽取」= Lens 给出 prompt + JSON schema → 用户在 Claude Code / Codex 里运行 → 粘贴 JSON 回 Lens → `WorkflowSchema` 校验后保存（S2-07） | 是否允许 Lens 内置 LLM adapter（模型、预算、出境数据范围） |

## Round 2 新增的待拍板项

| # | 问题 | 默认值 | 待拍板 |
|---|---|---|---|
| X8 | 备份是否包含 Access log（`audit.db`）与 grants | 默认**不包含** `audit.db`、`grants.json`、`identity/ed25519.key.enc`（S2-02） | 是否提供“包含 Access log”的显式选项 |
| X9 | 主动层（Tray / Notification / globalShortcut / 定时 brief） | 不做；「今天」手动刷新 | 是否允许 Lens 常驻菜单栏并在本机发通知（仍不联网） |
| X10 | 对外发布上游备注（MOD-07、IMPORT-SOURCE-KEY、HABIT-3-DATES） | 只写在本仓库 `docs/upstream/` | 是否向 personal-model 上游提 issue / PR |
