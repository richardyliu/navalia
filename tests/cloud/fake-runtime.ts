// Fake Runtime MCP (`ossTool`) for the chat / context tests. No real Runtime, no ~/.persome.
import { vi } from 'vitest'

/** Stands in for the Runtime local token (scrubbed verbatim via knownSecrets). */
export const SECRET = 'rt_LOCALTOKEN_9f8e7d6c5b4a'

export function fakeOss(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const base: Record<string, (args: Record<string, unknown>) => unknown> = {
    search: () => ({
      query: 'q',
      results: [
        { id: 'mem-a', path: '/Users/bob/.persome/memory/project-lens.md', timestamp: '2026-11-04T09:00:00', content: `Lens 项目这周在做云端对话。token=${SECRET}` },
        { id: 'mem-b', path: 'person-alice.md', content: 'Alice 的邮箱 alice@example.com，电话 13812345678' },
        { id: 'mem-c', path: 'note.md', content: '截图在 /Users/bob/.persome/screenshots/2026/11/04/a.png ，库在 /Users/bob/.persome/index.db\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }
      ]
    }),
    behavior_patterns: () => ({
      root: { signature: '一个在做个人模型产品的工程师', confidence: 0.8 },
      faces: [
        { signature: '晚上写代码', observations: 3, confidence: 0.5 },
        { signature: '这周 Lens 云端对话 优先', observations: 9, confidence: 0.7 }
      ],
      skills: [{ path: 'skills/skill-release.md', description: '发版流程', playbook: '1. 跑测试 2. 打包', entry_id: 'sk-1' }],
      rendered: ''
    }),
    recent_activity: () => ({ count: 1, entries: [{ id: 'mem-r', path: 'event-x.md', timestamp: '2026-11-05T08:00:00', content: '今天早上开了 Lens 周会' }] }),
    ...overrides
  }
  const ossTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    const fn = base[name]
    if (!fn) throw new Error(`no tool ${name}`)
    const out = fn(args)
    if (out instanceof Error) throw out
    return JSON.stringify(out)
  })
  return { ossTool, calls }
}

