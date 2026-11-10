// Pure view-model for the 连接器 page (tested in tests/connectors/view.test.ts). No DOM, no window.
import {
  consentKindOf,
  type CalendarTarget,
  type ConnectorCommitResult,
  type ConnectorItem,
  type ConnectorKind,
  type ConnectorPreview,
  type ConsentView,
  type CsvMapping,
  type DeleteImportedResult,
  type ImapConfigInput,
  type LedgerConnectorView
} from '../../../main/connectors/api'
import { tr } from '../lib/i18n'

export const KIND_LABEL: Record<ConnectorKind, string> = {
  get calendar() {
    return tr('Calendar (.ics)', '日历（.ics）')
  },
  get health() {
    return tr('Health / workouts (CSV / JSON / Apple Health)', '健康 / 训练（CSV / JSON / Apple Health）')
  },
  get email() {
    return tr('Email (.eml / mbox)', '邮件（.eml / mbox）')
  },
  get csv() {
    return tr('Generic CSV', '通用 CSV')
  },
  get imap() {
    return tr('IMAP mailbox', 'IMAP 邮箱')
  }
}
export const KIND_ORDER: readonly ConnectorKind[] = ['calendar', 'health', 'email', 'imap', 'csv']

/** Column header for the item list. */
export const ITEM_LABEL: Record<ConnectorKind, string> = {
  get calendar() {
    return tr('Event', '事件')
  },
  get health() {
    return tr('Date', '日期')
  },
  get email() {
    return tr('Email', '邮件')
  },
  get imap() {
    return tr('Email', '邮件')
  },
  get csv() {
    return tr('Row', '行')
  }
}

export const TARGET_LABEL: Record<CalendarTarget, string> = {
  get memory() {
    return tr('Write to memory (remember, searchable right after import)', '写入记忆（remember，导入后即可搜索）')
  },
  get timeline() {
    return tr('Write to timeline (import-data --no-build, searchable after a build)', '写入时间线（import-data --no-build，构建后才可搜索）')
  }
}

export const STATE_LABEL: Record<ConnectorItem['state'], { text: string; tone: 'ok' | 'warn' | 'subtle' }> = {
  new: {
    get text() {
      return tr('Not imported', '未导入')
    },
    tone: 'subtle'
  },
  changed: {
    get text() {
      return tr('Changed', '有变化')
    },
    tone: 'warn'
  },
  unchanged: {
    get text() {
      return tr('Imported', '已导入')
    },
    tone: 'ok'
  }
}

/** Kinds whose write target the user chooses (memory vs timeline). */
export const hasTarget = (k: ConnectorKind): boolean => k === 'calendar' || k === 'csv'

/** Pre-selected keys: everything not already written with identical content. */
export function defaultSelection(p: ConnectorPreview): Set<string> {
  return new Set(p.items.filter((i) => i.state !== 'unchanged').map((i) => i.key))
}

