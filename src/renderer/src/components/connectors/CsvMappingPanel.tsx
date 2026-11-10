import { useState } from 'react'
import type { CsvMapping, CsvPreviewInfo } from '../../../../main/connectors/api'
import { csvMappingError, sameMapping, setCsvRole, toggleCsvBody, type CsvRole } from '../../pages/connectorsView'
import { tr } from '../../lib/i18n'

const ROLE_LABEL: Record<CsvRole, string> = {
  get date() {
    return tr('Date column', '日期列')
  },
  get title() {
    return tr('Title column', '标题列')
  },
  get tags() {
    return tr('Tag column (optional)', '标签列（可选）')
  }
}
const DELIM: Record<string, string> = {
  get ','() {
    return tr('comma', '逗号')
  },
  get ';'() {
    return tr('semicolon', '分号')
  },
  '\t': 'Tab'
}

/** C19 generic CSV: choose which columns become date / title / body / tags. Only mapped columns are written. */
export function CsvMappingPanel(props: { info: CsvPreviewInfo; busy: boolean; onApply: (m: CsvMapping) => void }) {
  const { info } = props
  const [m, setM] = useState<CsvMapping>(info.mapping)
  const err = csvMappingError(m)
  const dirty = !sameMapping(m, info.mapping)
  const opt = (i: number): string => `${i + 1}. ${info.header[i] || tr('(no header)', '（无表头）')}`

  return (
    <section className="card conn-csv">
      <h3>{tr('Column mapping', '列映射')}</h3>
      <p className="muted tiny">
        {tr(
          `${info.rows} rows · delimiter: ${DELIM[info.delimiter] ?? info.delimiter}${info.truncated ? ' · only the first 100,000 rows were read' : ''}. Only mapped columns are written; every value is redacted first.`,
          `${info.rows} 行 · 分隔符：${DELIM[info.delimiter] ?? info.delimiter}${info.truncated ? ' · 只读取了前 100,000 行' : ''}。只有映射到的列会写入；每个值先脱敏。`
        )}
      </p>
      <div className="conn-csv-roles">
        {(['date', 'title', 'tags'] as const).map((role) => (
          <label key={role} className="tiny">
            {ROLE_LABEL[role]}
            <select value={m[role] ?? ''} onChange={(e) => setM(setCsvRole(m, role, e.target.value === '' ? null : Number(e.target.value)))}>
              <option value="">{tr('(not used)', '（不使用）')}</option>
              {info.header.map((_, i) => (
                <option key={i} value={i}>
                  {opt(i)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="conn-csv-body tiny">
        <span>{tr('Body columns:', '正文列：')}</span>
        {info.header.map((_, i) => (
          <label key={i}>
            <input type="checkbox" checked={m.body.includes(i)} onChange={() => setM(toggleCsvBody(m, i))} /> {opt(i)}
          </label>
        ))}
      </div>
      {err ? <div className="banner warn compact tiny">{err}</div> : null}
      <div className="conn-csv-sample">
        <table className="table tiny">
          <thead>
            <tr>
              {info.header.map((_h, i) => (
                <th key={i} className={m.date === i || m.title === i || m.tags === i || m.body.includes(i) ? 'conn-col-used' : 'muted'}>
                  {opt(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.sample.map((row, r) => (
              <tr key={r}>
                {row.map((c, i) => (
                  <td key={i}>{c.length > 80 ? `${c.slice(0, 80)}…` : c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="page-actions">
        <button className="btn primary small" disabled={props.busy || !!err || !dirty} onClick={() => props.onApply(m)}>
          {tr('Preview again with this mapping', '按这个映射重新预览')}
        </button>
      </div>
    </section>
  )
}
