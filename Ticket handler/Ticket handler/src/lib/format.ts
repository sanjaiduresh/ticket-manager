import Papa from 'papaparse'
import { z } from 'zod'
import { assigneeIds } from './assignees'
import type { Connection, CustomerInput, Status, Ticket } from './types'

export const statuses: Status[] = ['new', 'assigned', 'in_progress', 'waiting_customer', 'waiting_provider', 'resolved', 'closed']
export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, s => s.toUpperCase())
export const reference = (number: number) => `DSA-${String(number).padStart(4, '0')}`
export const isOpen = (ticket: Pick<Ticket, 'status'>) => !['resolved', 'closed'].includes(ticket.status)
export const overdue = (ticket: Ticket) => isOpen(ticket) && !!ticket.due_at && Date.parse(ticket.due_at) < Date.now()
export function formatDate(value: string | null, time = true) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(new Date(value))
}
// datetime-local fields are explicitly labelled IST, independent of the device timezone.
export function toIstInput(value: string | null) { return value ? new Date(Date.parse(value) + 330 * 60_000).toISOString().slice(0, 16) : '' }
export function fromIstInput(value: string) { return value ? new Date(`${value}:00+05:30`).toISOString() : null }
export const customerSchema = z.object({
  full_name: z.string().trim().min(1, 'Name is required').max(200),
  phone: z.string().trim().min(1, 'Phone is required').max(40),
  address: z.string().trim().min(1, 'Address is required').max(2000),
  area: z.string().trim().min(1, 'Area is required').max(200),
  provider_id: z.enum(['jio', 'airtel', 'bsnl', 'niss']),
  account_number: z.string().trim().min(1, 'Account number is required').max(200),
  network_node: z.string().trim().max(200).default(''),
})
export const passwordSchema = z.string().refine(v => [...v].length >= 12 && new TextEncoder().encode(v).length <= 256, 'Use at least 12 characters and at most 256 bytes.')
export const csvHeaders = ['full_name', 'phone', 'address', 'area', 'provider_id', 'account_number', 'network_node'] as const
export function connectionKey(value: Pick<Connection, 'provider_id' | 'account_number'>) { return `${value.provider_id}:${value.account_number.trim()}` }
export function validateImport(rows: Record<string, string>[], connections: Connection[]) {
  const seen = new Set(connections.map(connectionKey))
  return rows.map((row, index) => {
    const parsed = customerSchema.safeParse(row)
    let error = parsed.success ? '' : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const data = parsed.success ? parsed.data : undefined
    if (data) {
      const key = connectionKey(data)
      if (seen.has(key)) error = 'Duplicate provider/account number (existing or earlier CSV row).'
      seen.add(key)
    }
    return { row: index + 2, data: data as CustomerInput | undefined, error }
  })
}
export function escapeFormula(value: unknown): string {
  const text = String(value ?? '')
  return /^[\s]*[=+\-@\t\r\n]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text
}
export function csvText(rows: Record<string, unknown>[]) {
  return Papa.unparse(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, escapeFormula(value)]))))
}
export function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', csvText(rows)], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Something went wrong. Please try again.'
  if (/schema cache|does not exist|PGRST205|42P01/i.test(message)) return `${message} — Database setup is incomplete. Ask the administrator to check server migrations and your staff profile.`
  return message
}
export function eventText(body: string) {
  try {
    const item = JSON.parse(body)
    if (item.action === 'note') return String(item.text)
    if (item.action === 'created') return 'Ticket created'
    if (item.action === 'updated') return Object.entries(item.changes ?? {}).map(([key, change]) => {
      const v = change as { from: unknown; to: unknown }
      if (key === 'assigned_to') {
        const ids = assigneeIds(v.to as Ticket['assigned_to'])
        return ids.length ? `Assigned to updated (${ids.length} technician${ids.length === 1 ? '' : 's'})` : 'Assigned to removed'
      }
      if (key === 'outage_id') return `${label(key)} ${v.to ? 'updated' : 'removed'}`
      return `${label(key)}: ${String(v.to ?? 'cleared').replaceAll('_', ' ')}`
    }).join(' · ') || 'Ticket updated'
  } catch { /* Old notes may be plain text. */ }
  return body
}