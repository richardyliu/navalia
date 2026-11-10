# Persome Lens — 本地可视化壳设计文档

> 版本：v1.0 Draft
> 日期：2026-11-04
> 目标：一个**不需要登录、不依赖官方云端** 的本地 Electron 应用，直接读取开源 Runtime（`personal-model`）的本地数据，做模型总览、证据回溯、人物/项目视图。
> 状态：设计评审中，未开始实现。

---

## 1. 背景

开源 Runtime（`~/Documents/GitHub/personal-model`，v0.3.2）已经具备完整能力：

```
AX/OCR 采集 → 1 分钟时间线 → 5 分钟会话归约 → 证据门控记忆
      → Point/Line/Face/Volume/Root → SQLite + HUMAN.md
      → 本地 REST /model 查看器 + MCP 21 tools
```

但它只有两种“界面”：

1. **命令行**（`persome` 的 40+ 个子命令）；
2. **官方 Web 查看器**（`persome model open` 打开的 `/model` 页面）。

官方查看器是完整的，但它是 runtime 的一部分：启动依赖 daemon、浏览器短时 capability、不可定制。产品版 DMG 的 Electron 壳又要求登录官方云端。

所以这里要补的是：**一个独立的、只读的、本地优先的桌面查看器**，把 Runtime 的数据以更清晰的方式呈现出来，并且给后续功能（搜索、纠正、导出）留出扩展位。

---

## 2. 目标与非目标

### 2.1 目标（v1）

| # | 目标 | 验收 |
|---|---|---|
| G1 | 不需要任何账号/登录/云 key | 断网、无官方云端账号也能启动并显示数据 |
| G2 | 自动发现本地 Runtime | 读取 `~/.persome`，探测 `127.0.0.1:8742`，显示健康状态 |
| G3 | 模型总览 | Root 叙事、Face/Volume 列表、Point 计数、构建状态 |
| G4 | 证据回溯 | 点任意 Root/Face/Point，看到 quote、来源应用/窗口/URL、receipt 状态 |
| G5 | 关系浏览 | 点一个 Point，看到它的关系树与原始 receipts |
| G6 | 空态与降级 | 未安装/未启动/未建模/权限不足都有明确说明与下一步 |
| G7 | 可打包 | `npm run dist` 产出可双击运行的 DMG |
| G8 | 安全 | token 不进渲染层、无远程内容、无遥测 |

### 2.2 非目标（v1）

- ❌ 不做登录、账号、云同步、好友卡片、周报、会议转写。
- ❌ 不做写入（纠正/删除/导入），v1 只读；写入放到 v1.2。
- ❌ **不做 HET**：`het/` 只存在于产品版私有分支，开源 Runtime 没有这个模块。若以后要做，需要自己从 Point/时间线重新计算，属于独立项目。
- ❌ 不内嵌官方 `/model` 查看器（见 §4.2），但提供“打开官方查看器”按钮。
- ❌ 不做移动端、Windows、Linux（Runtime 本身 macOS-only）。

---

## 3. 用户与场景

| 用户 | 场景 | 关键动作 |
|---|---|---|
| 开发者（已装 Runtime） | “我想看看它到底记住了什么” | 打开 App → 总览 → 点 Root → 看证据 |
| 隐私敏感用户 | “我不想登录，也不想数据上云” | 全程本地，无网络请求 |
| 研究者/评估者 | “我要检查一条结论是否可靠” | 搜索/定位 → 证据链 → 原文与 receipt |
| 未来的自己 | “上个月我对这个项目的判断是什么” | （v1.2）as-of 时间旅行 |

---

## 4. 方案总览

### 4.1 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Persome Lens (Electron)                                     │
│                                                              │
│  ┌────────────────────┐        ┌───────────────────────────┐ │
│  │ Renderer (React)   │◄─IPC──►│ Main process              │ │
│  │  Overview          │        │  - RuntimeClient (HTTP)   │ │
│  │  Model             │        │  - token reader           │ │
│  │  Evidence          │        │  - supervisor (start)     │ │
│  │  Settings          │        │  - IPC whitelist          │ │
│  └────────────────────┘        └────────────┬──────────────┘ │
└─────────────────────────────────────────────┼────────────────┘
                                              │ HTTP 127.0.0.1:8742
                                              │ Bearer PERSOME_LOCAL_API_TOKEN
                                   ┌──────────▼──────────┐
                                   │ Persome Runtime     │
                                   │ FastAPI + SQLite    │
                                   │ 21 MCP tools        │
                                   └─────────────────────┘
