import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { demand } from './schema.js'

export const digest = text => createHash('sha256').update(text).digest('hex')
export const hashPassword = password => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
export const verifyPassword = (hash, password) => argon2.verify(hash, password)
export const cookieOptions = production => ({ httpOnly: true, secure: production, sameSite: 'strict', path: '/' })
export const cookieName = production => production ? '__Host-dsa_session' : 'dsa_session'
// Browsers cap persistent cookies (commonly 400 days). Renew on authenticated
// requests; the server session itself has no time-based expiry. Revocation stays.
const lifetime = 400 * 24 * 60 * 60 * 1000
export const validSession = () => ({ $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: new Date() } }] })
export function makeSession(user) {
  const token = randomBytes(32).toString('base64url')
  return { token, document: { _id: digest(token), user_id: user.id, auth_version: user.auth_version, created_at: new Date() } }
}
export function setSessionCookie(res, token, production) { res.cookie(cookieName(production), token, { ...cookieOptions(production), maxAge: lifetime }) }
export async function authenticate(db, req, production) {
  const token = req.cookies[cookieName(production)]
  demand(typeof token === 'string' && /^[\w-]{43}$/.test(token), 401, 'Sign in to continue')
  const tokenHash = digest(token)
  const login = await db.collection('sessions').findOne({ _id: tokenHash, ...validSession() })
  demand(login, 401, 'Session expired. Sign in again')
  const user = await db.collection('users').findOne({ id: login.user_id })
  demand(user && user.auth_version === login.auth_version, 401, 'Session expired. Sign in again')
  if (login.expires_at) {
    // Upgrade only an existing, still-valid old session. Never upsert or revive
    // expired/logged-out sessions, and do not reset recent-login security checks.
    const upgraded = await db.collection('sessions').updateOne({ _id: tokenHash, auth_version: login.auth_version, expires_at: { $gt: new Date() } }, { $unset: { expires_at: '' } })
    demand(upgraded.matchedCount || await db.collection('sessions').findOne({ _id: tokenHash, auth_version: login.auth_version, expires_at: { $exists: false } }), 401, 'Session expired. Sign in again')
  }
  return { tokenHash, login, user }
}
// Distributed fixed-window limiter. Atomic counters remain bounded across workers.
export async function limit(db, key, max, windowMs) {
  const window = Math.floor(Date.now() / windowMs)
  const _id = digest(`${key}:${window}`)
  let entry
  try {
    entry = await db.collection('rate_limits').findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((window + 2) * windowMs) } }, { upsert: true, returnDocument: 'after' })
  } catch (error) {
    if (error.code !== 11000) throw error
    entry = await db.collection('rate_limits').findOneAndUpdate({ _id }, { $inc: { count: 1 } }, { returnDocument: 'after' })
  }
  demand(entry && entry.count <= max, 429, 'Too many attempts. Try again later')
}