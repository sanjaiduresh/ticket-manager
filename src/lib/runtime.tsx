import { createContext, useContext } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { DataApi, Dataset, Profile } from './types'

export interface Runtime { api: DataApi; profile: Profile; demo: boolean; scope: string; data: Dataset; logout(): Promise<void> }
export const RuntimeContext = createContext<Runtime | null>(null)
export function useDesk() {
  const context = useContext(RuntimeContext)
  if (!context) throw new Error('Service desk context unavailable')
  return context
}
export function useAction<T>(action: (input: T) => Promise<unknown>, message: string, done?: () => void) {
  const { scope } = useDesk()
  const cache = useQueryClient()
  return useMutation({ mutationFn: action, retry: false, gcTime: 0, onSuccess: async () => {
    await cache.invalidateQueries({ queryKey: [scope] })
    toast.success(message)
    done?.()
  } })
}