import { CONSENT_KINDS } from '../../src/main/connectors/api'
import type { ConnectorService } from '../../src/main/connectors/service'

/** C19: test setups that exercise parsing / writing grant every connector's consent up front. */
export function grantAll<T extends ConnectorService>(svc: T): T {
  for (const k of CONSENT_KINDS) svc.consent.grant(k)
  return svc
}
