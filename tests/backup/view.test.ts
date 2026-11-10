import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { BACKUP_EXCLUDED, BACKUP_INCLUDED } from '../../src/main/backup/api'
import { ALLOWED_DIRS, ALLOWED_FILES } from '../../src/main/backup/service'
import { exportLines, inspectionLines, restoreLines } from '../../src/renderer/src/components/backup/backupView'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` tests at the end.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

describe('backup view-model', () => {
  it('UI lists match the service allowlist and name the X8 exclusions', () => {
    const shown = BACKUP_INCLUDED.map((i) => i.path)
    for (const d of ALLOWED_DIRS) expect(shown).toContain(`lens/${d}/`)
    for (const f of ALLOWED_FILES) expect(shown).toContain(`lens/${f}`)
    const ex = BACKUP_EXCLUDED.map((e) => `${e.path} ${e.reason}`).join('\n')
    expect(ex).toMatch(/ed25519\.key\.enc/)
    expect(ex).toMatch(/grants\.json/)
    expect(ex).toMatch(/audit\.db/)
  })

  it('export / inspection lines; cancel → null', () => {
    expect(exportLines({ cancelled: true, path: null, files: 0, bytes: 0, modelSnapshot: null, excluded: [], skipped: [] })).toBeNull()
    const l = exportLines({ cancelled: false, path: '/b/navalia-backup-x', files: 3, bytes: 2048, modelSnapshot: 'included', excluded: [], skipped: [{ path: 'lens/cards/l', reason: '符号链接' }] })!
    expect(l.join('\n')).toMatch(/2\.0 KB/)
    expect(l.join('\n')).toMatch(/已包含/)
    expect(l.join('\n')).toMatch(/跳过 1 项/)
    const i = inspectionLines({
      cancelled: false,
      inspectionId: 'a'.repeat(24),
      name: 'navalia-backup-x',
      createdAt: '2026-11-05T09:30:00.000Z',
      appVersion: '0.1.0',
      counts: { workflows: 2, peers: 1, cards: 0, files: 5, bytes: 100 },
      modelSnapshot: true
    })!
    expect(i.join('\n')).toMatch(/不会写入 Runtime/)
  })

  it('restore lines report failures and archive-only parts', () => {
    const lines = restoreLines({
      name: 'navalia-backup-x',
      workflows: { imported: 1, duplicates: 2, failed: 1, items: [{ title: 'wf-bad', outcome: 'failed', detail: 'schema' }] },
      peers: { added: 0, updated: 0, unchanged: 0, failed: 1, items: [{ fingerprint: 'f'.repeat(64), outcome: 'failed', detail: 'tampered' }] },
      notRestored: ['模型快照（仅供存档）']
    }).join('\n')
    expect(lines).toMatch(/分叉另存副本 1，已存在 2，失败 1/)
    expect(lines).toMatch(/验签失败 1/)
    expect(lines).toMatch(/wf-bad/)
    expect(lines).toMatch(/仅存档/)
  })
})

describe('S1-R3-06 backup view', () => {
  it('export lines state the snapshot is redacted and the Access log status; restore lines report cards and history', () => {
    const l = exportLines({ cancelled: false, path: '/b/x', files: 3, bytes: 10, modelSnapshot: 'included', accessLogRows: 4, excluded: [], skipped: [] })!.join('\n')
    expect(l).toMatch(/已脱敏/)
    expect(l).toMatch(/Access log：已包含 4 条/)
    const r = restoreLines({
      name: 'x',
      workflows: { imported: 1, duplicates: 0, failed: 0, items: [{ title: 't', outcome: 'imported', detail: 'imp-1', versions: 2 }] },
      peers: { added: 0, updated: 0, unchanged: 0, failed: 0, items: [] },
      cards: { restored: 1, archived: 2, unchanged: 0, failed: 1, items: [{ cardId: 'card_x', outcome: 'failed', detail: '验签失败：signature' }] },
      notRestored: []
    }).join('\n')
    expect(r).toMatch(/共恢复 2 个版本/)
    expect(r).toMatch(/卡片：恢复 1，存档（签发者不是当前身份）2/)
    expect(r).toMatch(/card_x 失败/)
  })
})

import { EXPORT_FORM_DEFAULT, exportFormError, previewLines } from '../../src/renderer/src/components/backup/backupView'

describe('C21 backup view-model', () => {
  it('every opt-in defaults off; encryption needs a matching passphrase of ≥ 8 characters', () => {
    expect(EXPORT_FORM_DEFAULT).toMatchObject({ includeAccessLog: false, includeChat: false, includeMeetings: false, includeMoments: false, encrypt: false })
    expect(exportFormError(EXPORT_FORM_DEFAULT)).toBeNull()
    expect(exportFormError({ ...EXPORT_FORM_DEFAULT, encrypt: true, passphrase: 'short', passphraseAgain: 'short' })).toMatch(/至少 8/)
    expect(exportFormError({ ...EXPORT_FORM_DEFAULT, encrypt: true, passphrase: 'long enough', passphraseAgain: 'long enougH' })).toMatch(/不一致/)
    expect(exportFormError({ ...EXPORT_FORM_DEFAULT, encrypt: true, passphrase: 'long enough', passphraseAgain: 'long enough' })).toBeNull()
  })

  it('preview lines name the action per Workflow before anything is written', () => {
    const lines = previewLines({
      workflows: [
        { id: 'a', title: '周报', action: 'local_newer', versions: 0, detail: '本机已有 v4' },
        { id: 'b', title: '发版', action: 'merge', versions: 2, detail: null }
      ],
      cards: { valid: 2, invalid: 1 },
      peers: 1,
      userData: { chat: 0, meetings: 1, moments: 0 },
      accessLog: false
    }).join('\n')
    expect(lines).toMatch(/「周报」：本机更新，保留本机/)
    expect(lines).toMatch(/「发版」：追加备份里更新的版本（写入 2 个版本）/)
    expect(lines).toMatch(/1 张无效将跳过/)
    expect(lines).toMatch(/会议转写 1/)
  })
})

import { exportLines, trustLine } from '../../src/renderer/src/components/backup/backupView'

describe('C21 signature trust in the view-model', () => {
  it('says which restore mode applies and why', () => {
    expect(trustLine({ mode: 'mine', fingerprint: 'ab'.repeat(32), reason: '由你的 Navalia 身份签名' })).toMatch(/按原 ID/)
    expect(trustLine({ mode: 'foreign', fingerprint: 'cd'.repeat(32), reason: '签名者不是你当前或以前的 Navalia 身份' })).toMatch(/只以导入副本/)
    expect(trustLine({ mode: 'unsigned', fingerprint: null, reason: '备份没有签名' })).toMatch(/备份没有签名 → Workflow 只以导入副本/)
    const base = { cancelled: false, path: '/x', files: 1, bytes: 1, modelSnapshot: null, excluded: [], skipped: [] }
    expect(exportLines({ ...base, signed: false, signReason: '还没有创建 Navalia 身份（卡片签名密钥）' })!.join('\n')).toMatch(/未签名（还没有创建 Navalia 身份/)
    expect(exportLines({ ...base, signed: true, signReason: null })!.join('\n')).toMatch(/已用你的 Navalia 身份密钥签名/)
  })
})

describe('en: English UI text', () => {
  it('en: view-model lines and labels read in English', () => {
    setLocale('en')
    const l = exportLines({ cancelled: false, path: '/b/x', files: 3, bytes: 10, modelSnapshot: 'included', accessLogRows: 4, excluded: [], skipped: [] })!.join('\n')
    expect(l).toMatch(/Saved to: \/b\/x/)
    expect(l).toMatch(/redacted/)
    expect(l).toMatch(/Access log: 4 records included/)
    expect(exportFormError({ ...EXPORT_FORM_DEFAULT, encrypt: true, passphrase: 'short', passphraseAgain: 'short' })).toBe('Passphrase must be at least 8 characters.')
    expect(trustLine({ mode: 'unsigned', fingerprint: null, reason: 'The backup is not signed' })).toMatch(/only as imported copies/)
    expect(BACKUP_INCLUDED.find((i) => i.path === 'lens/peers/')!.label).toBe('Peers (cards signed by them)')
  })

  it('manifest text stays Chinese (on-disk) while the UI text follows the locale', () => {
    setLocale('en')
    const id = BACKUP_EXCLUDED.find((e) => e.path === 'identity/')!
    expect(id.reason).toMatch(/私钥只留在本机钥匙串加密/)
    expect(id.shown).toMatch(/never exported/)
    setLocale('zh')
    expect(id.shown).toBe(id.reason)
  })
})
