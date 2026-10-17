import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import Papa from 'papaparse'
import { Download, Plus, Search, Upload } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Empty, ErrorNotice, Field, Modal, PageHeader, Pagination, Select, Submit } from '../components/shared'
import { useAction, useDesk } from '../lib/runtime'
import { connectionKey, csvHeaders, customerSchema, downloadCsv, errorMessage, validateImport } from '../lib/format'
import type { CustomerInput } from '../lib/types'

export function CustomersPage() {
  const { data } = useDesk()
  const [search, setSearch] = useState(''); const [provider, setProvider] = useState(''); const [area, setArea] = useState(''); const [page, setPage] = useState(0)
  const [dialog, setDialog] = useState<'create' | 'import' | null>(null)
  const rows = data.connections.flatMap(connection => { const customer = data.customers.find(c => c.id === connection.customer_id); return customer ? [{ ...customer, ...connection, full_name: customer.full_name }] : [] })
    .filter(c => (!provider || c.provider_id === provider) && (!area || c.area === area) && [c.full_name, c.phone, c.address, c.area, c.account_number].join(' ').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
  const safePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1))
  function exportRows() { downloadCsv('dsa-customers.csv', rows.map(c => Object.fromEntries(csvHeaders.map(key => [key, c[key]])))) }
  return <><PageHeader title="Customers" subtitle={`${data.customers.length} customers · ${data.connections.length} service connections`}><Button variant="outline" disabled={!rows.length} onClick={exportRows}><Download/>Export</Button><Button variant="outline" onClick={() => setDialog('import')}><Upload/>Import CSV</Button><Button onClick={() => setDialog('create')}><Plus/>Add customer</Button></PageHeader><section className="panel"><div className="toolbar"><div className="search-input"><Search size={16}/><Input aria-label="Search customers" placeholder="Search name, phone, account or address…" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}/></div><Select label="Customer provider" value={provider} onChange={e => { setProvider(e.target.value); setPage(0) }}><option value="">All providers</option>{data.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select label="Customer area" value={area} onChange={e => { setArea(e.target.value); setPage(0) }}><option value="">All areas</option>{[...new Set(data.customers.map(c => c.area))].sort().map(a => <option key={a}>{a}</option>)}</Select></div>{!rows.length ? <Empty title="No matching customers">Add a customer and their first service connection, or clear your filters.</Empty> : <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Phone</th><th>Area / Address</th><th>Provider</th><th>Account / Node</th></tr></thead><tbody>{rows.slice(safePage * 10, safePage * 10 + 10).map(c => <tr key={c.id}><td><strong>{c.full_name}</strong></td><td>{c.phone}</td><td>{c.area}<small className="cell-secondary address-cell">{c.address}</small></td><td><span className={`provider provider-${c.provider_id}`}>{data.providers.find(p => p.id === c.provider_id)?.name}</span></td><td>{c.account_number}<small className="cell-secondary">{c.network_node || 'No node recorded'}</small></td></tr>)}</tbody></table></div>}<Pagination page={safePage} total={rows.length} onChange={setPage}/></section><p className="page-footnote">One row per service connection. Exports include the full filtered result, not just this page.</p>{dialog === 'create' && <CreateCustomer onClose={() => setDialog(null)}/>}{dialog === 'import' && <ImportCustomers onClose={() => setDialog(null)}/>}</>
}
const blankCustomer: CustomerInput = { full_name: '', phone: '', address: '', area: '', provider_id: 'niss', account_number: '', network_node: '' }
function CreateCustomer({ onClose }: { onClose(): void }) {
  const { api, data } = useDesk(); const [draft, setDraft] = useState(blankCustomer); const [validation, setValidation] = useState<unknown>()
  const save = useAction((input: CustomerInput) => api.createCustomer(input), 'Customer and connection created', onClose)
  function field(key: keyof CustomerInput, value: string) { setDraft(d => ({ ...d, [key]: value })) }
  return <Modal title="Add customer" description="Create a customer and their first service connection together." onClose={onClose}><form onSubmit={e => { e.preventDefault(); setValidation(undefined); const parsed = customerSchema.safeParse(draft); if (!parsed.success) { setValidation(new Error(parsed.error.issues.map(i => i.message).join(' · '))); return } if (data.connections.some(c => connectionKey(c) === connectionKey(parsed.data))) { setValidation(new Error('This provider/account number already exists.')); return } save.mutate(parsed.data) }}><fieldset disabled={save.isPending}><Field label="Full name"><Input required maxLength={200} value={draft.full_name} onChange={e => field('full_name', e.target.value)}/></Field><div className="form-grid"><Field label="Phone"><Input required type="tel" maxLength={40} value={draft.phone} onChange={e => field('phone', e.target.value)}/></Field><Field label="Area"><Input required maxLength={200} value={draft.area} onChange={e => field('area', e.target.value)}/></Field></div><Field label="Address"><Textarea required maxLength={2000} value={draft.address} onChange={e => field('address', e.target.value)}/></Field><div className="form-grid"><Field label="Provider"><Select label="Provider" value={draft.provider_id} onChange={e => field('provider_id', e.target.value)}>{data.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field><Field label="Account number"><Input required maxLength={200} value={draft.account_number} onChange={e => field('account_number', e.target.value)}/></Field></div><Field label="Network node (optional)"><Input maxLength={200} value={draft.network_node} onChange={e => field('network_node', e.target.value)}/></Field></fieldset><ErrorNotice error={validation || save.error}/>{save.isError && <p className="muted">If the request timed out, check the directory before retrying. Customer creation has no automatic retries.</p>}<div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Submit pending={save.isPending}>Create customer</Submit></div></form></Modal>
}

function ImportCustomers({ onClose }: { onClose(): void }) {
  const { data, api, scope } = useDesk(); const cache = useQueryClient()
  const [rows, setRows] = useState<ReturnType<typeof validateImport>>([]); const [error, setError] = useState<unknown>()
  const [results, setResults] = useState<Record<number, string>>({}); const [running, setRunning] = useState(false); const [attempted, setAttempted] = useState(false); const [page, setPage] = useState(0)
  async function read(file?: File) {
    setRows([]); setError(undefined); setResults({}); setAttempted(false); setPage(0)
    if (!file) return
    if (file.size > 5_000_000) { setError(new Error('Use a CSV file smaller than 5 MB.')); return }
    try {
      const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() })
      if (parsed.errors.length) throw new Error(parsed.errors.map(e => e.message).join('; '))
      const headers = parsed.meta.fields ?? []
      if (csvHeaders.some(h => !headers.includes(h)) || headers.some(h => !(csvHeaders as readonly string[]).includes(h))) throw new Error(`Use exactly these headers: ${csvHeaders.join(', ')}`)
      if (parsed.data.length > 5000) throw new Error('Import at most 5,000 rows per file.')
      if (!parsed.data.length) throw new Error('This file has no customer rows.')
      setRows(validateImport(parsed.data, data.connections))
    } catch (error) { setError(error) }
  }
  async function importRows() {
    setRunning(true); setAttempted(true)
    try {
      // Sequential, once per eligible row. Failed or uncertain rows are never retried automatically.
      for (const row of rows) {
        if (row.error || !row.data) continue
        try { await api.createCustomer(row.data); setResults(previous => ({ ...previous, [row.row]: 'Imported' })) }
        catch (error) { setResults(previous => ({ ...previous, [row.row]: `Failed / unconfirmed: ${errorMessage(error)}` })) }
      }
    } finally { await cache.invalidateQueries({ queryKey: [scope] }); setRunning(false) }
  }
  const valid = rows.filter(r => !r.error).length; const succeeded = Object.values(results).filter(v => v === 'Imported').length; const failed = Object.values(results).filter(v => v !== 'Imported').length
  return <Modal title="Import customers" description="Preview and validate every row before importing. Existing records are never overwritten." onClose={() => { if (!running) onClose() }} wide><p className="muted">Fixed header mapping (provider_id: niss, jio, airtel or bsnl):</p><div className="csv-headers">{csvHeaders.join(', ')}</div><Field label="Customer CSV"><Input type="file" accept=".csv,text/csv" disabled={running} onChange={e => void read(e.target.files?.[0])}/></Field><ErrorNotice error={error}/>{!!rows.length && <><div className="notice">{rows.length} rows · {valid} valid · {rows.length - valid} rejected. Duplicate accounts are checked against existing connections and earlier rows in this file.</div><div className="table-scroll"><table><thead><tr><th>Row</th><th>Customer</th><th>Provider / Account</th><th>Validation / Result</th></tr></thead><tbody>{rows.slice(page * 10, page * 10 + 10).map(row => <tr key={row.row}><td>{row.row}</td><td>{row.data?.full_name || 'Invalid row'}</td><td>{row.data?.provider_id} / {row.data?.account_number}</td><td className={row.error || results[row.row]?.startsWith('Failed') ? 'overdue' : ''}>{row.error || results[row.row] || 'Ready'}</td></tr>)}</tbody></table></div><Pagination page={page} total={rows.length} onChange={setPage}/>{attempted && <div role="status" className="notice">{succeeded} imported · {failed} failed / unconfirmed · {rows.length - valid} rejected{running ? ' · Import in progress; keep this window open.' : '. Finished. Check the directory for uncertain rows before preparing a corrected file. Nothing is silently retried.'}</div>}<div className="form-footer"><Button variant="outline" disabled={running} onClick={onClose}>Close</Button><Button disabled={!valid || running || attempted} onClick={() => void importRows()}>{running ? 'Importing…' : `Import ${valid} valid rows`}</Button></div></>}</Modal>
}