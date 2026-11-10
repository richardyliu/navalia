import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface RuntimeLocation {
  root: string
  port: number
  bin: string | null
  rootExists: boolean
  configPath: string
  envPath: string
}

export function resolveRoot(): string {
  const override = process.env.PERSOME_ROOT?.trim()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.persome')
}

/** Read the runtime HTTP port from config.toml without pulling in a TOML parser. */
export function resolvePort(root: string): number {
  try {
    const text = fs.readFileSync(path.join(root, 'config.toml'), 'utf8')
    let inMcp = false
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[')) {
        inMcp = trimmed === '[mcp]'
        continue
      }
      if (!inMcp) continue
      const match = trimmed.match(/^port\s*=\s*(\d{2,5})\b/)
      if (match) {
        const port = Number(match[1])
        if (port > 0 && port < 65536) return port
      }
    }
  } catch {
    // missing or unreadable config: fall through to the runtime default
  }
  return 8742
}

const BIN_CANDIDATES = [
  path.join(os.homedir(), '.local/bin/persome'),
  '/opt/homebrew/bin/persome',
  '/usr/local/bin/persome'
]

export function findPersomeBinary(): string | null {
  const override = process.env.PERSOME_BIN?.trim()
  if (override) {
    try {
      if (fs.statSync(override).isFile()) return override
    } catch {
      return null
    }
  }
  for (const candidate of BIN_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

export function locate(): RuntimeLocation {
  const root = resolveRoot()
  let rootExists = false
  try {
    rootExists = fs.statSync(root).isDirectory()
  } catch {
    rootExists = false
  }
  return {
    root,
    port: resolvePort(root),
    bin: findPersomeBinary(),
    rootExists,
    configPath: path.join(root, 'config.toml'),
    envPath: path.join(root, 'env')
  }
}
