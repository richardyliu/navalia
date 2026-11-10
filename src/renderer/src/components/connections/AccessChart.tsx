import type { AccessLogDay } from '../../../../main/broker/api'
import { stackDays } from './stack'
import { tr } from '../../lib/i18n'

// Theme-aware categorical series: tokens --series-1..6 in styles/app.css.
const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--series-${n})`)
const W = 600
const H = 100

export function clientColor(client: string, clients: string[]): string {
  const i = clients.indexOf(client)
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]
}

export function AccessChart({ daily }: { daily: AccessLogDay[] }) {
  const { stacks, clients, max } = stackDays(daily)
  const bw = W / stacks.length
  return (
    <div className="conn-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={tr('Reads over 30 days, stacked by Agent', '30 天读取次数，按 Agent 堆叠')}>
        {stacks.map((s, i) => {
          let y = H
          return (
            <g key={s.day}>
              {s.segments
                .filter((seg) => seg.reads > 0)
                .map((seg) => {
                  const h = (seg.reads / max) * (H - 6)
                  y -= h
                  return (
                    <rect key={seg.client} x={i * bw + 2} y={y} width={bw - 4} height={h} rx={2} style={{ fill: clientColor(seg.client, clients) }}>
                      <title>{tr(`${s.day} · ${seg.client} · ${seg.reads} reads`, `${s.day} · ${seg.client} · ${seg.reads} 次`)}</title>
                    </rect>
                  )
                })}
              {s.total === 0 ? <rect x={i * bw + 2} y={H - 1} width={bw - 4} height={1} style={{ fill: 'var(--line-strong)' }} /> : null}
            </g>
          )
        })}
      </svg>
      <div className="conn-chart-axis tiny muted">
        <span>{stacks[0]?.day.slice(5)}</span>
        <span>{stacks[Math.floor(stacks.length / 2)]?.day.slice(5)}</span>
        <span>{tr(`${stacks[stacks.length - 1]?.day.slice(5) ?? ''} (today)`, `${stacks[stacks.length - 1]?.day.slice(5) ?? ''}（今天）`)}</span>
      </div>
      <div className="conn-legend">
        {clients.length === 0 ? <span className="tiny muted">{tr('No reads in 30 days', '30 天内没有读取')}</span> : null}
        {clients.map((c) => (
          <span key={c} className="tiny">
            <i style={{ background: clientColor(c, clients) }} /> {c}
          </span>
        ))}
      </div>
    </div>
  )
}
