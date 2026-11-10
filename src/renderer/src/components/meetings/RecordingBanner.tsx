// Persistent recording indicator (S1-FULL C12). Reads the module-level recorder singleton, so it
// stays correct on every page. Mounted by the Meetings page; App can also mount it globally
// (wiring request in docs/design/s1full-log/C12-C14.md) so the banner shows on every page.
import { useSyncExternalStore } from 'react'
import { tr } from '../../lib/i18n'
import { formatClock } from '../../pages/meetingsView'
import { pauseRecording, recorderSnapshot, resumeRecording, stopRecording, subscribeRecorder } from './recorder'

export function useRecorder() {
  return useSyncExternalStore(subscribeRecorder, recorderSnapshot)
}

export function RecordingBanner({ onOpen }: { onOpen?: () => void }) {
  const r = useRecorder()
  if (r.phase !== 'recording' && r.phase !== 'paused' && r.phase !== 'finalizing') return null
  return (
    <div className="meet-banner" role="status" aria-live="polite" data-testid="meeting-recording-banner">
      <span className={`meet-dot${r.phase === 'recording' ? ' live' : ''}`} aria-hidden />
      <strong>{r.phase === 'paused' ? tr('Recording paused', '录音已暂停') : r.phase === 'finalizing' ? tr('Finishing recording', '正在结束录音') : tr('Recording', '正在录音')}</strong>
      <span className="mono">{formatClock(r.totalMs)}</span>
      <span className="muted small meet-banner-title">{r.title}</span>
      {r.phase === 'recording' ? (
        <button className="btn small ghost" onClick={pauseRecording}>
          {tr('Pause', '暂停')}
        </button>
      ) : null}
      {r.phase === 'paused' ? (
        <button className="btn small ghost" onClick={resumeRecording}>
          {tr('Resume', '继续')}
        </button>
      ) : null}
      {r.phase !== 'finalizing' ? (
        <button className="btn small ghost danger" onClick={stopRecording}>
          {tr('Stop', '停止')}
        </button>
      ) : null}
      {onOpen ? (
        <button className="btn small ghost" onClick={onOpen}>
          {tr('Open Meetings', '打开会议页')}
        </button>
      ) : null}
    </div>
  )
}
