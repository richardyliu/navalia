import type { CardContent } from '../../../../main/identity/card-schema'
import { layoutMiniMap, MAP_H, MAP_W } from './layout'
import { tr } from '../../lib/i18n'

const FILL = { root: 'var(--accent)', volume: 'var(--map-volume)', face: 'var(--map-face)' } as const

export function MiniMap({ map }: { map: CardContent['back']['mini_map'] }) {
  if (map.nodes.length === 0) {
    return (
      <div className="pcard-map-empty">
        <span>{tr('No Root / Volume / Face yet', '还没有 Root / Volume / Face')}</span>
        <span className="tiny muted">{tr('Once the Runtime builds the pattern layers, regenerate the card to see the Mini Map.', 'Runtime 构建出模式层后，重新生成卡片即可看到 Mini Map。')}</span>
      </div>
    )
  }
  const { nodes, edges } = layoutMiniMap(map)
  return (
    <svg className="pcard-map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="Mini Map">
      {edges.map((e) => (
        <line key={`${e.from.key}>${e.to.key}`} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} className="pcard-map-edge" />
      ))}
      {nodes.map((n) => (
        <circle key={n.key} cx={n.x} cy={n.y} r={n.r} style={{ fill: FILL[n.level] }} opacity={0.35 + 0.65 * n.confidence}>
          <title>{`${n.level} · ${n.observations} obs · ${Math.round(n.confidence * 100)}%\n${n.label}`}</title>
        </circle>
      ))}
    </svg>
  )
}
