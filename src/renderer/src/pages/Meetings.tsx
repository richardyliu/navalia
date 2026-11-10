// S1-FULL C12–C14 「会议」page. Logic lives in meetingsView.ts / recorderMachine.ts (pure, tested)
// and in main (cloud/meetings.ts). All network happens in main's client.ts.
import { useEffect, useState } from 'react'
import './Meetings.css'
import type { CloudStatus } from '../../../main/cloud/api'
import type { MeetingSummaryRow } from '../../../main/cloud/meetings-api'
import { CloudSetup } from '../components/chat/CloudSetup'
import { MeetingDetail } from '../components/meetings/MeetingDetail'
import { NewMeeting } from '../components/meetings/NewMeeting'
import { RecordingBanner, useRecorder } from '../components/meetings/RecordingBanner'
import { tr } from '../lib/i18n'
import { formatClock, leavesMachineNote, meetingsGate, serverNotE2eeNote, statusLabel } from './meetingsView'

export function Meetings() {
  const rec = useRecorder()
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [rows, setRows] = useState<MeetingSummaryRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const gate = meetingsGate(status)

  async function reload(remote = false): Promise<void> {
    const r = remote && gate.state === 'ready' ? await window.lens.meetings.refresh() : await window.lens.meetings.list()
    if (r.ok) setRows(r.data)
    else setMsg(r.error.message)
  }

  useEffect(() => {
    void window.lens.cloud.status().then((r) => r.ok && setStatus(r.data))
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pick up new chunks / status while recording or finishing (page visible only).
  useEffect(() => {
    if (rec.phase === 'idle') return
    const t = setInterval(() => void reload(), 3_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.phase])

  return (
    <div className="page meet-page">
      <header className="meet-header">
        <h1>{tr('Meetings', '会议')}</h1>
        <p className="muted small">
          {leavesMachineNote()}
          {tr(' ', '')}
          {serverNotE2eeNote()}
        </p>
      </header>
      <RecordingBanner />
      {gate.state !== 'loading' && gate.state !== 'ready' ? (
        <div className="meet-gate">
          <p className="small">{gate.text}</p>
          <CloudSetup status={status} onChange={setStatus} />
        </div>
      ) : null}
      <NewMeeting
        gate={gate.state}
        onStarted={(id) => {
          setSelected(id)
          void reload()
        }}
      />
      <div className="meet-layout">
        <aside className="meet-list" aria-label={tr('Meeting list', '会议列表')}>
          <div className="meet-row">
            <strong>{tr('Meetings', '会议')}</strong>
            <button className="btn small ghost" onClick={() => void reload(true)}>
              {tr('Refresh', '刷新')}
            </button>
          </div>
          {rows.length === 0 ? <p className="tiny muted">{tr('No meetings yet', '还没有会议')}</p> : null}
          {rows.map((r) => (
            <button key={r.id} className={`meet-list-item${selected === r.id ? ' active' : ''}`} onClick={() => setSelected(r.id)}>
              <span className="meet-list-title">{r.title}</span>
              <span className="tiny muted">
                {statusLabel(r)} · {formatClock(r.durationMs)}
                {r.imported ? tr(' · in memory', ' · 已写入记忆') : ''}
              </span>
            </button>
          ))}
        </aside>
        <div className="meet-main">
          {selected ? (
            <MeetingDetail
              meetingId={selected}
              gate={gate.state}
              onDeleted={(r) => {
                setSelected(null)
                setMsg(
                  `${r.serverDeleted ? tr('Cloud record deleted; ', '已删除云端记录；') : tr('Cloud record not deleted (kept at most 7 days); ', '云端记录未删除（最多保留 7 天）；')}${r.localDeleted ? tr('local files deleted.', '已删除本机文件。') : tr('no local files to delete.', '本机没有可删除的文件。')}${r.runtimeNote ? `\n${r.runtimeNote}` : ''}`
                )
                void reload()
              }}
            />
          ) : (
            <p className="muted small">{tr('Select a meeting on the left to see its transcript.', '选择左侧的一场会议查看转写。')}</p>
          )}
          {msg ? <p className="tiny meet-msg">{msg}</p> : null}
        </div>
      </div>
    </div>
  )
}