```

- **Main process 是唯一能读 token、发 HTTP 的地方。**
- Renderer 只通过 preload 暴露的窄接口拿数据，永远看不到 token。
- 默认**不启动** Runtime（避免偷偷开始录屏）；只在用户点“启动 Runtime”时执行 `persome start`。

### 4.2 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据通道 | **HTTP REST** | `/model/graph`、`/model/evidence`、`/status` 已是稳定 JSON；无需 MCP 协议栈 |
| 是否内嵌官方 `/model` | **否，自建 UI + “打开官方查看器”按钮** | 官方页面依赖 capability cookie 和 daemon，难以嵌入；自建可控、可扩展 |
| 启动 Runtime | **默认只连接，不自动启动** | 启动意味着开始采集屏幕；必须是显式动作 |
| v1 读写 | **只读** | 先把“看”做好；build/correct/删除都放到 v1.1+，v1 只显示命令 |
| 搜索 | **v1.1 通过 MCP stdio** | 公开 REST 没有 search 路由；MCP 的 `search` 是唯一稳定入口 |
| 端口 | 优先 `8742`，其次读 `config.toml [mcp].port` | Runtime 默认端口；产品版用 8823，不会冲突 |
| 数据根 | `PERSOME_ROOT` > `~/.persome` | 与 Runtime 一致，支持 dev 隔离 |
| 渲染技术 | React + TypeScript + CSS Modules | 体量小、无重型 UI 库；图表用 SVG |

---

## 5. Runtime 集成

### 5.1 发现顺序

```
1. process.env.PERSOME_ROOT
2. ~/.persome
```

校验：

- 目录存在且属主是当前用户；
- `<root>/env` 存在、权限 0600、不是符号链接；
- 能解析出 `PERSOME_LOCAL_API_TOKEN`；
- 端口可用：先读 `<root>/config.toml` 的 `[mcp].port`，读不到用 8742。

### 5.2 Token

```ts
// electron/runtime/token.ts
export function readLocalToken(root: string): string {
  const envPath = path.join(root, 'env');
  const st = fs.lstatSync(envPath);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('env file is not a regular file');
  if ((st.mode & 0o077) !== 0) throw new Error('env file permissions are too open');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^PERSOME_LOCAL_API_TOKEN=(.+)$/m);
  if (!m) throw new Error('PERSOME_LOCAL_API_TOKEN missing');
  return m[1].trim();
}
```

规则：

- 只存在主进程内存；
- 不写日志、不进 IPC 返回值、不进崩溃上报；
- 重新读取只在启动或 token 失效（401）时发生。

### 5.3 生命周期

| 状态 | 判定 | UI |
|---|---|---|
| `not_installed` | 找不到 `<root>` 或 `persome` 可执行文件 | 显示安装指引 |
| `stopped` | `/health` 连接被拒 | “启动 Runtime”按钮 |
| `running` | `/health` 200 + `/status` 200 | 正常 |
| `unauthorized` | `/status` 401 | “token 无效，重新生成” |
| `version_mismatch` | `/status.version` 不在支持范围 | 提示升级 |
| `degraded` | `/health` 返回 degraded | 顶部黄条 + 具体项 |

启动动作（显式）：

```bash
persome start        # 后台启动；不阻塞
```

实现：`spawn(persomeBin, ['start'], { detached: true, stdio: 'ignore' })`，然后轮询 `/health` 最多 30 秒。

停止动作不在 v1（避免误停用户正在用的 daemon）。

### 5.4 API 契约

除 `/health` 外，所有请求带 `Authorization: Bearer <token>`；超时 5s（`/model/graph` 15s）。

| 方法 | 路径 | 用途 | 返回 |
|---|---|---|---|
| GET | `/health` | 存活/降级（无鉴权） | `{status, ocr, index, capture}` |
| GET | `/status` | 版本、root、daemon、capture、last_capture、内存/会话/时间线、LLM profile | `ApiResponse<StatusData>` |
| GET | `/permissions` | accessibility / screen_recording | `ApiResponse<{...}>` |
| GET | `/model/graph` | 完整模型快照（未脱敏） | `{generated_at, model, index_health?}` |
| GET | `/model/evidence?ref=&as_of=` | 单条证据解析 | `EvidenceResponse` |
| GET | `/model/node?id=` | 节点原始 receipts + 关系树 | `{id, source, raw[], tree}` |
| GET | `/model/share-card` | 脱敏分享投影 | `{generated_at, model}` |
| POST | `/model/edit` | 纠正（v1.2） | `ApiResponse` |

`/model/graph` 返回的是 **owner 未脱敏视图**（源码注释明确：MCP/导出默认脱敏，loopback viewer 不脱敏）。因此：

- v1 不提供任何“分享/导出”入口；
- 未来若加导出，必须走 `/model/share-card` 或 `model export` 的脱敏路径。

### 5.5 错误映射

| 传输层 | UI |
|---|---|
| `ECONNREFUSED` | runtime stopped，显示启动按钮 |
| 401 | token invalid，显示 `persome start` 重新生成指引 |
| 404 | 路由不存在，按 version mismatch 处理 |
| 5xx | 显示错误详情 + “打开日志” |
| JSON schema 不符 | “Runtime 版本不兼容”，保留旧缓存并提示 |

---

## 6. 数据模型

```ts
// src/lib/types.ts
export type SchemaVersion = 1;

