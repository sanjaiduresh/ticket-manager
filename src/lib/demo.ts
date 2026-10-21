import type { DataApi, Dataset, Profile, Ticket, TicketEvent, AttendanceRecord, AssignmentNotification } from './types'
import { computeDemoPerformance, istDate, rangeError } from './reporting'
import { assigneeIds, sameAssignees } from './assignees'
import { whatsappNumberError } from './whatsapp'

const company_id = 'demo-company'
export const demoOwner: Profile = { company_id, id: 'demo-owner', full_name: 'Ananya Rao', role: 'owner', active: true, must_change_password: false }
export function createDemoApi(actorId = demoOwner.id): DataApi {
  const now = Date.now()
  const time = (hours: number) => new Date(now + hours * 3_600_000).toISOString()
  const dataset: Dataset = {
    companies: [{ id: company_id, name: 'DSA Demo Networks', created_at: time(-240) }],
    providers: [{ id: 'niss', name: 'NISS' }, { id: 'jio', name: 'Jio' }, { id: 'airtel', name: 'Airtel' }, { id: 'bsnl', name: 'BSNL' }],
    profiles: [{ ...demoOwner }, { company_id, id: 'demo-office', full_name: 'Kavya Menon', role: 'office', active: true, must_change_password: false },
      { company_id, id: 'demo-tech-1', full_name: 'Arun Kumar', role: 'technician', active: true, must_change_password: false },
      { company_id, id: 'demo-tech-2', full_name: 'Meera Das', role: 'technician', active: true, must_change_password: false }],
    customers: ['Ravi Iyer', 'Priya Nair', 'Mohan Stores', 'Leela Thomas', 'Dev Shah'].map((full_name, i) => ({
      company_id, id: `demo-c-${i}`, full_name, phone: `000000000${i}`, address: `${i + 12}, Example Street, Fictional Town`,
      area: ['Anna Nagar', 'West Park', 'Anna Nagar', 'Lake Road', 'West Park'][i], created_at: time(-240),
    })),
    connections: (['niss', 'jio', 'airtel', 'bsnl', 'niss'] as const).map((provider_id, i) => ({
      company_id, id: `demo-cn-${i}`, customer_id: `demo-c-${i}`, provider_id, account_number: `DEMO-${1001 + i}`, network_node: `BOX-${i + 10}`,
    })),
    outages: [{ company_id, id: 'demo-outage', provider_id: 'jio', area: 'West Park', title: 'Upstream fibre maintenance — intermittent connectivity', status: 'active', created_at: time(-3), restored_at: null }],
    tickets: [
      ['No internet since this morning', 'new', 'high', 0, null, 'No internet'],
      ['Frequent disconnections after maintenance', 'waiting_provider', 'high', 1, 'demo-tech-1', 'Intermittent'],
      ['Red LOS light on optical terminal', 'assigned', 'urgent', 2, ['demo-tech-1', 'demo-tech-2'], 'LOS / fibre cut'],
      ['Slow speeds during evening hours', 'in_progress', 'normal', 3, 'demo-tech-1', 'Slow speed'],
      ['Router restarts every few hours', 'new', 'normal', 4, null, 'Router'],
      ['Wi-Fi coverage in upstairs room', 'waiting_customer', 'low', 0, 'demo-tech-2', 'Router'],
      ['Connection drops during video calls', 'resolved', 'normal', 1, 'demo-tech-1', 'Intermittent'],
      ['Replace damaged fibre patch cord', 'closed', 'normal', 2, 'demo-tech-2', 'LOS / fibre cut'],
    ].map((row, i) => ({
      company_id, id: `demo-t-${i}`, number: 1042 + i, connection_id: `demo-cn-${row[3]}`, title: String(row[0]), status: row[1] as Dataset['tickets'][number]['status'],
      priority: row[2] as Dataset['tickets'][number]['priority'], assigned_to: row[4] as Ticket['assigned_to'], category: String(row[5]),
      description: 'Customer reported a service issue. Verify the optical signal and connection before arranging a visit.',
      outage_id: i === 1 ? 'demo-outage' : null, provider_reference: i === 1 ? 'DEMO-JIO-4821' : '',
      due_at: time(i === 2 ? -1 : 6 + i), visit_at: i === 2 ? time(2) : null, follow_up_at: i === 1 ? time(1) : null,
      resolution: i >= 6 ? 'Replaced the patch cord and verified stable connectivity with the customer.' : '',
      customer_feedback: i === 7 ? 'Fictional customer confirmed stable service after the patch cord replacement.' : '',
      created_at: time(-i * 5 - 2), updated_at: time(-1), version: 1,
    })),
  }
  const events: TicketEvent[] = dataset.tickets.map(ticket => ({ company_id, id: crypto.randomUUID(), ticket_id: ticket.id, actor_id: demoOwner.id, body: JSON.stringify({ action: 'created' }), created_at: ticket.created_at }))
  const attendance: AttendanceRecord[] = []
  const deletedTickets = new Map<string, { version: number; confirmation: string; reason: string }>()
  let ticketSequence = Math.max(0, ...dataset.tickets.map(ticket => ticket.number))
  const notifications: AssignmentNotification[] = []
  function notify(ticket: Ticket, previous: Ticket['assigned_to'], kind: AssignmentNotification['kind']) {
    for (const recipient_id of assigneeIds(ticket.assigned_to).filter(id => !assigneeIds(previous).includes(id))) {
      notifications.push({ id: crypto.randomUUID(), company_id, recipient_id, ticket_id: ticket.id, ticket_number: ticket.number, kind, created_at: new Date().toISOString(), read_at: null })
    }
  }
  dataset.tickets.forEach(ticket => notify(ticket, [], 'created'))
  const clone = <T,>(v: T): T => structuredClone(v)
  function actor() {
    const profile = dataset.profiles.find(p => p.id === actorId && p.company_id === company_id)
    if (!profile?.active || profile.must_change_password) throw new Error('Active staff access required')
    return profile
  }
  function office() { if (actor().role === 'technician') throw new Error('Office or owner access required') }
  function accessible(ticket: Ticket) { return actor().role !== 'technician' || assigneeIds(ticket.assigned_to).includes(actorId) }
  function normalized(value: Ticket['assigned_to']) {
    if (value !== null && typeof value !== 'string' && !Array.isArray(value)) throw new Error('Invalid assignees')
    if ((Array.isArray(value) ? value : value === null ? [] : [value]).some(id => typeof id !== 'string' || !id)) throw new Error('Invalid assignees')
    const ids = assigneeIds(value)
    if (ids.length > 50) throw new Error('Select at most 50 technicians')
    return ids
  }
  function checkReferences(input: { connection_id?: string | null; assigned_to?: Ticket['assigned_to']; outage_id?: string | null }) {
    if (input.connection_id != null && !dataset.connections.some(c => c.company_id === company_id && c.id === input.connection_id)) throw new Error('Connection unavailable in this company')
    if (assigneeIds(input.assigned_to).some(id => !dataset.profiles.some(p => p.company_id === company_id && p.id === id && p.active && p.role === 'technician'))) throw new Error('Assignee must be an active technician in this company')
    if (input.outage_id && !dataset.outages.some(o => o.company_id === company_id && o.id === input.outage_id)) throw new Error('Outage unavailable in this company')
    if (input.outage_id && !input.connection_id) throw new Error('An outage requires a linked connection')
    if (input.outage_id && dataset.outages.find(o => o.id === input.outage_id)?.provider_id !== dataset.connections.find(c => c.id === input.connection_id)?.provider_id) throw new Error('Outage must match the connection provider')
  }
  return {
    async attendance(range) {
      const user = actor(); const error = rangeError(range)
      if (error) throw new Error(error)
      return clone({ ...range, generated_at: new Date().toISOString(),
        records: attendance.filter(record => (user.role !== 'technician' || record.employee_id === actorId) && record.day >= range.from && record.day <= range.to).sort((a, b) => b.day.localeCompare(a.day)) })
    },
    async saveAttendance(input) {
      office()
      const value = clone(input)
      const error = rangeError({ from: value.day, to: value.day })
      if (error || value.day > istDate()) throw new Error(error || 'Attendance cannot be recorded for a future day')
      if (!dataset.profiles.some(p => p.id === value.employee_id)) throw new Error('Employee unavailable')
      if (!['present', 'absent', 'half_day', 'leave'].includes(value.status) || !Number.isInteger(value.version) || value.version < 0) throw new Error('Invalid attendance status or version')
      if (typeof value.note !== 'string' || value.note.trim().length > 2000) throw new Error('Notes must be text up to 2000 characters')
      value.note = value.note.trim()
      for (const key of ['check_in', 'check_out'] as const) {
        if (value[key] !== null) {
          if (!Number.isFinite(Date.parse(value[key]!))) throw new Error('Invalid attendance time')
          value[key] = new Date(value[key]!).toISOString()
          if (Date.parse(value[key]) > Date.now()) throw new Error('Attendance times cannot be in the future')
        }
      }
      if (['absent', 'leave'].includes(value.status) && (value.check_in || value.check_out)) throw new Error('Absent and leave records cannot have attendance times')
      if (value.check_in && istDate(value.check_in) !== value.day) throw new Error('Check-in must fall on the attendance day in IST')
      if (value.check_out && (!value.check_in || value.check_out < value.check_in)) throw new Error('Check-out requires a check-in and cannot be earlier')
      const prior = attendance.find(record => record.id === value.id)
      if (prior) {
        if (prior.employee_id !== value.employee_id || prior.day !== value.day) throw new Error('Employee and attendance day cannot be changed')
        const unchanged = Object.entries(value).filter(([key]) => key !== 'version').every(([key, field]) => prior[key as keyof AttendanceRecord] === field)
        if (unchanged && prior.updated_by === actorId && prior.version === value.version + 1) return
        if (prior.version !== value.version) throw new Error('Attendance changed. Reload the record before saving')
        if (unchanged) return
      } else {
        if (value.version !== 0) throw new Error('Attendance record unavailable')
        if (attendance.some(record => record.employee_id === value.employee_id && record.day === value.day)) throw new Error('Attendance already exists for this employee and day. Edit the existing record')
      }
      const next = { ...value, company_id, version: value.version + 1, recorded_by: prior?.recorded_by ?? actorId, updated_by: actorId, updated_at: new Date().toISOString() }
      if (prior) Object.assign(prior, next)
      else attendance.push(next)
    },
    async notifications() {
      actor(); const items = notifications.filter(item => item.recipient_id === actorId)
      return clone({ items: items.slice().reverse().slice(0, 100), unread_count: items.filter(item => !item.read_at).length })
    },
    async readNotifications(id) {
      actor()
      if (id && !notifications.some(item => item.id === id && item.recipient_id === actorId)) throw new Error('Notification unavailable')
      notifications.filter(item => item.recipient_id === actorId && (!id || item.id === id)).forEach(item => { item.read_at ??= new Date().toISOString() })
    },
    async performance(range) { if (actor().role !== 'owner') throw new Error('Owner access required'); return computeDemoPerformance(dataset, events, range) },
    async load() {
      if (actor().role !== 'technician') return clone(dataset)
      const tickets = dataset.tickets.filter(accessible)
      const connections = dataset.connections.filter(c => tickets.some(t => t.connection_id === c.id))
      return clone({ ...dataset, profiles: dataset.profiles.map(({ whatsapp_number: _phone, ...profile }) => profile), tickets, connections, customers: dataset.customers.filter(c => connections.some(connection => connection.customer_id === c.id)), outages: dataset.outages.filter(o => tickets.some(t => t.outage_id === o.id)) })
    },
    async profile(id) { const p = dataset.profiles.find(p => p.id === id); if (!p) throw new Error('Profile unavailable'); const { whatsapp_number: _phone, ...publicProfile } = p; return clone(publicProfile) },
    async events(id) { if (!dataset.tickets.some(t => t.id === id && accessible(t))) throw new Error('Ticket unavailable'); return clone(events.filter(e => e.ticket_id === id)) },
    async createCustomer(input) {
      office()
      if (dataset.connections.some(c => c.provider_id === input.provider_id && c.account_number === input.account_number)) throw new Error('This provider/account number already exists.')
      const { provider_id, account_number, network_node, ...customer } = input
      const id = crypto.randomUUID(); const connectionId = crypto.randomUUID()
      dataset.customers.push({ ...customer, company_id, id, created_at: time(0) })
      dataset.connections.push({ company_id, id: connectionId, customer_id: id, provider_id, account_number, network_node })
      return connectionId
    },
    async createTicket(input) {
      office()
      if (deletedTickets.has(input.id)) throw new Error('This ticket was permanently deleted. Create a new ticket instead')
      const assigned_to = normalized(input.assigned_to)
      checkReferences({ ...input, assigned_to })
      if (dataset.tickets.some(t => t.id === input.id)) return
      dataset.tickets.push({ ...clone(input), assigned_to, connection_id: input.connection_id ?? null, company_id, number: ++ticketSequence, status: assigned_to.length ? 'assigned' : 'new',
        provider_reference: '', visit_at: null, follow_up_at: null, resolution: '', customer_feedback: '', created_at: time(0), updated_at: time(0), version: 1 })
      events.push({ company_id, id: crypto.randomUUID(), ticket_id: input.id, actor_id: actorId, body: JSON.stringify({ action: 'created' }), created_at: time(0) })
      notify(dataset.tickets.at(-1)!, [], 'created')
    },
    async updateTicket(id, version, patch, note) {
      const ticket = dataset.tickets.find(t => t.id === id)
      if (!ticket || !accessible(ticket)) throw new Error('Ticket unavailable')
      if (ticket.version !== version) throw new Error('Ticket changed; reload before saving')
      if (!Object.keys(patch).length && !note.trim()) throw new Error('Provide a change or note')
      const tech = actor().role === 'technician'
      const allowed = tech ? ['status', 'resolution'] : ['status', 'title', 'description', 'priority', 'assigned_to', 'outage_id', 'provider_reference', 'due_at', 'visit_at', 'follow_up_at', 'resolution', 'customer_feedback']
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Field change not permitted')
      if (tech && patch.status !== undefined && patch.status !== ticket.status && (['resolved', 'closed'].includes(ticket.status) || !['in_progress', 'waiting_customer', 'waiting_provider', 'resolved'].includes(patch.status))) throw new Error('Technician status change not permitted')
      if (tech && ticket.status === 'closed' && patch.resolution !== undefined) throw new Error('Closed resolution is read-only')
      const next = { ...ticket, ...clone(patch), assigned_to: normalized('assigned_to' in patch ? patch.assigned_to! : ticket.assigned_to), company_id }
      checkReferences({ connection_id: next.connection_id, outage_id: next.outage_id })
      const changedStatus = next.status !== ticket.status
      const reopening = changedStatus && ['resolved', 'closed'].includes(ticket.status) && next.status !== 'closed'
      if ('customer_feedback' in patch) {
        if (ticket.status !== 'resolved' || !['resolved', 'closed'].includes(next.status)) throw new Error('Customer feedback can only be recorded after resolution and before closure')
        if (typeof patch.customer_feedback !== 'string' || patch.customer_feedback.length > 20000) throw new Error('Customer feedback must be text up to 20000 characters')
      }
      if (changedStatus && next.status === 'closed' && ticket.status !== 'resolved') throw new Error('Resolve the ticket before closing it')
      if (changedStatus && next.status === 'closed' && !(next.customer_feedback ?? '').trim()) throw new Error('Customer feedback is required before closing this ticket.')
      if (changedStatus && next.status === 'resolved') next.customer_feedback = ''
      if (reopening) {
        if (!['new', 'assigned', 'in_progress'].includes(next.status)) throw new Error('Reopen to new, assigned or in progress first')
        next.resolution = ''
        next.customer_feedback = ''
      }
      if (changedStatus && ['waiting_customer', 'waiting_provider'].includes(next.status) && !note.trim()) throw new Error('Provide a waiting reason in the note')
      if (!sameAssignees(next.assigned_to, ticket.assigned_to) || reopening) checkReferences({ assigned_to: next.assigned_to })
      if (['resolved', 'closed'].includes(next.status) && !next.resolution.trim()) throw new Error('A resolution note is required to resolve or close this ticket.')
      if (next.status === 'new' && next.assigned_to.length) next.status = 'assigned'
      if (next.status === 'assigned' && !next.assigned_to.length) next.status = 'new'
      if (next.status === 'in_progress' && !next.assigned_to.length) throw new Error('Assign a technician before starting work.')
      const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => key === 'assigned_to' ? !sameAssignees(next.assigned_to, ticket.assigned_to) : value !== ticket[key as keyof typeof ticket]).map(([key, value]) => [key, { from: ticket[key as keyof typeof ticket], to: value }]))
      notify(next, ticket.assigned_to, 'assigned')
      Object.assign(ticket, next, { version: version + 1, updated_at: time(0) })
      events.push({ company_id, id: crypto.randomUUID(), ticket_id: id, actor_id: actorId, body: JSON.stringify({ action: 'updated', changes }), created_at: time(0) })
      if (note.trim()) events.push({ company_id, id: crypto.randomUUID(), ticket_id: id, actor_id: actorId, body: JSON.stringify({ action: 'note', text: note.trim() }), created_at: time(0) })
    },
    async deleteTicket(id, version, confirmation, reason) {
      office()
      reason = reason.trim()
      if (!reason || reason.length > 500) throw new Error('Provide a deletion reason up to 500 characters')
      const prior = deletedTickets.get(id)
      if (prior) {
        if (prior.version !== version || prior.confirmation !== confirmation || prior.reason !== reason) throw new Error('Ticket already deleted; the deletion request does not match')
        return
      }
      const index = dataset.tickets.findIndex(ticket => ticket.id === id)
      if (index < 0) throw new Error('Ticket unavailable')
      const ticket = dataset.tickets[index]
      if (ticket.version !== version) throw new Error('Ticket changed. Reload before deleting')
      if (confirmation !== `DSA-${ticket.number}`) throw new Error('Type the exact ticket reference to confirm deletion')
      deletedTickets.set(id, { version, confirmation, reason })
      dataset.tickets.splice(index, 1)
      for (let i = events.length - 1; i >= 0; i--) if (events[i].ticket_id === id) events.splice(i, 1)
      for (let i = notifications.length - 1; i >= 0; i--) if (notifications[i].ticket_id === id) notifications.splice(i, 1)
    },
    async createOutage(input) { office(); dataset.outages.push({ ...input, company_id, id: crypto.randomUUID(), status: 'active', created_at: time(0), restored_at: null }) },
    async restoreOutage(id) { office(); const outage = dataset.outages.find(o => o.id === id); if (outage) Object.assign(outage, { status: 'restored', restored_at: time(0) }) },
    async staff(input) {
      if (input.action !== 'change_password' && actor().role !== 'owner') throw new Error('Owner access required')
      if ('whatsapp_number' in input && input.whatsapp_number !== undefined && whatsappNumberError(input.whatsapp_number)) throw new Error(whatsappNumberError(input.whatsapp_number))
      if (input.action === 'create') dataset.profiles.push({ company_id, id: crypto.randomUUID(), full_name: input.full_name, role: input.role, whatsapp_number: input.whatsapp_number?.trim() ?? '', active: true, must_change_password: true })
      else if (input.action === 'change_password') return // Simulation only; never retain demo passwords.
      else {
        const profile = dataset.profiles.find(p => p.id === input.id)
        if (!profile) throw new Error('Staff member unavailable')
        if (profile.role === 'owner') throw new Error('Owner changes are not supported here.')
        if (input.action === 'set_whatsapp') profile.whatsapp_number = input.whatsapp_number.trim()
        else if (input.action === 'reset_password') profile.must_change_password = true
        else { if (input.role) profile.role = input.role; if (input.active !== undefined) profile.active = input.active }
      }
    },
  }
}