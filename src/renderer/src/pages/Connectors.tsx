import { useCallback, useEffect, useState } from 'react'
import type {
  CalendarTarget,
  ConnectorCommitResult,
  ConnectorKind,
  ConnectorPreview,
  ConnectorsApi,
  ConsentView,
  CsvMapping,
  DeleteImportedResult,
  ImapConfigInput,
  ImapConfigView,
  ImapFetchOptions,
  LedgerView
} from '../../../main/connectors/api'
import { ConsentCard } from '../components/connectors/ConsentCard'
import { CsvMappingPanel } from '../components/connectors/CsvMappingPanel'
import { ImapPanel } from '../components/connectors/ImapPanel'
import { ImportedData } from '../components/connectors/ImportedData'
import '../components/connectors/connectors.css'
import {
  commitLines,
  commitScope,
  consentFor,
  defaultSelection,
  hasTarget,
  ITEM_LABEL,
  KIND_LABEL,
  KIND_ORDER,
  previewSummary,
  STATE_LABEL,
  TARGET_LABEL,
  toggle
} from './connectorsView'
import './import.css'
import { tr } from '../lib/i18n'
import { unwrap, errorMessage } from '../lib/api'

const api = (): ConnectorsApi['connectors'] => (window.lens as unknown as ConnectorsApi).connectors

/**
 * 「连接器」: per-connector consent → local file (or read-only IMAP) → preview (redacted) → write to
 * the Runtime; 「已导入的数据」 lists what each connector wrote and deletes what the Runtime allows.
 */
