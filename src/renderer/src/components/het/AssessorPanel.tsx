import type { HetAssessorInfo, HetAssessorStatus } from '../../../../main/het/api'
import { tr } from '../../lib/i18n'
import { assessorPanelLines, assessorToggleText } from './labels'
import { useHetAssessorInfo, useSetAssessorEnabled, useSetSendSummaries } from './useHet'

/**
 * X3 (R4-1) assessor settings: 「允许评估」 (default off), what is sent and to whom, the Runtime
 * budget, and the optional 「发送摘要给 assessor」 (default off; ON needs a native confirm in main).
 */
export function AssessorPanel({ gate }: { gate: HetAssessorStatus | undefined }) {
  const info = useHetAssessorInfo()
  const toggle = useSetAssessorEnabled()
  const sendSummaries = useSetSendSummaries()
  const status: HetAssessorStatus | undefined = info.data ?? gate
  const toggleText = assessorToggleText(status)
  const lines = assessorPanelLines(info.data)

  return (
    <section className="card het-assessor-toggle" data-assessor-state={status?.state}>
      <label className="het-toggle-row">
        <input
          type="checkbox"
          checked={status?.enabled ?? false}
          disabled={!status || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span>{toggleText.label}</span>
      </label>
      <p className="muted tiny">{toggleText.explain}</p>
      <p className={`tiny het-assessor-state ${lines.stateTone === 'ok' ? '' : 'het-toggle-note'}`}>{lines.state}</p>
      {toggleText.note ? <p className="tiny het-toggle-note">{toggleText.note}</p> : null}
      {toggle.isError ? <p className="tiny het-toggle-note">{String(toggle.error)}</p> : null}

      {info.data && info.data.enabled ? <AssessorDetails info={info.data} /> : null}

      {info.data && info.data.enabled ? (
        <>
          <label className="het-toggle-row">
            <input
              type="checkbox"
              checked={info.data.send_summaries}
              disabled={sendSummaries.isPending}
              onChange={(e) => sendSummaries.mutate(e.target.checked)}
            />
            <span>{tr('Send summaries to the assessor', '发送摘要给 assessor')}</span>
          </label>
          <p className="muted tiny">
            {tr(
              `Off by default. Turning it on shows a system confirmation: it additionally sends project paths, session titles, written file paths and redacted event summaries to the CLI provider configured in Persome Runtime (${info.data.client || 'not configured'}). Sent content cannot be recalled; turning it off only affects later assessments.`,
              `默认关闭。开启时会弹出系统确认框：额外发送项目路径、会话标题、写入文件路径和已脱敏的事件摘要，发给 Persome Runtime 配置的 CLI 提供方（${info.data.client || '未配置'}）。发出后无法撤回；关闭只影响之后的评估。`
            )}
          </p>
          {sendSummaries.data && !sendSummaries.data.confirmed ? <p className="tiny het-toggle-note">{tr('Cancelled; not turned on.', '已取消，未开启。')}</p> : null}
          {sendSummaries.isError ? <p className="tiny het-toggle-note">{String(sendSummaries.error)}</p> : null}
        </>
      ) : null}
      {info.isError ? <p className="tiny het-toggle-note">{String(info.error)}</p> : null}
    </section>
  )
}

function AssessorDetails({ info }: { info: HetAssessorInfo }) {
  const l = assessorPanelLines(info)
  return (
    <div className="het-assessor-details tiny">
      <ul className="het-assessor-facts">
        {l.facts.map((f) => (
          <li key={f.label}>
            <span className="muted">
              {f.label}
              {tr(': ', '：')}
            </span>
            {f.value}
          </li>
        ))}
      </ul>
      <p className="muted">
        {tr(`Sent (once per task): ${info.sent_fields.join(', ')}.`, `发送的内容（每个任务一次）：${info.sent_fields.join('、')}。`)}
      </p>
      {info.send_summaries ? null : <p className="muted">{tr('Not sent: session titles, project / file paths, summaries, raw conversation text.', '不发送：会话标题、项目/文件路径、摘要、对话原文。')}</p>}
      <p className="muted">{tr('Navalia only keeps assessment results, evidence ids and counts, never the prompt it sent.', 'Navalia 只保存评估结论、证据 id 和计数，不保存发送的 prompt。')}</p>
    </div>
  )
}
