import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'
import { tr } from '../../shared/i18n'

/**
 * C21 — encrypted backup archive (`navalia.backup-enc` v1). node:crypto only.
 *
 * File layout:
 *   MAGIC (8 bytes "PLBKENC1") | u32be headerLen | header JSON (utf8)          ← "header bytes"
 *   chunk*: u32be plainLen | ciphertext (plainLen) | GCM tag (16)
 *
 *  - Key = scrypt(passphrase NFC, salt 16 random bytes, N ≥ 2^15, r, p) → 32 bytes, AES-256-GCM.
 *  - Nonce (12) = nonce_prefix (7 random bytes, per archive) | u32be chunk index | final flag (0/1).
 *    STREAM construction: reordering, dropping, truncating or appending chunks all fail.
 *  - AAD of every chunk = header bytes | u32be index | u32be plainLen, so the header (format version,
 *    KDF params, salt, nonce prefix, chunk size) is authenticated by every chunk.
 *  - Plaintext of a chunk is released only after its tag verified (decipher.final()).
 *  - KDF params read from a file are bounded (N 2^15..2^18, r 8..16, p 1..4, N·r ≤ 2^21) so a crafted
 *    header cannot make the main process allocate unbounded memory.
 *
 * The plaintext is a simple container (see `ContainerWriter` / `ContainerReader`):
 *   "PLBKTAR1" | entry* | u16be 0
 *   entry = u16be pathLen | path utf8 | u32be sizeHi | u32be sizeLo | bytes
 */

export const ENC_MAGIC = Buffer.from('PLBKENC1', 'ascii')
export const ENC_FORMAT = 'navalia.backup-enc'
/** Previous name (Grapple); still accepted when decrypting. */
export const PREV_ENC_FORMAT = 'grapple.backup-enc'
export const PREV_ENC_EXT = 'grapplebackup'
/** Pre-rename (Persome Lens) names; still accepted when decrypting. */
export const LEGACY_ENC_FORMAT = 'persome-lens.backup-enc'
export const LEGACY_ENC_EXT = 'lensbackup'
export const ENC_FORMAT_VERSION = 1
export const ENC_EXT = 'navaliabackup'
export const TAR_MAGIC = Buffer.from('PLBKTAR1', 'ascii')
export const DEFAULT_CHUNK_BYTES = 1024 * 1024
export const KDF_DEFAULT = { N: 2 ** 15, r: 8, p: 1 } as const
const TAG_BYTES = 16
const MAX_HEADER_BYTES = 4096
export const MIN_PASSPHRASE = 8
export const MAX_PASSPHRASE = 1024

export class BackupCryptoError extends Error {
  constructor(
    readonly code: 'bad_passphrase' | 'tampered' | 'truncated' | 'format',
    message: string
  ) {
    super(message)
    this.name = 'BackupCryptoError'
  }
}

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
export const EncHeaderSchema = z.strictObject({
  format: z.union([z.literal(ENC_FORMAT), z.literal(PREV_ENC_FORMAT), z.literal(LEGACY_ENC_FORMAT)]),
  format_version: z.literal(ENC_FORMAT_VERSION),
  cipher: z.literal('aes-256-gcm'),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z
      .number()
      .int()
      .min(2 ** 15)
      .max(2 ** 18)
      .refine((n) => (n & (n - 1)) === 0, 'N must be a power of two'),
    r: z.number().int().min(8).max(16),
    p: z.number().int().min(1).max(4),
    salt: b64,
    key_len: z.literal(32)
  }),
  nonce_prefix: b64,
  chunk_bytes: z
    .number()
    .int()
    .min(4096)
    .max(16 * 1024 * 1024)
}).refine((h) => h.kdf.N * h.kdf.r <= 2 ** 21, 'KDF parameters too large')
export type EncHeader = z.infer<typeof EncHeaderSchema>

export interface KdfParams {
  N: number
  r: number
  p: number
}

