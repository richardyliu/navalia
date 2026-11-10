import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ANCHOR_KINDS, DEFAULT_ANCHORS, minutesTenths } from '../../src/main/het/anchors'
import { CALIBRATION } from './calibration.data'

const anchor = (k: string): number => DEFAULT_ANCHORS.find((a) => a.kind === k)!.minutes

describe('E3.7 calibration (status: UNKNOWN until user review)', () => {
  test('20 rows covering all six kinds and every size/complexity bucket', () => {
    expect(CALIBRATION).toHaveLength(20)
    expect(new Set(CALIBRATION.map((r) => r.kind))).toEqual(new Set(ANCHOR_KINDS))
    expect(new Set(CALIBRATION.map((r) => r.size))).toEqual(new Set(['xs', 's', 'm', 'l', 'xl']))
    expect(new Set(CALIBRATION.map((r) => r.complexity))).toEqual(new Set(['low', 'medium', 'high']))
  })

  test('anchor outputs are locked (default anchors v1, adoption confirmed)', () => {
    for (const r of CALIBRATION) {
      expect(minutesTenths({ anchorMinutes: anchor(r.kind), size: r.size, complexity: r.complexity, adoption: 'confirmed' }), r.id).toBe(
        r.anchorTenths
      )
    }
  })

  test('calibration.md table matches the locked data', () => {
    const md = readFileSync(join(__dirname, 'calibration.md'), 'utf8')
    expect(md).toMatch(/Status: \*\*UNKNOWN\*\*/)
    for (const r of CALIBRATION) {
      const line = md.split('\n').find((l) => l.startsWith(`| ${r.id} |`))
      expect(line, r.id).toBeDefined()
      const cells = line!.split('|').map((c) => c.trim())
      // | id | task | kind | size | complexity | anchor | estimate | ratio |
      expect(cells.slice(3, 9), r.id).toEqual([
        r.kind,
        r.size,
        r.complexity,
        (r.anchorTenths / 10).toFixed(1),
        String(r.estimateMin),
        (r.estimateMin / (r.anchorTenths / 10)).toFixed(2)
      ])
    }
  })
})
