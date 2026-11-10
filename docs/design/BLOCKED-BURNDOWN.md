# BLOCKED burn-down（S1 收口，2026-11-06）

规则：每一项都有 owner、一条可执行动作、验收条件。「DONE」= 本轮已用代码 + 测试 + 证据关闭；「OPEN」= 等 owner 动作。没有任何一项用 mock 冒充真实结果。

Owner 取值：**用户**（需要你的账号 / 凭据 / GUI / 决策）、**上游**（personal-model-og 维护者；本地分支已实现的只差合入）、**代码**（agent 可做）、**数据**（只能等时间流逝 + 采集）。

| # | BLOCKED | 状态 | Owner | 精确动作 | 验收 | 证据 |
|---|---|---|---|---|---|---|
| B1 | 11-06 采集 0 文本（TCC 在 ad-hoc 重签后失效） | **DONE**（AX：20:33:38 PST `ax=True`；Screen Recording 仍 `screenshot=False`，待用户） | 用户 | 退出 Lens → 系统设置 → 隐私与安全性 → **辅助功能** 和 **屏幕录制**：用「−」移除 Persome Lens，再「+」添加 `dist/mac-arm64/Persome Lens.app` 并勾选 → 启动该 app 正常使用 15 分钟 → `bash scripts/verify-capture-text.sh` | 脚本 exit 0，当天 `with_text > 0`；`~/.persome/logs/capture.log` 出现 `ax=True`；`timeline_blocks` 出现当天 `llm` | `test-evidence/PHASE5/capture-text/`（当前：11-06 313 帧 / 0 文本，exit 2） |
| B2 | Workflow 真实 steps | OPEN（日期闸已过；LLM 准入拒绝） | 数据 + 上游 | 有第 3 个本地日期含 `llm` block 后：`persome llm agent status` → `persome writer run` → `persome model build --no-wait` → `persome model status`；预算 ≤40 次 | MCP `behavior_patterns().skills[].steps` 非空；artifacts/rules/problems 各 ≥1；每个 evidence 指针 `resolve_evidence` 可解析 | `test-evidence/PHASE5/workflow-face/DIAGNOSIS.md` §6 |
| B2a | 第 3 个有效日期 | **DONE**（11-06 20:34 PST 起 77 个 `llm` block） | 用户 + 数据 | 11-06 要算数：**2026-11-06 23:59 PST（11-07T07:59Z）前**至少 1 个 `llm` block，且命中 11-04/11-05 已出现的候选；错过则 11-07；11-04 约 11-11 17:03 PST 滑出 7 天窗口 | `pattern_detector` 7 天窗口内 ≥3 个本地日期 | 同上 §5 |
| B3 | Face active | OPEN（结构性） | 数据 | 除 3 个 UTC 观察日期外，还需第 2 个 schema 才能产生 `both` provenance：某个非 event 记忆文件累积 ≥4 条事实（`schema_miner_stage.py:30`）。只能继续使用 + `remember`，不可伪造 | `persome faces-report --json-out <scratch>/faces.json` 出现 status=active（≥3 日期、≥2 信号、≥2 footprints） | 同上 §4 |
| B4 | 真实 Chat | OPEN | 用户 | `cd cloud && CLOUD_LLM_MODE=openai CLOUD_LLM_BASE_URL=<url> CLOUD_LLM_API_KEY=<key> CLOUD_LLM_MODEL=<model> CLOUD_PUBLIC_ORIGIN=http://localhost:8787 npm start`；Lens 云端对话页开启 + 登录 → 问一个需要个人上下文的问题；按 `CAP-L2L3-CHECKLIST.md` B6 记录 | 真实模型回答 + 引用的 context id；服务器日志无正文 | 未运行 |
| B5 | 真实订阅周信 | OPEN | 用户 | `CLOUD_MAIL_MODE=smtp CLOUD_MAIL_FROM=… CLOUD_SMTP_HOST/PORT/USER/PASS/SECURE=… CLOUD_EMAIL_PEPPER=<32+ 随机字节>` + 公网 HTTPS origin；发信域配置 SPF/DKIM/DMARC；按清单 B4 | 真实收件箱收到确认信 + 周信；Gmail 一键退订生效 | 未运行 |
| B6 | 真实会议 | OPEN | 用户 | `CLOUD_STT_MODE=soniox CLOUD_SONIOX_API_KEY=<key>`；打包版 Lens 开会议、勾「已告知参会者」、真人说话 ≥60 s；按清单 B1 + B3。注意：B14 的签名构建需要加 `com.apple.security.device.audio-input` entitlement（R5 发现） | 真实转写回到 Lens 并 `import-data` 导入；B10 的「从 Persome 删除…」可删除 | 未运行 |
| B7 | 通知中心 / Tray / 全局快捷键 | OPEN | 用户 | 按 `CAP-L2L3-CHECKLIST.md` Part B · B2 逐步操作（总开关默认关 → 开 → 触发 → 关） | 真实 banner、托盘「提醒」子菜单、快捷键响应；`proactive-decisions.json` 有对应「发/不发」记录 | 未运行 |
| B8 | CAP L2/L3 | OPEN（依赖 B1） | 用户 | 按清单 Part A：CAP-01/02/07/08/09 | TCC 列表只有 Lens（无 Runtime/python）；AX 优先、OCR 兜底；secure input 抑制；心跳；URL/title 元数据 | 清单 Results 表留空待填 |
| B9 | Runtime 版本字段 / T5 | **DONE（本地）**；合入 OPEN | 上游 | 本地分支 `og/r10-version-delete` @ `7066066` 已部署；上游维护者 review 后合入（本轮不 push、不开 PR） | `curl 127.0.0.1:8742/health` 含 `schema_revision`、`build_version`；Lens T5 marker = `schema:…|build:…` | `test-evidence/PHASE5/runtime-r10/`、`docs/upstream/runtime-version-field.md` |
| B10 | Runtime 按条目删除 | **DONE（本地）**；合入 OPEN | 上游 | 同 B9 分支：`POST /imports/delete`、`/memory/entries/delete`、`/timeline/delete`（事务 + bearer + 审计 + 幂等）；Lens 会议「从 Persome 删除…」、连接器删除改走新接口 | 上游 2654 passed；live 404 / 401 探测通过；Lens 测试通过。剩余：导入派生的记忆不级联删除（`runtime-delete-api.md` §4） | 同上、`docs/upstream/runtime-delete-api.md` |
| B11 | OAuth 连接器 | OPEN | 用户 | 在 Google Cloud Console / Notion / Azure 建 OAuth app，提供 client id + redirect `http://127.0.0.1:<port>/callback`；之后 agent 实现 PKCE 流程 | 至少一个真实授权 + 只读导入 | 无代码（不做假登录页，D82） |
| B12 | IMAP 真实邮箱 | OPEN（代码已在） | 用户 | 邮箱开 app password；Lens 连接器 → IMAP：host（993 隐式 TLS）、用户名、app password → 单独 consent → 导入；按清单 B5 | 真实只读导入，记忆可搜到；删除可用 | 代码 `src/main/connectors/imap/`，loopback TLS 测试 PASS |
| B13 | Docker / 公网 TLS | OPEN | 用户（运维） | 域名 A 记录 → 反向代理（Caddy/nginx）+ Let's Encrypt → `docker run` `cloud/` 镜像，设 `CLOUD_PUBLIC_ORIGIN=https://<domain>`、`CLOUD_TRUST_PROXY=1` | `curl https://<domain>/health` 200；Lens 打包版能登录 | 本地 Docker PASS（`PHASE4/docker/`） |
| B14 | 签名 / 公证 / 自动更新 | OPEN | 用户 | 加入 Apple Developer Program → 生成 Developer ID Application 证书 → 提供 `CSC_NAME` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` → `npm run dist`（electron-builder notarize） | `spctl -a -vv "dist/mac-arm64/Persome Lens.app"` → `accepted source=Notarized Developer ID` | 当前 `Signature=adhoc` |
| B15 | C21 新电脑身份迁移 | OPEN（决策） | 用户 | 从 A–F 选一个（见下） | 新电脑恢复后指纹一致或有签名继承链；云账号 / 订阅 / `mine` 备份可延续 | `test-evidence/PHASE4/c21/README.md` §4 |
| B16 | 云账号入口在 Settings | **DONE** | 代码 | Settings →「云端」：地址、登录状态、账号指纹、登录 / 退出 / 删除云账号（main 原生确认）/ 开关云端；复用现有 IPC | 13 个测试（空态 / 未登录 / 已登录 / 删除确认与取消 / 脱敏）通过 | `test-evidence/PHASE5/cloud-settings/` |
| B17 | 测试临时目录泄漏 | **DONE** | 代码 | `tests/_support/tmpdir.ts` 前缀守卫；6 个套件改用；守卫测试 3 个 | 全量前后 `$TMPDIR` 条目 4136 → 4136（修复前 +169）；不删除 tmpdir 本身 | `test-evidence/PHASE5/tmpdir/` |
| B18 | 重新打包 = TCC 再次丢失（B1 的根因会复发） | OPEN | 用户 | 钥匙串访问 → 证书助理 → 创建证书：名称 `Persome Lens Local`，类型「代码签名」，自签 → 告诉 agent 名称；agent 在 `package.json` `build.mac.identity` 填它（不入 repo 任何私钥） | 重新 `npm run dist` 后不重新授权仍 `ax=True`；`codesign -dv` 显示 `Authority=Persome Lens Local` | 当前每次 dist 都换 cdhash |
| B19 | `llm_failed` 无法重试 | OPEN | 上游 | 按 `docs/upstream/timeline-retry.md` 实现 `persome timeline retry-failed --max-calls N [--dry-run]`（CAS 更新、遇预算即停）；capture 文件保留到约 11-11 | 11-04/11-05 的 466 个 failed block 可转为 `llm`（不增加日期，但跨日 app combo 1→21） | `docs/upstream/timeline-retry.md`；失败原因 157/157 = `daily call limit (200/200)` |
| B20 | X3 UI 点击实测 | OPEN（依赖 B1→B2 后再打包） | 用户 | 见 `test-evidence/PHASE4/x3/UI-CHECK.md` | 「估计 + anchors v1」出现；关后回「未启用」；`het.db agent_calls` 新行含 client/model/anchor_version | 真实 transport PASS（5.1/3.0/27.0 分钟） |
| B21 | Lens 与 Runtime 的 OCR 触发规则不一致 | OPEN | 代码 + 上游 | Lens 在 AX 元素文本 ≥64 字符时不附 OCR 图；Runtime 用「有缩进行」判断。改为：Lens 只在 Runtime 实际提取的文本行 < 阈值时跳过，或 Runtime 在 OCR 图缺失时回报原因 | 构造「AX 文本多但无内容行」窗口：仍得到 OCR 或明确原因 | Agent A 审计，`[INFERRED]`，11-06 不受影响 |

## 2026-11-06 23:35 更新

- B1 AX 已恢复（`tccutil reset` 两条旧登记后重新添加）；Screen Recording 仍未生效。
- B2a 已达成：3 个本地日期。B2 现在被 LLM 准入规则挡住：通过日期闸的 5 个候选全是窗口标题 / URL（「uses X often」类），恢复后 9 次自动检测均未写 skill。需要跨 3 日期的 app 序列（继续采集或上游 B19）。详见 `PHASE5/workflow-face/DIAGNOSIS.md` 追加节。

## 顺序（重要）

1. **B1** 先做（用户，今天 23:59 PST 前）。
2. **不要**在拿到第 3 个日期前 `npm run dist` / `e2e:packaged`：会重签、再丢 TCC（B18）。
3. 第 3 个日期出现 → **B2**（agent 跑 build，≤40 次 LLM）。
4. 然后 B18（若用户已建证书）→ 重新打包 → 重新授权一次 → **B20**、B7、B8 一并做。
5. B3 只能等第 2 个 schema；不设截止。

## B15 选项（不替你决定）

| | 方案 | 代价 |
|---|---|---|
| A | 不迁移：新电脑 = 新身份，备份恢复为 `imp-*` 副本 | 旧云账号 / 订阅者 / 朋友信任全部断开 |
| B | 迁移助理 / Time Machine 整机恢复（含登录钥匙串） | ad-hoc 签名下钥匙串 ACL 绑定 cdhash，可能拒绝；未测试 |
| C | 单独的「导出身份密钥」加密文件（scrypt + AES-256-GCM），新电脑导入 | 私钥离开钥匙串；口令强度即全部安全；需 UI + 安全审查 |
| D | 旧密钥签「新指纹继承我」 | 需要旧机器在场；所有验证方都要学会继承链 |
| E | 纸质 / QR 恢复短语 | 误用风险最高 |
| F | iCloud 钥匙串同步 | 需要 Developer ID（B14），Apple 账号失守 = 身份失守 |

推荐 `[INFERRED, MED]`：现在 **A**（不改代码，风险最低）；B14 落地后评估 **C + D**（导出文件做恢复、继承链做信任迁移）。等你选。

## 自检

- 无 owner 的项：0。无可执行动作的项：0。无验收的项：0。
- DONE：B9（本地）、B10（本地）、B16、B17。其余 OPEN 都有具体命令。
