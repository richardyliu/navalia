/**
 * Encryption backend for the identity private key.
 *
 * Production uses Electron safeStorage (macOS Keychain-backed key). Tests inject a
 * different backend. There is deliberately no plaintext backend in src/.
 */
export interface SecretBox {
  /** Stable id stored next to the ciphertext, so a backend mismatch fails loudly. */
  readonly id: string
  isAvailable(): boolean
  encrypt(plaintext: Buffer): Buffer
  decrypt(ciphertext: Buffer): Buffer
}

/** Structural subset of Electron's `safeStorage`, injected so this module never imports electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export const SAFE_STORAGE_BOX_ID = 'electron-safestorage'

/**
 * safeStorage works on strings, so the secret bytes travel as base64 inside it.
 * Must be used after `app.whenReady()`; before that macOS reports unavailable.
 */
export function createSafeStorageBox(safeStorage: SafeStorageLike): SecretBox {
  return {
    id: SAFE_STORAGE_BOX_ID,
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt(plaintext) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage encryption is not available')
      return safeStorage.encryptString(plaintext.toString('base64'))
    },
    decrypt(ciphertext) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage encryption is not available')
      return Buffer.from(safeStorage.decryptString(ciphertext), 'base64')
    }
  }
}
