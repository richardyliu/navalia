# Navalia

A local-first macOS app for the
[Persome open-source runtime](https://github.com/Intuition-Lab/personal-model).
默认不登录、不联网；可选的自建云端功能需要你逐项开启（见「自建云端 `cloud/`」）。

Lens v2.1 has four parts:

- **Capture.** Lens owns screen capture and its macOS permissions (TCC). The
  Runtime receives frames over `POST /captures/ingest`.
- **Model.** Lens shows the personal model the Runtime builds: Root, Faces,
  Volumes, Points, evidence, search and corrections.
- **Identity.** Lens signs a local Personal Card, shares it by Swipe, and lets
  coding agents read the model through a loopback Broker. Every read is
  recorded in an Access log.
- **HET.** Lens records completed AI work for Human Equivalent Time. The
  assessor is off by default; when the user turns it on, minutes are an LLM-backed **estimate** (see Limitations, docs/design/HET-X3.md).

The S1 round (2026-11-05, see [docs/design/GAP-vs-S1.md](docs/design/GAP-vs-S1.md))
adds the Personal Database entry points from the S1 article: a daily brief
(今天), a Library of people / projects / skills (资料库), Claude Code / Codex
history import (导入), structured Workflows readable by agents, and honest
evidence / capture / HET status.

The S1-FULL round (2026-11-06, see
[docs/design/GAP-vs-S1-FULL.md](docs/design/GAP-vs-S1-FULL.md) and
[docs/design/S1-FULL-ARCH.md](docs/design/S1-FULL-ARCH.md)) adds **opt-in**
cloud features served by a self-hosted `cloud/` service: 云端对话 (Chat),
会议 (Meetings), 订阅 (weekly-letter email subscriptions and cloud cards),
共同经历 (two-party signed shared moments) and Workflow 云端抽取; plus
connectors (Apple Health, CSV, read-only IMAP), signed / encrypted backups,
「表现」 and more local notifications.

**默认模式（local-only）**：没有账号、没有云，Lens 不发遥测；Lens 打开的每个
socket 都在 127.0.0.1（Runtime API、Runtime 本地 MCP、Lens Broker 8750）。
这一点有 e2e 检查：云端关闭时 15 s 内整个进程树没有非 loopback socket
（`tests/e2e/smoke.e2e.mjs`）。**只有在你开启后**才会有出站连接：
你在「云端对话」/「订阅」/「会议」页的云端面板里填写并确认的 `cloud/` 服务器（登录用本机 Ed25519 身份密钥，没有
密码 / 邮箱注册），以及你单独同意的 IMAP 主机（993，隐式 TLS）。服务器不是
端到端加密。出机数据清单见 `docs/design/S1-FULL-ARCH.md` §4。

## Capabilities

| Area | What it does |
|---|---|
| Capture | A native Node-API addon reads the Accessibility tree, the permission state, the frontmost app and a frontmost-window screenshot. A coordinator handles debounce, dedup and deferral, and the app supports per-app exclusions and pause. Frames go to Runtime `POST /captures/ingest`. Capture runs only when the Runtime config has `[capture] source = "ingest"`. Without Accessibility it runs degraded and sends app-switch frames without AX text. |
| Model | Root / Faces / Volumes / Points, an evidence drill-down (sources, nearby context, history, receipts), search over memory and raw captures, remember and correct, and a Playbook view. The evidence drawer separates **direct sources** from **unresolved receipts** (marked 未解析, with the status and reason the Runtime returned — Lens never invents a reason), shows Runtime-wide gate-drop counts from `persome delta-report` labelled as global, gives copyable reproduce commands without tokens, and has an “as of” (截至) selector that accepts ISO dates / datetimes only. |
| Personal Card | A self-signed `.navaliacard` (Ed25519) built from the Runtime's scrubbed share-card projection. The private key is encrypted with macOS Keychain–backed `safeStorage`. Exports as PNG and QR; Swipe imports and verifies cards. |
| Connections | Per-agent full access to the model for Claude Code, Codex and Cursor. Lens writes their MCP config, pointing at `http://127.0.0.1:8750/mcp` with a bearer token. Claude Desktop has to be connected by pasting the config by hand. |
| Access log | One row per Broker read, grouped by day. Clearing the log does not disconnect any agent. |
| HET | Adapters read Claude Code and Codex agent logs (read-only). A segmenter splits them into tasks recorded in a local ledger (`het.db`); corrections `accepted` / `rejected` / `not_agent`; Weekly Review exports local Markdown/HTML. The same service is also served as REST `/het/*` (summary / tasks / period / activity / corrections / retry) on the Broker's loopback server (Bearer = Connection token, reads need scope `reports:read`, every request Access-logged; `src/main/het/rest.ts`, DEVIATIONS D17). Minutes need an explicit `assessorEnabled` switch **and** a real assessor transport **and** budget; since Round 4 (X3) main injects the Runtime `[agent_funding]` transport (`src/main/het/agentFundingTransport.ts`; runs `<PERSOME_ROOT>/venv/bin/python -I -B -c <fixed script>` → `agent_cli.complete`, sharing the Runtime lock and `daily_call_limit`). Default off → 「评估器未启用，0 分钟」. When on, minutes show as 「估计」 + anchor version, never as performance or time saved. |
| Capture diagnostics | The Capture page shows the Runtime capture source (ingest / daemon / 未知, read-only from `config.toml`), OCR on/off/policy/tier (config + loopback `/health`), Accessibility / Screen Recording state, last frame and counts, exclusions and pause, and a copyable diagnostics block with tokens and keys removed. |
| 今天 (daily brief) | Deterministic Markdown template, no LLM: 今天做了什么 / 下一步 / 待核对, from recent activity, behavior patterns and the HET summary; quotes source lines, checkboxes, every inferred line marked 「未核实」; copy or export `.md`. 下一步 comes only from explicitly unfinished lines (`- [ ]`, `TODO:`, `待办：`) in today's and yesterday's records and verbatim learned habits, each 「未核实」 with its source. It is not a Performance measure. |
| 资料库 (Library) | 人 / 项目 / 画像 / 技能 with the headline 「已整理 X 个项目、Y 个人」, classified only from Runtime fields (Point file prefixes `person-`/`project-`, relation `*_entity_kind`); unknown kinds go to 未分类. 画像 = Root signature verbatim + top 3 Faces (Runtime order) + model counts, linking to 模型. 技能 = observed playbooks + imported / shared (`.navaliaskill`) / edited / externally extracted Workflows with source badges, linking to Playbook; same “N 个技能文件，M 周的判断。” as Playbook. Each section fails on its own. |
| 导入 (history import) | Scans `~/.claude/projects` and `~/.codex/sessions` (read-only), previews sessions, stages redacted Markdown in the Lens Store (dry-run first), then runs `persome import-data --source folder --no-build`; building the model is a separate confirmed step. 导入的 Markdown 默认保留工具名、命令首行和写入 / 编辑的文件路径（已脱敏：家目录写作 `~`，Runtime 与 Lens 数据目录路径移除；从不含工具输出），可在导入页关闭；每个文档带 front matter（`session_key`、`dedupe_key`、`turns`），同一会话重复导入时 Runtime 报告 unchanged（C20，DEVIATIONS D83）。 An 「导入后构建」 switch (off by default, not saved, second confirmation because it calls the Runtime's LLM) chains the build after a successful import; it uses the Runtime's LLM budget (`[agent_funding]` daily cap) and shows the exit code and stderr on failure. |
| 连接器 (connectors) | 日历 `.ics`、健康 / 训练 CSV / JSON 与 Apple Health 导出（`export.xml` / 导出 `.zip`，流式读取，按天汇总）、邮件 `.eml` / mbox（每封一条记忆，附件只记文件名，按 Message-ID 去重）、通用 CSV（自选列映射），以及**只读 IMAP**（应用专用密码，仅 993 隐式 TLS，`src/main/connectors/imap/**` 是连接器里唯一的网络代码）。每个连接器单独同意（native confirm）、可撤销；先预览已脱敏的内容，再写入 Runtime（remember / import-data / health-events）。「已导入的数据」可以删除 Runtime 支持删除的部分（见 Limitations）。不支持 OAuth（Google / Notion / Outlook）。 |
| Skill sharing | 「导出 .navaliaskill」 signs one Workflow with your identity key after Broker-grade redaction; 「导入 .navaliaskill」 verifies offline, rejects tampered / unsigned / unknown files, stores valid ones as 「别人分享」 under a new local id with the signer fingerprint, and reports 「已存在」 on re-import. Badges 来自观察 / 导入 / 别人分享; headline “N 个技能文件，M 周的判断。” |
| 朋友 (Peers) + 每周信 | Import friends' `.navaliacard` into a local Peers list (offline verify, tampered cards refused, updates kept as history). Shows what their card says they work on and a demoted 「关键词重合（未核实，不是共同经历）」 view: 字面重合 + Runtime search + 相关度门槛 (a search hit is shown only if it carries a Runtime `score` ≥ 0.5, or — since today's Runtime `search` returns no score — also overlaps the card topic literally). Keyword overlap is never cited in any letter (C11). 「共同经历」 panel (opt-in cloud): see the 共同经历 row. Weekly letter to one friend: deterministic Markdown draft from your last 7 days plus the signed shared moments with that friend (`visibility: letters` only); copy or export, never sent from this page. 订阅文件夹: 本地订阅文件夹，手动刷新；可选后台周期扫描（默认关）. Pick a local / iCloud Drive folder; 「刷新」 imports its `.navaliacard` / `.navaliaskill` files after offline verification, skipping files already processed (sha256). Optional periodic scan, off by default: every N minutes (≥5) Lens scans only the top level of that folder (not recursive, no network) and stops when Lens quits. |
| Workflows | Playbook turns Runtime skills (`memory/skills/skill-*.md`, `behavior_patterns`) into structured Workflows (goal, inputs, tools, steps, artifacts, rules, problem→solution, evidence, provenance, version). Unmappable fields stay empty. Edits are versioned (the observed original is kept); JSON export / import is validated and deduplicated. Agents read them through the Broker tools `search_workflows` / `get_workflow`. Patterns with evidence on fewer than 3 distinct dates are shown as 「观察中」, not as stable habits. 「从会话 / 文本抽取」: copy a prompt + JSON Schema to Claude Code / Codex, paste the JSON back; Lens validates it and saves a new Workflow (badge 外部抽取). 「云端抽取」（可选云端，C15）：选一个本机 Claude Code / Codex 会话 → 逐条预览将发送的已脱敏片段 → 只发送勾选的条目到你的 `cloud/`（`task: "workflow_extract"`）→ 严格校验回复（坏 JSON / 越界引用整体拒绝）→ 你编辑后保存；来源记为 `provenance.extraction.source = "cloud_extracted"`，徽章「云端抽取」，每项可看到引用的原文。Lens 本机不持有 LLM key、不直连模型。 |
| 首次引导 (onboarding) | First launch on a fresh Lens Store shows a skippable 5-step overlay: welcome / permission status / connect an agent / 导入与预览 (optional) / done with the Library headline. 第 4 步显示资料库里已有的项目、人、技能 / 工作流和模型 Points 数量（各最多 3 个真实示例），读自本机 `library.overview()`；读不到显示「读不到」，没有数据如实为空（C23）。No account, no network, no LLM. Settings → 「重新打开引导」. |
| 问 (Ask) | Four copyable prompts (我是谁 / 本周进展 / 整理微信群 / 找回过去的决定) for the agent you connected in Connections, each listing the MCP tools it expects and asking the agent to cite sources and mark unverified claims. Lens does not answer and does not call an LLM. 「把回答保存到记忆」: paste an agent's answer → Lens redacts it in main and shows exactly what will be saved → a native confirm dialog (Cancel default) → Runtime MCP `remember`. The page shows OCR status from Runtime `/health` and warns on the 微信 card when OCR is not on; when OCR is off / degraded / unknown it lists the steps with copyable commands (`persome ocr setup`, then `persome stop && persome start`). |
| 导出 / 恢复 (backup) | Settings → 「导出个人数据库」 writes `navalia-backup-<time>/`: the Runtime's redacted `persome model export` snapshot, Lens Workflows / peers / cards / settings, and a sha256 manifest; it appears only when complete. 可选包含 Access log、聊天记录、会议转写（不含录音）、共同经历，均默认不包含。可选加密（AES-256-GCM，口令经 scrypt 派生，生成单个 `.navaliabackup` 文件；口令不保存、无法找回）。manifest 用你的 Lens 身份密钥签名（`manifest.sig.json`）。「恢复 Lens 数据」 先完整校验（sha256 / 每个加密块 / 签名），逐项列出将如何恢复并二次确认：卡片逐张验签，无效的跳过；**你自己（当前或以前的身份）签名的备份**按原 ID 逐字节恢复 Workflow 全部版本，本机更新的版本不覆盖，分叉另存为导入副本；未签名 / 别人签名的备份恢复为重新编号的导入副本（含全部历史）；签名无效的整份拒绝；Access log 仅存档（DEVIATIONS D84–D86）。无论如何都不含身份私钥、`grants.json`、云端 token / 设置、Runtime token。The model snapshot is a redacted export, not the Runtime's `index.db` or captures; to keep raw data, back up `~/.persome` separately. |
| 云端（可选，默认关） | 在「云端对话」/「订阅」/「会议」页的云端面板填写服务器地址（`https:`；`http://127.0.0.1` / `localhost` 只在未打包的开发构建里允许）并确认（主进程 native 对话框）后开启；登录用本机身份密钥对服务器 challenge 签名（检查 audience 与配置的 origin 一致），没有密码 / 邮箱。token 用 safeStorage 加密、绑定服务器 origin 和身份指纹（重置身份即登出）、不进 renderer / 日志 / 备份。关闭或换服务器时先尝试注销服务器会话（3 s），再本地删除 token；关闭后不再发出任何云端请求。顶栏显示「本地」/「云端已开启」。设置 →「云端」集中显示服务器地址（只显示 origin）、登录状态、账号指纹（截断 / 哈希，不显示原值），并提供登录、退出登录、删除云账号（主进程原生确认）和开关云端；只有一个全局开关，没有按功能的开关（DEVIATIONS D91）。代码：`src/main/cloud/`（只有 `client.ts` 调 fetch）。 |
| 云端对话 (Chat) | 用本机个人数据库作上下文向你自己的云提问：主进程从 Runtime 组装上下文并脱敏（≤40 条 / 60 000 字），发送前逐条预览、可去掉，renderer 不能注入文本；回答流式显示，带可点开的 `[ctx-N]` 引用（显示当时发出的原文）；「记住这条」预览后经 native confirm 写入 Runtime 记忆（tags `lens-chat,cloud-chat`）；「微信群整理」按群整理本周屏幕上读到的微信内容（只用搜索片段，写明覆盖范围）。对话只存在本机。截图、`index.db`、token 永不发送。 |
| 订阅 (Subscriptions) | 从本机数据生成每周信草稿（固定模板、不调用 LLM、自动脱敏密钥 / 邮箱 / 本机路径等），编辑后预览将要签名的完整字节，确认后签名发给邮件订阅者（服务器双重确认；不追踪打开 / 阅读；每封有退订链接，支持 RFC 8058 一键退订）；查看投递状态和订阅者（邮箱打码）；复制自己的订阅链接；获取朋友的周信并在本机验签（伪造的丢弃并提示）；把个人卡片发布到云端或撤回，按指纹获取朋友的卡片（离线验签后加入朋友列表）。周信可以写进「这周和朋友的共同经历」（只限双签、`letters` 可见、日期在窗口内的条目）。 |
| 会议 (Meetings) | 勾选「已告知参会者」并在 native 对话框确认后才开始录音；麦克风只在录音中、只对 app 自己的页面、只要音频时放行；切换页面时录音继续，顶部有录音横幅。音频每 ~30 s 一片上传到你的云转写，转写回到本机后删除本机音频；可以预览准确的 Markdown 后写入 Persome 记忆（`persome import-data --no-build`）；可选用云端模型从你勾选的转写片段生成摘要。删除会议会删服务器和本机副本；对 R10 Runtime（上游本地分支，`/imports/delete`）可再点「从 Persome 删除…」（原生确认）删除已导入的会议，旧 Runtime 上仍说明不能按条删除（DEVIATIONS D89）。 |
| 共同经历 (shared moments) | 在朋友页向某位朋友亲自发起一条共同经历（标题、日期、地点、附言、可见范围），对方确认后双方签名、各自在本机保存，每次读取都离线验两份签名；签名者不在朋友列表的提议不能接受；固定的回想问题帮你写自己的话（Lens 不替你写，附言不上传）；只有可见范围选「可以写进周信」的才会出现在周信里。任一方删除即双方删除。 |
| 表现 (Performance view) | 只给你自己看：按天 / 按周列出你在 HET 里标记的采纳、不采纳和「不是 Agent 做的」次数，Agent 会话里的 `git commit` 调用次数，以及你添加的本地仓库里你自己的提交数。点任何一个数字都能看到它对应的每一行。读不到的来源显示「未知 / 未接入」，不显示 0。项目：你自己写目标和里程碑，Lens 列出相关活动，不算完成比例、不预测日期。不是绩效分，不经过 Broker。 |
| 本机提醒（进阶） | 在 X9 本机通知之上新增：会议转写就绪、我提议的共同经历被接受、上周「表现」计数三类提醒；每类有「至少几条带证据的条目」门槛，不够就不提醒；每次「发 / 不发 + 原因」记在本机决定记录里（无正文）；可选全局快捷键（冲突检查）、菜单栏「提醒」入口、只在工作日、每日上限、附带简短说明。全部默认关闭；总开关一关全部停止。 |

Some features go beyond the original product: per-scope grants, revoke, renew,
TTL, read limits, and audit rows for denied calls. The UI labels these
**Extension**. [docs/design/DEVIATIONS.md](docs/design/DEVIATIONS.md) lists
every difference from the original product.

## Requirements

- macOS on Apple silicon (arm64)
- Node 22+ and npm
- Xcode Command Line Tools (clang), to build the native addon
- The Persome runtime: `persome` on PATH or in `~/.local/bin`, data in `~/.persome`

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run native:build` | Build `native/build/Release/navalia-native.node` against the Electron headers |
| `npm run dev` | Run in development (electron-vite) |
| `npm run typecheck` | TypeScript, main and renderer |
| `npm test` | Unit and contract tests (vitest; rebuilds the addon first) |
| `npm run build` | Bundle into `out/` |
| `npm run dist` | Addon, then bundle, then DMG in `dist/` (arm64) |
| `npm run e2e` | Offline end-to-end run against the dev build (`tests/e2e/smoke.e2e.mjs`) |
| `npm run e2e:packaged` | Checks on the packaged app: addon placement, fuses, signature, debug switches refused, Broker, loopback-only sockets |

If you start Lens from an Electron-based terminal that exports
`ELECTRON_RUN_AS_NODE=1`, unset it first:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

The E2E run uses a temp Runtime root, a temp Lens Store, a temp agent home,
the HET fixtures in `tests/fixtures/het`, and a mock Runtime and mock MCP
backend. Each step is labelled `[real]` or `[mock]`. If another Lens already
holds port 8750, the Broker steps are reported as `SKIP` and the holder is
named. The capture steps bring a blank test window to the front for a few
seconds. Set `E2E_NO_FOCUS=1` to skip them.

### Environment overrides

| Variable | Effect | Packaged build |
|---|---|---|
| `PERSOME_ROOT` | Runtime root (default `~/.persome`) | yes |
| `PERSOME_BIN` | `persome` binary | yes |
| `LENS_STORE_ROOT` | Lens Store root | yes |
| `NAVALIA_NATIVE` | Path of the native addon | **no** (stripped: would load arbitrary code into main) |
| `LENS_AGENT_HOME`, `LENS_AGENT_APPS` | Where agent configs are detected and written | no (stripped) |
| `LENS_HET_CLAUDE_ROOT`, `LENS_HET_CODEX_ROOT` | Agent-log roots for HET (empty string disables a source) | no (stripped) |
| `LENS_BROKER_PORT`, `LENS_E2E_SAVE_DIR` | Test-only: Broker port (`0` = ephemeral), Weekly / brief / workflow export dir | no (stripped) |
| `LENS_IMPORT_HOME` | Test-only: home dir scanned by 导入 for `.claude` / `.codex` transcripts | no (stripped) |
| `LENS_SCREENSHOT*` | Screenshot harness (dialog hooks only in unpackaged builds) | first page only |

To run a second instance next to an installed Lens, give it its own
user-data dir; otherwise the single-instance lock makes it exit at once:

```bash
env -u ELECTRON_RUN_AS_NODE PERSOME_ROOT=/tmp/persome-test LENS_STORE_ROOT=/tmp/lens-store \
  "dist/mac-arm64/Navalia.app/Contents/MacOS/Navalia" --user-data-dir=/tmp/lens-user-data
```

## 自建云端 `cloud/`

`cloud/` 是可选的自建服务（Node 24、`node:http` + `node:sqlite`，唯一运行时依赖
`nodemailer` 10.2.1），**不随 Lens 打包**，Lens 没有它也能完整使用。它提供设备密钥
登录、Chat 代理（OpenAI-compatible）、名片中继、周信邮件订阅、会议转写、共同经历中继和
`workflow_extract` 任务。

本机开发 / 试用，第三方全部用 mock，不需要任何 key、不发任何外部请求：

```bash
cd cloud
npm ci
CLOUD_PUBLIC_ORIGIN=http://localhost:8787 \
CLOUD_LLM_MODE=mock CLOUD_STT_MODE=mock \
CLOUD_MAIL_MODE=outbox CLOUD_MAIL_FROM=letters@localhost.test CLOUD_MAIL_OUTBOX_DIR=./data/outbox \
  npm start
curl -s localhost:8787/health
npm test          # 118 tests, no network
```

然后在未打包的 Lens（`npm run dev`）里把服务器地址填成 `http://localhost:8787`
（打包版只接受 `https:`）。

- 环境变量全表、接口和安全说明：[`cloud/README.md`](cloud/README.md)。
  真实模式需要你自己的：`CLOUD_LLM_MODE=openai` + `CLOUD_LLM_BASE_URL` / `CLOUD_LLM_API_KEY` /
  `CLOUD_LLM_MODEL`；`CLOUD_STT_MODE=soniox` + `CLOUD_SONIOX_API_KEY`；`CLOUD_MAIL_MODE=smtp` +
  `CLOUD_SMTP_*` + **必须设置** `CLOUD_EMAIL_PEPPER`（≥ 32 字符）。这三种真实模式都**没有**
  在真实环境验证过（只对测试内 fake 服务器）。
- 生产部署：设置 `CLOUD_PUBLIC_ORIGIN` 为对外 origin，放在 TLS 反向代理后面
  （`CLOUD_TRUST_PROXY=1` 只在有自己的代理时开）。`cloud/Dockerfile` 已写，**未构建验证**。
- 架构、出机数据、保留期、威胁模型：[`docs/design/S1-FULL-ARCH.md`](docs/design/S1-FULL-ARCH.md)。
  服务器不是端到端加密：运营方能读到 Chat（请求内存中）、转写、周信、订阅者邮箱、共同经历。

## Layout

```
native/                Objective-C++ addon (AX tree, permissions, screenshot, events), build scripts, AX fixtures
src/main/              Electron main process
  capture/             coordinator, frame builder, ingest client, exclusions/pause settings
  identity/            keys, card schema/sign/verify, grants, Swipe, QR
  broker/              loopback MCP server, agent config writers, Access log
  het/                 adapters, segmenter, assessor, anchors, ledger, Weekly Review
  store/               Lens Store paths and permissions
  workflows/           Workflow schema, Runtime skill mapping, versioned store, external-agent extraction
  skillshare/          signed `.navaliaskill` export/import
  import/              Claude Code / Codex transcript import (redacted staging -> `persome import-data`)
  library/             Library aggregation (people / projects / portrait / skills), daily brief, next steps
  peers/               friend cards, weekly letter draft, local subscription folder
  onboarding/          first-run state
  backup/              full export (model snapshot + Lens data allowlist) and restore; crypto.ts (AES-256-GCM), signature.ts (signed manifest)
  cloud/               opt-in cloud client (client.ts is the only fetch), Chat, subscriptions / cloud cards, meetings + mic gate, shared moments
  connectors/          local connectors, consent, Apple Health, CSV; imap/ = the only network code among connectors
  performance/         「表现」: read-only het.db counts, git log of user-added repos, user projects
  proactive/           local notifications, event bus, decision log, shortcut, tray items
  s1/                  shared dependencies handed to the S1/S2 feature modules
  runtime/, mcp/       Runtime HTTP client (incl. owner-alias REST), MCP client, Ask save-answer (preview → confirm → `remember`)
  security.ts          navigation/IPC guards, app:// protocol, debug-switch refusal
src/preload/           contextBridge API (`window.lens`)
src/renderer/          React UI (src/pages/*)
src/shared/            API and types shared by main and renderer
tests/                 vitest suites per plane, e2e/, fixtures/
docs/                  design, plan, reference, deviations, security findings, test evidence
cloud/                 optional self-hosted service (Node 24, SQLite); not bundled with Lens; see cloud/README.md
```

## Data

### Lens Store

Default location: `~/Library/Application Support/Navalia`, or
`LENS_STORE_ROOT`. Directories are 0700 and files 0600.

| Path | Contents |
|---|---|
| `identity/ed25519.key.enc` | Private key, encrypted with `safeStorage` (Keychain) |
| `identity/identity.json` | Public key, fingerprint, creation time |
| `identity/previous.json` | Public records of keys retired by "Reset identity" |
| `cards/` | Issued `.navaliacard` files |
| `grants.json` | Connection grants (token hashes, not tokens) |
| `audit.db` | Access log (SQLite) |
| `het.db` | HET ledger (SQLite) |
| `het-settings.json`, `capture-settings.json`, `settings.json` | Settings (HET `assessorEnabled`/budget/transport, exclusions/pause, display name) |
| `workflows/<id>/vNNNNNN.json` | Versioned Workflows (observed v1 kept; edits and imports as new versions) |
| `peers/<fingerprint>.json` | Imported friend cards (verified on every read, ≤20 versions) |
| `import/staging/<runId>/`, `import/ledger.json` | Redacted Markdown staged for `persome import-data`; content-hash ledger of imported sessions |
| `onboarding.json` | First-run record: outcome (completed / skipped / legacy / reopened), last step, timestamps |
| `peers/subscription.json` | Subscription folder path, enabled flag, sha256 ledger of processed files (name, kind, outcome, time; no content) |
| `workflows/ext-<hash>/` | Workflows pasted back from an external agent or saved from 云端抽取 (`provenance.extraction`) |
| `cloud.json` | 云端开关与服务器地址（默认 `enabled:false`，读不懂即视为关闭） |
| `cloud-token.enc` | 加密的登录令牌（safeStorage），绑定服务器 origin 与身份指纹；不进备份 |
| `chat/c-<id>.json` | 云端对话：消息、发送过的上下文快照、引用、用量（只在本机） |
| `cloud-letters/<fingerprint>/<issue_id>.json` | 已验签的朋友周信缓存（每位朋友最多 52 封） |
| `meetings/<id>/{meeting.json, audio/<seq>.webm, transcript.json}` | 会议元数据、未转写的音频分片（转写后删除）、转写稿 |
| `moments/<moment_id>.json` | 双方签名的共同经历 + 你自己写的话 |
| `performance/projects.json`, `performance/repos.json` | 「表现」的项目 / 里程碑和你添加的仓库 |
| `proactive-decisions.json` | 提醒的「发 / 不发 + 原因」记录（只有类别、数量和哈希编号，无正文） |
| `connectors/consent.json`, `connectors/ledger.json`, `connectors/imap.secret.json` | 连接器同意记录；写入账本（内容 hash、Runtime 条目 id、健康 event id、时间线文档）；IMAP 设置（只有 safeStorage 密文） |

### Backup directory (S2-02)

`<chosen folder>/navalia-backup-<time>/` (dirs 0700, files 0600): `manifest.json`
(`navalia.backup` v4 (older versions still accepted on restore), `includes_access_log`, `includes_user_data`, sha256 + bytes per file, excluded entries with reasons),
`manifest.sig.json` (Ed25519 signature over `navalia-backup-v1\n` + canonical manifest; absent when no identity existed),
`model-snapshot.json` (Runtime `persome model export`, redacted), `lens/{workflows,peers,cards}/`,
`lens/settings.json`, `lens/het-settings.json`. `lens/access-log.json` only when 「包含 Access log」 is ticked; chat / meeting transcripts / moments only when ticked. Never included: `identity/`, `grants.json`,
the `audit.db` file itself, `het.db`, `import/`, `cloud.json`, `cloud-token.enc`, meeting audio.
加密备份是单个 `navalia-backup-<time>.navaliabackup` 文件（`navalia.backup-enc` v1：scrypt → AES-256-GCM，1 MiB 分块），内容同上。

### Runtime version (deployed 2026-11-05)

| Item | Value |
|---|---|
| Runtime build | `personal-model-og` @ `462361d` (R1–R9), local tags `deploy/2026-11-05-r1r6` (`be0a0bc`), `deploy/2026-11-05-r1r7` (`03698b5`), `deploy/2026-11-05-r1r8` (`4e83ce8`), `deploy/2026-11-05-r1r9` (`462361d`, lineage backfill applied to real data: 45/49 Points and 107/187 Lines now have sources). R8 log: [docs/design/UPSTREAM-DEPLOY-R8.md](docs/design/UPSTREAM-DEPLOY-R8.md) |
| Schema | `2026-11-05.3` (migrated from `2026-08-11.4`; Runtime 0.3.2 refuses to open it) |
| Deploy status | Installed locally into `~/.persome` with `install.sh --update`. **Not pushed, no PR, no release.** Log: [docs/design/UPSTREAM-DEPLOY.md](docs/design/UPSTREAM-DEPLOY.md) |
| OCR (`/health`, 2026-11-05) | `ocr_enabled=true`, `ocr=ready`, `ocr_worker=ready`, `ocr_tier=tiny` |

Backups taken before each step (directories 0700; they contain `env` and the database, so treat them as secret):

| Path | Contents |
|---|---|
| `~/Persome Backups/20261105-145247-pre-r1r6/` | `data/` (schema `2026-08-11.4` `index.db`, `memory/`, config) + `venv-old/` (Runtime 0.3.2) + `manifest.sha256` |
| `~/Persome Backups/20261105-154335-pre-r7/` | `index.db` at schema `2026-11-05.3` + `venv-r6/` (R1–R6 venv) |
| `~/Persome Backups/20261105-173654-pre-r8/` | `data/` (index.db + wal/shm, consolidated copy, memory/, capture-buffer/, config) + `venv-r7/` (R1–R7 venv) + `manifest.sha256` |
| `~/Persome Backups/20261105-180023-pre-r9/` | same layout, taken before the R9 backfill + `venv-r8/` (R1–R8 venv) |

Rollback steps are in UPSTREAM-DEPLOY.md (DEPLOY-06 and "Rollback options now").

### Runtime files Lens reads

| Path | Purpose |
|---|---|
| `<root>/env` | Bearer token for the Runtime API, and `PERSOME_SCREENSHOT_KEY` (read in main only, to decrypt Rewind screenshots). Neither ever reaches the renderer or the logs. Screenshots returned to agents are **not** PII-scrubbed. |
| `<root>/capture-buffer/*.json` | Frames read by `rewind_frames` / `view_rewind_screenshot` |
| `<root>/config.toml` | `[mcp].port` (default 8742) and `[capture].source` |

Lens never writes the Runtime's `index.db`. It changes Runtime data only
through the Runtime's own interfaces: the ingest API, the MCP `remember` and
`correct_memory` tools, `persome import-data` / `persome model build`, and for
connector deletion `POST /health-events/import` (`deleted_events`) and
`POST /model/edit` (`retire`), plus, on an R10 Runtime (local upstream branch
`og/r10-version-delete`, not merged upstream), `POST /imports/delete`,
`POST /memory/entries/delete` and `POST /timeline/delete`. The proactive T5
「Runtime 已更新」 check keys off `schema_revision` / `build_version` from
`/health` when present (DEVIATIONS D89/D90).

Connected agents get **full access** through the Broker: all 22 Runtime MCP tools
under their own names (including the write tools `remember`, `correct_memory`,
`process_pending_model_work`, and since schema `2026-11-05.3` the read tool
`owner_aliases`), three Rewind tools (`search_rewind`,
`rewind_frames`, `view_rewind_screenshot`; shapes are Lens-defined) and four Lens
extensions (`card_get`, `usage_report`, and the read-only S1 tools
`search_workflows` / `get_workflow`, scope `model:search`): 22 + 3 + 4 = 29 tools. Tools that may spend LLM budget are
refused unless the agent budget is enabled and has calls left. Every call is in
the Access log. See DEVIATIONS D19, D26 and D55–D57; deploy deviations are D50–D54.

**Owner aliases.** The Runtime proposes names / accounts that may be the user; an alias
becomes active (resolves to self in `entity_graph`) only after the user confirms it, and a
rejected alias is not reopened by later suggestions. Lens reads them through
`GET /owner-aliases` and confirms / rejects through `POST /owner-aliases/{confirm,reject}`,
each behind a native dialog (Cancel default). For a scoped grant the Broker tool
`owner_aliases` needs `model:search` (not the public `identity:read`); without
`evidence:read` rows pass a fixed field allowlist with `evidence: []`. The alias `note`
field does not cross IPC. Real data had 0 aliases in every status on 2026-11-05.

### Trust boundaries

- Tokens, the private key and all Runtime calls stay in the main process. The
  renderer is sandboxed, with context isolation and a strict CSP
  (`connect-src 'self'`). It talks to main through an IPC allowlist that
  validates every payload with zod and checks the sender.
- The packaged app uses hardened Electron fuses: no `ELECTRON_RUN_AS_NODE`, no
  `NODE_OPTIONS`, no `--inspect`, asar integrity validation, app code loaded
  only from asar, and no extra privileges for `file://`. The renderer is served
  from `app://lens/`. A packaged build refuses to start with `--remote-debugging-port`,
  `--remote-debugging-pipe`, `--inspect`, `--inspect-brk` or `--inspect-port`.
- The Personal Card is self-signed. Verifying it proves the card is intact and
  matches its key; it does not prove who the holder is. Compare the
  fingerprint.
- Cloud (opt-in): only `src/main/cloud/client.ts` makes cloud requests, and only
  while the cloud is on; the bearer token and the identity private key never
  reach the renderer. Everything sent is first shown to you (context items,
  exact signed bytes of letters / cards / moments, consent before recording).
  Microphone access is denied unless a consented meeting is recording, and then
  only audio for the app's own page (`src/main/cloud/meetings-mic-gate.ts`).
- Capture runs inside Lens itself through the native addon. There is no
  `mac-ax-helper` fallback process, so Lens is the only app that asks for, and
  holds, the Accessibility and Screen Recording permissions.

## Limitations and blocked items

- **Signing and notarization: blocked.** The DMG is ad-hoc signed (bundle id
  `dev.navalia.app`). There is no Developer ID certificate and no
  notarization. Gatekeeper blocks a downloaded copy until the user allows it
  in System Settings.
- **TCC grants and rebuilds.** For an ad-hoc signed app, macOS ties
  Accessibility and Screen Recording grants to that exact build, so they may
  have to be granted again after an update. Until both are granted, capture
  runs degraded: no AX text, no screenshots. This happened for real on
  2026-11-05/06 (frames kept flowing, 0 with text, every timeline block
  `metadata_only`). The Capture page now shows frames / text frames / coverage
  and a red banner with 「打开系统设置」 when frames arrive without text, plus the
  reason a screenshot was not attached (e.g. `screen_recording_denied`).
  `bash scripts/verify-capture-text.sh` prints per-day counts only (no titles,
  URLs or text) from `~/.persome/index.db`, read-only, and exits 2 when the
  latest day has captures but no text. After re-granting, remove and re-add the
  app in both lists rather than toggling the old entry. See
  `docs/design/BLOCKED-BURNDOWN.md` B1/B18.
- **HET minutes are an estimate, and off by default.** X3 is approved
  (DECISIONS-ROUND4 R4-1). The assessor runs only when the user turns on
  「允许评估」 on the HET page, the Runtime python exists, and
  `[agent_funding]` is enabled and not exhausted; HET's own caps (5/tick,
  20/day) apply on top. By default the prompt carries only ids, counts, tool
  names, signals and file types; sending summaries is a separate opt-in with a
  native confirm. The LLM returns buckets only; minutes come from versioned
  anchors. With no adoption signal the weight is 0.3, so most estimates are
  deliberately low. They are not a performance score and not time saved.
  HET never uses the cloud LLM. In packaged builds `LENS_HET_FAKE_ASSESSOR` is
  ignored at runtime.
