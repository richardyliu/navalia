import { describe, expect, it } from 'vitest'
import { CAPTURE_CHANNELS } from '../../src/main/capture/api'
import { registerCaptureIpc } from '../../src/main/capture/ipc'
import type { CaptureService } from '../../src/main/capture/service'

function setup() {
  const handlers = new Map<string, (e: unknown, raw: unknown) => Promise<unknown>>()
  const calls: string[] = []
  const opened: string[] = []
  const service = {
    status: () => (calls.push('status'), { started: false }),
    restart: () => (calls.push('restart'), { started: false }),
    pause: (m: string) => (calls.push(`pause:${m}`), { paused: true }),
    resume: () => (calls.push('resume'), { paused: false }),
    addExclusion: (k: string, v: string) => calls.push(`add:${k}:${v}`),
    removeExclusion: (k: string, v: string) => calls.push(`remove:${k}:${v}`),
    pickAndExclude: async () => ({ path: '/Applications/X.app', bundleId: 'x.y', name: 'X' }),
    requestAccessibility: () => true,
    requestScreenRecording: async () => ({ granted: false })
  } as unknown as CaptureService
  registerCaptureIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, service, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    openExternal: async (u) => void opened.push(u)
  })
  const invoke = (ch: string, raw?: unknown) => handlers.get(ch)!(null, raw)
  return { handlers, calls, opened, invoke }
}

describe('capture IPC', () => {
  it('registers every channel', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(CAPTURE_CHANNELS).sort())
  })

  it('validates arguments with zod', async () => {
    const { invoke, calls } = setup()
    expect(await invoke(CAPTURE_CHANNELS.pause, { mode: 'forever' })).toMatchObject({ ok: false })
    expect(await invoke(CAPTURE_CHANNELS.status, { extra: 1 })).toMatchObject({ ok: false })
    expect(await invoke(CAPTURE_CHANNELS.excludeAdd, { kind: 'bundleId', value: '' })).toMatchObject({ ok: false })
    expect(await invoke(CAPTURE_CHANNELS.excludeAdd, { kind: 'path', value: 'x' })).toMatchObject({ ok: false })
    expect(calls).toEqual([])
    expect(await invoke(CAPTURE_CHANNELS.pause, { mode: 'untilMidnight' })).toMatchObject({ ok: true })
    expect(await invoke(CAPTURE_CHANNELS.excludeAdd, { kind: 'appName', value: ' Signal ' })).toEqual({ ok: true, data: true })
    expect(calls).toEqual(['pause:untilMidnight', 'add:appName:Signal'])
  })

  it('opens only the fixed System Settings privacy panes', async () => {
    const { invoke, opened } = setup()
    expect(await invoke(CAPTURE_CHANNELS.openPrivacy, { pane: 'https://evil.example' })).toMatchObject({ ok: false })
    await invoke(CAPTURE_CHANNELS.openPrivacy, { pane: 'accessibility' })
    await invoke(CAPTURE_CHANNELS.openPrivacy, { pane: 'screenRecording' })
    expect(opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    ])
  })

  it('returns only bundle id and name from the picker', async () => {
    const { invoke } = setup()
    expect(await invoke(CAPTURE_CHANNELS.pickApp)).toEqual({ ok: true, data: { bundleId: 'x.y', name: 'X' } })
  })
})
