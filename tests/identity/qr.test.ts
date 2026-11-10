import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { dataCodewords, encodeQr, encodeQrText, formatBits, gfMul, qrToSvg, rsDivisor, rsRemainder, versionBits, type Ecc } from '../../src/main/identity/qr'
import { tempRoot } from './helpers'

describe('QR building blocks (ISO/IEC 18004 reference values)', () => {
  test('GF(256) multiply', () => {
    expect(gfMul(0x02, 0x80)).toBe(0x1d) // x * x^7 = x^8 ≡ 0x1D mod 0x11D
    expect(gfMul(0x53, 0xca)).toBe(gfMul(0xca, 0x53))
    expect(gfMul(1, 0xab)).toBe(0xab)
  })

  test('Reed–Solomon: the classic 1-M "01234567" codewords', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
    expect(rsRemainder(data, rsDivisor(10)).map((b) => b.toString(16).padStart(2, '0')).join(' ')).toBe('a5 24 d4 c1 ed 36 c7 87 2c 55')
  })

  test('format and version information words', () => {
    expect(formatBits('M', 0).toString(2).padStart(15, '0')).toBe('101010000010010')
    expect(formatBits('L', 4).toString(2).padStart(15, '0')).toBe('110011000101111')
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100')
    expect(versionBits(10).toString(2).padStart(18, '0')).toBe('001010010011010011')
  })

  test('data capacity (codewords) matches the standard table', () => {
    expect([1, 2, 7, 8, 10].map((v) => dataCodewords(v, 'M'))).toEqual([16, 28, 124, 154, 216]) // data codewords (byte-mode capacity is 2 less: 122, 152)
    expect([1, 10].map((v) => dataCodewords(v, 'H'))).toEqual([9, 122])
  })

  test('swipe payload (129 bytes) → version 8-M; too long → throws', () => {
    const payload = JSON.stringify({ v: 1, card_id: `card_${'a'.repeat(32)}`, fp: 'b'.repeat(64) })
    expect(payload.length).toBe(129)
    const qr = encodeQrText(payload)
    expect([qr.version, qr.ecc, qr.size]).toEqual([8, 'M', 49])
    expect(() => encodeQr(new Uint8Array(400), 'M')).toThrow(/exceeds/)
  })

  test('SVG has a quiet zone and only dark-module paths', () => {
    const svg = qrToSvg(encodeQrText('hi'), 4)
    expect(svg).toContain('width="116"') // (21 + 8) * 4
    expect(svg).not.toMatch(/<script|href/)
  })
})

// Independent decode with Apple Vision (scratch Swift binary). Runs when LENS_QR_DECODER is set.
const decoder = process.env.LENS_QR_DECODER
describe.skipIf(!decoder)('QR decodes with an independent decoder (Apple Vision)', () => {
  test('every version 1–10 × ECC L/M/Q/H × mask 0–7 round-trips', () => {
    const dir = tempRoot('qr')
    const expected = new Map<string, string>()
    for (const ecc of ['L', 'M', 'Q', 'H'] as Ecc[]) {
      for (let v = 1; v <= 10; v++) {
        const n = dataCodewords(v, ecc) - (v <= 9 ? 2 : 3)
        const text = Array.from({ length: n }, (_, i) => 'abcdefghijKLMNOP0123456789'[(i * 5 + v) % 26]).join('')
        for (let mask = 0; mask < 8; mask++) {
          const qr = encodeQr(new TextEncoder().encode(text), ecc, mask)
          expect(qr.version).toBe(v)
          const name = path.join(dir, `v${v}-${ecc}-${mask}.txt`)
          fs.writeFileSync(name, qr.modules.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('\n'))
          expected.set(path.basename(name), text)
        }
      }
    }
    const out = execFileSync(decoder as string, [...expected.keys()].map((n) => path.join(dir, n)), { encoding: 'utf8', maxBuffer: 1 << 24 })
    const got = new Map(out.trim().split('\n').map((l) => l.split('\t') as [string, string]))
    const bad = [...expected].filter(([k, v]) => got.get(k) !== v).map(([k]) => k)
    expect(bad).toEqual([])
    expect(got.size).toBe(320)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 120_000)
})
