import { useState } from 'react'
import { assigneeIds } from '../lib/assignees'
import { Download, Ticket, Clock, CircleCheck, MessageSquare, UserRoundX, AlertCircle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { PageHeader, Empty } from '../components/shared'
import { CountChart, DateFields, ViewToggle } from '../components/reporting'
import { useDesk } from '../lib/runtime'
import { downloadCsv, isOpen, label, overdue } from '../lib/format'
import { emptyReportFilters, filterReportTickets, operationalSeries, rangeError, ticketExportRows } from '../lib/reporting'

export function ReportsPage() {
  const { data } = useDesk()
  const [filters, setFilters] = useState(emptyReportFilters)
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const error = rangeError(filters, false)
  const tickets = filterReportTickets(data, filters)
  const filtered = Object.values(filters).some(Boolean)
  const series = operationalSeries(data, tickets)
  const counts = [
    { text: 'Open tickets', count: tickets.filter(isOpen).length, icon: Ticket, hint: 'Excludes resolved and closed' },
    { text: 'Unassigned', count: tickets.filter(t => isOpen(t) && !assigneeIds(t.assigned_to).length).length, icon: UserRoundX, hint: 'Open, without an assignee' },
    { text: 'Overdue', count: tickets.filter(overdue).length, icon: AlertCircle, hint: 'Open, past the due time' },
    { text: 'Waiting for provider', count: tickets.filter(t => t.status === 'waiting_provider').length, icon: Clock, hint: 'Current provider handoff' },
    { text: 'Awaiting feedback / resolved', count: tickets.filter(t => t.status === 'resolved').length, icon: MessageSquare, hint: 'Resolved, not yet closed' },
    { text: 'Closed', count: tickets.filter(t => t.status === 'closed').length, icon: CircleCheck, hint: 'Closure completed' },
  ]
  return <>
    <PageHeader title="Reports" subtitle="Operational overview · aggregate ticket queues, without individual employee metrics."><Button variant="outline" disabled={!!error || !tickets.length} onClick={() => downloadCsv('dsa-tickets.csv', ticketExportRows(data, tickets))}><Download aria-hidden="true"/>{filtered ? 'Export filtered tickets' : 'Export all tickets'}</Button></PageHeader>
    <section className="panel report-definitions"><h2>A ticket-created cohort, not an activity report</h2><p>Dates select tickets by their <strong>created date in IST</strong>, inclusive. Cards and charts show the current state of those same tickets — not resolutions or work performed during that period. Resolved tickets await customer follow-up and closure, even when feedback is already saved.</p></section>
    <section className="panel report-filters" aria-label="Report filters"><DateFields value={filters} allTime onChange={range => setFilters({ ...filters, ...range })}/>
      <label>Provider<select aria-label="Provider" value={filters.provider} onChange={event => setFilters({ ...filters, provider: event.target.value })}><option value="">All providers</option>{data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}<option value="none">No connection</option></select></label>
      <label>Priority<select aria-label="Priority" value={filters.priority} onChange={event => setFilters({ ...filters, priority: event.target.value })}><option value="">All priorities</option>{['low', 'normal', 'high', 'urgent'].map(priority => <option key={priority} value={priority}>{label(priority)}</option>)}</select></label>
      <Button variant="ghost" onClick={() => setFilters(emptyReportFilters)}>Reset filters</Button>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
    <div className="report-toolbar"><p role="status"><strong>{tickets.length}</strong> tickets · {filters.from && filters.to ? `${filters.from} to ${filters.to} (IST created dates)` : 'All created dates'}</p><ViewToggle view={view} onChange={setView}/></div>
    {!error && <><div className="report-counts">{counts.map(({ text, count, icon: Icon, hint }) => <section className="panel metric" aria-label={text} key={text}><span><Icon size={17} aria-hidden="true"/>{text}</span><strong>{count}</strong><small>{hint}</small></section>)}</div>
      {!tickets.length ? <Empty title="No tickets match">Try another created-date range, provider or priority, or reset filters.</Empty> : <div className="report-chart-grid"><CountChart title="Status distribution" description="Current status of tickets in the selected cohort" rows={series.status} view={view}/><CountChart title="Provider workload" description="Open tickets only · includes unlinked tickets as No connection" rows={series.providers} view={view}/><CountChart title="Tickets-created trend" description="Tickets created by IST day · not employee activity" rows={series.trend} view={view} trend/></div>}
    </>}
    <p className="page-footnote">Exact counts from all loaded accessible records; refreshed with the workspace every 30 seconds. Cross-table data is not a transactionally consistent snapshot. Charts, tables and CSV share filters; exports preserve feedback and escape spreadsheet formulas.</p>
  </>
}