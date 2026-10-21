import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Plus } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Empty, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, Select, Submit } from '../components/shared'
import { DateFields } from '../components/reporting'
import { useAction, useDesk } from '../lib/runtime'
import { deskQueryOptions } from '../lib/queries'
import { downloadCsv, formatDate, fromIstInput, label, toIstInput } from '../lib/format'
import { istDate, rangeError, recentRange } from '../lib/reporting'
import type { AttendanceInput, AttendanceRecord, AttendanceStatus } from '../lib/types'

const statuses: AttendanceStatus[] = ['present', 'absent', 'half_day', 'leave']
function hours(record: AttendanceRecord) {
  return record.check_in && record.check_out ? Math.max(0, (Date.parse(record.check_out) - Date.parse(record.check_in)) / 3600000).toFixed(2) : '—'
}

export function AttendancePage() {
  const { api, scope, data, profile } = useDesk()
  const [applied, setApplied] = useState(() => recentRange())
  const [draft, setDraft] = useState(applied), [error, setError] = useState('')
  const [employee, setEmployee] = useState(''), [page, setPage] = useState(0)
  const [editing, setEditing] = useState<AttendanceRecord | 'new' | null>(null)
  const report = useQuery({ ...deskQueryOptions, queryKey: [scope, 'attendance', applied.from, applied.to],
    queryFn: ({ signal }) => api.attendance(applied, signal), refetchInterval: 30_000 })
  const result = report.isError ? undefined : report.data
  const records = result?.records.filter(record => !employee || record.employee_id === employee) ?? []
  const safePage = Math.min(page, Math.max(0, Math.ceil(records.length / 10) - 1))
  const name = (id: string | null) => id ? data.profiles.find(p => p.id === id)?.full_name ?? 'Former employee' : 'Legacy self-entry'
  const team = profile.role !== 'technician'
  return <>
    <PageHeader title="Attendance" subtitle={team ? 'Record and correct daily attendance for your company.' : 'View your attendance as recorded by office staff or the owner.'}>
      {team && <Button disabled={!result} onClick={() => setEditing('new')}><Plus aria-hidden="true"/>Record attendance</Button>}
      <Button variant="outline" disabled={!result || !records.length} onClick={() => downloadCsv('dsa-attendance.csv', records.map(record => ({ employee: name(record.employee_id), day_ist: record.day, status: record.status, check_in_ist: record.check_in ? formatDate(record.check_in) : '', check_out_ist: record.check_out ? formatDate(record.check_out) : '', elapsed_hours: hours(record) === '—' ? '' : hours(record), note: record.note, recorded_by: name(record.recorded_by), updated_by: name(record.updated_by), updated_ist: record.updated_at ? formatDate(record.updated_at) : '' })))}><Download aria-hidden="true"/>Export attendance CSV</Button>
    </PageHeader>
    <p className="notice">Only owners and office staff can record or edit attendance. Technicians have read-only access to their own records. Missing records are not automatically marked absent.</p>
    <p className="attendance-help">One record per employee per IST day. Optional times include breaks and overnight time, not verified working hours or payroll. Earlier self-entered records remain labeled as legacy entries; corrections retain an audit history.</p>
    <form className="panel report-filters" onSubmit={event => { event.preventDefault(); const message = rangeError(draft); setError(message); if (!message) { setApplied({ ...draft }); setPage(0) } }} noValidate>
      <DateFields value={draft} onChange={next => { setDraft(next); setError('') }}/><Button type="submit">Apply dates</Button>
      {team && <label>Employee<Select label="Attendance employee" value={employee} onChange={event => { setEmployee(event.target.value); setPage(0) }}><option value="">All employees</option>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}{p.active ? '' : ' (inactive)'}</option>)}</Select></label>}
      <p className="filter-context">Inclusive IST dates · maximum 366 days. {draft.from !== applied.from || draft.to !== applied.to ? 'Date changes are not applied yet.' : `Applied: ${applied.from} to ${applied.to}.`}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
    {report.isError ? <section className="panel attendance-error"><ErrorNotice error={report.error}/><Button onClick={() => void report.refetch()}>Retry attendance</Button></section> : report.isPending ? <Loading text="Loading attendance…"/> : result && <>
      <div className="queue-summary"><span><strong>{records.length}</strong> attendance records</span>{statuses.map(status => <span key={status}><strong>{records.filter(record => record.status === status).length}</strong> {label(status)}</span>)}</div>
      <section className="panel">{!records.length ? <Empty title="No attendance recorded">Choose another period or ask office staff to record attendance.</Empty> : <div className="table-scroll"><table aria-label="Attendance history"><thead><tr><th scope="col">Employee</th><th scope="col">Day (IST)</th><th scope="col">Status</th><th scope="col">Check-in (IST)</th><th scope="col">Check-out (IST)</th><th scope="col">Elapsed hours</th><th scope="col">Notes</th><th scope="col">Recorded / updated by</th>{team && <th scope="col">Actions</th>}</tr></thead><tbody>{records.slice(safePage * 10, safePage * 10 + 10).map(record => <tr key={record.id}>
        <th scope="row">{name(record.employee_id)}</th><td>{record.day}</td><td>{label(record.status)}</td><td>{record.check_in ? formatDate(record.check_in) : '—'}</td><td>{record.check_out ? formatDate(record.check_out) : '—'}</td><td>{hours(record)}</td><td>{record.note || '—'}</td><td>{name(record.recorded_by)}<small className="cell-secondary">Last: {name(record.updated_by)}{record.updated_at ? ` · ${formatDate(record.updated_at)} IST` : ''}</small></td>
        {team && <td><Button variant="outline" size="sm" aria-label={`Edit attendance for ${name(record.employee_id)} on ${record.day}`} onClick={() => setEditing(record)}>Edit attendance</Button></td>}
      </tr>)}</tbody></table></div>}<Pagination page={safePage} total={records.length} onChange={setPage}/></section>
    </>}
    {team && editing && result && <AttendanceForm key={editing === 'new' ? 'new' : editing.id} record={editing === 'new' ? undefined : editing} initialEmployee={employee} onClose={() => setEditing(null)}/>}
  </>
}

