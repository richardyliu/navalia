// S1-FULL C16: find the commit hash a transcript SHOWS after a `git commit` tool call.
//
// git prints `[<branch> <short-hash>] <subject>` (or `[<branch> (root-commit) <hash>]`) on success.
// The HET adapters store only the event's file + line, so this reads the same transcript read-only,
// from that line through the next LOOKAHEAD_LINES lines, and returns the first such hash. No hash
// shown ⇒ null (never guessed). Only files under the agent transcript roots are opened; symlinks are
// refused (O_NOFOLLOW); oversized files are skipped.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export const LOOKAHEAD_LINES = 40
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const MAX_LINE_CHARS = 2_000_000

/** `[main 1a2b3c4]`, `[feat/x (root-commit) 1a2b3c4d]`. Branch names cannot contain spaces / `]`. */
export const COMMIT_OUTPUT_RE = /\[[^\]\s"\\]{1,200}(?: \(root-commit\))? ([0-9a-f]{7,40})\]/

const GIT_COMMIT_CALL_RE = /\bgit\s+(-C\s+\S+\s+)?commit\b/

export function hashFromText(text: string): string | null {
  const m = COMMIT_OUTPUT_RE.exec(text)
  return m ? m[1] : null
}

export function underRoots(file: string, roots: string[]): boolean {
  const abs = path.resolve(file)
  return roots.some((r) => {
    const root = path.resolve(r)
    return abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

export async function commitHashAt(file: string, line: number, roots: string[]): Promise<string | null> {
  if (!Number.isInteger(line) || line < 1 || !underRoots(file, roots)) return null
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return null
  } catch {
    fs.closeSync(fd)
    return null
  }
  const stream = fs.createReadStream('', { fd, encoding: 'utf8', autoClose: true })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let n = 0
  try {
    for await (const text of rl) {
      n += 1
      if (n < line) continue
      if (n > line + LOOKAHEAD_LINES) break
      const t = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text
      const h = hashFromText(t)
      if (h) return h
      // A later `git commit` call starts another attempt: its hash must not be attributed to this one.
      if (n > line && GIT_COMMIT_CALL_RE.test(t)) return null
    }
    return null
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}
