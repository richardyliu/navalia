// Phase 5 gate: the cloud panel exposes right-to-deletion and shows the account fingerprint.
// (No jsdom: pure helper + static source checks, like the other renderer tests.)
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprintShort } from '../../src/renderer/src/components/chat/CloudSetup'

const SRC = fs.readFileSync(path.resolve('src/renderer/src/components/chat/CloudSetup.tsx'), 'utf8')

describe('CloudSetup: account fingerprint + delete account', () => {
  it('fingerprintShort shows head…tail of a 64-hex fingerprint', () => {
    const fp = 'a'.repeat(8) + '0'.repeat(48) + 'b'.repeat(8)
    expect(fingerprintShort(fp)).toBe('aaaaaaaa…bbbbbbbb')
    expect(fingerprintShort('acct_x')).toBe('acct_x')
  })

  it('signed-in panel calls deleteAccount with confirm:true (main adds its own native confirm)', () => {
    expect(SRC).toMatch(/window\.lens\.cloud\.deleteAccount\(\{ confirm: true \}\)/)
    expect(SRC).toContain('删除云端账号…')
    expect(SRC).toContain('cloud-account-fingerprint')
  })
})
