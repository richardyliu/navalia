import { describe, expect, test } from 'vitest'
import { TOOL_CATALOG } from '../../src/main/broker/catalog'
import { TOOLS } from '../../src/main/broker/tools'
import ossTools from '../../src/main/broker/oss-tools.json'

describe('Broker catalog', () => {
  test('catalog, tool defs and the mirrored OSS list agree', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(TOOL_CATALOG.map((t) => t.name))
    const oss = TOOL_CATALOG.filter((t) => t.origin === 'oss').map((t) => t.name).sort()
    expect(oss).toEqual(ossTools.tools.map((t) => t.name).sort())
    expect(oss).toHaveLength(22)
    expect(oss).toContain('owner_aliases')
    expect(TOOL_CATALOG.filter((t) => t.origin === 'product').map((t) => t.name)).toEqual(['search_rewind', 'rewind_frames', 'view_rewind_screenshot'])
    expect(TOOL_CATALOG.filter((t) => t.origin === 'extension').map((t) => t.name)).toEqual(['card_get', 'usage_report', 'get_workflow', 'search_workflows'])
  })

  test('OSS tools advertise the runtime schema verbatim (no hand-guessed argument names)', () => {
    for (const src of ossTools.tools) {
      const def = TOOLS.find((t) => t.name === src.name)!
      expect(def.inputSchema).toEqual(src.inputSchema)
      // Verbatim: the Broker only prefixes a label; nothing is cut (the longest, search, is ~3.2k of the 4k cap).
      expect([src.name, def.description.endsWith(src.description)]).toEqual([src.name, true])
    }
  })

  test('labels: write / LLM / image / Navalia-defined / extension tags are in descriptions', () => {
    const d = (n: string) => TOOLS.find((t) => t.name === n)!.description
    expect(d('remember')).toContain('writes to your Personal Model')
    expect(d('correct_memory')).toContain('LLM budget')
    expect(d('view_rewind_screenshot')).toContain('NOT PII-scrubbed')
    expect(d('rewind_frames')).toContain('Navalia-defined')
    expect(d('card_get')).toContain('Navalia extension')
  })
})
