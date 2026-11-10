import fs from 'node:fs'
import path from 'node:path'
import type { SecretBox } from '../../identity/secret-box'
import { writeFileSecure } from '../../store/paths'
import type { ImapConfigView } from '../api'
import { tr } from '../../../shared/i18n'

/**
 * C19 IMAP settings at rest: `<LensStore>/connectors/imap.secret.json` (0600) holding ONLY a
 * SecretBox ciphertext (production: Electron safeStorage / macOS Keychain) of
 * `{host, port, user, password, mailbox}`. Nothing is stored in plaintext; when the box is
 * unavailable nothing can be saved. The password never leaves main: `view()` returns host, port,
 * a masked user and the mailbox only.
 */

export interface ImapCredentials {
  host: string
  port: number
  user: string
  password: string
  mailbox: string
}

interface SealedFile {
  version: 1
  box: string
  ciphertext: string
}

export function maskUser(user: string): string {
  const at = user.lastIndexOf('@')
  const name = at > 0 ? user.slice(0, at) : user
  const domain = at > 0 ? user.slice(at) : ''
  const keep = name.length <= 2 ? 1 : 2
  return `${name.slice(0, keep)}***${domain}`
}

export function createImapCredentialStore(root: string, box: SecretBox | null) {
  const file = path.join(root, 'imap.secret.json')

  const load = (): ImapCredentials | null => {
    let sealed: SealedFile
    try {
      sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as SealedFile
    } catch {
      return null
    }
    if (!box || !box.isAvailable()) throw new Error(tr('System encrypted storage (Keychain) is unavailable, so the IMAP settings cannot be read.', '系统加密存储（钥匙串）不可用，无法读取 IMAP 设置。'))
    if (sealed?.version !== 1 || sealed.box !== box.id || typeof sealed.ciphertext !== 'string') throw new Error(tr('The IMAP settings file has the wrong format or another encryption method. Enter the settings again.', 'IMAP 设置文件格式不对或来自另一种加密方式，请重新填写。'))
    let v: ImapCredentials
    try {
      v = JSON.parse(box.decrypt(Buffer.from(sealed.ciphertext, 'base64')).toString('utf8')) as ImapCredentials
    } catch {
      throw new Error(tr('Cannot decrypt the IMAP settings. Enter them again.', '无法解密 IMAP 设置，请重新填写。'))
    }
    if (!v || typeof v.host !== 'string' || typeof v.user !== 'string' || typeof v.password !== 'string' || typeof v.mailbox !== 'string' || !Number.isInteger(v.port)) {
      throw new Error(tr('The IMAP settings are incomplete. Enter them again.', 'IMAP 设置不完整，请重新填写。'))
    }
    return v
  }

  return {
    path: file,
    load,
    save(c: ImapCredentials): void {
      if (!box || !box.isAvailable()) throw new Error(tr('System encrypted storage (Keychain) is unavailable: Navalia never saves a mail password in plaintext.', '系统加密存储（钥匙串）不可用：Navalia 不会以明文保存邮箱密码。'))
      const ciphertext = box.encrypt(Buffer.from(JSON.stringify(c), 'utf8')).toString('base64')
      writeFileSecure(file, `${JSON.stringify({ version: 1, box: box.id, ciphertext } satisfies SealedFile)}\n`)
    },
    clear(): void {
      fs.rmSync(file, { force: true })
    },
    view(): ImapConfigView {
      const encryptionAvailable = !!box && box.isAvailable()
      const empty: ImapConfigView = { configured: false, encryptionAvailable, host: null, port: null, userMasked: null, mailbox: null, hasPassword: false }
      if (!fs.existsSync(file)) return empty
      try {
        const c = load()
        if (!c) return empty
        return { configured: true, encryptionAvailable, host: c.host, port: c.port, userMasked: maskUser(c.user), mailbox: c.mailbox, hasPassword: c.password.length > 0 }
      } catch {
        return empty
      }
    }
  }
}
