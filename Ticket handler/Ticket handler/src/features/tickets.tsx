import { useRef, useState } from 'react'
import { AssigneeSelector } from '../components/assignee-selector'
import { assigneeIds, assigneeName, assigneeNames, sameAssignees } from '../lib/assignees'
import { useQuery } from '@tanstack/react-query'
import { deskQueryOptions } from '../lib/queries'
import { imageFileError } from '../lib/data'
import { Plus, Search, Phone, MapPin, ArrowUpRight, Clock3, SlidersHorizontal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Empty, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, PriorityBadge, Select, StatusBadge, Submit } from '../components/shared'
import { useAction, useDesk } from '../lib/runtime'
import { eventText, formatDate, fromIstInput, isOpen, label, overdue, reference, statuses, toIstInput } from '../lib/format'
import type { Priority, Status, Ticket, TicketInput, TicketPatch } from '../lib/types'

const categories = ['No internet', 'Slow speed', 'Intermittent', 'LOS / fibre cut', 'Router', 'Other']
const priorities: Priority[] = ['low', 'normal', 'high', 'urgent']

// Only definite input/permission rejections permit editing a previously submitted draft.
// Duplicate IDs and unclassified transport/server errors require reconciliation/retry.
function isDefiniteRejection(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { code, status } = error as { code?: string; status?: number }
  if (status && status >= 500) return false
  if (code === '23505') return false
  return (typeof code === 'string' && (/^(22|23)/.test(code) || ['42501', 'PGRST100', 'PGRST102', 'PGRST204'].includes(code))) ||
    [400, 401, 403, 404, 422].includes(status ?? 0)
}

