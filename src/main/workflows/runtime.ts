/**
 * Read-only access to Runtime behavioral memory files (`<root>/memory/skills/skill-*.md`,
 * legacy `<root>/memory/skill-*.md`). Never writes, never follows symlinks, bounded size.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readTextReadOnly } from '../het/adapters/common'
import { parseSkillFile, workflowFromSkillFile } from './parse'
import type { Workflow } from './schema'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 500

export interface RuntimeSkillsResult {
  workflows: Workflow[]
  /** 'ok' | 'missing' (no memory dir) | error message. */
  status: 'ok' | 'missing' | string
}

/** Read one file without following a symlink: O_NOFOLLOW + fstat + capped read (no lstat→read race). */
export function readRegularText(file: string, maxBytes: number): string | null {
  try {
    return readTextReadOnly(file, maxBytes)
  } catch {
    return null
  }
}

/** True only for a real directory (a symlinked directory is not followed). */
function isRealDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

function listSkillFiles(dir: string): string[] {
  if (!isRealDir(dir)) return []
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^skill-.+\.md$/.test(d.name))
      .map((d) => d.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function readRuntimeSkills(runtimeRoot: string): RuntimeSkillsResult {
  const memory = path.join(runtimeRoot, 'memory')
  if (!isRealDir(memory)) return { workflows: [], status: 'missing' }
  try {
    const candidates: Array<{ rel: string; abs: string }> = [
      ...listSkillFiles(path.join(memory, 'skills')).map((n) => ({ rel: `skills/${n}`, abs: path.join(memory, 'skills', n) })),
      ...listSkillFiles(memory).map((n) => ({ rel: n, abs: path.join(memory, n) }))
    ].slice(0, MAX_FILES)
    const byId = new Map<string, Workflow>()
    for (const c of candidates) {
      const text = readRegularText(c.abs, MAX_FILE_BYTES)
      if (text === null) continue
      const wf = workflowFromSkillFile(parseSkillFile(c.rel, text))
      // `skills/` wins over a legacy top-level file with the same stem (it is listed first).
      if (wf && !byId.has(wf.id)) byId.set(wf.id, wf)
    }
    return { workflows: [...byId.values()], status: 'ok' }
  } catch (error) {
    return { workflows: [], status: error instanceof Error ? error.message : String(error) }
  }
}
