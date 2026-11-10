import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RewindApi, RewindFrameView, RewindListQuery, RewindViewResult } from '../../../main/rewind/api'
import { formatDateTime } from '../lib/format'
import { intlLocale, tr } from '../lib/i18n'
import { unwrap, errorMessage } from '../lib/api'

// OG-05 Rewind: screenshot history over the Runtime capture buffer. Listing is metadata only;
// a screenshot is decrypted in main on demand, one at a time, and only held in component state.
const rewind = (): RewindApi['rewind'] => (window.lens as unknown as RewindApi).rewind

const PAGE = 50

type Preset = '1h' | 'today' | '24h' | '7d' | 'all' | 'custom'

const PRESET_LABEL: Record<Preset, string> = {
  get '1h'() { return tr('Last hour', '最近 1 小时') },
  get today() { return tr('Today', '今天') },
  get '24h'() { return tr('Last 24 hours', '最近 24 小时') },
  get '7d'() { return tr('Last 7 days', '最近 7 天') },
  get all() { return tr('All', '全部') },
  get custom() { return tr('Custom', '自定义') }
}

function presetRange(p: Preset): { since?: string; until?: string } {
  const now = Date.now()
  if (p === '1h') return { since: new Date(now - 3600_000).toISOString() }
  if (p === '24h') return { since: new Date(now - 24 * 3600_000).toISOString() }
  if (p === '7d') return { since: new Date(now - 7 * 24 * 3600_000).toISOString() }
  if (p === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return { since: d.toISOString() }
  }
  return {}
}

