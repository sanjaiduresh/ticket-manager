import { MongoClient } from 'mongodb'
import { createApp } from './app.js'
import { initializeDatabase } from './database.js'
import { cloudinaryMedia } from './cloudinary.js'
import { cleanupImages } from './images.js'

const production = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT || 3001)
const origins = (process.env.APP_ORIGINS || (production ? '' : 'http://127.0.0.1:5173,http://localhost:5173')).split(',').map(s => s.trim()).filter(Boolean)
if (!process.env.MONGODB_URI || !origins.length || origins.some(value => { try { const u = new URL(value); return u.origin !== value || (production && u.protocol !== 'https:') } catch { return true } })) {
  console.error('Set server-only MONGODB_URI and valid APP_ORIGINS (HTTPS in production).')
  process.exit(1)
}
const dbName = process.env.MONGODB_DB || 'dsa_service_desk'
if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) { console.error('Invalid MONGODB_DB'); process.exit(1) }
const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 })
try {
  await client.connect()
  const db = client.db(dbName)
  const hello = await db.command({ hello: 1 })
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transactions require MongoDB replica set or Atlas')
  await initializeDatabase(db)
  const media = cloudinaryMedia(process.env.CLOUDINARY_URL)
  const app = await createApp({ db, client, media, origins, production, trustProxy: process.env.TRUST_PROXY || false, staticDir: production ? 'dist' : undefined })
  const server = app.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log(`DSA API ready on port ${port}; database ${dbName}`))
  server.requestTimeout = 90000
  const sweep = () => cleanupImages(db, media).catch(() => console.error('Image reconciliation failed; will retry.'))
  void sweep()
  const timer = setInterval(sweep, 15 * 60000); timer.unref()
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearInterval(timer); server.close(() => { void client.close().then(() => process.exit(0)) }) })
} catch (error) {
  console.error('API startup failed. Check MongoDB credentials, Atlas network access and replica-set availability.', { type: error.name, code: typeof error.code === 'number' ? error.code : undefined })
  await client.close()
  process.exitCode = 1
}