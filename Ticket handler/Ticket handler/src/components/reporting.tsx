import { BarChart3, Table2 } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { recentRange } from '../lib/reporting'
import type { DateRange } from '../lib/types'
import './reporting.css'

export function DateFields({ value, onChange, allTime = false }: { value: DateRange; onChange(value: DateRange): void; allTime?: boolean }) {
  return <>
    <label>Period<select aria-label="Period" value={!value.from && !value.to ? 'all' : 'custom'} onChange={event => onChange(event.target.value === 'all' ? { from: '', to: '' } : event.target.value === 'custom' ? value : recentRange(Number(event.target.value)))}>
      {allTime && <option value="all">All time</option>}<option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom / selected dates</option>
    </select></label>
    <label>From (IST)<Input type="date" aria-label="From (IST)" value={value.from} onChange={event => onChange({ ...value, from: event.target.value })}/></label>
    <label>To (IST)<Input type="date" aria-label="To (IST)" value={value.to} onChange={event => onChange({ ...value, to: event.target.value })}/></label>
  </>
}
export function ViewToggle({ view, onChange }: { view: 'chart' | 'table'; onChange(value: 'chart' | 'table'): void }) {
  return <div className="actions" role="group" aria-label="Report view"><Button size="sm" variant={view === 'chart' ? 'secondary' : 'outline'} aria-pressed={view === 'chart'} onClick={() => onChange('chart')}><BarChart3 aria-hidden="true"/>Charts</Button><Button size="sm" variant={view === 'table' ? 'secondary' : 'outline'} aria-pressed={view === 'table'} onClick={() => onChange('table')}><Table2 aria-hidden="true"/>Tables</Button></div>
}
export function CountChart({ title, description, rows, view, trend = false }: { title: string; description: string; rows: { name: string; count: number }[]; view: 'chart' | 'table'; trend?: boolean }) {
  const table = <div className="table-scroll"><table aria-label={title}><thead><tr><th>{trend ? 'Created date (IST)' : 'Group'}</th><th>Tickets</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.name}:${index}`}><th scope="row">{row.name}</th><td>{row.count}</td></tr>)}</tbody></table></div>
  const any = rows.some(row => row.count > 0)
  return <section className="panel report-chart"><div className="section-heading"><h2>{title}</h2><p>{description}</p></div>
    {!any && <p className="report-empty" role="status">No tickets in this series for the applied filters.</p>}
    {view === 'table' ? table : <>
      {any && <div className="chart-frame" role="img" aria-label={`${title}. Exact values available in the data table below.`}><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {trend ? <LineChart data={rows} margin={{ top: 15, right: 24, bottom: 20, left: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="name" tick={{ fontSize: 11 }} minTickGap={35}/><YAxis allowDecimals={false} width={40}/><Tooltip/><Line type="linear" dataKey="count" name="Tickets" stroke="#087d70" strokeWidth={2} dot={rows.length < 32} isAnimationActive={false}/></LineChart>
          : <BarChart data={rows} layout="vertical" margin={{ top: 10, right: 28, bottom: 10, left: 8 }}><CartesianGrid strokeDasharray="3 3" horizontal={false}/><XAxis type="number" allowDecimals={false}/><YAxis type="category" dataKey="name" width={145} tick={{ fontSize: 11 }}/><Tooltip/><Bar dataKey="count" name="Tickets" fill="#087d70" radius={[0, 4, 4, 0]} isAnimationActive={false}/></BarChart>}
      </ResponsiveContainer></div>}
      <details className="report-data"><summary>View {title.toLowerCase()} data table</summary>{table}</details>
    </>}
  </section>
}