function AttendanceForm({ record, initialEmployee, onClose }: { record?: AttendanceRecord; initialEmployee: string; onClose(): void }) {
  const { api, data } = useDesk()
  const [id] = useState(() => record?.id ?? crypto.randomUUID())
  const [employee, setEmployee] = useState(record?.employee_id ?? initialEmployee)
  const [day, setDay] = useState(record?.day ?? istDate())
  const [status, setStatus] = useState<AttendanceStatus>(record?.status ?? 'present')
  const [checkIn, setCheckIn] = useState(toIstInput(record?.check_in ?? null)), [checkOut, setCheckOut] = useState(toIstInput(record?.check_out ?? null))
  const [note, setNote] = useState(record?.note ?? ''), [error, setError] = useState('')
  const [submitted, setSubmitted] = useState<AttendanceInput | null>(null)
  const save = useAction((input: AttendanceInput) => api.saveAttendance(input), 'Attendance saved', onClose)
  const withTimes = status === 'present' || status === 'half_day'
  return <Modal title={record ? 'Edit attendance' : 'Record attendance'} description="Only office staff and owners can save these records. All changes are audited." onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault(); setError('')
      if (submitted) { save.mutate(submitted); return }
      if (!employee) { setError('Choose an employee.'); return }
      if (rangeError({ from: day, to: day }) || day > istDate()) { setError('Choose a valid attendance day, not in the future.'); return }
      const input: AttendanceInput = { id, employee_id: employee, day, status, check_in: withTimes ? fromIstInput(checkIn) : null, check_out: withTimes ? fromIstInput(checkOut) : null, note: note.trim(), version: record?.version ?? 0 }
      if (input.check_out && (!input.check_in || input.check_out < input.check_in)) { setError('Check-out requires a check-in and cannot be earlier.'); return }
      if (input.check_in && istDate(input.check_in) !== day) { setError('Check-in must fall on the attendance day in IST.'); return }
      if ([input.check_in, input.check_out].some(value => value && Date.parse(value) > Date.now())) { setError('Attendance times cannot be in the future.'); return }
      setSubmitted(input); save.mutate(input)
    }}>
      <fieldset disabled={save.isPending || !!submitted}>
        <Field label="Employee"><Select label="Record employee" required disabled={!!record} value={employee} onChange={event => setEmployee(event.target.value)}><option value="">Choose employee</option>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.full_name}{p.active ? '' : ' (inactive)'}</option>)}</Select></Field>
        <Field label="Attendance day (IST)"><Input aria-label="Attendance day (IST)" type="date" required max={istDate()} disabled={!!record} value={day} onChange={event => setDay(event.target.value)}/></Field>
        <Field label="Attendance status"><Select label="Attendance status" value={status} onChange={event => setStatus(event.target.value as AttendanceStatus)}>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</Select></Field>
        {withTimes && <div className="form-grid"><Field label="Check-in (IST, optional)"><Input aria-label="Check-in (IST, optional)" type="datetime-local" value={checkIn} onChange={event => setCheckIn(event.target.value)}/></Field><Field label="Check-out (IST, optional)"><Input aria-label="Check-out (IST, optional)" type="datetime-local" value={checkOut} onChange={event => setCheckOut(event.target.value)}/></Field></div>}
        <Field label="Attendance notes"><Textarea aria-label="Attendance notes" maxLength={2000} value={note} onChange={event => setNote(event.target.value)}/></Field>
      </fieldset>
      <ErrorNotice error={error ? new Error(error) : save.error}/>
      {save.isError && <p className="notice warning">Close and refresh the register before correcting a rejected or stale record. Retrying sends the same saved request, not a new entry.</p>}
      <div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Submit pending={save.isPending}>{submitted && save.isError ? 'Retry attendance' : 'Save attendance'}</Submit></div>
    </form>
  </Modal>
}