export interface ModelSnapshot {
  schema_version: SchemaVersion;
  generated_at: string;
  build: BuildRecord;
  points: Point[];
  lines: Line[];
  faces: Face[];
  volumes: Volume[];
  root: Root | null;
  receipts: Receipt[];
  stats: ModelStats;
}

export interface Point {
  id: string;
  content: string;
  layer: string;
  status: 'active' | 'retired' | string;
  is_latest: boolean;
  supersedes?: string | null;
  superseded_by?: string | null;
  occurred_at?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  created_at?: string | null;
  file_name: string;
  tags: string[];
  confidence: number;
  conflicted: boolean;
  receipt: string;
  edit_refusal: string; // "" = 可纠正
}

export interface Line {
  kind: 'evolution' | 'relation';
  // relation: src, dst, predicate, label, polarity, confidence, status
  // evolution: from, to, reason...
  [key: string]: unknown;
}

export interface Face {
  signature: string;
  observations: number;
  confidence: number;
  provenance: 'mined' | 'emergent' | 'both' | 'synth' | 'authored';
  members?: string[];
  source_receipts: string[];
  edit_refusal: string;
  // anchors / status ...
}

export interface Volume extends Face {
  // 跨域 schema，字段同 Face
}

export interface Root {
  signature: string;
  observations: number;
  confidence: number;
  provenance: 'synth' | 'authored' | string;
  source_receipts: string[];
  edit_refusal: string;
}

export interface BuildRecord {
  build_id: string | null;
  core_commit: string | null;
  models: Record<string, string>;
  prompt_hashes: Record<string, string>;
  config_hash: string | null;
  input_window: { start: string; end: string } | null;
  mode: string | null;
  trigger: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  degraded_stages: string[];
  status: 'complete' | 'degraded' | 'building' | 'not_built';
}

