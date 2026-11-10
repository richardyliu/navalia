# GAP vs S1-R5（Round 4：X3 + 真实验收）

日期：2026-11-06。批准边界：`DECISIONS-ROUND4.md`。证据根目录：`docs/test-evidence/PHASE4/`。

## 1. 总表

| ID | 项 | before（S1-FULL） | after（Round 4） | 状态 | 证据 |
|---|---|---|---|---|---|
| X3-01..03 | HET 真实 transport + gate + UI | 无 transport，0 分钟 | `agentFundingTransport.ts`（Runtime python → `agent_cli.complete`）；默认关；budget probe；AssessorPanel；het.db v2 记录 client/model/anchor_version | DONE | `HET-X3.md`、`tests/het/agentFundingTransport.test.ts`（27） |
| X3-04 | 真实估计分钟 | 无 | 在真实 het.db 副本上做了 3 次真实调用 → 5.1 / 3.0 / 27.0 分钟（估计，anchor v1，claude-code）；关闭开关后 0 次调用 | PASS（打包版已重建；UI 点击待用户操作） | `PHASE4/x3/` |
| S1-R5-01 | 第一个真实结构化 Workflow | skills=0 | 跑了一次真实 `persome model build`（1 次 LLM 调用）；skills 仍为 0。根因：7 天窗口内可用的 timeline block 只覆盖 2 个日期（11-04/05 大多 `llm_failed`，当时 200/200 额度耗尽；11-06 全是 `metadata_only`），过不了 ≥3 日期门槛。Cloud 抽取 fallback：没有 `CLOUD_LLM_*` | **BLOCKED（数据不足）** | `PHASE4/workflow/` |
| S1-R5-02 | 真实 Face / 3 天 | faces=0 | 1 个 shadow 候选：观察 1 次，1 个日期（11-06）；晋升门槛 5 项中 4 项不满足。Lens 的「稳定习惯 / 观察中 / 日期未知」标签逻辑有代码和测试覆盖 | **数据不足** | `PHASE4/face/` |
| S1-R5-03 | 证据链空缺 | 45/49 Points、107/187 Lines | 按 `/model/graph` 重新统计：Points 88/96、Lines 110/110 有来源；`remember` Point 改为显示「来源=本条记忆」；其余 4 个 Point、138 条 shadow 边记为 limitation（不伪造） | PASS | `PHASE4/evidence-chain/`、`tests/evidence/r5-remember-self-source.test.ts` |
| S1-R5-04 | 真实 Chat | mock | 没有 `CLOUD_LLM_*`；打包版只接受 `https://` 云地址 | BLOCKED | `PHASE4/cloud/` |
| S1-R5-05 | 真实订阅 / SMTP | mock | 没有 SMTP relay / DKIM / `CLOUD_EMAIL_PEPPER` | BLOCKED | `PHASE4/cloud/` |
| S1-R5-06 | 真实会议 | fake STT | 没有 `CLOUD_SONIOX_API_KEY`，也没有人在麦克风前；另外签名构建还缺 `com.apple.security.device.audio-input` entitlement | BLOCKED | `PHASE4/cloud/`、`PHASE4/packaging/` |
| S1-R5-07 | 通知中心 / Tray / 快捷键 / CAP TCC | 未验证 | 需要人在 GUI 前操作；人工清单已写；TCC.db 无 Full Disk Access 读不到。T5：`/status.version` 是包版本 0.3.2，跨部署不变 → 上游 note | BLOCKED（T5 = 上游 FAIL） | `PHASE4/os-cap/`、`docs/upstream/runtime-version-field.md` |
| P4 | Runtime 按条目删除 | 无接口 | 上游提案：`POST /imports/delete`、`/memory/entries/delete`、`/timeline/delete` | 上游 BLOCKED | `docs/upstream/runtime-delete-api.md` |
| P4 | OAuth（Google/Notion/Outlook） | 无 | 没有 client id，也未批准；UI 四处写明不支持 OAuth | BLOCKED | `PHASE4/connectors/` |
| P4 | IMAP 真实邮箱 | 未验证 | 代码只有 `tls.connect`（993，TLS1.2+，校验证书，无 STARTTLS / 明文路径）；22/22 测试通过；没有真实邮箱凭据 | 代码 PASS / 真实 BLOCKED | `PHASE4/connectors/` |
| P4 | Docker / TLS | 未构建 | 镜像构建通过；本地容器 `/health` 200；登录→chat(mock)→删账号往返通过；容器已清理。TLS / 反向代理 / 多进程限流 / 备份由运维负责 | Docker PASS / 部署 BLOCKED | `PHASE4/docker/` |
| P4 | 打包 / 签名 / 公证 / 更新 | 未查 | 静态检查通过（麦克风 usage、native 在 asar 外、fuses 一致）。现为 ad hoc 签名，`spctl` 拒绝。没有 Developer ID | 签名 BLOCKED | `PHASE4/packaging/` |
| P4 | `e2e:packaged` | — | 用户同意后重新打包（ad hoc，未签名）：**30 PASS / 0 FAIL / 1 SKIP**。旧断言「Info.plist 不得有 NSMicrophoneUsageDescription」已过时（S1-FULL 已批准会议录音），改为「必须存在，且文案限定为会议录音」。新 app 已启动，het.db 迁移到 v2，评估器默认关 | PASS | `PHASE4/packaging/e2e-packaged.log` |
| P4 | C21 新电脑 | 未定 | 私钥不进备份（48/48）；新身份恢复只得到 `imp-*`；迁移方案 A–F 待定；旧云账号绑定旧 key | 测试 PASS / 决策待定 | `PHASE4/c21/` |
| P4 | 清理 | 136（实为 13） | 删除 39 个 `lens-upstream-*`（测试运行期间又新生成了一些），用前缀 + 父目录守卫。约 3000 个其他 `lens-*` 测试残留没有动 | PASS | `PHASE4/cleanup/` |
| P4 | 文档 | ARCH 403 过时 | ARCH 实际已是 404，GAP 中的说法已更正。删除云账号的入口只在 Chat 页；Settings 建议见笔记 | PASS | `PHASE4/settings-cloud-account.md` |

## 2. 验证

- `npm run typecheck`：exit 0
- `npx vitest run`：196 文件通过 / 5 跳过；**2072 passed / 7 skipped / 0 failed**（基线 2042/7）
- `npm run build`：exit 0
- `npm run e2e`：**41 PASS / 1 SKIP**
- `cd cloud && npm test`：118/118
- LLM 用量（Runtime usage 账本）：Phase 2 用 1 次；X3 用 3 次；期间 daemon 自己用了约 1 次。用量从 7 涨到 12。

## 3. 待用户决定

1. ~~重新打包~~（已完成）。还剩：在 HET 页实际点击「允许评估」做 UI 实测；新 bundle 的屏幕录制 / 辅助功能可能需要重新授权。
2. ~~daily_call_limit~~：用户确认 20000 有效（R4-1a）。
3. C21 密钥迁移方案 A–F。
4. 是否把 `runtime-version-field.md` / `runtime-delete-api.md` 提交给上游。
5. 提供 `CLOUD_LLM_*` / SMTP+DKIM / Soniox key 以及公网 TLS 域名，用于云端真实验收。
6. 测试临时目录泄漏（`tests/connectors/upstream.ts`、`tests/peers/fixtures.ts` 不做清理）是否修复。
7. Workflow / Face：需要 ≥3 个日期带文本的有效采集。前提是 daily_call_limit 不再提前耗尽，且 11-06 这类 `metadata_only` 采集要带上文本。
