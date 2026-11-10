# UI 升级调研：skills 与 UI/UX 套件

日期：2026-11-05。用于把 Lens 从「暖纸 + 森林绿」的干净界面推到更有高级感、也更清晰的状态。
本文只收**已在 2026-11-05 实测/核对过**的来源；安装命令按本机环境（DeepSeek Harness + Claude Code）验证。

## TL;DR

- **已经装好的 skill**：Impeccable（本项目 `.dsh/skills/impeccable`，19MB 含本地引擎）。
  它自带确定性检测器，第一次跑就抓到一个真问题：`app.css` 的 `border-left: 3px` 侧边强调条。
- **最值得再装的 skill**：`anthropics/skills` 的 `frontend-design`（设计方向，防「模板感」）、
  `ibelick/ui-skills`（设计工程基线）、`emil-design-eng`（动效/组件手感）；审计用 Impeccable 的 `critique` / `audit`。
- **套件只装无头原语**：Base UI（对话框/焦点/键盘）、Motion（动效）、cmdk（⌘K）、Sonner（toast）。
  **不要装 shadcn/ui 本体**：它默认带 Tailwind，与本项目 `VISUAL-TOKENS.md` 的「只用 token、无 Tailwind」规则冲突。
- **最大的清晰度问题不是配色，是结构**：19 个平铺 nav、`App.tsx` 里 4 种手写浮层、页面里重复实现
  loading/empty/error、统计卡把一句话塞进大号绿字。这些是「高级感」的真正来源。

## 1. Skills（装进 agent，而不是装进依赖）

