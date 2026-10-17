import type { Profile, Ticket } from './types'

// Read legacy scalar/null records and current arrays through one boundary.
// Do not truncate here: writes exceeding the limit must be rejected, not lose staff.
export function assigneeIds(value: Ticket['assigned_to'] | undefined): string[] {
  return [...new Set((Array.isArray(value) ? value : value ? [value] : []).filter(id => typeof id === 'string' && id.length > 0))]
}
export function assigneeName(id: string, profiles: Profile[]): string {
  const profile = profiles.find(p => p.id === id)
  return profile ? `${profile.full_name}${!profile.active ? ' (inactive)' : profile.role !== 'technician' ? ' (no longer technician)' : ''}` : `Former staff (${id})`
}
export function assigneeNames(value: Ticket['assigned_to'], profiles: Profile[]): string {
  return assigneeIds(value).map(id => assigneeName(id, profiles)).join('; ')
}
export function sameAssignees(a: Ticket['assigned_to'], b: Ticket['assigned_to']): boolean {
  const left = assigneeIds(a), right = assigneeIds(b)
  return left.length === right.length && left.every(id => right.includes(id))
}