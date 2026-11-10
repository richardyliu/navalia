import type { EvidenceLink } from './viewModel'

/** S1-R3-03: per-item evidence pointers; clicking one opens the EvidenceDrawer on that ref. */
export function EvidenceLinks({ links, onOpen }: { links: EvidenceLink[]; onOpen: (ref: string) => void }) {
  if (!links.length) return null
  return (
    <span className="wf-item-evidence">
      {links.map((l) => (
        <button key={l.ref} type="button" className="chip subtle wf-evidence-link" title={l.ref} onClick={() => onOpen(l.ref)}>
          {l.label}
        </button>
      ))}
    </span>
  )
}
