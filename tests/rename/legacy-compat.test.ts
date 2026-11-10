// Renames (Persome Lens → Grapple → Navalia): files and configs written by an older app must keep working.
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager, ENTRY_NAME, LEGACY_ENTRY_NAME } from '../../src/main/broker/agents'
import { createGrantStore } from '../../src/main/identity/grants'
import { verifyCardText, latestCard } from '../../src/main/identity/card'
import { canonicalJson, evaluateTrust, LEGACY_SIG_DOMAIN, PREV_SIG_DOMAIN, SIG_DOMAIN } from '../../src/main/backup/signature'
import { SignedCardSchema } from '../../src/main/identity/card-schema'
import { kindOf as classifyFile } from '../../src/main/peers/subscription'
import { fingerprintOf } from '../../src/main/identity/keys'
import { ensureStore, storePaths } from '../../src/main/store/paths'
import { tempRoot } from '../identity/helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const LEGACY_CARD = fs.readFileSync(path.join(__dirname, '../../cloud/test/fixtures/lens-exported.persomecard'), 'utf8')

describe('cards', () => {
  test('a card signed by Persome Lens (format persome-lens.card) still verifies', () => {
    expect(JSON.parse(LEGACY_CARD).card.format).toBe('persome-lens.card')
    expect(verifyCardText(LEGACY_CARD).valid).toBe(true)
  })

  test('tampering is still caught on a legacy card', () => {
    const doc = JSON.parse(LEGACY_CARD)
    doc.card.format = 'grapple.card' // format is inside the signed payload
    expect(verifyCardText(JSON.stringify(doc)).valid).toBe(false)
  })

  test('a .persomecard left in the store is still found as the latest card', () => {
    const root = tempRoot('store')
    roots.push(root)
    const paths = ensureStore(storePaths(root))
    const id = JSON.parse(LEGACY_CARD).card.card_id
    fs.writeFileSync(path.join(paths.cardsDir, `${id}.persomecard`), LEGACY_CARD)
    expect(latestCard(paths)?.card.card_id).toBe(id)
  })
})

describe('Grapple-era files', () => {
  test('card schema accepts grapple.card; subscription folder recognises .grapplecard / .grappleskill', () => {
    const doc = JSON.parse(LEGACY_CARD)
    doc.card.format = 'grapple.card'
    expect(SignedCardSchema.safeParse(doc).success).toBe(true)
    expect(classifyFile('a.grapplecard')).toBe('card')
    expect(classifyFile('a.grappleskill')).toBe('skill')
    expect(classifyFile('a.navaliacard')).toBe('card')
  })
})

describe('backup signatures', () => {
  function signed(domain: string, format: string) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    const manifest = { format: 'persome-lens.backup', format_version: 4, files: [] }
    const sig = {
      format,
      version: 1,
      alg: 'Ed25519',
      public_key: raw.toString('base64url'),
      fingerprint: fingerprintOf(raw),
      signature: sign(null, Buffer.from(domain + canonicalJson(manifest), 'utf8'), privateKey).toString('base64url')
    }
    return { manifest, bytes: Buffer.from(JSON.stringify(sig)) }
  }

  test('legacy signature (old format + old domain) verifies', () => {
    const { manifest, bytes } = signed(LEGACY_SIG_DOMAIN, 'persome-lens.backup-sig')
    expect(evaluateTrust(undefined, manifest, bytes).mode).toBe('foreign')
  })

  test('new signature verifies; domains are not interchangeable', () => {
    const ok = signed(SIG_DOMAIN, 'navalia.backup-sig')
    expect(evaluateTrust(undefined, ok.manifest, ok.bytes).mode).toBe('foreign')
    const mixed = signed(LEGACY_SIG_DOMAIN, 'navalia.backup-sig')
    expect(evaluateTrust(undefined, mixed.manifest, mixed.bytes).mode).toBe('invalid')
  })

  test('Grapple signature (grapple format + grapple domain) verifies; its domain is not interchangeable', () => {
    const ok = signed(PREV_SIG_DOMAIN, 'grapple.backup-sig')
    expect(evaluateTrust(undefined, ok.manifest, ok.bytes).mode).toBe('foreign')
    const mixed = signed(SIG_DOMAIN, 'grapple.backup-sig')
    expect(evaluateTrust(undefined, mixed.manifest, mixed.bytes).mode).toBe('invalid')
  })
})

