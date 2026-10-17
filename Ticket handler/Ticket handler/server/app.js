import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { ZodError } from 'zod'
import { registerSchema, loginSchema, customerSchema, ticketSchema, updateSchema, outageSchema, staffSchema, uuid, demand, HttpError, ticketTransition } from './schema.js'
import { transaction, companyWrite, publicProfile, profileFields, providers, now, office, ticketFilter, findTicket, references, event, audit } from './database.js'
import { authenticate, hashPassword, verifyPassword, makeSession, setSessionCookie, cookieName, cookieOptions, limit } from './security.js'
import { installImages } from './images.js'
import { installPerformance } from './performance.js'
import { assignmentIds, sameAssignments } from './assignments.js'

export async function createApp({ db, client, media, origins, production = false, trustProxy = false, staticDir, rateLimits = true }) {
  const app = express()
  app.disable('x-powered-by')
  if (trustProxy) app.set('trust proxy', trustProxy)
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } }, strictTransportSecurity: production ? undefined : false, referrerPolicy: { policy: 'no-referrer' } }))
  app.use(cookieParser())
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!origins.includes(req.get('origin'))) return next(new HttpError(403, 'Request origin is not allowed'))
      if (req.get('sec-fetch-site') === 'cross-site') return next(new HttpError(403, 'Cross-site request blocked'))
    }
    next()
  })
  app.use('/api', express.json({ limit: '64kb', type: 'application/json' }))
  app.get('/api/health', async (_req, res) => { await db.command({ ping: 1 }); res.json({ ok: true }) })
  const throttle = async (key, max, ms) => { if (rateLimits) await limit(db, key, max, ms) }
  const dummyHash = await hashPassword(randomUUID())
  app.use('/api/auth', async (req, _res, next) => { await throttle(`auth-ip:${req.ip}`, 50, 15 * 60000); next() })

  app.post('/api/auth/register', async (req, res) => {
    const input = registerSchema.parse(req.body)
    await throttle(`signup:${req.ip}`, 5, 60 * 60000)
    const password_hash = await hashPassword(input.password)
    await transaction(client, async session => {
      const options = { session }
      const company_id = randomUUID()
      const user = { id: randomUUID(), company_id, full_name: input.full_name, email: input.email, password_hash, role: 'owner', active: true, must_change_password: false, auth_version: 1, email_verified: false, created_at: now() }
      await db.collection('companies').insertOne({ id: company_id, name: input.company_name, created_at: now(), revision: 0, ticket_sequence: 0 }, options)
      await db.collection('users').insertOne(user, options)
      await audit(db, user, 'company_registered', user.id, options)
    })
    res.status(201).json({ ok: true, email: input.email })
  })
  app.post('/api/auth/login', async (req, res) => {
    const input = loginSchema.parse(req.body)
    await throttle(`login-email:${input.email}`, 20, 15 * 60000)
    const candidate = await db.collection('users').findOne({ email: input.email })
    const valid = await verifyPassword(candidate?.password_hash ?? dummyHash, input.password)
    demand(candidate && valid && candidate.active, 401, 'Email or password is incorrect, or access is inactive')
    const login = await transaction(client, async session => {
      const options = { session }
      await db.collection('companies').updateOne({ id: candidate.company_id }, { $inc: { revision: 1 } }, options)
      const user = await db.collection('users').findOne({ id: candidate.id, active: true, auth_version: candidate.auth_version }, options)
      demand(user, 401, 'Account changed. Sign in again')
      const login = makeSession(user)
      await db.collection('sessions').insertOne(login.document, options)
      return login
    })
    setSessionCookie(res, login.token, production)
    res.json({ user: { id: candidate.id, email: candidate.email } })
  })
  app.post('/api/auth/logout', async (req, res) => {
    // Idempotent even for expired accounts; invalidate server token before clearing cookie.
    const token = req.cookies[cookieName(production)]
    if (typeof token === 'string') {
      const { digest } = await import('./security.js')
      await db.collection('sessions').deleteOne({ _id: digest(token) })
    }
    res.clearCookie(cookieName(production), cookieOptions(production)).json({ ok: true })
  })
  app.use('/api', async (req, res, next) => {
    req.auth = await authenticate(db, req, production)
    setSessionCookie(res, req.cookies[cookieName(production)], production)
    next()
  })
  app.get('/api/auth/session', (req, res) => res.json({ user: { id: req.auth.user.id, email: req.auth.user.email } }))
  app.get('/api/profile', (req, res) => res.json(publicProfile(req.auth.user)))
  app.use('/api', async (req, _res, next) => {
    demand(req.auth.user.active, 403, 'Staff access is inactive')
    demand(!req.auth.user.must_change_password || (req.path === '/staff' && req.method === 'POST' && req.body?.action === 'change_password'), 403, 'Change your temporary password first')
    await throttle(`user:${req.auth.user.id}`, 300, 60000)
    next()
  })
  app.get('/api/workspace', async (req, res) => {
    // Snapshot includes fresh membership; avoids mixing assignment snapshots.
    const result = await transaction(client, async session => {
      const options = { session, projection: { _id: 0 } }
      const user = await db.collection('users').findOne({ id: req.auth.user.id, active: true, must_change_password: false, auth_version: req.auth.user.auth_version }, options)
      demand(user, 401, 'Account changed. Sign in again')
      const scope = { company_id: user.company_id }
      const tickets = await db.collection('tickets').find(ticketFilter(user), options).toArray()
      const connections = await db.collection('connections').find({ ...scope, ...(user.role === 'technician' ? { id: { $in: tickets.map(t => t.connection_id).filter(id => typeof id === 'string') } } : {}) }, options).toArray()
      const customers = await db.collection('customers').find({ ...scope, ...(user.role === 'technician' ? { id: { $in: connections.map(c => c.customer_id) } } : {}) }, options).toArray()
      const companies = await db.collection('companies').find({ id: user.company_id }, { session, projection: { _id: 0, id: 1, name: 1, created_at: 1 } }).toArray()
      const profiles = await db.collection('users').find(scope, { session, projection: profileFields }).toArray()
      const outages = await db.collection('outages').find(scope, options).toArray()
      return { companies, profiles, tickets, customers, connections, outages, providers }
    })
    res.json(result)
  })
  app.get('/api/tickets/:id/events', async (req, res) => {
    const id = uuid.parse(req.params.id)
    await findTicket(db, req.auth.user, id)
    res.json(await db.collection('events').find({ company_id: req.auth.user.company_id, ticket_id: id }, { projection: { _id: 0 } }).sort({ created_at: 1, id: 1 }).toArray())
  })
  app.post('/api/customers', async (req, res) => {
    const input = customerSchema.parse(req.body)
    const id = await companyWrite(client, db, req.auth, async (user, options) => {
      office(user)
      const { provider_id, account_number, network_node, ...customer } = input
      const customer_id = randomUUID(); const id = randomUUID(); const company_id = user.company_id
      await db.collection('customers').insertOne({ ...customer, id: customer_id, company_id, created_at: now() }, options)
      await db.collection('connections').insertOne({ id, company_id, customer_id, provider_id, account_number, network_node }, options)
      return id
    })
    res.status(201).json({ id })
  })
  app.post('/api/tickets', async (req, res) => {
    const input = ticketSchema.parse(req.body)
    await companyWrite(client, db, req.auth, async (user, options) => {
      office(user)
      // UUID retries acknowledge only a ticket already in this caller's company.
      if (await db.collection('tickets').findOne({ id: input.id, company_id: user.company_id }, options)) return
      await references(db, user, input, options)
      const company = await db.collection('companies').findOneAndUpdate({ id: user.company_id }, { $inc: { ticket_sequence: 1 } }, { ...options, returnDocument: 'after' })
      await db.collection('tickets').insertOne({ ...input, company_id: user.company_id, number: company.ticket_sequence, status: input.assigned_to.length ? 'assigned' : 'new', provider_reference: '', visit_at: null, follow_up_at: null, resolution: '', customer_feedback: '', created_at: now(), updated_at: now(), version: 1 }, options)
      await event(db, user, input.id, { action: 'created' }, options)
    })
    res.status(201).json({ ok: true })
  })
  app.patch('/api/tickets/:id', async (req, res) => {
    const id = uuid.parse(req.params.id); const { version, patch, note } = updateSchema.parse(req.body)
    await companyWrite(client, db, req.auth, async (user, options) => {
      const ticket = await findTicket(db, user, id, options)
      demand(ticket.version === version, 409, 'Ticket changed. Reload latest fields before saving')
      const { next, reopening } = ticketTransition(ticket, patch, note, user)
      const assignmentChanged = !sameAssignments(next.assigned_to, ticket.assigned_to)
      await references(db, user, next, options, reopening || assignmentChanged)
      const changes = Object.fromEntries(Object.keys(next)
        .filter(key => key !== '_id' && (key === 'assigned_to' ? assignmentChanged : next[key] !== ticket[key]))
        .map(key => [key, { from: key === 'assigned_to' ? assignmentIds(ticket[key]) : ticket[key], to: next[key] }]))
      const { _id, ...document } = next
      await db.collection('tickets').updateOne({ id, company_id: user.company_id, version }, { $set: { ...document, version: version + 1, updated_at: now() } }, options)
      if (Object.keys(changes).length) await event(db, user, id, { action: 'updated', changes }, options)
      if (note) await event(db, user, id, { action: 'note', text: note }, options)
    })
    res.json({ ok: true })
  })
  app.post('/api/outages', async (req, res) => {
    const input = outageSchema.parse(req.body)
    await companyWrite(client, db, req.auth, async (user, options) => { office(user); await db.collection('outages').insertOne({ ...input, id: randomUUID(), company_id: user.company_id, status: 'active', created_at: now(), restored_at: null }, options) })
    res.status(201).json({ ok: true })
  })
  app.post('/api/outages/:id/restore', async (req, res) => {
    const id = uuid.parse(req.params.id)
    await companyWrite(client, db, req.auth, async (user, options) => {
      office(user)
      const result = await db.collection('outages').updateOne({ id, company_id: user.company_id }, { $set: { status: 'restored', restored_at: now() } }, options)
      demand(result.matchedCount, 404, 'Outage unavailable')
    })
    res.json({ ok: true })
  })
  app.post('/api/staff', async (req, res) => {
    const input = staffSchema.parse(req.body)
    await throttle(`staff:${req.auth.user.id}`, 30, 15 * 60000)
    const password_hash = 'password' in input ? await hashPassword(input.password) : undefined
    await companyWrite(client, db, req.auth, async (user, options) => {
      if (input.action === 'change_password') {
        demand(Date.now() - new Date(req.auth.login.created_at).getTime() < 15 * 60000, 403, 'Sign out and sign in again before changing your password')
        const auth_version = user.auth_version + 1
        await db.collection('users').updateOne({ id: user.id, company_id: user.company_id }, { $set: { password_hash, must_change_password: false, auth_version } }, options)
        // Keep this session, invalidate all others atomically through auth_version.
        await db.collection('sessions').updateOne({ _id: req.auth.tokenHash }, { $set: { auth_version } }, options)
        await audit(db, user, 'password_changed', user.id, options)
        return
      }
      demand(user.role === 'owner', 403, 'Owner access required')
      if (input.action === 'create') {
        const id = randomUUID()
        await db.collection('users').insertOne({ id, company_id: user.company_id, full_name: input.full_name, email: input.email, password_hash, role: input.role, active: true, must_change_password: true, auth_version: 1, email_verified: false, created_at: now() }, options)
        await audit(db, user, 'staff_created', id, options)
        return
      }
      const target = await db.collection('users').findOne({ id: input.id, company_id: user.company_id }, options)
      demand(target, 404, 'Staff member unavailable')
      demand(target.role !== 'owner', 403, 'Owner accounts cannot be changed through team administration')
      const fields = input.action === 'reset_password' ? { password_hash, must_change_password: true } : { ...(input.role ? { role: input.role } : {}), ...(input.active !== undefined ? { active: input.active } : {}) }
      demand(Object.keys(fields).length, 400, 'Provide a staff change')
      await db.collection('users').updateOne({ id: target.id, company_id: user.company_id }, { $set: fields, $inc: { auth_version: 1 } }, options)
      await audit(db, user, input.action, target.id, options)
    }, input.action === 'change_password')
    res.json({ ok: true })
  })
  installPerformance(app, { db, client })
  installImages(app, { db, client, media, throttle })
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found' }))
  if (staticDir) {
    app.use(express.static(resolve(staticDir), { index: false, dotfiles: 'deny', setHeaders: (res, path) => res.set('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store') }))
    app.get('/{*path}', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(resolve(staticDir, 'index.html')) })
  }
  app.use((error, _req, res, _next) => {
    // Never serialize database errors, credentials, request bodies or Cloudinary URLs.
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.') || 'Request'}: ${i.message}`).join('; ') })
    if (error.code === 11000) return res.status(409).json({ error: 'An account or record already exists. Sign in or check existing records before retrying' })
    if (error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' })
    if (error.name === 'MulterError' || error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request or image upload' })
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
    console.error('API request failed', { type: error.name || 'Error', code: typeof error.code === 'number' ? error.code : undefined })
    res.status(503).json({ error: 'Server request could not be confirmed. Refresh before retrying' })
  })
  return app
}