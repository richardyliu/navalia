import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { createKeyManager } from '../../src/main/identity/keys'
import {
  noIdentityMessage,
  SKILL_FORMAT,
  SkillShareError,
  buildChain,
  passesRedactionCheck,
  redactForShare,
  signSkill,
  verifySkillText
} from '../../src/main/skillshare/package'
import { storePaths } from '../../src/main/store/paths'
import { readRuntimeSkills } from '../../src/main/workflows/runtime'
import type { Workflow } from '../../src/main/workflows/schema'
import { createTestBox, tempRoot } from '../identity/helpers'
import { FIXTURE_RUNTIME } from '../workflows/helpers'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function keyManager(init = true) {
  const root = tempRoot('skill-keys')
  roots.push(root)
  const keys = createKeyManager(storePaths(root), createTestBox())
  if (init) keys.ensureIdentity()
  return keys
}

const weekly = (): Workflow => structuredClone(readRuntimeSkills(FIXTURE_RUNTIME).workflows.find((w) => w.id === 'rt-weekly-report')!)
const fixedNow = () => new Date('2026-11-05T10:00:00.000Z')

describe('.navaliaskill sign / verify', () => {
  test('roundtrip: a signed package verifies offline and carries the signer fingerprint and chain', () => {
    const keys = keyManager()
    const signed = signSkill(weekly(), keys, fixedNow)
    const r = verifySkillText(signed.text)
    expect(r.valid).toBe(true)
    if (!r.valid) return
    expect(r.fingerprint).toBe(keys.getPublicIdentity()!.fingerprint)
    expect(r.packageHash).toBe(signed.packageHash)
    expect(r.pkg.payload.format).toBe(SKILL_FORMAT)
    expect(r.pkg.payload.exported_at).toBe('2026-11-05T10:00:00.000Z')
    expect(r.pkg.payload.workflow.id).toBe('rt-weekly-report')
    const chain = r.pkg.payload.provenance_chain
    expect(chain[0]).toMatchObject({ kind: 'observed' })
    expect(chain[chain.length - 1]).toEqual({ kind: 'shared', at: '2026-11-05T10:00:00.000Z', fingerprint: r.fingerprint, from: null })
  })

  test('tamper: one flipped payload byte is rejected as a signature failure', () => {
    const signed = signSkill(weekly(), keyManager(), fixedNow)
    const pkg = JSON.parse(signed.text)
    const title: string = pkg.payload.workflow.title
    pkg.payload.workflow.title = String.fromCharCode(title.charCodeAt(0) ^ 1) + title.slice(1)
    const r = verifySkillText(JSON.stringify(pkg))
    expect(r).toMatchObject({ valid: false, reason: 'signature' })
  })

  test('tamper: a signature from another package by the same key is rejected', () => {
    const keys = keyManager()
    const a = JSON.parse(signSkill(weekly(), keys, fixedNow).text)
    const other = weekly()
    other.goal = 'a different goal'
    const b = JSON.parse(signSkill(other, keys, fixedNow).text)
    a.signature = b.signature
    expect(verifySkillText(JSON.stringify(a))).toMatchObject({ valid: false, reason: 'signature' })
  })

  test('tamper: swapping in another public key (with consistent fingerprints) is rejected', () => {
    const signed = JSON.parse(signSkill(weekly(), keyManager(), fixedNow).text)
    const mallory = keyManager().getPublicIdentity()!
    signed.payload.signer = { alg: 'Ed25519', public_key: mallory.public_key, fingerprint: mallory.fingerprint }
    signed.payload.provenance_chain[signed.payload.provenance_chain.length - 1].fingerprint = mallory.fingerprint
    signed.signature.key_fingerprint = mallory.fingerprint
    expect(verifySkillText(JSON.stringify(signed))).toMatchObject({ valid: false, reason: 'signature' })
  })

  test('tamper: a public key that does not match its declared fingerprint is rejected', () => {
    const signed = JSON.parse(signSkill(weekly(), keyManager(), fixedNow).text)
    signed.payload.signer.public_key = keyManager().getPublicIdentity()!.public_key
    expect(verifySkillText(JSON.stringify(signed))).toMatchObject({ valid: false, reason: 'fingerprint' })
  })

  test('a re-signed package (attacker signs the same content) verifies only under the attacker fingerprint', () => {
    const alice = keyManager()
    const mallory = keyManager()
    const r = verifySkillText(signSkill(weekly(), mallory, fixedNow).text)
    expect(r.valid && r.fingerprint).toBe(mallory.getPublicIdentity()!.fingerprint)
    expect(r.valid && r.fingerprint).not.toBe(alice.getPublicIdentity()!.fingerprint)
  })

  test('unsigned, unknown format, plain workflow JSON, extra fields and garbage are rejected', () => {
    const pkg = JSON.parse(signSkill(weekly(), keyManager(), fixedNow).text)
    const { signature: _sig, ...unsigned } = pkg
    expect(verifySkillText(JSON.stringify(unsigned))).toMatchObject({ valid: false, reason: 'unsigned' })
    expect(verifySkillText(JSON.stringify({ ...pkg, payload: { ...pkg.payload, format: 'something.else' } }))).toMatchObject({ valid: false, reason: 'format' })
    expect(verifySkillText(JSON.stringify({ ...pkg, payload: { ...pkg.payload, format_version: 2 } }))).toMatchObject({ valid: false, reason: 'format' })
    expect(verifySkillText(JSON.stringify({ format: 'navalia.workflow', format_version: 1, exported_at: 'x', workflows: [weekly()] }))).toMatchObject({
      valid: false,
      reason: 'format'
    })
    expect(verifySkillText(JSON.stringify({ ...pkg, payload: { ...pkg.payload, extra: 1 } }))).toMatchObject({ valid: false, reason: 'schema' })
    expect(verifySkillText('not json')).toMatchObject({ valid: false, reason: 'parse' })
    expect(verifySkillText('x'.repeat(2 * 1024 * 1024 + 1))).toMatchObject({ valid: false, reason: 'too_large' })
  })

  test('uninitialised identity: export is refused in Chinese and no key is created', () => {
    const keys = keyManager(false)
    expect(() => signSkill(weekly(), keys, fixedNow)).toThrow(SkillShareError)
    expect(() => signSkill(weekly(), keys, fixedNow)).toThrow(noIdentityMessage())
    expect(keys.getPublicIdentity()).toBeNull()
    expect(() => signSkill(weekly(), undefined, fixedNow)).toThrow(noIdentityMessage())
    try {
      signSkill(weekly(), null, fixedNow)
    } catch (e) {
      expect((e as SkillShareError).code).toBe('no_identity')
    }
  })
})

