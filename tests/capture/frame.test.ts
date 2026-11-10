import { describe, expect, it } from 'vitest'
import { buildFrame, RECORDING_AX_OPTIONS } from '../../src/main/capture/frame'
import type { LensNative } from '../../src/main/capture/native'

const trigger = { event_type: 'AXApplicationActivated', app_name: 'Notes', bundle_id: 'com.apple.Notes', window_title: '' }

function fakeNative(front: { bundleId: string; name: string }, screenRecording = true, shotOk = true) {
  const calls: string[] = []
  const tree = {
    timestamp: '2026-11-04T20:00:00Z',
    apps: [{ name: front.name, bundle_id: front.bundleId, is_frontmost: true, pid: 1, windows: [{ title: 'Doc', focused: true }] }]
  }
  const native = {
    frontmost: () => (calls.push('frontmost'), { pid: 1, name: front.name, bundleId: front.bundleId, bundlePath: null, windowTitle: null }),
    axTree: async (opts: unknown) => (calls.push(`axTree:${JSON.stringify(opts)}`), JSON.stringify(tree)),
    permissions: () => ({ accessibility: true, screenRecording }),
    browserUrl: (pid: number) => (calls.push(`browserUrl:${pid}`), 'https://example.com/page'),
    screenshot: async (opts: unknown) => (
      calls.push(`screenshot:${JSON.stringify(opts)}`),
      shotOk ? { data: Buffer.from([0xff, 0xd8, 0xff]), width: 10, height: 5, mimeType: 'image/jpeg' as const, backend: 'screencapturekit' as const } : null
    )
  } as unknown as LensNative
  return { native, calls }
}

describe('buildFrame', () => {
  it('builds a CaptureIngestBody-shaped frame with the daemon AX options', async () => {
    const { native, calls } = fakeNative({ bundleId: 'com.apple.Notes', name: 'Notes' })
    const r = await buildFrame(native, trigger, { includeScreenshot: true, now: () => Date.UTC(2026, 10, 4, 20) })
    expect(r.frame).toMatchObject({
      timestamp: '2026-11-04T20:00:00.000Z',
      trigger,
      window_meta: { app_name: 'Notes', title: 'Doc', bundle_id: 'com.apple.Notes' },
      ax_metadata: { mode: 'frontmost', depth: 100, platform: 'macos', raw: false },
      screenshot: { image_base64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), mime_type: 'image/jpeg', width: 10, height: 5 }
    })
    expect((r.frame!.ax_tree as { apps: unknown[] }).apps).toHaveLength(1)
    expect(calls).toContain(`axTree:${JSON.stringify(RECORDING_AX_OPTIONS)}`)
  })

  it('checks exclusion before any AX or screenshot call', async () => {
    const { native, calls } = fakeNative({ bundleId: 'com.1password.1password', name: '1Password' })
    const r = await buildFrame(native, trigger, {
      includeScreenshot: true,
      isExcluded: (b) => b === 'com.1password.1password'
    })
    expect(r).toEqual({ frame: null, skipped: 'excluded_app' })
    expect(calls).toEqual(['frontmost'])
  })

  it('omits the screenshot when Screen Recording is not granted', async () => {
    const { native, calls } = fakeNative({ bundleId: 'com.apple.Notes', name: 'Notes' }, false)
    const r = await buildFrame(native, trigger, { includeScreenshot: true })
    expect(r.frame!.screenshot).toBeUndefined()
    expect(calls.some((c) => c.startsWith('screenshot'))).toBe(false)
    expect(r.local).toMatchObject({ screenshot: 'not_granted' })
  })

  it('grabs only the vetted frontmost window, pinned to its pid', async () => {
    const { native, calls } = fakeNative({ bundleId: 'com.apple.Notes', name: 'Notes' })
    await buildFrame(native, trigger, { includeScreenshot: true })
    const shots = calls.filter((c) => c.startsWith('screenshot'))
    expect(shots).toHaveLength(1)
    expect(JSON.parse(shots[0].slice('screenshot:'.length))).toMatchObject({ scope: 'frontmostWindow', pid: 1 })
  })

  it('a failed window grab yields AX-only, never a display fallback', async () => {
    const { native, calls } = fakeNative({ bundleId: 'com.apple.Notes', name: 'Notes' }, true, false)
    const r = await buildFrame(native, trigger, { includeScreenshot: true })
    expect(r.frame!.screenshot).toBeUndefined()
    expect(r.frame!.ax_tree).toBeDefined()
    expect(r.local).toMatchObject({ screenshot: 'unavailable' })
    const shots = calls.filter((c) => c.startsWith('screenshot'))
    expect(shots).toHaveLength(1)
    expect(shots.some((c) => c.includes('"display"'))).toBe(false)
  })

  it('never captures Lens itself', async () => {
    const { native, calls } = fakeNative({ bundleId: 'dev.navalia.app', name: 'Navalia' })
    expect(await buildFrame(native, trigger, { includeScreenshot: true, selfPid: 1 })).toEqual({ frame: null, skipped: 'self' })
    expect(calls).toEqual(['frontmost'])
  })

  it('reads the page URL only for registered browsers and keeps it out of the ingest body', async () => {
    const chrome = fakeNative({ bundleId: 'com.google.Chrome', name: 'Google Chrome' })
    const r = await buildFrame(chrome.native, trigger, { includeScreenshot: false, browserBundleIds: new Set(['com.google.Chrome']) })
    expect(r.local).toMatchObject({ url: 'https://example.com/page', screenshot: 'disabled' })
    expect(JSON.stringify(r.frame)).not.toContain('example.com/page')
    const notes = fakeNative({ bundleId: 'com.apple.Notes', name: 'Notes' })
    await buildFrame(notes.native, trigger, { includeScreenshot: false, browserBundleIds: new Set(['com.google.Chrome']) })
    expect(notes.calls.some((c) => c.startsWith('browserUrl'))).toBe(false)
  })
})