describe('MCP entry written by Persome Lens', () => {
  const URL_ = 'http://127.0.0.1:8750/mcp'
  function setup() {
    const home = tempRoot('home')
    const store = tempRoot('store')
    roots.push(home, store)
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }))
    const grants = createGrantStore(ensureStore(storePaths(store)))
    const agents = createAgentManager({ env: { home, applications: home }, grants, brokerUrl: () => URL_ })
    return { home, agents }
  }

  test('Claude Code: legacy key counts as connected; reconnect replaces it; disconnect removes it', () => {
    const { home, agents } = setup()
    const file = path.join(home, '.claude.json')
    agents.connect('claude-code')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    cfg.mcpServers[LEGACY_ENTRY_NAME] = cfg.mcpServers[ENTRY_NAME]
    delete cfg.mcpServers[ENTRY_NAME]
    fs.writeFileSync(file, JSON.stringify(cfg))
    expect(agents.get('claude-code').state).toBe('connected')

    agents.connect('claude-code')
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).sort()).toEqual([ENTRY_NAME, 'other'])

    const again = JSON.parse(fs.readFileSync(file, 'utf8'))
    again.mcpServers[LEGACY_ENTRY_NAME] = again.mcpServers[ENTRY_NAME]
    fs.writeFileSync(file, JSON.stringify(again))
    agents.disconnect('claude-code')
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers)).toEqual(['other'])
  })

  test('Claude Code: a grapple entry counts as connected; reconnect replaces it', () => {
    const { home, agents } = setup()
    const file = path.join(home, '.claude.json')
    agents.connect('claude-code')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    cfg.mcpServers.grapple = cfg.mcpServers[ENTRY_NAME]
    delete cfg.mcpServers[ENTRY_NAME]
    fs.writeFileSync(file, JSON.stringify(cfg))
    expect(agents.get('claude-code').state).toBe('connected')
    agents.connect('claude-code')
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).sort()).toEqual([ENTRY_NAME, 'other'])
  })

  test('Codex: a grapple marker block counts as connected; disconnect removes it', () => {
    const { home, agents } = setup()
    const file = path.join(home, '.codex', 'config.toml')
    fs.writeFileSync(file, 'model = "x"\n')
    agents.connect('codex')
    const toGrapple = (t: string) =>
      t.replace('# >>> navalia (managed by Navalia) >>>', '# >>> grapple (managed by Grapple) >>>').replace('[mcp_servers.navalia]', '[mcp_servers.grapple]').replace('# <<< navalia <<<', '# <<< grapple <<<')
    fs.writeFileSync(file, toGrapple(fs.readFileSync(file, 'utf8')))
    expect(agents.get('codex').state).toBe('connected')
    agents.disconnect('codex')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain('grapple')
    expect(text).toContain('model = "x"')
  })

  test('Codex: legacy marker block counts as connected; reconnect and disconnect leave no legacy block', () => {
    const { home, agents } = setup()
    const file = path.join(home, '.codex', 'config.toml')
    fs.writeFileSync(file, 'model = "x"\n')
    agents.connect('codex')
    const toLegacy = (t: string) =>
      t
        .replace('# >>> navalia (managed by Navalia) >>>', '# >>> persome-lens (managed by Persome Lens) >>>')
        .replace('[mcp_servers.navalia]', '[mcp_servers.persome-lens]')
        .replace('# <<< navalia <<<', '# <<< persome-lens <<<')
    fs.writeFileSync(file, toLegacy(fs.readFileSync(file, 'utf8')))
    expect(agents.get('codex').state).toBe('connected')

    agents.connect('codex')
    let text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain('persome-lens')
    expect(text).toContain('[mcp_servers.navalia]')
    expect(text.startsWith('model = "x"\n')).toBe(true)

    fs.writeFileSync(file, toLegacy(text))
    agents.disconnect('codex')
    text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain('persome-lens')
    expect(text).not.toContain('navalia')
    expect(text).toContain('model = "x"')
  })
})
