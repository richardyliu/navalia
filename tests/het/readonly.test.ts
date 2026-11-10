import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Security finding #11: static guarantee that transcript readers never write.
 * Scope: every file in src/main/het/adapters/ plus the incremental source and redactor.
 */
const HET = join(__dirname, '..', '..', 'src', 'main', 'het')
const FILES = [
  ...readdirSync(join(HET, 'adapters')).map((f) => join(HET, 'adapters', f)),
  join(HET, 'sources.ts'),
  join(HET, 'redact.ts')
]

const WRITE_API = new RegExp(
  [
    '\\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|unlink|unlinkSync|rmSync|rmdir|rmdirSync|rename|renameSync',
    '|createWriteStream|truncateSync|ftruncate|ftruncateSync|copyFile|copyFileSync|writeSync|writev|writevSync|chmod|chmodSync',
    '|chown|chownSync|utimes|utimesSync|symlink|symlinkSync|linkSync|cpSync)\\b',
    // generic names only as calls, so string literals like 'pr-link' do not trip the scan
    '|\\b(write|link|rm|cp|truncate)\\s*\\('
  ].join('')
)
const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC|openSync\([^)]*['"][wa+]/

/** Strip comments so prose like "never writes" or "truncated" cannot trip or mask the scan. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('HET transcript readers are read-only', () => {
  test('pattern positive controls', () => {
    expect('fs.writeFileSync(p, x)').toMatch(WRITE_API)
    expect('import { rmSync } from "node:fs"').toMatch(WRITE_API)
    expect('openSync(p, "w")').toMatch(WRITE_FLAGS)
    expect('fs.rm(dir, cb)').toMatch(WRITE_API)
    expect("type === 'pr-link'").not.toMatch(WRITE_API)
    expect('constants.O_RDWR').toMatch(WRITE_FLAGS)
    expect(code('// writeFileSync here\nconst a = 1')).not.toMatch(WRITE_API)
    expect(code('text is truncated to 200')).not.toMatch(WRITE_API)
  })

  test.each(FILES.map((f) => [f.slice(HET.length + 1), f]))('%s has no fs write API or write flag', (_name, file) => {
    const src = code(readFileSync(file, 'utf8'))
    expect(src).not.toMatch(WRITE_API)
    expect(src).not.toMatch(WRITE_FLAGS)
  })

  test('opens use O_RDONLY|O_NOFOLLOW', () => {
    const src = readFileSync(join(HET, 'adapters', 'common.ts'), 'utf8')
    expect(src).toContain('constants.O_RDONLY | constants.O_NOFOLLOW')
    expect(code(src).match(/openSync\(/g)).toHaveLength(1)
  })
})
