// S1-R3-08 / S1-R3-09, updated for S1-R4-05: X9 (local notifications) is approved since 2026-11-05
// (DECISIONS-ROUND3 §1), but ONLY inside the opt-in proactive module src/main/proactive/**. The Ask /
// save-answer / OCR-status code still adds no proactive surface (Tray, Notification, globalShortcut,
// timers) and no network module, and no other file in src/ may use Notification.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const FILES = [
  'src/main/mcp/save-answer.ts',
  'src/main/mcp/save-answer-api.ts',
  'src/preload/ask.ts',
  'src/renderer/src/pages/Ask.tsx',
  'src/renderer/src/components/ask/SaveAnswerCard.tsx',
  'src/renderer/src/components/ask/OcrStatusPanel.tsx',
  'src/renderer/src/components/ask/ocrStatus.ts'
]

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (fs.statSync(abs).isFile()) return [rel]
  return fs.readdirSync(abs).flatMap((n) => files(path.join(rel, n)))
}

describe('no proactive layer, no network in S1-R3-08/09 code', () => {
  it.each(FILES)('%s', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    expect(src).not.toMatch(/\bTray\b|\bNotification\b|globalShortcut|setInterval\(|refetchInterval|powerMonitor/)
    expect(src).not.toMatch(/from 'node:(https?|http2|net|tls|dgram|dns)'|\bfetch\(|XMLHttpRequest|WebSocket|EventSource/)
  })
})

describe('X9: notifications only in the proactive module', () => {
  it('no file outside src/main/proactive uses Notification (Electron or Web)', () => {
    const offenders = files('src')
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
      .filter((f) => !f.split(path.sep).join('/').startsWith('src/main/proactive/'))
      .filter((f) => /\bNotification\b|showNotification|requestPermission\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('inside the module, only main.ts constructs one', () => {
    const users = files('src/main/proactive').filter((f) => /new Notification\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(users.map((f) => f.split(path.sep).join('/'))).toEqual(['src/main/proactive/main.ts'])
  })
})
