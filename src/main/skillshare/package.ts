/**
 * S1-10 — signed skill share package (`.navaliaskill`).
 *
 * File = { payload, signature }. The signature is Ed25519 over the RFC 8785 canonical bytes of
 * `payload` exactly as it appears in the file, made with the user's existing identity key (the
 * same KeyManager that signs Cards). Trust is self-signed: a valid signature proves integrity
 * and that the embedded key signed it, not who holds that key (DEVIATIONS D3a).
 *
 * No network, no registry. Never creates a key: an uninitialised identity is an error.
 */
import { tr } from '../../shared/i18n'
import { createHash, verify as cryptoVerify } from 'node:crypto'
import { z } from 'zod'
import { canonicalBytes } from '../identity/canonical'
import { fingerprintOf, publicKeyFromRaw, type KeyManager } from '../identity/keys'
import { scrubText } from '../identity/redact'
import { ProvenanceStepSchema, WorkflowSchema, type ProvenanceStep, type Workflow } from '../workflows/schema'

export const SKILL_FORMAT = 'navalia.skill'
export const SKILL_FORMAT_VERSION = 1
export const SKILL_FILE_EXT = '.navaliaskill'
/** Previous name (Grapple); still accepted on import. */
export const PREV_SKILL_FORMAT = 'grapple.skill'
export const PREV_SKILL_FILE_EXT = '.grappleskill'
/** Pre-rename (Persome Lens) names; still accepted on import. */
export const LEGACY_SKILL_FORMAT = 'persome-lens.skill'
export const LEGACY_SKILL_FILE_EXT = '.lensskill'
export const MAX_SKILL_BYTES = 2 * 1024 * 1024
/** Shown next to every signer fingerprint (matches DEVIATIONS D3a). */
export function selfSignedNote(): string {
  return tr('Self-signed: proves integrity and key consistency only, not identity', '自签名：只证明完整性与密钥一致，不证明身份')
}

const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/)

export const SkillSignerSchema = z.strictObject({
  alg: z.literal('Ed25519'),
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  fingerprint: Fingerprint
})

export const SkillPayloadSchema = z.strictObject({
  format: z.union([z.literal(SKILL_FORMAT), z.literal(PREV_SKILL_FORMAT), z.literal(LEGACY_SKILL_FORMAT)]),
  format_version: z.literal(SKILL_FORMAT_VERSION),
  exported_at: z.string().datetime({ offset: true }),
  workflow: WorkflowSchema,
  /** Oldest first; the last hop is always `shared` by `signer`. */
  provenance_chain: z.array(ProvenanceStepSchema).min(1).max(50),
  signer: SkillSignerSchema
})

export const SkillPackageSchema = z.strictObject({
  payload: SkillPayloadSchema,
  signature: z.strictObject({
    alg: z.literal('Ed25519'),
    key_fingerprint: Fingerprint,
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
  })
})
export type SkillPackage = z.infer<typeof SkillPackageSchema>

export type SkillShareErrorCode = 'no_identity' | 'redaction' | 'rejected'

export class SkillShareError extends Error {
  constructor(
    readonly code: SkillShareErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SkillShareError'
  }
}

export function noIdentityMessage(): string {
  return tr(
    'No identity key yet: create one on the Identity page first, then export the .navaliaskill (Navalia will not generate a key for you).',
    '还没有创建身份密钥：请先到「身份」页创建身份，再导出 .navaliaskill（Navalia 不会自动替你生成密钥）。'
  )
}

// ── Redaction (same rules as the Broker / Card scrubber) ────────────────────

export interface RedactionResult {
  workflow: Workflow
  /** Field paths whose text the scrubber changed. */
  redacted: string[]
}

/**
 * Run every free-text field through the Broker/Card scrubber (`identity/redact.ts`). Ids, enum
 * values, numbers and timestamps are not free text and are kept. Over-redaction is accepted.
 */
