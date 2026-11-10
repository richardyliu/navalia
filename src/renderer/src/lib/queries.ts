import { useQuery } from '@tanstack/react-query'
import type {
  BehaviorPatterns,
  BudgetInfo,
  BuildState,
  ModelGraphResponse,
  PermissionsData,
  RuntimeLocationInfo,
  StatusData
} from '../../../shared/types'
import { api } from './api'

export function useDiscover() {
  return useQuery<RuntimeLocationInfo>({
    queryKey: ['discover'],
    queryFn: api.discover,
    staleTime: 15_000
  })
}

export function useStatus() {
  return useQuery<StatusData>({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 2_000
  })
}

export function usePermissions(enabled: boolean) {
  return useQuery<PermissionsData>({
    queryKey: ['permissions'],
    queryFn: api.permissions,
    enabled,
    staleTime: 30_000
  })
}

export function useBudget() {
  return useQuery<BudgetInfo>({
    queryKey: ['budget'],
    queryFn: api.budget,
    refetchInterval: 60_000,
    staleTime: 30_000
  })
}

export function usePatterns() {
  return useQuery<BehaviorPatterns>({
    queryKey: ['patterns'],
    queryFn: api.patterns,
    staleTime: 60_000
  })
}

export function useBuildStatus() {
  return useQuery<BuildState>({
    queryKey: ['build-status'],
    queryFn: api.buildStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1500 : 10_000),
    staleTime: 0
  })
}

export function useGraph(enabled: boolean) {
  return useQuery<ModelGraphResponse>({
    queryKey: ['graph'],
    queryFn: api.graph,
    enabled,
    staleTime: 60_000
  })
}
