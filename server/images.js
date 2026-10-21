import { randomUUID } from 'node:crypto'
import multer from 'multer'
import sharp from 'sharp'
import { demand, uuid, HttpError } from './schema.js'
import { companyWrite, findTicket, event, now } from './database.js'

const maxBytes = 5 * 1024 * 1024
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 }, fileFilter: (_req, file, done) => done(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) }).single('image')

export async function sanitizeImage(buffer) {
  try {
    const image = sharp(buffer, { limitInputPixels: 20000000, animated: false, failOn: 'warning' })
    const metadata = await image.metadata()
    demand(['jpeg', 'png', 'webp'].includes(metadata.format) && (!metadata.pages || metadata.pages === 1), 400, 'Choose a single JPEG, PNG or WebP image')
    // Decode and re-encode rather than trust MIME or extension. Strip EXIF/GPS.
    const output = await image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
    demand(output.length <= maxBytes, 400, 'Image is too large after processing')
    return output
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Image could not be decoded. Choose a valid JPEG, PNG or WebP image') }
}
export function installImages(app, { db, client, media, throttle }) {
  const root = '/api/tickets/:id/images'
  const visible = async req => { const id = uuid.parse(req.params.id); await findTicket(db, req.auth.user, id); return id }
  const shape = image => ({ id: image.id, ticket_id: image.ticket_id, uploaded_by: image.uploaded_by, created_at: image.created_at, url: `/api/tickets/${image.ticket_id}/images/${image.id}/content` })
  app.get(root, async (req, res) => {
    const ticket_id = await visible(req)
    const images = await db.collection('images').find({ company_id: req.auth.user.company_id, ticket_id, state: 'ready' }).toArray()
    res.json(images.map(shape))
  })
  app.post(root, async (req, _res, next) => {
    demand(media, 503, 'Image storage is not configured')
    await visible(req)
    await throttle(`images:${req.auth.user.id}`, 20, 60 * 60000)
    next()
  }, upload, async (req, res) => {
    demand(req.file?.buffer?.length, 400, 'Choose a JPEG, PNG or WebP image')
    const buffer = await sanitizeImage(req.file.buffer)
    const id = randomUUID(); const ticket_id = uuid.parse(req.params.id)
    const company_id = req.auth.user.company_id
    const public_id = `dsa/${company_id}/${ticket_id}/${id}`
    await companyWrite(client, db, req.auth, async (user, options) => {
      await findTicket(db, user, ticket_id, options)
      const count = await db.collection('images').countDocuments({ company_id, ticket_id }, options)
      demand(count < 6, 409, 'This ticket already has six images or pending uploads. Refresh before retrying')
      await db.collection('images').insertOne({ id, company_id, ticket_id, public_id, uploaded_by: user.id, created_at: now(), state: 'pending' }, options)
    })
    // No remote side effects inside retryable MongoDB transactions. Reservations
    // survive uncertain uploads/commits, allowing safe maintenance reconciliation.
    await media.upload(buffer, public_id)
    await companyWrite(client, db, req.auth, async (user, options) => {
      await findTicket(db, user, ticket_id, options)
      const result = await db.collection('images').updateOne({ id, company_id, state: 'pending' }, { $set: { state: 'ready' } }, options)
      demand(result.matchedCount, 409, 'Upload reservation unavailable')
      await event(db, user, ticket_id, { action: 'note', text: 'Ticket image added' }, options)
    })
    res.status(201).json({ ok: true })
  })
  app.get(`${root}/:imageId/content`, async (req, res) => {
    demand(media, 503, 'Image storage is not configured')
    const ticket_id = await visible(req); const id = uuid.parse(req.params.imageId)
    const image = await db.collection('images').findOne({ id, ticket_id, company_id: req.auth.user.company_id, state: 'ready' })
    demand(image, 404, 'Image unavailable')
    // Return bytes, never a redirect or signed CDN URL. Every request is authorized.
    const buffer = await media.download(image.public_id)
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="ticket-image.webp"' }).send(buffer)
  })
  app.delete(`${root}/:imageId`, async (req, res) => {
    demand(media, 503, 'Image storage is not configured')
    const ticket_id = uuid.parse(req.params.id); const id = uuid.parse(req.params.imageId)
    const image = await companyWrite(client, db, req.auth, async (user, options) => {
      await findTicket(db, user, ticket_id, options)
      const image = await db.collection('images').findOne({ id, ticket_id, company_id: user.company_id }, options)
      demand(image, 404, 'Image unavailable')
      demand(image.state !== 'pending', 409, 'Upload is still pending')
      await db.collection('images').updateOne({ id, company_id: user.company_id }, { $set: { state: 'deleting' } }, options)
      await event(db, user, ticket_id, { action: 'note', text: 'Ticket image removed' }, options)
      return image
    })
    await media.destroy(image.public_id)
    await db.collection('images').deleteOne({ id, company_id: image.company_id, state: 'deleting' })
    res.json({ ok: true })
  })
}

// Safe to run periodically or on restart. Never removes a ready attachment.
// Pending upload timeout is one hour, far beyond the remote request's 60s limit.
export async function cleanupImages(db, media, scope = {}) {
  if (!media) return
  const stale = new Date(Date.now() - 60 * 60000).toISOString()
  const cursor = db.collection('images').find({ ...scope, $or: [{ state: 'deleting' }, { state: 'pending', created_at: { $lt: stale } }] })
  for await (const image of cursor) {
    const claimed = await db.collection('images').findOneAndUpdate({ id: image.id, company_id: image.company_id, state: image.state }, { $set: { state: 'deleting' } }, { returnDocument: 'after' })
    if (!claimed) continue
    await media.destroy(image.public_id)
    await db.collection('images').deleteOne({ id: image.id, company_id: image.company_id, state: 'deleting' })
  }
}