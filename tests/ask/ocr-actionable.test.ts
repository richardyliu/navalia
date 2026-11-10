// S1-R4-08 OCR actionable switch: when OCR is off / degraded / unknown, Capture and Ask show explicit
// steps with copyable commands (`persome ocr setup`, then `persome stop && persome start`) and say that
// WeChat content only appears via OCR. Lens never edits ~/.persome/config.toml. Pure + static render.
import fs from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { CaptureDiagnosticsView, OcrConfigView, RuntimeOcrHealth } from '../../src/main/capture/api'
import { parseRuntimeOcrHealth } from '../../src/main/capture/diagnostics'
import {
  OCR_CHECK_COMMAND,
  OCR_SETUP_COMMAND,
  RUNTIME_RESTART_COMMAND,
  RUNTIME_START_COMMAND,
  ocrStatusView,
  wechatOnlyViaOcr
} from '../../src/renderer/src/components/ask/ocrStatus'
import { OcrStatusPanel } from '../../src/renderer/src/components/ask/OcrStatusPanel'
;(globalThis as { React?: typeof React }).React = React

const cfg = (enabled: boolean | null): OcrConfigView => ({
  enabled,
  policy: enabled === null ? null : enabled ? 'enabled' : 'disabled',
  tier: 'tiny',
  origin: { enabled: 'config', policy: 'config', tier: 'config' }
})

const READY = parseRuntimeOcrHealth({
  success: true,
  data: { status: 'ok', ocr: 'ready', ocr_worker: 'ready', ocr_enabled: true, ocr_tier: 'tiny', index: 'ok', capture_pipeline: 'ok' }
})
const DISABLED: RuntimeOcrHealth = { state: 'disabled', enabled: false, tier: 'tiny', worker: 'not_started' }
const WORKER_DOWN: RuntimeOcrHealth = { state: 'ready', enabled: true, tier: 'tiny', worker: 'failed' }

const diag = (runtimeOcr: RuntimeOcrHealth | null, ocr: OcrConfigView | null) => ({ runtimeOcr, config: { ocr } }) as unknown as CaptureDiagnosticsView

function render(props: { diag: CaptureDiagnosticsView | undefined; failed?: boolean; testId?: string }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(OcrStatusPanel, props)))
}
const commandsIn = (html: string, testId: string): string[] =>
  [...html.matchAll(new RegExp(`data-testid="${testId}-command">([^<]*)<`, 'g'))].map((m) => m[1].replace(/&amp;/g, '&'))

describe('S1-R4-08 view-model per state', () => {
  it('enabled + ready ⇒ on: no steps, no commands, no WeChat warning', () => {
    const v = ocrStatusView(READY, cfg(true))
    expect(v.kind).toBe('on')
    expect(v.commands).toEqual([])
    expect(v.steps).toEqual([])
    expect(v.wechatWarning).toBeNull()
  })

  it('disabled ⇒ off: setup, then restart, then check; steps match; WeChat only via OCR', () => {
    const v = ocrStatusView(DISABLED, cfg(false))
    expect(v.kind).toBe('off')
    expect(v.commands.map((c) => c.command)).toEqual([OCR_SETUP_COMMAND, RUNTIME_RESTART_COMMAND, OCR_CHECK_COMMAND])
    expect(OCR_SETUP_COMMAND).toBe('persome ocr setup')
    expect(RUNTIME_RESTART_COMMAND).toBe('persome stop && persome start')
    const steps = v.steps.join('\n')
    expect(steps.indexOf('persome ocr setup')).toBeLessThan(steps.indexOf('persome stop && persome start'))
    expect(steps).toMatch(/Navalia never modifies this file/)
    expect(v.wechatWarning).toContain('WeChat chats can reach screen capture only through OCR')
  })

  it('config on but Runtime not restarted ⇒ restart first, no setup', () => {
    const v = ocrStatusView(DISABLED, cfg(true))
    expect(v.commands[0].command).toBe(RUNTIME_RESTART_COMMAND)
    expect(v.commands.map((c) => c.command)).not.toContain(OCR_SETUP_COMMAND)
  })

  it('worker down ⇒ degraded: check, then restart; WeChat only via OCR', () => {
    const v = ocrStatusView(WORKER_DOWN, cfg(true))
    expect(v.kind).toBe('degraded')
    expect(v.commands.map((c) => c.command)).toEqual([OCR_CHECK_COMMAND, RUNTIME_RESTART_COMMAND])
    expect(v.wechatWarning).toContain(wechatOnlyViaOcr())
    expect(v.canRestart).toBe(true)
  })

  it('health unreachable ⇒ unknown: start the Runtime; never claims on; WeChat only via OCR', () => {
    const v = ocrStatusView(null, null)
    expect(v.kind).toBe('unknown')
    expect(v.commands.map((c) => c.command)).toEqual([RUNTIME_START_COMMAND])
    expect(v.wechatWarning).toContain(wechatOnlyViaOcr())
    expect(v.canRestart).toBe(false)
  })
})

