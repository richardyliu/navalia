import { Fragment, useState } from 'react'
import { waitingKey, type HetCorrection, type HetTaskDto } from '../../../../main/het/api'
import { intlLocale, tr } from '../../lib/i18n'
import { reasonText, undoCorrectionLabel } from './labels'
import { useCorrect, useRevertCorrection } from './useHet'

const statusLabel = (status: HetTaskDto['status']): { text: string; tone: string } => {
  switch (status) {
    case 'unsettled':
      return { text: tr('In progress', '进行中'), tone: 'subtle' }
    case 'needs_assessment':
      return { text: tr('Awaiting assessment', '等待评估'), tone: 'warn' }
    case 'assessed':
      return { text: tr('Assessed', '已评估'), tone: 'ok' }
    default:
      return { text: tr('Assessment failed', '评估失败'), tone: 'bad' }
  }
}

const correctionLabel = (c: HetCorrection): string =>
  c === 'accepted' ? tr('Accept (accepted)', '接受 accepted') : c === 'rejected' ? tr('Reject (rejected)', '拒绝 rejected') : tr('Not an agent (not_agent)', '不是 agent not_agent')

/** Why a task is not (yet) counted (same buckets as the period counts). */
export function pendingReason(t: Pick<HetTaskDto, 'status' | 'last_error'>, transport?: string): string {
  return reasonText(waitingKey(t), transport)
}

const project = (p: string | null): string => (p ? p.split('/').filter(Boolean).pop() ?? p : '—')
const when = (iso: string): string =>
  new Intl.DateTimeFormat(intlLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

export function TaskTable({ tasks, transport }: { tasks: HetTaskDto[]; transport?: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const correct = useCorrect()
  const revert = useRevertCorrection()
  if (!tasks.length) return <p className="muted">{tr('No AI work detected in this period.', '这个时间段没有检测到 AI 工作。')}</p>
  return (
    <table className="table het-table">
      <thead>
        <tr>
          <th>{tr('Start', '开始')}</th>
          <th>Agent</th>
          <th>{tr('Project', '项目')}</th>
          <th>{tr('Task', '任务')}</th>
          <th>{tr('Kind', '类型')}</th>
          <th>{tr('Status', '状态')}</th>
          <th>{tr('Adoption', '采纳')}</th>
          <th className="num">{tr('HET (est. · min)', 'HET（估计·分钟）')}</th>
          <th>{tr('Correction', '修正')}</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((t) => {
          const s = statusLabel(t.status)
          const isOpen = open === t.id
          return (
            <Fragment key={t.id}>
              <tr className={`het-row ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : t.id)}>
                <td className="mono tiny">{when(t.start)}</td>
                <td className="tiny">{t.agent}</td>
                <td className="tiny ellipsis" title={t.project ?? ''}>{project(t.project)}</td>
                <td className="ellipsis het-title">{t.title ?? <span className="muted">{tr('(summary not saved)', '（未保存摘要）')}</span>}</td>
                <td className="tiny">{t.kind === 'unassessed' ? '—' : t.kind}</td>
                <td>
                  <span className={`chip ${s.tone}`} title={t.counted ? '' : pendingReason(t, transport)}>{s.text}</span>
                </td>
                <td className="tiny">{t.adoption ?? '—'}</td>
                <td className="num mono" title={t.counted && t.anchor_version !== null ? tr(`Estimate (anchors v${t.anchor_version}): not performance, not time saved`, `估计（anchors v${t.anchor_version}）：不是绩效、不是节省时间`) : undefined}>{t.counted && t.minutes_tenths !== null ? (t.minutes_tenths / 10).toFixed(1) : '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="het-actions">
                    {(['accepted', 'rejected', 'not_agent'] as const).map((a) => (
                      <button
                        key={a}
                        className={`btn tiny-btn ${t.correction === a ? 'primary' : 'ghost'}`}
                        disabled={correct.isPending}
                        onClick={() => correct.mutate({ taskId: t.id, action: a })}
                        title={correctionLabel(a)}
                      >
                        {a === 'accepted' ? tr('Accept', '接受') : a === 'rejected' ? tr('Reject', '拒绝') : tr('Not agent', '非 agent')}
                      </button>
                    ))}
                    {undoCorrectionLabel(t).show ? (
                      <button
                        className="btn tiny-btn ghost het-undo"
                        disabled={revert.isPending || correct.isPending}
                        onClick={() => revert.mutate(t.id)}
                        title={undoCorrectionLabel(t).title}
                      >
                        {undoCorrectionLabel(t).text}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
              {isOpen ? (
                <tr className="het-evidence-row">
                  <td colSpan={9}>
                    <TaskEvidence task={t} transport={transport} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function TaskEvidence({ task, transport }: { task: HetTaskDto; transport?: string }) {
  const ev = task.evidence ?? []
  return (
    <div className="het-evidence">
      <div className="het-evidence-meta tiny muted">
        {task.counted ? null : <span>{tr(`Not counted: ${pendingReason(task, transport)} · `, `未计入：${pendingReason(task, transport)} · `)}</span>}
        <span>
          {tr(
            `User messages ${task.stats.userTurns ?? 0} · Tool calls ${task.stats.toolCalls ?? 0} · Files written ${task.stats.filesWritten ?? 0}`,
            `用户消息 ${task.stats.userTurns ?? 0} · 工具调用 ${task.stats.toolCalls ?? 0} · 写入文件 ${task.stats.filesWritten ?? 0}`
          )}
        </span>
        {task.signals.length ? <span>{tr(` · Signals ${task.signals.join(', ')}`, ` · 信号 ${task.signals.join(', ')}`)}</span> : null}
        {task.anchor_version !== null ? <span>{tr(` · Estimate (anchors v${task.anchor_version}; not performance, not time saved)`, ` · 估计（anchors v${task.anchor_version}，不是绩效、不是节省时间）`)}</span> : null}
        {task.correction ? <span>{tr(` · Correction ${task.correction}`, ` · 修正 ${task.correction}`)}</span> : null}
      </div>
      {ev.length === 0 ? (
        <p className="muted tiny">{tr('No evidence saved.', '没有保存证据。')}</p>
      ) : (
        <ul className="het-evidence-list">
          {ev.map((e) => (
            <li key={e.event_id}>
              <span className="mono tiny">{when(e.ts)}</span>
              <span className="chip subtle">{e.role}</span>
              {e.tools.length ? <span className="mono tiny">{e.tools.join(', ')}</span> : null}
              {e.signals.length ? (
                <span className={`chip ${e.signals.includes('tool_error') ? 'warn' : 'ok'}`}>{e.signals.join(', ')}</span>
              ) : null}
              {e.files.length ? <span className="mono tiny ellipsis">{e.files.map(project).join(', ')}</span> : null}
              <span className="het-evidence-summary">{e.summary || <span className="muted">{tr('(summary not saved)', '（摘要未保存）')}</span>}</span>
              <span className="mono tiny muted" title={e.source.file}>
                {e.event_id}:{e.source.line}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
