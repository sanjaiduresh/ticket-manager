import type { QueryClient } from '@tanstack/react-query'
import type { Profile } from './types'

// Never persist tenant data or carry previous-query data into another workspace.
export const deskQueryOptions = { staleTime: 15_000, gcTime: 0, retry: false, refetchOnWindowFocus: true } as const
export const profileKey = (id: string | undefined) => [`live:${id}`, 'profile'] as const
export const workspaceScope = (mode: 'live' | 'demo', profile: Profile) => `${mode}:${profile.company_id}:${profile.id}:${profile.role}`

export function discardOtherWorkspaces(cache: QueryClient, scope: string | undefined, userId: string | undefined) {
  const filters = { predicate: (query: { queryKey: readonly unknown[] }) => {
    const key = query.queryKey[0]
    return typeof key === 'string' && /^(live|demo):/.test(key) && key !== scope && key !== profileKey(userId)[0]
  } }
  // Cancel before removal; never await and later delete a newly active scope.
  void cache.cancelQueries(filters)
  cache.removeQueries(filters)
}