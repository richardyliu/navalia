// C23 copy fixes: onboarding must not claim 「不联网 / 没有云端 / 没有账号」 unconditionally now that
// opt-in cloud features exist; CloudSetup's off-state line must be context-neutral by default.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { welcomePrivacyCopy } from '../../src/renderer/src/components/onboarding/flow'
import { setLocale } from '../../src/shared/i18n'

const root = path.join(__dirname, '..', '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

const ONBOARDING_SOURCES = [
  'src/renderer/src/pages/Onboarding.tsx',
  'src/renderer/src/components/onboarding/flow.ts',
  'src/main/onboarding/api.ts',
  'src/main/onboarding/store.ts',
  'src/main/onboarding/ipc.ts'
]

describe('onboarding privacy copy (C23)', () => {
  it('welcome copy says local by default and cloud is optional and off until enabled', () => {
    const en = welcomePrivacyCopy()
    expect(en).toContain('by default')
    expect(en).toContain('optional and off by default')
    expect(en).toContain('turn them on')
    setLocale('zh')
    try {
      const zh = welcomePrivacyCopy()
      expect(zh).toContain('默认')
      expect(zh).toContain('不联网')
      expect(zh).toContain('可选')
      expect(zh).toContain('默认关闭')
      expect(zh).toContain('开启')
    } finally {
      setLocale('en')
    }
    expect(read('src/renderer/src/pages/Onboarding.tsx')).toContain('{welcomePrivacyCopy()}')
  })

  it('no unconditional 「不联网 / 没有云端 / 没有账号」 claim anywhere in onboarding', () => {
    for (const rel of ONBOARDING_SOURCES) {
      const src = read(rel)
      expect(src, rel).not.toContain('没有云端')
      expect(src, rel).not.toContain('没有账号')
      expect(src, rel).not.toContain('Lens 不联网')
      // Every 「不联网」 must be qualified by 「默认」 in the same sentence.
      for (const m of src.matchAll(/不联网/g)) {
        const start = Math.max(src.lastIndexOf('。', m.index!), src.lastIndexOf('\n', m.index!))
        const sentence = src.slice(start + 1, m.index! + 3)
        expect(sentence, `${rel}: ${sentence}`).toContain('默认')
      }
    }
  })
})

describe('CloudSetup off-state copy (C23)', () => {
  const src = read('src/renderer/src/components/chat/CloudSetup.tsx')

  it('is context-neutral by default and accepts a per-page offText', () => {
    const m = src.match(/export function cloudOffNeutral\(\): string \{\s*return tr\(\s*'[^']+',\s*'([^']+)'/)
    expect(m).not.toBeNull()
    const neutral = m![1]
    expect(neutral).not.toContain('预览')
    expect(neutral).not.toContain('上下文')
    expect(neutral).toContain('默认关闭')
    expect(src).toContain("gate.state === 'off' ? offText ?? cloudOffNeutral() : gate.text")
    expect(src).toMatch(/offText\?: string/)
  })

  it('keeps the existing behaviour: same IPC calls, confirm flag, not-E2EE note', () => {
    expect(src).toContain('window.lens.cloud.configure({ enabled: true, baseUrl: url.trim(), confirm: true })')
    expect(src).toContain('window.lens.cloud.signIn()')
    expect(src).toContain('window.lens.cloud.signOut()')
    expect(src).toContain('{notE2eeNote()}')
    expect(src).toContain('data-testid="chat-cloud-setup"')
  })
})
