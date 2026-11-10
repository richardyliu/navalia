# Decisions — OG round（OG-00，2026-11-05）

来源：X1–X6 来自 `DECISIONS.md`，X1–X10 的当前值以 `DECISIONS-ROUND2.md` 为准。OG-D1..D7 是本轮新增项。
规则不变：用户没拍板之前，代码只按“默认值”执行，不越界；默认值是本地运行、无账号、无云，Lens 自己不调用 LLM。
**后果**一列写的是：按默认值走，§15 哪些测试拿不到 PASS。

## 1. 沿用 X1–X10

| # | 问题（问用户） | 状态 | 当前默认值 | 对 OG 的后果 |
|---|---|---|---|---|
| X1 | 要不要引入服务端（自建或第三方）？身份由谁担保？ | 待拍板 | 不接服务端、账号、遥测和公网请求，只交换本地文件（`.persomecard` / `.lensskill` / 备份目录） | INT-01..06、ID-02 永远 BLOCKED；Chat / Meetings / Check-ins 送达 / 云同步做不了 |
| X2 | 共享文件夹能不能作为正式的订阅载体？要不要后台定时扫描？ | 待拍板 | 本地订阅文件夹，默认关闭，手动刷新，验签后导入（D38） | Peers 订阅只到 L0；跟原版的云订阅在机制上不同 |
| X3 | 要不要授权真实的 LLM transport（预算、模型、数据出境范围）？HET 是否保留一级导航？ | 待拍板 | assessor 关闭，不注入 transport，真实使用中是 0 分钟、「未测量」（D22） | HET-02/04 只在 fixture 上 PASS，真实数据从来不出分钟数；“HET 计量”这一环在实际使用中没有闭合 |
| X4 | Performance 指什么，谁能看？ | 待拍板 | 不定义，也不实现（`PERFORMANCE.md`） | 不影响 §15（§15 没有 Performance 测试） |
| X5 | 导入后能不能默认自动构建？ | 待拍板 | `--no-build`；开关默认关，打开要二次确认（D39） | 不影响 §15 |
| X6 | 要不要向上游提议把习惯阈值改成 3 个日期？ | 待拍板 | 不改 Runtime；Lens 显示「观察中」（D24） | MOD-04 预计 FAIL（Runtime ≥2 次就准入）[INFERRED] |
| X7 | 要不要让 Lens 内置 LLM adapter？ | 待拍板 | Lens 不调 LLM；Workflow 由外部 Agent 抽取（D37） | 原版的 `library_preview`（首启资料库预览是一次有依据的模型调用）做不了 → First-run 停在 L0 |
| X8 | 备份要不要提供“包含 Access log”的选项？ | 待拍板 | 不包含 `audit.db` / `grants.json` / 私钥 | PRIV-06 只覆盖了一部分 |
| X9 | 主动层（菜单栏 / 通知 / 快捷键 / 定时 brief） | 待拍板，**OG-D5 细化** | 不做 | VIS-05、VIS-09 TODO |
| X10 | 上游备注（MOD-07 等）要不要提交到 personal-model？ | 待拍板 | 只放在 `docs/upstream/` | MOD-07 FAIL 一直留着（Runtime 是上游代码，Lens 只读） |

## 2. OG 新增决策

