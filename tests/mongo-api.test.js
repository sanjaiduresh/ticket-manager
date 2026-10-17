import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { BSON, MongoClient } from 'mongodb'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createApp } from '../server/app.js'
import { initializeDatabase } from '../server/database.js'
import { cleanupImages, sanitizeImage } from '../server/images.js'
import { digest, limit, verifyPassword } from '../server/security.js'
import { performanceMetrics, performanceRange } from '../server/performance.js'

// No server entrypoint, dotenv, Atlas URI or real media adapter is imported.
// A real replica set supplies snapshot isolation, unique indexes and transaction retries.
const origin = 'http://127.0.0.1:5173'
const password = 'Fictional-test-password-42!'
const newPassword = 'Replacement-test-password-73!'
let replSet, client, db, app, baseline, a, b, tech, otherTech, officeStaff
let connectionA, connectionB, otherConnection, ticketA, ticketB, otherTicket, outageA, outageB
let jpeg, png, webp
const blobs = new Map()
const media = {
  upload: vi.fn(async (buffer, id) => { blobs.set(id, Buffer.from(buffer)) }),
  destroy: vi.fn(async id => { blobs.delete(id) }),
  download: vi.fn(async id => {
    if (!blobs.has(id)) throw new Error('Missing fake image')
    return Buffer.from(blobs.get(id))
  }),
}

function mutate(method, path, actor, body) {
  const req = request(app)[method](path).set('Origin', origin)
  if (actor) req.set('Cookie', actor.cookie)
  return body === undefined ? req : req.send(body)
}
function get(path, actor) {
  const req = request(app).get(path)
  return actor ? req.set('Cookie', actor.cookie) : req
}
function registration(email, extra = {}) {
  return { company_name: 'Fictional Networks', full_name: 'Test Owner', email, password, ...extra }
}
async function login(email, pass = password) {
  const response = await mutate('post', '/api/auth/login', null, { email, password: pass }).expect(200)
  return { ...(await db.collection('users').findOne({ email })), cookie: response.headers['set-cookie'][0].split(';')[0], response }
}
async function owner(email) {
  await mutate('post', '/api/auth/register', null, registration(email)).expect(201)
  return login(email)
}
async function staff(actor, email, role, changePassword = true) {
  await mutate('post', '/api/staff', actor, { action: 'create', full_name: 'Fictional Staff', email, password, role }).expect(200)
  const user = await login(email)
  if (changePassword) await mutate('post', '/api/staff', user, { action: 'change_password', password: newPassword }).expect(200)
  return user
}
async function customer(actor, account, provider = 'jio') {
  const response = await mutate('post', '/api/customers', actor, {
    full_name: `Fictional Customer ${account}`, phone: '5550101234', address: '42 Test Street',
    area: 'Test Area', provider_id: provider, account_number: account, network_node: 'Test Node',
  }).expect(201)
  return db.collection('connections').findOne({ id: response.body.id })
}
function ticketInput(connection, extra = {}) {
  return { id: randomUUID(), connection_id: connection.id, title: 'Fictional connection offline', description: 'Integration test',
    category: 'no_internet', priority: 'normal', assigned_to: null, due_at: null, outage_id: null, ...extra }
}
async function ticket(actor, connection, extra = {}) {
  const input = ticketInput(connection, extra)
  await mutate('post', '/api/tickets', actor, input).expect(201)
  return db.collection('tickets').findOne({ id: input.id })
}
function patch(actor, item, changes, note = '', version = item.version) {
  return mutate('patch', `/api/tickets/${item.id}`, actor, { version, patch: changes, note })
}
function upload(actor, item, buffer = jpeg, contentType = 'image/jpeg') {
  return mutate('post', `/api/tickets/${item.id}/images`, actor)
    .attach('image', buffer, { filename: 'fictional-image', contentType })
}
async function seedImage(item = ticketA, state = 'ready', created_at = new Date().toISOString()) {
  // Seed attachment state for independent read/delete/maintenance tests: upload defects
  // must not hide authorization defects in those endpoints.
  const id = randomUUID()
  const image = { id, company_id: item.company_id, ticket_id: item.id, public_id: `fake/${id}`,
    uploaded_by: a.id, created_at, state }
  await db.collection('images').insertOne(image)
  blobs.set(image.public_id, Buffer.from(webp))
  return image
}
function noMediaCalls() {
  expect(media.upload).not.toHaveBeenCalled()
  expect(media.download).not.toHaveBeenCalled()
  expect(media.destroy).not.toHaveBeenCalled()
}

