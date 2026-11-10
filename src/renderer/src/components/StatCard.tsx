import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  detail,
  tone = 'muted'
}: {
  label: string
  value: ReactNode
  detail?: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
}) {
  return (
    <div className={`card stat tone-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail ? <div className="stat-detail">{detail}</div> : null}
    </div>
  )
}
