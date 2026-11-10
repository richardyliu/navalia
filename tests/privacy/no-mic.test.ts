import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

// PRIV-10 (static), revised for S1-FULL C12 (opt-in Meetings, DECISIONS S1F-6): the microphone is
// reachable ONLY through the meetings recorder, behind consent + native confirm + the main-side mic
// gate. Exactly one Lens-specific usage string; no entitlements; no native audio APIs; system audio
// capture / camera strings still stripped.
const ROOT = path.join(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mm|m|cc|cpp|h|js|cjs|mjs|json|plist)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('PRIV-10: microphone only via the gated Meetings recorder', () => {
  test('after-pack strips NSAudioCaptureUsageDescription / camera but keeps Lens\'s own microphone string', () => {
    const hook = fs.readFileSync(path.join(ROOT, 'build/after-pack.cjs'), 'utf8')
    expect(hook).toContain("'NSAudioCaptureUsageDescription'")
    expect(hook).toContain("'NSCameraUsageDescription'")
    expect(hook).not.toContain("'NSMicrophoneUsageDescription'")
  })

  test('package.json: no entitlements / audio-input; exactly one usage string (microphone, Lens text)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    expect(raw).not.toMatch(/device\.audio-input|entitlements/)
    const pkg = JSON.parse(raw) as { build: { mac: { extendInfo?: Record<string, string> } } }
    expect(Object.keys(pkg.build.mac.extendInfo ?? {})).toEqual(['NSMicrophoneUsageDescription'])
    expect(pkg.build.mac.extendInfo?.NSMicrophoneUsageDescription).toMatch(/会议.*告知参会者/)
  })

  test('only the meetings recorder requests audio; no native audio APIs anywhere', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'native'))].filter((f) => !f.includes('node_modules') && !f.includes(`${path.sep}build${path.sep}`))
    const hits = files.filter((f) => /getUserMedia|AVMediaTypeAudio|AVCaptureDevice|audio-input|NSMicrophone/.test(fs.readFileSync(f, 'utf8')))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([path.join('src', 'renderer', 'src', 'components', 'meetings', 'recorder.ts')])
    const rec = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/meetings/recorder.ts'), 'utf8')
    expect(rec).toMatch(/getUserMedia\(\s*\{\s*audio:\s*true,\s*video:\s*false/)
    expect(rec).not.toMatch(/getDisplayMedia|AVCaptureDevice|AVMediaTypeAudio/)
  })
})
