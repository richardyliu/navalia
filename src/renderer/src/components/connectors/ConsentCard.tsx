import type { ConsentView } from '../../../../main/connectors/api'
import { consentLine } from '../../pages/connectorsView'
import { tr } from '../../lib/i18n'

/** C19: per-connector consent. Granting goes through a main-process native dialog. */
export function ConsentCard(props: { consent: ConsentView; busy: boolean; onGrant: () => void; onRevoke: () => void }) {
  const { consent: c, busy } = props
  if (c.granted) {
    return (
      <div className="conn-consent granted tiny">
        <span className="chip ok">{consentLine(c)}</span>
        <details>
          <summary>{tr('What this connector reads and where it writes', '这个连接器读取什么、写到哪里')}</summary>
          <ConsentText c={c} />
        </details>
        <button className="btn ghost small" disabled={busy} onClick={props.onRevoke}>
          {tr('Revoke consent', '撤销同意')}
        </button>
      </div>
    )
  }
  return (
    <section className="card conn-consent">
      <h3>{tr(`"${c.text.title}" needs your consent before use`, `使用「${c.text.title}」前需要你的同意`)}</h3>
      <ConsentText c={c} />
      <p className="muted tiny">
        {tr(
          `${consentLine(c)}. After you click "Agree", the system asks once more to confirm; you can revoke at any time, after which nothing can be read or imported.`,
          `${consentLine(c)}。点「同意」后系统会再弹出一次确认；之后随时可以撤销，撤销后不能再读取或导入。`
        )}
      </p>
      <div className="page-actions">
        <button className="btn primary" disabled={busy} onClick={props.onGrant}>
          {tr('Agree…', '同意…')}
        </button>
      </div>
    </section>
  )
}

function ConsentText({ c }: { c: ConsentView }) {
  return (
    <dl className="conn-consent-text">
      <dt>{tr('Reads', '读取')}</dt>
      {c.text.reads.map((r) => (
        <dd key={r}>{r}</dd>
      ))}
      <dt>{tr('Writes', '写入')}</dt>
      {c.text.writes.map((w) => (
        <dd key={w}>{w}</dd>
      ))}
      {c.text.notes.length ? <dt>{tr('Also', '另外')}</dt> : null}
      {c.text.notes.map((n) => (
        <dd key={n}>{n}</dd>
      ))}
    </dl>
  )
}