| # | 问题（问用户） | 默认值（拍板前） | 后果 |
|---|---|---|---|
| OG-D1 云 / 账号 | 为了贴近 OG，要不要实现登录（Google / Apple / 邀请码）和云端 Chat / Meetings / Check-ins？要的话，服务端是谁？ | **不引入，标 BLOCKED。** 不做假登录页，不做“看起来能登录”的空壳；Card 的 claim 继续用本地创建（D3） | INT-01..06、ID-02、PRIV-10 是 BLOCKED，不算 FAIL，也不算 PASS。OG 覆盖率上限少 7 个 ID |
| OG-D2 HET 真实 transport | 能不能给 HET 配一个真实的 assessor transport（哪个模型、每日预算、发出去的是摘要还是原文）？ | **继续受 X3 约束。** 没有 transport 就是 0 分钟、「未测量」。**不用 fixture / 估算 / 运行时长填数字，不做“假分钟”。** fixture transport 只在未打包的 E2E 里用，并且标明「测试 fixture」 | HET-02/04 停在 fixture 级证据；HET-09 能守住（不拿运行时长冒充）；真实 HET 数字一直为空 |
| OG-D3 签名 / 公证 | 有没有 Apple Developer ID（Team ID）可以用来签名和 notarize？ | **没有，所以 BLOCKED。** 保持 ad-hoc（`mac.identity: null`），README 继续写 “blocked”。**不把 ad-hoc 说成“已签名”，不在任何文档里写 notarized** | CAP-01 第 2 部分只能用 ad-hoc 包测，每次重建可能都要重新授权；下载的 DMG 会被 Gatekeeper 拦；更新链路（OG-D4）没法做签名校验 |
| OG-D4 更新 | 要更新吗？如果要，只做“检查 + 通知”还是自动安装？发布源（`RELEASES.json`）放在哪里？ | **只检查、只通知，不下载、不安装。** 目前没有 `RELEASES.json`，也没有发布源，所以整个功能 **BLOCKED**：不加轮询代码，不发请求 | VIS-10（更新部分）TODO / BLOCKED；原版的 6h 轮询、Setup.app、回滚都不做。**2026-11-05 OG-09：仍 BLOCKED。** Settings「更新」显示当前版本，「检查更新」只返回 BLOCKED（无发布源 `RELEASES.json` / 未签名），`src/main/privacy/updates.ts` 不导入任何网络模块、不发请求、不设定时器（`tests/privacy/updates.test.ts` 静态 + 运行时断言） |
| OG-D5 菜单栏 / Quick Box | 允许 Lens 常驻菜单栏、注册全局快捷键、打开 Quick Box 输入框吗？允许发本机通知吗？ | **只在本地运行，需要用户主动开启（默认关）。** 开启后：菜单栏显示状态和入口；快捷键唤起 Quick Box；Quick Box 只把输入交给已有的本地查询，Lens 不调 LLM（X7）。**通知默认关闭**，主动推送只在“有足够 context”时提出，否则不出声；不联网 | 拍板前 VIS-05 / VIS-09 TODO。开启后才有机会到 L1；“主动推送”到不了 L2（原版是 [D] 叙事，没有可测契约） |
| OG-D6 Rewind | 允许 Lens 显示截图历史吗？截图解密只能在 main 进程做，能接受吗？ | **只在 main 进程解密**（`PERSOME_SCREENSHOT_KEY` 从 `<root>/env` 读取，不进 renderer，不写日志，不进 IPC 返回值；renderer 只拿解好的图像数据）。**没有 key 就 BLOCKED**，显示「无法解密：缺少 PERSOME_SCREENSHOT_KEY」，不显示占位图，不说“无截图” | VIS-04 只有在 key 存在、并且有 Screen Recording 授权时才能 PASS；CAP-03 要一起测（无明文、key 0600） |
| OG-D6b Rewind 明文旧帧 | 未加密的旧截图帧要不要显示？目前 Rewind 页拒绝（`plaintext_refused`），但 Broker 工具 `view_rewind_screenshot` 仍会返回明文帧，两条路径不一致 | **Rewind 页拒绝显示明文帧（已实现）。** 建议 Broker 也改为拒绝，以对齐 CAP-03 静态加密；拍板前 Broker 保持现状 | 不统一则 CAP-03 无法判 PASS：agent 仍可经 Broker 读到明文帧。**2026-11-05 已按默认执行**：Broker reader 与 `view_rewind_screenshot` 均拒绝明文帧（`plaintext_refused`）；本机 0/2376 帧为明文，无数据损失；可回滚 |
| OG-D7 Recovery | 数据或 Runtime 出故障时，Lens 能自动做哪些恢复？哪些操作必须让用户确认？ | **默认不做任何破坏性操作。** 自动只做：诊断、重启 Runtime、重试 health 检查、只读导出诊断。破坏性操作（删除或重建索引、清 buffer、重置身份、回滚数据）要求**两次确认**：main 进程弹对话框，默认按钮是取消，再加一次输入字面量确认（沿用安全 #9 的模式）；执行前先做备份（S2-02） | VIS-10（恢复部分）拍板前 TODO；实现后可以测“模拟失败 → 可恢复，不丢数据” |

