import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assignmentIds } from './assignments.js'
import { companyWrite, now } from './database.js'
import { demand, uuid } from './schema.js'

// Called within the ticket transaction: no notification for a rolled-back write.
export async function notifyAssignments(db, user, ticket, previous, kind, options) {
  const prior = new Set(assignmentIds(previous))
  const recipients = assignmentIds(ticket.assigned_to).filter(id => !prior.has(id))
  if (!recipients.length) return
  const created_at = now()
  await db.collection('notifications').insertMany(recipients.map(recipient_id => ({
    id: randomUUID(), company_id: user.company_id, recipient_id, ticket_id: ticket.id,
    ticket_number: ticket.number, kind, created_at, read_at: null,
  })), options)
}

export function installNotifications(app, { db, client }) {
  app.get('/api/notifications', async (req, res) => {
    const scope = { company_id: req.auth.user.company_id, recipient_id: req.auth.user.id }
    // References only: no customer details or ticket text exposed after reassignment.
    const items = await db.collection('notifications').find(scope, { projection: { _id: 0 } })
      .sort({ created_at: -1, id: -1 }).limit(100).toArray()
    const unread_count = await db.collection('notifications').countDocuments({ ...scope, read_at: null })
    res.json({ items, unread_count })
  })
  app.post('/api/notifications/read', async (req, res) => {
    const { id } = z.strictObject({ id: uuid.optional() }).parse(req.body)
    await companyWrite(client, db, req.auth, async (user, options) => {
      const scope = { company_id: user.company_id, recipient_id: user.id, ...(id ? { id } : {}) }
      if (id) demand(await db.collection('notifications').findOne(scope, options), 404, 'Notification unavailable')
      await db.collection('notifications').updateMany({ ...scope, read_at: null }, { $set: { read_at: now() } }, options)
    })
    res.json({ ok: true })
  })
}