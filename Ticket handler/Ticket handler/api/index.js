import { MongoClient } from 'mongodb'
import { createApp } from '../server/app.js'
import { initializeDatabase } from '../server/database.js'
import { cloudinaryMedia } from '../server/cloudinary.js'

// Cache the app and MongoDB client across serverless warm invocations.
// A cold start re-runs the setup; a warm invocation reuses the connection.
let cachedApp = null
let cachedClient = null

export default async function handler(req, res) {
  if (!cachedApp) {
    const dbName = process.env.MONGODB_DB || 'dsa_service_desk'
    if (!process.env.MONGODB_URI) {
      res.status(500).json({ error: 'MONGODB_URI environment variable is not set.' })
      return
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
      res.status(500).json({ error: 'Invalid MONGODB_DB value.' })
      return
    }

    const origins = (process.env.APP_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    if (!origins.length) {
      res.status(500).json({ error: 'APP_ORIGINS environment variable is not set.' })
      return
    }

    cachedClient = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    })

    try {
      await cachedClient.connect()
      const db = cachedClient.db(dbName)
      const hello = await db.command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') {
        await cachedClient.close()
        cachedClient = null
        res.status(500).json({ error: 'Transactions require MongoDB replica set or Atlas.' })
        return
      }
      await initializeDatabase(db)
      const media = cloudinaryMedia(process.env.CLOUDINARY_URL)

      cachedApp = await createApp({
        db,
        client: cachedClient,
        media,
        origins,
        production: true,
        // Vercel sits behind a trusted reverse proxy — required for correct req.ip
        // in rate limiting. Use '1' (single-hop Vercel proxy) rather than 'true'.
        trustProxy: 1,
        rateLimits: true,
        // staticDir is omitted: Vercel serves built frontend assets from /public
        // automatically; Express does not need to serve them in serverless mode.
        staticDir: undefined,
      })
    } catch (error) {
      if (cachedClient) {
        await cachedClient.close().catch(() => {})
        cachedClient = null
      }
      cachedApp = null
      console.error('API cold-start failed', { type: error.name, code: error.code })
      res.status(503).json({ error: 'Service temporarily unavailable. Please retry.' })
      return
    }
  }

  return cachedApp(req, res)
}
