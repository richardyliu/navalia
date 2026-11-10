/** Placeholder rows that match the text they replace, so cards keep their height while loading. */
export function Skeleton({ rows = 2, className }: { rows?: number; className?: string }) {
  return (
    <div className={className ? `skeleton ${className}` : 'skeleton'} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={i === rows - 1 ? 'skeleton-line short' : 'skeleton-line'} />
      ))}
    </div>
  )
}
