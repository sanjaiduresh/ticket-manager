import { useId } from 'react'
import type { Profile } from '../lib/types'
import { assigneeName } from '../lib/assignees'

export function AssigneeSelector({ profiles, value, history = [], onChange }: { profiles: Profile[]; value: string[]; history?: string[]; onChange(value: string[]): void }) {
  const helpId = useId()
  const ids = [...new Set([...profiles.filter(p => p.active && p.role === 'technician').map(p => p.id), ...history, ...value])]
  return <fieldset className="assignee-selector" aria-describedby={helpId}>
    <legend>Assigned technicians</legend>
    <small id={helpId}>{value.length ? `${value.length} selected` : 'Unassigned'} · Select up to 50 technicians. Clear all to unassign.</small>
    <div className="assignee-options">{ids.map(id => {
      const selected = value.includes(id)
      const profile = profiles.find(p => p.id === id)
      return <label key={id} className="assignee-option"><input type="checkbox" checked={selected} disabled={!selected && (value.length >= 50 || !profile?.active || profile.role !== 'technician')} onChange={event => onChange(event.target.checked ? [...value, id] : value.filter(value => value !== id))}/><span>{assigneeName(id, profiles)}</span></label>
    })}</div>
    {!ids.length && <small>No active technicians available.</small>}
  </fieldset>
}