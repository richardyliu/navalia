// OG-04 Quick Box (renderer for the `#quickbox` window). Three modes, all local:
// 快速问 = memory search via the same `lens:mcp:search` IPC as the Search page (no LLM call; the
// Ask page makes none either), 快速记 = the same `lens:mcp:remember` IPC as RememberDialog,
// 快速打开 = jump the main window to a page. The clipboard is read only when the user presses
// "粘贴剪贴板"; selection / clipboard are never read automatically.
import { useEffect, useRef, useState } from 'react'
import type { MemorySearchHit } from '../../../../shared/types'
import { QUICK_OPEN_PAGES, type QuickOpenPage } from '../../../../main/shell/api'
import { matchPages, routeQuickInput, splitPrefix, type QuickMode } from '../../../../main/shell/intent'
import { api, errorMessage } from '../../lib/api'
import './quickbox.css'
import { tr } from '../../lib/i18n'

const MODES: Array<{ id: QuickMode; label: string; hint: string; placeholder: string }> = [
  {
    id: 'ask',
    get label() { return tr('Quick ask', '快速问') },
    hint: '?',
    get placeholder() { return tr('Search local memory… (no LLM call)', '搜索本地记忆…（不调用 LLM）') }
  },
  {
    id: 'remember',
    get label() { return tr('Quick note', '快速记') },
    hint: '+',
    get placeholder() { return tr('One self-contained fact; Enter saves it to memory', '一条自包含的事实，回车写入记忆') }
  },
  {
    id: 'open',
    get label() { return tr('Quick open', '快速打开') },
    hint: '>',
    get placeholder() { return tr('Page name, e.g. Capture / HET / settings', '页面名，例如 采集 / HET / settings') }
  }
]

const pageLabel = (id: QuickOpenPage): string | undefined => QUICK_OPEN_PAGES.find((p) => p.id === id)?.label

type Outcome =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  | { kind: 'hits'; hits: MemorySearchHit[] }
  | { kind: 'remembered'; entryId: string }

export function QuickBox() {
  const [mode, setMode] = useState<QuickMode>('ask')
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const [clipNote, setClipNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    document.title = 'Quick Box'
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void window.lens.shell.closeQuickBox()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const effective = splitPrefix(mode, text).mode
  const pageMatches = effective === 'open' ? matchPages(splitPrefix(mode, text).text) : []

  async function openPage(page: QuickOpenPage): Promise<void> {
    const r = await window.lens.shell.openPage(page)
    if (!r.ok) setOutcome({ kind: 'error', message: r.error.message })
  }

  async function submit(): Promise<void> {
    const intent = routeQuickInput(mode, text)
    if (intent.kind === 'invalid') {
      setOutcome({ kind: 'error', message: intent.reason })
      return
    }
    if (intent.kind === 'open') {
      await openPage(intent.page)
      return
    }
    setOutcome({ kind: 'busy' })
    try {
      if (intent.kind === 'ask') {
        const res = await api.search(intent.query, 8)
        setOutcome({ kind: 'hits', hits: res.results })
      } else {
        const res = await api.remember(intent.content)
        setOutcome({ kind: 'remembered', entryId: res.entry_id })
        setText('')
      }
    } catch (error) {
      setOutcome({ kind: 'error', message: errorMessage(error) })
    }
  }

  async function pasteClipboard(): Promise<void> {
    const r = await window.lens.shell.readClipboard()
    if (!r.ok) {
      setClipNote(r.error.message)
      return
    }
    if (!r.data.text.trim()) {
      setClipNote(tr('The clipboard has no text', '剪贴板没有文本'))
      return
    }
    setText(r.data.text)
    setClipNote(
      r.data.truncated ? tr('Pasted (truncated to 20000 chars)', '已粘贴（已截断到 20000 字）') : tr('Pasted clipboard text', '已粘贴剪贴板文本')
    )
    inputRef.current?.focus()
  }

  const current = MODES.find((m) => m.id === mode) ?? MODES[0]

  return (
    <div className="quickbox" data-testid="quickbox">
      <div className="quickbox-head">
        <div className="segmented">
          {MODES.map((m) => (
            <button
              key={m.id}
              data-testid={`quickbox-mode-${m.id}`}
              className={`seg-btn ${effective === m.id ? 'active' : ''}`}
              onClick={() => {
                setMode(m.id)
                setOutcome({ kind: 'idle' })
                inputRef.current?.focus()
              }}
            >
              {m.label} <small>{m.hint}</small>
            </button>
          ))}
        </div>
        <span className="tiny muted">{tr('Esc to close', 'Esc 关闭')}</span>
      </div>

      <textarea
        ref={inputRef}
        className="textarea quickbox-input"
        data-testid="quickbox-input"
        rows={effective === 'remember' ? 4 : 2}
        placeholder={current.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />

      <div className="quickbox-tools">
        <button className="btn ghost small" data-testid="quickbox-paste" onClick={() => void pasteClipboard()}>
          {tr('Paste clipboard', '粘贴剪贴板')}
        </button>
        <span className="tiny muted">{clipNote ??
            tr(
              "Copy your selection first (⌘C), then click here. Navalia never reads the clipboard or selection on its own.",
              '划词后先复制（⌘C），再点这里；Navalia 不会自动读取剪贴板或选区。'
            )}</span>
        <button className="btn primary small" data-testid="quickbox-submit" onClick={() => void submit()} disabled={outcome.kind === 'busy'}>
          {effective === 'ask' ? tr('Search', '搜索') : effective === 'remember' ? tr('Save to memory', '写入记忆') : tr('Open', '打开')}
        </button>
      </div>

      <div className="quickbox-out">
        {effective === 'open' ? (
          <ul className="quickbox-pages">
            {pageMatches.length === 0 ? <li className="muted small">{tr('No matching pages', '没有匹配的页面')}</li> : null}
            {pageMatches.map((p) => (
              <li key={p}>
                <button className="btn ghost small" onClick={() => void openPage(p)}>
                  {pageLabel(p)} <span className="mono tiny muted">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {outcome.kind === 'busy' ? <p className="muted small">{tr('Working…', '处理中…')}</p> : null}
        {outcome.kind === 'error' ? <div className="banner bad compact">{outcome.message}</div> : null}
        {outcome.kind === 'remembered' ? (
          <div className="banner ok compact">
            {tr('Saved to memory, entry id ', '已写入记忆，entry id ')}
            <code>{outcome.entryId}</code>
            {tr(' (no LLM; it enters the model on the next build).', '（不走 LLM，下次 build 进入模型）。')}
          </div>
        ) : null}
        {outcome.kind === 'hits' ? (
          outcome.hits.length === 0 ? (
            <p className="muted small">{tr('No related memories found.', '没有找到相关记忆。')}</p>
          ) : (
            <ul className="quickbox-hits">
              {outcome.hits.map((h) => (
                <li key={h.id}>
                  <div className="small">{h.content.length > 280 ? `${h.content.slice(0, 280)}…` : h.content}</div>
                  <div className="mono tiny muted ellipsis">{h.path}</div>
                </li>
              ))}
              <li>
                <button className="btn ghost small" onClick={() => void openPage('search')}>
                  {tr('See more in Search', '在「搜索」页查看更多')}
                </button>
              </li>
            </ul>
          )
        ) : null}
      </div>
    </div>
  )
}
