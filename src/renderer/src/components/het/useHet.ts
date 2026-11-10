import { useEffect, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { tr } from '../../lib/i18n'
import type {
  HetAssessorInfo,
  HetAssessorStatus,
  HetSetSendSummariesResult,
  HetCorrection,
  HetCountFilter,
  HetFilteredTasks,
  HetPeriod,
  HetSummary,
  HetTickStatus,
  HetWeekCounts,
  WeeklyReviewResult
} from '../../../../main/het/api'
import { unwrap } from '../../lib/api'

export type HetRange = 'today' | 'week' | 'month'

/** Local-time [start, end) for the range containing `now`. */
export function rangeBounds(range: HetRange, now = new Date()): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === 'today') return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) }
  if (range === 'week') {
    const offset = (start.getDay() + 6) % 7 // Monday = 0
    const ws = new Date(start.getFullYear(), start.getMonth(), start.getDate() - offset)
    return { start: ws, end: new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7) }
  }
  const ms = new Date(now.getFullYear(), now.getMonth(), 1)
  return { start: ms, end: new Date(ms.getFullYear(), ms.getMonth() + 1, 1) }
}

export function useHetSummary() {
  return useQuery<HetSummary>({
    queryKey: ['het', 'summary'],
    queryFn: () => unwrap(window.lens.het.summary(31)),
    refetchInterval: 60_000
  })
}

/**
 * Tick status. Polls fast while a tick runs (or none has finished yet) and invalidates the
 * HET data queries whenever a new tick completes, so the first startup scan shows up.
 */
export function useHetStatus() {
  const qc = useQueryClient()
  const last = useRef<string | null>(null)
  const q = useQuery<HetTickStatus>({
    queryKey: ['het-status'],
    queryFn: () => unwrap(window.lens.het.status()),
    refetchInterval: (query) => (query.state.data?.running || !query.state.data?.lastTickAt ? 2_000 : 15_000)
  })
  const tickAt = q.data?.lastTickAt ?? null
  useEffect(() => {
    if (tickAt && tickAt !== last.current) {
      last.current = tickAt
      void qc.invalidateQueries({ queryKey: ['het'] })
    }
  }, [tickAt, qc])
  return q
}

export function useHetPeriod(range: HetRange) {
  const { start, end } = rangeBounds(range)
  return useInfiniteQuery<HetPeriod>({
    queryKey: ['het', 'period', range, start.toISOString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(window.lens.het.period(start.toISOString(), end.toISOString(), pageParam as string | null, 100, true)),
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: 60_000
  })
}

/** S1-R3-04: counts for the current ISO week (main computes the week in `timezone`). */
export function useHetWeekCounts(timezone?: string) {
  return useQuery<HetWeekCounts>({
    queryKey: ['het', 'week-counts', timezone ?? null],
    queryFn: () => unwrap(window.lens.het.weekCounts(timezone)),
    refetchInterval: 60_000
  })
}

/** S1-R3-04 click-through list (same window + predicate as the count). */
export function useHetFilteredTasks(p: { filter: HetCountFilter; start: string; end: string; timezone?: string }) {
  return useInfiniteQuery<HetFilteredTasks>({
    queryKey: ['het', 'filtered', p.filter, p.start, p.end, p.timezone ?? null],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => unwrap(window.lens.het.filteredTasks(p.start, p.end, p.filter, pageParam as string | null, 100, p.timezone)),
    getNextPageParam: (last) => last.next_cursor
  })
}

export function useCorrect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { taskId: string; action: HetCorrection }) => unwrap(window.lens.het.correct(v.taskId, v.action)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['het'] })
  })
}

/** OG-08 / D17: undo a correction (minutes re-derived from verdict + anchors). */
export function useRevertCorrection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => unwrap(window.lens.het.revertCorrection(taskId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['het'] })
  })
}

/** OG-08 / HET-08: re-queue failed tasks + one scan (same gate and caps). */
export function useRetryFailed() {
  const qc = useQueryClient()
  return useMutation<{ requeued: number }, Error, void>({
    mutationFn: () => unwrap(window.lens.het.retry()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['het'] })
      void qc.invalidateQueries({ queryKey: ['het-status'] })
    }
  })
}

/** S1-02: persist the assessorEnabled switch, then refresh status + data. */
export function useSetAssessorEnabled() {
  const qc = useQueryClient()
  return useMutation<HetAssessorStatus, Error, boolean>({
    mutationFn: (enabled) => unwrap(window.lens.het.setAssessorEnabled(enabled)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['het-status'] })
      void qc.invalidateQueries({ queryKey: ['het'] })
    }
  })
}

export function useExportWeekly() {
  return useMutation<WeeklyReviewResult, Error, Date>({
    mutationFn: (weekStart) => unwrap(window.lens.het.exportWeekly(weekStart.toISOString()))
  })
}

export function formatHet(tenths: number): string {
  const min = tenths / 10
  if (min < 60) return tr(`${min.toFixed(1)} min`, `${min.toFixed(1)} 分钟`)
  return tr(`${(min / 60).toFixed(1)} h`, `${(min / 60).toFixed(1)} 小时`)
}

/** X3: assessor settings view (state, client / model, Runtime budget, what is sent). */
export function useHetAssessorInfo() {
  return useQuery<HetAssessorInfo>({
    queryKey: ['het-status', 'assessor-info'],
    queryFn: () => unwrap(window.lens.het.assessorInfo()),
    refetchInterval: 30_000
  })
}

/** X3: 「发送摘要给 assessor」. ON goes through a main-owned native confirm; OFF does not. */
export function useSetSendSummaries() {
  const qc = useQueryClient()
  return useMutation<HetSetSendSummariesResult, Error, boolean>({
    mutationFn: (enabled) => unwrap(window.lens.het.setSendSummaries(enabled)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['het-status'] })
  })
}
