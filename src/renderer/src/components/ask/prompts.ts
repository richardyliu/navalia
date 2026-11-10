// S2-03 「问」page: stable, pure prompt cards (no React, no window, no network). Owned by onboard-ask.
//
// Lens never runs these prompts. The user copies one into an external agent (Claude Code / Codex /
// Cursor) that they connected on the Connections page. That agent calls MCP tools; Lens does not
// call any LLM (DECISIONS-ROUND2 X7).
//
// Which MCP server: Connections writes an entry named `navalia` that points at the local Lens
// Broker (127.0.0.1, see src/main/broker/agents.ts ENTRY_NAME). Under the default full-access grant
// the Broker exposes the 22 Runtime (OSS) tools under their exact names
// (src/main/broker/catalog.ts TOOL_CATALOG / oss-tools.json). A user who configured the Runtime's
// own `persome` MCP server directly sees the same tool names. A scoped grant (Lens extension) may hide
// some tools; `requiredScopes()` in askView.ts lists what each card needs.

import { tr } from '../../lib/i18n'

export function askLlmNote(): string {
  return tr('Results come from the external Agent; Navalia does not call an LLM', '结果由外部 Agent 生成，Navalia 不调用 LLM')
}

export function askServerNote(): string {
  return tr(
    'These prompts expect the Agent to be connected to the Navalia Broker (the MCP server name the Connections page writes is navalia; full access by default, with the same tool names as the Runtime persome MCP). If you configured the Runtime persome MCP directly, the tool names are the same.',
    '这些 prompt 期望 Agent 已经接入 Navalia Broker（Connections 页写入的 MCP 服务名是 navalia；默认完全访问，工具名与 Runtime 的 persome MCP 相同）。如果你直接配置了 Runtime 的 persome MCP，工具名也一样。'
  )
}

/** Shared tail: ask the agent to cite and to mark what it could not verify. */
function cite(): string {
  return tr(
    'Requirements: after every conclusion, cite its source (memory file path, receipt / entry_id, or the time and app name of the screen capture); mark anything without a source as "unverified" and do not fill in or guess.',
    '要求：每条结论后面注明来源（memory 文件路径、receipt / entry_id，或屏幕采集的时间与应用名）；找不到来源的内容标注「未核实」，不要补全或猜测。'
  )
}

export interface AskPrompt {
  /** Stable id (used as React key and in tests). */
  id: 'who-am-i' | 'weekly-progress' | 'wechat-groups' | 'past-decisions'
  title: string
  /** One line under the title. */
  summary: string
  /** Exact text copied to the clipboard. */
  prompt: string
  /** MCP tools the prompt asks the agent to use, exact Runtime names. */
  tools: string[]
  /** Honest limits shown on the card (may be empty). */
  limits: string[]
  /** Always askLlmNote(). */
  note: string
}