export function toggle(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function previewSummary(p: ConnectorPreview): string {
  const t = p.totals
  const st = (s: ConnectorItem['state']): number => p.items.filter((i) => i.state === s).length
  const what =
    p.kind === 'calendar'
      ? tr(`${t.items} events`, `${t.items} 个事件`)
      : p.kind === 'email' || p.kind === 'imap'
        ? tr(
            `${t.items} emails${t.events !== t.items ? ` (${t.events} ${p.kind === 'email' ? 'in the file' : 'in total'}, duplicates counted once)` : ''}`,
            `${t.items} 封邮件${t.events !== t.items ? `（${p.kind === 'email' ? '文件中' : ''}共 ${t.events} 封，重复的只算一次）` : ''}`
          )
        : p.kind === 'csv'
          ? tr(`${t.items} items (${t.events} rows in the file)`, `${t.items} 条（文件 ${t.events} 行）`)
          : tr(`${t.items} days · ${t.events} records`, `${t.items} 天 · ${t.events} 条记录`)
  return tr(
    `${p.fileName ?? ''}: ${what} · ${t.redactions} redacted · not imported ${st('new')} / changed ${st('changed')} / imported ${st('unchanged')}`,
    `${p.fileName ?? ''}：${what} · 脱敏 ${t.redactions} 处 · 未导入 ${st('new')} / 有变化 ${st('changed')} / 已导入 ${st('unchanged')}`
  )
}

export function commitLines(r: ConnectorCommitResult): string[] {
  const lines = [
    tr(
      `Written ${r.written} · updated ${r.updated} · unchanged, skipped ${r.unchanged}${r.failed ? ` · failed ${r.failed}` : ''}`,
      `写入 ${r.written} · 更新 ${r.updated} · 未变跳过 ${r.unchanged}${r.failed ? ` · 失败 ${r.failed}` : ''}`
    )
  ]
  if (r.cli)
    lines.push(
      tr(
        `persome ${r.cli.args.join(' ')} → exit code ${r.cli.exitCode ?? 'none'}${r.cli.counts ? ` (new/changed ${r.cli.counts.imported}, unchanged ${r.cli.counts.unchanged})` : ''}`,
        `persome ${r.cli.args.join(' ')} → 退出码 ${r.cli.exitCode ?? '无'}${r.cli.counts ? `（新增/变更 ${r.cli.counts.imported}，未变 ${r.cli.counts.unchanged}）` : ''}`
      )
    )
  lines.push(...r.notes)
  for (const it of r.items.filter((i) => i.outcome === 'failed' || i.outcome === 'updated')) lines.push(tr(`${it.key}: ${it.detail ?? it.outcome}`, `${it.key}：${it.detail ?? it.outcome}`))
  return lines
}

export function commitScope(kind: ConnectorKind, target: CalendarTarget): string {
  if (hasTarget(kind)) return TARGET_LABEL[target]
  if (kind === 'email' || kind === 'imap') return tr('One memory per email', '每封邮件一条记忆')
  if (kind === 'csv') return tr('One memory per row', '每行一条记忆')
  return tr('Health records + daily summary', '健康记录 + 每日摘要')
}

// ─── Consent ─────────────────────────────────────────────────────────────

export function consentFor(list: readonly ConsentView[] | null | undefined, kind: ConnectorKind): ConsentView | null {
  return list?.find((c) => c.kind === consentKindOf(kind)) ?? null
}

export function consentLine(c: ConsentView): string {
  if (c.granted) return tr(`Agreed (${c.grantedAt?.slice(0, 16).replace('T', ' ') ?? ''})`, `已同意（${c.grantedAt?.slice(0, 16).replace('T', ' ') ?? ''}）`)
  if (c.revokedAt)
    return tr(`Consent revoked (${c.revokedAt.slice(0, 16).replace('T', ' ')}): cannot read or import`, `已撤销同意（${c.revokedAt.slice(0, 16).replace('T', ' ')}）：不能读取或导入`)
  return tr('Not agreed yet: you need to agree before reading files or connecting a mailbox', '尚未同意：读取文件或连接邮箱前需要你先同意')
}

// ─── IMAP ────────────────────────────────────────────────────────────────

export interface ImapProviderNote {
  name: string
  host: string
  port: number
  user: string
  password: string[]
}

/** App-password notes (no OAuth in this version; Google / Microsoft OAuth is not available). */
export const IMAP_PROVIDERS: readonly ImapProviderNote[] = [
  {
    name: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    get user() {
      return tr('Full Gmail address', '完整的 Gmail 地址')
    },
    get password() {
      return [
        tr(
          'Turn on 2-Step Verification first; then in Google Account → "Security" → "App passwords", generate a 16-character password and enter it here (not your sign-in password).',
          '需要先开启两步验证；在 Google 账号 →「安全性」→「应用专用密码」生成 16 位密码，填在这里（不是登录密码）。'
        ),
        tr('Work / school accounts may have app passwords disabled by an admin.', '工作 / 学校账号可能被管理员禁用了应用专用密码。')
      ]
    }
  },
  {
    get name() {
      return tr('iCloud Mail', 'iCloud 邮件')
    },
    host: 'imap.mail.me.com',
    port: 993,
    get user() {
      return tr('Full iCloud email address', '完整的 iCloud 邮箱地址')
    },
    get password() {
      return [
        tr(
          'Generate one on the Apple Account site (appleid.apple.com) → "Sign-In and Security" → "App-Specific Passwords"; two-factor authentication must be on.',
          '在 Apple 账户网站（appleid.apple.com）→「登录与安全」→「App 专用密码」生成，需要已开启双重认证。'
        )
      ]
    }
  },
  {
    get name() {
      return tr('QQ Mail', 'QQ 邮箱')
    },
    host: 'imap.qq.com',
    port: 993,
    get user() {
      return tr('Full QQ Mail address', '完整的 QQ 邮箱地址')
    },
    get password() {
      return [
        tr(
          'In QQ Mail on the web → "Settings" → "Account", turn on "IMAP/SMTP service", generate the authorization code as prompted, and enter that code here.',
          '网页版 QQ 邮箱 →「设置」→「账号」→ 开启「IMAP/SMTP 服务」，按提示生成「授权码」，把授权码填在这里。'
        )
      ]
    }
  },
  {
    get name() {
      return tr('163 / 126 Mail', '163 / 126 邮箱')
    },
    host: 'imap.163.com',
    port: 993,
    get user() {
      return tr('Full email address', '完整的邮箱地址')
    },
    get password() {
      return [
        tr(
          'On the web → "Settings" → "POP3/SMTP/IMAP", turn on the IMAP service, set a client authorization password, and enter it here. The 126 Mail server is imap.126.com.',
          '网页版 →「设置」→「POP3/SMTP/IMAP」→ 开启 IMAP 服务，设置「客户端授权密码」，填在这里。126 邮箱的服务器是 imap.126.com。'
        )
      ]
    }
  }
]

export function imapNotSupported(): string[] {
  return [
    tr(
      'Outlook / Hotmail / Microsoft 365: Microsoft has turned off app-password IMAP sign-in and requires OAuth, which this version does not support (OAuth is not wired up).',
      'Outlook / Hotmail / Microsoft 365：微软已关闭应用密码式的 IMAP 登录，只能用 OAuth；这个版本不支持（OAuth 未接入）。'
    ),
    tr('Only implicit TLS on port 993 is supported; no plaintext port 143 or STARTTLS.', '只支持 993 端口的隐式 TLS；不支持明文 143 端口或 STARTTLS。')
  ]
}

export function imapFormErrors(v: ImapConfigInput, hasStoredPassword: boolean): string[] {
  const errs: string[] = []
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(v.host.trim())) errs.push(tr('Invalid server address (for example imap.gmail.com, without imap:// or a port)', '服务器地址格式不对（例如 imap.gmail.com，不要带 imap:// 或端口）'))
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) errs.push(tr('Port must be 1–65535 (IMAPS is usually 993)', '端口应为 1–65535（IMAPS 通常是 993）'))
  if (!v.user.trim()) errs.push(tr('Enter the account', '请填写账号'))
  if (!v.password && !hasStoredPassword) errs.push(tr('Enter the app password', '请填写应用专用密码'))
  if (/[\r\n\0]/.test(`${v.user}${v.password}${v.mailbox}`)) errs.push(tr('Account, password and mailbox name cannot contain line breaks', '账号、密码、邮箱名里不能有换行'))
  return errs
}