/** `<input type="datetime-local">` value (local time) → ISO, or undefined when empty/invalid. */
function localToIso(v: string): string | undefined {
  if (!v) return undefined
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

function hourKey(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const s = new Intl.DateTimeFormat(intlLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit' }).format(d)
  return tr(s, `${s} 时`)
}

export function Rewind() {
  const [preset, setPreset] = useState<Preset>('24h')
  const [customSince, setCustomSince] = useState('')
  const [customUntil, setCustomUntil] = useState('')
  const [appName, setAppName] = useState('')
  const [frames, setFrames] = useState<RewindFrameView[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  // Last page stopped at the per-call scan budget (Broker SCAN_BUDGET) before filling `limit`.
  const [partial, setPartial] = useState(false)
  const [keyAvailable, setKeyAvailable] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [seenApps, setSeenApps] = useState<string[]>([])
  const [selected, setSelected] = useState<RewindFrameView | null>(null)
  const [view, setView] = useState<RewindViewResult | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const generation = useRef(0)

  const query = useMemo<RewindListQuery>(() => {
    const range = preset === 'custom' ? { since: localToIso(customSince), until: localToIso(customUntil) } : presetRange(preset)
    const q: RewindListQuery = { limit: PAGE }
    if (range.since) q.since = range.since
    if (range.until) q.until = range.until
    if (appName.trim()) q.appName = appName.trim()
    return q
    // presetRange reads the clock; recompute only when filters change.
  }, [preset, customSince, customUntil, appName])

  const load = useCallback(
    async (append: boolean, after: string | null) => {
      const gen = ++generation.current
      setLoading(true)
      setListError(null)
      try {
        const r = await unwrap(rewind().list(after ? { ...query, cursor: after } : query))
        if (gen !== generation.current) return
        setFrames((prev) => (append ? [...prev, ...r.frames] : r.frames))
        setCursor(r.nextCursor)
        setPartial(Boolean(r.partial) && r.nextCursor !== null)
        setKeyAvailable(r.keyAvailable)
        setSeenApps((prev) => {
          const set = new Set(prev)
          for (const f of r.frames) if (f.appName) set.add(f.appName)
          return [...set].sort((a, b) => a.localeCompare(b))
        })
      } catch (error) {
        if (gen !== generation.current) return
        setListError(errorMessage(error))
        if (!append) setFrames([])
        setCursor(null)
        setPartial(false)
      } finally {
        if (gen === generation.current) setLoading(false)
      }
    },
    [query]
  )

  useEffect(() => {
    void load(false, null)
  }, [load])

  async function open(frame: RewindFrameView): Promise<void> {
    setSelected(frame)
    setView(null)
    setViewError(null)
    if (!frame.hasScreenshot) return
    setViewLoading(true)
    try {
      const r = await unwrap(rewind().view(frame.fileStem))
      setView(r)
    } catch (error) {
      setViewError(errorMessage(error))
    } finally {
      setViewLoading(false)
    }
  }

  function close(): void {
    setSelected(null)
    setView(null)
    setViewError(null)
  }

  const groups = useMemo(() => {
    const out: Array<{ key: string; items: RewindFrameView[] }> = []
    for (const f of frames) {
      const k = hourKey(f.timestamp)
      const last = out[out.length - 1]
      if (last && last.key === k) last.items.push(f)
      else out.push({ key: k, items: [f] })
    }
    return out
  }, [frames])

  return (
    <div className="page rewind-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Rewind</div>
          <h2>{tr('Screenshot history', '截图历史')}</h2>
          <p className="muted">
            {tr(
              "Browse frames in the Runtime capture buffer by time. The list holds metadata only; a screenshot is decrypted in the main process only when you open a frame, shown on this page only, never written to disk or cached, and the key never enters the page. Screenshots are kept only for the Runtime's retention period (24 hours by default); expired frames keep only text.",
              '按时间浏览 Runtime capture buffer 里的帧。列表只含元数据；点开某一帧时，截图才在主进程里按需解密，只用于本页显示，不写盘、不缓存、密钥不进入页面。截图只保留 Runtime 设定的保留期（默认 24 小时），过期帧只剩文字。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => void load(false, null)} disabled={loading}>
            ↻ {tr('Refresh', '刷新')}
          </button>
        </div>
      </header>

      {keyAvailable === false ? (
        <div className="banner warn compact rewind-blocked">
          <span>
            <strong>{tr('BLOCKED: screenshot key missing. ', 'BLOCKED：缺少截图密钥。')}</strong>
            {tr(
              "The Runtime env file has no usable PERSOME_SCREENSHOT_KEY (or its permissions aren't owner-only), so screenshots can't be decrypted. You can still browse the frame list; Navalia never guesses the key and never shows unencrypted screenshots.",
              'Runtime 的 env 文件里没有可用的 PERSOME_SCREENSHOT_KEY（或文件权限不是仅本人可读），截图无法解密。帧列表仍可浏览；Navalia 不会猜测密钥，也不会显示未加密截图。'
            )}
          </span>
        </div>
      ) : null}
      {listError ? <div className="banner bad compact">{listError}</div> : null}

      <section className="card rewind-filters">
        <div className="card-foot wrap">
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <button key={p} className={`btn small ${preset === p ? '' : 'ghost'}`} onClick={() => setPreset(p)}>
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>
        {preset === 'custom' ? (
          <div className="card-foot wrap">
            <label className="small">
              {tr('Start', '开始')}{' '}
              <input className="input" type="datetime-local" value={customSince} onChange={(e) => setCustomSince(e.target.value)} />
            </label>
            <label className="small">
              {tr('End', '结束')}{' '}
              <input className="input" type="datetime-local" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)} />
            </label>
          </div>
        ) : null}
        <div className="card-foot wrap">
          <label className="small">
            {tr('App', '应用')}{' '}
            <input
              className="input"
              list="rewind-apps"
              placeholder={tr('All apps (type the full app name)', '全部应用（输入完整应用名）')}
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
            />
          </label>
          <datalist id="rewind-apps">
            {seenApps.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          {appName ? (
            <button className="btn ghost small" onClick={() => setAppName('')}>
              {tr('Clear app filter', '清除应用筛选')}
            </button>
          ) : null}
        </div>
      </section>

      <div className="rewind-body" style={{ display: 'grid', gridTemplateColumns: selected ? 'minmax(320px, 1fr) minmax(360px, 1.4fr)' : '1fr', gap: 16 }}>
        <section className="card rewind-timeline">
          <div className="card-head">
            <h3>{tr('Timeline', '时间线')}</h3>
            <span className="muted small">{tr(`Newest first · ${frames.length} frames loaded`, `新的在前 · 已加载 ${frames.length} 帧`)}</span>
          </div>
          {!loading && frames.length === 0 && !listError ? (
            <p className="muted small">{cursor
                ? tr(
                    "No matches in the frames checked so far; earlier frames haven't been checked yet, so you can keep searching back.",
                    '已检查的帧里没有匹配项；更早的帧还没检查，可继续向前查找。'
                  )
                : tr('No frames in this range.', '这个范围内没有帧。')}</p>
          ) : null}
          {groups.map((g) => (
            <div key={g.key} className="rewind-group">
              <div className="eyebrow">{g.key}</div>
              <table className="table">
                <tbody>
                  {g.items.map((f) => (
                    <tr
                      key={f.fileStem}
                      data-stem={f.fileStem}
                      className={selected?.fileStem === f.fileStem ? 'active' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => void open(f)}
                    >
                      <td className="small" style={{ width: 150 }}>
                        {formatDateTime(f.timestamp)}
                      </td>
                      <td style={{ width: 140 }}>{f.appName ?? '—'}</td>
                      <td>
                        <div className="ellipsis">{f.windowTitle ?? '—'}</div>
                        {f.url ? <div className="mono tiny muted ellipsis">{f.url}</div> : null}
                      </td>
                      <td style={{ width: 72 }}>
                        <span className={`chip ${f.hasScreenshot ? 'ok' : 'subtle'}`}>{f.hasScreenshot ? tr('Screenshot', '截图') : tr('Text only', '仅文字')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="card-foot">
            {cursor ? (
              <button className="btn ghost small" disabled={loading} onClick={() => void load(true, cursor)}>
                {loading ? tr('Loading…', '加载中…') : partial ? tr('Keep searching back', '继续向前查找') : tr('Load earlier frames', '加载更早的帧')}
              </button>
            ) : frames.length > 0 ? (
              <span className="muted tiny">{tr('Reached the start of the range', '已到范围起点')}</span>
            ) : null}
            {loading && !cursor ? <span className="muted tiny">{tr('Loading…', '加载中…')}</span> : null}
          </div>
        </section>

        {selected ? (
          <section className="card rewind-viewer">
            <div className="card-head">
              <h3>{selected.appName ?? tr('Unknown app', '未知应用')}</h3>
              <button className="btn ghost small" onClick={close}>
                {tr('Close', '关闭')}
              </button>
            </div>
            <dl className="kv">
              <div>
                <dt>{tr('Time', '时间')}</dt>
                <dd className="small">{formatDateTime(selected.timestamp)}</dd>
              </div>
              <div>
                <dt>{tr('Window', '窗口')}</dt>
                <dd className="small">{selected.windowTitle ?? '—'}</dd>
              </div>
              {selected.url ? (
                <div>
                  <dt>URL</dt>
                  <dd className="mono tiny">{selected.url}</dd>
                </div>
              ) : null}
            </dl>
            {!selected.hasScreenshot ? <p className="muted small">
                {tr(
                  'This frame has no screenshot (not captured, or stripped after the screenshot retention period).',
                  '该帧没有截图（未采集，或已超过截图保留期被剥离）。'
                )}
              </p> : null}
            {viewLoading ? <p className="muted small">{tr('Decrypting in the main process…', '正在主进程中解密…')}</p> : null}
            {viewError ? <div className="banner bad compact">{viewError}</div> : null}
            {view?.status === 'blocked' ? (
              <div className="banner warn compact">
                <strong>{tr('BLOCKED: ', 'BLOCKED：')}</strong>
                {view.message}
              </div>
            ) : null}
            {view?.status === 'unavailable' ? <div className="banner warn compact">{view.message}</div> : null}
            {view?.status === 'ok' ? (
              <figure style={{ margin: 0 }}>
                <img
                  src={view.dataUrl}
                  alt={`${selected.appName ?? ''} ${selected.windowTitle ?? ''}`}
                  draggable={false}
                  style={{ maxWidth: '100%', borderRadius: 'var(--radius-sm)', display: 'block' }}
                />
                <figcaption className="muted tiny">
                  {view.width && view.height ? `${view.width}×${view.height} · ` : ''}
                  {(view.bytes / 1024).toFixed(0)} KiB · {tr('display only, not saved', '仅用于显示，不保存')}
                </figcaption>
              </figure>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}
