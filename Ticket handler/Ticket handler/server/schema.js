import { z } from 'zod'
import { assignmentIds } from './assignments.js'

const text = (max, min = 0) => z.string().trim().min(min).max(max).refine(v => !v.includes('\0'), 'NUL characters are not allowed')
export const uuid = z.uuid()
// Bound transport work as well as the number of unique selected technicians.
const assignment = z.union([uuid, z.null(), z.array(uuid).max(100)])
  .transform(assignmentIds).refine(ids => ids.length <= 50, 'Select at most 50 technicians')
export const password = z.string().refine(v => [...v].length >= 12 && Buffer.byteLength(v, 'utf8') <= 256 && !v.includes('\0'), 'Use at least 12 characters and at most 256 UTF-8 bytes')
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email())
const provider = z.enum(['jio', 'airtel', 'bsnl', 'niss'])
const priority = z.enum(['low', 'normal', 'high', 'urgent'])
const status = z.enum(['new', 'assigned', 'in_progress', 'waiting_customer', 'waiting_provider', 'resolved', 'closed'])
const date = z.iso.datetime({ offset: true }).nullable()
export const registerSchema = z.strictObject({ company_name: text(200, 1), full_name: text(200, 1), email, password })
export const loginSchema = z.strictObject({ email, password: z.string().min(1).max(256) })
export const customerSchema = z.strictObject({ full_name: text(200, 1), phone: text(40, 1), address: text(2000, 1), area: text(200, 1), provider_id: provider, account_number: text(200, 1), network_node: text(200).default('') })
export const ticketSchema = z.strictObject({ id: uuid, connection_id: uuid.nullable().default(null), title: text(500, 1), description: text(20000), category: text(200, 1), priority, assigned_to: assignment, due_at: date, outage_id: uuid.nullable() })
export const updateSchema = z.strictObject({ version: z.number().int().positive(), patch: z.strictObject({ status, title: text(500, 1), description: text(20000), priority, assigned_to: assignment, outage_id: uuid.nullable(), provider_reference: text(500), due_at: date, visit_at: date, follow_up_at: date, resolution: text(20000), customer_feedback: text(20000) }).partial(), note: text(20000) })
export const outageSchema = z.strictObject({ provider_id: provider, area: text(200, 1), title: text(500, 1) })
export const staffSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), full_name: text(200, 1), email, password, role: z.enum(['office', 'technician']) }),
  z.strictObject({ action: z.literal('update'), id: uuid, role: z.enum(['office', 'technician']).optional(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('reset_password'), id: uuid, password }),
  z.strictObject({ action: z.literal('change_password'), password }),
])

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export function demand(condition, status, message) { if (!condition) throw new HttpError(status, message) }
export function ticketTransition(ticket, patch, note, actor) {
  demand(Object.keys(patch).length || note, 400, 'Provide a change or note')
  const tech = actor.role === 'technician'
  if (tech) {
    demand(Object.keys(patch).every(key => ['status', 'resolution'].includes(key)), 403, 'Technicians may only update status, resolution and notes')
    demand(!['resolved', 'closed'].includes(ticket.status) || !Object.keys(patch).length, 403, 'Only office staff can change resolved tickets')
    demand(!patch.status || patch.status === ticket.status || ['in_progress', 'waiting_customer', 'waiting_provider', 'resolved'].includes(patch.status), 403, 'Status change not allowed')
  }
  const next = { ...ticket, customer_feedback: ticket.customer_feedback ?? '', ...patch }
  next.assigned_to = assignmentIds(next.assigned_to)
  const changed = next.status !== ticket.status
  const reopening = changed && ['resolved', 'closed'].includes(ticket.status) && next.status !== 'closed'
  if ('customer_feedback' in patch) {
    demand(['owner', 'office'].includes(actor.role), 403, 'Only office staff can record customer feedback')
    demand(ticket.status === 'resolved' && ['resolved', 'closed'].includes(next.status), 400, 'Record customer feedback after resolution and before closure')
  }
  if (changed && next.status === 'closed') {
    demand(['owner', 'office'].includes(actor.role), 403, 'Only office staff can close tickets')
    demand(ticket.status === 'resolved', 400, 'Resolve the ticket before closing it')
    demand(next.customer_feedback.trim(), 400, 'Contact the customer and record their feedback before closing this ticket')
  }
  if (reopening) { demand(['new', 'assigned', 'in_progress'].includes(next.status), 400, 'Reopen to new, assigned or in progress first'); next.resolution = ''; next.customer_feedback = '' }
  if (changed && next.status === 'resolved') next.customer_feedback = ''
  if (changed && ['waiting_customer', 'waiting_provider'].includes(next.status)) demand(note, 400, 'Provide a waiting reason in the note')
  if (['resolved', 'closed'].includes(next.status)) demand(next.resolution.trim(), 400, 'A resolution note is required')
  if (next.status === 'new' && next.assigned_to.length) next.status = 'assigned'
  if (next.status === 'assigned' && !next.assigned_to.length) next.status = 'new'
  demand(next.status !== 'in_progress' || next.assigned_to.length, 400, 'Assign a technician before starting work')
  return { next, reopening }
}