describe('MongoDB API integration (isolated replica set)', () => {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' } })
    client = new MongoClient(replSet.getUri(), { maxPoolSize: 20, serverSelectionTimeoutMS: 30000 })
    await client.connect()
    db = client.db(`mongo_api_test_${randomUUID().replaceAll('-', '')}`)
    expect((await db.command({ hello: 1 })).setName).toBeTruthy()
    await initializeDatabase(db)
    app = await createApp({ db, client, media, origins: [origin], rateLimits: false })
    a = await owner('owner-a@example.test')
    b = await owner('owner-b@example.test')
    tech = await staff(a, 'technician@example.test', 'technician')
    otherTech = await staff(a, 'other-technician@example.test', 'technician')
    officeStaff = await staff(a, 'office@example.test', 'office')
    connectionA = await customer(a, 'SAME-ACCOUNT')
    connectionB = await customer(b, 'SAME-ACCOUNT')
    otherConnection = await customer(a, 'OTHER-ACCOUNT')
    ticketA = await ticket(a, connectionA, { assigned_to: tech.id })
    ticketB = await ticket(b, connectionB)
    otherTicket = await ticket(a, otherConnection, { assigned_to: otherTech.id })
    for (const actor of [a, b]) await mutate('post', '/api/outages', actor, { provider_id: 'jio', area: 'Test Area', title: 'Fictional outage' }).expect(201)
    outageA = await db.collection('outages').findOne({ company_id: a.company_id })
    outageB = await db.collection('outages').findOne({ company_id: b.company_id })
    jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#3487ab' } }).jpeg().withMetadata().toBuffer()
    png = await sharp({ create: { width: 24, height: 32, channels: 4, background: '#34ab87' } }).png().toBuffer()
    webp = await sharp(png).webp().toBuffer()
    baseline = await Promise.all((await db.listCollections().toArray()).map(async ({ name }) => [name, await db.collection(name).find().toArray()]))
  }, 600000) // Allow first-run MongoDB binary download; never use a hosted fallback.

  beforeEach(async () => {
    // Restore documents, not the database: all production unique/TTL indexes stay active.
    for (const [name, documents] of baseline) {
      await db.collection(name).deleteMany({})
      // structuredClone loses BSON prototypes, turning ObjectId into an ordinary object.
      if (documents.length) await db.collection(name).insertMany(documents.map(document => BSON.deserialize(BSON.serialize(document))))
    }
    blobs.clear()
    vi.clearAllMocks()
  }, 30000)

  afterAll(async () => {
    try { if (client) await client.close() }
    finally { if (replSet) await replSet.stop() }
  }, 60000)

  describe('multiple technician assignments', () => {
    const stored = item => db.collection('tickets').findOne({ id: item.id })
    const history = item => db.collection('events').find({ ticket_id: item.id }).toArray()
    const pair = () => [tech.id, otherTech.id].sort()

    it('canonicalizes scalar, null, empty and duplicated sets on creation with idempotent retries', async () => {
      for (const [assigned_to, expected] of [[null, []], [[], []], [tech.id, [tech.id]],
        [[otherTech.id, tech.id, otherTech.id], pair()]]) {
        const input = ticketInput(connectionA, { assigned_to })
        await mutate('post', '/api/tickets', officeStaff, input).expect(201)
        await mutate('post', '/api/tickets', officeStaff, input).expect(201)
        expect(await stored(input)).toMatchObject({ assigned_to: expected, status: expected.length ? 'assigned' : 'new', version: 1 })
        expect(await history(input)).toHaveLength(1)
      }
    })

    it('rejects invalid array elements, foreign/inactive/nontechnician IDs, and both unique/raw size overflow atomically', async () => {
      const foreign = await staff(b, 'multi-foreign@example.test', 'technician')
      await mutate('post', '/api/staff', a, { action: 'update', id: otherTech.id, active: false }).expect(200)
      const before = await stored(ticketA)
      const eventCount = await db.collection('events').countDocuments()
      const ticketCount = await db.collection('tickets').countDocuments()
      const invalid = [false, 42, {}, '', [null], [42], [{}], [[tech.id]], ['bad-uuid'],
        [tech.id, foreign.id], [tech.id, otherTech.id], [tech.id, officeStaff.id], [tech.id, a.id], [tech.id, randomUUID()],
        Array.from({ length: 51 }, () => randomUUID()), Array(101).fill(tech.id)]
      for (const assigned_to of invalid) {
        await mutate('post', '/api/tickets', a, ticketInput(connectionA, { assigned_to })).expect(400)
        await patch(a, ticketA, { assigned_to }).expect(400)
      }
      expect(await stored(ticketA)).toEqual(before)
      expect(await db.collection('events').countDocuments()).toBe(eventCount)
      expect(await db.collection('tickets').countDocuments()).toBe(ticketCount)
    })

    it('accepts the 50-unique/100-raw boundaries and rejects 51 real active technicians', async () => {
      const users = Array.from({ length: 49 }, (_, index) => ({
        id: randomUUID(), company_id: a.company_id, role: 'technician', active: true,
        full_name: `Fictional boundary technician ${index}`, email: `boundary-${index}@example.test`,
      }))
      await db.collection('users').insertMany(users)
      const ids = [tech.id, ...users.map(user => user.id)]
      const item = await ticket(a, connectionA, { assigned_to: [...ids, ...ids].reverse() })
      expect(item.assigned_to).toEqual([...ids].sort())
      await patch(a, item, { assigned_to: [...ids, otherTech.id] }).expect(400)
      await mutate('post', '/api/tickets', a, ticketInput(connectionA, { assigned_to: [...ids, otherTech.id] })).expect(400)
      await patch(a, item, { assigned_to: Array(100).fill(tech.id) }).expect(200)
      expect((await stored(item)).assigned_to).toEqual([tech.id])
    })

    it('shares ticket/customer/connection/event access, but not office privileges, with every assigned technician', async () => {
      const item = await ticket(officeStaff, connectionA, { assigned_to: pair() })
      for (const actor of [tech, otherTech]) {
        const workspace = (await get('/api/workspace', actor).expect(200)).body
        expect(workspace.tickets.filter(t => t.id === item.id)).toHaveLength(1)
        expect(workspace.connections.some(c => c.id === connectionA.id)).toBe(true)
        expect(workspace.customers.some(c => c.id === connectionA.customer_id)).toBe(true)
        await get(`/api/tickets/${item.id}/events`, actor).expect(200)
        for (const changes of [{ assigned_to: [] }, { assigned_to: pair() }, { status: 'closed' }, { customer_feedback: 'Not office' }]) {
          await patch(actor, item, changes).expect(403)
        }
      }
      await patch(tech, item, { status: 'in_progress' }).expect(200)
      await patch(otherTech, item, { status: 'waiting_provider' }, 'Waiting on provider', 2).expect(200)
      await patch(tech, item, { status: 'in_progress' }, '', 3).expect(200)
      await patch(otherTech, item, { status: 'resolved', resolution: 'Shared repair complete' }, '', 4).expect(200)
      for (const actor of [tech, otherTech]) await patch(actor, item, { status: 'closed' }, '', 5).expect(403)
      const repair = (await history(item)).find(e => JSON.parse(e.body).changes?.status?.to === 'resolved')
      expect(repair.actor_id).toBe(otherTech.id)
    })

    it('supports shared image upload/read/delete and revokes all ticket scopes immediately on removal', async () => {
      await patch(a, ticketA, { assigned_to: [otherTech.id] }).expect(200)
      const item = await ticket(a, connectionA, { assigned_to: pair() })
      const root = `/api/tickets/${item.id}/images`
      for (const actor of [tech, otherTech]) await upload(actor, item).expect(201)
      const images = (await get(root, tech).expect(200)).body
      expect(images.map(image => image.uploaded_by).sort()).toEqual(pair())
      for (const actor of [tech, otherTech]) {
        expect((await get(root, actor).expect(200)).body).toHaveLength(2)
        for (const image of images) await get(image.url, actor).expect(200)
      }
      // Image IDs cannot be substituted from another ticket or company.
      const foreign = await seedImage(ticketB)
      const unrelated = await seedImage(otherTicket)
      for (const image of [foreign, unrelated]) {
        await get(`${root}/${image.id}/content`, otherTech).expect(404)
        await mutate('delete', `${root}/${image.id}`, otherTech).expect(404)
      }
      await mutate('delete', `${root}/${images[0].id}`, otherTech).expect(200)
      await patch(officeStaff, item, { assigned_to: [otherTech.id] }).expect(200)
      vi.clearAllMocks()
      const empty = (await get('/api/workspace', tech).expect(200)).body
      for (const key of ['tickets', 'connections', 'customers']) expect(empty[key]).toEqual([])
      await get(`/api/tickets/${item.id}/events`, tech).expect(404)
      await patch(tech, item, {}, 'Removed technician', 2).expect(404)
      await get(root, tech).expect(404)
      await get(images[1].url, tech).expect(404)
      await mutate('delete', `${root}/${images[1].id}`, tech).expect(404)
      await upload(tech, item, Buffer.from('invalid')).expect(404)
      noMediaCalls()
      await get(images[1].url, otherTech).expect(200)
      await patch(otherTech, item, { status: 'in_progress' }, '', 2).expect(200)
      await mutate('delete', `${root}/${images[1].id}`, otherTech).expect(200)
    })

    it('compares sets rather than array order/identity and records deterministic assignment audits', async () => {
      const item = await ticket(a, connectionA, { assigned_to: pair() })
      await patch(a, item, { assigned_to: [...pair()].reverse().concat(tech.id) }).expect(200)
      expect(await history(item)).toHaveLength(1)
      await patch(tech, item, {}, 'Only a note', 2).expect(200)
      expect((await history(item)).map(e => JSON.parse(e.body).action).sort()).toEqual(['created', 'note'])
      await patch(a, item, { assigned_to: tech.id }, '', 3).expect(200)
      const change = (await history(item)).find(e => JSON.parse(e.body).changes?.assigned_to)
      expect(JSON.parse(change.body).changes.assigned_to).toEqual({ from: pair(), to: [tech.id] })
      await patch(a, item, { assigned_to: [tech.id, tech.id] }, '', 4).expect(200)
      expect(await history(item)).toHaveLength(3)
    })

    it.each(['inactive', 'office'])('revalidates every assignee on change/reopen while preserving %s historical notes', async mode => {
      const item = await ticket(a, connectionA, { assigned_to: pair() })
      await patch(tech, item, { status: 'resolved', resolution: 'Historical shared repair' }).expect(200)
      await mutate('post', '/api/staff', a, { action: 'update', id: otherTech.id,
        ...(mode === 'inactive' ? { active: false } : { role: 'office' }) }).expect(200)
      await patch(a, item, { status: 'in_progress' }, '', 2).expect(400)
      // Reordering the same historical set is not reassignment.
      await patch(a, item, { assigned_to: [...pair()].reverse() }, 'Historical note', 2).expect(200)
      const another = await ticket(a, connectionA, { assigned_to: tech.id })
      await patch(a, another, { assigned_to: pair() }).expect(400)
      await patch(a, item, { status: 'assigned', assigned_to: tech.id }, '', 3).expect(200)
      expect(await stored(item)).toMatchObject({ assigned_to: [tech.id], status: 'assigned', resolution: '', customer_feedback: '', version: 4 })
      expect((await history(item)).filter(e => JSON.parse(e.body).changes?.assigned_to)).toHaveLength(1)
    })

    it('handles empty-array unassignment, work prerequisites, and unassigned resolution/reopening', async () => {
      const item = await ticket(a, connectionA, { assigned_to: pair() })
      await patch(a, item, { assigned_to: [] }).expect(200)
      expect(await stored(item)).toMatchObject({ status: 'new', assigned_to: [] })
      await patch(a, item, { status: 'in_progress' }, '', 2).expect(400)
      await patch(a, item, { assigned_to: pair(), status: 'new' }, '', 2).expect(200)
      expect((await stored(item)).status).toBe('assigned')
      await patch(tech, item, { status: 'in_progress' }, '', 3).expect(200)
      await patch(a, item, { assigned_to: [] }, '', 4).expect(400)
      await patch(a, item, { assigned_to: null, status: 'assigned' }, '', 4).expect(200)
      expect(await stored(item)).toMatchObject({ status: 'new', assigned_to: [] })
      await patch(officeStaff, item, { status: 'resolved', resolution: 'Telephone repair' }, '', 5).expect(200)
      await patch(officeStaff, item, { status: 'closed', customer_feedback: 'Confirmed' }, '', 6).expect(200)
      await patch(a, item, { status: 'new' }, '', 7).expect(200)
      expect(await stored(item)).toMatchObject({ status: 'new', assigned_to: [], resolution: '', customer_feedback: '' })
    })

    it('preserves optimistic conflicts for concurrent technicians and stale assignment patches', async () => {
      const item = await ticket(a, connectionA, { assigned_to: pair() })
      const results = await Promise.all([patch(tech, item, { status: 'in_progress' }),
        patch(otherTech, item, { status: 'resolved', resolution: 'Repaired' })])
      expect(results.map(response => response.status).sort()).toEqual([200, 409])
      expect(await stored(item)).toMatchObject({ version: 2, assigned_to: pair() })
      const events = await history(item)
      expect(events).toHaveLength(2)
      expect(events.find(e => JSON.parse(e.body).action === 'updated').actor_id).toBe(results[0].status === 200 ? tech.id : otherTech.id)
      await patch(a, item, { assigned_to: [] }).expect(409)
      expect(await history(item)).toHaveLength(2)
    })

    it('reads legacy scalar/null records without migration, then canonicalizes only the edited record without false audits', async () => {
      await db.collection('tickets').updateOne({ id: ticketA.id }, { $set: { assigned_to: tech.id } })
      await db.collection('tickets').updateOne({ id: otherTicket.id }, { $set: { assigned_to: null, status: 'new' } })
      await initializeDatabase(db)
      const workspace = (await get('/api/workspace', a).expect(200)).body
      expect(workspace.tickets.find(t => t.id === ticketA.id).assigned_to).toBe(tech.id)
      expect(workspace.tickets.find(t => t.id === otherTicket.id).assigned_to).toBeNull()
      expect((await get('/api/workspace', tech).expect(200)).body.tickets.map(t => t.id)).toEqual([ticketA.id])
      await get(`/api/tickets/${ticketA.id}/events`, tech).expect(200)
      await upload(tech, ticketA).expect(201)
      await patch(tech, ticketA, {}, 'Legacy note').expect(200)
      expect((await stored(ticketA)).assigned_to).toEqual([tech.id])
      expect((await stored(otherTicket)).assigned_to).toBeNull()
      expect((await history(ticketA)).some(e => JSON.parse(e.body).changes?.assigned_to)).toBe(false)
      await patch(a, otherTicket, { status: 'in_progress' }).expect(400)
      await patch(a, otherTicket, { assigned_to: [] }).expect(200)
      expect(await stored(otherTicket)).toMatchObject({ status: 'new', assigned_to: [] })
      expect(await history(otherTicket)).toHaveLength(1)
      await patch(a, ticketA, { assigned_to: pair() }, '', 2).expect(200)
      await get(`/api/tickets/${ticketA.id}/events`, otherTech).expect(200)
    })

    it('counts shared workload once per assignee across legacy/array values, but outcomes only for actual audit actors', async () => {
      await db.collection('tickets').updateMany({}, { $set: { assigned_to: null } })
      const past = '2024-01-01T00:00:00.000Z'
      const shared = await ticket(officeStaff, connectionA, { assigned_to: pair(), due_at: past })
      const legacy = await ticket(a, connectionA, { assigned_to: tech.id, due_at: past })
      await db.collection('tickets').updateOne({ id: legacy.id }, { $set: { assigned_to: tech.id } })
      const repaired = await ticket(officeStaff, connectionA, { assigned_to: pair() })
      await patch(otherTech, repaired, { status: 'resolved', resolution: 'Actual repair actor' }).expect(200)
      // Robust against duplicate entries in previously stored array data, too.
      await db.collection('tickets').updateOne({ id: shared.id }, { $set: { assigned_to: [tech.id, otherTech.id, tech.id] } })
      await mutate('post', '/api/staff', a, { action: 'update', id: otherTech.id, active: false }).expect(200)
      const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)
      const result = (await get('/api/reports/performance', a).query({ from: day, to: day }).expect(200)).body
      const row = actor => result.employees.find(employee => employee.id === actor.id)
      expect(row(tech)).toMatchObject({ open_assigned: 2, overdue_assigned: 2, awaiting_feedback_assigned: 1, resolved: 0 })
      expect(row(otherTech)).toMatchObject({ active: false, open_assigned: 1, overdue_assigned: 1, awaiting_feedback_assigned: 1, resolved: 1 })
      expect(row(officeStaff)).toMatchObject({ created: 2, resolved: 0 })
      await patch(a, shared, { assigned_to: tech.id }).expect(200)
      const after = (await get('/api/reports/performance', a).query({ from: day, to: day }).expect(200)).body
      expect(after.employees.find(employee => employee.id === otherTech.id)).toMatchObject({ open_assigned: 0, overdue_assigned: 0, awaiting_feedback_assigned: 1, resolved: 1 })
    })
  })

  describe('owner employee performance', () => {
    const endpoint = '/api/reports/performance'
    const dates = { from: '2024-02-01', to: '2024-02-29' }
    const createdAt = '2024-02-10T00:00:00.000Z'
    const zeroOutcomes = { created: 0, resolved: 0, closed: 0, feedback_recorded: 0, median_resolution_hours: null }
    const report = (actor = a, query = dates) => get(endpoint, actor).query(query)
    const employee = (body, actor) => {
      const row = body.employees.find(item => item.id === actor.id)
      expect(row, `Missing employee ${actor.id}`).toBeDefined()
      return row
    }
    const updated = changes => ({ action: 'updated', changes })
    const resolved = { status: { from: 'in_progress', to: 'resolved' } }
    function activity(item, actor, body, created_at = '2024-02-10T04:00:00.000Z', extra = {}) {
      return { id: randomUUID(), company_id: item.company_id, ticket_id: item.id, actor_id: actor.id,
        body: JSON.stringify(body), created_at, ...extra }
    }
    async function seedTickets(specifications) {
      // Safe fictional documents only, in the same disposable replica set as the API fixture.
      const items = specifications.map((fields, index) => ({
        ...ticketInput(connectionA, { assigned_to: tech.id }), company_id: a.company_id, number: 1000 + index,
        status: 'assigned', provider_reference: '', visit_at: null, follow_up_at: null,
        resolution: '', customer_feedback: '', created_at: createdAt, updated_at: createdAt, version: 1, ...fields,
      }))
      await db.collection('tickets').insertMany(items)
      return items
    }

    it('requires owner access, returns only safe aggregate fields, and adds nothing to workspace', async () => {
      await report(null).expect(401)
      await report(officeStaff).expect(403)
      await report(tech).expect(403)
      const response = await report().expect(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(Object.keys(response.body).sort()).toEqual(['employees', 'from', 'generated_at', 'to'])
      expect(response.body).toMatchObject(dates)
      expect(new Date(response.body.generated_at).toISOString()).toBe(response.body.generated_at)
      expect(response.body.employees.map(row => row.id).sort()).toEqual([a.id, tech.id, otherTech.id, officeStaff.id].sort())
      const fields = ['id', 'full_name', 'role', 'active', 'created', 'resolved', 'closed', 'feedback_recorded',
        'open_assigned', 'overdue_assigned', 'awaiting_feedback_assigned', 'median_resolution_hours'].sort()
      for (const row of response.body.employees) expect(Object.keys(row).sort()).toEqual(fields)
      const serialized = JSON.stringify(response.body)
      for (const forbidden of ['company_id', 'events', 'actor_id', 'ticket_id', 'body', 'password_hash', 'email',
        'auth_version', 'must_change_password', '$argon2', a.password_hash, a.email, a.company_id, b.company_id, a.cookie]) {
        expect(serialized).not.toContain(forbidden)
      }
      for (const actor of [a, officeStaff, tech]) {
        const workspace = (await get('/api/workspace', actor).expect(200)).body
        expect(Object.keys(workspace).sort()).toEqual(['companies', 'connections', 'customers', 'outages', 'profiles', 'providers', 'tickets'])
        expect(JSON.stringify(workspace)).not.toMatch(/performance|median_resolution_hours|feedback_recorded|open_assigned/)
      }
    })

    it('isolates both owners despite foreign actors, tenant-mismatched tickets and forged event scopes', async () => {
      const foreign = await staff(b, 'performance-foreign@example.test', 'technician')
      await db.collection('events').deleteMany({})
      await db.collection('tickets').updateMany({}, { $set: { created_at: createdAt } })
      await db.collection('tickets').updateOne({ id: ticketB.id }, { $set: { assigned_to: foreign.id } })
      await db.collection('events').insertMany([
        activity(ticketA, tech, updated(resolved)),
        activity(ticketB, foreign, updated(resolved), '2024-02-10T08:00:00.000Z'),
        activity(ticketA, foreign, updated(resolved)), // Own ticket, foreign actor.
        activity(ticketB, tech, updated(resolved)), // Foreign event scope, own actor.
        activity(ticketB, tech, updated(resolved), undefined, { company_id: a.company_id }),
        activity(ticketA, foreign, updated(resolved), undefined, { company_id: b.company_id }),
        activity(ticketA, tech, updated(resolved), '2024-02-10T20:00:00.000Z', { company_id: b.company_id }),
        activity({ ...ticketA, id: randomUUID() }, tech, updated(resolved)),
        activity(ticketA, { id: randomUUID() }, updated(resolved)),
      ])
      const own = (await report().expect(200)).body
      const other = (await report(b).expect(200)).body
      expect(own.employees.map(row => row.id).sort()).toEqual([a.id, tech.id, otherTech.id, officeStaff.id].sort())
      expect(other.employees.map(row => row.id).sort()).toEqual([b.id, foreign.id].sort())
      expect(employee(own, tech)).toMatchObject({ ...zeroOutcomes, resolved: 1, median_resolution_hours: 4, open_assigned: 1 })
      expect(employee(other, foreign)).toMatchObject({ ...zeroOutcomes, resolved: 1, median_resolution_hours: 8, open_assigned: 1 })
      for (const row of own.employees.filter(row => row.id !== tech.id)) expect(row).toMatchObject(zeroOutcomes)
      expect(employee(other, b)).toMatchObject(zeroOutcomes)
      expect(JSON.stringify(own)).not.toContain(foreign.id)
      for (const actor of [a, tech, otherTech, officeStaff]) expect(JSON.stringify(other)).not.toContain(actor.id)
      // Also exercise the metric-level tenant guards with deliberately mixed input arrays.
      const mixed = performanceMetrics(await db.collection('users').find().toArray(),
        await db.collection('tickets').find().toArray(), await db.collection('events').find().toArray(), performanceRange(dates))
      expect(employee(mixed, tech)).toMatchObject({ resolved: 1, median_resolution_hours: 4 })
      expect(employee(mixed, foreign)).toMatchObject({ resolved: 1, median_resolution_hours: 8 })
    })

    it('strictly validates required calendar dates, ordering, inclusive 366-day limit and unknown query keys', async () => {
      const invalid = [{}, { from: dates.from }, { to: dates.to }, { ...dates, from: '' }, { ...dates, to: '' },
        { ...dates, from: '2023-02-29' }, { ...dates, to: '2024-02-30' }, { ...dates, to: '2024-04-31' },
        { ...dates, from: '2024-00-10' }, { ...dates, to: '2024-13-01' }, { ...dates, from: '2024-2-01' },
        { ...dates, from: '2024-02-01T00:00:00Z' }, { ...dates, to: ' 2024-02-29' },
        { from: '2024-03-01', to: '2024-02-29' }, { from: '2024-01-01', to: '2025-01-01' },
        ...['company_id', 'actor_id', 'role', 'limit', 'unexpected'].map(key => ({ ...dates, [key]: b.company_id })),
        { ...dates, from: ['2024-02-01', '2024-02-02'] }, { ...dates, to: ['2024-02-28', '2024-02-29'] },
        { ...dates, from: { $gte: dates.from } }]
      for (const query of invalid) {
        const response = await report(a, query)
        expect(response.status, JSON.stringify(query)).toBe(400)
        expect(response.body).not.toHaveProperty('employees')
      }
      for (const query of [{ from: '2024-02-29', to: '2024-02-29' }, { from: '2024-01-01', to: '2024-12-31' }]) {
        expect((await report(a, query).expect(200)).body).toMatchObject(query)
      }
      const leapYear = performanceRange({ from: '2024-01-01', to: '2024-12-31' })
      expect(leapYear.end - leapYear.start).toBe(366 * 86400000)
    })

    it('attributes real repair and office follow-up audits to their actors, even after reassignment', async () => {
      await db.collection('events').deleteMany({})
      const item = await ticket(officeStaff, connectionA, { assigned_to: tech.id })
      await patch(tech, item, { status: 'resolved', resolution: 'Fictional cable repaired' }).expect(200)
      await patch(officeStaff, item, { customer_feedback: 'Fictional customer confirmed repair' }, '', 2).expect(200)
      await patch(officeStaff, item, { status: 'closed' }, '', 3).expect(200)
      const events = await db.collection('events').find({ ticket_id: item.id }).toArray()
      expect(events).toHaveLength(4)
      // Retimestamp actual API audits, without replacing their bodies or attribution.
      for (const event of events) {
        const body = JSON.parse(event.body)
        const hour = body.action === 'created' ? 0 : body.changes?.status?.to === 'resolved' ? 4 : body.changes?.status?.to === 'closed' ? 6 : 5
        expect(event.actor_id).toBe(hour === 4 ? tech.id : officeStaff.id)
        await db.collection('events').updateOne({ id: event.id }, { $set: { created_at: `2024-02-10T0${hour}:00:00.000Z` } })
      }
      await db.collection('tickets').updateOne({ id: item.id }, { $set: { created_at: createdAt } })
      const before = (await report().expect(200)).body
      expect(employee(before, tech)).toMatchObject({ ...zeroOutcomes, resolved: 1, median_resolution_hours: 4 })
      expect(employee(before, officeStaff)).toMatchObject({ ...zeroOutcomes, created: 1, closed: 1, feedback_recorded: 1 })
      expect(employee(before, otherTech)).toMatchObject(zeroOutcomes)
      const historicalEvents = await db.collection('events').find({ ticket_id: item.id }).sort({ id: 1 }).toArray()
      await patch(a, item, { assigned_to: otherTech.id }, '', 4).expect(200)
      expect(await db.collection('tickets').findOne({ id: item.id })).toMatchObject({ assigned_to: [otherTech.id], status: 'closed' })
      const after = (await report().expect(200)).body
      expect(after.employees).toEqual(before.employees)
      expect(await db.collection('events').find({ id: { $in: events.map(event => event.id) } }).sort({ id: 1 }).toArray())
        .toEqual(historicalEvents)
    })

    it('counts distinct tickets, not repeated resolves, feedback edits, closure audits or malformed events', async () => {
      await db.collection('events').deleteMany({})
      const [first, second, ignored] = await seedTickets([{}, {}, {}])
      const rows = []
      for (const item of [first, second]) {
        rows.push(activity(item, officeStaff, { action: 'created' }), activity(item, officeStaff, { action: 'created' }))
        rows.push(activity(item, tech, updated(resolved), '2024-02-10T02:00:00.000Z'))
        rows.push(activity(item, tech, updated(resolved), item.id === first.id ? '2024-02-10T04:00:00.000Z' : '2024-02-10T10:00:00.000Z'))
        rows.push(activity(item, officeStaff, updated({ customer_feedback: { from: '', to: 'Confirmed' } })))
        rows.push(activity(item, officeStaff, updated({ customer_feedback: { from: 'Confirmed', to: 'Confirmed again' } })))
        rows.push(activity(item, officeStaff, updated({ status: { from: 'resolved', to: 'closed' } })))
        rows.push(activity(item, officeStaff, updated({ status: { from: 'resolved', to: 'closed' } })))
      }
      for (const body of [null, [], 'not an event', { action: 'note', changes: resolved },
        updated({ status: { from: 'resolved', to: 'resolved' } }), updated({ status: { from: 'closed', to: 'closed' } }),
        updated({ customer_feedback: { from: '', to: '  ' } }), updated({ customer_feedback: { from: 'Same', to: 'Same' } }),
        updated({ customer_feedback: { from: 'Old', to: null } }), updated({ customer_feedback: { from: '', to: 12 } })]) {
        rows.push(activity(ignored, tech, body), activity(ignored, officeStaff, body))
      }
      rows.push(activity(ignored, tech, null, undefined, { body: '{invalid json' }))
      rows.push(activity(ignored, tech, updated(resolved), 'not-a-date'))
      await db.collection('events').insertMany(rows.reverse()) // Natural order must not choose the latest outcome.
      const body = (await report().expect(200)).body
      expect(employee(body, tech)).toMatchObject({ ...zeroOutcomes, resolved: 2, median_resolution_hours: 7 })
      expect(employee(body, officeStaff)).toMatchObject({ ...zeroOutcomes, created: 2, closed: 2, feedback_recorded: 2 })
      expect(employee(body, a)).toMatchObject(zeroOutcomes)
      expect(employee(body, otherTech)).toMatchObject(zeroOutcomes)
    })

    it('includes both IST calendar-day boundaries and excludes exactly the next midnight', async () => {
      await db.collection('events').deleteMany({})
      const items = await seedTickets([{}, {}, {}, {}])
      const timestamps = ['2024-02-09T18:29:59.999Z', '2024-02-09T18:30:00.000Z',
        '2024-02-11T18:29:59.999Z', '2024-02-11T18:30:00.000Z']
      await db.collection('events').insertMany(items.flatMap((item, index) => [
        activity(item, officeStaff, { action: 'created' }, timestamps[index]),
        activity(item, tech, updated(resolved), timestamps[index]),
        activity(item, officeStaff, updated({ status: { from: 'resolved', to: 'closed' },
          customer_feedback: { from: '', to: 'Fictional confirmation' } }), timestamps[index]),
      ]))
      const query = { from: '2024-02-10', to: '2024-02-11' }
      const range = performanceRange(query)
      expect(new Date(range.start).toISOString()).toBe(timestamps[1])
      expect(new Date(range.end).toISOString()).toBe(timestamps[3])
      const body = (await report(a, query).expect(200)).body
      expect(employee(body, tech).resolved).toBe(2)
      expect(employee(body, officeStaff)).toMatchObject({ created: 2, closed: 2, feedback_recorded: 2 })
      for (const query of [{ from: '2024-02-09', to: '2024-02-09' }, { from: '2024-02-12', to: '2024-02-12' }]) {
        const adjacent = (await report(a, query).expect(200)).body
        expect(employee(adjacent, tech).resolved).toBe(1)
        expect(employee(adjacent, officeStaff)).toMatchObject({ created: 1, closed: 1, feedback_recorded: 1 })
      }
    })

    it('computes medians from creation to latest in-range resolution per actor/ticket, or null without valid durations', () => {
      const range = performanceRange(dates)
      const profiles = [tech, otherTech, officeStaff]
      const specs = [createdAt, createdAt, createdAt, undefined, 'invalid-date', '2024-02-11T00:00:00.000Z']
      const items = specs.map(created_at => ({ id: randomUUID(), company_id: a.company_id, assigned_to: null, status: 'closed', created_at }))
      const [first, second, third, ...invalid] = items
      const events = [
        activity(first, tech, updated(resolved), '2024-02-10T02:00:00.000Z'),
        activity(first, tech, updated(resolved), '2024-02-10T04:00:00.000Z'),
        activity(first, tech, updated(resolved), '2024-03-01T04:00:00.000Z'), // Later, but outside range.
        activity(second, tech, updated(resolved), '2024-02-10T10:00:00.000Z'),
        activity(third, tech, updated(resolved), '2024-02-11T00:00:00.000Z'),
        activity(first, otherTech, updated(resolved), '2024-02-10T20:00:00.000Z'), // Must not overwrite tech's time.
        ...invalid.flatMap(item => [activity(item, tech, updated(resolved)), activity(item, officeStaff, updated(resolved))]),
      ]
      const timestamp = Date.parse('2024-03-10T00:00:00.000Z')
      const odd = performanceMetrics(profiles, items, [...events].reverse(), range, timestamp)
      expect(odd.generated_at).toBe('2024-03-10T00:00:00.000Z')
      expect(employee(odd, tech)).toMatchObject({ resolved: 6, median_resolution_hours: 10 })
      expect(employee(odd, otherTech)).toMatchObject({ resolved: 1, median_resolution_hours: 20 })
      expect(employee(odd, officeStaff)).toMatchObject({ resolved: 3, median_resolution_hours: null })
      const even = performanceMetrics(profiles, items, events.filter(event => event.ticket_id !== third.id), range, timestamp)
      expect(employee(even, tech)).toMatchObject({ resolved: 5, median_resolution_hours: 7 })
      const empty = performanceMetrics(profiles, items, [], range, timestamp)
      for (const row of empty.employees) expect(row).toMatchObject(zeroOutcomes)
    })

    it('keeps all-time current workload separate from dated outcomes and includes inactive staff', async () => {
      await db.collection('events').deleteMany({})
      await db.collection('tickets').updateMany({}, { $set: { assigned_to: null } })
      const past = '2001-01-01T00:00:00.000Z'
      const future = '9999-01-01T00:00:00.000Z'
      const items = await seedTickets([
        { status: 'new', due_at: past, created_at: past },
        { status: 'assigned', due_at: future, created_at: past },
        { status: 'in_progress', due_at: null, created_at: future },
        { status: 'waiting_customer', due_at: past }, { status: 'waiting_provider', due_at: past },
        { status: 'resolved', due_at: past, customer_feedback: '' },
        { status: 'resolved', due_at: past, customer_feedback: 'Saved but not closed' },
        { status: 'closed', due_at: past }, { status: 'assigned', due_at: past, assigned_to: null },
        { status: 'assigned', due_at: past, assigned_to: otherTech.id },
      ])
      await db.collection('events').insertOne(activity(items[5], tech, updated(resolved)))
      await mutate('post', '/api/staff', a, { action: 'update', id: tech.id, active: false }).expect(200)
      const current = (await report().expect(200)).body
      const historical = (await report(a, { from: '1999-01-01', to: '1999-01-01' }).expect(200)).body
      const workload = { active: false, open_assigned: 5, overdue_assigned: 3, awaiting_feedback_assigned: 2 }
      expect(employee(current, tech)).toMatchObject({ ...workload, resolved: 1 })
      expect(employee(historical, tech)).toMatchObject({ ...zeroOutcomes, ...workload })
      expect(employee(current, otherTech)).toMatchObject({ open_assigned: 1, overdue_assigned: 1, awaiting_feedback_assigned: 0 })
      for (const actor of [a, officeStaff]) expect(employee(current, actor)).toMatchObject({ open_assigned: 0, overdue_assigned: 0, awaiting_feedback_assigned: 0 })
      // Deterministic exact-deadline check without freezing MongoDB's timers or sessions.
      const timestamp = Date.parse(createdAt)
      const pure = performanceMetrics([tech], [
        { ...items[0], due_at: createdAt }, { ...items[1], due_at: '2024-02-09T23:59:59.999Z' },
        { ...items[2], due_at: 'invalid-date' }, { ...items[3], due_at: null },
      ], [], performanceRange(dates), timestamp)
      expect(employee(pure, tech)).toMatchObject({ open_assigned: 4, overdue_assigned: 1, awaiting_feedback_assigned: 0 })
    })

    it('denies revoked sessions, fresh role/password gates and membership changes before the report snapshot', async () => {
      const users = db.collection('users')
      const originalOwner = baseline.find(([name]) => name === 'users')[1].find(user => user.id === a.id)
      const restoreOwner = () => users.replaceOne({ id: a.id }, BSON.deserialize(BSON.serialize(originalOwner)))
      for (const [fields, status] of [[{ auth_version: a.auth_version + 1 }, 401], [{ role: 'office' }, 403],
        [{ role: 'technician' }, 403], [{ must_change_password: true }, 403], [{ active: false }, 403]]) {
        await users.updateOne({ id: a.id }, { $set: fields })
        const denied = await report().expect(status)
        expect(denied.body).not.toHaveProperty('employees')
        await restoreOwner()
      }
      // Return a pre-change authentication read, then revoke before the transaction reads membership.
      // Spy on the collection prototype because db.collection() returns new handles.
      const prototype = Object.getPrototypeOf(users)
      const originalFindOne = prototype.findOne
      for (const fields of [{ role: 'office' }, { must_change_password: true }, { active: false },
        { auth_version: a.auth_version + 1 }, { company_id: b.company_id }]) {
        let changed = false
        const spy = vi.spyOn(prototype, 'findOne').mockImplementation(async function (filter, options) {
          const result = await originalFindOne.call(this, filter, options)
          if (this.collectionName === 'users' && filter.id === a.id && !options?.session && !changed) {
            changed = true
            await users.updateOne({ id: a.id }, { $set: fields })
          }
          return result
        })
        try {
          const denied = await report().expect(403)
          expect(changed).toBe(true)
          expect(denied.body).not.toHaveProperty('employees')
        } finally {
          spy.mockRestore()
          await restoreOwner()
        }
      }
      await report().expect(200)
      await mutate('post', '/api/auth/logout', a, {}).expect(200)
      await report().expect(401)
      await report(b).expect(200)
    })
  })

  it.each(['null', 'omitted'])('creates an unlinked ticket with %s connection and supports its lifecycle', async mode => {
    const input = ticketInput(connectionA, { connection_id: null })
    if (mode === 'omitted') delete input.connection_id
    await mutate('post', '/api/tickets', a, input).expect(201)
    await mutate('post', '/api/tickets', a, input).expect(201)
    const item = await db.collection('tickets').findOne({ id: input.id })
    expect(item).toMatchObject({ connection_id: null, company_id: a.company_id, version: 1 })
    expect(await db.collection('events').countDocuments({ ticket_id: item.id })).toBe(1)
    await patch(a, item, {}, 'Customer details will be recorded in the notes').expect(200)
    await patch(a, item, { status: 'resolved', resolution: 'Phone fix verified' }, '', 2).expect(200)
    await patch(a, item, { status: 'closed', customer_feedback: 'Customer confirmed the connection works' }, '', 3).expect(200)
    await patch(a, item, { status: 'new' }, '', 4).expect(200)
    expect(await db.collection('tickets').findOne({ id: item.id })).toMatchObject({ connection_id: null, status: 'new', resolution: '', version: 5 })
    const workspace = await get('/api/workspace', a).expect(200)
    expect(workspace.body.tickets.some(t => t.id === item.id && t.connection_id === null)).toBe(true)
    await get(`/api/tickets/${item.id}/events`, b).expect(404)
    await patch(b, item, {}, 'Foreign note').expect(404)
    await get(`/api/tickets/${item.id}/events`, tech).expect(404)
  })

  it('assigned unlinked tickets remain technician-scoped without exposing unrelated customers', async () => {
    const item = await ticket(a, connectionA, { connection_id: null, assigned_to: tech.id })
    // Leave this technician only the unlinked job, with other customer data intact.
    await db.collection('tickets').updateOne({ id: ticketA.id }, { $set: { assigned_to: otherTech.id } })
    const workspace = await get('/api/workspace', tech).expect(200)
    expect(workspace.body.tickets.map(t => t.id)).toEqual([item.id])
    expect(workspace.body.connections).toEqual([])
    expect(workspace.body.customers).toEqual([])
    await get(`/api/tickets/${item.id}/events`, tech).expect(200)
    await patch(tech, item, { status: 'in_progress' }).expect(200)
    await patch(tech, item, { status: 'resolved', resolution: 'Verified repair' }, '', 2).expect(200)
    await upload(tech, item).expect(201)
    await get(`/api/tickets/${item.id}/images`, otherTech).expect(404)
    await get(`/api/tickets/${item.id}/images`, b).expect(404)
  })

  it('optional connections do not bypass reference, outage or assignee validation', async () => {
    for (const connection_id of ['', 'not-a-uuid', 123]) {
      await mutate('post', '/api/tickets', a, ticketInput(connectionA, { connection_id })).expect(400)
    }
    for (const connection_id of [connectionB.id, randomUUID()]) {
      await mutate('post', '/api/tickets', a, ticketInput(connectionA, { connection_id })).expect(404)
    }
    for (const assigned_to of [b.id, a.id, randomUUID()]) {
      await mutate('post', '/api/tickets', a, ticketInput(connectionA, { connection_id: null, assigned_to })).expect(400)
    }
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { connection_id: null, outage_id: outageA.id })).expect(400)
    const item = await ticket(a, connectionA, { connection_id: null })
    await patch(a, item, { outage_id: outageA.id }).expect(400)
    await patch(a, item, { assigned_to: b.id }).expect(400)
    expect(await db.collection('tickets').findOne({ id: item.id })).toMatchObject({ version: 1, outage_id: null, assigned_to: [] })
  })

  it('registers two isolated owner companies with Argon2 hashes and transactional audits', async () => {
    expect(a.company_id).not.toBe(b.company_id)
    expect(await db.collection('companies').countDocuments()).toBe(2)
    for (const actor of [a, b]) {
      const stored = await db.collection('users').findOne({ id: actor.id })
      expect(stored).toMatchObject({ role: 'owner', active: true, must_change_password: false })
      expect(stored.password_hash).not.toBe(password)
      expect(stored.password_hash).toMatch(/^\$argon2id\$/)
      expect(await verifyPassword(stored.password_hash, password)).toBe(true)
      expect(await db.collection('staff_audit').countDocuments({ company_id: actor.company_id, action: 'company_registered', target_id: actor.id })).toBe(1)
    }
  })

  it('strictly rejects registration privilege fields, omissions and invalid values without writes', async () => {
    const valid = registration('strict@example.test')
    const inputs = [
      ...['role', 'company_id', 'active', 'auth_version', 'email_verified', 'password_hash'].map(key => ({ ...valid, [key]: key === 'company_id' ? a.company_id : 'injected' })),
      ...Object.keys(valid).map(key => Object.fromEntries(Object.entries(valid).filter(([field]) => field !== key))),
      { ...valid, password: 'short' }, { ...valid, password: '🙂'.repeat(65) }, { ...valid, full_name: 'bad\0name' },
      { ...valid, company_name: '   ' }, { ...valid, email: 'invalid' },
    ]
    for (const input of inputs) await mutate('post', '/api/auth/register', null, input).expect(400)
    expect(await db.collection('companies').countDocuments()).toBe(2)
    expect(await db.collection('users').countDocuments({ email: valid.email })).toBe(0)
  })

  it('rolls back duplicate concurrent registrations: one user, company and audit only', async () => {
    const counts = await Promise.all(['companies', 'users', 'staff_audit'].map(name => db.collection(name).countDocuments()))
    const results = await Promise.all(Array.from({ length: 4 }, () => mutate('post', '/api/auth/register', null, registration('race@example.test'))))
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409, 409])
    for (const [index, name] of ['companies', 'users', 'staff_audit'].entries()) expect(await db.collection(name).countDocuments()).toBe(counts[index] + 1)
    expect(await db.collection('users').countDocuments({ email: 'race@example.test' })).toBe(1)
  })

  it('rejects invalid login credentials uniformly without issuing sessions', async () => {
    const count = await db.collection('sessions').countDocuments()
    const unknown = await mutate('post', '/api/auth/login', null, { email: 'absent@example.test', password }).expect(401)
    const wrong = await mutate('post', '/api/auth/login', null, { email: a.email, password: 'wrong-password' }).expect(401)
    expect(unknown.body).toEqual(wrong.body)
    expect(unknown.headers['set-cookie']).toBeUndefined()
    expect(wrong.headers['set-cookie']).toBeUndefined()
    await mutate('post', '/api/auth/login', null, { email: a.email, password, role: 'owner' }).expect(400)
    expect(await db.collection('sessions').countDocuments()).toBe(count)
  })

  it('issues HTTPOnly Strict cookies, stores only token digests and secures production cookies', async () => {
    const user = await login(a.email)
    const cookie = user.response.headers['set-cookie'][0]
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=34560000')
    const token = user.cookie.split('=')[1]
    const stored = await db.collection('sessions').findOne({ _id: digest(token) })
    expect(stored._id).not.toBe(token)
    expect(stored).not.toHaveProperty('expires_at')
    await get('/api/auth/session', user).expect(200)
    const secureApp = await createApp({ db, client, media, origins: [origin], production: true, rateLimits: false })
    const secure = await request(secureApp).post('/api/auth/login').set('Origin', origin).send({ email: a.email, password }).expect(200)
    expect(secure.headers['set-cookie'][0]).toMatch(/^__Host-dsa_session=/)
    expect(secure.headers['set-cookie'][0]).toContain('Secure')
    expect(secure.headers['set-cookie'][0]).toContain('HttpOnly')
  })

  it('rejects absent, malformed, unknown and expired cookies before database TTL cleanup', async () => {
    await get('/api/workspace').expect(401)
    for (const value of ['invalid', 'a'.repeat(43)]) await get('/api/workspace', { cookie: `dsa_session=${value}` }).expect(401)
    await db.collection('sessions').updateOne({ _id: digest(a.cookie.split('=')[1]) }, { $set: { expires_at: new Date(Date.now() - 1000) } })
    await get('/api/auth/session', a).expect(401)
    await get('/api/workspace', a).expect(401)
    await patch(a, ticketA, {}, 'Expired write').expect(401)
  })

  it('keeps old persistent sessions usable and renews cookies without changing their identity', async () => {
    const key = digest(a.cookie.split('=')[1])
    const old = new Date(Date.now() - 500 * 86400000)
    await db.collection('sessions').updateOne({ _id: key }, { $set: { created_at: old } })
    const response = await get('/api/workspace', a).expect(200)
    expect(response.headers['set-cookie'][0]).toContain(a.cookie)
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=34560000')
    const session = await db.collection('sessions').findOne({ _id: key })
    expect(session).not.toHaveProperty('expires_at')
    expect(session.created_at).toEqual(old)
    await patch(a, ticketA, {}, 'Still signed in after long absence').expect(200)
    // Keeping a session does not bypass recent authentication for password changes.
    await mutate('post', '/api/staff', a, { action: 'change_password', password: newPassword }).expect(403)
  })

  it('upgrades unexpired legacy sessions but never revives an expired legacy token', async () => {
    const key = digest(a.cookie.split('=')[1])
    await db.collection('sessions').updateOne({ _id: key }, { $set: { expires_at: new Date(Date.now() + 3600000) } })
    await get('/api/auth/session', a).expect(200)
    expect(await db.collection('sessions').findOne({ _id: key })).not.toHaveProperty('expires_at')
    const expiredKey = digest(b.cookie.split('=')[1])
    await db.collection('sessions').updateOne({ _id: expiredKey }, { $set: { expires_at: new Date(Date.now() - 10000) } })
    await get('/api/auth/session', b).expect(401)
    const expired = await db.collection('sessions').findOne({ _id: expiredKey })
    if (expired) expect(expired.expires_at.getTime()).toBeLessThan(Date.now())
  })

  it('logout invalidates the server token, clears cookies and is idempotent', async () => {
    const result = await mutate('post', '/api/auth/logout', a, {}).expect(200)
    expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970')
    expect(await db.collection('sessions').findOne({ _id: digest(a.cookie.split('=')[1]) })).toBeNull()
    await get('/api/workspace', a).expect(401)
    await mutate('post', '/api/auth/logout', a, {}).expect(200)
    await get('/api/workspace', b).expect(200)
  })

  it('blocks missing-origin, foreign-origin and cross-site mutations including auth and multipart', async () => {
    for (const headers of [{}, { Origin: 'https://evil.example.test' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }]) {
      await request(app).post('/api/auth/register').set(headers).send(registration('csrf@example.test')).expect(403)
      await request(app).post('/api/auth/logout').set(headers).set('Cookie', a.cookie).send({}).expect(403)
      await request(app).patch(`/api/tickets/${ticketA.id}`).set(headers).set('Cookie', a.cookie).send({ version: 1, patch: {}, note: 'CSRF' }).expect(403)
      await request(app).post(`/api/tickets/${ticketA.id}/images`).set(headers).set('Cookie', a.cookie).attach('image', jpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(403)
    }
    await get('/api/workspace', a).expect(200)
    expect(await db.collection('companies').countDocuments()).toBe(2)
    noMediaCalls()
  })

  it('workspace returns only the current company and never staff email/password/session secrets', async () => {
    const response = await get('/api/workspace', a).expect(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.companies.map(c => c.id)).toEqual([a.company_id])
    for (const key of ['profiles', 'tickets', 'customers', 'connections', 'outages']) {
      expect(response.body[key].length).toBeGreaterThan(0)
      expect(response.body[key].every(row => row.company_id === a.company_id)).toBe(true)
    }
    const serialized = JSON.stringify(response.body)
    // must_change_password is intentionally public; credentials and credential keys are not.
    for (const forbidden of ['"password":', '"password_hash":', '"email":', '"auth_version":', '$argon2', password, newPassword, a.cookie, b.company_id]) expect(serialized).not.toContain(forbidden)
    const profile = await get('/api/profile', a).expect(200)
    expect(profile.body).not.toHaveProperty('email')
    expect(profile.body).not.toHaveProperty('password_hash')
  })

  it('new staff must change temporary passwords before operational reads or writes', async () => {
    const pending = await staff(a, 'pending@example.test', 'technician', false)
    await get('/api/auth/session', pending).expect(200)
    expect((await get('/api/profile', pending).expect(200)).body.must_change_password).toBe(true)
    await get('/api/workspace', pending).expect(403)
    await get(`/api/tickets/${ticketA.id}/events`, pending).expect(403)
    await mutate('post', '/api/tickets', pending, ticketInput(connectionA)).expect(403)
    await upload(pending, ticketA).expect(403)
    await mutate('post', '/api/staff', pending, { action: 'change_password', password: newPassword }).expect(200)
    await get('/api/workspace', pending).expect(200)
    noMediaCalls()
  })

  it('password changes hash the replacement, retain current session and revoke all other sessions', async () => {
    const first = await login(a.email)
    const second = await login(a.email)
    await mutate('post', '/api/staff', first, { action: 'change_password', password: newPassword }).expect(200)
    await get('/api/workspace', first).expect(200)
    await get('/api/workspace', second).expect(401)
    await get('/api/workspace', a).expect(401)
    await mutate('post', '/api/auth/login', null, { email: a.email, password }).expect(401)
    const stored = await db.collection('users').findOne({ id: a.id })
    expect(stored.password_hash).not.toBe(newPassword)
    expect(await verifyPassword(stored.password_hash, newPassword)).toBe(true)
    const fresh = await login(a.email, newPassword)
    await db.collection('sessions').updateOne({ _id: digest(fresh.cookie.split('=')[1]) }, { $set: { created_at: new Date(Date.now() - 16 * 60000) } })
    await mutate('post', '/api/staff', fresh, { action: 'change_password', password }).expect(403)
  })

  it('owner password resets revoke staff sessions and reinstate the password gate', async () => {
    await mutate('post', '/api/staff', a, { action: 'reset_password', id: tech.id, password }).expect(200)
    await get('/api/workspace', tech).expect(401)
    await mutate('post', '/api/auth/login', null, { email: tech.email, password: newPassword }).expect(401)
    const reset = await login(tech.email)
    await get('/api/workspace', reset).expect(403)
    await mutate('post', '/api/staff', reset, { action: 'change_password', password: newPassword }).expect(200)
    await get('/api/workspace', reset).expect(200)
    expect(await db.collection('staff_audit').countDocuments({ action: 'reset_password', target_id: tech.id })).toBe(1)
  })

  it('deactivation and role changes revoke existing sessions immediately', async () => {
    await mutate('post', '/api/staff', a, { action: 'update', id: tech.id, active: false }).expect(200)
    await get('/api/auth/session', tech).expect(401)
    await patch(tech, ticketA, {}, 'Revoked write').expect(401)
    await mutate('post', '/api/auth/login', null, { email: tech.email, password: newPassword }).expect(401)
    await mutate('post', '/api/staff', a, { action: 'update', id: tech.id, active: true, role: 'office' }).expect(200)
    await get('/api/workspace', tech).expect(401)
    const active = await login(tech.email, newPassword)
    expect((await get('/api/profile', active).expect(200)).body.role).toBe('office')
    await mutate('post', '/api/staff', a, { action: 'update', id: tech.id, role: 'technician' }).expect(200)
    await get('/api/workspace', active).expect(401)
  })

  it('office staff can operate tickets but cannot create, update or reset staff', async () => {
    await patch(officeStaff, ticketA, { priority: 'high' }).expect(200)
    for (const input of [
      { action: 'create', full_name: 'Forbidden Staff', email: 'forbidden@example.test', role: 'office', password },
      { action: 'update', id: tech.id, role: 'office' }, { action: 'reset_password', id: tech.id, password },
    ]) await mutate('post', '/api/staff', officeStaff, input).expect(403)
    expect(await db.collection('users').countDocuments({ email: 'forbidden@example.test' })).toBe(0)
    await get('/api/workspace', tech).expect(200)
  })

  it('protects owner accounts from administrative demotion, deactivation and reset', async () => {
    for (const input of [{ action: 'update', id: a.id, active: false }, { action: 'update', id: a.id, role: 'office' }, { action: 'reset_password', id: a.id, password: newPassword }]) {
      await mutate('post', '/api/staff', a, input).expect(403)
    }
    await mutate('post', '/api/staff', a, { action: 'create', full_name: 'Injected Owner', email: 'injected@example.test', password, role: 'owner' }).expect(400)
    expect((await db.collection('users').findOne({ id: a.id })).auth_version).toBe(1)
  })

  it('denies foreign staff updates and password resets without changing target credentials', async () => {
    const foreign = await staff(b, 'foreign-staff@example.test', 'technician')
    const before = await db.collection('users').findOne({ id: foreign.id })
    for (const input of [{ action: 'update', id: foreign.id, active: false }, { action: 'reset_password', id: foreign.id, password }]) await mutate('post', '/api/staff', a, input).expect(404)
    expect(await db.collection('users').findOne({ id: foreign.id })).toEqual(before)
    await get('/api/workspace', foreign).expect(200)
  })

  it('creates tenant-bound customer/connection relationships and rejects foreign connection references', async () => {
    expect(connectionA.customer_id).not.toBe(connectionB.customer_id)
    expect(await db.collection('customers').findOne({ id: connectionA.customer_id })).toMatchObject({ company_id: a.company_id })
    const before = await db.collection('tickets').countDocuments()
    await mutate('post', '/api/tickets', a, ticketInput(connectionB)).expect(404)
    await mutate('post', '/api/tickets', a, ticketInput({ id: connectionB.customer_id })).expect(404)
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { customer_id: connectionB.customer_id })).expect(400)
    await mutate('post', '/api/customers', a, { full_name: 'Injected', phone: '5550100', address: 'Test', area: 'Test', provider_id: 'jio', account_number: 'INJECT', customer_id: connectionB.customer_id, company_id: b.company_id }).expect(400)
    expect(await db.collection('tickets').countDocuments()).toBe(before)
    const customersBefore = await db.collection('customers').countDocuments()
    await mutate('post', '/api/customers', a, { full_name: 'Duplicate', phone: '5550100', address: 'Test', area: 'Test', provider_id: 'jio', account_number: connectionA.account_number }).expect(409)
    expect(await db.collection('customers').countDocuments()).toBe(customersBefore)
  })

  it('denies foreign and provider-mismatched outages while allowing same-company links and restoration', async () => {
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { outage_id: outageB.id })).expect(400)
    await patch(a, ticketA, { outage_id: outageB.id }).expect(400)
    await mutate('post', `/api/outages/${outageB.id}/restore`, a, {}).expect(404)
    const airtel = await customer(a, 'AIRTEL', 'airtel')
    await mutate('post', '/api/tickets', a, ticketInput(airtel, { outage_id: outageA.id })).expect(400)
    await patch(a, ticketA, { outage_id: outageA.id }).expect(200)
    await mutate('post', `/api/outages/${outageA.id}/restore`, a, {}).expect(200)
    expect((await db.collection('outages').findOne({ id: outageB.id })).status).toBe('active')
    expect((await db.collection('tickets').findOne({ id: ticketA.id })).status).toBe('assigned')
  })

  it('rejects foreign, inactive and non-technician assignees without ticket/event writes', async () => {
    const foreign = await staff(b, 'foreign-tech@example.test', 'technician')
    await mutate('post', '/api/staff', a, { action: 'update', id: otherTech.id, active: false }).expect(200)
    const count = await db.collection('events').countDocuments()
    for (const id of [foreign.id, otherTech.id, officeStaff.id, a.id, randomUUID()]) {
      await mutate('post', '/api/tickets', a, ticketInput(connectionA, { assigned_to: id })).expect(400)
      await patch(a, ticketA, { assigned_to: id }).expect(400)
    }
    expect(await db.collection('events').countDocuments()).toBe(count)
    expect((await db.collection('tickets').findOne({ id: ticketA.id })).version).toBe(1)
  })

  it('technician workspace includes only assigned tickets and their related customer/connection', async () => {
    const response = await get('/api/workspace', tech).expect(200)
    expect(response.body.tickets.map(t => t.id)).toEqual([ticketA.id])
    expect(response.body.connections.map(c => c.id)).toEqual([connectionA.id])
    expect(response.body.customers.map(c => c.id)).toEqual([connectionA.customer_id])
    await get(`/api/tickets/${otherTicket.id}/events`, tech).expect(404)
    await patch(tech, otherTicket, {}, 'Not my job').expect(404)
    await patch(a, ticketA, { assigned_to: otherTech.id }).expect(200)
    const empty = await get('/api/workspace', tech).expect(200)
    for (const key of ['tickets', 'connections', 'customers']) expect(empty.body[key]).toEqual([])
    await get(`/api/tickets/${ticketA.id}/events`, tech).expect(404)
  })

  it('technicians cannot create customers/tickets/outages or alter assignment and office fields', async () => {
    await mutate('post', '/api/customers', tech, { full_name: 'Test', phone: '5550100', address: 'Test', area: 'Test', provider_id: 'jio', account_number: 'TECH' }).expect(403)
    await mutate('post', '/api/tickets', tech, ticketInput(connectionA)).expect(403)
    await mutate('post', '/api/outages', tech, { provider_id: 'jio', area: 'Test', title: 'Test' }).expect(403)
    await mutate('post', `/api/outages/${outageA.id}/restore`, tech, {}).expect(403)
    for (const changes of [{ assigned_to: otherTech.id }, { priority: 'urgent' }, { title: 'Tampered' }, { outage_id: outageA.id }]) await patch(tech, ticketA, changes).expect(403)
  })

  it('denies foreign ticket updates/events and UUID replay without revealing another tenant', async () => {
    const before = await db.collection('tickets').findOne({ id: ticketB.id })
    await get(`/api/tickets/${ticketB.id}/events`, a).expect(404)
    await patch(a, ticketB, {}, 'Foreign write').expect(404)
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { id: ticketB.id })).expect(409)
    expect(await db.collection('tickets').findOne({ id: ticketB.id })).toEqual(before)
    expect(await db.collection('events').countDocuments({ company_id: a.company_id, ticket_id: ticketB.id })).toBe(0)
  })

  it('concurrent same-UUID ticket creation allocates exactly one number and creation event', async () => {
    const input = ticketInput(connectionA)
    const sequence = (await db.collection('companies').findOne({ id: a.company_id })).ticket_sequence
    const results = await Promise.all(Array.from({ length: 6 }, () => mutate('post', '/api/tickets', a, input)))
    expect(results.map(r => r.status)).toEqual(Array(6).fill(201))
    expect(await db.collection('tickets').countDocuments({ id: input.id })).toBe(1)
    expect((await db.collection('tickets').findOne({ id: input.id })).number).toBe(sequence + 1)
    expect((await db.collection('companies').findOne({ id: a.company_id })).ticket_sequence).toBe(sequence + 1)
    const events = await db.collection('events').find({ ticket_id: input.id }).toArray()
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].body)).toEqual({ action: 'created' })
  })

  it('optimistic concurrent updates permit exactly one winner and one atomic event', async () => {
    const results = await Promise.all([patch(a, ticketA, { title: 'Winner A' }), patch(a, ticketA, { title: 'Winner B' })])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    const stored = await db.collection('tickets').findOne({ id: ticketA.id })
    expect(stored.version).toBe(2)
    expect(stored.title).toBe(results[0].status === 200 ? 'Winner A' : 'Winner B')
    const events = (await get(`/api/tickets/${ticketA.id}/events`, a).expect(200)).body
    expect(events).toHaveLength(2)
    expect(JSON.parse(events.find(e => JSON.parse(e.body).action === 'updated').body).changes.title.to).toBe(stored.title)
  })

  it('waiting transitions require a nonblank reason and preserve actor-stamped notes', async () => {
    for (const status of ['waiting_customer', 'waiting_provider']) {
      await patch(tech, ticketA, { status }, '   ').expect(400)
    }
    expect((await db.collection('tickets').findOne({ id: ticketA.id })).version).toBe(1)
    await patch(tech, ticketA, { status: 'waiting_provider' }, 'Provider investigation pending').expect(200)
    const events = (await get(`/api/tickets/${ticketA.id}/events`, tech).expect(200)).body
    expect(events).toHaveLength(3)
    const note = events.find(e => JSON.parse(e.body).action === 'note')
    expect(note.actor_id).toBe(tech.id)
    expect(note.company_id).toBe(a.company_id)
    expect(JSON.parse(note.body).text).toBe('Provider investigation pending')
    await patch(tech, ticketA, { status: 'in_progress' }, '', 2).expect(200)
  })

  it('enforces resolution/close/reopen lifecycle and preserves prior resolution in the audit', async () => {
    await patch(a, ticketA, { status: 'closed' }).expect(400)
    await patch(a, ticketA, { status: 'resolved', resolution: '  ' }).expect(400)
    await patch(a, ticketA, { status: 'resolved', resolution: 'Replaced damaged cable' }).expect(200)
    await patch(a, ticketA, { status: 'closed', customer_feedback: 'Customer confirmed stable internet' }, '', 2).expect(200)
    await patch(a, ticketA, { status: 'waiting_provider' }, 'Invalid reopen', 3).expect(400)
    await patch(a, ticketA, { status: 'in_progress' }, 'Issue returned', 3).expect(200)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toMatchObject({ status: 'in_progress', resolution: '', version: 4 })
    const events = (await get(`/api/tickets/${ticketA.id}/events`, a).expect(200)).body.map(e => JSON.parse(e.body))
    expect(events.some(e => e.changes?.resolution?.from === 'Replaced damaged cable' && e.changes.resolution.to === '')).toBe(true)
    await patch(a, ticketA, { status: 'resolved', resolution: 'Historical fix' }, '', 4).expect(200)
    await mutate('post', '/api/staff', a, { action: 'update', id: tech.id, active: false }).expect(200)
    await patch(a, ticketA, { status: 'in_progress' }, '', 5).expect(400)
    await patch(a, ticketA, {}, 'Historical note allowed', 5).expect(200)
  })

  it('technicians resolve assigned work but cannot close, reopen or rewrite resolved fields', async () => {
    await patch(tech, ticketA, { status: 'resolved', resolution: 'Test repair completed' }).expect(200)
    for (const changes of [{ status: 'closed' }, { status: 'in_progress' }, { resolution: 'Overwrite history' }]) await patch(tech, ticketA, changes, '', 2).expect(403)
    await patch(tech, ticketA, {}, 'Post-resolution note', 2).expect(200)
    const unassigned = await ticket(a, connectionA)
    await patch(a, unassigned, { status: 'in_progress' }).expect(400)
    await patch(officeStaff, unassigned, { status: 'resolved', resolution: 'Phone support fix' }).expect(200)
  })

  it('hands resolved jobs to office staff for required customer feedback and audited closure', async () => {
    await patch(tech, ticketA, { status: 'resolved', resolution: 'Fibre replaced and tested' }).expect(200)
    for (const customer_feedback of ['', ' \n\t ']) {
      await patch(officeStaff, ticketA, { status: 'closed', customer_feedback }, '', 2).expect(400)
    }
    await patch(officeStaff, ticketA, { status: 'closed' }, 'A generic note is not customer feedback', 2).expect(400)
    await patch(tech, ticketA, { customer_feedback: 'Technician cannot impersonate office follow-up' }, '', 2).expect(403)
    await patch(b, ticketA, { status: 'closed', customer_feedback: 'Foreign feedback' }, '', 2).expect(404)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toMatchObject({ status: 'resolved', customer_feedback: '', version: 2 })
    await patch(officeStaff, ticketA, { customer_feedback: '  Called customer; internet is stable now.  ' }, '', 2).expect(200)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toMatchObject({ status: 'resolved', customer_feedback: 'Called customer; internet is stable now.', version: 3 })
    await patch(tech, ticketA, { status: 'closed' }, '', 3).expect(403)
    await patch(officeStaff, ticketA, { status: 'closed' }, '', 3).expect(200)
    await patch(officeStaff, ticketA, { customer_feedback: 'Rewrite after closure' }, '', 4).expect(400)
    const events = await db.collection('events').find({ ticket_id: ticketA.id }).toArray()
    const feedbackEvent = events.find(e => JSON.parse(e.body).changes?.customer_feedback?.to === 'Called customer; internet is stable now.')
    expect(feedbackEvent).toMatchObject({ actor_id: officeStaff.id, company_id: a.company_id })
    expect(events.some(e => e.actor_id === officeStaff.id && JSON.parse(e.body).changes?.status?.to === 'closed')).toBe(true)
  })

  it('requires fresh post-repair feedback after reopening and rejects prefilled feedback', async () => {
    await patch(officeStaff, ticketA, { customer_feedback: 'Before repair' }).expect(400)
    await patch(officeStaff, ticketA, { status: 'resolved', resolution: 'Fixed', customer_feedback: 'Collected too early' }).expect(400)
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { customer_feedback: 'Injected' })).expect(400)
    await patch(tech, ticketA, { status: 'resolved', resolution: 'First repair' }).expect(200)
    await patch(officeStaff, ticketA, { status: 'closed', customer_feedback: 'First repair confirmed' }, '', 2).expect(200)
    await patch(officeStaff, ticketA, { status: 'in_progress' }, 'Customer reported recurrence', 3).expect(200)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toMatchObject({ resolution: '', customer_feedback: '', version: 4 })
    const history = await db.collection('events').find({ ticket_id: ticketA.id }).toArray()
    expect(history.some(e => JSON.parse(e.body).changes?.customer_feedback?.from === 'First repair confirmed' && JSON.parse(e.body).changes.customer_feedback.to === '')).toBe(true)
    await patch(tech, ticketA, { status: 'resolved', resolution: 'Second repair' }, '', 4).expect(200)
    await patch(officeStaff, ticketA, { status: 'closed' }, '', 5).expect(400)
    await patch(officeStaff, ticketA, { status: 'closed', customer_feedback: 'Customer confirmed second repair' }, '', 5).expect(200)
  })

  it('requires feedback for legacy resolved records without fabricating it for legacy closed records', async () => {
    await db.collection('tickets').updateOne({ id: ticketA.id }, { $set: { status: 'resolved', resolution: 'Legacy repair' }, $unset: { customer_feedback: '' } })
    await patch(officeStaff, ticketA, { status: 'closed' }).expect(400)
    await patch(officeStaff, ticketA, { status: 'closed', customer_feedback: 'Customer contacted today' }).expect(200)
    await db.collection('tickets').updateOne({ id: ticketA.id }, { $unset: { customer_feedback: '' } })
    await patch(officeStaff, ticketA, {}, 'Historical note', 2).expect(200)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toMatchObject({ status: 'closed', customer_feedback: '' })
  })

  it('protects ticket identity, company ownership, relationships, version and audit fields', async () => {
    for (const changes of [{ company_id: b.company_id }, { id: randomUUID() }, { connection_id: connectionB.id }, { number: 999 }, { version: 99 }, { created_at: new Date().toISOString() }, { actor_id: b.id }]) await patch(a, ticketA, changes).expect(400)
    await mutate('patch', `/api/tickets/${ticketA.id}`, a, { version: 1, patch: {}, note: 'Test', actor_id: b.id }).expect(400)
    await mutate('post', '/api/tickets', a, ticketInput(connectionA, { company_id: b.company_id })).expect(400)
    expect(await db.collection('tickets').findOne({ id: ticketA.id })).toEqual(ticketA)
    expect(await db.collection('events').countDocuments({ ticket_id: ticketA.id })).toBe(1)
  })

  it.each([['JPEG', () => jpeg, 'image/jpeg'], ['PNG', () => png, 'image/png']])('uploads valid %s as stripped WebP through the real multipart endpoint', async (_name, bytes, mime) => {
    const sanitized = await sanitizeImage(bytes())
    expect((await sharp(sanitized).metadata()).format).toBe('webp')
    await upload(a, ticketA, bytes(), mime).expect(201)
    expect(media.upload).toHaveBeenCalledTimes(1)
    const [buffer, publicId] = media.upload.mock.calls[0]
    expect(Buffer.isBuffer(buffer)).toBe(true)
    const metadata = await sharp(buffer).metadata()
    expect(metadata.format).toBe('webp')
    expect(metadata.exif).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
    expect(publicId).toContain(`dsa/${a.company_id}/${ticketA.id}/`)
    expect(await db.collection('images').findOne({ public_id: publicId })).toMatchObject({ state: 'ready', company_id: a.company_id, ticket_id: ticketA.id })
    const events = await db.collection('events').find({ ticket_id: ticketA.id }).toArray()
    expect(events.some(e => JSON.parse(e.body).text === 'Ticket image added')).toBe(true)
  })

  it('rejects invalid MIME, undecodable bytes and SVG disguised as a permitted image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>')
    for (const [buffer, mime] of [[jpeg, 'text/plain'], [Buffer.from('not an image'), 'image/jpeg'], [svg, 'image/svg+xml'], [svg, 'image/png']]) await upload(a, ticketA, buffer, mime).expect(400)
    // Check the decoder independently so multipart rejection cannot mask content-validation regressions.
    await expect(sanitizeImage(svg)).rejects.toMatchObject({ status: 400 })
    await expect(sanitizeImage(Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 })
    expect(await db.collection('images').countDocuments()).toBe(0)
    noMediaCalls()
  })

  it('rejects uploads exceeding the 5 MiB transport limit without reserving or uploading', async () => {
    const tooLarge = Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024 + 1 - jpeg.length)])
    await upload(a, ticketA, tooLarge).expect(413)
    expect(await db.collection('images').countDocuments()).toBe(0)
    noMediaCalls()
  })

  it('atomically limits concurrent image reservations to six including pending uploads', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => upload(a, ticketA)))
    expect(results.map(r => r.status).sort()).toEqual([201, 201, 201, 201, 201, 201, 409, 409])
    expect(media.upload).toHaveBeenCalledTimes(6)
    expect(await db.collection('images').countDocuments({ ticket_id: ticketA.id })).toBe(6)
    expect(await db.collection('images').countDocuments({ ticket_id: ticketA.id, state: 'ready' })).toBe(6)
    await db.collection('images').updateOne({ ticket_id: ticketA.id }, { $set: { state: 'pending' } })
    await upload(a, ticketA).expect(409)
    expect(media.upload).toHaveBeenCalledTimes(6)
  }, 30000)

  it('authorizes foreign/unassigned/anonymous image operations BEFORE any media side effect', async () => {
    const foreign = await seedImage(ticketB)
    const unassigned = await seedImage(otherTicket)
    for (const [actor, item, image, expected] of [[a, ticketB, foreign, 404], [tech, otherTicket, unassigned, 404], [null, ticketB, foreign, 401]]) {
      const root = `/api/tickets/${item.id}/images`
      await get(root, actor).expect(expected)
      await get(`${root}/${image.id}/content`, actor).expect(expected)
      await mutate('delete', `${root}/${image.id}`, actor).expect(expected)
      // Malformed bytes prove authorization occurs before even decoding the upload.
      await upload(actor, item, Buffer.from('invalid')).expect(expected)
    }
    const own = await seedImage()
    await get(`/api/tickets/${ticketA.id}/images/${foreign.id}/content`, a).expect(404)
    await mutate('delete', `/api/tickets/${ticketA.id}/images/${foreign.id}`, a).expect(404)
    await patch(a, ticketA, { assigned_to: otherTech.id }).expect(200)
    await get(`/api/tickets/${ticketA.id}/images/${own.id}/content`, tech).expect(404)
    noMediaCalls()
  })

  it('serves protected image bytes with private cache headers and never exposes signed media URLs', async () => {
    const image = await seedImage()
    await seedImage(ticketA, 'pending')
    const listed = await get(`/api/tickets/${ticketA.id}/images`, tech).expect(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0]).toEqual({ id: image.id, ticket_id: ticketA.id, uploaded_by: a.id, created_at: image.created_at, url: `/api/tickets/${ticketA.id}/images/${image.id}/content` })
    expect(JSON.stringify(listed.body)).not.toMatch(/public_id|cloudinary|https:|signature|token/)
    const content = await get(listed.body[0].url, tech).expect(200)
    expect(content.headers['content-type']).toMatch(/^image\/webp/)
    expect(content.headers['cache-control']).toBe('private, no-store')
    expect(content.headers['x-content-type-options']).toBe('nosniff')
    expect(content.headers.location).toBeUndefined()
    expect(content.body).toEqual(webp)
    expect(media.download).toHaveBeenCalledExactlyOnceWith(image.public_id)
    await get(listed.body[0].url).expect(401)
    expect(media.download).toHaveBeenCalledTimes(1)
  })

  it('deletes authorized ready images, audits removal and rejects deleting pending images', async () => {
    const image = await seedImage()
    const pending = await seedImage(ticketA, 'pending')
    const root = `/api/tickets/${ticketA.id}/images`
    await mutate('delete', `${root}/${pending.id}`, a).expect(409)
    expect(media.destroy).not.toHaveBeenCalled()
    await mutate('delete', `${root}/${image.id}`, tech).expect(200)
    expect(media.destroy).toHaveBeenCalledExactlyOnceWith(image.public_id)
    expect(await db.collection('images').findOne({ id: image.id })).toBeNull()
    expect(blobs.has(image.public_id)).toBe(false)
    await get(`${root}/${image.id}/content`, a).expect(404)
    await mutate('delete', `${root}/${image.id}`, a).expect(404)
    expect(media.destroy).toHaveBeenCalledTimes(1)
    const events = await db.collection('events').find({ ticket_id: ticketA.id }).toArray()
    expect(events.filter(e => JSON.parse(e.body).text === 'Ticket image removed')).toHaveLength(1)
  })

  it('maintenance removes stale pending/deleting blobs but preserves ready and recent pending images', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60000).toISOString()
    const abandoned = await seedImage(ticketA, 'pending', stale)
    const deleting = await seedImage(ticketB, 'deleting')
    const ready = await seedImage(ticketA, 'ready', stale)
    const recent = await seedImage(ticketA, 'pending')
    await cleanupImages(db, media)
    expect(media.destroy.mock.calls.map(([id]) => id).sort()).toEqual([abandoned.public_id, deleting.public_id].sort())
    expect((await db.collection('images').find().toArray()).map(i => i.id).sort()).toEqual([ready.id, recent.id].sort())
    expect(blobs.has(ready.public_id)).toBe(true)
    expect(blobs.has(recent.public_id)).toBe(true)
    await cleanupImages(db, media)
    expect(media.destroy).toHaveBeenCalledTimes(2)
  })

  it('failed remote uploads retain recoverable pending reservations without exposing content or success events', async () => {
    media.upload.mockImplementationOnce(async (buffer, id) => {
      // Simulate remote persistence followed by a lost acknowledgement.
      blobs.set(id, Buffer.from(buffer))
      throw new Error('Simulated lost upload acknowledgement')
    })
    await upload(a, ticketA).expect(503)
    expect(media.upload).toHaveBeenCalledTimes(1)
    const pending = await db.collection('images').findOne({ ticket_id: ticketA.id })
    expect(pending).toMatchObject({ state: 'pending', company_id: a.company_id })
    expect((await get(`/api/tickets/${ticketA.id}/images`, a).expect(200)).body).toEqual([])
    await get(`/api/tickets/${ticketA.id}/images/${pending.id}/content`, a).expect(404)
    expect(await db.collection('events').countDocuments({ ticket_id: ticketA.id })).toBe(1)
    expect(media.download).not.toHaveBeenCalled()
    await db.collection('images').updateOne({ id: pending.id }, { $set: { created_at: new Date(Date.now() - 2 * 60 * 60000).toISOString() } })
    await cleanupImages(db, media)
    expect(media.destroy).toHaveBeenCalledExactlyOnceWith(pending.public_id)
    expect(await db.collection('images').findOne({ id: pending.id })).toBeNull()
    expect(blobs.has(pending.public_id)).toBe(false)
  })

  it('rechecks shared assignment after an in-flight remote upload before publishing the attachment', async () => {
    await patch(a, ticketA, { assigned_to: [tech.id, otherTech.id] }).expect(200)
    let started, finish
    const entered = new Promise(resolve => { started = resolve })
    const released = new Promise(resolve => { finish = resolve })
    media.upload.mockImplementationOnce(async (buffer, id) => {
      blobs.set(id, Buffer.from(buffer))
      started()
      await released
    })
    // Explicitly start supertest's lazy request, then revoke assignment while media is paused.
    const uploading = upload(tech, ticketA).then(response => response)
    try {
      const first = await Promise.race([entered.then(() => 'media'), uploading.then(response => response.status)])
      expect(first).toBe('media')
      await patch(a, ticketA, { assigned_to: [otherTech.id] }, '', 2).expect(200)
    } finally { finish() }
    const response = await uploading
    expect(response.status).toBe(404)
    expect(media.upload).toHaveBeenCalledTimes(1)
    expect(await db.collection('images').countDocuments({ ticket_id: ticketA.id, state: 'ready' })).toBe(0)
    expect(await db.collection('images').countDocuments({ ticket_id: ticketA.id, state: 'pending' })).toBe(1)
    await get(`/api/tickets/${ticketA.id}/images`, tech).expect(404)
    const events = await db.collection('events').find({ ticket_id: ticketA.id }).toArray()
    expect(events.some(e => JSON.parse(e.body).text === 'Ticket image added')).toBe(false)
  }, 30000)

  it('Mongo limiter atomically allows only the low maximum across concurrent callers', async () => {
    // Freeze only Date, not socket/timer scheduling; no fixed-window rollover flakiness.
    const NativeDate = Date
    const fixed = NativeDate.now()
    vi.stubGlobal('Date', class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])) }
      static now() { return fixed }
    })
    try {
      const results = await Promise.allSettled(Array.from({ length: 16 }, () => limit(db, 'fictional-limit', 3, 60000)))
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3)
      const rejected = results.filter(r => r.status === 'rejected')
      expect(rejected).toHaveLength(13)
      for (const result of rejected) expect(result.reason).toMatchObject({ status: 429 })
      const row = await db.collection('rate_limits').findOne({ _id: digest(`fictional-limit:${Math.floor(fixed / 60000)}`) })
      expect(row.count).toBe(16)
      expect(row.expires_at.getTime()).toBeGreaterThan(fixed)
      await expect(limit(db, 'independent-limit', 3, 60000)).resolves.toBeUndefined()
      expect(await db.collection('rate_limits').countDocuments()).toBe(2)
    } finally { vi.unstubAllGlobals() }
  })
})