export function providerFor(host: string): ImapProviderNote | null {
  const h = host.trim().toLowerCase()
  return IMAP_PROVIDERS.find((p) => p.host === h) ?? null
}

// ─── CSV mapping ─────────────────────────────────────────────────────────

export type CsvRole = 'date' | 'title' | 'tags'

export function setCsvRole(m: CsvMapping, role: CsvRole, col: number | null): CsvMapping {
  const next: CsvMapping = { ...m, body: m.body.filter((b) => b !== col) }
  next[role] = col
  return next
}

export function toggleCsvBody(m: CsvMapping, col: number): CsvMapping {
  if (m.body.includes(col)) return { ...m, body: m.body.filter((b) => b !== col) }
  return { date: m.date === col ? null : m.date, title: m.title === col ? null : m.title, tags: m.tags === col ? null : m.tags, body: [...m.body, col].sort((a, b) => a - b) }
}

export function csvMappingError(m: CsvMapping): string | null {
  if (m.title === null && !m.body.length) return tr('Choose a title column or at least one body column', '至少选择标题列或一个正文列')
  return null
}

export const sameMapping = (a: CsvMapping, b: CsvMapping): boolean =>
  a.date === b.date && a.title === b.title && a.tags === b.tags && a.body.length === b.body.length && a.body.every((x, i) => x === b.body[i])

// ─── Imported data / deletion ────────────────────────────────────────────

export function ledgerLine(v: LedgerConnectorView): string {
  const parts = [tr(`${v.items} items`, `${v.items} 项`)]
  if (v.memoryEntries) parts.push(tr(`${v.memoryEntries} memory entries`, `记忆 ${v.memoryEntries} 条`))
  if (v.memoryWithoutId) parts.push(tr(`${v.memoryWithoutId} without entry id`, `无条目 id ${v.memoryWithoutId} 项`))
  if (v.healthEvents) parts.push(tr(`${v.healthEvents} structured health records`, `结构化健康记录 ${v.healthEvents} 条`))
  if (v.timelineDocs) parts.push(tr(`${v.timelineDocs} timeline documents`, `时间线文档 ${v.timelineDocs} 个`))
  if (v.lastAt) parts.push(tr(`last written ${v.lastAt.slice(0, 16).replace('T', ' ')}`, `最近写入 ${v.lastAt.slice(0, 16).replace('T', ' ')}`))
  return parts.join(' · ')
}

export function deleteLines(r: DeleteImportedResult): string[] {
  const memory = r.memoryErased
    ? tr(
        `Deleted ${r.memoryErased} memory entries${r.memoryRetired ? ` · retired ${r.memoryRetired} memory entries` : ''}`,
        `删除记忆 ${r.memoryErased} 条${r.memoryRetired ? ` · 撤回记忆 ${r.memoryRetired} 条` : ''}`
      )
    : tr(`Retired ${r.memoryRetired} memory entries`, `撤回记忆 ${r.memoryRetired} 条`)
  const timeline = r.timelineDeleted ? tr(` · deleted ${r.timelineDeleted} timeline documents`, ` · 删除时间线文档 ${r.timelineDeleted} 个`) : ''
  const health = r.kind === 'health' ? tr(` · deleted ${r.healthDeleted} structured health records`, ` · 删除结构化健康记录 ${r.healthDeleted} 条`) : ''
  const lines = [`${memory}${timeline}${health}`]
  lines.push(...r.notes)
  if (!r.remaining.length) lines.push(tr('Everything this connector wrote per the Navalia ledger has been deleted from Runtime.', 'Navalia 账本里这个连接器写入的内容都已从 Runtime 删除。'))
  return lines
}

export const REMAINING_LABEL: Record<'memory' | 'timeline' | 'health', string> = {
  get memory() {
    return tr('Memory entries', '记忆条目')
  },
  get timeline() {
    return tr('Timeline documents', '时间线文档')
  },
  get health() {
    return tr('Structured health records', '结构化健康记录')
  }
}