- **「表现」 is counts and activity, not a score.** Option A (time saved) is not
  built. X4 option B (「本周 AI 工作计数」 on Home, and the 「表现」 page) shows
  counts only to the owner and links each number to its rows; option C is an
  activity list against your own goals, with no completion ratio and no dates
  (`docs/design/PERFORMANCE.md`). 「会话里的 git commit」 counts `git commit`
  calls in transcripts, not confirmed commits, and HET keeps a bounded set of
  evidence per task, so it may undercount. Project activity from memory uses
  Runtime search (top 20 per keyword, then a literal filter). Tested on fixture
  data only.
- **Local notifications (X9) are opt-in and off by default.** They need the
  switch in Settings; at most 3 per local day, quiet hours default 22:00–09:00,
  no body text in the notification, no network. The C17 additions (event
  triggers, context gate, decision log, global shortcut, tray items) are also
  off by default. None of this has been run against the real Notification
  Center, menu bar or global shortcut registry, only against fakes.
- **Lens holds no LLM key and calls no model directly.** 「问」 and the
  external Workflow extraction hand a prompt to an external agent. The opt-in
  cloud features (云端对话, 会议摘要, 云端抽取) send previewed content to *your*
  `cloud/`, and the server calls the LLM. Those paths have been tested only with
  the mock LLM / a fake OpenAI-compatible upstream, never a real provider.
  WeChat content is limited to what was on screen and captured
  (AX / OCR) within the retention window; no WeChat database is read. WeChat
  exposes almost no Accessibility text, so without OCR there is essentially no
  WeChat text. Capture and 问 show the Runtime `/health` OCR fields and, when OCR
  is off, the steps to enable it (`persome ocr setup`, which writes
  `[capture] enable_ocr_fallback / ocr_policy / ocr_tier`, then a Runtime restart).
  Lens never edits `config.toml`; its 「重启 Runtime…」 button asks first.
