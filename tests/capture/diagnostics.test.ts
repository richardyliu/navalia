import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPTURE_CHANNELS, type CaptureStatusView } from '../../src/main/capture/api'
import {
  buildCaptureDiagnostics,
  explainSource,
  fetchRuntimeOcrHealth,
  parseCaptureTable,
  parseRuntimeOcrHealth,
  readRuntimeConfigSummary,
  redactSecrets,
  summarizeRuntimeConfig
} from '../../src/main/capture/diagnostics'
import { registerCaptureIpc } from '../../src/main/capture/ipc'
import type { CaptureService } from '../../src/main/capture/service'

const TOKEN = 'Zx9_tok3n-AbCdEfGh1234567890qwertyUIOP'
const tmpDirs: string[] = []
function tmpRoot(config?: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-cap-diag-'))
  tmpDirs.push(dir)
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.toml'), config)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const INGEST_CONFIG = `# Persome config
[llm]
api_key = "sk-live-${TOKEN}"
models = [
  "a",
  "b",
]

[capture]
source = "ingest"             # "daemon" | "ingest"
event_driven = true
debounce_seconds = 3.0
enable_ocr_fallback = true   # comment
ocr_policy = "enabled"
ocr_tier = "small"
buffer_max_mb = 2_000

[timeline]
prompt = """
multi
line
"""
window_minutes = 1
`

function statusFixture(over: Partial<CaptureStatusView> = {}): CaptureStatusView {
  return {
    started: false,
    reason: `Runtime capture.source is "daemon", not "ingest"; Authorization: Bearer ${TOKEN}`,
    degraded: null,
    startedAt: null,
    nativeLoaded: true,
    nativePath: path.join(os.homedir(), 'x/navalia-native.node'),
    permissions: { accessibility: true, screenRecording: false },
    accessibilityObservers: false,
    pause: { paused: true, mode: 'until', since: '2026-11-05T10:00:00.000Z', until: '2026-11-06T08:00:00.000Z' },
    excluded: {
      bundleIds: ['com.1password.1password'],
      appNames: ['Signal'],
      builtIn: [{ label: 'Navalia', bundleIds: ['app.persome.lens'], bundlePaths: [] }]
    },
    settingsError: null,
    ingest: {
      written: 3,
      deduped: 2,
      skipped: 1,
      rejected: 0,
      tooLarge: 0,
      retries: 4,
      parked: 0,
      dropped: { paused: 1, locked: 0, excluded_app: 0 },
      queued: 0
    },
    decisions: { captured: 6, debounced: 10 },
    recentFrames: [
      {
        at: '2026-11-05T09:59:00.000Z',
        trigger: 'AXApplicationActivated',
        appName: 'Notes',
        bundleId: 'com.apple.Notes',
        windowTitle: 'SECRET WINDOW TITLE',
        url: 'https://private.example/path?q=1',
        axAvailable: true,
        screenshot: 'not_granted',
        outcome: 'written',
        id: 'cap_1'
      }
    ],
    perApp: [],
    runtime: { root: '/tmp/root', port: 8742, source: 'daemon', settings: [] },
    ...over
  }
}

describe('parseCaptureTable', () => {
  it('reads [capture] scalars and skips other tables, multi-line arrays and strings', () => {
    const r = parseCaptureTable(INGEST_CONFIG)
    expect(r).toEqual({
      ok: true,
      hasCaptureSection: true,
      capture: {
        source: 'ingest',
        event_driven: true,
        debounce_seconds: 3,
        enable_ocr_fallback: true,
        ocr_policy: 'enabled',
        ocr_tier: 'small',
        buffer_max_mb: 2000
      }
    })
  })

  it.each([
    ['unterminated string', '[capture]\nsource = "ingest\n'],
    ['garbage line', '[capture]\nthis is not toml\n'],
    ['broken header', '[capture\nsource = "ingest"\n'],
    ['duplicate table', '[capture]\nsource = "ingest"\n[capture]\nsource = "daemon"\n'],
    ['duplicate key', '[capture]\nsource = "ingest"\nsource = "daemon"\n'],
    ['unclosed array', 'x = [\n1,\n'],
    ['unclosed multi-line string', 'x = """\nabc\n'],
    ['binary', Buffer.from([0x5b, 0x00, 0x01]).toString('latin1')]
  ])('rejects malformed: %s', (_name, text) => {
    expect(parseCaptureTable(text).ok).toBe(false)
  })

  it('never puts line content into the error', () => {
    const r = parseCaptureTable(`[llm]\napi_key ${TOKEN}\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('Line 2: cannot parse')
      expect(r.error).not.toContain(TOKEN)
    }
  })
})

