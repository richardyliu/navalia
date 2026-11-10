import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { defaultBackupFirst } from '../../src/renderer/src/components/settings/privacyView'

describe('OG-D7 backup-first default', () => {
  it('defaults to backing up before every delete target', () => {
    for (const t of ['captures', 'timeline', 'memory', 'all'] as const) expect(defaultBackupFirst(t)).toBe(true)
  })
})

describe('VIS-07 Home brief read error', () => {
  it('Home surfaces the recent-activity read error instead of zero counts', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/src/pages/Home.tsx'), 'utf8')
    expect(src).toMatch(/const briefQ = recent\.isError\s*\?\s*\{ isLoading: false, isError: true as const, error: recent\.error/)
  })
})