- **「把回答保存到记忆」** saves the pasted text verbatim minus redactions
  (heuristic, errs toward removing too much; an env / credential dump is refused),
  with a provenance header and tags `ask-answer,external-agent`; the Runtime adds
  `source:agent-run`. Lens does not check whether the answer is true.
- **Backups** exclude the identity key, grants, HET ledger, import staging and
  cloud token / settings, and include the Access log, chat, meeting transcripts
  or moments only when you tick them (default off; the manifest records it).
  Encryption is optional; a lost passphrase cannot be recovered. The model
  snapshot is archive-only (restore it on the Runtime side); the Access log is
  archive-only (never written back to `audit.db`). Workflows come back under
  their original ids with full history **only from a backup signed by your own
  identity**. Because the private key is never in a backup, restoring on a new
  machine (new identity) brings Workflows back as re-stamped `imp-*` copies with
  full history (DECISIONS S1F-11). `peers/subscription.json` and
  `onboarding.json` are machine-local and not backed up.
- **Cloud is not end-to-end encrypted.** The server operator can read chat
  content (in request memory), transcripts, weekly letters, subscriber
  addresses and shared moments. Turning the cloud off stops all requests but
  does not delete server data; deletion is a separate action per feature
  (delete a meeting, unpublish the card, delete a shared moment, remove a
  subscriber). Deleting the whole cloud account (`DELETE /v1/account`) is
  implemented in the client and IPC (`window.lens.cloud.deleteAccount`, native
  confirm) but, as of 2026-11-06, no page has a button for it. If the logout request fails when you turn the cloud off, the
  server session stays valid until it expires (30 days by default).
