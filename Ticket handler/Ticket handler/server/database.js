import { randomUUID } from 'node:crypto'
import { demand } from './schema.js'
import { assignmentIds } from './assignments.js'
import { validSession } from './security.js'

export const profileFields = { _id: 0, id: 1, company_id: 1, full_name: 1, role: 1, active: 1, must_change_password: 1 }
export const publicProfile = user => Object.fromEntries(Object.keys(profileFields).filter(k => k !== '_id').map(k => [k, user[k]]))
export const now = () => new Date().toISOString()
export const providers = [{ id: 'niss', name: 'NISS' }, { id: 'jio', name: 'Jio' }, { id: 'airtel', name: 'Airtel' }, { id: 'bsnl', name: 'BSNL' }]

export async function initializeDatabase(db) {
  // Dedicated dsa_service_desk database: never touch other applications' collections.
  for (const name of ['companies', 'users', 'customers', 'connections', 'tickets', 'events', 'outages', 'images', 'staff_audit']) {
    await db.collection(name).createIndex({ id: 1 }, { unique: true })
    if (name !== 'companies') await db.collection(name).createIndex({ company_id: 1 })
  }
  await db.collection('users').createIndex({ email: 1 }, { unique: true })
  await db.collection('connections').createIndex({ company_id: 1, provider_id: 1, account_number: 1 }, { unique: true })
  await db.collection('tickets').createIndex({ company_id: 1, number: 1 }, { unique: true })
  await db.collection('tickets').createIndex({ company_id: 1, assigned_to: 1 })
  await db.collection('events').createIndex({ company_id: 1, ticket_id: 1, created_at: 1 })
  await db.collection('events').createIndex({ company_id: 1, created_at: 1 })
  await db.collection('images').createIndex({ company_id: 1, ticket_id: 1 })
  await db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
  await db.collection('rate_limits').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
}

export async function transaction(client, work) {
  const session = client.startSession()
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 }) }
  finally { await session.endSession() }
}

// Every company mutation writes the same company lock in a transaction. This
// serializes role changes, password invalidation, relationship checks and writes.
// Re-read the actor AFTER acquiring it; never trust a request's earlier profile.
export async function companyWrite(client, db, auth, work, allowPasswordGate = false) {
  return transaction(client, async session => {
    const options = { session }
    const lock = await db.collection('companies').updateOne({ id: auth.user.company_id }, { $inc: { revision: 1 } }, options)
    demand(lock.matchedCount, 403, 'Company unavailable')
    const user = await db.collection('users').findOne({ id: auth.user.id, company_id: auth.user.company_id }, options)
    const login = await db.collection('sessions').findOne({ _id: auth.tokenHash, ...validSession() }, options)
    demand(user?.active && login && login.auth_version === user.auth_version, 401, 'Session expired. Sign in again')
    demand(allowPasswordGate || !user.must_change_password, 403, 'Change your temporary password first')
    return work(user, options)
  })
}
export function ticketFilter(user, id) { return { company_id: user.company_id, ...(id ? { id } : {}), ...(user.role === 'technician' ? { assigned_to: user.id } : {}) } }
export async function findTicket(db, user, id, options = {}) {
  const ticket = await db.collection('tickets').findOne(ticketFilter(user, id), options)
  demand(ticket, 404, 'Ticket unavailable')
  return ticket
}
export function office(user) { demand(['owner', 'office'].includes(user.role), 403, 'Office access required') }
export async function event(db, user, ticket_id, body, options) {
  await db.collection('events').insertOne({ id: randomUUID(), company_id: user.company_id, ticket_id, actor_id: user.id, body: JSON.stringify(body), created_at: now() }, options)
}
export async function audit(db, user, action, target_id, options) {
  await db.collection('staff_audit').insertOne({ id: randomUUID(), company_id: user.company_id, actor_id: user.id, target_id, action, created_at: now() }, options)
}
export async function references(db, user, input, options = {}, checkAssignee = true) {
  const scope = { company_id: user.company_id }
  const connection = input.connection_id == null ? null : await db.collection('connections').findOne({ ...scope, id: input.connection_id }, options)
  if (input.connection_id != null) demand(connection, 404, 'Connection unavailable')
  const assignees = assignmentIds(input.assigned_to)
  if (checkAssignee && assignees.length) {
    const count = await db.collection('users').countDocuments({ ...scope, id: { $in: assignees }, active: true, role: 'technician' }, options)
    demand(count === assignees.length, 400, 'Assignees must be active technicians in this company')
  }
  if (input.outage_id) {
    demand(connection, 400, 'A connection is required to link an outage')
    demand(await db.collection('outages').findOne({ ...scope, id: input.outage_id, provider_id: connection.provider_id }, options), 400, 'Choose an outage for this provider in this company')
  }
}