// Shared navigation data: one source of truth for the sidebar groups and the ⌘K palette.
// Keep `id` in sync with `Page` in lib/nav.ts — `satisfies` makes a drift a compile error.
import {
  BookOpen,
  Brain,
  CircleUserRound,
  Clock,
  Download,
  History,
  Home,
  IdCard,
  Layers,
  Library,
  Link2,
  type LucideIcon,
  MessageCircle,
  Plug,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Users,
  Mail,
  Video,
  Mic,
  ListChecks
} from 'lucide-react'
import type { Page } from './nav'
import { tr } from './i18n'

export interface NavItem {
  id: Page
  label: string
  hint: string
  icon: LucideIcon
  /** Extra words the ⌘K fuzzy filter should match. */
  keywords?: string
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'today',
    get label() { return tr('Daily', '今日') },
    items: [
      { id: 'home', get label() { return tr('Home', '主页') }, get hint() { return tr('Today / HET / Agents / heatmap', 'Today / HET / Agents / 热力图') }, icon: Home, keywords: 'dashboard home heatmap 首页 主页' },
      { id: 'today', get label() { return tr('Today', '今天') }, get hint() { return tr('Daily brief · unverified', '每日 brief · 未核实') }, icon: Sun, keywords: 'daily brief today 日报 今天' },
      { id: 'ask', get label() { return tr('Ask', '问') }, get hint() { return tr('Example prompts · hand off to an external Agent', '示例 prompt · 交给外部 Agent') }, icon: MessageCircle, keywords: 'ask prompt 问' },
      { id: 'chat', get label() { return tr('Cloud chat', '云端对话') }, get hint() { return tr('Optional cloud · preview context before sending', '可选云端 · 发送前预览上下文') }, icon: MessageCircle, keywords: 'chat cloud wechat group 云端 对话 微信群' },
      { id: 'meetings', get label() { return tr('Meetings', '会议') }, get hint() { return tr('Record · cloud transcription · save to memory (optional cloud)', '录音 · 云端转写 · 写入记忆（可选云端）') }, icon: Mic, keywords: 'meetings meeting recording transcription 会议 录音 转写' }
    ]
  },
  {
    id: 'memory',
    get label() { return tr('Memory', '记忆') },
    items: [
      { id: 'overview', get label() { return tr('Overview', '总览') }, get hint() { return tr('Runtime and build status', 'Runtime 与构建状态') }, icon: Layers, keywords: 'overview runtime 总览' },
      { id: 'library', get label() { return tr('Library', '资料库') }, get hint() { return tr('People / projects / profile / skills', '人 / 项目 / 画像 / 技能') }, icon: Library, keywords: 'library people projects profile skills 资料库 人物 项目' },
      { id: 'model', get label() { return tr('Model', '模型') }, get hint() { return 'Root / Face / Point' }, icon: Brain, keywords: 'model root face point 模型' },
      { id: 'search', get label() { return tr('Search', '搜索') }, get hint() { return tr('Memory / screen / recent', '记忆 / 屏幕 / 最近') }, icon: Search, keywords: 'search find 搜索 查找' },
      { id: 'playbook', label: 'Playbook', get hint() { return tr('Behavior patterns / workflows', '行为模式 / 工作流') }, icon: BookOpen, keywords: 'workflow skills 技能' }
    ]
  },
  {
    id: 'capture',
    get label() { return tr('Capture', '采集') },
    items: [
      { id: 'capture', get label() { return tr('Capture', '采集') }, get hint() { return tr('Permissions / exclusions / pause / frames', '权限 / 排除 / 暂停 / 帧') }, icon: Video, keywords: 'capture screenshot permissions 采集 截图 权限' },
      { id: 'rewind', label: 'Rewind', get hint() { return tr('Screenshot history · decrypt on demand', '截图历史 · 按需解密') }, icon: History, keywords: 'history screenshot 历史' }
    ]
  },
  {
    id: 'identity',
    get label() { return tr('Identity & connections', '身份与连接') },
    items: [
      { id: 'card', get label() { return tr('Personal Card', '个人卡片') }, get hint() { return tr('Personal Card / signature', 'Personal Card / 签名') }, icon: IdCard, keywords: 'card personal signature 个人卡片 签名' },
      { id: 'peers', get label() { return tr('Peers', '朋友') }, get hint() { return tr('Peer cards / weekly letter drafts', '朋友卡片 / 周信草稿') }, icon: Users, keywords: 'peers friends weekly letter 朋友 周信' },
      { id: 'subscriptions', get label() { return tr('Subscriptions', '订阅') }, get hint() { return tr('Weekly letter email subscriptions · cloud card (optional cloud)', '周信邮件订阅 · 云端名片（可选云端）') }, icon: Mail, keywords: 'subscriptions weekly letter email cloud card 订阅 周信 邮件 云端 名片' },
      { id: 'swipe', label: 'Swipe', get hint() { return tr('Swipe Your Card / export / verify', 'Swipe Your Card / 导出 / 验证') }, icon: CircleUserRound, keywords: 'swipe export verify 导出' },
      { id: 'connections', label: 'Connections', get hint() { return tr('Agent connections / Access log', 'Agent 连接 / Access log') }, icon: Plug, keywords: 'agent mcp connections 连接' }
    ]
  },
  {
    id: 'system',
    get label() { return tr('System', '系统') },
    items: [
      { id: 'het', label: 'HET', hint: 'Human Equivalent Time', icon: Clock, keywords: 'het time 时间' },
      { id: 'performance', get label() { return tr('Performance', '表现') }, get hint() { return tr('Only for you: traceable counts · project activity', '只给你看：计数可回溯 · 项目活动') }, icon: ListChecks, keywords: 'performance counts projects milestones commit 表现 计数 项目 里程碑 提交' },
      { id: 'import', get label() { return tr('Import', '导入') }, get hint() { return tr('Claude Code / Codex history', 'Claude Code / Codex 历史') }, icon: Download, keywords: 'import history 导入 历史' },
      { id: 'connectors', get label() { return tr('Connectors', '连接器') }, get hint() { return tr('Local calendar .ics / health CSV·JSON', '本地日历 .ics / 健康 CSV·JSON') }, icon: Link2, keywords: 'connectors calendar health email 连接器 日历 健康 邮件' },
      { id: 'settings', get label() { return tr('Settings', '设置') }, get hint() { return tr('Paths and diagnostics', '路径与诊断') }, icon: Settings, keywords: 'settings diagnostics language 设置 诊断 语言' },
      { id: 'recovery', get label() { return tr('Recovery', '恢复') }, get hint() { return tr('Runtime / data failure recovery', '运行时 / 数据故障恢复') }, icon: RotateCcw, keywords: 'recovery repair 恢复 故障' }
    ]
  }
]