describe('summarizeRuntimeConfig / readRuntimeConfigSummary', () => {
  it('ingest config', () => {
    const root = tmpRoot(INGEST_CONFIG)
    const s = readRuntimeConfigSummary(root)
    expect(s).toMatchObject({
      state: 'ok',
      source: 'ingest',
      sourceOrigin: 'config',
      sourceInvalid: false,
      error: null,
      ocr: { enabled: true, policy: 'enabled', tier: 'small', origin: { enabled: 'config', policy: 'config', tier: 'config' } },
      invalidKeys: []
    })
    expect(s.path).toBe(path.join(root, 'config.toml'))
    expect(explainSource(s)).toContain('ingest')
  })

  it('daemon config explains that Navalia capture is inert', () => {
    const s = readRuntimeConfigSummary(tmpRoot('[capture]\nsource = "daemon"\n'))
    expect(s.source).toBe('daemon')
    expect(s.sourceOrigin).toBe('config')
    // OCR keys absent -> OSS defaults, flagged as defaults
    expect(s.ocr).toEqual({
      enabled: false,
      policy: 'auto',
      tier: 'tiny',
      origin: { enabled: 'default', policy: 'default', tier: 'default' }
    })
    const text = explainSource(s)
    expect(text).toContain('daemon')
    expect(text).toContain('Navalia capture stays off')
    expect(text).toContain('"ingest"')
  })

  it('config without source uses the Runtime default "daemon" (marked default)', () => {
    const s = summarizeRuntimeConfig('[capture]\ninclude_screenshot = false\n', '/x/config.toml')
    expect(s).toMatchObject({ state: 'ok', source: 'daemon', sourceOrigin: 'default' })
    expect(explainSource(s)).toContain('default')
  })

  it('missing config -> unknown, never guessed', () => {
    const s = readRuntimeConfigSummary(tmpRoot())
    expect(s).toMatchObject({ state: 'missing', source: 'unknown', sourceOrigin: 'unknown', error: null })
    expect(s.ocr).toEqual({ enabled: null, policy: null, tier: null, origin: { enabled: 'unknown', policy: 'unknown', tier: 'unknown' } })
    expect(explainSource(s)).toContain('unknown')
  })

  it('malformed config -> unknown with line-number error', () => {
    const s = readRuntimeConfigSummary(tmpRoot(`[capture]\nsource = "ingest"\napi_key ${TOKEN}\n`))
    expect(s).toMatchObject({ state: 'malformed', source: 'unknown', error: 'Line 3: cannot parse' })
    expect(s.ocr.enabled).toBeNull()
  })

  it('directory instead of file -> unreadable', () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'config.toml'))
    expect(readRuntimeConfigSummary(root)).toMatchObject({ state: 'unreadable', source: 'unknown' })
  })

  it('values Runtime would reject are reported as unknown/invalid', () => {
    const s = summarizeRuntimeConfig(
      '[capture]\nsource = "swift"\nenable_ocr_fallback = "yes"\nocr_policy = "sometimes"\nocr_tier = "huge"\n',
      '/x'
    )
    expect(s.source).toBe('unknown')
    expect(s.sourceInvalid).toBe(true)
    expect(s.ocr).toMatchObject({ enabled: null, policy: null, tier: null })
    expect(s.invalidKeys).toEqual(['source', 'enable_ocr_fallback', 'ocr_policy', 'ocr_tier'])
  })

  it('reading is read-only (file bytes and mtime unchanged)', () => {
    const root = tmpRoot(INGEST_CONFIG)
    const file = path.join(root, 'config.toml')
    const before = fs.statSync(file)
    readRuntimeConfigSummary(root)
    const after = fs.statSync(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(INGEST_CONFIG)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

describe('Runtime OCR health', () => {
  it('parses enveloped and bare /health payloads', () => {
    const data = { status: 'ok', ocr: 'ready', ocr_worker: 'ready', ocr_enabled: true, ocr_tier: 'tiny' }
    const want = { state: 'ready', enabled: true, tier: 'tiny', worker: 'ready' }
    expect(parseRuntimeOcrHealth({ ok: true, data })).toEqual(want)
    expect(parseRuntimeOcrHealth(data)).toEqual(want)
    expect(parseRuntimeOcrHealth({ status: 'ok' })).toBeNull()
    expect(parseRuntimeOcrHealth('nope')).toBeNull()
    expect(parseRuntimeOcrHealth({ ocr: 42 })).toBeNull()
  })

  it('fetches loopback /health without Authorization; failures -> null', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify({ ok: true, data: { ocr: 'disabled', ocr_enabled: false, ocr_tier: 'tiny' } }))
    }) as unknown as typeof fetch
    expect(await fetchRuntimeOcrHealth(8742, ok)).toEqual({ state: 'disabled', enabled: false, tier: 'tiny', worker: null })
    expect(seen[0].url).toBe('http://127.0.0.1:8742/health')
    expect(Object.keys(seen[0].headers).map((k) => k.toLowerCase())).not.toContain('authorization')
    const boom = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await fetchRuntimeOcrHealth(8742, boom)).toBeNull()
    expect(await fetchRuntimeOcrHealth(0, ok)).toBeNull()
  })
})

