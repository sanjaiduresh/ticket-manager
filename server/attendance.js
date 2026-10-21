import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { companyWrite, now, office, transaction } from './database.js'
import { demand, uuid } from './schema.js'
import { performanceRange } from './performance.js'

export const attendanceDay = timestamp => new Date(Date.parse(timestamp) + 330 * 60000).toISOString().slice(0, 10)
const attendanceSchema = z.strictObject({
  id: uuid, employee_id: uuid, day: z.string(), version: z.number().int().min(0),
  status: z.enum(['present', 'absent', 'half_day', 'leave']),
  check_in: z.iso.datetime({ offset: true }).nullable(), check_out: z.iso.datetime({ offset: true }).nullable(),
  note: z.string().trim().max(2000),
})
export function attendanceInput(body, timestamp = now()) {
  const input = attendanceSchema.parse(body)
  performanceRange({ from: input.day, to: input.day })
  demand(input.day <= attendanceDay(timestamp), 400, 'Attendance cannot be recorded for a future day')
  if (input.check_in) input.check_in = new Date(input.check_in).toISOString()
  if (input.check_out) input.check_out = new Date(input.check_out).toISOString()
  demand(!['absent', 'leave'].includes(input.status) || (!input.check_in && !input.check_out), 400, 'Absent and leave records cannot have check-in or check-out times')
  demand(!input.check_in || attendanceDay(input.check_in) === input.day, 400, 'Check-in must fall on the attendance day in IST')
  demand(!input.check_out || (input.check_in && input.check_out >= input.check_in), 400, 'Check-out requires a check-in and cannot be earlier')
  demand((!input.check_in || input.check_in <= timestamp) && (!input.check_out || input.check_out <= timestamp), 400, 'Attendance times cannot be in the future')
  return input
}
export function attendanceRecord(record) {
  const { _id, ...fields } = record
  return { ...fields, status: record.status ?? 'present', note: record.note ?? '', version: record.version ?? 1,
    recorded_by: record.recorded_by ?? null, updated_by: record.updated_by ?? null, updated_at: record.updated_at ?? null }
}

export function installAttendance(app, { db, client }) {
  app.get('/api/attendance', async (req, res) => {
    const range = performanceRange(req.query)
    const result = await transaction(client, async session => {
      const user = await db.collection('users').findOne({ id: req.auth.user.id, company_id: req.auth.user.company_id,
        active: true, must_change_password: false, auth_version: req.auth.user.auth_version }, { session })
      demand(user, 403, 'Staff access changed. Sign in again')
      const options = { session, projection: { _id: 0 } }
      const scope = { company_id: user.company_id }
      const records = await db.collection('attendance').find({ ...scope,
        ...(user.role === 'technician' ? { employee_id: user.id } : {}),
        day: { $gte: range.from, $lte: range.to } }, options).sort({ day: -1, check_in: -1, id: 1 }).toArray()
      return { from: range.from, to: range.to, generated_at: now(), records: records.map(attendanceRecord) }
    })
    res.json(result)
  })
  app.post('/api/attendance', async (req, res) => {
    office(req.auth.user)
    const input = attendanceInput(req.body)
    await companyWrite(client, db, req.auth, async (user, options) => {
      office(user)
      const { id, version, ...fields } = input
      const scope = { company_id: user.company_id }
      demand(await db.collection('users').findOne({ ...scope, id: fields.employee_id }, options), 404, 'Employee unavailable')
      const prior = await db.collection('attendance').findOne({ ...scope, id }, options)
      if (prior) {
        demand(prior.employee_id === fields.employee_id && prior.day === fields.day, 400, 'Employee and attendance day cannot be changed; edit the correct daily record')
        const unchanged = Object.entries(fields).every(([key, value]) => attendanceRecord(prior)[key] === value)
        if (unchanged && prior.updated_by === user.id && prior.version === version + 1) return
        demand((prior.version ?? 1) === version, 409, 'Attendance changed. Reload the record before saving')
        if (unchanged) return
      } else {
        demand(version === 0, 404, 'Attendance record unavailable')
        demand(!await db.collection('attendance').findOne({ ...scope, employee_id: fields.employee_id, day: fields.day }, options), 409, 'Attendance already exists for this employee and day. Edit the existing record')
      }
      const timestamp = now()
      const next = { id, ...scope, ...fields, version: version + 1, recorded_by: prior ? prior.recorded_by ?? null : user.id,
        created_at: prior?.created_at ?? prior?.check_in ?? timestamp, updated_by: user.id, updated_at: timestamp }
      if (prior) await db.collection('attendance').replaceOne({ ...scope, id }, next, options)
      else await db.collection('attendance').insertOne(next, options)
      await db.collection('attendance_audit').insertOne({ id: randomUUID(), ...scope, attendance_id: id, employee_id: fields.employee_id,
        actor_id: user.id, created_at: timestamp, before: prior ? attendanceRecord(prior) : null, after: next }, options)
    })
    res.json({ ok: true })
  })
  app.post(['/api/attendance/check-in', '/api/attendance/check-out'], (_req, res) => {
    res.status(403).json({ error: 'Self-service attendance is disabled. Ask office staff or the owner to record attendance' })
  })
}