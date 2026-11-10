import { useMemo, type ReactElement } from 'react'
import { encodeQrText } from '../../../../main/identity/qr'

/** Renders the QR as React SVG elements (no innerHTML). */
export function QrSvg({ text, size = 200 }: { text: string; size?: number }) {
  const qr = useMemo(() => encodeQrText(text, 'M'), [text])
  const border = 4
  const dim = qr.size + border * 2
  const rects: ReactElement[] = []
  qr.modules.forEach((row, y) => {
    let x = 0
    while (x < qr.size) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (end < qr.size && row[end]) end++
      rects.push(<rect key={`${x}-${y}`} x={x + border} y={y + border} width={end - x} height={1} />)
      x = end
    }
  })
  return (
    <svg className="swipe-qr" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label={`QR v${qr.version}-${qr.ecc}`}>
      <rect width={dim} height={dim} fill="#fff" />
      <g fill="#000">{rects}</g>
    </svg>
  )
}