describe('S1-R4-08 panel render per state (Capture + Ask share it)', () => {
  it('enabled + ready: green banner, no copy buttons', () => {
    const html = render({ diag: diag(READY, cfg(true)), testId: 'capture-ocr-status' })
    expect(html).toContain('data-ocr-kind="on"')
    expect(html).not.toContain('data-command=')
    expect(html).not.toContain('capture-ocr-status-wechat-warning')
  })

  it('disabled: copyable commands in order, WeChat warning, restart button, config.toml not edited', () => {
    const html = render({ diag: diag(DISABLED, cfg(false)), testId: 'ask-ocr-status' })
    expect(html).toContain('data-ocr-kind="off"')
    expect(commandsIn(html, 'ask-ocr-status')).toEqual([OCR_SETUP_COMMAND, RUNTIME_RESTART_COMMAND, OCR_CHECK_COMMAND])
    expect(html).toContain(`data-command="${OCR_SETUP_COMMAND}"`)
    expect(html).toContain('>Copy<')
    expect(html).toContain('data-testid="ask-ocr-status-wechat-warning"')
    expect(html).toContain("change ~/.persome/config.toml")
    expect(html).toContain('Restart Runtime…')
  })

  it('worker down: degraded banner with check + restart commands', () => {
    const html = render({ diag: diag(WORKER_DOWN, cfg(true)), testId: 'capture-ocr-status' })
    expect(html).toContain('data-ocr-kind="degraded"')
    expect(commandsIn(html, 'capture-ocr-status')).toEqual([OCR_CHECK_COMMAND, RUNTIME_RESTART_COMMAND])
    expect(html).toContain('OCR worker failed to start')
  })

  it('health unreachable: /health null → unknown; diagnostics IPC failed → unknown (not blank); loading → nothing', () => {
    const a = render({ diag: diag(null, cfg(true)), testId: 'ask-ocr-status' })
    expect(a).toContain('data-ocr-kind="unknown"')
    expect(commandsIn(a, 'ask-ocr-status')).toEqual([RUNTIME_START_COMMAND])
    const b = render({ diag: undefined, failed: true, testId: 'ask-ocr-status' })
    expect(b).toContain('data-ocr-kind="unknown"')
    expect(b).toContain('ask-ocr-status-wechat-warning')
    expect(render({ diag: undefined })).toBe('')
  })
})

describe('S1-R4-08 Navalia never writes config.toml', () => {
  it('OCR UI sources only copy text; no fs / config write path; pages pass the failed flag', () => {
    const dir = path.resolve(__dirname, '../../src/renderer/src')
    for (const f of ['components/ask/ocrStatus.ts', 'components/ask/OcrStatusPanel.tsx']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      expect(src).not.toMatch(/from ['"](node:)?fs['"]|writeFile|saveOcrConfig|setOcr|config\.write/)
    }
    expect(fs.readFileSync(path.join(dir, 'components/ask/OcrStatusPanel.tsx'), 'utf8')).toContain('window.lens.app.copy(command)')
    expect(fs.readFileSync(path.join(dir, 'pages/Ask.tsx'), 'utf8')).toMatch(/OcrStatusPanel diag=\{diag\.data\} failed=\{diag\.isError\}/)
    expect(fs.readFileSync(path.join(dir, 'pages/Capture.tsx'), 'utf8')).toMatch(/OcrStatusPanel diag=\{d\} failed=\{diag\.isError\}/)
  })
})
