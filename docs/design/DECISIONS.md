# Decisions — S1 round（2026-11-05）

需要用户拍板的事项。Lens 在拍板前一律按“本地替代方案”执行，不静默实现云/账号能力。

| # | 问题 | S1 文章要什么 | 本地替代（当前实现） | 需要用户决定 |
|---|---|---|---|---|
| X1 | 云 / 账号 | 朋友卡片订阅、每周信送达、分享链接都隐含账号与服务端 | 只做本地文件交换：`.persomecard` / `.lensskill` 导入导出；周信只生成草稿、复制或导出，不发送 | 是否引入任何服务端（自建 / 第三方），以及身份如何担保（当前卡片是自签名，见 DEVIATIONS D3a） |
| X2 | 订阅（Shared moments） | 订阅朋友的更新 | 标 `unsupported`；可选：监视一个用户指定的本地/同步文件夹（iCloud Drive 等由用户自己选），仍不发网络请求 | 是否接受“共享文件夹”作为订阅载体 |
| X3 | HET 定位 | S1 文章里 HET 不是核心；它属于 S2/DMG 的可计量目标 | 默认 assessor 关闭，0 分钟不计入，页面明确写“未启用”；保留 transport 注入点 | HET 是否保留为一级导航；是否授权一个真实 LLM transport（预算、模型、数据出境范围） |
| X4 | Performance 定义 | 文章没有给 Performance 的定义 | 不定义；HET 只报告“已评估的任务的等效人工分钟”，不报告效率/绩效 | Performance 指什么（时间？产出？质量？），以及谁能看 |
| X5 | 导入后构建 | 导入历史后自动整理成记忆与模型 | `import-data` 默认 `--no-build`；构建需要用户再确认一次（会消耗 Runtime 的 LLM 预算） | 是否允许导入后自动构建 |
| X6 | 习惯阈值 | ≥3 个不同日期 | Runtime 准入 ≥2 次独立观察（上游行为，不改）；Lens 侧把未满 3 个日期的标为“观察中” | 是否向上游提议把阈值改为 3 个不同日期 |

## S1-FULL（2026-11-05）

