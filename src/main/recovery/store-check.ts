import fs from 'node:fs'
import path from 'node:path'
import { SettingsSchema } from '../store/settings'
import { storePaths } from '../store/paths'
import { tr } from '../../shared/i18n'

/**
 * Read-only Lens Store integrity check. Never creates, chmods, or opens a database: SQLite files
 * are checked by reading their 16-byte header only (O_RDONLY | O_NOFOLLOW).
 */

export interface StoreFinding {
  level: 'warn' | 'fail'
  message: string
}

export interface StoreCheckResult {
  exists: boolean
  findings: StoreFinding[]
  checkedFiles: number
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
const MAX_JSON_BYTES = 8 * 1024 * 1024

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

function readHeader(file: string, n: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const buf = Buffer.alloc(n)
    const read = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

export function checkLensStore(root: string): StoreCheckResult {
  const p = storePaths(root)
  const findings: StoreFinding[] = []
  let checkedFiles = 0
  const rootStat = lstatOrNull(p.root)
  if (!rootStat) return { exists: false, findings: [{ level: 'fail', message: tr('The Navalia Store folder does not exist', 'Navalia Store 目录不存在') }], checkedFiles }
  if (!rootStat.isDirectory()) {
    return { exists: true, findings: [{ level: 'fail', message: tr('The Navalia Store path is not a folder', 'Navalia Store 路径不是目录') }], checkedFiles }
  }
  if ((rootStat.mode & 0o077) !== 0) findings.push({ level: 'warn', message: tr('Navalia Store folder permissions are too open (should be 0700)', 'Navalia Store 目录权限过宽（应为 0700）') })

  const json = (file: string, label: string, validate?: (v: unknown) => boolean): void => {
    const st = lstatOrNull(file)
    if (!st) return
    checkedFiles++
    if (!st.isFile()) {
      findings.push({ level: 'fail', message: tr(`${label} is not a regular file`, `${label} 不是普通文件`) })
      return
    }
    if ((st.mode & 0o077) !== 0) findings.push({ level: 'warn', message: tr(`${label} permissions are too open (should be 0600)`, `${label} 权限过宽（应为 0600）`) })
    if (st.size > MAX_JSON_BYTES) {
      findings.push({ level: 'fail', message: tr(`${label} has an abnormal size (${st.size} bytes)`, `${label} 体积异常（${st.size} 字节）`) })
      return
    }
    let value: unknown
    try {
      value = JSON.parse(readHeader(file, st.size).toString('utf8'))
    } catch {
      findings.push({ level: 'fail', message: tr(`${label} is not valid JSON`, `${label} 不是合法 JSON`) })
      return
    }
    if (validate && !validate(value)) findings.push({ level: 'fail', message: tr(`${label} has an unexpected structure`, `${label} 结构不符合预期`) })
  }

  const sqlite = (file: string, label: string): void => {
    const st = lstatOrNull(file)
    if (!st) return
    checkedFiles++
    if (!st.isFile()) {
      findings.push({ level: 'fail', message: tr(`${label} is not a regular file`, `${label} 不是普通文件`) })
      return
    }
    if ((st.mode & 0o077) !== 0) findings.push({ level: 'warn', message: tr(`${label} permissions are too open (should be 0600)`, `${label} 权限过宽（应为 0600）`) })
    if (st.size === 0) return // created lazily; empty is a valid "not yet initialised" state
    try {
      const head = readHeader(file, SQLITE_MAGIC.length)
      if (!head.equals(SQLITE_MAGIC)) findings.push({ level: 'fail', message: tr(`${label} header is not an SQLite database`, `${label} 文件头不是 SQLite 数据库`) })
    } catch {
      findings.push({ level: 'fail', message: tr(`${label} cannot be read`, `${label} 无法读取`) })
    }
  }

  json(p.settingsFile, 'settings.json', (v) => SettingsSchema.safeParse(v).success)
  json(p.grantsFile, 'grants.json', (v) => typeof v === 'object' && v !== null)
  json(path.join(p.root, 'het-settings.json'), 'het-settings.json', (v) => typeof v === 'object' && v !== null)
  json(p.identityFile, 'identity/identity.json', (v) => typeof v === 'object' && v !== null)
  if (lstatOrNull(p.identityFile) && !lstatOrNull(p.privateKeyFile)) {
    findings.push({ level: 'warn', message: tr('Identity metadata exists but the encrypted private key file is missing (signing cards will not work)', '有身份元数据但缺少加密私钥文件（签名卡片将不可用）') })
  }
  sqlite(p.auditDb, 'audit.db')
  sqlite(p.hetDb, 'het.db')
  return { exists: true, findings, checkedFiles }
}

export interface DiskInfo {
  path: string
  freeBytes: number
  totalBytes: number
}

/** Free space on the filesystem that holds `target` (nearest existing ancestor). */
export function diskFree(target: string, statfs: (p: string) => { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint } = fs.statfsSync): DiskInfo | null {
  let dir = path.resolve(target)
  for (;;) {
    if (lstatOrNull(dir)) break
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  try {
    const s = statfs(dir)
    const bsize = Number(s.bsize)
    return { path: dir, freeBytes: Number(s.bavail) * bsize, totalBytes: Number(s.blocks) * bsize }
  } catch {
    return null
  }
}
