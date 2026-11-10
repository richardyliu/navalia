/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, versions 1–10, ECC L/M/Q/H.
 * Pure TypeScript with no Node imports, so main and renderer share it. Written for the
 * Swipe QR, whose payload is only `{v:1, card_id, fp}` (~130 bytes), so v10 is ample.
 */

export type Ecc = 'L' | 'M' | 'Q' | 'H'

const ECC_FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }
// Index = version (1..10); index 0 unused.
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28]
}
const NUM_BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8]
}
export const MAX_VERSION = 10

export interface QrCode {
  version: number
  ecc: Ecc
  mask: number
  size: number
  /** modules[y][x], true = dark. */
  modules: boolean[][]
}

// ---- GF(2^8) Reed–Solomon (primitive polynomial 0x11D) ----

export function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

export function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)))
  }
  return result
}

// ---- Layout helpers ----

export function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

export function dataCodewords(ver: number, ecc: Ecc): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * NUM_BLOCKS[ecc][ver]
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const size = ver * 4 + 17
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

/** 15-bit format information (ECC level + mask, BCH-protected, XOR 0x5412). */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 18-bit version information (versions >= 7). */
export function versionBits(ver: number): number {
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (ver << 12) | rem
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

class Matrix {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]
  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }
  setFn(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }
}

function drawFunctionPatterns(m: Matrix, ecc: Ecc): void {
  const { size, version } = m
  for (let i = 0; i < size; i++) {
    m.setFn(6, i, i % 2 === 0)
    m.setFn(i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        m.setFn(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const pos = alignmentPositions(version)
  const n = pos.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  drawFormat(m, ecc, 0) // reserve; rewritten after masking
  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      m.setFn(a, b, bit(bits, i))
      m.setFn(b, a, bit(bits, i))
    }
  }
}

function drawFormat(m: Matrix, ecc: Ecc, mask: number): void {
  const bits = formatBits(ecc, mask)
  const { size } = m
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(bits, i))
  m.setFn(8, 7, bit(bits, 6))
  m.setFn(8, 8, bit(bits, 7))
  m.setFn(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, bit(bits, i))
  m.setFn(8, size - 8, true) // the always-dark module
}

function interleave(data: number[], ver: number, ecc: Ecc): number[] {
  const numBlocks = NUM_BLOCKS[ecc][ver]
  const eccLen = ECC_PER_BLOCK[ecc][ver]
  const raw = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ec = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push(dat.concat(ec))
  }
  const out: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i])
    })
  }
  return out
}

function drawCodewords(m: Matrix, data: number[]): void {
  const { size } = m
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!m.isFunction[y][x] && i < data.length * 8) {
          m.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7))
          i++
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (!m.isFunction[y][x] && maskBit(mask, x, y)) m.modules[y][x] = !m.modules[y][x]
  }
}

/** Standard penalty score (rules N1–N4); only used to pick a mask, any mask decodes. */
export function penalty(mods: boolean[][]): number {
  const size = mods.length
  let score = 0
  const line = (get: (i: number) => boolean) => {
    let s = 0
    let run = 1
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++
        if (run === 5) s += 3
        else if (run > 5) s += 1
      } else run = 1
    }
    const seq = Array.from({ length: size }, (_, i) => get(i))
    const pat = [true, false, true, true, true, false, true]
    for (let i = 0; i + 7 <= size; i++) {
      if (!pat.every((p, k) => seq[i + k] === p)) continue
      const before = i - 4 >= 0 && seq.slice(i - 4, i).every((v) => !v)
      const after = i + 11 <= size && seq.slice(i + 7, i + 11).every((v) => !v)
      if (before || after) s += 40
    }
    return s
  }
  for (let y = 0; y < size; y++) score += line((i) => mods[y][i])
  for (let x = 0; x < size; x++) score += line((i) => mods[i][x])
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mods[y][x]
      if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) score += 3
    }
  }
  const dark = mods.reduce((s, r) => s + r.filter(Boolean).length, 0)
  const total = size * size
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
  return score
}

/** Encode UTF-8 bytes. Picks the smallest version that fits at the given ECC level. */
export function encodeQr(bytes: Uint8Array, ecc: Ecc = 'M', forceMask?: number): QrCode {
  let version = 1
  for (; version <= MAX_VERSION; version++) {
    const ccBits = version <= 9 ? 8 : 16
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(version, ecc) * 8) break
  }
  if (version > MAX_VERSION) throw new Error(`payload of ${bytes.length} bytes exceeds QR version ${MAX_VERSION}-${ecc}`)

  const bits: number[] = []
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(version, ecc) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  const base = new Matrix(version)
  drawFunctionPatterns(base, ecc)
  drawCodewords(base, interleave(data, version, ecc))

  let best: { mask: number; modules: boolean[][] } | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue
    const m = new Matrix(version)
    m.modules.forEach((row, y) => row.forEach((_, x) => {
      m.modules[y][x] = base.modules[y][x]
      m.isFunction[y][x] = base.isFunction[y][x]
    }))
    applyMask(m, mask)
    drawFormat(m, ecc, mask)
    const s = penalty(m.modules)
    if (s < bestScore) {
      bestScore = s
      best = { mask, modules: m.modules }
    }
  }
  const chosen = best as { mask: number; modules: boolean[][] }
  return { version, ecc, mask: chosen.mask, size: version * 4 + 17, modules: chosen.modules }
}

export function encodeQrText(text: string, ecc: Ecc = 'M'): QrCode {
  return encodeQr(new TextEncoder().encode(text), ecc)
}

/** SVG with a 4-module quiet zone. Dark modules merged per row into runs. */
export function qrToSvg(qr: QrCode, scale = 8): string {
  const border = 4
  const dim = (qr.size + border * 2) * scale
  let path = ''
  qr.modules.forEach((row, y) => {
    let x = 0
    while (x < qr.size) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (end < qr.size && row[end]) end++
      path += `M${(x + border) * scale} ${(y + border) * scale}h${(end - x) * scale}v${scale}h${-(end - x) * scale}z`
      x = end
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
