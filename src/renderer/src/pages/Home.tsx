// OG-01 Home dashboard (reference §5.1 / §5.3). Composes existing IPC reads only — no new main
// data, no LLM, no network. Each card: real data, honest empty state, error state, deep link.
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import '../components/home/home.css'
import { buildBrief, localDateIn, previousDate, UNVERIFIED } from '../../../main/library/brief'
import type { PeerList } from '../../../main/peers/api'
import type { WorkflowCatalog } from '../../../main/workflows/api'
import { systemTimeZone, useBriefSources } from '../components/library/useLibrary'
import { useAccessDaily, useConnections } from '../components/connections/useConnections'
import { formatHet } from '../components/het/useHet'
import { Skeleton } from '../components/Skeleton'
import { AiWorkCountsCard } from '../components/home/AiWorkCounts'
import { aiCountsTitle } from '../components/home/aiCountsView'
import { workflowsApi } from '../components/workflows/client'
import {
  accessSummary,
  actionItems,
  AGENT_STATE_LABEL,
  agentStateTone,
  connectionsSummary,
  heatLevel,
  heatmapView,
  hetCardView,
  peersSummary,
  recentItems,
  recentPoints,
  skillsSummary
} from '../components/home/homeView'
import { unwrap } from '../lib/api'
import { formatDateTime, formatNumber, truncate } from '../lib/format'
import { useNav, type Page } from '../lib/nav'
import { useGraph } from '../lib/queries'
import { tr } from '../lib/i18n'

/** Access log window the Connections page also uses. */
const ACCESS_DAYS = 30

interface CardProps {
  id: string
  title: string
  target: Page
  linkLabel: string
  wide?: boolean
  hint?: string
  children: ReactNode
}

function HomeCard({ id, title, target, linkLabel, wide, hint, children }: CardProps) {
  const { go } = useNav()
  return (
    <section className={`card home-card${wide ? ' wide' : ''}`} data-home-card={id}>
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          {hint ? <span className="hint">{hint}</span> : null}
        </div>
        <button className="btn ghost small" onClick={() => go(target)}>
          {linkLabel} →
        </button>
      </div>
      {children}
    </section>
  )
}

/** Loading / error wrapper so every card shows the same honest states. */
function Body<T>({ q, children }: { q: { isLoading: boolean; isError: boolean; error: Error | null; data: T | undefined }; children: (data: T) => ReactNode }) {
  if (q.isLoading) return <Skeleton rows={2} />
  if (q.isError) return <div className="banner bad compact">{tr('Failed to load: ', '读取失败：')}{q.error?.message ?? tr('Unknown error', '未知错误')}</div>
  if (q.data === undefined) return <p className="muted small">{tr('No data.', '没有数据。')}</p>
  return <>{children(q.data)}</>
}