export function TicketsPage() {
  const { data, profile } = useDesk()
  const [tab, setTab] = useState('open'); const [search, setSearch] = useState('')
  const [provider, setProvider] = useState(''); const [priority, setPriority] = useState(''); const [status, setStatus] = useState(''); const [assignee, setAssignee] = useState('')
  const [page, setPage] = useState(0); const [create, setCreate] = useState(false); const [selected, setSelected] = useState<string | null>(null)
  const customers = new Map(data.customers.map(c => [c.id, c])); const connections = new Map(data.connections.map(c => [c.id, c]))
  const filterAssignees = [...new Set([...data.profiles.filter(p => p.role === 'technician').map(p => p.id), ...data.tickets.flatMap(t => assigneeIds(t.assigned_to))])]
  const counts = { open: data.tickets.filter(isOpen).length, unassigned: data.tickets.filter(t => isOpen(t) && !assigneeIds(t.assigned_to).length).length, waiting: data.tickets.filter(t => t.status === 'waiting_provider').length, feedback: data.tickets.filter(t => t.status === 'resolved').length, resolved: data.tickets.filter(t => !isOpen(t)).length }
  const filtered = data.tickets.filter(t => {
    const connection = connections.get(t.connection_id ?? ''); const customer = customers.get(connection?.customer_id ?? '')
    const matchesTab = tab === 'open' ? isOpen(t) : tab === 'unassigned' ? isOpen(t) && !assigneeIds(t.assigned_to).length : tab === 'waiting' ? t.status === 'waiting_provider' : tab === 'feedback' ? t.status === 'resolved' : !isOpen(t)
    const text = [reference(t.number), t.title, customer?.full_name, customer?.phone, customer?.area, connection?.account_number].join(' ').toLowerCase()
    return matchesTab && text.includes(search.toLowerCase()) && (!provider || connection?.provider_id === provider) && (!priority || t.priority === priority) && (!status || t.status === status) && (!assignee || (assignee === 'none' ? !assigneeIds(t.assigned_to).length : assigneeIds(t.assigned_to).includes(assignee)))
  }).sort((a, b) => b.number - a.number)
  const safePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1)); const rows = filtered.slice(safePage * 10, safePage * 10 + 10)
  const ticket = data.tickets.find(t => t.id === selected)
  function filter(setter: (value: string) => void, value: string) { setter(value); setPage(0) }
  return <><PageHeader title={profile.role === 'technician' ? 'My jobs' : 'Ticket queue'} subtitle="Track service issues, coordinate visits, and keep work moving.">{profile.role !== 'technician' && <Button onClick={() => setCreate(true)}><Plus/>Create ticket</Button>}</PageHeader>
    <div className="queue-summary"><span><i className="summary-dot teal"/><strong>{counts.open}</strong> open tickets</span><span><i className="summary-dot amber"/><strong>{data.tickets.filter(overdue).length}</strong> overdue</span><span><i className="summary-dot"/><strong>{data.outages.filter(o => o.status === 'active').length}</strong> active outages</span><span className="summary-end"><Clock3 size={13}/> All times IST</span></div>
    <section className="panel queue-panel"><div className="tabs" role="tablist" aria-label="Ticket queues">{([['open', 'All open'], ['unassigned', 'Unassigned'], ['waiting', 'Waiting for provider'], ['feedback', 'Awaiting feedback'], ['resolved', 'Resolved']] as const).map(([key, text]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setStatus(''); setPage(0) }}>{text}<span>{counts[key]}</span></button>)}</div>
      {(tab === 'feedback' || tab === 'resolved') && <div className="notice">Resolved tickets: pending customer feedback / confirmation and office closure. Office staff should contact the customer after repair; if the issue is not fixed, reopen the ticket. Awaiting feedback includes resolved tickets with feedback already saved but not yet closed.</div>}
      <div className="toolbar"><div className="search-input"><Search size={16}/><Input aria-label="Search tickets" placeholder="Search ticket, customer, phone or account…" value={search} onChange={e => filter(setSearch, e.target.value)}/></div><span className="filter-label"><SlidersHorizontal size={15}/>Filter</span><Select label="Filter provider" value={provider} onChange={e => filter(setProvider, e.target.value)}><option value="">All providers</option>{data.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select label="Filter priority" value={priority} onChange={e => filter(setPriority, e.target.value)}><option value="">Priority</option>{priorities.map(p => <option key={p}>{p}</option>)}</Select><Select label="Filter status" value={status} onChange={e => filter(setStatus, e.target.value)}><option value="">Status</option>{statuses.map(s => <option key={s} value={s}>{label(s)}</option>)}</Select><Select label="Filter assignee" value={assignee} onChange={e => filter(setAssignee, e.target.value)}><option value="">Assignee</option><option value="none">Unassigned</option>{filterAssignees.map(id => <option key={id} value={id}>{assigneeName(id, data.profiles)}</option>)}</Select>{(search || provider || priority || status || assignee) && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setProvider(''); setPriority(''); setStatus(''); setAssignee(''); setPage(0) }}>Clear</Button>}</div>
      {!rows.length ? <Empty title="No tickets in this view">Try another queue or clear your filters.</Empty> : <><div className="desktop-table table-scroll"><table><thead><tr><th>Ticket / Customer</th><th>Provider</th><th>Status</th><th>Priority</th><th>Assigned to</th><th>Due</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{rows.map(t => {
        const connection = connections.get(t.connection_id ?? ''); const customer = customers.get(connection?.customer_id ?? '')
        return <tr key={t.id}><td className="ticket-cell"><div className="ticket-reference">{reference(t.number)}{customer?.area && <span>· {customer.area}</span>}</div><button className="ticket-title" onClick={() => setSelected(t.id)}>{t.title}</button><div className="cell-secondary">{connection ? [customer?.full_name, connection.account_number].filter(Boolean).join(' · ') : 'No connection linked'}</div></td><td>{connection ? <span className={`provider provider-${connection.provider_id}`}>{data.providers.find(p => p.id === connection.provider_id)?.name}</span> : <span className="muted">—</span>}</td><td><StatusBadge value={t.status}/></td><td><PriorityBadge value={t.priority}/></td><td><span className="assignee">{assigneeNames(t.assigned_to, data.profiles) || 'Unassigned'}</span></td><td><span className={overdue(t) ? 'overdue' : 'date-cell'}>{formatDate(t.due_at, false)}</span>{overdue(t) && <small className="overdue block">Overdue</small>}</td><td><Button size="icon-sm" variant="ghost" aria-label={`Open ${reference(t.number)}`} onClick={() => setSelected(t.id)}><ArrowUpRight/></Button></td></tr>
      })}</tbody></table></div><div className="job-cards">{rows.map(t => { const connection = connections.get(t.connection_id ?? ''); const customer = customers.get(connection?.customer_id ?? ''); return <article className="job-card" key={t.id}><div className="spread"><span className="ticket-reference">{reference(t.number)}</span><PriorityBadge value={t.priority}/></div><button className="ticket-title" onClick={() => setSelected(t.id)}>{t.title}</button><p>{connection ? [customer?.full_name, customer?.area].filter(Boolean).join(' · ') : 'No connection linked'}</p><span className="assignee">{assigneeNames(t.assigned_to, data.profiles) || 'Unassigned'}</span><div className="spread"><StatusBadge value={t.status}/>{connection && <span className="muted">{connection.provider_id.toUpperCase()}</span>}</div><small className={overdue(t) ? 'overdue' : 'muted'}>Due {formatDate(t.due_at)} · IST</small>{t.visit_at && <small>Visit {formatDate(t.visit_at)} IST</small>}</article> })}</div></>}
      <Pagination page={safePage} total={filtered.length} onChange={setPage}/>
    </section><p className="page-footnote">{profile.role === 'technician' ? 'Only jobs assigned to you are visible.' : 'One shared queue for NISS, Jio, Airtel and BSNL.'} Resolved includes closed tickets.</p>
    {create && <CreateTicket onClose={() => setCreate(false)}/>}{ticket && <TicketDetail key={ticket.id} ticket={ticket} onClose={() => setSelected(null)}/>}
  </>
}

