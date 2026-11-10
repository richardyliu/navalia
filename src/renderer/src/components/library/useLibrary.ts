import { useMutation, useQuery } from '@tanstack/react-query'
import type { HetSummary } from '../../../../main/het/api'
import type { ExportBriefResult, LibraryEntityGraph, LibraryOverview } from '../../../../main/library/api'
import type { BehaviorPatterns, RecentActivityResponse } from '../../../../shared/types'
import { unwrap } from '../../lib/api'

export function useLibraryOverview() {
  return useQuery<LibraryOverview>({
    queryKey: ['library', 'overview'],
    queryFn: () => unwrap(window.lens.library.overview()),
    staleTime: 30_000,
    retry: false
  })
}

export function useEntityGraph(name: string | null) {
  return useQuery<LibraryEntityGraph>({
    queryKey: ['library', 'entity', name],
    queryFn: () => unwrap(window.lens.library.entity(name as string)),
    enabled: Boolean(name),
    staleTime: 60_000,
    retry: false
  })
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The three brief inputs, fetched independently so one failing source does not hide the others. */
export function useBriefSources(timezone: string) {
  const recent = useQuery<RecentActivityResponse>({
    queryKey: ['library', 'brief', 'recent'],
    queryFn: () => unwrap(window.lens.mcp.recent(100)),
    staleTime: 30_000,
    retry: false
  })
  const patterns = useQuery<BehaviorPatterns>({
    queryKey: ['library', 'brief', 'patterns'],
    queryFn: () => unwrap(window.lens.mcp.patterns()),
    staleTime: 60_000,
    retry: false
  })
  const het = useQuery<HetSummary>({
    queryKey: ['library', 'brief', 'het', timezone],
    queryFn: () => unwrap(window.lens.het.summary(7, timezone)),
    staleTime: 30_000,
    retry: false
  })
  return { recent, patterns, het }
}

export function useCopy() {
  return useMutation<boolean, Error, string>({ mutationFn: (text) => unwrap(window.lens.app.copy(text)) })
}

export function useExportBrief() {
  return useMutation<ExportBriefResult, Error, { markdown: string; date: string }>({
    mutationFn: ({ markdown, date }) => unwrap(window.lens.library.exportBrief(markdown, date))
  })
}