export function redactForShare(w: Workflow): RedactionResult {
  const redacted: string[] = []
  const s = (field: string, v: string): string => {
    const out = scrubText(v)
    if (out !== v) redacted.push(field)
    return out
  }
  const sn = (field: string, v: string | null): string | null => (v === null ? null : s(field, v))
  const arr = (field: string, list: string[]) => list.map((v, i) => s(`${field}[${i}]`, v))
  const out: Workflow = {
    ...w,
    title: s('title', w.title),
    goal: s('goal', w.goal),
    context: s('context', w.context),
    inputs: arr('inputs', w.inputs),
    tools: arr('tools', w.tools),
    steps: w.steps.map((st, i) => ({ order: st.order, text: s(`steps[${i}]`, st.text) })),
    artifacts: arr('artifacts', w.artifacts),
    rules: arr('rules', w.rules),
    problems: w.problems.map((p, i) => ({ problem: s(`problems[${i}].problem`, p.problem), solution: s(`problems[${i}].solution`, p.solution) })),
    evidence: w.evidence.map((e, i) => ({ ...e, ref: s(`evidence[${i}].ref`, e.ref) })),
    evidence_note: s('evidence_note', w.evidence_note),
    tags: arr('tags', w.tags),
    provenance: {
      ...w.provenance,
      from: sn('provenance.from', w.provenance.from),
      original_id: sn('provenance.original_id', w.provenance.original_id),
      chain: w.provenance.chain.map((c, i) => ({ ...c, from: sn(`provenance.chain[${i}].from`, c.from) })),
      // S1-FULL C15: shared .navaliaskill packages never carry the cloud-extraction session snapshot / cited items.
      ...(w.provenance.extraction
        ? (({ cited_items: _items, session: _session, ...rest }) => ({ extraction: { ...rest, agent: s('provenance.extraction.agent', rest.agent) } }))(w.provenance.extraction)
        : {})
    },
    source: {
      ...w.source,
      path: sn('source.path', w.source.path),
      entry_ids: arr('source.entry_ids', w.source.entry_ids),
      stage: sn('source.stage', w.source.stage),
      confidence: sn('source.confidence', w.source.confidence)
    }
  }
  return { workflow: WorkflowSchema.parse(out), redacted }
}

/** The redaction check: true when the scrubber would change nothing more in `w`. */
export function passesRedactionCheck(w: Workflow): boolean {
  return redactForShare(w).redacted.length === 0
}

// ── Provenance chain ─────────────────────────────────────────────────────────

/** History of `w` as hops (oldest first), ending with this share by `signerFingerprint`. */
export function buildChain(w: Workflow, signerFingerprint: string, exportedAt: string): ProvenanceStep[] {
  const p = w.provenance
  const chain: ProvenanceStep[] = [...p.chain]
  const origin = p.kind === 'user_edited' ? p.original_kind : p.kind
  if (!chain.length) {
    // First share: reconstruct the hops this copy actually went through.
    if (p.observed_at || origin === 'observed') chain.push({ kind: 'observed', at: p.observed_at, fingerprint: null, from: null })
    if (origin === 'imported') chain.push({ kind: 'imported', at: p.imported_at, fingerprint: null, from: p.from })
  }
  if (p.kind === 'user_edited') chain.push({ kind: 'user_edited', at: p.edited_at, fingerprint: null, from: null })
  chain.push({ kind: 'shared', at: exportedAt, fingerprint: signerFingerprint, from: null })
  return chain.slice(-50)
}

// ── Sign / verify ────────────────────────────────────────────────────────────

export function packageHash(rawPayload: unknown): string {
  return createHash('sha256').update(canonicalBytes(rawPayload)).digest('hex')
}

export interface SignedSkill {
  text: string
  pkg: SkillPackage
  packageHash: string
  fingerprint: string
  redacted: string[]
}

/**
 * Redact, then sign one Workflow with the local identity key. Throws SkillShareError
 * `no_identity` when no keypair exists; never calls `ensureIdentity()`.
 */
export function signSkill(w: Workflow, keys: KeyManager | null | undefined, now: () => Date = () => new Date()): SignedSkill {
  const identity = keys?.getPublicIdentity() ?? null
  if (!keys || !identity) throw new SkillShareError('no_identity', noIdentityMessage())
  const { workflow, redacted } = redactForShare(WorkflowSchema.parse(w))
  if (!passesRedactionCheck(workflow)) throw new SkillShareError('redaction', tr('Some content still failed the redaction check after redacting; export rejected', '脱敏后仍有内容未通过脱敏检查，已拒绝导出'))
  const exportedAt = now().toISOString()
  const payload = SkillPayloadSchema.parse({
    format: SKILL_FORMAT,
    format_version: SKILL_FORMAT_VERSION,
    exported_at: exportedAt,
    workflow,
    provenance_chain: buildChain(workflow, identity.fingerprint, exportedAt),
    signer: { alg: 'Ed25519', public_key: identity.public_key, fingerprint: identity.fingerprint }
  })
  const signature = keys.sign(canonicalBytes(payload))
  const pkg = SkillPackageSchema.parse({
    payload,
    signature: { alg: 'Ed25519', key_fingerprint: identity.fingerprint, value: signature.toString('base64url') }
  })
  return { text: `${JSON.stringify(pkg, null, 2)}\n`, pkg, packageHash: packageHash(payload), fingerprint: identity.fingerprint, redacted }
}

