// One meeting: status / upload progress, transcript, Markdown preview → 「写入记忆」, optional cloud
// summary (preview → send → remember), delete. Every write goes through a native confirm in main.
import { useEffect, useState } from 'react'
import type { MeetingDeleteResult, MeetingDetail as Detail, MeetingMarkdownPreview, MeetingSummaryPreview } from '../../../../main/cloud/meetings-api'
import type { Gate } from '../../pages/chatView'
import { intlLocale, tr } from '../../lib/i18n'
import { actionsFor, chunkProgress, errorLabel, formatClock, importResultText, isTerminal, runtimeDeleteNote, runtimeDeleteText, serverGoneNote, speakerNote, statusLabel } from '../../pages/meetingsView'
import { useRecorder } from './RecordingBanner'

type Res<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

export function MeetingDetail({ meetingId, gate, onDeleted }: { meetingId: string; gate: Gate['state']; onDeleted: (r: MeetingDeleteResult) => void }) {
  const rec = useRecorder()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [md, setMd] = useState<MeetingMarkdownPreview | null>(null)
  const [sum, setSum] = useState<MeetingSummaryPreview | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function load(): Promise<void> {
    const r = await window.lens.meetings.get(meetingId)
    if (r.ok) setDetail(r.data)
    else setMsg(r.error.message)
  }

  useEffect(() => {
    setDetail(null)
    setMd(null)
    setSum(null)
    setMsg(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId])

  // Refresh local state while main uploads / polls (only while this page is visible).
  const terminal = detail ? isTerminal(detail.meta.localStatus) : true
  useEffect(() => {
    if (terminal) return
    const t = setInterval(() => void load(), 2_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, meetingId])

  async function act<T>(fn: () => Promise<Res<T>>, done: (d: T) => void): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      if (r.ok) done(r.data)
      else setMsg(r.error.message)
    } finally {
      setBusy(false)
    }
  }

  if (!detail) return <section className="card">{msg ?? tr('Loading…', '加载中…')}</section>
  const m = detail.meta
  const recordingThis = rec.meetingId === m.id && rec.phase !== 'idle' && rec.phase !== 'stopped'
  const a = actionsFor(m, gate, recordingThis)
  const prog = chunkProgress(m)

  return (
    <section className="card meet-detail" data-testid="meeting-detail">
      <div className="meet-row">
        <h2 className="meet-h2">{m.title}</h2>
        <span className="chip">{statusLabel(m)}</span>
      </div>
      <p className="tiny muted">
        {new Date(m.createdAt).toLocaleString(intlLocale())} · {tr(`Duration ${formatClock(m.durationMs)}`, `时长 ${formatClock(m.durationMs)}`)} · {prog.text}
        {m.audioDeleted ? tr(' · local audio deleted', ' · 本地音频已删除') : ''}
      </p>
      {errorLabel(m.errorCode) ? <p className="tiny meet-error">{errorLabel(m.errorCode)}</p> : null}
      {m.serverGone && m.transcript ? <p className="tiny muted">{serverGoneNote()}</p> : null}
      <div className="meet-row">
        {a.canRetry ? (
          <button className="btn small ghost" disabled={busy} onClick={() => void act(() => window.lens.meetings.retry(m.id), () => void load())}>
            {tr('Retry upload / refresh status', '重试上传 / 刷新状态')}
          </button>
        ) : null}
        {a.canMarkdown ? (
          <button className="btn small" disabled={busy} onClick={() => void act(() => window.lens.meetings.markdownPreview(m.id), setMd)}>
            {tr('Preview Markdown', '预览 Markdown')}
          </button>
        ) : null}
        {a.canSummarize ? (
          <button
            className="btn small"
            disabled={busy}
            onClick={() =>
              void act(() => window.lens.meetings.summaryPreview(m.id), (p) => {
                setSum(p)
                setPicked(new Set(p.items.map((i) => i.id)))
              })
            }
          >
            {tr('Summarize with cloud', '用云端生成摘要')}
          </button>
        ) : null}
        {a.canDelete ? (
          <button
            className="btn small ghost danger"
            disabled={busy}
            onClick={() => void act(() => window.lens.meetings.delete({ meetingId: m.id, localOnly: gate !== 'ready' }), onDeleted)}
            title={gate !== 'ready' ? tr('Not signed in to Cloud: only local files are deleted', '云端未登录：只删除本机文件') : undefined}
          >
            {gate === 'ready' ? tr('Delete meeting…', '删除会议…') : tr('Delete local files…', '删除本机文件…')}
          </button>
        ) : null}
      </div>
      {m.imported ? (
        <p className="tiny muted">
          {tr(
            `${importResultText(m.imported)} (${new Date(m.imported.at).toLocaleString(intlLocale())}). ${m.imported.ok && !m.imported.runtimeDeletedAt ? runtimeDeleteNote() : ''}`,
            `${importResultText(m.imported)}（${new Date(m.imported.at).toLocaleString(intlLocale())}）。${m.imported.ok && !m.imported.runtimeDeletedAt ? runtimeDeleteNote() : ''}`
          )}
        </p>
      ) : null}
      {a.canDeleteFromRuntime ? (
        <div className="meet-row">
          <button
            className="btn small ghost danger"
            data-testid="meeting-delete-from-runtime"
            disabled={busy}
            onClick={() =>
              void act(
                () => window.lens.meetings.deleteFromRuntime(m.id),
                (r) => {
                  setMsg(runtimeDeleteText(r))
                  void load()
                }
              )
            }
            title={tr(
              'Delete the imported transcript and meeting summary this meeting wrote to the local Persome Runtime (a system confirmation appears first)',
              '删除这场会议写入本机 Persome Runtime 的导入转写和会议摘要（会先弹出系统确认）'
            )}
          >
            {tr('Delete from Persome…', '从 Persome 删除…')}
          </button>
        </div>
      ) : null}

      {md ? (
        <div className="meet-block">
          <div className="meet-row">
            <strong>{tr('Markdown to be written', '将写入的 Markdown')}</strong>
            <span className="tiny muted">
              {tr(
                `${md.chars.toLocaleString('en-US')} chars · ${md.redactions} redacted · file name ${md.fileName}`,
                `${md.chars.toLocaleString('en-US')} 字 · 已脱敏 ${md.redactions} 处 · 文件名 ${md.fileName}`
              )}
            </span>
          </div>
          <pre className="meet-pre" data-testid="meeting-markdown">{md.markdown}</pre>
          <p className="tiny muted">{runtimeDeleteNote()}</p>
          {a.canImport ? (
            <button
              className="btn small primary"
              disabled={busy}
              onClick={() =>
                void act(() => window.lens.meetings.importToRuntime(md.previewId), (r) => {
                  setMsg(importResultText(r) + (r.stderr ? `\n${r.stderr}` : ''))
                  setMd(null)
                  void load()
                })
              }
            >
              {tr('Write to memory…', '写入记忆…')}
            </button>
          ) : (
            <span className="tiny muted">{tr('Already written to memory', '已写入过记忆')}</span>
          )}
        </div>
      ) : null}

      {sum ? (
        <div className="meet-block">
          <strong>{tr('Transcript parts to send to the cloud', '将发送到云端的转写片段')}</strong>
          <p className="tiny muted">
            {tr(
              `Only the ticked parts and a fixed summary instruction are sent; ${sum.totalChars.toLocaleString('en-US')} characters in total.`,
              `只发送勾选的片段和固定的摘要指令；共 ${sum.totalChars.toLocaleString('en-US')} 字符。`
            )}
          </p>
          {sum.warnings.map((w) => (
            <p key={w} className="tiny meet-error">
              {w}
            </p>
          ))}
          {sum.items.map((i) => (
            <details key={i.id} className="meet-item">
              <summary>
                <input
                  type="checkbox"
                  checked={picked.has(i.id)}
                  onChange={(e) => {
                    const n = new Set(picked)
                    if (e.target.checked) n.add(i.id)
                    else n.delete(i.id)
                    setPicked(n)
                  }}
                />{' '}
                {i.id} · {i.title} · {tr(`${i.chars} chars`, `${i.chars} 字`)}
              </summary>
              <pre className="meet-pre">{i.text}</pre>
            </details>
          ))}
          <button
            className="btn small primary"
            disabled={busy || picked.size === 0}
            onClick={() =>
              void act(() => window.lens.meetings.summarySend({ previewId: sum.previewId, includeIds: [...picked] }), () => {
                setSum(null)
                void load()
              })
            }
          >
            {tr('Send and summarize', '发送并生成摘要')}
          </button>
        </div>
      ) : null}

      {m.summary ? (
        <div className="meet-block">
          <div className="meet-row">
            <strong>{tr('Cloud summary', '云端摘要')}</strong>
            <span className="tiny muted">
              {m.summary.status === 'complete' ? '' : m.summary.status === 'truncated' ? tr(' (truncated)', '（被截断）') : tr(' (incomplete)', '（不完整）')}
              {m.summary.model ? ` · ${m.summary.model}` : ''}
            </span>
          </div>
          <pre className="meet-pre">{m.summary.text}</pre>
          {a.canRememberSummary ? (
            <button className="btn small" disabled={busy} onClick={() => void act(() => window.lens.meetings.rememberSummary(m.id), () => void load())}>
              {tr('Remember this summary…', '记住这条摘要…')}
            </button>
          ) : m.summary.rememberedEntryId ? (
            <span className="tiny muted">{tr(`Written to memory (${m.summary.rememberedEntryId})`, `已写入记忆（${m.summary.rememberedEntryId}）`)}</span>
          ) : null}
        </div>
      ) : null}

      {detail.transcript ? (
        <div className="meet-block">
          <strong>
            {tr(
              `Transcript (${detail.transcript.language ?? 'unknown language'}, ${detail.transcript.segments.length} segments)`,
              `转写（${detail.transcript.language ?? '未知语言'}，${detail.transcript.segments.length} 段）`
            )}
          </strong>
          <p className="tiny muted">{speakerNote()}</p>
          <div className="meet-transcript">
            {detail.transcript.segments.map((s, i) => (
              <p key={i} className="small">
                <span className="mono muted">[{formatClock(s.start_ms)}]</span> {s.speaker ? <strong>{tr(`${s.speaker}: `, `${s.speaker}：`)}</strong> : null}
                {s.text}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {msg ? <p className="tiny meet-msg">{msg}</p> : null}
    </section>
  )
}