**OG-D7b Recovery 重建采集索引（2026-11-05 追加）**：Recovery 页唯一实现的破坏性动作是调用 Runtime 自带 CLI `persome rebuild-captures-index --merge`（单事务、merge 保留旧行、Runtime 运行中会拒绝执行），流程为停止 → 重建 → 启动，前置 main 签发 60 秒一次性 nonce + 用户输入「重建采集索引」。Lens 自身不打开 index.db；写入由 Runtime CLI 完成，符合“只经 ingest/MCP/CLI/REST”约束。**问题**：是否允许 Lens 触发任何 Runtime 索引写入？**默认**：允许（仅此一项，二次确认）。**若否**：移除该动作，改列「需手动执行」。非 merge 全量重建、清 buffer、重置 Lens Store 仍只给手动步骤。

## 3. 需要用户先回答的（按对 OG L2/L3 的影响排序）

1. **CAP 人工授权（不是决策，是动作）**：按 `docs/test-evidence/REPORT.md` 的 “CAP L2/L3” 步骤跑一次。不跑，采集的 L2/L3 一直为空。
2. **X10**：要不要把 MOD-07 提交给上游？MOD-07/08 的 L3 卡在上游。
3. **OG-D2 / X3**：HET 真实 transport。
4. **OG-D3**：Developer ID。
5. **OG-D5 / OG-D6 / OG-D7**：主窗口形态（菜单栏、Quick Box、Rewind、Recovery）。
6. **OG-D1 / X1**：云。不引入就接受 7 个 ID 永久 BLOCKED。

## 4. 用户已拍板（2026-11-05）
- **上游路线 A**：在 personal-model 独立 worktree 修上游缺陷。集成分支 `og/upstream-fixes`（`~/Documents/GitHub/personal-model-og`），子分支 `og/r1`、`og/r4`、`og/r5`（`personal-model-og-r1/-r4/-r5`），均从 `b7a28ff` 起。主 checkout、`~/.local/bin/persome`、真实 `~/.persome` 不动；不 push、不开 PR、不部署——三者各需用户单独批准。
- **MOD-11**：owner 别名必须用户显式确认（UI/CLI）后才激活；屏幕自述不算。
- **MOD-13**：UI 必须显示 reference 的字面降级原因码（与中文解释并列）。
- **迁移**：R1 等 schema 迁移只在临时 root 上执行；真实 index.db 不迁移，部署另行决定（先备份）。
- **R2 语义（2026-11-05 用户拍板）**：`[memory_delta] relation_conflict_policy` 默认 `supersede`（旧 Point 转为历史版本，不删除；`flag`/`off` 可配）；CLI `persome as-of` 保持双时态（写入于 T 且在 T 有效），REST `/model/evidence` 与 `entity_graph` 用有效时间；冲突匹配保持整词匹配（不用谓词表、不用 LLM）；观测时间取窗口结束、`verify_fact` 值分组等 R2 其余默认值接受。
- **R3 语义（2026-11-05 用户拍板）**：owner 别名确认仅限用户（REST/Lens UI、CLI、`persome correct`）；MCP agent 的 confirm 与 `correct_memory merge_into_self`（source=agent）不得激活别名；升级时已 active 但不足 3 日期的 Face 保持 active，仅新晋升适用 3 日期门槛；MEM-05 默认 search 同时排除 `schema-*` 与 `skills/skill-*.md`（可经 paths 显式 opt-in）。
- **事故记录**：R4 回滚测试与 R6 在真实 HOME 下的全量套件运行可能以连接方式打开过真实 `~/.persome/index.db`。只读核查（2026-11-05 13:47）：`quick_check=ok`，`schema_revision=2026-08-11.4`，schema 指纹与已安装 0.3.2 计算值一致，无 R1/R3 新表/列。数据行“零写入”无法证明（daemon 持续写入）。上游测试隔离缺陷见 `docs/upstream/TEST-ISOLATION.md`。
