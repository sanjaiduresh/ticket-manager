import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Empty, ErrorNotice, Loading, PageHeader } from '../components/shared'
import { CountChart, DateFields, ViewToggle } from '../components/reporting'
import { useDesk } from '../lib/runtime'
import { deskQueryOptions } from '../lib/queries'
import { downloadCsv, formatDate, label } from '../lib/format'
import { performanceExportRows, rangeError, recentRange } from '../lib/reporting'
import type { PerformanceEmployee } from '../lib/types'

// Defense in depth: the query component is never mounted for a non-owner.
export function PerformancePage() {
  const { profile } = useDesk()
  return profile.role === 'owner' ? <OwnerPerformance/> : <Navigate to="/tickets" replace/>
}
function EmployeeTable({ employees }: { employees: PerformanceEmployee[] }) {
  return <div className="table-scroll"><table aria-label="Employee performance"><thead><tr><th scope="col">Employee</th><th scope="col">Role</th><th scope="col">Account</th><th scope="col">Created</th><th scope="col">Resolved</th><th scope="col">Closed</th><th scope="col">Feedback recorded</th><th scope="col">Median elapsed hours</th><th scope="col">Open assigned now</th><th scope="col">Overdue assigned now</th><th scope="col">Awaiting feedback now</th></tr></thead><tbody>{employees.map(employee => <tr key={employee.id}><th scope="row">{employee.full_name}</th><td>{label(employee.role)}</td><td>{employee.active ? 'Active' : 'Inactive'}</td><td>{employee.created}</td><td>{employee.resolved}</td><td>{employee.closed}</td><td>{employee.feedback_recorded}</td><td>{employee.median_resolution_hours === null ? 'No history' : employee.median_resolution_hours.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td><td>{employee.open_assigned}</td><td>{employee.overdue_assigned}</td><td>{employee.awaiting_feedback_assigned}</td></tr>)}</tbody></table></div>
}
function OwnerPerformance() {
  const { api, scope, demo } = useDesk()
  const [applied, setApplied] = useState(() => recentRange())
  const [draft, setDraft] = useState(applied)
  const [error, setError] = useState('')
  const [role, setRole] = useState(''), [activity, setActivity] = useState(''), [search, setSearch] = useState(''), [employeeId, setEmployeeId] = useState('')
  const [view, setView] = useState<'chart' | 'table'>('table')
  const report = useQuery({ ...deskQueryOptions, queryKey: [scope, 'performance', applied.from, applied.to], enabled: !!api.performance,
    queryFn: ({ signal }) => api.performance!(applied, signal) })
  // Gate on query errors before reading cached data, including background 401/403 failures.
  const result = report.isError ? undefined : report.data
  const employees = result?.employees.filter(employee => (!role || employee.role === role) && (!activity || employee.active === (activity === 'active')) && (!employeeId || employee.id === employeeId) && employee.full_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? []
  const dirty = draft.from !== applied.from || draft.to !== applied.to
  return <>
    <PageHeader title="Performance" subtitle="Owner-only employee activity and current assignment context. No scores or rankings."><Button variant="outline" disabled={!result || !employees.length} onClick={() => result && downloadCsv('dsa-performance.csv', performanceExportRows(result, employees))}><Download aria-hidden="true"/>Export performance CSV</Button></PageHeader>
    <section className="panel report-definitions" aria-label="How to read performance"><h2>Read with context, not as a ranking</h2><p>Created, resolved, closed and feedback recorded count <strong>unique tickets acted on by each employee</strong> in the applied IST period, using the audit actor — not the current assignee. Repeat actions on one ticket count once per employee and metric; totals across people may overlap.</p><p><strong>Median elapsed hours</strong> measures ticket creation to the latest qualifying resolution by that actor per ticket in the period. It includes provider and customer waits; it is <strong>not actual labor time</strong>. Missing history shows “No history”, not zero.</p><p><strong>Assigned now</strong> is an all-history snapshot independent of the date filter. A shared ticket counts once for each assigned employee, so employee workload totals may exceed the number of tickets. Sharing an assignment does not grant resolution credit. Open excludes resolved and closed; overdue means open past its due time. Awaiting feedback includes all resolved tickets pending closure, even if feedback is already saved. All staff, including owners and inactive accounts with zero activity, are included by default. Roles, case difficulty and handoffs differ; no employee decisions or actions are automated.</p>{demo && <p>Demo activity uses only in-memory audit events. Existing resolved/closed demo tickets have no seeded resolution history; their historical activity is not invented.</p>}</section>
    <form className="panel report-filters" onSubmit={event => { event.preventDefault(); const message = rangeError(draft); setError(message); if (!message) setApplied({ ...draft }) }} noValidate>
      <DateFields value={draft} onChange={next => { setDraft(next); setError('') }}/><Button type="submit">Apply dates</Button>
      <p className="filter-context">Inclusive IST dates · maximum 366 days. {dirty ? 'Date changes are not applied yet.' : `Applied: ${applied.from} to ${applied.to}.`}</p>{error && <p role="alert" className="form-error">{error}</p>}
    </form>
    {!api.performance ? <Empty title="Performance unavailable">This data source does not provide employee activity reports.</Empty> : report.isError ? <section className="panel report-definitions"><ErrorNotice error={report.error}/><Button onClick={() => void report.refetch()}>Retry performance</Button></section> : report.isPending ? <div role="status"><Loading text="Loading employee performance…"/></div> : result && <>
      <section className="panel report-filters" aria-label="Employee filters">
        <label>Role<select aria-label="Role" value={role} onChange={event => setRole(event.target.value)}><option value="">All roles</option>{['owner', 'office', 'technician'].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Account activity<select aria-label="Account activity" value={activity} onChange={event => setActivity(event.target.value)}><option value="">All accounts</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <label>Search employees<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Employee name"/></label>
        <label>Employee<select aria-label="Employee" value={employeeId} onChange={event => setEmployeeId(event.target.value)}><option value="">All employees</option>{result.employees.map(employee => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>
        <Button variant="ghost" onClick={() => { setRole(''); setActivity(''); setSearch(''); setEmployeeId('') }}>Clear employee filters</Button>
      </section>
      <div className="report-toolbar"><div><p>Activity: <strong>{result.from} to {result.to} (IST)</strong> · {employees.length} employees</p><p>Snapshot generated {formatDate(result.generated_at)} IST</p></div><div className="actions"><Button variant="ghost" disabled={report.isFetching} onClick={() => void report.refetch()}><RefreshCw aria-hidden="true"/>{report.isFetching ? 'Refreshing…' : 'Refresh performance'}</Button><ViewToggle view={view} onChange={setView}/></div></div>
      {!employees.length ? <Empty title="No employees match">Clear employee filters or choose another account activity or role.</Empty> : view === 'table' ? <section className="panel"><EmployeeTable employees={employees}/></section> : <>
        <div className="report-chart-grid">{(['created', 'resolved', 'closed', 'feedback_recorded', 'open_assigned', 'overdue_assigned', 'awaiting_feedback_assigned'] as const).map(metric => <CountChart key={metric} title={label(metric)} description={metric.endsWith('assigned') ? 'Current snapshot · independent of period' : 'Unique tickets by audit actor · applied period'} rows={employees.map(employee => ({ name: employee.full_name, count: employee[metric] }))} view="chart"/>)}</div>
        <section className="panel report-data"><details><summary>View complete employee performance table, including elapsed time</summary><EmployeeTable employees={employees}/></details></section>
      </>}
    </>}
  </>
}