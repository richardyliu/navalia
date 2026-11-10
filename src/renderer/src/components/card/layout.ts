import type { CardContent } from '../../../../main/identity/card-schema'

type MiniMap = CardContent['back']['mini_map']

export interface PlacedNode {
  key: string
  level: 'root' | 'volume' | 'face'
  label: string
  observations: number
  confidence: number
  x: number
  y: number
  r: number
}

export interface PlacedEdge {
  from: PlacedNode
  to: PlacedNode
}

export const MAP_W = 320
export const MAP_H = 230

/**
 * Deterministic radial layout: Root at the centre, Volumes on the inner ring, Faces on the outer
 * ring. Faces are ordered by their parent Volume (from real edges) so clusters sit together.
 * Position encodes level only; edges come solely from the card data.
 */
export function layoutMiniMap(map: MiniMap): { nodes: PlacedNode[]; edges: PlacedEdge[] } {
  const cx = MAP_W / 2
  const cy = MAP_H / 2
  const maxObs = Math.max(1, ...map.nodes.map((n) => n.observations))
  const radius = (obs: number, base: number) => base + 5 * Math.sqrt(obs / maxObs)

  const roots = map.nodes.filter((n) => n.level === 'root')
  const volumes = map.nodes.filter((n) => n.level === 'volume')
  const faces = map.nodes.filter((n) => n.level === 'face')

  const parentOf = new Map<string, string>()
  for (const e of map.edges) {
    if (e.from.startsWith('v') && e.to.startsWith('f') && !parentOf.has(e.to)) parentOf.set(e.to, e.from)
  }
  const volumeIndex = new Map(volumes.map((v, i) => [v.key, i]))
  const orderedFaces = [...faces].sort((a, b) => {
    const pa = volumeIndex.get(parentOf.get(a.key) ?? '') ?? Number.MAX_SAFE_INTEGER
    const pb = volumeIndex.get(parentOf.get(b.key) ?? '') ?? Number.MAX_SAFE_INTEGER
    return pa - pb || faces.indexOf(a) - faces.indexOf(b)
  })

  const placed: PlacedNode[] = []
  const ring = (list: typeof faces, rx: number, ry: number, base: number, phase: number) =>
    list.forEach((n, i) => {
      const angle = phase + (2 * Math.PI * i) / Math.max(1, list.length)
      placed.push({ ...n, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle), r: radius(n.observations, base) })
    })

  roots.forEach((n) => placed.push({ ...n, x: cx, y: cy, r: radius(n.observations, 7) }))
  ring(volumes, roots.length || volumes.length > 1 ? 62 : 0, roots.length || volumes.length > 1 ? 44 : 0, 4, -Math.PI / 2)
  ring(orderedFaces, 136, 96, 2.5, -Math.PI / 2 + Math.PI / Math.max(2, orderedFaces.length))

  const byKey = new Map(placed.map((n) => [n.key, n]))
  const edges: PlacedEdge[] = []
  for (const e of map.edges) {
    const from = byKey.get(e.from)
    const to = byKey.get(e.to)
    if (from && to) edges.push({ from, to })
  }
  return { nodes: placed, edges }
}

/** "03b4119b…" → "03b4 119b dbab …" groups of 4 for reading aloud / comparing. */
export function groupFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)?.join(' ') ?? fp
}
