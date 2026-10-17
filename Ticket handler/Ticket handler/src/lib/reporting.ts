import { formatDate, isOpen, label, reference, statuses } from './format'
import { assigneeIds, assigneeNames } from './assignees'
import type { Dataset, DateRange, PerformanceEmployee, PerformanceReport, Ticket, TicketEvent } from './types'

const day = 86_400_000
export function istDate(value: string | number = Date.now()) {
  return new Date(new Date(value).getTime() + 330 * 60_000).toISOString().slice(0, 10)
}
export function recentRange(days = 30, now = Date.now()): DateRange {
  const to = istDate(now)
  return { from: new Date(Date.parse(to) - (days - 1) * day).toISOString().slice(0, 10), to }
}
export function rangeError({ from, to }: DateRange, required = true): string {
  if (!required && !from && !to) return ''
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  if (!valid(from) || !valid(to)) return 'Enter valid From and To dates.'
  const days = (Date.parse(to) - Date.parse(from)) / day + 1
  if (days < 1) return 'From must be on or before To.'
  if (days > 366) return 'Choose a range of at most 366 days (inclusive).'
  return ''
}
export interface ReportFilters extends DateRange { provider: string; priority: string }
export const emptyReportFilters: ReportFilters = { from: '', to: '', provider: '', priority: '' }
export function ticketProvider(ticket: Ticket, data: Dataset) {
  return data.connections.find(connection => connection.id === ticket.connection_id)?.provider_id ?? 'none'
}
export function filterReportTickets(data: Dataset, filters: ReportFilters) {
  if (rangeError(filters, false)) return []
  return data.tickets.filter(ticket => (!filters.from || istDate(ticket.created_at) >= filters.from) && (!filters.to || istDate(ticket.created_at) <= filters.to)
    && (!filters.provider || ticketProvider(ticket, data) === filters.provider) && (!filters.priority || ticket.priority === filters.priority))
}
export function operationalSeries(data: Dataset, tickets: Ticket[]) {
  const dates = new Map<string, number>()
  tickets.forEach(ticket => { const key = istDate(ticket.created_at); dates.set(key, (dates.get(key) ?? 0) + 1) })
  // Fill gaps between observed dates; all-time workspaces can span years, so use observed days for those.
  const keys = [...dates.keys()].sort()
  if (keys.length && (Date.parse(keys.at(-1)!) - Date.parse(keys[0])) / day < 366) {
    for (let at = Date.parse(keys[0]); at <= Date.parse(keys.at(-1)!); at += day) {
      const key = new Date(at).toISOString().slice(0, 10)
      if (!dates.has(key)) dates.set(key, 0)
    }
  }
  return {
    status: statuses.map(status => ({ name: status === 'resolved' ? 'Awaiting feedback / resolved' : label(status), count: tickets.filter(ticket => ticket.status === status).length })),
    providers: [...data.providers, { id: 'none', name: 'No connection' }].map(provider => ({ name: provider.name, count: tickets.filter(ticket => isOpen(ticket) && ticketProvider(ticket, data) === provider.id).length })),
    trend: [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
  }
}
export function ticketExportRows(data: Dataset, tickets: Ticket[]) {
  return tickets.map(ticket => {
    const connection = data.connections.find(c => c.id === ticket.connection_id)
    const customer = data.customers.find(c => c.id === connection?.customer_id)
    return { reference: reference(ticket.number), title: ticket.title, customer: customer?.full_name, phone: customer?.phone, provider: connection?.provider_id ?? 'No connection', account_number: connection?.account_number, status: ticket.status, priority: ticket.priority, category: ticket.category, assigned_to: assigneeNames(ticket.assigned_to, data.profiles), created_ist: formatDate(ticket.created_at), due_ist: formatDate(ticket.due_at), visit_ist: formatDate(ticket.visit_at), follow_up_ist: formatDate(ticket.follow_up_at), provider_reference: ticket.provider_reference, resolution: ticket.resolution, customer_feedback: ticket.customer_feedback ?? '' }
  })
}
export function performanceExportRows(report: PerformanceReport, employees: PerformanceEmployee[]) {
  return employees.map(employee => ({ from_ist: report.from, to_ist: report.to, snapshot_generated_at: report.generated_at, ...employee }))
}

// Demo only: derive activity from real in-memory audit records, never infer actors from assignment.
export function computeDemoPerformance(data: Dataset, events: TicketEvent[], range: DateRange, now = Date.now()): PerformanceReport {
  const error = rangeError(range)
  if (error) throw new Error(error)
  const employees = data.profiles.map(profile => {
    const assigned = data.tickets.filter(ticket => ticket.company_id === profile.company_id && assigneeIds(ticket.assigned_to).includes(profile.id))
    const created = new Set<string>(), resolved = new Map<string, number>(), closed = new Set<string>(), feedback = new Set<string>()
    for (const event of events) {
      if (event.actor_id !== profile.id || event.company_id !== profile.company_id || istDate(event.created_at) < range.from || istDate(event.created_at) > range.to) continue
      const ticket = data.tickets.find(t => t.id === event.ticket_id && t.company_id === profile.company_id)
      if (!ticket) continue
      try {
        const body = JSON.parse(event.body)
        if (body.action === 'created') created.add(ticket.id)
        if (body.action !== 'updated') continue
        const status = body.changes?.status
        if (status?.to === 'resolved' && status.from !== 'resolved') resolved.set(ticket.id, Math.max(resolved.get(ticket.id) ?? -Infinity, Date.parse(event.created_at)))
        if (status?.to === 'closed' && status.from !== 'closed') closed.add(ticket.id)
        const response = body.changes?.customer_feedback
        if (typeof response?.to === 'string' && response.to.trim() && response.to !== response.from) feedback.add(ticket.id)
      } catch { /* Legacy free-text notes do not establish action history. */ }
    }
    const hours = [...resolved].map(([id, at]) => (at - Date.parse(data.tickets.find(t => t.id === id)!.created_at)) / 3_600_000).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
    const middle = Math.floor(hours.length / 2)
    return { id: profile.id, full_name: profile.full_name, role: profile.role, active: profile.active,
      open_assigned: assigned.filter(isOpen).length,
      overdue_assigned: assigned.filter(t => isOpen(t) && !!t.due_at && Date.parse(t.due_at) < now).length,
      awaiting_feedback_assigned: assigned.filter(t => t.status === 'resolved').length,
      created: created.size, resolved: resolved.size, closed: closed.size, feedback_recorded: feedback.size,
      median_resolution_hours: hours.length ? (hours.length % 2 ? hours[middle] : (hours[middle - 1] + hours[middle]) / 2) : null }
  })
  return { ...range, generated_at: new Date(now).toISOString(), employees }
}