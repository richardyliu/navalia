// S1-R3-09 OCR status view-model shared by Capture and Ask.
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n'
import { ocrStatusView } from '../../src/renderer/src/components/ask/ocrStatus'
import type { OcrConfigView, RuntimeOcrHealth } from '../../src/main/capture/api'
import { parseRuntimeOcrHealth } from '../../src/main/capture/diagnostics'

/** `[capture]` keys `persome ocr setup` writes (personal-model src/persome/ocr_setup.py save_ocr_config). */
const OCR_CONFIG_KEYS = ['enable_ocr_fallback', 'ocr_policy', 'ocr_tier'] as const

const cfg = (enabled: boolean | null): OcrConfigView => ({
  enabled,
  policy: enabled === null ? null : enabled ? 'enabled' : 'disabled',
  tier: 'tiny',
  origin: { enabled: 'config', policy: 'config', tier: 'config' }
})

describe('ocrStatusView', () => {
  it('real /health on 2026-11-05 (ocr_enabled=true, tier tiny, ready) ⇒ on, no WeChat warning', () => {
    const real = parseRuntimeOcrHealth({
      success: true,
      data: { status: 'ok', ocr: 'ready', ocr_worker: 'ready', ocr_enabled: true, ocr_tier: 'tiny', index: 'ok', capture_pipeline: 'ok' }
    })
    expect(real).toEqual({ state: 'ready', enabled: true, tier: 'tiny', worker: 'ready' })
    const v = ocrStatusView(real, cfg(true))
    expect(v.kind).toBe('on')
    expect(v.wechatWarning).toBeNull()
    expect(v.steps).toEqual([])
    expect(v.fields).toEqual([
      ['ocr_enabled', 'true'],
      ['ocr', 'ready'],
      ['ocr_worker', 'ready'],
      ['ocr_tier', 'tiny']
    ])
  })

  it('ocr_enabled=false ⇒ off, numbered steps name the config keys, then restart, then verify', () => {
    const rt: RuntimeOcrHealth = { state: 'disabled', enabled: false, tier: 'tiny', worker: 'not_started' }
    const v = ocrStatusView(rt, cfg(false))
    expect(v.kind).toBe('off')
    expect(v.canRestart).toBe(true)
    expect(v.wechatWarning).toMatch(/OCR is off/)
    expect(v.wechatWarning).toMatch(/WeChat/)
    expect(v.steps.length).toBeGreaterThanOrEqual(3)
    const all = v.steps.join('\n')
    expect(all).toContain('persome ocr setup')
    for (const k of OCR_CONFIG_KEYS) expect(all).toContain(k)
    expect(all).toContain('[capture]')
    expect(v.steps.findIndex((s) => /Restart Runtime/.test(s))).toBeGreaterThan(v.steps.findIndex((s) => s.includes('enable_ocr_fallback')))
    expect(all).toMatch(/Navalia never modifies/)
  })

  it('config already on but Runtime still off ⇒ says the Runtime has not reloaded; restart is the first step', () => {
    const v = ocrStatusView({ state: 'disabled', enabled: false, tier: 'tiny', worker: null }, cfg(true))
    expect(v.kind).toBe('off')
    expect(v.title).toMatch(/has not been restarted/)
    expect(v.steps[0]).toMatch(/Restart Runtime/)
  })

  it('disabled_by_environment ⇒ off with the PERSOME_DISABLE_OCR step', () => {
    const v = ocrStatusView({ state: 'disabled_by_environment', enabled: true, tier: 'tiny', worker: null }, cfg(true))
    expect(v.kind).toBe('off')
    expect(v.steps.join('\n')).toContain('PERSOME_DISABLE_OCR')
  })

  it('enabled but permission_required / worker failed ⇒ degraded with WeChat warning', () => {
    const p = ocrStatusView({ state: 'permission_required', enabled: true, tier: 'tiny', worker: 'not_started' }, cfg(true))
    expect(p.kind).toBe('degraded')
    expect(p.steps.join('\n')).toMatch(/Screen Recording/)
    expect(p.wechatWarning).toMatch(/not ready/)
    const f = ocrStatusView({ state: 'ready', enabled: true, tier: 'tiny', worker: 'failed' }, cfg(true))
    expect(f.kind).toBe('degraded')
    expect(f.steps.join('\n')).toContain('persome ocr status --check')
  })

  it('warming worker ⇒ degraded, wait then refresh, no restart offered', () => {
    const v = ocrStatusView({ state: 'ready', enabled: true, tier: 'tiny', worker: 'warming' }, cfg(true))
    expect(v.kind).toBe('degraded')
    expect(v.canRestart).toBe(false)
  })

  it('/health unreachable ⇒ unknown; WeChat warning says it cannot be confirmed; never claims on', () => {
    const v = ocrStatusView(null, cfg(true))
    expect(v.kind).toBe('unknown')
    expect(v.wechatWarning).toMatch(/Cannot confirm/)
    expect(v.canRestart).toBe(false)
  })

  it('older Runtime without ocr_enabled: falls back to state', () => {
    expect(ocrStatusView({ state: 'ready', enabled: null, tier: null, worker: null }, null).kind).toBe('on')
    expect(ocrStatusView({ state: 'disabled', enabled: null, tier: null, worker: null }, null).kind).toBe('off')
    expect(ocrStatusView({ state: null, enabled: null, tier: null, worker: null }, null).kind).toBe('unknown')
  })
})

describe('ocrStatusView in Chinese', () => {
  afterEach(() => setLocale('en'))
  it('keeps the original Chinese wording when the locale is zh', () => {
    setLocale('zh')
    const v = ocrStatusView({ state: 'disabled', enabled: false, tier: 'tiny', worker: 'not_started' }, cfg(false))
    expect(v.wechatWarning).toMatch(/OCR 已关闭/)
    expect(v.steps.join('\n')).toMatch(/Navalia 不会修改/)
    expect(ocrStatusView(null, cfg(true)).wechatWarning).toMatch(/无法确认/)
  })
})
