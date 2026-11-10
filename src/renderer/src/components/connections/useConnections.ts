import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CLEAR_LOG_CONFIRM, type AccessLogDay, type AccessLogPreview, type AccessLogRow, type AgentId, type ConnectionsOverview } from '../../../../main/broker/api'
import { unwrap } from '../../lib/api'

export function useConnections() {
  return useQuery<ConnectionsOverview>({
    queryKey: ['connections', 'list'],
    queryFn: () => unwrap(window.lens.connections.list()),
    refetchInterval: 10_000
  })
}

export function useAccessLog(includeFailures: boolean) {
  return useQuery<AccessLogRow[]>({
    queryKey: ['connections', 'log', includeFailures],
    queryFn: () => unwrap(window.lens.accessLog.list({ days: 30, includeFailures })),
    refetchInterval: 10_000
  })
}

export function useAccessDaily() {
  return useQuery<AccessLogDay[]>({
    queryKey: ['connections', 'daily'],
    queryFn: () => unwrap(window.lens.accessLog.daily(30)),
    refetchInterval: 10_000
  })
}

/** Fetched only when a row is expanded; previews never travel with the list. */
export function useAccessPreview(id: number) {
  return useQuery<AccessLogPreview | null>({
    queryKey: ['connections', 'preview', id],
    queryFn: () => unwrap(window.lens.accessLog.preview(id)),
    staleTime: Infinity
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['connections'] })
}

export function useAgentAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ action, agent }: { action: 'connect' | 'disconnect' | 'copy'; agent: AgentId }) => {
      if (action === 'connect') return (await unwrap(window.lens.connections.connect(agent))).agent
      if (action === 'disconnect') return unwrap(window.lens.connections.disconnect(agent))
      return unwrap(window.lens.connections.copyManualConfig(agent))
    },
    onSuccess: invalidate
  })
}

export function useGrantAction() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ action, grantId, ttlSeconds }: { action: 'revoke' | 'renew'; grantId: string; ttlSeconds?: number | null }) =>
      action === 'revoke'
        ? unwrap(window.lens.connections.revokeGrant(grantId))
        : unwrap(window.lens.connections.renewGrant(grantId, ttlSeconds ?? null)),
    onSuccess: invalidate
  })
}

export function useClearLog() {
  const invalidate = useInvalidate()
  return useMutation({ mutationFn: () => unwrap(window.lens.accessLog.clear(CLEAR_LOG_CONFIRM)), onSuccess: invalidate })
}