export function Home() {
  const [timezone] = useState(systemTimeZone)
  const { recent, patterns, het } = useBriefSources(timezone)
  const graph = useGraph(true)
  const connections = useConnections()
  const access = useAccessDaily()
  const workflows = useQuery<WorkflowCatalog>({ queryKey: ['workflows'], queryFn: workflowsApi.list, staleTime: 30_000 })
  const peers = useQuery<PeerList>({ queryKey: ['peers', 'list'], queryFn: () => unwrap(window.lens.peers.list()) })

  const briefLoading = recent.isLoading || patterns.isLoading || het.isLoading
  const now = Math.max(recent.dataUpdatedAt, recent.errorUpdatedAt, patterns.dataUpdatedAt, het.dataUpdatedAt, 0) || Date.now()
  const today = localDateIn(now, timezone)
  const brief = useMemo(
    () =>
      briefLoading
        ? null
        : buildBrief({
            now,
            timezone,
            recent: recent.data ?? null,
            recentError: recent.isError ? recent.error.message : null,
            patterns: patterns.data ?? null,
            patternsError: patterns.isError ? patterns.error.message : null,
            het: het.data ?? null,
            hetError: het.isError ? het.error.message : null
          }),
    [briefLoading, now, timezone, recent.data, recent.error, recent.isError, patterns.data, patterns.error, patterns.isError, het.data, het.error, het.isError]
  )
  // VIS-07: if recent activity could not be read, the brief's counts are not measurements — surface
  // the read error instead of rendering "0 条活动 / 0 条未完成".
  const briefQ = recent.isError
    ? { isLoading: false, isError: true as const, error: recent.error, data: undefined }
    : { isLoading: briefLoading, isError: false as const, error: null, data: brief ?? undefined }
  let since = today
  for (let i = 0; i < 6; i++) since = previousDate(since)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Home</div>
          <h2>{tr(`Home · ${today}`, `主页 · ${today}`)}</h2>
          <p className="muted">
            {tr(
              `Summarizes data already on this machine, with no LLM and no network. Cards without data say so instead of filling in numbers. Time zone ${timezone}.`,
              `汇总本机已有数据，不调用 LLM、不联网。没有数据的卡片会直接说没有，不补数字。时区 ${timezone}。`
            )}
          </p>
        </div>
      </header>

      <div className="home-grid">
        <HomeCard
          id="today"
          title={tr('Today', '今天')}
          target="today"
          linkLabel={tr("Today's brief", '今日 brief')}
          hint={tr('Built from a template · marked "Unverified"', `按模板生成 · 标「${UNVERIFIED}」`)}
        >
          <Body q={briefQ}>
            {(b) => (
              <>
                <div className="home-kv small">
                  <span>{tr(`${b.counts.recentToday} ${b.counts.recentToday === 1 ? 'activity' : 'activities'} today`, `今天 ${b.counts.recentToday} 条活动`)}</span>
                  <span>{tr(`${b.counts.review} to review`, `${b.counts.review} 条待核对`)}</span>
                  <span>{tr(`${b.counts.todo} not done`, `${b.counts.todo} 条未完成`)}</span>
                </div>
                {b.nextSteps.length === 0 ? (
                  <p className="muted small">
                    {tr(
                      'No items marked not done and no learned habits, so there is no "next step".',
                      '没有标为未完成的事项，也没有已学到的习惯，所以没有「下一步」。'
                    )}
                  </p>
                ) : (
                  <p className="small">
                    <span className="chip warn">{tr('Unverified', b.nextSteps[0].label)}</span>{' '}
                    {tr(
                      `Next step: "${truncate(b.nextSteps[0].text, 80)}"`,
                      `下一步：“${truncate(b.nextSteps[0].text, 80)}”`
                    )}
                  </p>
                )}
              </>
            )}
          </Body>
        </HomeCard>

        <HomeCard
          id="het"
          title="HET"
          target="het"
          linkLabel={tr('HET panel', 'HET 面板')}
          hint={tr('Human Equivalent Time · not time saved', 'Human Equivalent Time · 不是节省时间')}
        >
          <Body q={het}>
            {(s) => {
              const v = hetCardView(s, today)
              if (v.kind === 'unmeasured')
                return (
                  <>
                    <div className="home-figure unmeasured">{tr('Not measured', '未测量')}</div>
                    <p className="muted small">{v.reason}</p>
                  </>
                )
              return (
                <>
                  <div className={`home-figure${v.todayTenths === null ? ' unmeasured' : ''}`}>
                    {v.todayTenths === null ? tr('Not measured today', '今天未测量') : formatHet(v.todayTenths)}
                  </div>
                  <div className="home-kv tiny muted">
                    <span>
                      {tr(
                        `Last ${v.windowDays} days ${formatHet(v.windowTenths)} · ${v.windowTasks} tasks`,
                        `近 ${v.windowDays} 天 ${formatHet(v.windowTenths)} · ${v.windowTasks} 个任务`
                      )}
                    </span>
                    {v.pending > 0 ? <span>{tr(`${v.pending} awaiting assessment`, `${v.pending} 个待评估`)}</span> : null}
                    {v.failed > 0 ? <span>{tr(`${v.failed} failed`, `${v.failed} 个失败`)}</span> : null}
                    <span>{tr('Unverified', UNVERIFIED)}</span>
                  </div>
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="ai-counts"
          title={aiCountsTitle()}
          target="het"
          linkLabel={tr('HET tasks', 'HET 任务')}
          hint={tr('Counts in the HET ledger · since Monday 00:00 this week', 'HET 账本里的计数 · 本周一 00:00 起')}
        >
          <AiWorkCountsCard timezone={timezone} />
        </HomeCard>

        <HomeCard
          id="actions"
          title={tr('To-dos', '待办')}
          target="today"
          linkLabel={tr("Today's brief", '今日 brief')}
          hint={tr("Items explicitly not done in today's/yesterday's records, quoted as is", '今天/昨天记录里明确未完成的事，只列原文')}
        >
          <Body q={briefQ}>
            {(b) => {
              const items = actionItems(b)
              if (items.length === 0)
                return (
                  <p className="muted small">
                    {tr(
                      'Nothing in the records is marked not done (- [ ] / TODO: / 待办：).',
                      '记录里没有标为未完成的事（- [ ] / TODO: / 待办：）。'
                    )}
                  </p>
                )
              return (
                <ul className="home-list small">
                  {items.slice(0, 5).map((n) => (
                    <li key={n.key}>
                      <span className="line">“{n.text}”</span>
                      {n.source.kind === 'record' ? (
                        <span className="tiny muted">
                          {n.day === 'today' ? tr('Today', '今天') : tr('Yesterday', '昨天')} {n.source.time ?? '--:--'} · <span className="mono">{n.source.path}</span>
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {items.length > 5 ? <li className="tiny muted">{tr(`${items.length - 5} more`, `还有 ${items.length - 5} 条`)}</li> : null}
                </ul>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="memories"
          title={tr('Memory', '记忆')}
          target="model"
          linkLabel={tr('Model', '模型')}
          hint={tr('Runtime model stats and latest Points', 'Runtime 模型统计与最新 Points')}
        >
          <Body q={graph}>
            {(g) => {
              const s = g.model.stats
              const pts = recentPoints(g.model, 4)
              return (
                <>
                  <div className="home-kv small">
                    <span>{formatNumber(s.points)} Points</span>
                    <span>{formatNumber(s.faces)} Faces</span>
                    <span>{formatNumber(s.volumes)} Volumes</span>
                    <span>{tr(`${formatNumber(s.relation_lines)} relation lines`, `${formatNumber(s.relation_lines)} 关系线`)}</span>
                  </div>
                  {pts.length === 0 ? (
                    <p className="muted small">{tr('No Points in the model yet.', '模型里还没有 Point。')}</p>
                  ) : (
                    <ul className="home-list small" style={{ marginTop: 10 }}>
                      {pts.map(({ point, at }) => (
                        <li key={point.id}>
                          <span className="line">{point.content}</span>
                          <span className="tiny muted">
                            {at ? formatDateTime(at) : tr('Time unknown', '时间未知')} · <span className="mono">{point.file_name}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard id="agents" title="Agents" target="connections" linkLabel="Connections" hint={tr('Local Agent connection status', '本机 Agent 连接状态')}>
          <Body q={connections}>
            {(c) =>
              c.agents.length === 0 ? (
                <p className="muted small">{tr('No connectable Agents detected.', '没有检测到可连接的 Agent。')}</p>
              ) : (
                <ul className="home-list small">
                  {c.agents.map((a) => (
                    <li key={a.id} title={a.detail}>
                      {a.name} <span className={`chip ${agentStateTone(a.state)}`}>{AGENT_STATE_LABEL[a.state]}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Body>
        </HomeCard>

        <HomeCard
          id="connections"
          title="Connections"
          target="connections"
          linkLabel={tr('Manage connections', '管理连接')}
          hint={tr('Local Broker · connecting grants full access', '本地 Broker · 连接即 full access')}
        >
          <Body q={connections}>
            {(c) => {
              const s = connectionsSummary(c)
              return (
                <>
                  <p className="small">
                    Broker{' '}
                    <span className={`chip ${s.brokerRunning ? 'ok' : 'bad'}`}>{s.brokerRunning ? tr('Running', '运行中') : tr('Not running', '未运行')}</span>{' '}
                    <span className="mono tiny">{s.brokerUrl}</span>
                  </p>
                  {s.brokerError ? <div className="banner bad compact">{s.brokerError}</div> : null}
                  <div className="home-kv small">
                    <span>
                      {tr(`Connected ${s.counts.connected}/${s.total}`, `已连接 ${s.counts.connected}/${s.total}`)}
                    </span>
                    {s.counts.available > 0 ? <span>{tr(`Available ${s.counts.available}`, `可连接 ${s.counts.available}`)}</span> : null}
                    {s.attention.length > 0 ? <span className="warn-text">
                        {tr(`Needs attention: ${s.attention.join(', ')}`, `需处理：${s.attention.join('、')}`)}
                      </span> : null}
                  </div>
                  {s.counts.connected === 0 ? <p className="muted small">{tr('No Agent is connected to Navalia yet.', '还没有 Agent 连接到 Navalia。')}</p> : null}
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="agent-reads"
          title={tr('Agent reads', 'Agent 读取')}
          target="connections"
          linkLabel="Access log"
          hint={tr(
            `Last ${ACCESS_DAYS} days · counts how much was read, not time saved`,
            `近 ${ACCESS_DAYS} 天 · 统计读了多少，不是省了多少时间`
          )}
        >
          <Body q={access}>
            {(rows) => {
              const s = accessSummary(rows, ACCESS_DAYS, since)
              if (s.reads === 0)
                return (
                  <p className="muted small">
                    {tr(`No Agent reads in the last ${ACCESS_DAYS} days.`, `近 ${ACCESS_DAYS} 天没有 Agent 读取记录。`)}
                  </p>
                )
              return (
                <>
                  <div className="home-figure">{tr(`${formatNumber(s.reads)} reads`, `${formatNumber(s.reads)} 次`)}</div>
                  <div className="home-kv tiny muted">
                    <span>{tr(`Last 7 days ${formatNumber(s.recentReads)}`, `近 7 天 ${formatNumber(s.recentReads)} 次`)}</span>
                    <span>{tr(`${formatNumber(s.responseChars)} characters returned`, `返回 ${formatNumber(s.responseChars)} 字符`)}</span>
                    <span>{tr(`${s.activeDays} days with reads`, `${s.activeDays} 天有读取`)}</span>
                    {s.lastDay ? <span>{tr(`Latest ${s.lastDay}`, `最近 ${s.lastDay}`)}</span> : null}
                  </div>
                  <ul className="home-list small" style={{ marginTop: 8 }}>
                    {s.byClient.slice(0, 4).map((c) => (
                      <li key={c.client}>
                        <span className="mono">{c.client}</span> · {tr(`${formatNumber(c.reads)} reads`, `${formatNumber(c.reads)} 次`)}
                      </li>
                    ))}
                  </ul>
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="skills"
          title={tr('Skills', '技能')}
          target="playbook"
          linkLabel="Playbook"
          hint={tr('Number of Workflows and Runtime playbooks', 'Workflow 与 Runtime playbook 数量')}
        >
          <Body q={workflows}>
            {(cat) => {
              const s = skillsSummary(cat, patterns.data ? patterns.data.skills.length : null)
              return (
                <>
                  <div className="home-figure">{tr(`${s.workflows} Workflows`, `${s.workflows} 个 Workflow`)}</div>
                  <div className="home-kv tiny muted">
                    <span>{tr(`Observed ${s.byKind.observed}`, `观察 ${s.byKind.observed}`)}</span>
                    <span>{tr(`Imported ${s.byKind.imported}`, `导入 ${s.byKind.imported}`)}</span>
                    <span>{tr(`Edited ${s.byKind.user_edited}`, `手动编辑 ${s.byKind.user_edited}`)}</span>
                    <span>{tr(`Shared by peers ${s.byKind.shared}`, `朋友分享 ${s.byKind.shared}`)}</span>
                    <span>
                      Playbook {s.playbooks === null ? (patterns.isError ? tr('failed to load', '读取失败') : '—') : s.playbooks}
                    </span>
                  </div>
                  {s.workflows === 0 ? <p className="muted small">{tr('No Workflows yet.', '还没有 Workflow。')}</p> : null}
                  {s.sourceIssues.map((i) => (
                    <div key={i} className="banner warn compact">
                      {i}
                    </div>
                  ))}
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="peers"
          title={tr('Peers', '朋友')}
          target="peers"
          linkLabel={tr('Peers', '朋友')}
          hint={tr('Peer cards imported on this machine', '本机导入的朋友卡片')}
        >
          <Body q={peers}>
            {(list) => {
              const s = peersSummary(list)
              return (
                <>
                  <div className="home-figure">{tr(`${s.count} peers`, `${s.count} 位`)}</div>
                  {s.count === 0 ? <p className="muted small">{tr('No peer cards imported yet.', '还没有导入朋友卡片。')}</p> : null}
                  <div className="home-kv tiny muted">
                    {s.latest ? (
                      <span>
                        {tr(
                          `Latest: ${s.latest.name} · ${formatDateTime(s.latest.importedAt)}`,
                          `最近：${s.latest.name} · ${formatDateTime(s.latest.importedAt)}`
                        )}
                      </span>
                    ) : null}
                    {s.oldKey > 0 ? <span>{tr(`${s.oldKey} may use an old key (unverified)`, `${s.oldKey} 张可能是旧密钥（${UNVERIFIED}）`)}</span> : null}
                    {s.unreadable > 0 ? <span className="warn-text">
                        {tr(`${s.unreadable} files failed signature verification`, `${s.unreadable} 个文件无法验签`)}
                      </span> : null}
                  </div>
                </>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="recent"
          title={tr('Recent', '最近')}
          target="search"
          linkLabel={tr('Search · recent', '搜索 · 最近')}
          hint={tr('Latest recent_activity entries', 'recent_activity 最新条目')}
        >
          <Body q={recent}>
            {(r) => {
              const items = recentItems(r, timezone, 5)
              if (items.length === 0) return <p className="muted small">{tr('Runtime has not returned any recent records yet.', 'Runtime 还没有返回任何最近记录。')}</p>
              return (
                <ul className="home-list small">
                  {items.map(({ entry, date, time }) => (
                    <li key={entry.id}>
                      <span className="line">{entry.content.split('\n').find((l) => l.trim()) ?? ''}</span>
                      <span className="tiny muted">
                        {date ? `${date} ${time ?? ''}` : tr('Time unknown', '时间未知')} · <span className="mono">{entry.path}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }}
          </Body>
        </HomeCard>

        <HomeCard
          id="heatmap"
          title={tr('Activity heatmap', '活动热力图')}
          target="search"
          linkLabel={tr('Search · recent', '搜索 · 最近')}
          wide
          hint={tr(
            'Last 7 days × 24 hours · counted from the times of the latest ≤100 records, not all captures',
            `近 7 天 × 24 小时 · 按最近 ≤100 条记录的时间统计，不是全部采集`
          )}
        >
          <Body q={recent}>
            {(r) => {
              const h = heatmapView(r, now, timezone, 7)
              if (h.placed === 0)
                return (
                  <p className="muted small">
                    {tr('No timed records in the last 7 days; the heatmap is empty.', '近 7 天没有带时间的记录，热力图为空。')}
                    {h.sampled > 0
                      ? tr(
                          ` (read ${h.sampled}: ${h.outside} older than 7 days, ${h.dateOnly} date only, ${h.undated} time unknown)`,
                          `（读取了 ${h.sampled} 条：${h.outside} 条早于 7 天，${h.dateOnly} 条只有日期，${h.undated} 条时间未知）`
                        )
                      : ''}
                  </p>
                )
              return (
                <>
                  <div className="heat" role="table" aria-label={tr('Activity heatmap', '活动热力图')}>
                    <span />
                    {Array.from({ length: 24 }, (_, i) => (
                      <span key={i} className="hour">
                        {i % 3 === 0 ? i : ''}
                      </span>
                    ))}
                    {h.rows.map((row) => (
                      <HeatRow key={row.date} date={row.date} hours={row.hours} max={h.max} total={row.total} />
                    ))}
                  </div>
                  <div className="home-kv tiny muted">
                    <span>
                      {tr(`Placed ${h.placed} / read ${h.sampled}`, `已放入 ${h.placed} 条 / 读取 ${h.sampled} 条`)}
                      {h.truncated ? tr(' (hit the limit; older ones not read)', '（已到上限，更早的未读取）') : ''}
                    </span>
                    {h.dateOnly > 0 ? <span>{tr(`${h.dateOnly} date only`, `${h.dateOnly} 条只有日期`)}</span> : null}
                    {h.outside > 0 ? <span>{tr(`${h.outside} older than 7 days`, `${h.outside} 条早于 7 天`)}</span> : null}
                    {h.undated > 0 ? <span>{tr(`${h.undated} time unknown`, `${h.undated} 条时间未知`)}</span> : null}
                    <span className="heat-legend">
                      {tr('Less', '少')} {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat-cell l${l}`} />)}{' '}
                      {tr(`More (max ${h.max}/hour)`, `多（最多 ${h.max} 条/小时）`)}
                    </span>
                  </div>
                </>
              )
            }}
          </Body>
        </HomeCard>
      </div>
    </div>
  )
}

function HeatRow({ date, hours, max, total }: { date: string; hours: number[]; max: number; total: number }) {
  return (
    <>
      <span className="mono" title={tr(`${date} · ${total} records`, `${date} · ${total} 条`)}>
        {date.slice(5)} · {total}
      </span>
      {hours.map((n, hour) => (
        <span key={hour} className={`heat-cell l${heatLevel(n, max)}`} title={tr(
            `${date} ${String(hour).padStart(2, '0')}:00 · ${n} records`,
            `${date} ${String(hour).padStart(2, '0')}:00 · ${n} 条`
          )} />
      ))}
    </>
  )
}
