import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { RememberDialog } from '../components/RememberDialog'
import { ocrStatusView } from '../components/ask/ocrStatus'
import { useOcrDiagnostics } from '../components/ask/OcrStatusPanel'
import type { CaptureSearchHit, MemorySearchHit, RecentActivityResponse, SearchResponse } from '../../../shared/types'
import { api, errorMessage } from '../lib/api'
import { copiedToast } from '../components/Toaster'
import { formatDateTime, truncate } from '../lib/format'
import { tr } from '../lib/i18n'

type Mode = 'memory' | 'captures' | 'recent'

function modes(): Array<{ id: Mode; label: string; hint: string }> {
  return [
    { id: 'memory', label: tr('Memory', '记忆'), hint: tr('Compressed durable memory', '压缩后的持久记忆') },
    { id: 'captures', label: tr('Screen', '屏幕'), hint: tr('Raw screen text', '原始屏幕文本') },
    { id: 'recent', label: tr('Recent', '最近'), hint: tr('Latest memory entries', '最新记忆条目') }
  ]
}

function MemoryHit({ hit, onOpen }: { hit: MemorySearchHit; onOpen: (ref: string) => void }) {
  return (
    <button className="search-hit" onClick={() => onOpen(hit.id)}>
      <div className="search-hit-head">
        <span className="chip subtle">{hit.path}</span>
        <span>{formatDateTime(hit.timestamp)}</span>
        {typeof hit.age_days === 'number' ? <span>{tr(`${hit.age_days}d ago`, `${hit.age_days} 天前`)}</span> : null}
      </div>
      <p>{truncate(hit.content.replace(/\s+/g, ' '), 360)}</p>
    </button>
  )
}

function CaptureHit({ hit }: { hit: CaptureSearchHit }) {
  return (
    <div className="search-hit capture">
      <div className="search-hit-head">
        <span className="chip subtle">{hit.app_name}</span>
        {hit.window_title ? <span>{truncate(hit.window_title, 60)}</span> : null}
        <span>{formatDateTime(hit.timestamp)}</span>
      </div>
      <pre className="snippet">{hit.snippet}</pre>
      <div className="search-hit-foot">
        <span className="mono tiny muted">{hit.file_stem}</span>
        <button
          className="btn ghost small"
          onClick={async () => {
            await api.copy(hit.file_stem)
            copiedToast('file_stem')
          }}
        >
          {tr('Copy file_stem', '复制 file_stem')}
        </button>
      </div>
    </div>
  )
}

export function Search() {
  const [mode, setMode] = useState<Mode>('recent')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [rememberOpen, setRememberOpen] = useState(false)

  const memory = useQuery<SearchResponse<MemorySearchHit>>({
    queryKey: ['search-memory', query],
    queryFn: () => api.search(query, 20),
    enabled: mode === 'memory' && query.trim().length > 0,
    staleTime: 30_000
  })

  const captures = useQuery<SearchResponse<CaptureSearchHit>>({
    queryKey: ['search-captures', query],
    queryFn: () => api.searchCaptures(query, 20),
    enabled: mode === 'captures' && query.trim().length > 0,
    staleTime: 30_000
  })

  const recent = useQuery<RecentActivityResponse>({
    queryKey: ['recent'],
    queryFn: () => api.recent(30),
    enabled: mode === 'recent',
    staleTime: 30_000
  })

  // S1-R3-09: raw-capture search must not look complete for WeChat when OCR is not confirmed on.
  const ocrDiag = useOcrDiagnostics()
  const ocr = ocrStatusView(ocrDiag.data?.runtimeOcr ?? null, ocrDiag.data?.config.ocr ?? null)

  function submit(): void {
    setQuery(input.trim())
  }

  const active = mode === 'memory' ? memory : mode === 'captures' ? captures : recent
  const error = active.error

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Search</div>
          <h2>{tr('Search', '搜索')}</h2>
          <p className="muted">
            {tr(
              'Through local MCP: memory / raw screen / recent activity, with no cloud at all.',
              '走本地 MCP：记忆 / 原始屏幕 / 最近活动，全部零云端。'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => setRememberOpen(true)}>
            {tr('Remember something', '记住一条')}
          </button>
        </div>
      </header>

      {mode === 'captures' && ocr.wechatWarning ? (
        <div className="banner compact warn" data-testid="search-ocr-warning">
          {ocr.wechatWarning}
        </div>
      ) : null}

      <div className="card search-card">
        <div className="segmented">
          {modes().map((item) => (
            <button
              key={item.id}
              className={`seg-btn ${mode === item.id ? 'active' : ''}`}
              onClick={() => setMode(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>

        {mode !== 'recent' ? (
          <div className="search-row">
            <input
              className="input search-input"
              placeholder={
                mode === 'memory'
                  ? tr("Describe what you're looking for; exact wording not required", '描述你在找什么，不要求原文')
                  : tr('Enter keywords that appeared on screen', '输入屏幕上出现过的关键词')
              }
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
            <button className="btn primary" onClick={submit} disabled={!input.trim()}>
              {tr('Search', '搜索')}
            </button>
          </div>
        ) : (
          <div className="search-row">
            <span className="muted small">{tr('Recent memory entries, newest first.', '按时间倒序展示最近的记忆条目。')}</span>
          </div>
        )}

        {error ? <div className="banner bad compact">{errorMessage(error)}</div> : null}

        {active.isFetching ? <p className="muted small">{tr('Searching…', '搜索中…')}</p> : null}

        {mode === 'memory' && query && memory.data ? (
          memory.data.results.length === 0 ? (
            <p className="muted">{tr('No matching memories.', '没有匹配的记忆。')}</p>
          ) : (
            <div className="search-results">
              {memory.data.results.map((hit) => (
                <MemoryHit key={hit.id} hit={hit} onOpen={setSelected} />
              ))}
            </div>
          )
        ) : null}

        {mode === 'captures' && query && captures.data ? (
          captures.data.results.length === 0 ? (
            <p className="muted">{tr('No matching screen records.', '没有匹配的屏幕记录。')}</p>
          ) : (
            <div className="search-results">
              {captures.data.results.map((hit) => (
                <CaptureHit key={`${hit.file_stem}-${hit.timestamp}`} hit={hit} />
              ))}
            </div>
          )
        ) : null}

        {mode === 'recent' && recent.data ? (
          recent.data.entries.length === 0 ? (
            <p className="muted">{tr('No memory entries yet.', '还没有记忆条目。')}</p>
          ) : (
            <div className="search-results">
              {recent.data.entries.map((hit) => (
                <MemoryHit key={hit.id} hit={hit} onOpen={setSelected} />
              ))}
            </div>
          )
        ) : null}
      </div>

      {selected ? (
        <EvidenceDrawer reference={selected} onClose={() => setSelected(null)} onNavigate={setSelected} />
      ) : null}
      {rememberOpen ? <RememberDialog onClose={() => setRememberOpen(false)} /> : null}
    </div>
  )
}
