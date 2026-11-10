// New meeting: title + consent checkbox → main (native confirm + mic access + POST) → recorder.
import { useState } from 'react'
import { tr } from '../../lib/i18n'
import { consentText, leavesMachineNote, startBlocker } from '../../pages/meetingsView'
import type { Gate } from '../../pages/chatView'
import { clearRecorder, startRecording } from './recorder'
import { useRecorder } from './RecordingBanner'

export function NewMeeting({ gate, onStarted }: { gate: Gate['state']; onStarted: (meetingId: string) => void }) {
  const rec = useRecorder()
  const [title, setTitle] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const recording = rec.phase === 'recording' || rec.phase === 'paused' || rec.phase === 'finalizing'
  const blocker = startBlocker(title, consent, gate, recording)

  async function start(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      clearRecorder()
      const r = await window.lens.meetings.start({ title: title.trim(), participantsInformed: true })
      if (!r.ok) return setMsg(r.error.message)
      const err = await startRecording({ meetingId: r.data.meetingId, title: title.trim(), mimeAllowlist: r.data.mimeAllowlist, maxChunks: r.data.limits.maxChunks })
      if (err) {
        // Main armed the meeting but nothing was recorded: close it (disarms the mic gate).
        await window.lens.meetings.stop({ meetingId: r.data.meetingId, chunks: 0 })
        setMsg(err)
      } else {
        setTitle('')
        setConsent(false)
      }
      onStarted(r.data.meetingId)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card meet-new" data-testid="meeting-new">
      <h2 className="meet-h2">{tr('New meeting', '新会议')}</h2>
      <p className="tiny muted">{leavesMachineNote()}</p>
      <div className="meet-row">
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder={tr('Meeting title', '会议标题')} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label={tr('Meeting title', '会议标题')} disabled={recording} />
      </div>
      <label className="meet-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={recording} />
        <span>{consentText()}</span>
      </label>
      <div className="meet-row">
        <button className="btn small primary" disabled={busy || blocker !== null} onClick={() => void start()} title={blocker ?? undefined}>
          {tr('Start recording…', '开始录音…')}
        </button>
        {blocker && !recording ? <span className="tiny muted">{blocker}</span> : null}
      </div>
      {rec.error ? <p className="tiny meet-error">{rec.error}</p> : null}
      {msg ? <p className="tiny meet-error">{msg}</p> : null}
    </section>
  )
}
