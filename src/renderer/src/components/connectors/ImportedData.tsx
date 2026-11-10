import { useState } from 'react'
import type { ConnectorKind, DeleteImportedResult, LedgerView } from '../../../../main/connectors/api'
import { deleteLines, KIND_LABEL, ledgerLine, REMAINING_LABEL } from '../../pages/connectorsView'
import { tr } from '../../lib/i18n'

/**
 * C19 「已导入的数据」: what each connector wrote (from the local ledger) and deletion. Deletion asks
 * here first, then main shows a native confirm. What the Runtime cannot delete is listed with how to
 * remove it — never reported as deleted.
 */
export function ImportedData(props: {
  ledger: LedgerView | null
  busy: boolean
  results: Partial<Record<ConnectorKind, DeleteImportedResult>>
  onDelete: (kind: ConnectorKind) => void
}) {
  const [asking, setAsking] = useState<ConnectorKind | null>(null)
  const rows = props.ledger?.connectors ?? []
  return (
    <section className="card conn-imported">
      <h3>{tr('Imported data', '已导入的数据')}</h3>
      {!rows.length ? <p className="muted tiny">{tr('Nothing has been written through connectors yet (per the local Navalia ledger).', '还没有通过连接器写入任何内容（以本机 Navalia 账本为准）。')}</p> : null}
      {rows.map((v) => {
        const r = props.results[v.kind]
        return (
          <div key={v.kind} className="conn-imported-row">
            <div>
              <strong>{KIND_LABEL[v.kind]}</strong>
              <div className="muted tiny">{ledgerLine(v)}</div>
            </div>
            {asking === v.kind ? (
              <div className="banner warn compact tiny">
                <span>
                  {tr(
                    'Ask Runtime to delete what this connector wrote: memories via Runtime retire, health records by ID. Anything Runtime cannot delete (such as timeline documents, or memories under the default markdown write mode) is listed with how to delete it by hand. Continue?',
                    '请求 Runtime 删除这个连接器写入的内容：记忆用 Runtime 的撤回（retire），健康记录按 ID 删除。Runtime 不支持删除的部分（例如时间线文档、默认 markdown 写入方式下的记忆）会列出来并说明怎么手动删除。继续吗？'
                  )}
                </span>
                <span className="page-actions">
                  <button
                    className="btn primary small"
                    disabled={props.busy}
                    onClick={() => {
                      setAsking(null)
                      props.onDelete(v.kind)
                    }}
                  >
                    {tr('Delete…', '删除…')}
                  </button>
                  <button className="btn ghost small" onClick={() => setAsking(null)}>
                    {tr('Cancel', '取消')}
                  </button>
                </span>
              </div>
            ) : (
              <button className="btn ghost small" disabled={props.busy} onClick={() => setAsking(v.kind)}>
                {tr('Delete imported data', '删除导入的数据')}
              </button>
            )}
            {r ? (
              <div className={`banner compact tiny ${r.remaining.length ? 'warn' : 'ok'}`}>
                <div>
                  {deleteLines(r).map((l) => (
                    <div key={l}>{l}</div>
                  ))}
                  {r.remaining.map((x) => (
                    <div key={`${x.what}-${x.reason}`} className="conn-remaining">
                      <strong>
                        {tr(`Still in Runtime: ${REMAINING_LABEL[x.what]} ${x.count}`, `仍在 Runtime 里：${REMAINING_LABEL[x.what]} ${x.count}`)}
                      </strong>
                      <div>{x.reason}</div>
                      <ul>
                        {x.how.map((h) => (
                          <li key={h}>{h}</li>
                        ))}
                      </ul>
                      {x.ids.length ? (
                        <details>
                          <summary>{tr(`id list (${x.ids.length})`, `id 列表（${x.ids.length}）`)}</summary>
                          <pre className="build-log">{x.ids.join('\n')}</pre>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