export function Connectors() {
  const [kind, setKind] = useState<ConnectorKind>('calendar')
  const [preview, setPreview] = useState<ConnectorPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<CalendarTarget>('memory')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<null | 'pick' | 'commit' | 'consent' | 'imap' | 'delete'>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ConnectorCommitResult | null>(null)
  const [consents, setConsents] = useState<ConsentView[] | null>(null)
  const [imap, setImap] = useState<ImapConfigView | null>(null)
  const [ledger, setLedger] = useState<LedgerView | null>(null)
  const [deleted, setDeleted] = useState<Partial<Record<ConnectorKind, DeleteImportedResult>>>({})

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [c, i, l] = await Promise.all([unwrap(api().consentStatus()), unwrap(api().imapStatus()), unwrap(api().ledger())])
      setConsents(c)
      setImap(i)
      setLedger(l)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const consent = consentFor(consents, kind)

  async function act<T>(what: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | null> {
    setBusy(what)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(errorMessage(e))
      return null
    } finally {
      setBusy(null)
    }
  }

  const showPreview = (p: ConnectorPreview): void => {
    if (p.cancelled) return
    setPreview(p)
    setSelected(defaultSelection(p))
  }

  async function pick(): Promise<void> {
    if (kind === 'imap') return
    setResult(null)
    setConfirming(false)
    const p = await act('pick', () => unwrap(api().pick(kind)))
    if (p) showPreview(p)
  }

  async function fetchImap(o: ImapFetchOptions): Promise<void> {
    setResult(null)
    setConfirming(false)
    const p = await act('imap', () => unwrap(api().imapFetch(o)))
    if (p) showPreview(p)
  }

  async function remap(m: CsvMapping): Promise<void> {
    if (!preview?.previewId) return
    const p = await act('pick', () => unwrap(api().csvMap(preview.previewId!, m)))
    if (p) showPreview(p)
  }

  async function commit(): Promise<void> {
    if (!preview?.previewId) return
    setConfirming(false)
    const r = await act('commit', () => unwrap(api().commit(preview.previewId!, [...selected], hasTarget(kind) ? { target } : {}, true)))
    if (r) {
      setResult(r)
      void refresh()
    }
  }

  async function grant(): Promise<void> {
    if (!consent) return
    if (await act('consent', () => unwrap(api().consentGrant(consent.kind)))) void refresh()
  }
  async function revoke(): Promise<void> {
    if (!consent) return
    if (await act('consent', () => unwrap(api().consentRevoke(consent.kind)))) {
      setPreview(null)
      setResult(null)
      void refresh()
    }
  }

  async function saveImap(v: ImapConfigInput): Promise<boolean> {
    const s = await act('imap', () => unwrap(api().imapSave(v)))
    if (s) setImap(s)
    return !!s
  }
  async function clearImap(): Promise<void> {
    const s = await act('imap', () => unwrap(api().imapClear()))
    if (s) setImap(s)
  }

  async function deleteImported(k: ConnectorKind): Promise<void> {
    const r = await act('delete', () => unwrap(api().deleteImported(k, true)))
    if (r) {
      setDeleted((d) => ({ ...d, [k]: r }))
      void refresh()
    }
  }

  const switchKind = (k: ConnectorKind): void => {
    if (preview?.previewId) void api().discard(preview.previewId)
    setKind(k)
    setPreview(null)
    setResult(null)
    setError(null)
    setConfirming(false)
  }

  return (
    <div className="page import-page connectors-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Connectors</div>
          <h2>{tr('Connectors', '连接器')}</h2>
          <p className="muted">
            {tr(
              'Import calendars, health / workout data (including Apple Health exports), email and generic CSV from local files, or read one IMAP mailbox read-only with an app password: agree first → preview (redacted) → write to Runtime. Each connector needs its own consent, which you can revoke at any time. Only IMAP goes online (only to the mail server you enter); Navalia never calls an LLM and never writes the Runtime database directly. OAuth accounts such as Google / Notion are not supported yet.',
              '从本机文件导入日历、健康 / 训练数据（含 Apple Health 导出）、邮件和通用 CSV，或用应用专用密码以只读方式读取一个 IMAP 邮箱：先同意 → 预览（已脱敏）→ 写入 Runtime。每个连接器单独同意，可随时撤销。只有 IMAP 会联网（只连你填写的邮件服务器）；Navalia 不调用 LLM，也不直接写 Runtime 数据库。Google / Notion 等 OAuth 账号连接暂不支持。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <div className="segmented">
            {KIND_ORDER.map((k) => (
              <button key={k} className={`seg-btn ${kind === k ? 'active' : ''}`} onClick={() => switchKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {kind !== 'imap' && consent?.granted ? (
            <button className="btn primary" disabled={busy !== null} onClick={() => void pick()}>
              {busy === 'pick' ? tr('Reading…', '读取中…') : tr('Choose file…', '选择文件…')}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <pre className="banner bad compact">{error}</pre> : null}

      {consent ? <ConsentCard consent={consent} busy={busy !== null} onGrant={() => void grant()} onRevoke={() => void revoke()} /> : null}

      {kind === 'imap' && consent?.granted ? (
        <ImapPanel status={imap} busy={busy !== null} onSave={saveImap} onClear={() => void clearImap()} onFetch={(o) => void fetchImap(o)} />
      ) : null}

      {preview?.csv ? <CsvMappingPanel key={preview.previewId ?? ''} info={preview.csv} busy={busy !== null} onApply={(m) => void remap(m)} /> : null}

      {preview ? (
        <section className="card">
          <div className="muted tiny">{previewSummary(preview)}</div>
          {preview.warnings.length ? (
            <ul className="tiny muted">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <details className="tiny">
            <summary>{tr('Write mode and limits', '写入方式与限制')}</summary>
            <ul>
              {preview.mapping.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </details>
          {preview.items.length ? (
            <table className="table import-table">
              <thead>
                <tr>
                  <th />
                  <th>{ITEM_LABEL[kind]}</th>
                  <th>{tr('Time', '时间')}</th>
                  <th>{tr('Status', '状态')}</th>
                  <th>{tr('Content to write (redacted)', '将写入的内容（已脱敏）')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((it) => (
                  <tr key={it.key} onClick={() => setSelected(toggle(selected, it.key))}>
                    <td>
                      <input type="checkbox" checked={selected.has(it.key)} readOnly />
                    </td>
                    <td>
                      {it.title}
                      {it.events ? <div className="muted tiny">{tr(`${it.events} records`, `${it.events} 条记录`)}</div> : null}
                      {it.attachments ? <div className="muted tiny">{tr(`${it.attachments} attachments (names only)`, `${it.attachments} 个附件（只记文件名）`)}</div> : null}
                    </td>
                    <td className="tiny mono">{it.when ?? '—'}</td>
                    <td>
                      <span className={`chip ${STATE_LABEL[it.state].tone}`}>{STATE_LABEL[it.state].text}</span>
                    </td>
                    <td>
                      <details onClick={(e) => e.stopPropagation()}>
                        <summary className="tiny">{tr('View', '查看')}</summary>
                        <pre className="build-log">{it.text}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted tiny">{tr('Nothing to import.', '没有可导入的项目。')}</p>
          )}
          {hasTarget(kind) ? (
            <div className="tiny">
              {(['memory', 'timeline'] as const).map((t) => (
                <label key={t} className="import-build-after">
                  <input type="radio" name="connector-target" checked={target === t} onChange={() => setTarget(t)} /> {TARGET_LABEL[t]}
                </label>
              ))}
            </div>
          ) : kind === 'health' ? (
            <div className="muted tiny">
              {tr(
                'Health data needs Runtime running (writes to /health-events/import), plus one searchable summary per day.',
                '健康数据需要 Runtime 正在运行（写入 /health-events/import），每天另写一条可搜索的摘要。'
              )}
            </div>
          ) : (
            <div className="muted tiny">
              {tr(
                'Each email is written as one memory (remember). Attachment content is never read, only file names; Runtime must be available.',
                '每封邮件写一条记忆（remember）。附件内容从不读取，只记文件名；需要 Runtime 可用。'
              )}
            </div>
          )}
          {preview.previewId ? (
            <div className="page-actions">
              <button className="btn primary" disabled={busy !== null || selected.size === 0} onClick={() => setConfirming(true)}>
                {tr(`Write to Runtime (${selected.size} items)`, `写入 Runtime（${selected.size} 项）`)}
              </button>
            </div>
          ) : null}
          {confirming ? (
            <div className="banner warn compact">
              <span>
                {tr(
                  `The redacted content of the ${selected.size} selected items will be written to the local Runtime (${commitScope(kind, target)}). Memory entries are append-only: if the content changes later, another "updated" entry is written and the old one stays. Write now?`,
                  `将把所选 ${selected.size} 项的脱敏内容写入本机 Runtime（${commitScope(kind, target)}）。记忆条目只追加：之后内容有变化会再写一条「更新」，旧条目保留。确定写入吗？`
                )}
              </span>
              <span className="page-actions">
                <button className="btn primary small" onClick={() => void commit()}>
                  {tr('Write', '确认写入')}
                </button>
                <button className="btn ghost small" onClick={() => setConfirming(false)}>
                  {tr('Cancel', '取消')}
                </button>
              </span>
            </div>
          ) : null}
          {busy === 'commit' ? <p className="muted">{tr('Writing…', '写入中…')}</p> : null}
          {result ? (
            <div className={`banner compact ${result.failed ? 'bad' : 'ok'}`}>
              <div>
                <strong>{result.failed ? tr('Partly failed', '部分失败') : tr('Write complete', '写入完成')}</strong>
                {commitLines(result).map((l) => (
                  <div key={l} className="tiny">
                    {l}
                  </div>
                ))}
                {!result.failed && result.target !== 'timeline' ? <div className="tiny muted">{tr('You can find these entries on the Search page by title or metric name.', '可在「搜索」页按标题或指标名查到这些条目。')}</div> : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : consent?.granted && kind !== 'imap' ? (
        <p className="muted">{tr('Click "Choose file…". The preview only reads the file and writes nothing.', '点「选择文件…」。预览只读取文件，不写入任何内容。')}</p>
      ) : null}

      <ImportedData ledger={ledger} busy={busy !== null} results={deleted} onDelete={(k) => void deleteImported(k)} />
    </div>
  )
}
