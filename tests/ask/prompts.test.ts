import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import ossTools from '../../src/main/broker/oss-tools.json'
import { OSS_TOOL_NAMES, toolMeta } from '../../src/main/broker/catalog'
import { ASK_PROMPTS, askLlmNote, askServerNote, copyText } from '../../src/renderer/src/components/ask/prompts'
import { requiredScopes } from '../../src/renderer/src/components/ask/askView'
import type { AskPrompt } from '../../src/renderer/src/components/ask/prompts'

/** Tools the card names that the Broker catalog does not expose (should always be empty). */
const unknownTools = (card: AskPrompt): string[] => card.tools.filter((t) => !toolMeta(t))
/** True when every tool is a read-only, non-LLM tool (the Ask cards never ask for writes). */
const readOnlyCard = (card: AskPrompt): boolean =>
  card.tools.every((t) => {
    const meta = toolMeta(t)
    return Boolean(meta) && !meta!.write && !meta!.llm
  })

describe('Ask prompt cards', () => {
  it('are stable: ids and tool lists', () => {
    expect(ASK_PROMPTS.map((c) => [c.id, c.tools])).toEqual([
      ['who-am-i', ['behavior_patterns', 'entity_graph']],
      ['weekly-progress', ['recent_activity', 'search']],
      ['wechat-groups', ['search_captures', 'read_recent_capture']],
      ['past-decisions', ['search', 'read_memory', 'read_receipt']]
    ])
    expect(new Set(ASK_PROMPTS.map((c) => c.id)).size).toBe(ASK_PROMPTS.length)
  })

  it('has at least 4 cards', () => {
    expect(ASK_PROMPTS.length).toBeGreaterThanOrEqual(4)
  })

  it('every tool exists in the Broker catalog AND in the Runtime OSS tool list, read-only and non-LLM', () => {
    const runtimeNames = (ossTools as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    for (const card of ASK_PROMPTS) {
      expect(unknownTools(card)).toEqual([])
      expect(readOnlyCard(card)).toBe(true)
      for (const t of card.tools) {
        expect(OSS_TOOL_NAMES).toContain(t)
        expect(runtimeNames).toContain(t)
        expect(toolMeta(t)?.origin).toBe('oss')
        // The prompt text actually names every expected tool.
        expect(card.prompt).toContain(t)
      }
    }
  })

  it('required scopes come from the catalog', () => {
    const byId = Object.fromEntries(ASK_PROMPTS.map((c) => [c.id, requiredScopes(c)]))
    expect(byId['who-am-i']).toEqual(['model:search'])
    expect(byId['weekly-progress']).toEqual(['now:read', 'model:search'])
    expect(byId['wechat-groups']).toEqual(['model:search', 'now:read'])
    expect(byId['past-decisions']).toEqual(['model:search', 'evidence:read'])
  })

  it('every card carries the "Navalia does not call an LLM" note', () => {
    expect(askLlmNote()).toBe('Results come from the external Agent; Navalia does not call an LLM')
    for (const card of ASK_PROMPTS) {
      expect(card.note).toBe(askLlmNote())
      expect(card.note).toContain('Navalia does not call an LLM')
    }
  })

  it('copy text is exactly the prompt text', () => {
    for (const card of ASK_PROMPTS) expect(copyText(card)).toBe(card.prompt)
  })

  it('prompts ask for sources and for unverified marking', () => {
    for (const card of ASK_PROMPTS) {
      expect(card.prompt).toMatch(/source/)
      expect(card.prompt).toContain('unverified')
    }
  })

  it('contain no secrets, tokens, absolute paths or URLs', () => {
    const all = [askServerNote(), ...ASK_PROMPTS.flatMap((c) => [c.title, c.summary, c.prompt, ...c.limits])].join('\n')
    expect(all).not.toMatch(/token|bearer|secret|password|api[_-]?key|sk-[A-Za-z0-9]/i)
    expect(all).not.toMatch(/\/Users\/|\/home\/|~\/|[A-Za-z]:\\/)
    expect(all).not.toMatch(/https?:\/\//)
    expect(all).not.toMatch(/[A-Za-z0-9+/]{32,}/)
  })

  it('WeChat card states the honest limits', () => {
    const w = ASK_PROMPTS.find((c) => c.id === 'wechat-groups')!
    const text = w.limits.join('\n')
    expect(text).toMatch(/on screen/)
    expect(text).toMatch(/OCR/)
    expect(text).toMatch(/captured/)
    expect(text).toMatch(/reads the WeChat local database/)
    expect(w.prompt).toMatch(/chat history that never appeared on screen is not included/)
  })
})

describe('Ask prompt cards in Chinese', () => {
  afterEach(() => setLocale('en'))
  it('keep the original Chinese text, sources and 未核实 marking when the locale is zh', () => {
    setLocale('zh')
    expect(askLlmNote()).toBe('结果由外部 Agent 生成，Navalia 不调用 LLM')
    for (const card of ASK_PROMPTS) {
      expect(card.note).toContain('Navalia 不调用 LLM')
      expect(card.prompt).toMatch(/来源/)
      expect(card.prompt).toContain('未核实')
      for (const t of card.tools) expect(card.prompt).toContain(t)
    }
    const w = ASK_PROMPTS.find((c) => c.id === 'wechat-groups')!
    expect(w.limits.join('\n')).toMatch(/不读取微信的本地数据库/)
    expect(w.prompt).toMatch(/没有出现在屏幕上的聊天记录不在里面/)
    const all = [askServerNote(), ...ASK_PROMPTS.flatMap((c) => [c.title, c.summary, c.prompt, ...c.limits])].join('\n')
    expect(all).not.toMatch(/token|bearer|secret|password|api[_-]?key|sk-[A-Za-z0-9]/i)
  })
})