export interface ModelStats {
  points: number;
  evolution_lines: number;
  relation_lines: number;
  faces: number;
  volumes: number;
  roots: number;
  receipts: number;
}
```

证据响应（来自 `evidence.py` 的 `_base`）：

```ts
export interface EvidenceResponse {
  reference: string;
  canonical_reference: string;
  kind: string;
  id: string;
  status: 'ok' | 'missing' | string;
  label: string;
  summary: string;
  timestamp: string | null;
  path: string | null;
  metadata: Record<string, unknown>;
  sources: EvidenceItem[];   // 显式来源，可作为证明
  context: EvidenceItem[];   // 时间邻近上下文，不是证明
  history: EvidenceItem[];   // Point 的版本链
}
```

> UI 文案必须区分 `sources`（直接来源）与 `context`（邻近上下文，不是证据）。这是 Runtime 自己的契约，不要混。

---

## 7. UI 设计

### 7.1 信息架构

```
┌ Sidebar ─────────┬ Main ─────────────────────────────────────┐
│ ● Overview       │  Overview / Model / Evidence / Settings    │
│ ● Model          │                                            │
│ ● Search (v1.1)  │                                            │
│ ● Settings       │                                            │
└──────────────────┴────────────────────────────────────────────┘
```

### 7.2 页面

#### Overview

```
┌────────────────────────────────────────────────────────────┐
│ Persome Lens                           [Runtime: running]  │
├────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│ │ Capture  │ │ Last     │ │ Model    │ │ Sessions │        │
│ │ active   │ │ 2m ago   │ │ 1 Root   │ │ 42       │        │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
│                                                            │
│ Build: complete · 2026-11-04T… · 1,204 points              │
│ Degraded stages: (none)                                    │
│                                                            │
│ [复制 build 命令] [Open official viewer] [Open data folder] │
└────────────────────────────────────────────────────────────┘
```

- 数据来源：`/status`（5s 轮询，窗口失焦 30s）。
- 显示：daemon、capture、last_capture、sessions、memory、timeline、build status、counts。
- 若 `build.status = not_built`：显示“还没有模型，先跑一次 build”+ 可复制的命令（v1 不代替用户执行 build；v1.1 再加按钮）。

#### Model

三栏：

```
┌ Root ────────────────┬ Faces / Volumes ──────┬ Points ─────────┐
│ 一段叙事（可滚动）    │ Face 列表（置信度）    │ 可筛选表格      │
│ 置信度 · 证据数 · 时间│ Volume 列表           │ 点击 → 右侧证据 │
└──────────────────────┴───────────────────────┴─────────────────┘
```

- Root 卡片：signature、confidence、observations、build time、receipts 数。
- Faces/Volumes：按 confidence 排序，展示 signature 前两行；点击 → 过滤关联 Points。
- Points：virtualized 列表；列：时间、文件、摘要、confidence、conflicted、tags。
- 过滤器：`is_latest`、`conflicted`、`file_name`、tag。
- 选中 Point → 打开 Evidence 抽屉（不跳页）。

#### Evidence（抽屉/独立页）

```
┌ Evidence ─────────────────────────────────────────────┐
│ 结论：用户偏好 Rust 做 CLI 工具                         │
│ status: ok · point:event:entry:… · 2026-10-12          │
├────────────────────────────────────────────────────────┤
│ 直接来源（sources）                                     │
│  • 2026-10-12 14:03 · Terminal · iTerm                 │
│    “I’ll use Rust for this one.”                       │
│    receipt ⟨…⟩  [复制]                                  │
├────────────────────────────────────────────────────────┤
│ 邻近上下文（context，非证明）                           │
│  • 14:01 · VS Code · Cargo.toml                        │
├────────────────────────────────────────────────────────┤
│ 版本历史（history）                                     │
│  • supersedes ← 2026-09-30 …                           │
└────────────────────────────────────────────────────────┘
```

- 点击 receipt：调用 `/model/evidence?ref=<receipt>` 继续下钻；`status=missing` 时显示“原始数据已过保留期”。
- `as_of` 选择器（v1.1）：时间旅行。

#### Node（关系）

- 从 Point 的 “关系” tab 触发 `/model/node?id=<point.id>`。
- 展示 `raw[]`（原始 receipts）与 `tree`（BFS 关系树，depth≤2、fanout≤8）。
- 树节点可继续点击 → evidence。

#### Settings

| 项 | 内容 |
|---|---|
| Runtime 路径 | `<root>`，可打开 Finder |
| 端口 / 版本 | 只读 |
| Token | `已加载 / 缺失`（不显示值） |
| Config | 打开 `config.toml`（只读提示） |
| 诊断 | 复制 `doctor` 摘要（不含 token） |
| 官方查看器 | 按钮：`persome model open` |
| 关于 | 版本、许可、非官方声明 |

### 7.3 视觉

- 浅色「纸」主题，参考 Runtime 查看器的暖白/森林绿；
- 字体：系统 `-apple-system` / `PingFang SC`；
- 圆角 10px，1px 边框，弱阴影；
- 深色模式 v1.1（CSS variables 已留位）。

### 7.4 空态与降级

| 状态 | 文案 | 动作 |
|---|---|---|
| Runtime 未安装 | “没有找到 ~/.persome” | 安装指引链接 |
| Runtime 未启动 | “Runtime 没有运行” | 启动按钮 |
| 无权限 | “Accessibility / Screen Recording 未授权” | 打开系统设置 |
| 模型为空 | “模型还在形成中（未 build）” | 显示 `persome model build` |
| Build degraded | “以下阶段失败：…” | 显示 stage 列表 |
| index_health 异常 | 顶部黄条 | 链接到诊断 |

---

## 8. 安全设计

| 面 | 措施 |
|---|---|
| 进程 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| preload | 仅暴露 `window.lens` 的固定方法；参数用 zod 校验 |
| token | 只在 main；IPC 返回值不含 token；日志脱敏 |
| CSP | `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` |
| 远程内容 | 禁止加载任何 http(s) 页面；外链走 `shell.openExternal` + 域名白名单 |
| 文件访问 | 只读 `<root>` 下指定文件；路径规范化，拒绝 `..` |
| 遥测 | **无**（不引入 Sentry/analytics） |
| 导出 | v1 不提供；v1.2 只走 `/model/share-card` 或 `persome model export` |

---

## 9. 性能

| 点 | 方案 |
|---|---|
| `/model/graph` 可能很大 | 启动时拉一次，缓存 60s；列表虚拟化；只渲染当前视图 |
| 证据点击 | 懒加载，单条请求 |
| 状态轮询 | 聚焦 5s / 失焦 30s；窗口隐藏时暂停 |
| 内存 | 不把整张图复制进 React state 多次；用 normalized store |
| 首屏 | 先显示 status，再异步拉 graph；graph 期间显示 skeleton |

---

## 10. 技术栈与工程结构

### 10.1 栈

| 层 | 选择 |
|---|---|
| 壳 | Electron 43（当前稳定版），electron-vite |
| 渲染 | React 19 + TypeScript |
| 状态 | TanStack Query + 少量 Zustand（选中项） |
| 样式 | CSS Modules + CSS variables（不引 Tailwind） |
| 校验 | zod |
| 打包 | electron-builder（DMG，arm64） |
| 测试 | Vitest（unit）+ Playwright `_electron`（e2e） |

### 10.2 目录

```
persome-lens/
  package.json
  electron.vite.config.ts
  electron/
    main.ts                 # app lifecycle, window, IPC registration
    preload.ts              # window.lens API
    ipc.ts                  # channel whitelist + zod validation
    runtime/
      paths.ts              # root/port discovery
      token.ts              # env reader
      client.ts             # RuntimeClient (fetch + error mapping)
      supervisor.ts         # start runtime, health polling
    log.ts                  # redacted logger
  src/
    main.tsx
    App.tsx
    pages/Overview.tsx
    pages/Model.tsx
    pages/Settings.tsx
    components/EvidenceDrawer.tsx
    components/PointTable.tsx
    components/RootCard.tsx
    components/StateBanner.tsx
    lib/types.ts
    lib/api.ts              # window.lens typed wrapper
    lib/format.ts
    styles/tokens.css
  tests/
    fixtures/               # 从 runtime tests/fixtures/runtime_model 裁剪
    unit/*.test.ts
    e2e/*.spec.ts
  build/
    icon.png
  README.md
```

---

## 11. 测试

### 11.1 单元

- token 解析：缺字段、权限过宽、符号链接；
- 端口发现：config 有/无、端口占用；
- 错误映射：401/404/5xx/ECONNREFUSED；
- 数据归一化：`/model/graph` → 视图模型；`status` → 卡片。

### 11.2 契约测试

用 Runtime 仓库 `tests/fixtures/runtime_model/` 的 JSON 作为 golden fixture：

- 空模型（无 root）；
- 完整模型（root + faces + volumes + points）；
- evidence `status=missing`；
- degraded build。

### 11.3 E2E

用 Playwright `_electron` 启动 App，注入一个 **fake runtime**（本地 Express 或 msw）返回 fixture：

1. runtime down → 启动按钮可见；
2. 启动后 → Overview 显示 running；
3. Model 页显示 Root；
4. 点 Point → Evidence 抽屉出现 `sources`；
5. 无 token → 显示 unauthorized 文案。

### 11.4 手工

- 真实 Runtime 跑 10 分钟，确认状态轮询不抖动；
- 断网启动，确认无任何网络请求（DevTools Network 为空）；
- 检查日志无 token。

---

## 12. 打包与分发

```bash
npm run dist
# 产出 dist/Persome Lens-1.0.0-arm64.dmg
```

- appId：`dev.persomelens.app`
- productName：`Persome Lens`
- 最低 macOS 14，arm64
- v1 不做自动更新、不做公证（本地自用）；对外分发前再做 Developer ID + notarize
- 图标：自绘占位，不使用原版商标

---

## 13. 里程碑

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| M0 | 脚手架、窗口、preload、token/端口发现、`/status` | 应用可启动并读到 Runtime |
| M1 | Model 页：graph、Root、Faces、Points 列表 | 真实数据可渲染 |
| M2 | Evidence 抽屉、Node 树、Settings、空态/降级 | 证据可回溯；空态不崩 |
| M3 | 打包 DMG、README、fixtures 测试 | DMG 可安装；fixture 测试通过 |

依赖：Runtime 已安装（已完成）、Node 24、Xcode CLT（已具备）。

---

## 14. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| `/model/graph` 契约在 v0.4 变化 | 解析失败 | 按 `schema_version` 分支；zod 校验；不兼容时只读旧缓存 |
| 大模型 payload（数千 Points） | 卡顿 | 虚拟化 + 分页（v1.1 改用 MCP bounded projection） |
| token 文件权限差异 | 无法连接 | 明确报错 + 引导 `persome start` 重新生成 |
| Runtime 版本过旧 | 路由缺失 | 版本检查 + 升级提示 |
| 用户同时开产品版 | 端口/采集冲突 | 只用 8742；检测 8823 并提示“产品版在运行” |
| 只读 v1 不够用 | 用户想纠正 | v1.2 接 `POST /model/edit` + `correct_memory` |

开放问题：

1. 搜索是否在 v1 就做？建议 v1.1，用 `persome mcp` stdio + `@modelcontextprotocol/sdk`。
2. 是否做“constellation”星空图？建议 v1.1，先列表 + 关系树。
3. 是否需要 i18n？v1 中文优先，英文 v1.1。
4. 是否支持多 root（dev/prod）切换？v1 单 root + `PERSOME_ROOT` 覆盖。

---

## 15. 验收标准（Definition of Done）

- [ ] `npm install && npm run dev` 在已装 Runtime 的机器上直接打开窗口；
- [ ] 断网、无账号，Overview/Model/Evidence 全部可用；
- [ ] Runtime 未启动时显示明确空态，一键启动后自动刷新；
- [ ] 点击 Root/Face/Point 能看到 sources 原文与 receipt；
- [ ] `status=missing` 的旧 receipt 有正确文案；
- [ ] 渲染进程 DevTools 中搜不到 token；
- [ ] 无任何外部网络请求（除 127.0.0.1）；
- [ ] `npm run dist` 产出可双击运行的 DMG；
- [ ] README 写明：非官方、只读、数据不出本机。

---

## 16. 后续版本

| 版本 | 内容 |
|---|---|
| v1.1 | MCP stdio 搜索（`search` / `search_captures` / `recent_activity`）；星空图；深色模式 |
| v1.2 | 写入：`POST /model/edit`、`correct_memory`；`as_of` 时间旅行 |
| v1.3 | 导入向导（Obsidian/folder/Notion）；`HUMAN.md` 预览 |
| v2 | 可选接产品版 Cloud（登录后启用会议/卡片/周报），但必须保持“本地模式”可独立运行 |
| 暂不做 | HET（开源 Runtime 无此模块）；会议；社交；云同步 |

---

## 17. 参考资料

- Runtime 仓库：`~/Documents/GitHub/personal-model`
- 模型格式：`MODEL_FORMAT.md`
- MCP 契约：`MCP.md`
- 证据契约：`src/persome/evidence.py`
- 路由：`src/persome/api/routes.py`
- 官方查看器：`src/persome/api/model_view.py`

---

## 18. 非官方声明

本项目是第三方本地查看器，不使用原版商标与云端服务；只读取用户本机 `~/.persome` 中由开源 Runtime 生成的数据。Runtime 代码遵循 Apache-2.0，本查看器将保留相应 NOTICE。

---

## 19. 实现状态（2026-11-04）

- 代码位置：`~/Documents/GitHub/persome-lens`
- 已实现：Overview（状态/构建/权限）、Model（Root/Faces/Volumes/Points 筛选）、Evidence 抽屉（sources/context/history/receipt 下钻）、Node 关系与原始回执、Settings、Runtime 一键启动、未连接/空模型/无权限空态。
- 未实现（按计划）：搜索（MCP，v1.1）、写入/纠正（v1.2）、星空图、i18n、DMG 公证。
- 验证：typecheck ✅、build ✅、打包 DMG ✅、mock fixtures 与真实 runtime（ingest 模式）均通过。
- 运行：
  ```bash
  cd ~/Documents/GitHub/persome-lens
  env -u ELECTRON_RUN_AS_NODE npm run dev
  ```

### 19.1 真实数据验证（2026-11-04 晚）

- 真实 `~/.persome` 跑通：Overview / Model / Evidence 均能读取运行时数据。
- 发现并修复一个真实数据 bug：`/model/graph` 的 `Point.tags` 是空格分隔字符串，不是数组；Model 页首版因此崩溃（白屏）。已在 `tagList()` 中兼容 string / array / null。
- 第一次 build（114 个导入 session + 4 条 agent remember 事实）结果：**14 Points / 10 Lines / 0 Faces / 0 Volumes / 0 Root**，`model_contract` degraded。
- 结论：`import-data` 在公开 v0.3.2 里只生成 event 日志，evomem 会跳过 `event-*`；Points 主要来自 `remember` 写入的持久记忆与实体边。Face/Volume/Root 需要跨会话重复证据。
- Claude 订阅额度当晚 200/200 用尽（导入 session 归约消耗大），次日重置前 LLM 阶段会 fail closed。

### 19.2 P0 / P1 已实现（2026-11-04 夜）

- **P0**：顶栏新增 `LLM used/limit` 徽标；额度耗尽时显示红色提示条（含下次重置时间）；新增全局刷新按钮。
- **P1**：新增「搜索」页，走 `persome mcp` stdio：
  - 记忆搜索：MCP `search`
  - 屏幕搜索：MCP `search_captures`
  - 最近活动：MCP `recent_activity`
  - 记忆/最近结果可点开 Evidence 抽屉。
- 主进程新增最小 MCP JSON-RPC 客户端（`src/main/mcp/client.ts`），按需启动 `persome mcp`，退出时关闭。
- 已验证：typecheck、build、dist；真实 `~/.persome` 下记忆搜索返回结果；额度条显示 200/200 与重置时间。

### 19.3 P2 / P3 已实现（2026-11-04 夜）

- **P2 写入**：
  - 「记住一条」对话框：调用 MCP `remember`，直接写 `topic-agent-findings.md`，零 LLM。
  - Evidence 抽屉「纠正」：调用 MCP `correct_memory`，自然语言纠正，保留回执；可能调用 LLM。
  - 「构建模型」按钮：主进程 spawn `persome model build`，实时显示输出尾部、退出码，可取消；额度耗尽时禁用。
- **P3 Playbook**：新增页面读取 MCP `behavior_patterns`，展示 Root / Faces / Skills 与 Runtime 渲染块；空态说明需要跨会话证据。
- 真实数据验证：搜索、记住弹窗、纠正弹窗、空 Playbook 均正常渲染；typecheck/build/dist 通过。
- 未验证：build 按钮的完整构建（当前额度 200/200 被禁用）；correct_memory 的实际应用（会调用 LLM，同样受额度限制）。
