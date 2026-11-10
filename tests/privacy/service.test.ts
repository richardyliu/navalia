import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, beforeEach } from 'vitest'
import { ENTRY_NAME, createAgentManager } from '../../src/main/broker/agents'
import { openAuditLog } from '../../src/main/broker/audit'
import { createGrantStore } from '../../src/main/identity/grants'
import { PRIVACY_CONFIRM_SPECS, PRIVACY_CONFIRM_TTL_MS, createPrivacyConfirmGate } from '../../src/main/privacy/confirm'
import { CLEAN_ARGS, createPrivacyService, type PrivacyDeps } from '../../src/main/privacy/service'
import type { CliRun } from '../../src/main/recovery/exec'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import { createMaintenanceLock } from '../../src/main/runtime/maintenance-lock'
import { PRIVACY_DIALOG_TEXT, privacyConfirmDialog } from '../../src/main/privacy/main'
import { setLocale } from '../../src/shared/i18n'

// Most assertions below pin the Chinese UI text (unchanged in zh); English is covered by the `en:` test(s) in this file.
beforeEach(() => setLocale('zh'))
afterEach(() => setLocale('en'))

const roots: string[] = []
afterEach(() => {
  const prefix = path.join(os.tmpdir(), 'lens-priv-')
  for (const r of roots.splice(0)) if (r.startsWith(prefix)) fs.rmSync(r, { recursive: true, force: true })
})
const temp = (label: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lens-priv-${label}-`))
  roots.push(d)
  return d
}
const URL_ = 'http://127.0.0.1:8750/mcp'

function setup(over: Partial<PrivacyDeps> & { up?: boolean } = {}) {
  const home = temp('home')
  const apps = temp('apps')
  const store = ensureStore(storePaths(temp('store')))
  const runtimeRoot = temp('rt')
  const grants = createGrantStore(store)
  const agents = createAgentManager({ env: { home, applications: apps }, grants, brokerUrl: () => URL_ })
  const calls: string[][] = []
  let up = over.up ?? false
  let t = 1_000_000
  const ok: CliRun = { exitCode: 0, timedOut: false, truncated: false, durationMs: 1, output: 'done', spawnFailed: false }
  const confirm = createPrivacyConfirmGate({ now: () => t })
  const dialogs: Array<{ action: string; sender: unknown }> = []
  let dialogAnswer: boolean | Error = true
  const service = createPrivacyService({
    locate: () => ({ root: runtimeRoot, port: 65_000, bin: '/fake/persome', configPath: path.join(runtimeRoot, 'config.toml') }) as never,
    grants,
    agents,
    appVersion: () => '0.1.0',
    confirm,
    homeDir: home,
    exec: async (_bin, args) => {
      calls.push([...args])
      if (args[0] === 'stop') up = false
      return ok
    },
    isUp: async () => up,
    startRuntime: async () => {
      calls.push(['<start>'])
      up = true
    },
    sleep: async () => undefined,
    // OG3: fake main-owned native dialog; records what was asked and with which sender.
    confirmDialog: async (action, sender) => {
      dialogs.push({ action, sender })
      if (dialogAnswer instanceof Error) throw dialogAnswer
      return dialogAnswer
    },
    lock: createMaintenanceLock(),
    ...over
  })
  return {
    home,
    store,
    grants,
    agents,
    service,
    calls,
    dialogs,
    answer: (a: boolean | Error) => (dialogAnswer = a),
    advance: (ms: number) => (t += ms)
  }
}

const phrase = (a: keyof typeof PRIVACY_CONFIRM_SPECS) => PRIVACY_CONFIRM_SPECS[a].phrase

describe('delete: nonce flow guards the Runtime clean command', () => {
  test('happy path, Runtime running: stop → clean captures → start; Lens passes only whitelisted args', async () => {
    const s = setup({ up: true })
    const ch = s.service.confirmIssue('delete-captures')
    const r = await s.service.deleteRun('captures', ch.nonce, ch.phrase, false)
    expect(s.calls).toEqual([['stop'], ['clean', 'captures', '--yes'], ['<start>']])
    expect(r).toMatchObject({ target: 'captures', ok: true, backup: null, runtimeRestarted: true })
  })

  test('Runtime not running: no stop, no restart', async () => {
    const s = setup({ up: false })
    const ch = s.service.confirmIssue('delete-timeline')
    const r = await s.service.deleteRun('timeline', ch.nonce, ch.phrase, false)
    expect(s.calls).toEqual([['clean', 'timeline', '--yes']])
    expect(r.runtimeRestarted).toBe(false)
  })

  test('wrong phrase → nothing executed; the nonce is burnt', async () => {
    const s = setup({ up: true })
    const ch = s.service.confirmIssue('delete-all')
    await expect(s.service.deleteRun('all', ch.nonce, '删除', false)).rejects.toThrow(/确认短语不正确/)
    await expect(s.service.deleteRun('all', ch.nonce, ch.phrase, false)).rejects.toThrow(/已失效/)
    expect(s.calls).toEqual([])
  })

  test('expired nonce → nothing executed', async () => {
    const s = setup()
    const ch = s.service.confirmIssue('delete-memory')
    s.advance(PRIVACY_CONFIRM_TTL_MS + 1)
    await expect(s.service.deleteRun('memory', ch.nonce, ch.phrase, false)).rejects.toThrow(/过期|已失效/)
    expect(s.calls).toEqual([])
  })

  test('replay of a used nonce → refused, clean runs exactly once', async () => {
    const s = setup()
    const ch = s.service.confirmIssue('delete-captures')
    await s.service.deleteRun('captures', ch.nonce, ch.phrase, false)
    await expect(s.service.deleteRun('captures', ch.nonce, ch.phrase, false)).rejects.toThrow(/已失效/)
    expect(s.calls.filter((c) => c[0] === 'clean')).toHaveLength(1)
  })

  test('a captures nonce cannot authorize deleting memory', async () => {
    const s = setup()
    const ch = s.service.confirmIssue('delete-captures')
    await expect(s.service.deleteRun('memory', ch.nonce, phrase('delete-memory'), false)).rejects.toThrow(/不匹配/)
    expect(s.calls).toEqual([])
  })

  test('backup first: cancelled backup → nothing deleted; completed backup → reported by name', async () => {
    let n = 0
    const s = setup({
      backup: async () => (n++ === 0 ? { cancelled: true, path: null, files: 0 } : { cancelled: false, path: '/x/y/navalia-backup-20261105', files: 7 })
    })
    const c1 = s.service.confirmIssue('delete-memory')
    await expect(s.service.deleteRun('memory', c1.nonce, c1.phrase, true)).rejects.toThrow(/备份已取消/)
    expect(s.calls).toEqual([])
    const c2 = s.service.confirmIssue('delete-memory')
    const r = await s.service.deleteRun('memory', c2.nonce, c2.phrase, true)
    expect(r.backup).toEqual({ name: 'navalia-backup-20261105', files: 7 })
    expect(s.calls).toEqual([['clean', 'memory', '--yes']])
  })

  test('backup first without a backup provider is refused before any deletion', async () => {
    const s = setup({ backup: undefined })
    const ch = s.service.confirmIssue('delete-all')
    await expect(s.service.deleteRun('all', ch.nonce, ch.phrase, true)).rejects.toThrow(/不支持先备份/)
    expect(s.calls).toEqual([])
  })

  test('Runtime that will not stop → refuses to clean', async () => {
    const s = setup({ up: true, isUp: async () => true, stopWaitMs: 0 })
    const ch = s.service.confirmIssue('delete-captures')
    await expect(s.service.deleteRun('captures', ch.nonce, ch.phrase, false)).rejects.toThrow(/仍在运行/)
    expect(s.calls).toEqual([['stop']])
  })

  test('clean args are fixed vectors with --yes; no path or renderer input', () => {
    for (const [t, args] of Object.entries(CLEAN_ARGS)) expect(args).toEqual(['clean', t, '--yes'])
  })
})

describe('withdraw: revokes every grant and disconnects agents, Access log untouched', () => {
  test('two connected agents + a manual grant → all revoked, configs cleaned, audit rows kept', async () => {
    const s = setup()
    fs.writeFileSync(path.join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { persome: { type: 'stdio' } } }), { mode: 0o600 })
    fs.mkdirSync(path.join(s.home, '.codex'))
    fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "x"\n')
    s.agents.connect('claude-code')
    s.agents.connect('codex')
    s.grants.create({ client: 'other-client', label: 'manual' })
    expect(s.grants.list().filter((g) => g.state === 'active')).toHaveLength(3)

    const audit = openAuditLog(s.store.auditDb)
    audit.record({ grantId: null, client: 'claude-code', capability: 'search', argsSha256: 'h', argsPreview: '{}', itemIds: [], itemCount: 0, responseChars: 3, resultPreview: '', outcome: 'ok', httpStatus: 200, errorCode: null, durationMs: 1 })
    const auditBytes = fs.readFileSync(s.store.auditDb)

    const ch = s.service.confirmIssue('withdraw-all')
    const r = await s.service.withdrawRun(ch.nonce, ch.phrase)
    expect(r.grantsRevoked).toBe(3)
    expect(r.activeAfter).toBe(0)
    expect(r.accessLogTouched).toBe(false)
    expect(r.agentsDisconnected.sort()).toEqual(['Claude Code', 'Codex'])
    expect(s.grants.list().every((g) => g.revokedAt !== null)).toBe(true)
    const claude = JSON.parse(fs.readFileSync(path.join(s.home, '.claude.json'), 'utf8'))
    expect(claude.mcpServers[ENTRY_NAME]).toBeUndefined()
    expect(claude.mcpServers.persome).toEqual({ type: 'stdio' })
    expect(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8')).not.toContain(ENTRY_NAME)

    expect(audit.list({ days: 30 })).toHaveLength(1)
    expect(fs.readFileSync(s.store.auditDb).equals(auditBytes)).toBe(true)
    audit.close()
  })

  test('wrong phrase / replay → no grant revoked', async () => {
    const s = setup()
    s.grants.create({ client: 'x', label: 'x' })
    const ch = s.service.confirmIssue('withdraw-all')
    await expect(s.service.withdrawRun(ch.nonce, '撤回')).rejects.toThrow(/确认短语不正确/)
    await expect(s.service.withdrawRun(ch.nonce, ch.phrase)).rejects.toThrow(/已失效/)
    expect(s.grants.list()[0].state).toBe('active')
  })

  test('nothing connected → zero revoked, still succeeds', async () => {
    const s = setup()
    const ch = s.service.confirmIssue('withdraw-all')
    const r = await s.service.withdrawRun(ch.nonce, ch.phrase)
    expect(r).toMatchObject({ agentsDisconnected: [], grantsRevoked: 0, activeAfter: 0, warnings: [] })
  })
})

describe('OG3: a main-owned native dialog must also confirm (renderer alone cannot complete)', () => {
  test('delete: phrase right but dialog cancelled → nothing executed, nonce burnt', async () => {
    const s = setup({ up: true })
    s.answer(false)
    const sender = { id: 42 }
    const ch = s.service.confirmIssue('delete-all')
    await expect(s.service.deleteRun('all', ch.nonce, ch.phrase, false, sender)).rejects.toThrow(/已在确认对话框中取消，未删除任何数据/)
    expect(s.calls).toEqual([])
    expect(s.dialogs).toEqual([{ action: 'delete-all', sender }])
    s.answer(true)
    await expect(s.service.deleteRun('all', ch.nonce, ch.phrase, false, sender)).rejects.toThrow(/已失效/)
    expect(s.calls).toEqual([])
  })

  test('delete: dialog shown only after the phrase is accepted; wrong phrase never reaches it', async () => {
    const s = setup()
    const ch = s.service.confirmIssue('delete-memory')
    await expect(s.service.deleteRun('memory', ch.nonce, '错的', false)).rejects.toThrow(/确认短语不正确/)
    expect(s.dialogs).toEqual([])
  })

  test('delete: dialog confirmed → runs; backup prompt comes after the dialog', async () => {
    const order: string[] = []
    const s = setup({
      backup: async () => (order.push('backup'), { cancelled: false, path: '/x/b', files: 1 }),
      confirmDialog: async () => (order.push('dialog'), true)
    })
    const ch = s.service.confirmIssue('delete-captures')
    const r = await s.service.deleteRun('captures', ch.nonce, ch.phrase, true)
    expect(order).toEqual(['dialog', 'backup'])
    expect(r.ok).toBe(true)
    expect(s.calls).toEqual([['clean', 'captures', '--yes']])
  })

  test('a dialog that throws counts as cancel', async () => {
    const s = setup()
    s.answer(new Error('no window'))
    const ch = s.service.confirmIssue('delete-timeline')
    await expect(s.service.deleteRun('timeline', ch.nonce, ch.phrase, false)).rejects.toThrow(/取消/)
    expect(s.calls).toEqual([])
  })

  test('no dialog provider → fail closed for delete and withdraw', async () => {
    const s = setup({ confirmDialog: undefined })
    s.grants.create({ client: 'x', label: 'x' })
    const d = s.service.confirmIssue('delete-all')
    await expect(s.service.deleteRun('all', d.nonce, d.phrase, false)).rejects.toThrow(/无法显示确认对话框/)
    const w = s.service.confirmIssue('withdraw-all')
    await expect(s.service.withdrawRun(w.nonce, w.phrase)).rejects.toThrow(/无法显示确认对话框/)
    expect(s.calls).toEqual([])
    expect(s.grants.list()[0].state).toBe('active')
  })

  test('withdraw: dialog cancelled → no grant revoked, nonce burnt', async () => {
    const s = setup()
    s.grants.create({ client: 'x', label: 'x' })
    s.answer(false)
    const ch = s.service.confirmIssue('withdraw-all')
    await expect(s.service.withdrawRun(ch.nonce, ch.phrase, { id: 7 })).rejects.toThrow(/未撤回任何连接/)
    expect(s.dialogs).toEqual([{ action: 'withdraw-all', sender: { id: 7 } }])
    expect(s.grants.list()[0].state).toBe('active')
    s.answer(true)
    await expect(s.service.withdrawRun(ch.nonce, ch.phrase)).rejects.toThrow(/已失效/)
  })

  test('privacyConfirmDialog: per-action title + label, detail = the gate warning, sender passed through', async () => {
    const seen: unknown[] = []
    const dialog = privacyConfirmDialog(async (sender, opts) => (seen.push({ sender, opts }), false))
    for (const action of Object.keys(PRIVACY_DIALOG_TEXT) as Array<keyof typeof PRIVACY_DIALOG_TEXT>) {
      expect(await dialog(action, 'S')).toBe(false)
    }
    expect(seen).toHaveLength(5)
    expect(seen[0]).toEqual({
      sender: 'S',
      opts: { ...PRIVACY_DIALOG_TEXT['delete-captures'], detail: PRIVACY_CONFIRM_SPECS['delete-captures'].warning }
    })
  })
})

describe('en: English UI text', () => {
  test('en: wrong phrase and cancelled dialog read in English', async () => {
    setLocale('en')
    const s = setup({ up: true })
    const ch = s.service.confirmIssue('delete-all')
    expect(ch.phrase).toBe('delete all personal data')
    await expect(s.service.deleteRun('all', ch.nonce, 'delete', false)).rejects.toThrow(/confirmation phrase is incorrect/)
    expect(s.calls).toEqual([])
    expect(PRIVACY_DIALOG_TEXT['delete-all']).toEqual({ message: 'Delete all personal data?', confirmLabel: 'Delete all personal data' })
  })
})