export type SkillVerifyFailure = 'too_large' | 'parse' | 'format' | 'unsigned' | 'schema' | 'fingerprint' | 'signature'

export type SkillVerifyResult =
  | { valid: true; pkg: SkillPackage; packageHash: string; fingerprint: string }
  | { valid: false; reason: SkillVerifyFailure; detail: string }

const REASON_TEXT: Record<SkillVerifyFailure, string> = {
  get too_large() {
    return tr('File too large', '文件过大')
  },
  get parse() {
    return tr('Not valid JSON', '不是合法的 JSON')
  },
  get format() {
    return tr('Not a .navaliaskill file (unknown format)', '不是 .navaliaskill 文件（未知格式）')
  },
  get unsigned() {
    return tr('Not signed', '没有签名')
  },
  get schema() {
    return tr('Content does not match the .navaliaskill format', '内容不符合 .navaliaskill 格式')
  },
  get fingerprint() {
    return tr('Public key does not match the fingerprint', '公钥与指纹不一致')
  },
  get signature() {
    return tr('Signature check failed (content was tampered with or the signature is not from this public key)', '签名校验失败（内容被篡改或签名不属于该公钥）')
  }
}

export function rejectionMessage(r: { reason: SkillVerifyFailure; detail: string }): string {
  return tr(`${REASON_TEXT[r.reason]}: ${r.detail}`, `${REASON_TEXT[r.reason]}：${r.detail}`)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Offline verification using only the file. The signature is checked over the canonical form
 * of `payload` exactly as parsed from the file (not a re-serialised schema output).
 */
export function verifySkillText(text: string): SkillVerifyResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) return { valid: false, reason: 'too_large', detail: tr(`Exceeds ${MAX_SKILL_BYTES} bytes`, `超过 ${MAX_SKILL_BYTES} 字节`) }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { valid: false, reason: 'parse', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isObject(input) || !isObject(input.payload) || (input.payload.format !== SKILL_FORMAT && input.payload.format !== PREV_SKILL_FORMAT && input.payload.format !== LEGACY_SKILL_FORMAT)) {
    return { valid: false, reason: 'format', detail: tr(`Expected format = ${SKILL_FORMAT}`, `期望 format = ${SKILL_FORMAT}`) }
  }
  if (input.payload.format_version !== SKILL_FORMAT_VERSION) {
    return { valid: false, reason: 'format', detail: tr(`Unsupported format_version: ${String(input.payload.format_version)}`, `不支持的 format_version：${String(input.payload.format_version)}`) }
  }
  if (input.signature === undefined || input.signature === null) return { valid: false, reason: 'unsigned', detail: tr('Missing signature', '缺少 signature') }
  const parsed = SkillPackageSchema.safeParse(input)
  if (!parsed.success) {
    return { valid: false, reason: 'schema', detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
  }
  const { payload, signature } = parsed.data
  let rawPub: Buffer
  try {
    rawPub = Buffer.from(payload.signer.public_key, 'base64url')
    publicKeyFromRaw(rawPub)
  } catch (error) {
    return { valid: false, reason: 'fingerprint', detail: error instanceof Error ? error.message : String(error) }
  }
  const fingerprint = fingerprintOf(rawPub)
  if (fingerprint !== payload.signer.fingerprint || fingerprint !== signature.key_fingerprint) {
    return { valid: false, reason: 'fingerprint', detail: tr("The signer public key's fingerprint does not match the declared one", '签名者公钥的指纹与声明不符') }
  }
  const last = payload.provenance_chain[payload.provenance_chain.length - 1]
  if (last.kind !== 'shared' || last.fingerprint !== fingerprint) {
    return { valid: false, reason: 'schema', detail: tr("The last provenance_chain hop must be this signer's shared", 'provenance_chain 最后一跳必须是该签名者的 shared') }
  }
  const rawPayload = input.payload
  let ok = false
  try {
    ok = cryptoVerify(null, canonicalBytes(rawPayload), publicKeyFromRaw(rawPub), Buffer.from(signature.value, 'base64url'))
  } catch (error) {
    return { valid: false, reason: 'signature', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!ok) return { valid: false, reason: 'signature', detail: tr('Ed25519 signature mismatch', 'Ed25519 签名不匹配') }
  return { valid: true, pkg: parsed.data, packageHash: packageHash(rawPayload), fingerprint }
}