- **Not verified in a real environment:** real LLM provider, Soniox, SMTP
  delivery to a real inbox (and SPF / DKIM / DMARC), a real IMAP mailbox, the
  real microphone and MediaRecorder rotation, the Docker image. All were tested
  against in-test fakes or mock modes only.
- **Meetings.** Content written into Persome cannot be removed per meeting
  (only via bulk 「删除时间线 / 全部记忆」); deleting a meeting says so. Speaker
  labels are valid within one ~30 s chunk only (`S1@3` = S1 in chunk 3). A
  recording loses a few ms at each 30 s boundary. The server keeps transcripts
  at most 7 days.
- **Subscriptions.** A sent letter cannot be recalled. The draft is
  redacted automatically (secrets, e-mail, local paths, phone / ID numbers) but
  names and ordinary text are not; check it before publishing.
- **Shared moments** need the friend's card in Peers first. Deleting removes
  the moment for both on the server; the friend's local copy goes away when
  they sync and confirm.
- **Connectors.** No OAuth (Google / Notion / Outlook). IMAP supports app
  passwords on port 993 (implicit TLS) only. With the Runtime's default
  markdown write authority, memories written by `remember` cannot be deleted
  per item, and imported timeline documents cannot be deleted by source; Lens
  lists what remains and how to remove it by hand. Apple Health aggregates
  common types only (cumulative types: the largest single source per day).
