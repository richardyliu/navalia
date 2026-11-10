import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretBox } from '../../src/main/identity/secret-box'

/** Test-only backend: AES-256-GCM with a per-instance random key held in memory. */
export function createTestBox(options: { id?: string; available?: boolean; key?: Buffer } = {}): SecretBox & { key: Buffer } {
  const key = options.key ?? randomBytes(32)
  let available = options.available ?? true
  return {
    id: options.id ?? 'test-aes-gcm',
    key,
    isAvailable: () => available,
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt(ciphertext) {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12))
      decipher.setAuthTag(ciphertext.subarray(12, 28))
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()])
    },
    // exposed for tests that flip availability
    ...{ setAvailable: (v: boolean) => (available = v) }
  }
}

export function tempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lens-${label}-`))
}

export function mode(file: string): string {
  return (fs.statSync(file).mode & 0o777).toString(8)
}
