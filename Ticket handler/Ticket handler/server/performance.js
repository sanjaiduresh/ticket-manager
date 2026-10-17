import { z } from 'zod'
import { demand } from './schema.js'
import { transaction, profileFields } from './database.js'
import { assignmentIds } from './assignments.js'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Enter a valid calendar date')
const rangeSchema = z.strictObject({ from: day, to: day })
export function performanceRange(query) {
  const { from, to } = rangeSchema.parse(query)
  const start = Date.parse(`${from}T00:00:00+05:30`)
  const end = Date.parse(`${to}T00:00:00+05:30`) + 86400000
  demand(end > start && end - start <= 366 * 86400000, 400, 'Choose an ordered date range of at most 366 days')
  return { from, to, start, end }
}

// Activity is attributed to the immutable audit actor, NOT today's assignee.
// All outcome counters are distinct tickets; repeated feedback edits never inflate them.
export function performanceMetrics(profiles, tickets, events, range, timestamp = Date.now()) {
  const ticketMap = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const buckets = new Map(profiles.map(profile => [profile.id, {
    profile, created: new Set(), resolved: new Map(), closed: new Set(), feedback: new Set(),
    open: 0, overdue: 0, awaiting: 0,
  }]))
  for (const ticket of tickets) {
    for (const id of assignmentIds(ticket.assigned_to)) {
      const bucket = buckets.get(id)
      if (!bucket || bucket.profile.company_id !== ticket.company_id) continue
      if (ticket.status === 'resolved') bucket.awaiting++
      if (!['resolved', 'closed'].includes(ticket.status)) {
        bucket.open++
        if (ticket.due_at && Date.parse(ticket.due_at) < timestamp) bucket.overdue++
      }
    }
  }
  for (const event of events) {
    const time = Date.parse(event.created_at)
    if (!(time >= range.start && time < range.end)) continue
    const bucket = buckets.get(event.actor_id)
    const ticket = ticketMap.get(event.ticket_id)
    if (!bucket || !ticket || event.company_id !== ticket.company_id || event.company_id !== bucket.profile.company_id) continue
    let body
    try { body = JSON.parse(event.body) } catch { continue }
    if (!body || typeof body !== 'object') continue
    if (body.action === 'created') bucket.created.add(ticket.id)
    if (body.action !== 'updated') continue
    const change = body.changes?.status
    if (change?.to === 'resolved' && change.from !== 'resolved') {
      const previous = bucket.resolved.get(ticket.id)
      if (previous === undefined || time > previous) bucket.resolved.set(ticket.id, time)
    }
    if (change?.to === 'closed' && change.from !== 'closed') bucket.closed.add(ticket.id)
    const feedback = body.changes?.customer_feedback
    if (typeof feedback?.to === 'string' && feedback.to.trim() && feedback.to !== feedback.from) bucket.feedback.add(ticket.id)
  }
  const employees = [...buckets.values()].map(bucket => {
    const hours = [...bucket.resolved].flatMap(([id, time]) => {
      const created = Date.parse(ticketMap.get(id).created_at)
      return Number.isFinite(created) && time >= created ? [(time - created) / 3600000] : []
    }).sort((a, b) => a - b)
    const middle = Math.floor(hours.length / 2)
    const median = hours.length ? hours.length % 2 ? hours[middle] : (hours[middle - 1] + hours[middle]) / 2 : null
    const { id, full_name, role, active } = bucket.profile
    return { id, full_name, role, active, open_assigned: bucket.open, overdue_assigned: bucket.overdue,
      awaiting_feedback_assigned: bucket.awaiting, created: bucket.created.size, resolved: bucket.resolved.size,
      closed: bucket.closed.size, feedback_recorded: bucket.feedback.size, median_resolution_hours: median }
  }).sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id))
  return { from: range.from, to: range.to, generated_at: new Date(timestamp).toISOString(), employees }
}

export function installPerformance(app, { db, client }) {
  app.get('/api/reports/performance', async (req, res) => {
    demand(req.auth.user.role === 'owner', 403, 'Only the company owner can view employee performance')
    const range = performanceRange(req.query)
    const report = await transaction(client, async session => {
      // Recheck membership/session version in the same snapshot as reporting reads.
      const owner = await db.collection('users').findOne({ id: req.auth.user.id, company_id: req.auth.user.company_id,
        role: 'owner', active: true, must_change_password: false, auth_version: req.auth.user.auth_version }, { session })
      demand(owner, 403, 'Only the company owner can view employee performance')
      const scope = { company_id: owner.company_id }
      const profiles = await db.collection('users').find(scope, { session, projection: profileFields }).toArray()
      const tickets = await db.collection('tickets').find(scope, { session, projection: { _id: 0, id: 1, company_id: 1, assigned_to: 1, status: 1, due_at: 1, created_at: 1 } }).toArray()
      const events = await db.collection('events').find({ ...scope, created_at: { $gte: new Date(range.start).toISOString(), $lt: new Date(range.end).toISOString() } },
        { session, projection: { _id: 0, company_id: 1, ticket_id: 1, actor_id: 1, body: 1, created_at: 1 } }).toArray()
      return performanceMetrics(profiles, tickets, events, range)
    })
    res.json(report)
  })
}