describe('redaction', () => {
  it('scrubs known secrets, bearer/token/key patterns and opaque runs', () => {
    const text = [
      `token=${TOKEN}`,
      `Authorization: Bearer abc.def`,
      `PERSOME_LOCAL_API_TOKEN=${TOKEN}`,
      `screenshot_key: 0123456789abcdef0123456789abcdef`,
      `opaque ${'a1'.repeat(20)}`,
      `literal ${TOKEN} here`
    ].join('\n')
    const out = redactSecrets(text, [TOKEN])
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('abc.def')
    expect(out).not.toContain('0123456789abcdef0123456789abcdef')
    expect(out).not.toContain('a1'.repeat(20))
    expect(out).toContain('[hidden]')
  })

  it('keeps ordinary paths, bundle ids and timestamps', () => {
    const text = '/Users/x/Library/Application Support/navalia/native com.apple.Notes 2026-11-05T09:59:00.000Z port: 8742'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('buildCaptureDiagnostics', () => {
  const config = summarizeRuntimeConfig('[capture]\nsource = "daemon"\nenable_ocr_fallback = true\nocr_tier = "small"\n', '/tmp/root/config.toml')

  it('summarises frames, exclusions, pause, permissions and OCR', () => {
    const d = buildCaptureDiagnostics({
      status: statusFixture(),
      config,
      runtimeOcr: { state: 'ready', enabled: true, tier: 'small', worker: 'ready' },
      now: Date.parse('2026-11-05T10:00:00.000Z'),
      homeDir: os.homedir()
    })
    expect(d.generatedAt).toBe('2026-11-05T10:00:00.000Z')
    expect(d.lensCaptureEffective).toBe(false)
    expect(d.frames).toEqual({
      lastAt: '2026-11-05T09:59:00.000Z',
      lastApp: 'Notes',
      lastOutcome: 'written',
      accepted: 6,
      written: 3,
      recentCount: 1
    })
    expect(d.exclusions).toMatchObject({ bundleIds: 1, appNames: 1, builtIn: 1 })
    expect(d.ocrLabel).toBe('Config: on · policy auto · tier small · Runtime live: ready / small')
    expect(d.text).toContain('capture.source: daemon (config)')
    expect(d.text).toContain('Accessibility granted; Screen Recording not granted')
    expect(d.text).toContain('Pause: Paused until 2026-11-06T08:00:00.000Z')
    expect(d.text).toContain('received 6')
    expect(d.text).toContain('~/x/navalia-native.node')
    // screen content never in diagnostics
    expect(d.text).not.toContain('SECRET WINDOW TITLE')
    expect(d.text).not.toContain('private.example')
  })

  it('OCR unknown when config is missing and Runtime is unreachable', () => {
    const d = buildCaptureDiagnostics({
      status: statusFixture({ recentFrames: [] }),
      config: readRuntimeConfigSummary(tmpRoot()),
      runtimeOcr: null,
      now: 0
    })
    expect(d.ocrLabel).toBe('Config: unknown · policy unknown · tier unknown · Runtime live: unknown (cannot reach /health)')
    expect(d.frames.lastAt).toBeNull()
    expect(d.text).toContain('Last frame: none')
  })

  it('token never appears in the diagnostics view, even via reason/settingsError', () => {
    const d = buildCaptureDiagnostics({
      status: statusFixture({ settingsError: `bad file ${TOKEN}` }),
      config,
      runtimeOcr: null,
      now: 0,
      knownSecrets: [TOKEN]
    })
    expect(JSON.stringify(d)).not.toContain(TOKEN)
    // pattern-based even without knownSecrets
    const d2 = buildCaptureDiagnostics({ status: statusFixture(), config, runtimeOcr: null, now: 0 })
    expect(d2.text).not.toContain(TOKEN)
  })
})

describe('lens:capture:diagnostics IPC', () => {
  function setup(root: string, status: CaptureStatusView) {
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    const service = { status: () => status } as unknown as CaptureService
    registerCaptureIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, service, {
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      openExternal: async () => undefined,
      runtimeOcrHealth: async () => ({ state: 'ready', enabled: true, tier: 'small', worker: 'ready' }),
      knownSecrets: (r) => {
        // Mirrors the index.ts wiring: the token read from <root>/env, used only for redaction.
        expect(r).toBe(root)
        return [TOKEN]
      },
      now: () => Date.parse('2026-11-05T10:00:00.000Z')
    })
    return (raw?: unknown) => handlers.get(CAPTURE_CHANNELS.diagnostics)!(null, raw)
  }

  it('returns the payload shape from a temp PERSOME_ROOT, without the token', async () => {
    const root = tmpRoot(INGEST_CONFIG)
    fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${TOKEN}\n`, { mode: 0o600 })
    const status = statusFixture({ runtime: { root, port: 8742, source: 'ingest', settings: [] } })
    const res = (await setup(root, status)()) as { ok: true; data: Record<string, unknown> }
    expect(res.ok).toBe(true)
    expect(Object.keys(res.data).sort()).toEqual(
      ['config', 'exclusions', 'frames', 'generatedAt', 'lensCaptureEffective', 'ocrLabel', 'runtimeOcr', 'sourceExplanation', 'text'].sort()
    )
    expect(res.data.lensCaptureEffective).toBe(true)
    expect(res.data.config).toMatchObject({ state: 'ok', source: 'ingest' })
    const json = JSON.stringify(res)
    expect(json).not.toContain(TOKEN)
    expect(json).not.toContain('sk-live')
  })

  it('validates arguments with zod', async () => {
    const root = tmpRoot()
    const res = await setup(root, statusFixture({ runtime: { root, port: 8742, source: 'daemon', settings: [] } }))({ x: 1 })
    expect(res).toMatchObject({ ok: false })
  })

  it('tolerates malformed config and a throwing secret source', async () => {
    const root = tmpRoot('[capture\n')
    const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
    registerCaptureIpc(
      { handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never,
      { status: () => statusFixture({ runtime: { root, port: 8742, source: 'daemon', settings: [] } }) } as unknown as CaptureService,
      {
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        openExternal: async () => undefined,
        runtimeOcrHealth: async () => null,
        knownSecrets: () => {
          throw new Error('no env')
        }
      }
    )
    const res = (await handlers.get(CAPTURE_CHANNELS.diagnostics)!(null, undefined)) as {
      ok: true
      data: { config: { state: string; source: string } }
    }
    expect(res.ok).toBe(true)
    expect(res.data.config).toMatchObject({ state: 'malformed', source: 'unknown' })
  })
})