export function checkPassphrase(pass: string): void {
  if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new BackupCryptoError('format', tr(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`, `口令至少 ${MIN_PASSPHRASE} 个字符。`))
  if (pass.length > MAX_PASSPHRASE) throw new BackupCryptoError('format', tr('Passphrase is too long.', '口令过长。'))
}

export function deriveKey(pass: string, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(pass.normalize('NFC'), 'utf8'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function nonce(prefix: Buffer, index: number, final: boolean): Buffer {
  return Buffer.concat([prefix, u32(index), Buffer.from([final ? 1 : 0])])
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
}

function readExact(fd: number, pos: number, len: number): Buffer | null {
  const buf = Buffer.alloc(len)
  let off = 0
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off)
    if (n === 0) break
    off += n
  }
  return off === len ? buf : off === 0 ? null : buf.subarray(0, off)
}

/** Streaming AES-256-GCM writer (chunked). Call `write()` any number of times, then `finish()` once. */
export class EncryptWriter {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private index = 0
  private done = false
  readonly headerBytes: Buffer

  private constructor(
    private readonly fd: number,
    private readonly key: Buffer,
    private readonly prefix: Buffer,
    private readonly chunkBytes: number,
    header: EncHeader
  ) {
    const json = Buffer.from(JSON.stringify(header), 'utf8')
    this.headerBytes = Buffer.concat([ENC_MAGIC, u32(json.length), json])
    writeAll(fd, this.headerBytes)
  }

  static async open(fd: number, pass: string, opts: { kdf?: KdfParams; chunkBytes?: number } = {}): Promise<EncryptWriter> {
    checkPassphrase(pass)
    const kdf = opts.kdf ?? KDF_DEFAULT
    const salt = randomBytes(16)
    const prefix = randomBytes(7)
    const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES
    const header: EncHeader = EncHeaderSchema.parse({
      format: ENC_FORMAT,
      format_version: ENC_FORMAT_VERSION,
      cipher: 'aes-256-gcm',
      kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64'), key_len: 32 },
      nonce_prefix: prefix.toString('base64'),
      chunk_bytes: chunkBytes
    })
    const key = await deriveKey(pass, salt, kdf)
    return new EncryptWriter(fd, key, prefix, chunkBytes, header)
  }

  private emit(plain: Buffer, final: boolean): void {
    const c = createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index, final))
    c.setAAD(Buffer.concat([this.headerBytes, u32(this.index), u32(plain.length)]))
    const ct = Buffer.concat([c.update(plain), c.final()])
    writeAll(this.fd, Buffer.concat([u32(plain.length), ct, c.getAuthTag()]))
    this.index++
    if (this.index > 0xffffffff) throw new BackupCryptoError('format', tr('Backup is too large.', '备份过大。'))
  }

  write(data: Buffer): void {
    if (this.done) throw new Error('writer finished')
    if (!data.length) return
    this.pending.push(data)
    this.pendingBytes += data.length
    // Keep at least one byte pending so the final chunk is never empty unless the whole stream is.
    while (this.pendingBytes > this.chunkBytes) {
      const all = Buffer.concat(this.pending)
      this.emit(all.subarray(0, this.chunkBytes), false)
      const rest = all.subarray(this.chunkBytes)
      this.pending = [rest]
      this.pendingBytes = rest.length
    }
  }

  finish(): void {
    if (this.done) return
    this.emit(Buffer.concat(this.pending), true)
    this.pending = []
    this.pendingBytes = 0
    this.done = true
    this.key.fill(0)
  }
}

/** Read + validate the header of an encrypted archive. Throws `format` on anything unexpected. */
export function readEncHeader(fd: number): { header: EncHeader; headerBytes: Buffer } {
  const head = readExact(fd, 0, ENC_MAGIC.length + 4)
  if (!head || head.length < ENC_MAGIC.length + 4 || !head.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) {
    throw new BackupCryptoError('format', tr('Not a Navalia encrypted backup file.', '不是 Navalia 加密备份文件。'))
  }
  const len = head.readUInt32BE(ENC_MAGIC.length)
  if (len < 2 || len > MAX_HEADER_BYTES) throw new BackupCryptoError('format', tr('Invalid encrypted backup header.', '加密备份文件头不合法。'))
  const json = readExact(fd, head.length, len)
  if (!json || json.length !== len) throw new BackupCryptoError('truncated', tr('Encrypted backup is incomplete (header truncated).', '加密备份文件不完整（文件头被截断）。'))
  let header: EncHeader
  try {
    header = EncHeaderSchema.parse(JSON.parse(json.toString('utf8')))
  } catch {
    throw new BackupCryptoError('format', tr('Invalid encrypted backup header (unsupported format version or KDF parameters).', '加密备份文件头不合法（格式版本或 KDF 参数不受支持）。'))
  }
  const salt = Buffer.from(header.kdf.salt, 'base64')
  const prefix = Buffer.from(header.nonce_prefix, 'base64')
  if (salt.length < 16 || prefix.length !== 7) throw new BackupCryptoError('format', tr('Invalid encrypted backup header.', '加密备份文件头不合法。'))
  return { header, headerBytes: Buffer.concat([head, json]) }
}

/**
 * Decrypt chunk by chunk, handing each VERIFIED plaintext chunk to `onPlain`. Throws
 * `bad_passphrase` when the first chunk fails (wrong passphrase or a tampered header / first chunk),
 * `tampered` for a later chunk, `truncated` when the final chunk is missing, and `format` for
 * trailing bytes after the final chunk.
 */
export async function decryptFile(fd: number, pass: string, onPlain: (chunk: Buffer) => void): Promise<void> {
  checkPassphrase(pass)
  const { header, headerBytes } = readEncHeader(fd)
  const salt = Buffer.from(header.kdf.salt, 'base64')
  const prefix = Buffer.from(header.nonce_prefix, 'base64')
  const key = await deriveKey(pass, salt, header.kdf)
  const size = fs.fstatSync(fd).size
  let pos = headerBytes.length
  let index = 0
  try {
    for (;;) {
      const lenBuf = readExact(fd, pos, 4)
      if (!lenBuf || lenBuf.length < 4) throw new BackupCryptoError('truncated', tr('Encrypted backup is incomplete (truncated).', '加密备份文件不完整（被截断）。'))
      const len = lenBuf.readUInt32BE(0)
      if (len > header.chunk_bytes) throw new BackupCryptoError(index === 0 ? 'bad_passphrase' : 'tampered', tr('Invalid encrypted chunk length (file was tampered with).', '加密备份数据块长度不合法（文件被篡改）。'))
      const body = readExact(fd, pos + 4, len + TAG_BYTES)
      if (!body || body.length < len + TAG_BYTES) throw new BackupCryptoError('truncated', tr('Encrypted backup is incomplete (truncated).', '加密备份文件不完整（被截断）。'))
      const end = pos + 4 + len + TAG_BYTES
      const isLast = end === size
      // Try the flag the position implies; a chunk sealed as final but followed by bytes fails below.
      let plain: Buffer | null = null
      for (const final of isLast ? [true] : [false, true]) {
        try {
          const d = createDecipheriv('aes-256-gcm', key, nonce(prefix, index, final))
          d.setAAD(Buffer.concat([headerBytes, u32(index), u32(len)]))
          d.setAuthTag(body.subarray(len))
          plain = Buffer.concat([d.update(body.subarray(0, len)), d.final()])
          if (final && !isLast) throw new BackupCryptoError('format', tr('Encrypted backup has extra data after the final chunk (file was tampered with).', '加密备份在结束块之后还有多余数据（文件被篡改）。'))
          break
        } catch (e) {
          if (e instanceof BackupCryptoError) throw e
          plain = null
        }
      }
      if (!plain) {
        if (index === 0) throw new BackupCryptoError('bad_passphrase', tr('Wrong passphrase, or the backup file is damaged or tampered with. Nothing was restored.', '口令错误，或备份文件已损坏 / 被篡改。没有恢复任何内容。'))
        if (isLast) throw new BackupCryptoError('truncated', tr('Encrypted backup is incomplete (final chunk missing) or tampered with. Nothing was restored.', '加密备份文件不完整（缺少结束块）或被篡改。没有恢复任何内容。'))
        throw new BackupCryptoError('tampered', tr(`Encrypted chunk ${index + 1} failed verification (file was tampered with). Nothing was restored.`, `加密备份第 ${index + 1} 个数据块校验失败（文件被篡改）。没有恢复任何内容。`))
      }
      onPlain(plain)
      pos = end
      index++
      if (isLast) return
    }
  } finally {
    key.fill(0)
  }
}

// ---- plaintext container ---------------------------------------------------------------------

/** Serialises files into the container, feeding an `EncryptWriter`. */
export class ContainerWriter {
  constructor(private readonly out: { write(b: Buffer): void }) {
    out.write(TAR_MAGIC)
  }

  /** Stream one regular file (already validated by the caller) in 1 MiB slices. */
  addFile(rel: string, file: string, expectedBytes: number): void {
    const name = Buffer.from(rel, 'utf8')
    if (!name.length || name.length > 0xffff) throw new Error('bad path')
    const size = Buffer.alloc(8)
    size.writeUInt32BE(Math.floor(expectedBytes / 2 ** 32), 0)
    size.writeUInt32BE(expectedBytes >>> 0, 4)
    const len = Buffer.alloc(2)
    len.writeUInt16BE(name.length)
    this.out.write(Buffer.concat([len, name, size]))
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const buf = Buffer.alloc(1024 * 1024)
      let total = 0
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, total)
        if (n === 0) break
        total += n
        if (total > expectedBytes) throw new Error(`file grew while archiving: ${rel}`)
        this.out.write(Buffer.from(buf.subarray(0, n)))
      }
      if (total !== expectedBytes) throw new Error(`file changed while archiving: ${rel}`)
    } finally {
      fs.closeSync(fd)
    }
  }

  end(): void {
    this.out.write(Buffer.from([0, 0]))
  }
}

export interface ContainerSink {
  /** Called once per entry header; return false to reject (abort). */
  begin(rel: string, size: number): void
  data(chunk: Buffer): void
  end(): void
}

/** Incremental parser of the plaintext container (push decrypted chunks into `push`). */
export class ContainerReader {
  private buf: Buffer = Buffer.alloc(0)
  private state: 'magic' | 'head' | 'body' | 'done' = 'magic'
  private remaining = 0

  constructor(private readonly sink: ContainerSink) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.state === 'done') {
        if (this.buf.length) throw new BackupCryptoError('format', tr('Extra data after the end of the backup container.', '备份容器结束后还有多余数据。'))
        return
      }
      if (this.state === 'magic') {
        if (this.buf.length < TAR_MAGIC.length) return
        if (!this.buf.subarray(0, TAR_MAGIC.length).equals(TAR_MAGIC)) throw new BackupCryptoError('format', tr('Malformed backup container.', '备份容器格式不正确。'))
        this.buf = this.buf.subarray(TAR_MAGIC.length)
        this.state = 'head'
        continue
      }
      if (this.state === 'head') {
        if (this.buf.length < 2) return
        const n = this.buf.readUInt16BE(0)
        if (n === 0) {
          this.buf = this.buf.subarray(2)
          this.state = 'done'
          continue
        }
        if (this.buf.length < 2 + n + 8) return
        const rel = this.buf.subarray(2, 2 + n).toString('utf8')
        const size = this.buf.readUInt32BE(2 + n) * 2 ** 32 + this.buf.readUInt32BE(2 + n + 4)
        this.buf = this.buf.subarray(2 + n + 8)
        this.sink.begin(rel, size)
        this.remaining = size
        this.state = 'body'
        if (size === 0) {
          this.sink.end()
          this.state = 'head'
        }
        continue
      }
      // body
      if (!this.buf.length) return
      const take = Math.min(this.remaining, this.buf.length)
      this.sink.data(this.buf.subarray(0, take))
      this.buf = this.buf.subarray(take)
      this.remaining -= take
      if (this.remaining === 0) {
        this.sink.end()
        this.state = 'head'
      }
    }
  }

  finish(): void {
    if (this.state !== 'done') throw new BackupCryptoError('truncated', tr('Backup container is incomplete.', '备份容器不完整。'))
  }
}