- **Subscription folder** imports skills only from friends already in Peers
  (import their card first, or drop it in the same folder). 本地订阅文件夹，手动刷新；可选后台周期扫描（默认关）:
  the periodic scan runs the same refresh on the same folder only after you turn it
  on (interval 5 min – 24 h, default 30 min). Top level only, no network, no
  symlinks, iCloud files must be downloaded, ≤2 MB per file, ≤200 files per refresh.
- **Onboarding** is shown only on a fresh Lens Store; existing users can reopen it
  from Settings.
- **Capture L2/L3 (CAP-01/08/09)** need a person to accept the macOS TCC prompts
  (Accessibility, Screen Recording) on the packaged app by hand; they cannot be
  automated. Checklist in `docs/upstream/CAPTURE-L2L3.md`.
- **Evidence chain: backfilled, with gaps.** New Points / Lines record lineage
  in `model_candidate_points` / `relation_edge_evidence` (R1). Objects built
  under Runtime 0.3.2 were linked by the deterministic R9 backfill
  (`persome model backfill-lineage`, no LLM): 45/49 Points and 107/187 Lines now
  have direct sources. `persome model build` does not backfill old objects. Still
  without candidate sources: 4 `remember` facts (their source is their own
  entry), 42 event-occurrence Lines, 3 closed Lines. `as_of` (MOD-12) is
  unchanged by the backfill; a bare date means 00:00 local.