| Skill | 来源 | 解决什么 | 怎么装 |
|---|---|---|---|
| **Impeccable** | [impeccable.style](https://impeccable.style) · [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | 24 个命令：`critique`（UX 评分）、`audit`（a11y/性能/主题）、`polish`、`typeset`、`layout`、`distill`、`onboard`、`animate`；62 条确定性规则抓 AI 味 | 已装（见下）。全局：`npx impeccable install --providers=deepseek --scope=global -y` |
| **frontend-design** | [anthropics/skills](https://github.com/anthropics/skills) | 先定视觉方向再写代码：调色板、字体、布局、原则；显式列出「AI 生成感」特征清单 | Claude Code：`/plugin marketplace add anthropics/skills` → 装 `example-skills` |
| **ui-skills**（baseline-ui 等） | [ibelick/ui-skills](https://github.com/ibelick/ui-skills) · [ui-skills.com](https://www.ui-skills.com) | 设计工程基线：可访问原语、动效规则、Tailwind 约束（Tailwind 部分本项目跳过） | `npx ui-skills list --category motion` → `npx ui-skills get baseline-ui` |
| **emil-design-eng** | [master5d/claude-design-skills](https://github.com/master5d/claude-design-skills) | 组件手感：按压态、弹簧、`ease-out`、避免 `transition: all`；输出 Before/After 表 | 该 repo 的 skills 目录直接复制，或按 README 装 plugin |
| **fixing-accessibility** | 同上 | ARIA、焦点陷阱、键盘导航、WCAG 审计 | 同上 |
| **webapp-testing** | [anthropics/skills](https://github.com/anthropics/skills) | Playwright 截图/控制台，作为「改完截图对比」的验收环 | 随 `example-skills` 安装 |
| Superdesign（可选） | [superdesign.dev](https://superdesign.dev/docs/cli-skill-tutorial) | 设计画布 + 多方案生成；需要登录与 CLI | `npm i -g @superdesign/cli` → `superdesign login` → `npx skills add superdesigndev/superdesign-skill` |

**本机已执行的安装**（项目级，DeepSeek Harness 自动识别）：

```bash
npm_config_cache=/tmp/npm-cache npx --yes impeccable install \
  --providers=deepseek --scope=project -y
```

产物：`.dsh/skills/impeccable/`（含 `scripts/bin/darwin-arm64/impeccable` 引擎）。已把 `.dsh/` 加入 `.gitignore`。
下一步在对话里执行 `/impeccable init` 生成 `PRODUCT.md`，再 `/impeccable document` 把现有 token 固化成 `DESIGN.md`。

> 注意：本机 npm 全局缓存有 root 属主文件，直接 `npx` 会 `EPERM`。
> 临时绕过：命令前加 `npm_config_cache=/tmp/npm-cache`；彻底修：`sudo chown -R 501:20 ~/.npm`。

## 2. UI/UX 套件（按「能不能进这个项目」分三档）

### A. 可装：无头、无样式、不抢设计权

| 包 | 版本（2026-11-05 npm） | 用途 | 与现有约束的关系 |
|---|---|---|---|
| `@base-ui/react` | 1.9.0 | Dialog / Popover / Select / Menu / Tooltip / Switch，自带焦点陷阱、Esc、键盘、ARIA | 无样式，class 继续用 token；替代手写 `Modal.tsx` + 4 处浮层 |
| `motion` | 14.9.1 | 进场/退场、布局动画、`useReducedMotion` | 只做 150–200ms 的「回应动作」动效，不加装饰性动画 |
| `cmdk` | 1.1.1 | ⌘K 命令面板（跳页 + 搜记忆） | 纯无头，样式自写 |
| `sonner` | 2.0.8 | toast（复制成功、后台扫描、导入完成） | 可完全用 CSS 变量覆写，不引入视觉语言 |
| `vaul` | 1.1.2 | 移动端式抽屉/底部弹层 | 本项目更接近 macOS 抽屉，优先级低 |
| `lucide-react` | 1.69.0 | 图标（nav 分组、按钮、空状态） | 1px stroke 线性图标，与纸感界面相容 |

### B. 只取灵感 / 抄结构，不装依赖

| 来源 | 取什么 | 为什么不能直接装 |
|---|---|---|
| [shadcn/ui](https://ui.shadcn.com) blocks / charts | 表单排布、空状态、设置页分组、图表卡片的**信息层级** | 默认 Tailwind + 自带 token，和 `VISUAL-TOKENS.md` 的 token-only 规则冲突 |
| [ui-skills Playbook](https://www.ui-skills.com/playbook) | 从顶级设计工程 skill 提炼的规则清单 | 是读物，不是依赖 |
| [Mobbin](https://mobbin.com) / [Cosmos](https://cosmos.so) | 找同类「本地优先工具 / 知识库」的成熟模式 | 参考，注意版权，不直接搬 |
| [Refactoring UI](https://www.refactoringui.com) | 层级、留白、对比、颜色的判断法 | 书/方法论 |

### C. 不建议

- **完整 UI Kit**（Mantine、MUI、Ant Design、Chakra、Vuero 等）：自带一整套视觉语言和 token，
  会把现在的暖纸/森林绿覆盖成通用后台，且 Electron 包体明显变大。
- **Tremor**：图表组件好看，但绑定 Tailwind 且自带灰阶设计语言；本项目只有 2 个图表，手写 SVG 更可控。
- **Framer/Webflow 模板**：静态营销页资产，迁进 React 状态流成本高于收益。

## 3. 落到这个仓库的优先级

### P0 — 低成本、立刻可见（纯 CSS/TSX，不动依赖）

1. **删掉侧边强调条**：`app.css:762` `.schema-item.volume { border-left: 3px solid var(--accent) }`
   → 改为 1px `--accent-line` 边框 + 小号 `VOLUME` 标签，或整卡 `--accent-soft` 底。
   这是检测器命中的「最典型的 AI 生成感」。
2. **统计卡降噪**：`.tone-ok .stat-value { color: var(--accent) }` 让 4 张卡的 4 个数字全是绿色。
   数字用 `--ink` + `650`，只有**状态**（degraded / 未测量）才上色；句子拆成「主数字 + 1 行 detail」。
3. **加载态**：`Home.tsx` 的 `Body` 现在渲染「读取中…」文字；改成 2–3 行骨架（`--fill` 底 + 120ms 脉冲，
   尊重 `prefers-reduced-motion`），避免布局跳动。
4. **焦点可见**：`Modal.tsx` / `drawer` 补齐 Esc 关闭、初始焦点、焦点陷阱；手写 `Modal` 直接换 Base UI Dialog。

### P1 — 信息架构（「清晰感」的大头）

1. **导航分组**：`App.tsx` 的 `NAV` 19 项平铺，改成 5 组：
   `今日`（主页/今天/问）、`记忆`（总览/资料库/模型/搜索/Playbook）、`采集`（采集/Rewind）、
   `身份与连接`（个人卡片/朋友/Swipe/Connections）、`系统`（HET/导入/连接器/设置/恢复）。
   组标题用 10–11px 字重 600 的 `--muted`，不要全大写加字距（`VISUAL-TOKENS.md` 已把 eyebrow 收敛）。
2. **⌘K**：cmdk 面板同时覆盖「跳页」和「搜记忆」；`Search.tsx` 保留为结果页，面板只做入口。
   一个快捷键能同时减少 nav 压力和「找不到」的焦虑。
3. **统一浮层**：`App.tsx` 的 drawer、`Modal.tsx`、`ResetIdentityDialog`、`RememberDialog`、Evidence 抽屉
   各自实现遮罩/动画/焦点。收敛到一套 Dialog + Drawer 原语，交互一致才显“做完了”。

### P2 — 质感（做完 P0/P1 再动）

1. **字体**：现在 `-apple-system + PingFang SC`。macOS 上 SF Pro 显示效果不差，问题在**层级**：
   页面标题 22/650、卡标题 14、正文 13，差距不够。先把层级拉开（标题 24–26、行高 1.2、
   卡标题 13/600 + 说明 12/400），再考虑换字。
   若要换：拉丁 `Geist` / `Inter`（Fontsource，离线可变字体），中文保持 PingFang；
   或自托管 `MiSans` / `Noto Sans SC`（注意 +5–10MB 包体，Electron 安装包会变大）。
2. **动效 token**：现有 `--dur-fast: 120ms` 只够 hover。补 `--dur-base: 180ms`、`--dur-slow: 240ms`
   和 `--ease-out` 的一组曲线，只用于抽屉/弹层进出、列表插入、状态切换。
3. **数据可视化**：热力图与 AccessChart 尺寸/色阶已统一；若要再进一步，只统一两件事——
   同一语义同一颜色（成功/警告/失败在图表和 chip 里一致）、坐标轴与网格降到 `--line` 的 60%。
4. **一个记忆点**：frontend-design skill 明确警告「暖米色底 + 高对比衬线标题 + 陶土色」是当下最常见的
   AI 生成组合；本项目是暖米色 + 森林绿 + 无衬线，已经避开一半。建议只留**一处**刻意设计的瞬间
   （例如「今天」页把 brief 做成一张真正的纸质日报：衬线标题 + 细分割线 + 页脚日期），其余保持安静。

## 4. 验收方式

- 每轮改动后：`npm run dev` → 截图 Today / Home / Model / Settings 四页（浅色 + 深色）→ 对比。
- 可访问性：Impeccable `audit` 出 P0–P3 清单；键盘走一遍 nav → 页面 → 抽屉 → Esc。
- 视觉回归：`webapp-testing` skill 写一个 Playwright 脚本，对四页做截图 diff，避免改动互相踩。

## 5. 已落地（2026-11-05）

P0–P2 中除「换字体」外的条目都已实现，细则见 `VISUAL-TOKENS.md` §Structure：

- 侧边条反模式已删（`schema-item.volume` 改为 `--fill-raised` + `--accent-line` 边框）。
- 19 页改成 5 组 `NAV_GROUPS`，带 15px Lucide 图标；`App.tsx` 不再手写 nav 数组。
- ⌘K 命令面板（cmdk + Base UI Dialog）已接入，输入即筛、分组、键盘上下 + Enter；侧边栏底部有可见入口。
- `Modal.tsx` 与 `EvidenceDrawer` 改由 Base UI Dialog 托管焦点陷阱 / Esc / 遮罩关闭 / 滚动锁 / 焦点恢复，
  进出场改为 `data-starting-style` / `data-ending-style` 过渡。
- `Skeleton` 替换 Home / Today / Library 的「读取中…」；`Toaster`（Sonner）接管复制与写入成功提示。
- 统计值统一 `--ink`，tone 只标状态；标题 24/650、卡标题 14/600；新增 `--dur-base` / `--dur-slow` 与
  `prefers-reduced-motion` 全局降级。
- 验证：`npm run typecheck`、1578 个单测、41 步 Electron e2e 全过；Impeccable `detect` 在 renderer 上 0 findings。
- 截图：`docs/design/v3-shots/`。

## 6. 参考链接

- [Base UI](https://base-ui.com) · [Motion](https://motion.dev) · [cmdk](https://cmdk.paco.me) · [Sonner](https://sonner.emilkowal.ski)
- [Impeccable 文档](https://impeccable.style/docs) · [ui-skills](https://www.ui-skills.com) · [skills.sh](https://www.skills.sh)
- [shadcn/ui Base UI 默认变更（2026-07）](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