export const ASK_PROMPTS: readonly AskPrompt[] = [
  {
    id: 'who-am-i',
    get title() {
      return tr('Who I am / what I am working on', '我是谁 / 我在做什么')
    },
    get summary() {
      return tr('Have the Agent read your behavior model and relation graph and write an overview of you.', '让 Agent 读你的行为模型和关系图，写一段关于你的概述。')
    },
    get prompt() {
      return tr(
        [
          'Use the Persome MCP tools to learn about me:',
          '1. First call behavior_patterns to read my root overview, behavior patterns and workflows;',
          '2. For each main person and project that appears, call entity_graph(name) once to see how they relate to me;',
          '3. Write a paragraph of at most 150 words on who I am, what I have been working on lately and with whom, then list 3–5 current main projects.',
          cite()
        ].join('\n'),
        [
          '请用 Persome 的 MCP 工具了解我：',
          '1. 先调用 behavior_patterns，读我的 root 概述、行为规律和工作流；',
          '2. 对其中出现的主要人物和项目，各调用一次 entity_graph(name)，看他们和我的关系；',
          '3. 用中文写一段 200 字以内的「我是谁、最近在做什么、和谁一起做」，再列出 3–5 个当前主要项目。',
          cite()
        ].join('\n')
      )
    },
    tools: ['behavior_patterns', 'entity_graph'],
    get limits() {
      return [
        tr(
          'Reflects only what Runtime has already built into the model; if the model has not been built or there is little data, the result will be thin.',
          '只反映 Runtime 已经构建进模型的内容；模型没构建或数据很少时，结果会很空。'
        )
      ]
    },
    get note() {
      return askLlmNote()
    }
  },
  {
    id: 'weekly-progress',
    get title() {
      return tr("This week's project progress", '这周项目进展')
    },
    get summary() {
      return tr('Summarize memory entries from the last 7 days by project.', '按项目汇总最近 7 天的记忆条目。')
    },
    get prompt() {
      return tr(
        [
          "Use the Persome MCP tools to put together this week's project progress:",
          '1. Call recent_activity (since = 7 days ago) to get recent memory entries;',
          '2. For each project that appears, add detail with search(query=project name, since=7 days ago);',
          '3. Output by project: what got done, where it is stuck, and what comes next.',
          cite()
        ].join('\n'),
        [
          '请用 Persome 的 MCP 工具整理我这周的项目进展：',
          '1. 调用 recent_activity（since 设为 7 天前），拿到最近的记忆条目；',
          '2. 对每个出现的项目，用 search(query=项目名, since=7 天前) 补充细节；',
          '3. 按项目输出：完成了什么、卡在哪里、下一步是什么。',
          cite()
        ].join('\n')
      )
    },
    tools: ['recent_activity', 'search'],
    get limits() {
      return [
        tr(
          'Includes only what has been written to memory; screen activity Runtime has not yet compressed into memory does not appear in recent_activity.',
          '只包含已经写入记忆的内容；还没被 Runtime 压缩进记忆的屏幕活动不会出现在 recent_activity 里。'
        )
      ]
    },
    get note() {
      return askLlmNote()
    }
  },
  {
    id: 'wechat-groups',
    get title() {
      return tr('Sort out my WeChat groups', '整理我的微信群')
    },
    get summary() {
      return tr(
        'Find group chat content recently seen in WeChat from screen captures and organize it by group.',
        '从屏幕采集里找出最近在微信里看到过的群聊内容，按群整理。'
      )
    },
    get prompt() {
      return tr(
        [
          'Use the Persome MCP tools to organize the WeChat group chats I have seen recently:',
          '1. Call search_captures with app_name set to "WeChat" (if nothing comes back, try "微信"), and use keywords or group names I care about as the query;',
          '2. For hits you need to read in full, call read_recent_capture (with the hit time at and app_name); do not request screenshots;',
          '3. Output by group: group name, topics discussed, and to-dos that involve me or places that mention me.',
          'Note: you can only see text that was on my screen at the time and was captured; chat history that never appeared on screen is not included, so do not speculate about it.',
          cite()
        ].join('\n'),
        [
          '请用 Persome 的 MCP 工具整理我最近在微信里看到的群聊：',
          '1. 调用 search_captures，app_name 设为「WeChat」（如果没有结果，再试「微信」），query 用我关心的关键词或群名；',
          '2. 对需要看全文的命中，调用 read_recent_capture（按命中的时间 at 和 app_name），不要请求截图；',
          '3. 按群输出：群名、讨论的主题、和我有关的待办或提到我的地方。',
          '注意：你只能看到当时显示在我屏幕上、并且被采集到的文字；没有出现在屏幕上的聊天记录不在里面，不要推测它们。',
          cite()
        ].join('\n')
      )
    },
    tools: ['search_captures', 'read_recent_capture'],
    get limits() {
      return [
        tr(
          'Only text that was on screen at the time and captured via Accessibility (AX) or OCR; chats you never scrolled to or opened are not in Persome.',
          '只有当时显示在屏幕上、并经辅助功能（AX）或 OCR 采集到的文字；没滚动到、没打开过的聊天记录不在 Persome 里。'
        ),
        tr(
          'WeChat exposes almost no Accessibility (AX) text, so it relies mainly on the Runtime OCR fallback. OCR is off by default (enable_ocr_fallback = false; the install script turns it on only on supported Macs). With OCR off, WeChat has almost no searchable text. Check OCR status in the diagnostics on the Capture page.',
          '微信几乎不暴露辅助功能（AX）文本，主要靠 Runtime 的 OCR 兜底；OCR 默认关闭（enable_ocr_fallback = false，安装脚本在支持的 Mac 上才会打开）。OCR 没开时，微信里基本没有可搜的文字。请在「采集」页的诊断里查看 OCR 状态。'
        ),
        tr('Neither Navalia nor Runtime reads the WeChat local database.', 'Navalia 和 Runtime 都不读取微信的本地数据库。'),
        tr(
          'Raw screen captures have a retention limit (Runtime default buffer_retention_hours = 168, about 7 days); older content may already be cleaned up.',
          '原始屏幕采集有保留期限（Runtime 默认 buffer_retention_hours = 168，约 7 天），更早的内容可能已经清理。'
        )
      ]
    },
    get note() {
      return askLlmNote()
    }
  },
  {
    id: 'past-decisions',
    get title() {
      return tr('Recover a past decision', '找回过去的决定')
    },
    get summary() {
      return tr('Find out how something was decided at the time, why, and on what basis.', '找出某件事当时是怎么决定的、为什么、依据是什么。')
    },
    get prompt() {
      return tr(
        [
          'Use the Persome MCP tools to help me recover a past decision (topic: <fill in the topic here>):',
          '1. Call search(query=topic, include_chains=true) to find related decisions and reasons;',
          '2. For the most relevant results, read the memory file with read_memory(path) (paged; when has_more is true, call again with the same arguments plus cursor=next_cursor), and check the original entry with read_receipt(entry_id);',
          '3. Output: the decision at the time, the reasons, when it was made, and whether it was later reversed or updated.',
          cite()
        ].join('\n'),
        [
          '请用 Persome 的 MCP 工具帮我找回过去的决定（主题：<在这里填写主题>）：',
          '1. 调用 search(query=主题, include_chains=true)，找出相关的决定和理由；',
          '2. 对最相关的结果，用 read_memory(path) 读记忆文件（分页返回；has_more 为 true 时用相同参数加 cursor=next_cursor 继续），用 read_receipt(entry_id) 核对原始条目；',
          '3. 输出：当时的决定、理由、时间、之后有没有被推翻或更新。',
          cite()
        ].join('\n')
      )
    },
    tools: ['search', 'read_memory', 'read_receipt'],
    get limits() {
      return [
        tr(
          'Only decisions written into memory can be recovered; verbal decisions that never appeared on screen or in a session cannot be found.',
          '只能找回被写进记忆的决定；从来没有出现在屏幕或会话里的口头决定找不到。'
        )
      ]
    },
    get note() {
      return askLlmNote()
    }
  }
]

/** Text that the 复制 button puts on the clipboard: exactly the prompt. */
export function copyText(card: AskPrompt): string {
  return card.prompt
}
