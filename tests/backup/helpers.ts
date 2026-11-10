import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKeyManager } from '../../src/main/identity/keys'
import { storePaths } from '../../src/main/store/paths'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import type { Workflow, WorkflowEdit } from '../../src/main/workflows/schema'
import { createWorkflowStore } from '../../src/main/workflows/store'
import { createTestBox } from '../identity/helpers'
import { createPeerStore } from '../../src/main/peers/store'
import { friend, text } from '../peers/fixtures'

export const FIXTURE_RUNTIME = path.join(__dirname, '..', 'workflows', 'fixtures', 'runtime')
export const RUNTIME_TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUV0123456789'
export const SCREENSHOT_KEY = 'ab'.repeat(32)

const made: string[] = []
export function tempDir(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lens-backup-${label}-`))
  made.push(d)
  return d
}
export function cleanupAll(): void {
  // Only mkdtemp dirs this helper created directly under tmpdir, with our prefix (never tmpdir itself).
  for (const d of made.splice(0)) {
    if (path.basename(d).startsWith('lens-backup-') && path.dirname(d) === os.tmpdir() && d !== os.tmpdir()) fs.rmSync(d, { recursive: true, force: true })
  }
}

/**
 * TEST DOUBLE of the external `persome` CLI. Records argv + PERSOME_ROOT into the Runtime root
 * and writes a small JSON object to `--out`, like `persome model export --out` (personal-model
 * src/persome/cli.py `model_export`). `fail` exits 3 with a secret-looking stderr.
 */
export function fakePersome(behaviour: 'ok' | 'fail' | 'no-output' | 'leak' = 'ok'): string {
  const dir = tempDir('bin')
  const bin = path.join(dir, 'persome')
  const head = `#!/bin/sh
printf '%s\\n' "$@" > "$PERSOME_ROOT/fake-argv.txt"
printf '%s\\n' "$PERSOME_ROOT" > "$PERSOME_ROOT/fake-root.txt"
out=""; prev=""
for a in "$@"; do if [ "$prev" = "--out" ]; then out="$a"; fi; prev="$a"; done
`
  const body = {
    ok: `printf '{"format":"persome.model_snapshot","nodes":[{"label":"写作"}]}\\n' > "$out"\necho "model snapshot: $out"\n`,
    fail: `echo "model export failed: index locked; key sk-ant-api03-LEAKLEAKLEAK1234567" >&2\nexit 3\n`,
    'no-output': `echo "model snapshot: $out"\n`,
    leak: `printf '{"note":"${RUNTIME_TOKEN}"}\\n' > "$out"\n`
  }[behaviour]
  fs.writeFileSync(bin, head + body)
  fs.chmodSync(bin, 0o755)
  return bin
}

/** A temp Runtime root with an owner-only `env` holding a token and a screenshot key. */
export function runtimeRoot(): string {
  const root = tempDir('runtime')
  fs.writeFileSync(path.join(root, 'env'), `PERSOME_LOCAL_API_TOKEN=${RUNTIME_TOKEN}\nPERSOME_SCREENSHOT_KEY=${SCREENSHOT_KEY}\n`, { mode: 0o600 })
  return root
}

export const observed = (): Workflow => readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!

function editOf(w: Workflow, patch: Partial<WorkflowEdit> = {}): WorkflowEdit {
  const { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags } = w
  return { title, goal, context, inputs, tools, steps, artifacts, rules, problems, tags, ...patch }
}

/**
 * A populated Lens Store: identity (encrypted key), grants, audit.db, het.db, import staging,
 * an edited workflow (v1 + v2), one peer, a card file, settings. Returns handy paths.
 */
export function populatedStore() {
  const root = tempDir('store')
  const paths = storePaths(root)
  const keys = createKeyManager(paths, createTestBox())
  keys.ensureIdentity()
  fs.writeFileSync(paths.grantsFile, JSON.stringify({ grants: [{ agent: 'claude-code', token_hash: 'deadbeef' }] }), { mode: 0o600 })
  fs.writeFileSync(paths.auditDb, 'SQLite format 3\u0000audit', { mode: 0o600 })
  fs.writeFileSync(paths.hetDb, 'SQLite format 3\u0000het', { mode: 0o600 })
  fs.mkdirSync(path.join(root, 'import', 'staging', 'imp-1'), { recursive: true })
  fs.writeFileSync(path.join(root, 'import', 'staging', 'imp-1', 'a.md'), '# transcript copy\n')
  fs.mkdirSync(paths.cardsDir, { recursive: true })
  fs.writeFileSync(path.join(paths.cardsDir, 'card_0123456789abcdef0123456789abcdef.navaliacard'), '{"card":"public"}\n', { mode: 0o600 })
  fs.writeFileSync(paths.settingsFile, '{"version":1,"displayName":"Ryl"}\n', { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'het-settings.json'), '{"assessorEnabled":false}\n', { mode: 0o600 })

  const wf = createWorkflowStore(root)
  const o = observed()
  wf.saveEdit(o.id, 1, editOf(o, { title: '周报（我的版本）', rules: [...o.rules, '17:00 前发出'] }), o)

  const f = friend('backup')
  const peers = createPeerStore({ storeRoot: root })
  const added = peers.importText(text(f.card()))
  if (!added.ok) throw new Error('peer fixture failed')

  return { root, paths, keys, friend: f, workflowId: o.id }
}

/** Every file (relative, POSIX) under `root`, recursively, without following symlinks. */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}
