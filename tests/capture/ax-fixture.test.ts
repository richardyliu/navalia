import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadNative } from '../../src/main/capture/native'

/**
 * Byte equality between the addon's axTree serialization and the OSS
 * mac-ax-helper. Expected files are the stdout of the OSS helper compiled as a
 * fixture-driven oracle (native/scripts/build-oracle.sh + record-ax-fixtures.sh).
 */
const ROOT = path.resolve(__dirname, '../..')
const FIX = path.join(ROOT, 'native/fixtures/ax')
const ORACLE = path.join(ROOT, 'native/build/oracle/mac-ax-helper-oracle')
const OSS_SRC = path.join(os.homedir(), 'Documents/GitHub/personal-model/resources/mac-ax-helper.swift')

interface Mode {
  name: string
  args: string[]
  options: Record<string, unknown>
}
const modes: Mode[] = JSON.parse(fs.readFileSync(path.join(FIX, 'modes.json'), 'utf8'))
const inputs = fs.readdirSync(FIX).filter((f) => f.endsWith('.input.json')).sort()

const loaded = loadNative(ROOT)

describe('axTree byte compatibility with mac-ax-helper', () => {
  it('loads the addon', () => {
    expect(loaded.error).toBeNull()
    expect(typeof loaded.native?._axTreeFromFixture).toBe('function')
  })

  it('has fixtures for every mode', () => {
    expect(inputs.length).toBeGreaterThanOrEqual(6)
    expect(modes.length).toBeGreaterThanOrEqual(10)
  })

  for (const input of inputs) {
    const base = input.replace(/\.input\.json$/, '')
    for (const mode of modes) {
      it(`${base} / ${mode.name}`, () => {
        const fixture = fs.readFileSync(path.join(FIX, input), 'utf8')
        const expectedJson = path.join(FIX, `${base}.${mode.name}.expected.json`)
        const expectedExit = path.join(FIX, `${base}.${mode.name}.expected.exit`)
        if (fs.existsSync(expectedExit)) {
          expect(() => loaded.native!._axTreeFromFixture(fixture, mode.options)).toThrow()
          return
        }
        const expected = fs.readFileSync(expectedJson)
        // The helper prints the JSON followed by one newline.
        const actual = Buffer.from(loaded.native!._axTreeFromFixture(fixture, mode.options) + '\n', 'utf8')
        expect(actual.equals(expected)).toBe(true)
        if (!actual.equals(expected)) expect(actual.toString('utf8')).toBe(expected.toString('utf8'))
      })
    }
  }

  it('recorded oracle matches the current OSS helper source', () => {
    const recorded = fs.readFileSync(path.join(FIX, 'ORACLE_HELPER_SHA256'), 'utf8').trim()
    if (!fs.existsSync(OSS_SRC)) return // OSS checkout absent: recorded bytes remain the contract
    const current = createHash('sha256').update(fs.readFileSync(OSS_SRC)).digest('hex')
    expect(current, 'OSS mac-ax-helper.swift changed: rebuild oracle and re-record').toBe(recorded)
  })

  it('live oracle (when built) reproduces every recorded expectation', () => {
    if (!fs.existsSync(ORACLE)) return
    let checked = 0
    for (const input of inputs) {
      const base = input.replace(/\.input\.json$/, '')
      for (const mode of modes) {
        const run = spawnSync(ORACLE, mode.args, {
          env: { ...process.env, LENS_AX_FIXTURE: path.join(FIX, input) }
        })
        const expectedJson = path.join(FIX, `${base}.${mode.name}.expected.json`)
        if (fs.existsSync(expectedJson)) {
          expect(run.status).toBe(0)
          expect(run.stdout.equals(fs.readFileSync(expectedJson))).toBe(true)
        } else {
          expect(run.status).not.toBe(0)
        }
        checked++
      }
    }
    expect(checked).toBe(inputs.length * modes.length)
  })

  it('a deliberately different config is detected (negative control)', () => {
    const fixture = fs.readFileSync(path.join(FIX, 'native-notes.input.json'), 'utf8')
    const shallow = loaded.native!._axTreeFromFixture(fixture, { maxDepth: 3 }) + '\n'
    const expected = fs.readFileSync(path.join(FIX, 'native-notes.default.expected.json'), 'utf8')
    expect(shallow).not.toBe(expected)
  })
})

describe('live axTree / permissions (environment-dependent)', () => {
  it('permissions() returns booleans without prompting', () => {
    const p = loaded.native!.permissions()
    expect(typeof p.accessibility).toBe('boolean')
    expect(typeof p.screenRecording).toBe('boolean')
  })

  it('axTree() rejects with ERR_AX_NOT_TRUSTED when untrusted, else matches the live helper shape', async () => {
    const native = loaded.native!
    if (!native.permissions().accessibility) {
      await expect(native.axTree()).rejects.toMatchObject({ code: 'ERR_AX_NOT_TRUSTED' })
      return
    }
    const parsed = JSON.parse(await native.axTree({ focusedWindowOnly: true }))
    expect(Array.isArray(parsed.apps)).toBe(true)
    expect(typeof parsed.timestamp).toBe('string')
  })

  it('screenshot() resolves null (no prompt) when Screen Recording is not granted', async () => {
    const native = loaded.native!
    const shot = await native.screenshot({ maxWidth: 640 })
    if (!native.permissions().screenRecording) {
      expect(shot).toBeNull()
    } else {
      expect(shot!.mimeType).toBe('image/jpeg')
      expect(shot!.data.subarray(0, 2).toString('hex')).toBe('ffd8')
      expect(shot!.width).toBeLessThanOrEqual(640)
    }
  })

  it('frontmost() reports the active app', () => {
    const front = loaded.native!.frontmost()
    if (front) expect(typeof front.pid).toBe('number')
  })
})