- **Workflow structure (R8): deployed, not yet observed on real data.** The
  Runtime can write evidence-backed Steps / Artifacts / Rules / Problems, but
  the real model has 0 skills and the Runtime LLM daily cap was used up on
  2026-11-05, so no real structured Workflow exists yet.
- **Restart other MCP clients after a Runtime upgrade.** Claude Code / Codex /
  Cursor sessions keep their old `persome mcp` stdio process, which runs the old
  code and cannot join the new SQLite maintenance gate. Restart those sessions
  (Lens' own MCP client reconnects by itself) before they write with
  `remember` / `correct_memory`.
- **Import.** Needs the `persome` CLI. Building the model after import needs a
  Runtime LLM (`persome llm setup`); without it the build step fails and says
  so. Redaction is heuristic and errs toward removing too much; tool output and
  reasoning are not imported. Re-importing a session that grew duplicates its
  earlier content ([docs/upstream/IMPORT-SOURCE-KEY.md](docs/upstream/IMPORT-SOURCE-KEY.md)).
- **Library / brief.** Classification depends entirely on Runtime entity files
  and relation kinds; differently written names are not merged; `entity_graph`
  only resolves the person roster. The brief reads the latest 100 activity
  entries and only recognises explicit todo markers (`- [ ]`, `TODO:`, `待办：`).
- **Workflows / habits.** Fields are filled only from what the Runtime wrote;
  today's Runtime skill entries carry Pattern / Context / Evidence, so most
  Workflows show goal, context and evidence until edited. Habit dates are
  Runtime write times. Since schema `2026-11-05.3` the Runtime promotes a Face to
  active only with evidence on ≥3 distinct dates and returns `observation_dates`;
  Lens labels Faces from those dates. Verified on temp roots only: real data had
  0 Faces on 2026-11-05.
- **Sharing is self-signed.** `.navaliaskill`, friend cards, weekly letters and shared moments prove integrity and the signing key, not who the sender is — compare fingerprints out of band. Exporting needs an identity (never created silently). In the default local mode nothing is sent: a friend's update arrives only as a new card file (dropped in the local subscription folder or imported by hand) and the per-friend weekly letter is a draft. With the opt-in cloud, cards and letters can be published to and fetched from your `cloud/`, and are always re-verified offline (DEVIATIONS D3 / D31 / D38 S1-FULL notes).
- **关键词重合** (the demoted view on a friend's page) uses 字面重合 + Runtime search + 相关度门槛. The Runtime's `search` returns no relevance score (`rank` is a raw BM25 value or `0.0`, `confidence` is extraction confidence), so a search hit must also share words with the friend's card topic. It is labelled 「未核实，不是共同经历」 and is never cited in a letter; 共同经历 exist only as two-party signed moments.
- **Capture diagnostics.** Frame counts cover the current Lens run only; a
  missing or malformed `config.toml` shows 「未知」.
- The Runtime must be switched to `[capture] source = "ingest"` before Lens
  captures. With `source = "daemon"` Lens capture stays inactive and says so.
- Claude Desktop is connected by pasting the MCP JSON by hand.
- The Codex adapter has been tested on fixtures only.
- The Broker port (8750) is fixed. Only one Lens instance per user can serve
  the Broker.

Security review findings and their status are in
[docs/agents/SECURITY-FINDINGS.md](docs/agents/SECURITY-FINDINGS.md).

## Screens (v1 console)

| Overview | Model | Search |
|---|---|---|
| ![](docs/screens/p01-overview.png) | ![](docs/screens/real-built-model.png) | ![](docs/screens/p01-search.png) |

| Playbook | Evidence | Remember |
|---|---|---|
| ![](docs/screens/p23-playbook.png) | ![](docs/screens/real-built-evidence.png) | ![](docs/screens/p23-remember.png) |

## Design and plan

- [v2.1 design](docs/design/DESIGN.md)
- [v2.1 plan](docs/design/PLAN-v2.md)
- [Deviations from the original](docs/design/DEVIATIONS.md)
- [v1 design archive](docs/design/DESIGN-v1-archive.md)

## License / attribution

This is an unofficial third-party app. It reads data produced by the Apache-2.0 licensed open-source runtime;
no runtime code is redistributed here.
