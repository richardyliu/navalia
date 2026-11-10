import { useMemo, useState } from 'react'
import type { AccessLogRow } from '../../../../main/broker/api'
import { toolMeta } from '../../../../main/broker/catalog'
import { useAccessPreview } from './useConnections'
import { formatNumber } from '../../lib/format'
import { tr } from '../../lib/i18n'

function time(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function Preview({ row }: { row: AccessLogRow }) {
  const p = useAccessPreview(row.id)
  return (
    <td colSpan={6}>
      <div className="tiny muted">
        {row.durationMs} ms{row.errorCode ? ` · ${row.errorCode}` : ''}
        {toolMeta(row.capability)?.image ? ' · image, not scrubbed' : ''}
      </div>
      {p.isLoading ? <p className="tiny muted">{tr('Loading preview…', '读取预览…')}</p> : null}
      {p.isError ? <p className="tiny muted">{p.error instanceof Error ? p.error.message : String(p.error)}</p> : null}
      {p.data === null ? <p className="tiny muted">{tr('This record has been cleared', '这条记录已被清除')}</p> : null}
      {p.data ? (
        <>
          <div className="tiny muted">argumentsPreview</div>
          <pre>{p.data.argumentsPreview || '{}'}</pre>
          <div className="tiny muted">resultPreview</div>
          <pre>{p.data.resultPreview || '—'}</pre>
        </>
      ) : null}
    </td>
  )
}

/** Small tags so ~26 capability names stay scannable: write / image / Rewind / extension. */
export function CapabilityTags({ name }: { name: string }) {
  const m = toolMeta(name)
  if (!m) return null
  return (
    <>
      {m.write ? <span className="chip warn conn-tag">write</span> : null}
      {m.image ? <span className="chip warn conn-tag" title="image, not scrubbed">image</span> : null}
      {m.origin === 'product' ? <span className="chip subtle conn-tag">Rewind</span> : null}
      {m.origin === 'extension' ? <span className="chip subtle conn-tag">Extension</span> : null}
    </>
  )
}

const OUTCOME_LABEL: Record<AccessLogRow['outcome'], string> = {
  ok: '',
  get denied() {
    return tr('denied', '拒绝')
  },
  get unauthorized() {
    return tr('unauthorized', '未授权')
  },
  get error() {
    return tr('failed', '失败')
  }
}

export function AccessLogList({ rows }: { rows: AccessLogRow[] }) {
  const days = useMemo(() => {
    const m = new Map<string, AccessLogRow[]>()
    for (const r of rows) m.set(r.day, [...(m.get(r.day) ?? []), r])
    return [...m.entries()]
  }, [rows])
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [openRows, setOpenRows] = useState<Set<number>>(new Set())

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    apply(next)
  }

  if (rows.length === 0) return <p className="muted conn-empty">{tr('No reads yet. Reads by an Agent through the Broker appear here (empty results are logged too).', '还没有读取记录。Agent 通过 Broker 读取后会出现在这里（空结果也会记录）。')}</p>

  return (
    <div className="conn-log">
      {days.map(([day, list]) => {
        const open = openDays.has(day)
        const chars = list.filter((r) => r.outcome === 'ok').reduce((s, r) => s + r.responseChars, 0)
        return (
          <div key={day} className="conn-day">
            <button className="conn-day-head" onClick={() => toggle(openDays, day, setOpenDays)} aria-expanded={open}>
              <span>{open ? '▾' : '▸'} {day}</span>
              <span className="tiny muted">
                {tr(`${list.length} reads · ${formatNumber(chars)} chars`, `${list.length} 次 · ${formatNumber(chars)} 字符`)}
              </span>
            </button>
            {open ? (
              <table className="conn-table">
                <thead>
                  <tr>
                    <th>{tr('Time', '时间')}</th>
                    <th>client</th>
                    <th>capability</th>
                    <th>items</th>
                    <th>count</th>
                    <th>response chars</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const expanded = openRows.has(r.id)
                    return [
                      <tr key={r.id} className={`conn-row ${r.outcome}`} onClick={() => toggle(openRows, r.id, setOpenRows)}>
                        <td className="mono">{time(r.ts)}</td>
                        <td>{r.client}</td>
                        <td className="mono">
                          {r.capability}
                          <CapabilityTags name={r.capability} />
                          {r.outcome !== 'ok' ? <span className="chip bad">{OUTCOME_LABEL[r.outcome]} {r.httpStatus}</span> : null}
                        </td>
                        <td className="mono ellipsis conn-items" title={r.itemIds.join('\n')}>
                          {r.itemIds.length ? r.itemIds.slice(0, 2).join(', ') + (r.itemIds.length > 2 ? ' …' : '') : '—'}
                        </td>
                        <td>{r.itemCount}</td>
                        <td>{formatNumber(r.responseChars)}</td>
                      </tr>,
                      expanded ? (
                        <tr key={`${r.id}-x`} className="conn-preview">
                          <Preview row={r} />
                        </tr>
                      ) : null
                    ]
                  })}
                </tbody>
              </table>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