| # | 决定 | 含义 |
|---|---|---|
| S1F-1 | **opt-in 云（由 S1-FULL brief 授权；推翻 R2 X1/X2/X7 与 R3 X1 中「不上云」的部分）** | 新增自建服务 `cloud/`，设备 Ed25519 密钥 challenge 登录（无密码 / 无邮箱注册，account_id = 公钥指纹）。所有云功能默认关闭、逐项开启；本地模式零公网请求。永不出机：截图、Runtime `index.db`、私钥、Runtime token。Chat 只发用户预览过的 context bundle；Meetings 只发 30 s 音频分片；周信邮件订阅与本地文件夹订阅（D38）并存；卡片服务器只转发，客户端离线验签。服务器日志只含 req_id/method/route/status/ms。详见 `docs/design/S1-FULL-ARCH.md`。 |
| S1F-2 | **拒绝小阶 / 非规范 Ed25519 公钥** | 实测（Node 24 / OpenSSL）：公钥为单位点时，签名 `R=单位点, S=0` 对任意消息验签通过（256/256）；8 个小阶点全部可伪造（成功率约 1/阶）。`cloud/src/auth.ts` `isWeakPublicKey` 在 challenge 阶段返回 400 `invalid_public_key`；测试 `cloud/test/auth.test.ts`。 |
| S1F-3 | **`cloud/` 允许 `nodemailer` 10.2.1（精确锁定，无传递依赖）** | 自写 SMTP（STARTTLS / AUTH / dot-stuffing / 头注入 / MIME UTF-8）风险高于引入标准库；仅 `cloud/`，Electron 侧无新依赖。 |
| S1F-4 | **`smtp` 模式必须配置 `CLOUD_EMAIL_PEPPER`** | 退订后只留 `HMAC(pepper, email)`；pepper 若存在同一 DB，DB 泄露即可暴力还原邮箱。dev（outbox / 关闭）模式仍允许 DB 生成的 pepper。 |
| S1F-5 | **C11（周信加入“共同经历”）推迟到 Phase 4 与 C18 一起做** | C18 的 shared-moments 对象尚不存在；提前做只会退化成字面重合，违反 brief。 |
| S1F-6 | **麦克风只用于 opt-in 会议（推翻 PRIV-10「无麦克风」）** | 唯一入口 `components/meetings/recorder.ts`（`getUserMedia({audio:true, video:false})`）。主进程 mic gate：仅 `media` + 仅 audio + 仅 app 文档 + 已 consent（勾选 + native confirm）+ 录音中（3 h TTL）；其余一律拒绝。`package.json` 只有一条 Lens 自己的 `NSMicrophoneUsageDescription`；after-pack 不再删除它，仍删除摄像头 / 系统音频采集 / 蓝牙。守卫测试改为「只有 recorder 能碰麦克风」而非删除：`tests/privacy/no-mic.test.ts`、`tests/capture/og02-capture.test.ts`、`tests/shell/og-round-2026-11-05.test.ts`。 |
| S1F-7 | **共同经历 = 双方签名对象，不做推断** | 一方提议并签名，另一方对规范 JSON 的 sha256 签名接受；服务器只转发，客户端每次读取都离线验两个签名；任一方删除即双方消失；`visibility:"letters"` 由双方签名覆盖，只有它能进周信。D31 字面重合降级为「关键词重合（未核实，不是共同经历）」，不再进任何信。第三方 accept/decline 返回 404（不泄露存在）。 |
| S1F-8 | **Workflow 云端抽取的来源写在 `provenance.extraction.source = "cloud_extracted"`** | 不新增 ProvenanceKind：新 kind 会被 Library 归为「来自观察」，属于冒充来源。分享 `.lensskill` 时去掉 `cited_items` / `session`。上游 `behavior_patterns().skills` 当前为空（2026-11-06），故真实 steps 只来自云端抽取。 |
| S1F-9 | **表现（C16）只做 B + C，不做 A** | 计数 = 点开即可看到的同一行列表；来源未接入显示「未知 / 未接入」而非 0；`transcript_commit` 是 transcript 里的 `git commit` 调用，不保证已提交。项目只显示活动，不算完成度、不预测日期。仅本机可见。 |
| S1F-10 | **主动层（C17）默认全关，上下文不足就沉默** | 事件触发：会议转写完成、**我提议的**共同经历被对方接受（在 sync 中首次看到时发布，不在我接受别人时发布）。每次决定（触发/沉默+原因）写入本机日志，通知默认不带正文。 |
| S1F-11 | **备份按原 id 恢复 Workflow，只对「本人身份签名的 manifest」开放（C21 修订，lead 决定）** | 导出时用 Lens 身份密钥对 manifest（含每个文件的 sha256）签名：`persome-lens-backup-v1\n` + canonical JSON，存为 `manifest.sig.json`（加密包内为第二个条目）。恢复时 `evaluateTrust` → `mine`（当前身份或 `previousIdentities()`）/ `foreign` / `unsigned` / `invalid`。`mine` → 按原 id 逐字节恢复全部版本（本机更新的不覆盖，分叉另存 `imp-*` 副本，Runtime 正在观察且 v1 不同的 id 也另存副本）；`foreign` / `unsigned` → 仍走 D36 / S1-R3-SEC L4（重新编号的副本，含全部历史）；签名存在但验不过 → 整份拒绝、不写任何东西。加密不代表作者身份。**后果**：私钥不进备份，新电脑（新身份）上恢复只能得到副本。见 `s1full-log/C20-C21.md` §3 / §6、DEVIATIONS D84。 |
| S1F-12 | **IMAP 连接器：只读、只走隐式 TLS（993）、只用应用专用密码；OAuth 连接器 BLOCKED（C19）** | 不支持 STARTTLS / 143 / 明文；`rejectUnauthorized: true`、TLS ≥ 1.2、SNI；只发 7 种只读命令（EXAMINE 不用 SELECT）；凭据用 safeStorage SecretBox 加密，不可用时拒绝保存；必须先单独 consent，撤销即删凭据。这是 Lens 第一处连向非 loopback 地址的出站连接（用户自己填写的主机），代码限定在 `src/main/connectors/imap/**`，有静态测试。Google / Notion / Outlook 等 OAuth 连接器没有 client id，BLOCKED。见 `s1full-log/C19.md`、DEVIATIONS D80–D82。 |
| S1F-13 | **导入时工具调用摘要默认打开（C20）** | 推翻 S1-R3-06 的「默认关」：保留工具名、命令首行、写入 / 编辑的文件路径（家目录写作 `~`，Runtime / Lens 数据目录路径移除，token / 邮箱打码），从不导入工具输出；每次导入可关闭。代价：脱敏漏掉的内容现在默认会被导入。见 `s1full-log/C20-C21.md`、DEVIATIONS D83。 |
| S1F-14 | **X3（HET transport）仍未批准** | HET 仍是 `disabledTransport`、0 分钟、「未测量」；`src/main/het` 与 `src/main/cloud` 互不 import（`tests/het/c23-transport.test.ts`）。批准需要用户回答 5 件事：预算与耗尽行为；供应商 / 模型（按 anchor 版本钉住，温度 0）；出机文本范围与对方保留条款（建议逐条预览）；是否复用云端 `/v1/chat/completions` 加 `task:"het_assess"`；分钟以「估计」+ anchor 版本显示、不当作评分。见 `s1full-log/C23.md` Task 2。 |
| S1F-15 | **C22 部署 / 复测由用户于 2026-11-06 批准并完成** | 上游 `og/upstream-fixes` HEAD = `462361d` = `deploy/2026-11-05-r1r9`，本轮没有新的上游提交，未 fetch / push；先做备份 `/Users/ryl/Persome Backups/20261106-101058-pre-c22`（`shasum -c` 0 失败）；schema `2026-11-05.3` 无需迁移；Runtime 重启后 `/health ok`；部署后 venv 上 §15 复测 63/63。见 `docs/test-evidence/S1FULL-C22/summary.md`。 |