function CreateTicket({ onClose }: { onClose(): void }) {
  const { api, data } = useDesk()
  const [id] = useState(() => crypto.randomUUID()); const [connectionId, setConnectionId] = useState(''); const [search, setSearch] = useState('')
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [category, setCategory] = useState(categories[0]); const [priority, setPriority] = useState<Priority>('normal'); const [assigned, setAssigned] = useState<string[]>([]); const [due, setDue] = useState('')
  const [submitted, setSubmitted] = useState<TicketInput | null>(null)
  const uncertain = useRef(false)
  const save = useAction(async (input: TicketInput) => {
    try { await api.createTicket(input) } catch (error) {
      if (!uncertain.current && isDefiniteRejection(error)) setSubmitted(null)
      else uncertain.current = true // A later rejection cannot disprove an earlier commit.
      throw error
    }
  }, 'Ticket created', onClose)
  const connection = data.connections.find(c => c.id === connectionId); const customer = data.customers.find(c => c.id === connection?.customer_id)
  const duplicates = data.tickets.filter(t => t.connection_id === connectionId && isOpen(t))
  const outages = data.outages.filter(o => o.status === 'active' && o.provider_id === connection?.provider_id && o.area.toLowerCase() === customer?.area.toLowerCase())
  const matchingConnections = data.connections.filter(c => { const customer = data.customers.find(v => v.id === c.customer_id); return [customer?.full_name, customer?.phone, c.account_number, c.provider_id].join(' ').toLowerCase().includes(search.toLowerCase()) })
  return <Modal title="Create ticket" description="Log a service issue with or without a customer's connection." onClose={onClose}><form onSubmit={e => { e.preventDefault(); const input = submitted ?? { id, connection_id: connectionId || null, title: title.trim(), description, category, priority, assigned_to: [...assigned], due_at: fromIstInput(due), outage_id: null }; setSubmitted(input); save.mutate(input) }}>
    <fieldset disabled={!!submitted || save.isPending}><Field label="Find a customer or connection"><Input placeholder="Name, phone or account number" value={search} onChange={e => setSearch(e.target.value)}/></Field><Field label="Connection"><Select label="Connection" aria-describedby="connection-help" value={connectionId} onChange={e => setConnectionId(e.target.value)}><option value="">No connection (optional)</option>{matchingConnections.map(c => <option key={c.id} value={c.id}>{data.customers.find(v => v.id === c.customer_id)?.full_name} · {c.provider_id.toUpperCase()} · {c.account_number}</option>)}</Select><small id="connection-help">Connection is optional. You can log customer, contact and issue details manually in Details.</small></Field>
    {!!duplicates.length && <div className="notice warning">{duplicates.length} open ticket(s) already exist for this connection: {duplicates.map(t => reference(t.number)).join(', ')}. Continue only for a separate issue.</div>}{outages.map(o => <div className="notice warning" key={o.id}>Active provider outage: {o.title}. You can link it from ticket details after creating.</div>)}
    <Field label="Issue title"><Input required maxLength={500} value={title} onChange={e => setTitle(e.target.value)}/></Field><div className="form-grid"><Field label="Category"><Select label="Category" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</Select></Field><Field label="Priority"><Select label="Priority" value={priority} onChange={e => setPriority(e.target.value as Priority)}>{priorities.map(p => <option key={p}>{p}</option>)}</Select></Field></div><Field label="Details"><Textarea maxLength={20000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Symptoms, checks already completed, and useful context"/></Field><div className="form-grid"><Field label="Due date & time (IST)"><Input type="datetime-local" value={due} onChange={e => setDue(e.target.value)}/></Field><AssigneeSelector profiles={data.profiles} value={assigned} onChange={setAssigned}/></div></fieldset>
    <ErrorNotice error={save.error}/>{save.isError && <p className="muted">{submitted ? 'The result is unconfirmed. Retry sends the same frozen draft and ticket ID to prevent duplicates. Check the queue before starting a different draft.' : 'The ticket was rejected. Correct the fields and submit again; the same ticket ID will be kept.'}</p>}<div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Submit pending={save.isPending}>{save.isError && submitted ? 'Retry same ticket' : 'Create ticket'}</Submit></div></form></Modal>
}

function TicketDetail({ ticket, onClose }: { ticket: Ticket; onClose(): void }) {
  const { api, data, profile, scope, demo } = useDesk()
  // Preserve the base version and user's draft across background refetches.
  const [base, setBase] = useState(ticket); const [draft, setDraft] = useState(ticket); const [note, setNote] = useState('')
  const tech = profile.role === 'technician'
  const reopening = ['resolved', 'closed'].includes(base.status) && ['new', 'assigned', 'in_progress'].includes(draft.status)
  const waiting = draft.status !== base.status && ['waiting_customer', 'waiting_provider'].includes(draft.status)
  const needsResolution = ['resolved', 'closed'].includes(draft.status)
  const closing = base.status === 'resolved' && draft.status === 'closed'
  const feedbackEditable = !tech && base.status === 'resolved' && !reopening
  const invalidReopenAssignee = reopening && assigneeIds(draft.assigned_to).some(id => !data.profiles.some(p => p.id === id && p.active && p.role === 'technician'))
  const events = useQuery({ ...deskQueryOptions, queryKey: [scope, 'events', ticket.id], queryFn: ({ signal }) => api.events(ticket.id, signal), refetchInterval: 30_000 })
  const save = useAction(async () => {
    if (needsResolution && !draft.resolution.trim()) throw new Error('A resolution note is required to resolve or close this ticket.')
    if (closing && !(draft.customer_feedback ?? '').trim()) throw new Error('Customer feedback is required before closing this ticket.')
    if (waiting && !note.trim()) throw new Error('Provide a waiting reason in the note.')
    if (invalidReopenAssignee) throw new Error('Reassign to an active technician or unassign before reopening.')
    if (draft.status === 'in_progress' && !assigneeIds(draft.assigned_to).length) throw new Error('Assign a technician before starting work.')
    const keys: (keyof TicketPatch)[] = tech ? ['status', 'resolution'] : ['status', 'title', 'description', 'priority', 'assigned_to', 'outage_id', 'provider_reference', 'due_at', 'visit_at', 'follow_up_at', 'resolution']
    const patch = Object.fromEntries(keys.filter(key => key === 'assigned_to' ? !sameAssignees(draft.assigned_to, base.assigned_to) : draft[key] !== base[key]).map(key => [key, key === 'assigned_to' ? assigneeIds(draft.assigned_to) : draft[key]])) as TicketPatch
    // The server clears feedback on reopen/new resolution. Never send it with those transitions.
    if (feedbackEditable && (draft.customer_feedback ?? '') !== (base.customer_feedback ?? '')) patch.customer_feedback = draft.customer_feedback ?? ''
    if (!Object.keys(patch).length && !note.trim()) throw new Error('Add a note or make a change first.')
    await api.updateTicket(ticket.id, base.version, patch, note)
  }, 'Ticket updated', onClose)
  const connection = data.connections.find(c => c.id === ticket.connection_id); const customer = data.customers.find(c => c.id === connection?.customer_id)
  function update<K extends keyof Ticket>(key: K, value: Ticket[K]) { setDraft(v => ({ ...v, [key]: value })) }
  function changeStatus(status: Status) {
    const reopen = ['resolved', 'closed'].includes(base.status) && ['new', 'assigned', 'in_progress'].includes(status)
    setDraft(v => ({ ...v, status, resolution: reopen ? '' : reopening ? base.resolution : v.resolution,
      customer_feedback: reopen || (status === 'resolved' && base.status !== 'resolved') ? '' : reopening ? base.customer_feedback ?? '' : v.customer_feedback ?? '' }))
  }
  const allowedStatuses = statuses.filter(s => s === base.status || (tech
    ? !['resolved', 'closed'].includes(base.status) && ['in_progress', 'waiting_customer', 'waiting_provider', 'resolved'].includes(s)
    : ['resolved', 'closed'].includes(base.status)
      ? ['new', 'assigned', 'in_progress'].includes(s) || (base.status === 'resolved' && s === 'closed')
      : s !== 'closed'))
  return <Modal title={`${reference(ticket.number)} · Ticket details`} description={`Created ${formatDate(ticket.created_at)} IST · Version ${base.version}`} onClose={onClose} wide>
    <div className="detail-customer"><div>{connection ? <><strong>{customer?.full_name}</strong><p>{[customer?.address, customer?.area].filter(Boolean).join(' · ')}</p><small>{connection.provider_id.toUpperCase()} · {connection.account_number} · {connection.network_node || 'No network node'}</small></> : <><strong>No connection linked</strong><p>See Details for any manually logged customer or contact information.</p></>}</div>{connection && customer && <div className="actions">{!demo ? <><a className="icon-link" href={`tel:${customer.phone.replace(/[^+\d]/g, '')}`}><Phone size={15}/>{customer.phone}</a><a className="icon-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customer.address + ', ' + customer.area)}`} target="_blank" rel="noreferrer"><MapPin size={15}/>Maps</a></> : <span className="muted">Fictional contact · calling disabled</span>}</div>}</div>
    <form onSubmit={e => { e.preventDefault(); save.mutate() }}><fieldset disabled={save.isPending}>
      <Field label="Issue title"><Input required maxLength={500} readOnly={tech} value={draft.title} onChange={e => update('title', e.target.value)}/></Field><Field label="Details"><Textarea maxLength={20000} readOnly={tech} value={draft.description} onChange={e => update('description', e.target.value)}/></Field>
      {ticket.version !== base.version && <div className="notice warning">This ticket has changed since you opened it. Your draft is preserved. Copy any notes, then <button type="button" className="text-link" onClick={() => { setBase(ticket); setDraft(ticket); save.reset() }}>reload latest fields</button> before saving.</div>}
      <div className="form-grid"><Field label="Status"><Select label="Ticket status" disabled={tech && ['resolved', 'closed'].includes(base.status)} value={draft.status} onChange={e => changeStatus(e.target.value as Status)}>{allowedStatuses.map(s => <option key={s} value={s}>{label(s)}</option>)}</Select></Field>{!tech && <Field label="Priority"><Select label="Ticket priority" value={draft.priority} onChange={e => update('priority', e.target.value as Priority)}>{priorities.map(p => <option key={p}>{p}</option>)}</Select></Field>}</div>
      {base.status === 'resolved' && !reopening && <div className="notice warning">Pending customer feedback / confirmation and office closure. {tech ? 'Repair handed off: office staff must contact the customer, record feedback and close the ticket. Technicians cannot record customer feedback or close tickets.' : 'Contact the customer after repair and record their feedback. Save feedback while resolved, or select Closed to finish. If the issue is not fixed, reopen the ticket.'}</div>}
      {reopening && <div className="notice">Reopening clears the current resolution and customer feedback; previous values remain in activity history. New/assigned follows the selected assignee.</div>}
      {invalidReopenAssignee && <div className="notice warning">Reassign to an active technician or unassign before reopening.</div>}
      {tech && <p>Assigned technicians: {assigneeNames(draft.assigned_to, data.profiles) || 'Unassigned'}</p>}
      {!tech && <><div className="form-grid"><AssigneeSelector profiles={data.profiles} value={assigneeIds(draft.assigned_to)} history={assigneeIds(base.assigned_to)} onChange={ids => update('assigned_to', ids)}/><Field label="Provider reference"><Input maxLength={500} value={draft.provider_reference} onChange={e => update('provider_reference', e.target.value)}/></Field></div>
      <div className="form-grid">{(['due_at', 'follow_up_at', 'visit_at'] as const).map(key => <Field key={key} label={`${key === 'due_at' ? 'Due' : key === 'visit_at' ? 'Visit' : 'Follow-up'} (IST)`}><Input type="datetime-local" value={toIstInput(draft[key])} onChange={e => update(key, fromIstInput(e.target.value))}/></Field>)}<Field label="Linked outage"><Select label="Linked outage" disabled={!connection} aria-describedby={!connection ? 'outage-help' : undefined} value={draft.outage_id ?? ''} onChange={e => update('outage_id', e.target.value || null)}><option value="">No linked outage</option>{data.outages.filter(o => o.provider_id === connection?.provider_id).map(o => <option key={o.id} value={o.id}>{o.title} ({o.status})</option>)}</Select>{!connection && <small id="outage-help">An outage can only be linked to a ticket with a connection.</small>}</Field></div></>}
      <Field label="Resolution note" hint="Required to resolve or close. Describe the fix and verification, including phone fixes."><Textarea maxLength={20000} required={needsResolution} readOnly={(tech && base.status === 'closed') || reopening} value={draft.resolution} onChange={e => update('resolution', e.target.value)}/></Field>
      {['resolved', 'closed'].includes(base.status) && (!tech || !!(base.customer_feedback ?? '').trim()) && <Field label="Customer feedback" hint={base.status === 'closed' ? 'Recorded feedback is read-only after closure. Historical tickets may have no feedback recorded.' : 'Office staff: record the customer response after repair. Required to close; if not fixed, reopen.'}><Textarea aria-label="Customer feedback" maxLength={20000} required={closing && !tech} readOnly={!feedbackEditable} value={draft.customer_feedback ?? ''} onChange={e => update('customer_feedback', e.target.value)}/></Field>}
      <Field label="Add a note" hint={waiting ? 'Required: explain why this ticket is waiting for a customer or provider.' : 'Add context or a customer update.'}><Textarea maxLength={20000} required={waiting} value={note} onChange={e => setNote(e.target.value)} placeholder="Add an update for the team…"/></Field></fieldset><ErrorNotice error={save.error}/><div className="form-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Submit pending={save.isPending}/></div></form>
    <TicketImages ticketId={ticket.id}/>
    <section className="timeline"><h2>Activity & notes</h2>{events.isPending ? <Loading text="Loading activity…"/> : events.isError ? <><ErrorNotice error={events.error}/><Button variant="outline" onClick={() => void events.refetch()}>Retry activity</Button></> : [...events.data].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(event => <article key={event.id}><span className="timeline-dot"/><div><p>{eventText(event.body)}</p><small>{data.profiles.find(p => p.id === event.actor_id)?.full_name ?? 'Staff member'} · {formatDate(event.created_at)} IST</small></div></article>)}</section>
  </Modal>
}

function TicketImages({ ticketId }: { ticketId: string }) {
  const { api, scope, demo } = useDesk()
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<unknown>()
  const input = useRef<HTMLInputElement>(null)
  const enabled = !demo && !!api.attachments
  const images = useQuery({ ...deskQueryOptions, queryKey: [scope, 'images', ticketId], queryFn: ({ signal }) => api.attachments!(ticketId, signal), enabled, refetchInterval: enabled ? 30_000 : false })
  const upload = useAction(async (selected: File) => {
    try { await api.uploadImage!(ticketId, selected) }
    finally { setFile(null); if (input.current) input.current.value = '' }
  }, 'Image uploaded')
  const remove = useAction((id: string) => api.deleteImage!(ticketId, id), 'Image deleted')
  const pending = upload.isPending || remove.isPending
  const full = (images.data?.length ?? 0) >= 6
  return <section className="ticket-images" aria-labelledby="ticket-images-title" aria-busy={pending}>
    <div className="spread"><h2 id="ticket-images-title">Images</h2>{enabled && <span className="muted">{images.data?.length ?? 0} / 6 images</span>}</div>
    <p id="ticket-images-help" className="muted">JPEG, PNG or WebP · Up to 5 MB each · Maximum 6 per ticket.</p>
    {demo ? <p className="notice">Images are disabled in demo. No files are uploaded and no live image requests are made.</p> : !enabled ? <p className="notice">Images are unavailable in this workspace.</p> : <>
      <p className="muted">Active company members with access to this ticket can view its images. Technicians can access images only on assigned tickets. Downloads are served through the protected server proxy.</p>
      {images.isPending ? <Loading text="Loading images…"/> : images.isError ? <><ErrorNotice error={images.error}/><Button type="button" variant="outline" onClick={() => void images.refetch()}>Retry images</Button></> : <>
        {!images.data.length && <p className="muted">No images attached yet.</p>}
        <ul className="image-grid">{images.data.map((image, index) => <li className="image-card" key={image.id}>
          <ImagePreview url={image.url} index={index}/>
          <small>Added {formatDate(image.created_at)} IST</small>
          <Button type="button" variant="outline" size="sm" aria-label={`Delete image ${index + 1}`} disabled={pending || !api.deleteImage} onClick={() => { setError(undefined); upload.reset(); remove.mutate(image.id) }}>{remove.isPending && remove.variables === image.id ? 'Deleting…' : 'Delete image'}</Button>
        </li>)}</ul>
      </>}
      <div className="image-upload">
        <label htmlFor="ticket-image-file">Choose ticket image</label>
        <Input ref={input} id="ticket-image-file" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="ticket-images-help" disabled={pending || full || !api.uploadImage || !images.isSuccess} onChange={event => {
          const selected = event.target.files?.[0]
          setFile(null); setError(undefined); upload.reset(); remove.reset()
          if (!selected) return
          const invalid = imageFileError(selected)
          if (invalid) { setError(new Error(invalid)); event.target.value = ''; return }
          setFile(selected)
        }}/>
        {full && <p role="status">This ticket has 6 images. Delete an image before uploading another.</p>}
        <Button type="button" disabled={!file || pending || full || !images.isSuccess || !api.uploadImage} onClick={() => { if (file) upload.mutate(file) }}>{upload.isPending ? 'Uploading…' : 'Upload image'}</Button>
      </div>
      <ErrorNotice error={error || upload.error || remove.error}/>
      {upload.isError && <p className="muted">Check the image list before retrying an unconfirmed upload. <button className="text-link" type="button" onClick={() => void images.refetch()}>Refresh images</button></p>}
    </>}
  </section>
}

function ImagePreview({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false)
  return failed ? <p role="status">Image {index + 1} could not be loaded. Check your access or refresh the ticket.</p> : <a href={url} target="_blank" rel="noreferrer" aria-label={`Open image ${index + 1} in a new tab`}><img src={url} alt={`Ticket attachment ${index + 1}`} loading="lazy" onError={() => setFailed(true)}/></a>
}