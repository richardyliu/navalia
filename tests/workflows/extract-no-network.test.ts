// S2-07 / X7: Lens never calls an LLM and the extraction path never touches the network.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_EXAMPLE, buildExtractionPrompt, parseExtraction } from '../../src/main/workflows/extract'
import { createWorkflowService } from '../../src/main/workflows/service'
import { extractPreview } from '../../src/renderer/src/components/workflows/extractView'
import { runtimeCopy, tempDir } from './helpers'

const SOURCES = [
  'src/main/workflows/extract.ts',
  'src/renderer/src/components/workflows/extractView.ts',
  'src/renderer/src/components/workflows/ExtractPanel.tsx'
]

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const c of cleanups.splice(0)) c()
})

describe('workflow extraction: no LLM, no network', () => {
  it('no new source imports a network module, calls fetch, or names an LLM SDK / endpoint', () => {
    const banned = [
      /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)['"]/,
      /require\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\bnet\.request\b/,
      /@anthropic-ai|openai|api\.anthropic\.com|generativelanguage|ollama/i,
      /\bossTool\b|\bruntime\(\)/
    ]
    for (const f of SOURCES) {
      const src = fs.readFileSync(path.resolve(f), 'utf8')
      for (const re of banned) expect(re.test(src), `${f} matches ${re}`).toBe(false)
    }
  })

  it('prompt, validation and save make zero network calls', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network forbidden')))
    vi.stubGlobal('fetch', fetchSpy)
    const spies = [vi.spyOn(http, 'request'), vi.spyOn(http, 'get'), vi.spyOn(https, 'request'), vi.spyOn(https, 'get'), vi.spyOn(net, 'connect'), vi.spyOn(net, 'createConnection'), vi.spyOn(tls, 'connect')]
    const rt = runtimeCopy()
    const st = tempDir('extract-nonet')
    cleanups.push(rt.cleanup, st.cleanup)
    const tools: string[] = []
    // Only the existing catalog read (behavior_patterns via injected MCP) — never an LLM.
    const svc = createWorkflowService({ storeRoot: st.dir, runtimeRoot: () => rt.root, ossTool: async (name) => (tools.push(name), '{"skills":[]}') })
    buildExtractionPrompt('x')
    expect(parseExtraction(JSON.stringify(EXTRACTION_EXAMPLE)).ok).toBe(true)
    expect(extractPreview(JSON.stringify(EXTRACTION_EXAMPLE)).status).toBe('valid')
    const r = await svc.saveExtracted(JSON.stringify(EXTRACTION_EXAMPLE), 'user_edited', 'Claude Code')
    expect(r.item.outcome).toBe('imported')
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    expect(tools.every((t) => t === 'behavior_patterns')).toBe(true)
  })
})
