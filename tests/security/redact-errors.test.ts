// S2-SEC L4: error messages that reach the renderer never carry `/Users/<name>/…`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toLensError as libraryError } from '../../src/main/library/ipc'
import { toLensError as peersError } from '../../src/main/peers/ipc'
import { createPeerStore } from '../../src/main/peers/store'
import { createSubscription } from '../../src/main/peers/subscription'
import { toLensError as workflowsError } from '../../src/main/workflows/ipc'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lens-sec-${p}-`))
  roots.push(d)
  return d
}

const RAW = "ENOENT: no such file or directory, open '/Users/alice/Library/Application Support/Navalia/workflows/x.json'"

describe('toLensError redacts home paths (S2-SEC L4)', () => {
  for (const [name, fn] of [
    ['peers', peersError],
    ['workflows', workflowsError],
    ['library', libraryError]
  ] as const) {
    it(name, () => {
      const e = fn(new Error(RAW))
      expect(e.message).not.toContain('/Users/alice')
      expect(e.message).toContain('/Users/[user]/Library/Application Support')
      expect(fn('plain /Users/bob/secret.txt').message).not.toContain('bob')
    })
  }
})

describe('subscription per-file detail is redacted (S2-SEC L4)', () => {
  it('an unexpected skill import error does not leak the absolute path', async () => {
    const storeRoot = tmp('store')
    const folder = tmp('folder')
    const sub = createSubscription({
      storeRoot,
      peers: createPeerStore({ storeRoot }),
      skills: () => ({
        importSkill: async () => {
          throw new Error(RAW)
        }
      }),
      now: () => new Date('2026-11-05T00:00:00Z')
    })
    sub.setFolder(folder)
    fs.writeFileSync(path.join(folder, 'x.navaliaskill'), '{"not":"a skill"}')
    const r = await sub.refresh()
    expect(r.files[0]).toMatchObject({ outcome: 'skipped', reason: 'unreadable' })
    expect(r.files[0].detail).not.toContain('/Users/alice')
    expect(r.files[0].detail).toContain('/Users/[user]')
  })
})
