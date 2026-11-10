import fs from 'node:fs'
import path from 'node:path'
import { writeFileSecure } from '../store/paths'
import { CONSENT_KINDS, CONSENT_TEXT, CONSENT_TEXT_VERSION, type ConsentKind, type ConsentView } from './api'
import { tr } from '../../shared/i18n'

/**
 * C19 per-connector consent: `<LensStore>/connectors/consent.json` (0600, dir 0700).
 *
 * One record per kind with what it reads / where it writes (copied from the consent text at the
 * time of granting, so the file documents what was agreed), `granted_at`, `revoked_at` and the text
 * version. A grant for an older text version does not count. The service checks consent before every
 * preview and again before every commit, so revoking consent blocks further imports immediately.
 * Granting itself happens only through the IPC handler after a main-process native confirm.
 */

interface ConsentRecord {
  kind: ConsentKind
  granted: boolean
  granted_at: string | null
  revoked_at: string | null
  text_version: number
  reads: string[]
  writes: string[]
}

interface ConsentFile {
  version: 1
  records: Partial<Record<ConsentKind, ConsentRecord>>
}

export class ConsentRequiredError extends Error {
  constructor(readonly kind: ConsentKind) {
    super(tr(`Agree to the "${CONSENT_TEXT[kind].title}" connector terms before reading or importing.`, `需要先同意「${CONSENT_TEXT[kind].title}」连接器的说明，才能读取或导入。`))
    this.name = 'ConsentRequiredError'
  }
}

export function createConsentStore(root: string, now: () => number = Date.now) {
  const file = path.join(root, 'consent.json')

  const read = (): ConsentFile => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as ConsentFile
      if (v && v.version === 1 && v.records && typeof v.records === 'object' && !Array.isArray(v.records)) return v
    } catch {
      /* missing / corrupt → nothing granted (fail closed) */
    }
    return { version: 1, records: {} }
  }

  const recordOf = (f: ConsentFile, kind: ConsentKind): ConsentRecord | null => {
    // Own-property lookup only: a hand-edited file cannot grant through the prototype.
    if (!Object.prototype.hasOwnProperty.call(f.records, kind)) return null
    const r = f.records[kind]
    return r && typeof r === 'object' ? r : null
  }

  const isGranted = (r: ConsentRecord | null): boolean => !!r && r.granted === true && r.text_version === CONSENT_TEXT_VERSION && typeof r.granted_at === 'string'

  const view = (f: ConsentFile, kind: ConsentKind): ConsentView => {
    const r = recordOf(f, kind)
    return {
      kind,
      text: CONSENT_TEXT[kind],
      granted: isGranted(r),
      grantedAt: isGranted(r) ? (r?.granted_at ?? null) : null,
      revokedAt: typeof r?.revoked_at === 'string' ? r.revoked_at : null
    }
  }

  return {
    path: file,
    list: (): ConsentView[] => {
      const f = read()
      return CONSENT_KINDS.map((k) => view(f, k))
    },
    get: (kind: ConsentKind): ConsentView => view(read(), kind),
    isGranted: (kind: ConsentKind): boolean => isGranted(recordOf(read(), kind)),
    /** Throws ConsentRequiredError unless the kind is granted for the current text version. */
    require(kind: ConsentKind): void {
      if (!isGranted(recordOf(read(), kind))) throw new ConsentRequiredError(kind)
    },
    /** Record a grant. Call only after the main-process native confirm. */
    grant(kind: ConsentKind): ConsentView {
      const f = read()
      const t = CONSENT_TEXT[kind]
      f.records[kind] = {
        kind,
        granted: true,
        granted_at: new Date(now()).toISOString(),
        revoked_at: null,
        text_version: CONSENT_TEXT_VERSION,
        reads: t.reads,
        writes: t.writes
      }
      writeFileSecure(file, `${JSON.stringify(f, null, 2)}\n`)
      return view(f, kind)
    },
    revoke(kind: ConsentKind): ConsentView {
      const f = read()
      const prev = recordOf(f, kind)
      const t = CONSENT_TEXT[kind]
      f.records[kind] = {
        kind,
        granted: false,
        granted_at: prev?.granted_at ?? null,
        revoked_at: new Date(now()).toISOString(),
        text_version: CONSENT_TEXT_VERSION,
        reads: t.reads,
        writes: t.writes
      }
      writeFileSecure(file, `${JSON.stringify(f, null, 2)}\n`)
      return view(f, kind)
    }
  }
}