describe('.navaliaskill redaction before signing', () => {
  test('secrets, emails and local paths are scrubbed with the Broker rules before signing', () => {
    const w = weekly()
    w.goal = 'mail bob@example.com the report'
    w.steps = [{ order: 1, text: 'export API_KEY=abc123secret then open /Users/bob/private/notes.txt' }]
    const signed = signSkill(w, keyManager(), fixedNow)
    expect(signed.text).not.toContain('bob@example.com')
    expect(signed.text).not.toContain('abc123secret')
    expect(signed.text).not.toContain('/Users/bob')
    expect(signed.redacted).toEqual(expect.arrayContaining(['goal', 'steps[0]']))
    const r = verifySkillText(signed.text)
    expect(r.valid && passesRedactionCheck(r.pkg.payload.workflow)).toBe(true)
  })

  test('redactForShare is idempotent and keeps ids, enums and timestamps', () => {
    const once = redactForShare(weekly()).workflow
    const twice = redactForShare(once)
    expect(twice.redacted).toEqual([])
    expect(once.id).toBe('rt-weekly-report')
    expect(once.evidence.map((e) => e.timestamp)).toEqual(weekly().evidence.map((e) => e.timestamp))
  })

  test('buildChain appends to a carried chain on re-share', () => {
    const w = weekly()
    const fpA = 'a'.repeat(64)
    const fpB = 'b'.repeat(64)
    w.provenance = { ...w.provenance, kind: 'shared', chain: [{ kind: 'observed', at: null, fingerprint: null, from: null }, { kind: 'shared', at: 't1', fingerprint: fpA, from: null }] }
    const chain = buildChain(w, fpB, 't2')
    expect(chain.map((c) => [c.kind, c.fingerprint])).toEqual([
      ['observed', null],
      ['shared', fpA],
      ['shared', fpB]
    ])
  })
})
