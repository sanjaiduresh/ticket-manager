import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Building2 } from 'lucide-react'
import { PriorityBadge } from '../src/components/shared'
import { AssigneeSelector } from '../src/components/assignee-selector'
import { assigneeIds, assigneeNames, sameAssignees } from '../src/lib/assignees'
import { csvText, customerSchema, errorMessage, escapeFormula, eventText, fromIstInput, isOpen, passwordSchema, reference, toIstInput, validateImport } from '../src/lib/format'
import { createDemoApi } from '../src/lib/demo'
import { QueryClient } from '@tanstack/react-query'
import { deskQueryOptions, discardOtherWorkspaces, profileKey, workspaceScope } from '../src/lib/queries'

import { apiRequest } from '../src/lib/http'
import { liveApi, imageFileError } from '../src/lib/data'
import { whatsappLink, whatsappMessage, whatsappNumberError, whatsappTicketUrl } from '../src/lib/whatsapp'
import { hasSavedSession, saveSessionHint, sessionHintKey } from '../src/lib/session'
import { computeDemoPerformance, emptyReportFilters, filterReportTickets, istDate, operationalSeries, performanceExportRows, rangeError, recentRange, ticketExportRows } from '../src/lib/reporting'
import type { AttendanceInput, AttendanceReport, Ticket, TicketEvent, TicketInput } from '../src/lib/types'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const customer = { full_name: 'Fictional Example', phone: '0000000000', address: 'Example address', area: 'Example area', provider_id: 'niss' as const, account_number: 'DEMO-NEW', network_node: '' }
describe('manual WhatsApp sharing', () => {
  it('validates optional international contacts and constructs only encoded wa.me links', () => {
    for (const phone of ['', '+12025550123', ' +919876543210 ', '+1234567', '+123456789012345']) expect(whatsappNumberError(phone)).toBe('')
    for (const phone of ['919876543210', '+01234567', '+123', '+1234567890123456', '+1 202 555 0123', '+1202&text=secret', 'javascript:alert(1)']) {
      expect(whatsappNumberError(phone)).not.toBe('')
      expect(whatsappLink(phone, 'Test')).toBeNull()
    }
    expect(whatsappLink('', 'Test')).toBeNull()
    const message = 'Hello & next?\nनमस्ते #ticket'
    const url = new URL(whatsappLink('+12025550123', message)!)
    expect(url.origin).toBe('https://wa.me'); expect(url.pathname).toBe('/12025550123')
    expect(url.searchParams.get('text')).toBe(message)
    expect([...url.searchParams.keys()]).toEqual(['text'])
  })
  it('shares minimal ticket context and a clean sign-in link, never customer text or credentials', async () => {
    const ticket = (await createDemoApi().load()).tickets[0]
    const message = whatsappMessage(ticket, 'https://desk.example.test/old?token=secret#fragment')
    expect(message).toContain('DSA-1042'); expect(message).toContain('Priority: High')
    expect(message).toContain('https://desk.example.test/tickets?ticket=demo-t-0')
    expect(message).not.toContain(ticket.title); expect(message).not.toContain(ticket.description)
    expect(message).not.toContain('secret'); expect(message).not.toContain('fragment')
    for (const origin of ['http://127.0.0.1:4173', 'https://localhost', 'https://app.localhost', 'https://[::1]', 'javascript:alert(1)', 'https://user:secret@desk.example.test', 'invalid']) expect(whatsappTicketUrl(origin, ticket.id)).toBeNull()
    expect(whatsappMessage(ticket, 'http://127.0.0.1:4173')).not.toContain('127.0.0.1')
  })
  it('supports demo owner contact changes/removal without publishing contacts to public profiles', async () => {
    const api = createDemoApi()
    await api.staff({ action: 'set_whatsapp', id: 'demo-tech-1', whatsapp_number: '+12025550123' })
    expect((await api.load()).profiles.find(p => p.id === 'demo-tech-1')?.whatsapp_number).toBe('+12025550123')
    expect(await api.profile('demo-tech-1')).not.toHaveProperty('whatsapp_number')
    await expect(api.staff({ action: 'set_whatsapp', id: 'demo-tech-1', whatsapp_number: 'bad' })).rejects.toThrow('country code')
    await api.staff({ action: 'set_whatsapp', id: 'demo-tech-1', whatsapp_number: '' })
    expect((await api.load()).profiles.find(p => p.id === 'demo-tech-1')?.whatsapp_number).toBe('')
    for (const id of ['demo-tech-1', 'demo-office']) await expect(createDemoApi(id).staff({ action: 'set_whatsapp', id: 'demo-tech-2', whatsapp_number: '+12025550123' })).rejects.toThrow('Owner access')
  })
})
describe('attendance and notification data sources', () => {
  const range = { from: '2026-10-01', to: '2026-10-20' }
  const entry = (patch: Partial<AttendanceInput> = {}): AttendanceInput => ({ id: crypto.randomUUID(), employee_id: 'demo-tech-1', day: '2026-10-19', status: 'present', check_in: null, check_out: null, note: '', version: 0, ...patch })
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T12:00:00Z')) })

  it.each(['demo-owner', 'demo-office'])('allows %s to record all four statuses for employees, with optional times and attribution', async actor => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const api = createDemoApi(actor)
    expect((await api.attendance(range)).records).toEqual([])
    const statuses = ['present', 'absent', 'half_day', 'leave'] as const
    for (const [index, status] of statuses.entries()) {
      const input = entry({ status, day: `2026-10-${16 + index}`, note: `  ${status} recorded by office  ` })
      await api.saveAttendance(input)
      expect(input.note).toBe(`  ${status} recorded by office  `)
      expect((await api.attendance(range)).records.find(record => record.id === input.id)).toEqual({ ...input, note: input.note.trim(), company_id: 'demo-company', version: 1, recorded_by: actor, updated_by: actor, updated_at: '2026-10-20T12:00:00.000Z' })
    }
    const timed = entry({ day: '2026-10-20', employee_id: 'demo-office', check_in: '2026-10-20T09:00:00+05:30', check_out: '2026-10-20T13:30:00+05:30' })
    await api.saveAttendance(timed)
    expect((await api.attendance(range)).records[0]).toMatchObject({ id: timed.id, check_in: '2026-10-20T03:30:00.000Z', check_out: '2026-10-20T08:00:00.000Z' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('edits the same daily record, preserves its recorder, and makes exact retries and no-op saves idempotent', async () => {
    const api = createDemoApi('demo-office'), input = entry({ note: 'Original entry' })
    await api.saveAttendance(input)
    const created = (await api.attendance(range)).records[0]
    vi.setSystemTime(new Date('2026-10-20T13:00:00Z'))
    await api.saveAttendance(input)
    await api.saveAttendance({ ...input, version: 1 })
    expect((await api.attendance(range)).records).toEqual([created])
    const correction = { ...input, version: 1, status: 'half_day' as const, check_in: '2026-10-19T03:30:00Z', check_out: '2026-10-19T07:30:00Z', note: '  Corrected after review  ' }
    await api.saveAttendance(correction)
    const updated = (await api.attendance(range)).records[0]
    expect(updated).toEqual({ ...created, status: 'half_day', check_in: '2026-10-19T03:30:00.000Z', check_out: '2026-10-19T07:30:00.000Z', note: 'Corrected after review', version: 2, recorded_by: created.recorded_by, updated_by: 'demo-office', updated_at: '2026-10-20T13:00:00.000Z' })
    vi.setSystemTime(new Date('2026-10-20T14:00:00Z'))
    await api.saveAttendance(correction)
    await api.saveAttendance({ ...correction, version: 2 })
    expect((await api.attendance(range)).records).toEqual([updated])
    await expect(api.saveAttendance(input)).rejects.toThrow('Attendance changed')
    await api.saveAttendance({ ...input, status: 'leave', version: 2 })
    expect((await api.attendance(range)).records).toEqual([expect.objectContaining({ id: input.id, version: 3, status: 'leave', check_in: null, check_out: null })])
  })
  it('rejects concurrent creates/edits, stale versions and identity changes without partial writes', async () => {
    const api = createDemoApi(), input = entry()
    const creates = await Promise.allSettled([api.saveAttendance(input), api.saveAttendance({ ...input, id: crypto.randomUUID() })])
    expect(creates.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(creates[1]).toMatchObject({ reason: new Error('Attendance already exists for this employee and day. Edit the existing record') })
    const edits = await Promise.allSettled([api.saveAttendance({ ...input, version: 1, note: 'Winning correction' }), api.saveAttendance({ ...input, version: 1, note: 'Stale correction' })])
    expect(edits.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(edits[1]).toMatchObject({ reason: new Error('Attendance changed. Reload the record before saving') })
    const before = await api.attendance(range)
    for (const [patch, message] of [
      [{ version: 0 }, 'Attendance changed'], [{ version: 99 }, 'Attendance changed'],
      [{ version: 2, employee_id: 'demo-tech-2' }, 'Employee and attendance day cannot be changed'],
      [{ version: 2, day: '2026-10-18' }, 'Employee and attendance day cannot be changed'],
      [{ id: crypto.randomUUID(), version: 1 }, 'Attendance record unavailable'],
    ] as const) {
      await expect(api.saveAttendance({ ...input, ...patch })).rejects.toThrow(message)
      expect(await api.attendance(range)).toEqual(before)
    }
    expect(before.records).toEqual([expect.objectContaining({ id: input.id, note: 'Winning correction', version: 2 })])
  })
  it.each([
    [{ day: '2026-02-30' }, /valid|date/i], [{ day: '2026-10-21' }, /future day/],
    [{ employee_id: 'foreign-employee' }, /Employee unavailable/],
    [{ status: 'invalid' }, /Invalid attendance status or version/],
    [{ version: -1 }, /Invalid attendance status or version/], [{ version: 0.5 }, /Invalid attendance status or version/],
    [{ note: 'x'.repeat(2001) }, /Notes must be text/], [{ note: null }, /Notes must be text/],
    [{ check_in: 'not-a-time' }, /Invalid attendance time/], [{ check_out: 'not-a-time' }, /Invalid attendance time/],
    [{ check_in: '2026-10-20T13:00:00Z' }, /future/],
    [{ check_in: '2026-10-18T18:29:59Z' }, /attendance day in IST/],
    [{ check_out: '2026-10-19T08:00:00Z' }, /requires a check-in/],
    [{ check_in: '2026-10-19T04:00:00Z', check_out: '2026-10-19T03:00:00Z' }, /cannot be earlier/],
    [{ check_in: '2026-10-19T04:00:00Z', check_out: '2026-10-20T13:00:00Z' }, /future/],
    [{ status: 'absent', check_in: '2026-10-19T04:00:00Z' }, /cannot have attendance times/],
    [{ status: 'leave', check_out: '2026-10-19T08:00:00Z' }, /cannot have attendance times/],
  ])('rejects invalid daily input %j atomically on create and edit', async (patch, message) => {
    const api = createDemoApi(), input = entry()
    await expect(api.saveAttendance({ ...input, ...patch } as AttendanceInput)).rejects.toThrow(message)
    expect((await api.attendance(range)).records).toEqual([])
    await api.saveAttendance(input)
    const before = await api.attendance(range)
    await expect(api.saveAttendance({ ...input, version: 1, ...patch } as AttendanceInput)).rejects.toThrow(message)
    expect(await api.attendance(range)).toEqual(before)
  })
  it('accepts IST midnight, overnight and check-in-only times, inactive employees and maximum notes', async () => {
    const api = createDemoApi()
    await api.staff({ action: 'update', id: 'demo-tech-1', active: false })
    await api.saveAttendance(entry({ check_in: '2026-10-18T18:30:00Z', check_out: '2026-10-19T19:30:00Z', note: 'x'.repeat(2000) }))
    await api.saveAttendance(entry({ day: '2026-10-20', status: 'half_day', check_in: '2026-10-19T18:30:00Z' }))
    expect((await api.attendance(range)).records).toEqual([
      expect.objectContaining({ day: '2026-10-20', status: 'half_day', check_out: null }),
      expect.objectContaining({ day: '2026-10-19', check_in: '2026-10-18T18:30:00.000Z', check_out: '2026-10-19T19:30:00.000Z', note: 'x'.repeat(2000) }),
    ])
  })
  it('returns inclusive, descending, detached daily reports and resets each demo without synthesizing absences', async () => {
    const api = createDemoApi()
    for (const day of ['2026-10-18', '2026-10-20', '2026-10-19']) await api.saveAttendance(entry({ day }))
    const report = await api.attendance({ from: '2026-10-19', to: '2026-10-20' })
    expect(Object.keys(report).sort()).toEqual(['from', 'generated_at', 'records', 'to'])
    expect(report.records.map(record => record.day)).toEqual(['2026-10-20', '2026-10-19'])
    report.records[0].note = 'Mutated copy'
    expect((await api.attendance(range)).records[0].note).toBe('')
    expect((await api.attendance({ from: '2026-10-01', to: '2026-10-17' })).records).toEqual([])
    expect((await createDemoApi().attendance(range)).records).toEqual([])
    for (const invalid of [{ from: '', to: '' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-20', to: '2026-10-19' }, { from: '2025-01-01', to: '2026-10-20' }]) await expect(api.attendance(invalid)).rejects.toThrow()
  })
  it.each(['demo-tech-1', 'demo-tech-2'])('keeps %s read-only and rejects creates and edits even for their own day', async actor => {
    const api = createDemoApi(actor)
    expect((await api.attendance(range)).records).toEqual([])
    for (const employee_id of [actor, 'demo-office', 'foreign']) {
      for (const version of [0, 1]) await expect(api.saveAttendance(entry({ employee_id, version }))).rejects.toThrow('Office or owner access required')
    }
    expect((await api.attendance(range)).records).toEqual([])
    for (const adapter of [api, liveApi]) {
      expect(adapter).not.toHaveProperty('checkIn')
      expect(adapter).not.toHaveProperty('checkOut')
    }
  })
  it('returns only the demo recipient’s notifications and tracks reads', async () => {
    const api = createDemoApi('demo-tech-1')
    const feed = await api.notifications()
    expect(feed.items.length).toBeGreaterThan(0)
    expect(feed.items.every(item => item.recipient_id === 'demo-tech-1')).toBe(true)
    await api.readNotifications(feed.items[0].id)
    expect((await api.notifications()).unread_count).toBe(feed.unread_count - 1)
    await expect(api.readNotifications('foreign')).rejects.toThrow('unavailable')
    await api.readNotifications()
    expect((await api.notifications()).unread_count).toBe(0)
    expect((await createDemoApi().notifications()).items).toEqual([])
  })
  it('uses scoped same-origin endpoints and forwards cancellation for reads', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }))
    // Each call needs an unconsumed response body.
    fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await liveApi.attendance({ from: '2026-10-01', to: '2026-10-19' }, signal)
    expect(fetch).toHaveBeenLastCalledWith('/api/attendance?from=2026-10-01&to=2026-10-19', expect.objectContaining({ signal, credentials: 'same-origin' }))
    const input = entry({ status: 'half_day', check_in: '2026-10-19T04:00:00Z', note: 'Office entry' })
    await liveApi.saveAttendance(input)
    expect(fetch).toHaveBeenLastCalledWith('/api/attendance', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify(input) }))
    await liveApi.saveAttendance({ ...input, version: 3, status: 'leave', check_in: null })
    expect(fetch).toHaveBeenLastCalledWith('/api/attendance', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...input, version: 3, status: 'leave', check_in: null }) }))
    await liveApi.notifications(signal)
    expect(fetch).toHaveBeenLastCalledWith('/api/notifications', expect.objectContaining({ signal }))
    await liveApi.readNotifications('notice')
    expect(fetch).toHaveBeenLastCalledWith('/api/notifications/read', expect.objectContaining({ body: JSON.stringify({ id: 'notice' }) }))
  })
  it('returns the daily attendance report unchanged and propagates cancellation', async () => {
    const report: AttendanceReport = { ...range, generated_at: new Date().toISOString(), records: [{ ...entry(), company_id: 'company', version: 2, recorded_by: 'owner', updated_by: 'office', updated_at: new Date().toISOString() }] }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(report)))
    expect(await liveApi.attendance(range)).toEqual(report)
    const controller = new AbortController(), abort = new DOMException('Cancelled', 'AbortError')
    controller.abort(); fetch.mockRejectedValueOnce(abort)
    await expect(liveApi.attendance(range, controller.signal)).rejects.toBe(abort)
    expect(fetch).toHaveBeenLastCalledWith('/api/attendance?from=2026-10-01&to=2026-10-20', expect.objectContaining({ signal: controller.signal }))
  })
  it.each([[403, 'Office or owner access required'], [409, 'Attendance changed. Reload the record before saving'], [400, 'Check-in must fall on the attendance day in IST']])('preserves a %s attendance save error without retrying', async (status, message) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: message }), { status }))
    await expect(liveApi.saveAttendance(entry())).rejects.toMatchObject({ name: 'ApiError', status, message })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([{ ok: false }, {}, null])('rejects an unconfirmed attendance save response %j', async response => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)))
    await expect(liveApi.saveAttendance(entry())).rejects.toThrow('could not be confirmed')
  })
})
describe('demo ticket deletion adapter', () => {
  const input = (): TicketInput => ({ id: crypto.randomUUID(), connection_id: null, title: 'Delete this demo complaint', description: '', category: 'Other', priority: 'normal', assigned_to: ['demo-tech-1'], due_at: null, outage_id: null })
  it.each(['demo-owner', 'demo-office'])('lets %s delete locally, retry only the same request, and never recreate a deleted UUID or reuse its number', async actor => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const api = createDemoApi(actor), original = await api.load()
    const highest = original.tickets.reduce((a, b) => a.number > b.number ? a : b)
    await api.deleteTicket(highest.id, highest.version, `DSA-${highest.number}`, 'Remove highest seeded number')
    const first = input()
    await api.createTicket(first)
    const created = (await api.load()).tickets.find(ticket => ticket.id === first.id)!
    expect(created.number).toBe(highest.number + 1)
    await api.updateTicket(first.id, 1, {}, 'Note to be removed')
    expect(await api.events(first.id)).toHaveLength(3)
    const confirmation = `DSA-${created.number}`
    await api.deleteTicket(first.id, 2, confirmation, '  Duplicate complaint  ')
    const deleted = await api.load()
    expect(deleted.tickets.some(ticket => ticket.id === first.id || ticket.id === highest.id)).toBe(false)
    expect(deleted.customers).toEqual(original.customers)
    expect(deleted.connections).toEqual(original.connections)
    await api.deleteTicket(first.id, 2, confirmation, 'Duplicate complaint')
    for (const [version, ref, reason] of [[1, confirmation, 'Duplicate complaint'], [2, 'DSA-0', 'Duplicate complaint'], [2, confirmation, 'Different reason']] as const) {
      await expect(api.deleteTicket(first.id, version, ref, reason)).rejects.toThrow('deletion request does not match')
    }
    await expect(api.createTicket(first)).rejects.toThrow('permanently deleted')
    await expect(api.updateTicket(first.id, 2, {}, 'Cannot restore')).rejects.toThrow('Ticket unavailable')
    await expect(api.events(first.id)).rejects.toThrow('Ticket unavailable')
    expect(await api.load()).toEqual(deleted)
    const second = input()
    await api.createTicket(second); await api.createTicket(second)
    expect((await api.load()).tickets.filter(ticket => ticket.id === second.id)).toEqual([expect.objectContaining({ number: created.number + 1, version: 1 })])
    expect((await createDemoApi(actor).load()).tickets).toHaveLength(original.tickets.length)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects stale versions, wrong references, invalid reasons and missing tickets without changing data or events', async () => {
    const api = createDemoApi(), before = await api.load(), ticket = before.tickets[0]
    const events = await api.events(ticket.id), confirmation = `DSA-${ticket.number}`
    for (const [id, version, ref, reason, message] of [
      [ticket.id, 0, confirmation, 'Duplicate', 'Ticket changed'],
      [ticket.id, 1, `${confirmation} `, 'Duplicate', 'exact ticket reference'],
      [ticket.id, 1, String(ticket.number), 'Duplicate', 'exact ticket reference'],
      [ticket.id, 1, confirmation, ' \n ', 'deletion reason'],
      [ticket.id, 1, confirmation, 'x'.repeat(501), 'deletion reason'],
      [crypto.randomUUID(), 1, confirmation, 'Duplicate', 'Ticket unavailable'],
    ] as const) {
      await expect(api.deleteTicket(id, version, ref, reason)).rejects.toThrow(message)
      expect(await api.load()).toEqual(before)
      expect(await api.events(ticket.id)).toEqual(events)
    }
    await api.deleteTicket(ticket.id, 1, confirmation, 'x'.repeat(500))
    expect((await api.load()).tickets).toHaveLength(before.tickets.length - 1)
  })
  it.each(['demo-tech-1', 'demo-tech-2'])('denies %s deletion of assigned tickets without changing their inbox or history', async actor => {
    const api = createDemoApi(actor), before = await api.load(), ticket = before.tickets[0]
    const feed = await api.notifications(), events = await api.events(ticket.id)
    await expect(api.deleteTicket(ticket.id, ticket.version, `DSA-${ticket.number}`, 'Duplicate')).rejects.toThrow('Office or owner access required')
    expect(await api.load()).toEqual(before)
    expect(await api.events(ticket.id)).toEqual(events)
    expect(await api.notifications()).toEqual(feed)
  })
})
describe('multiple technician assignment', () => {
  const input = { id: 'multi', connection_id: null, title: 'Shared complaint', description: '', category: 'Other', priority: 'normal' as const, assigned_to: ['demo-tech-1', 'demo-tech-2', 'demo-tech-1'], due_at: null, outage_id: null }
  it('normalizes legacy strings/null and arrays without mutating, truncating or double-counting', () => {
    expect(assigneeIds(null)).toEqual([]); expect(assigneeIds(undefined)).toEqual([]); expect(assigneeIds([])).toEqual([])
    expect(assigneeIds('legacy')).toEqual(['legacy'])
    const ids = ['a', 'b', 'a']; expect(assigneeIds(ids)).toEqual(['a', 'b']); expect(ids).toEqual(['a', 'b', 'a'])
    expect(sameAssignees('a', ['a', 'a'])).toBe(true)
    expect(sameAssignees(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameAssignees(null, [])).toBe(true)
    expect(sameAssignees(['a'], ['a', 'b'])).toBe(false)
    expect(assigneeIds(Array.from({ length: 51 }, (_, i) => String(i)))).toHaveLength(51)
  })
  it('renders an accessible fieldset with checkboxes, history and a 50-selection limit', async () => {
    const data = await createDemoApi().load()
    data.profiles[2].active = false
    const markup = renderToStaticMarkup(createElement(AssigneeSelector, { profiles: data.profiles, value: ['demo-tech-1', 'former'], onChange: () => {} }))
    expect(markup).toContain('<legend>Assigned technicians</legend>')
    expect(markup).toContain('type="checkbox"'); expect(markup).toContain('Arun Kumar (inactive)')
    expect(markup).toContain('Former staff (former)'); expect(markup).not.toMatch(/<label[^>]*>[^<]*<fieldset/)
    const full = renderToStaticMarkup(createElement(AssigneeSelector, { profiles: data.profiles, value: Array.from({ length: 50 }, (_, i) => `old-${i}`), onChange: () => {} }))
    expect(full).toMatch(/type="checkbox" disabled=""/)
  })
  it('normalizes creation, edits, legacy writes and removals; failed work starts are atomic', async () => {
    const api = createDemoApi()
    await api.createTicket(input)
    expect((await api.load()).tickets.find(t => t.id === input.id)).toMatchObject({ assigned_to: ['demo-tech-1', 'demo-tech-2'], status: 'assigned' })
    await api.updateTicket(input.id, 1, { assigned_to: ['demo-tech-2'] }, '')
    await api.updateTicket(input.id, 2, { assigned_to: [] }, '')
    expect((await api.load()).tickets.find(t => t.id === input.id)).toMatchObject({ assigned_to: [], status: 'new', version: 3 })
    const before = await api.load(), events = await api.events(input.id)
    await expect(api.updateTicket(input.id, 3, { status: 'in_progress' }, '')).rejects.toThrow('Assign a technician')
    expect(await api.load()).toEqual(before); expect(await api.events(input.id)).toEqual(events)
    expect(events.map(e => eventText(e.body))).toContain('Assigned to removed · Status: new')
    await api.updateTicket(input.id, 3, { assigned_to: 'demo-tech-1', status: 'in_progress' }, '')
    expect((await api.load()).tickets.find(t => t.id === input.id)?.assigned_to).toEqual(['demo-tech-1'])
    await expect(api.updateTicket(input.id, 3, { assigned_to: [] }, '')).rejects.toThrow('changed')
  })
  it('rejects invalid members and over 50 unique ids without partial writes, allowing deduplication', async () => {
    const api = createDemoApi(), before = await api.load()
    const invalid: Ticket['assigned_to'][] = [['demo-tech-1', 'foreign'], ['demo-office'], [''], Array.from({ length: 51 }, (_, i) => `staff-${i}`), [42] as unknown as string[]]
    for (const assigned_to of invalid) {
      await expect(api.createTicket({ ...input, assigned_to })).rejects.toThrow()
      await expect(api.updateTicket('demo-t-0', 1, { assigned_to }, '')).rejects.toThrow()
      expect(await api.load()).toEqual(before)
    }
    await api.createTicket({ ...input, assigned_to: Array(60).fill('demo-tech-1') })
    expect((await api.load()).tickets.find(t => t.id === input.id)?.assigned_to).toEqual(['demo-tech-1'])
  })
  it('preserves inactive history for notes but requires valid technicians on reassignment and reopen', async () => {
    const api = createDemoApi()
    await api.createTicket(input)
    await api.staff({ action: 'update', id: 'demo-tech-1', active: false })
    await api.updateTicket(input.id, 1, {}, 'Keep historical assignment')
    await api.updateTicket(input.id, 2, { status: 'resolved', resolution: 'Office repair' }, '')
    await expect(api.updateTicket(input.id, 3, { status: 'assigned' }, '')).rejects.toThrow('active technician')
    await api.updateTicket(input.id, 3, { status: 'assigned', assigned_to: ['demo-tech-2'] }, '')
    await expect(api.updateTicket(input.id, 4, { assigned_to: ['demo-tech-1', 'demo-tech-2'] }, '')).rejects.toThrow('active technician')
    const data = await api.load()
    expect(assigneeNames(['demo-tech-1', 'former'], data.profiles)).toBe('Arun Kumar (inactive); Former staff (former)')
    data.profiles[3].role = 'office'
    expect(assigneeNames('demo-tech-2', data.profiles)).toBe('Meera Das (no longer technician)')
  })
  it('enforces technician membership and permission rules while recording the actual repair actor', async () => {
    for (const actor of ['demo-tech-1', 'demo-tech-2']) {
      const api = createDemoApi(actor)
      expect((await api.load()).tickets.some(t => t.id === 'demo-t-2')).toBe(true)
      expect((await api.load()).tickets.every(t => assigneeIds(t.assigned_to).includes(actor))).toBe(true)
      await expect(api.createTicket(input)).rejects.toThrow('Office or owner')
      for (const patch of [{ assigned_to: [] }, { customer_feedback: 'Cannot write' }, { status: 'closed' as const }]) await expect(api.updateTicket('demo-t-2', 1, patch, '')).rejects.toThrow()
      await expect(api.updateTicket('demo-t-0', 1, {}, 'Not assigned')).rejects.toThrow('unavailable')
      await expect(api.events('demo-t-0')).rejects.toThrow('unavailable')
      await api.updateTicket('demo-t-2', 1, { status: 'resolved', resolution: 'Shared repair' }, '')
      expect((await api.events('demo-t-2')).at(-1)?.actor_id).toBe(actor)
      await expect(api.updateTicket('demo-t-2', 2, { status: 'in_progress' }, '')).rejects.toThrow('not permitted')
    }
    const office = createDemoApi('demo-office')
    await office.createTicket(input)
    await office.updateTicket(input.id, 1, { assigned_to: [] }, '')
    expect((await office.events(input.id)).at(-1)?.actor_id).toBe('demo-office')
  })
  it('counts shared open/overdue/awaiting work once per employee but never credits resolution by assignment', async () => {
    const data = await createDemoApi().load()
    data.tickets = [{ ...data.tickets[0], id: 'open', assigned_to: input.assigned_to, due_at: '2026-01-01T00:00:00Z' }, { ...data.tickets[6], id: 'resolved', assigned_to: input.assigned_to }]
    const event: TicketEvent = { id: 'event', company_id: 'demo-company', ticket_id: 'resolved', actor_id: 'demo-tech-2', created_at: new Date().toISOString(), body: JSON.stringify({ action: 'updated', changes: { status: { from: 'in_progress', to: 'resolved' } } }) }
    const report = computeDemoPerformance(data, [event, event], recentRange())
    for (const id of ['demo-tech-1', 'demo-tech-2']) expect(report.employees.find(p => p.id === id)).toMatchObject({ open_assigned: 1, overdue_assigned: 1, awaiting_feedback_assigned: 1, resolved: id === 'demo-tech-2' ? 1 : 0 })
    const csv = csvText(ticketExportRows(data, data.tickets))
    expect(csv.match(/Arun Kumar; Meera Das/g)).toHaveLength(2)
    data.tickets[0].assigned_to = 'demo-tech-1'
    data.tickets[1].assigned_to = null
    expect(ticketExportRows(data, data.tickets).map(row => row.assigned_to)).toEqual(['Arun Kumar', ''])
  })
  it('summarizes legacy and array assignment audit without treating empty arrays as assigned', () => {
    const summary = (to: Ticket['assigned_to']) => eventText(JSON.stringify({ action: 'updated', changes: { assigned_to: { from: 'old', to } } }))
    expect(summary([])).toBe('Assigned to removed'); expect(summary(null)).toBe('Assigned to removed')
    expect(summary('legacy')).toBe('Assigned to updated (1 technician)')
    expect(summary(['a', 'b', 'a'])).toBe('Assigned to updated (2 technicians)')
  })
})
describe('reporting and performance contracts', () => {
  it('uses inclusive IST days, including midnight boundaries and presets', () => {
    expect(istDate('2026-10-15T18:29:59.999Z')).toBe('2026-10-15')
    expect(istDate('2026-10-15T18:30:00Z')).toBe('2026-10-16')
    expect(recentRange(30, Date.parse('2026-10-15T18:30:00Z'))).toEqual({ from: '2026-09-17', to: '2026-10-16' })
    expect(recentRange(7, Date.parse('2026-10-15T18:30:00Z')).from).toBe('2026-10-10')
  })
  it('rejects missing, impossible, reversed and oversized dates, allowing exactly 366 days', () => {
    for (const range of [{ from: '', to: '' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-17', to: '2026-10-16' }, { from: '2025-01-01', to: '2026-01-02' }]) expect(rangeError(range)).not.toBe('')
    expect(rangeError({ from: '2024-01-01', to: '2024-12-31' })).toBe('')
    expect(rangeError({ from: '', to: '' }, false)).toBe('')
  })
  it('shares cohort, null-provider and priority filtering across chart series and CSV, retaining feedback', async () => {
    const data = await createDemoApi().load()
    data.tickets = [
      { ...data.tickets[0], id: 'before', created_at: '2026-10-15T18:29:59Z', connection_id: null },
      { ...data.tickets[0], id: 'at', created_at: '2026-10-15T18:30:00Z', connection_id: null, customer_feedback: '=unsafe' },
      { ...data.tickets[0], id: 'end', created_at: '2026-10-16T18:29:59Z', connection_id: null },
      { ...data.tickets[0], id: 'after', created_at: '2026-10-16T18:30:00Z', connection_id: null },
    ]
    const filters = { from: '2026-10-16', to: '2026-10-16', provider: 'none', priority: 'high' }
    const tickets = filterReportTickets(data, filters)
    expect(tickets.map(t => t.id)).toEqual(['at', 'end'])
    const series = operationalSeries(data, tickets)
    expect(series.status.reduce((sum, row) => sum + row.count, 0)).toBe(2)
    expect(series.providers.find(row => row.name === 'No connection')?.count).toBe(2)
    expect(series.trend).toEqual([{ name: '2026-10-16', count: 2 }])
    const rows = ticketExportRows(data, tickets)
    expect(rows).toHaveLength(2); expect(rows[0].provider).toBe('No connection')
    expect(csvText(rows)).toContain("'=unsafe")
    expect(filterReportTickets(data, { ...filters, priority: 'low' })).toEqual([])
    expect(filterReportTickets(data, { ...filters, from: '2026-10-17' })).toEqual([])
    expect(filterReportTickets(data, emptyReportFilters)).toHaveLength(4)
  })
  it('counts unique audit actors, latest resolution per actor/ticket and current snapshots independently', async () => {
    const data = await createDemoApi().load(); const range = { from: '2026-10-16', to: '2026-10-16' }
    data.tickets = [{ ...data.tickets[0], id: 'ticket', created_at: '2026-10-14T18:30:00Z', assigned_to: 'demo-tech-1', due_at: '2026-10-15T00:00:00Z', status: 'in_progress' }]
    data.profiles[3].active = false
    const event = (actor: string, body: unknown, at: string): TicketEvent => ({ id: crypto.randomUUID(), company_id: data.companies[0].id, ticket_id: 'ticket', actor_id: actor, body: JSON.stringify(body), created_at: at })
    const events = [event('demo-owner', { action: 'created' }, '2026-10-14T18:30:00Z'),
      event('demo-office', { action: 'updated', changes: { status: { from: 'in_progress', to: 'resolved' } } }, '2026-10-15T18:30:00Z'),
      event('demo-office', { action: 'updated', changes: { status: { from: 'in_progress', to: 'resolved' } } }, '2026-10-16T06:30:00Z'),
      event('demo-office', { action: 'updated', changes: { customer_feedback: { from: '', to: 'Confirmed' }, status: { from: 'resolved', to: 'closed' } } }, '2026-10-16T07:30:00Z'),
      event('demo-office', { action: 'updated', changes: { customer_feedback: { from: 'Confirmed', to: 'Confirmed again' } } }, '2026-10-16T08:30:00Z'),
      event('demo-owner', { action: 'updated', changes: { status: { from: 'in_progress', to: 'resolved' } } }, '2026-10-16T10:30:00Z'),
    ]
    const report = computeDemoPerformance(data, events, range, Date.parse('2026-10-16T12:00:00Z'))
    expect(report.employees).toHaveLength(4)
    expect(report.employees.find(p => p.id === 'demo-office')).toMatchObject({ resolved: 1, closed: 1, feedback_recorded: 1, median_resolution_hours: 36, open_assigned: 0 })
    expect(report.employees.find(p => p.id === 'demo-tech-1')).toMatchObject({ resolved: 0, median_resolution_hours: null, open_assigned: 1, overdue_assigned: 1 })
    expect(report.employees.find(p => p.id === 'demo-tech-2')).toMatchObject({ active: false, created: 0, resolved: 0 })
    const empty = computeDemoPerformance(data, events, { from: '2020-01-01', to: '2020-01-01' }, Date.parse('2026-10-16T12:00:00Z'))
    expect(empty.employees.find(p => p.id === 'demo-tech-1')).toMatchObject({ open_assigned: 1, overdue_assigned: 1, resolved: 0 })
  })
  it('demo performance makes no network calls or invented historical resolutions, and safely exports names', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'))
    const api = createDemoApi(); const initial = await api.performance!(recentRange())
    expect(initial.employees.every(p => p.resolved === 0 && p.median_resolution_hours === null)).toBe(true)
    expect(initial.employees.find(p => p.id === 'demo-owner')?.created).toBe(8)
    await api.updateTicket('demo-t-6', 1, { status: 'closed', customer_feedback: 'Confirmed' }, '')
    const next = await api.performance!(recentRange())
    expect(next.employees.find(p => p.id === 'demo-owner')).toMatchObject({ feedback_recorded: 1, closed: 1 })
    expect(next.employees.find(p => p.id === 'demo-tech-1')).toMatchObject({ closed: 0, feedback_recorded: 0 })
    expect(csvText(performanceExportRows(next, [{ ...next.employees[0], full_name: '=unsafe' }]))).toContain("'=unsafe")
    expect(fetch).not.toHaveBeenCalled()
  })
  it('sends only from/to with the optional performance REST method and abort signal', async () => {
    const report = { from: '2026-10-01', to: '2026-10-16', generated_at: '2026-10-16T00:00:00Z', employees: [] }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }))
    const signal = new AbortController().signal
    expect(await liveApi.performance!({ from: report.from, to: report.to }, signal)).toEqual(report)
    expect(fetch.mock.calls[0][0]).toBe('/api/reports/performance?from=2026-10-01&to=2026-10-16')
    expect(fetch.mock.calls[0][1]?.signal).toBe(signal)
  })
})
describe('frontend utility contracts', () => {
  it('converts IST fields independently of the device timezone', () => {
    expect(fromIstInput('2026-10-10T09:30')).toBe('2026-10-10T04:00:00.000Z')
    expect(toIstInput('2026-10-10T04:00:00.000Z')).toBe('2026-10-10T09:30')
    expect(fromIstInput('')).toBeNull(); expect(toIstInput(null)).toBe('')
  })
  it('validates customer fields against SQL limits', () => {
    expect(customerSchema.parse({ ...customer, full_name: '  Example  ' }).full_name).toBe('Example')
    expect(customerSchema.safeParse({ ...customer, provider_id: 'unknown' }).success).toBe(false)
    expect(customerSchema.safeParse({ ...customer, address: ' ' }).success).toBe(false)
    expect(customerSchema.safeParse({ ...customer, phone: '0'.repeat(41) }).success).toBe(false)
  })
  it('detects duplicate existing accounts and duplicate CSV rows', () => {
    const result = validateImport([customer, { ...customer }, { ...customer, account_number: 'existing' }], [{ company_id: 'company-a', id: 'c', customer_id: 'u', provider_id: 'niss', account_number: 'existing', network_node: '' }])
    expect(result[0].error).toBe(''); expect(result[1].error).toMatch(/Duplicate/); expect(result[2].error).toMatch(/Duplicate/)
    expect(result[0].row).toBe(2)
  })
  it.each(['=HYPERLINK("https://example.test")', '+SUM(1,2)', '-3', '@cmd', '  =1+1', '\ttext', '\ntext'])('escapes spreadsheet formula input %j', input => {
    expect(escapeFormula(input)).toBe(`'${input}`)
  })
  it('quotes CSV punctuation while preserving safe text', () => {
    expect(csvText([{ name: 'Example, Fictional', account: '=1+1' }])).toContain('"Example, Fictional"')
    expect(csvText([{ name: 'Example', account: '=1+1' }])).toContain("'=1+1")
    expect(escapeFormula('DEMO-123')).toBe('DEMO-123')
  })
  it('matches edge-function password character and byte limits', () => {
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false)
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true)
    expect(passwordSchema.safeParse('😀'.repeat(65)).success).toBe(false)
  })
  it('formats references and server audit records safely', () => {
    expect(reference(1)).toBe('DSA-0001')
    expect(reference(42)).toBe('DSA-0042')
    expect(reference(12345)).toBe('DSA-12345')
    expect(isOpen({ status: 'waiting_provider' })).toBe(true)
    expect(isOpen({ status: 'resolved' })).toBe(false)
    expect(eventText('{"action":"note","text":"Checked fibre"}')).toBe('Checked fibre')
    expect(eventText('plain note')).toBe('plain note')
    expect(errorMessage({ message: 'relation does not exist' })).toMatch(/migration/)
  })
})

describe('DSA brand boundaries', () => {
  it('keeps NISS as a provider, not a business label to replace in data', async () => {
    const data = await createDemoApi().load()
    expect(data.providers).toContainEqual({ id: 'niss', name: 'NISS' })
    expect(data.connections.some(connection => connection.provider_id === 'niss')).toBe(true)
    expect(customerSchema.safeParse(customer).success).toBe(true)
    expect(customerSchema.safeParse({ ...customer, provider_id: 'dsa' }).success).toBe(false)
  })

  it.each([
    ['urgent', 'chevrons-up', 'Urgent'], ['high', 'arrow-up', 'High'],
    ['normal', 'minus', 'Normal'], ['low', 'arrow-down', 'Low'],
  ])('renders %s priority with a decorative Lucide icon and text', (value, icon, text) => {
    const markup = renderToStaticMarkup(createElement(PriorityBadge, { value }))
    expect(markup).toContain('<svg')
    expect(markup).toContain(`lucide-${icon}`)
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain(`</svg>${text}</span>`)
    expect(markup).not.toMatch(/[↑↓−]/)
  })

  it('uses the installed Building2 geometry for a single licensed teal favicon', () => {
    const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
    const installed = renderToStaticMarkup(createElement(Building2))
    const paths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1])
    expect(paths(favicon)).toEqual(paths(installed))
    expect(favicon.match(/<svg\b/g)).toHaveLength(1)
    expect(favicon).toContain('viewBox="0 0 24 24"')
    expect(favicon).toContain('stroke="#087d70"')
    expect(favicon).toContain('ISC License')
    expect(favicon).toContain('Copyright (c) 2026 Lucide Icons and Contributors')
    expect(existsSync(new URL('../public/icons.svg', import.meta.url))).toBe(false)
  })

  it('stores only the boolean session hint and discards retired tokens', () => {
    const store = new Map([['niss-auth', 'obsolete-token']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) })
    expect(hasSavedSession()).toBe(false)
    saveSessionHint(true)
    expect([...store]).toEqual([[sessionHintKey, 'true']])
    expect(hasSavedSession()).toBe(true)
    saveSessionHint(false)
    expect(store.size).toBe(0)
  })
})

describe('isolated in-memory demo', () => {
  it('requires nonblank feedback for closure without changing state or audit on rejection', async () => {
    const api = createDemoApi()
    const before = await api.load(); const events = await api.events('demo-t-6')
    expect(before.tickets.find(t => t.id === 'demo-t-6')?.customer_feedback).toBe('')
    expect(before.tickets.find(t => t.id === 'demo-t-7')?.customer_feedback).toMatch(/Fictional customer/)
    for (const patch of [{ status: 'closed' as const }, { status: 'closed' as const, customer_feedback: ' \n ' }]) {
      await expect(api.updateTicket('demo-t-6', 1, patch, '')).rejects.toThrow('Customer feedback is required')
      expect(await api.load()).toEqual(before)
      expect(await api.events('demo-t-6')).toEqual(events)
    }
    await api.updateTicket('demo-t-6', 1, { status: 'closed', customer_feedback: 'Customer confirmed stable service on callback.' }, '')
    expect((await api.load()).tickets.find(t => t.id === 'demo-t-6')).toMatchObject({ status: 'closed', customer_feedback: 'Customer confirmed stable service on callback.', version: 2 })
  })
  it('allows feedback-only saves while resolved, then closes with previously saved feedback', async () => {
    const api = createDemoApi()
    await api.updateTicket('demo-t-6', 1, { customer_feedback: 'Customer reports connection is stable.' }, '')
    expect((await api.load()).tickets.find(t => t.id === 'demo-t-6')).toMatchObject({ status: 'resolved', customer_feedback: 'Customer reports connection is stable.', version: 2 })
    await api.updateTicket('demo-t-6', 2, { status: 'closed' }, '')
    await expect(api.updateTicket('demo-t-6', 3, { customer_feedback: 'Changed after closure' }, '')).rejects.toThrow('only be recorded after resolution and before closure')
    await api.updateTicket('demo-t-6', 3, {}, 'Historical note still allowed')
    expect((await api.load()).tickets.find(t => t.id === 'demo-t-6')).toMatchObject({ status: 'closed', customer_feedback: 'Customer reports connection is stable.', version: 4 })
  })
  it.each(['resolved', 'closed'] as const)('clears feedback and resolution on reopening from %s and requires fresh feedback after the next repair', async status => {
    const api = createDemoApi(); const id = 'demo-t-6'
    await api.updateTicket(id, 1, { status, customer_feedback: 'Previous repair feedback' }, '')
    await expect(api.updateTicket(id, 2, { status: 'in_progress', customer_feedback: '' }, '')).rejects.toThrow('only be recorded after resolution and before closure')
    await api.updateTicket(id, 2, { status: 'in_progress' }, 'Customer reports recurrence')
    expect((await api.load()).tickets.find(t => t.id === id)).toMatchObject({ status: 'in_progress', resolution: '', customer_feedback: '', version: 3 })
    await expect(api.updateTicket(id, 3, { customer_feedback: 'Too early' }, '')).rejects.toThrow('only be recorded after resolution and before closure')
    await expect(api.updateTicket(id, 3, { status: 'resolved', resolution: 'New repair', customer_feedback: 'Cannot combine initial resolution with feedback' }, '')).rejects.toThrow('only be recorded after resolution and before closure')
    await api.updateTicket(id, 3, { status: 'resolved', resolution: 'New repair' }, '')
    expect((await api.load()).tickets.find(t => t.id === id)).toMatchObject({ status: 'resolved', resolution: 'New repair', customer_feedback: '' })
    await expect(api.updateTicket(id, 4, { status: 'closed' }, '')).rejects.toThrow('Customer feedback is required')
    expect((await api.events(id)).some(e => eventText(e.body).includes('Previous repair feedback'))).toBe(true)
  })
  it('stamps empty feedback on creation and accepts customer responses without sentiment validation', async () => {
    const api = createDemoApi()
    await api.createTicket({ id: 'feedback-new', title: 'Complaint', description: '', category: 'Other', priority: 'normal', connection_id: null, assigned_to: null, due_at: null, outage_id: null })
    expect((await api.load()).tickets.find(t => t.id === 'feedback-new')?.customer_feedback).toBe('')
    await api.updateTicket('demo-t-6', 1, { customer_feedback: 'Still intermittent; customer requests another visit.' }, '')
    expect((await api.load()).tickets.find(t => t.id === 'demo-t-6')).toMatchObject({ status: 'resolved', customer_feedback: 'Still intermittent; customer requests another visit.' })
  })
  it.each([null, 'demo-tech-1'])('creates and updates an unlinked ticket with assignee %s', async assigned_to => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const api = createDemoApi()
    const input = { id: 'unlinked', connection_id: null, title: 'Manual complaint', description: 'Contact and symptoms recorded manually', category: 'Other', priority: 'normal' as const, assigned_to, due_at: null, outage_id: null }
    await api.createTicket(input)
    await api.createTicket(input)
    expect((await api.load()).tickets.filter(t => t.id === input.id)).toEqual([expect.objectContaining({ connection_id: null, assigned_to: assigneeIds(assigned_to), status: assigned_to ? 'assigned' : 'new', version: 1 })])
    await api.updateTicket(input.id, 1, { title: 'Updated manual complaint', description: 'Callback completed', priority: 'high' }, 'Checked by phone')
    await api.updateTicket(input.id, 2, { status: 'resolved', resolution: 'Service confirmed by caller' }, '')
    expect((await api.load()).tickets.find(t => t.id === input.id)).toMatchObject({ connection_id: null, outage_id: null, title: 'Updated manual complaint', description: 'Callback completed', priority: 'high', status: 'resolved', resolution: 'Service confirmed by caller', version: 3 })
    expect((await api.events(input.id)).map(e => eventText(e.body))).toContain('Checked by phone')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects outage links without a connection on creation and update without mutating records', async () => {
    const api = createDemoApi()
    const input = { id: 'unlinked', connection_id: null, title: 'Manual complaint', description: '', category: 'Other', priority: 'normal' as const, assigned_to: null, due_at: null, outage_id: null }
    const before = await api.load()
    await expect(api.createTicket({ ...input, outage_id: 'demo-outage' })).rejects.toThrow('An outage requires a linked connection')
    expect(await api.load()).toEqual(before)
    await api.createTicket(input)
    const created = await api.load(); const events = await api.events(input.id)
    await expect(api.updateTicket(input.id, 1, { outage_id: 'demo-outage' }, '')).rejects.toThrow('An outage requires a linked connection')
    expect(await api.load()).toEqual(created)
    expect(await api.events(input.id)).toEqual(events)
    await api.updateTicket(input.id, 1, { outage_id: null }, 'Still unlinked')
    await expect(api.updateTicket(input.id, 2, { assigned_to: 'foreign-tech' }, '')).rejects.toThrow('Assignee must be an active technician')
    await expect(api.createTicket({ ...input, id: 'bad-assignee', assigned_to: 'foreign-tech' })).rejects.toThrow('Assignee must be an active technician in this company')
    for (const connection_id of ['', 'foreign-connection']) {
      await expect(api.createTicket({ ...input, id: 'bad-connection', connection_id })).rejects.toThrow('Connection unavailable in this company')
    }
  })
  it('stamps company identity on every seeded and created tenant record', async () => {
    const api = createDemoApi()
    await api.createCustomer(customer)
    await api.createOutage({ provider_id: 'niss', area: 'Example', title: 'Example outage' })
    await api.staff({ action: 'create', full_name: 'New Staff', email: 'new@example.test', password: 'fictional-password', role: 'office' })
    await api.createTicket({ id: 'new-ticket', connection_id: 'demo-cn-0', title: 'New ticket', description: '', category: 'Router', priority: 'normal', assigned_to: null, due_at: null, outage_id: null })
    await api.updateTicket('new-ticket', 1, {}, 'Demo note')
    const data = await api.load()
    expect(data.companies).toHaveLength(1)
    for (const rows of [data.profiles, data.customers, data.connections, data.outages, data.tickets, await api.events('new-ticket')]) {
      expect(rows.every(row => row.company_id === data.companies[0].id)).toBe(true)
    }
  })
  it('does not accept references outside the demo company', async () => {
    const api = createDemoApi()
    await expect(api.createTicket({ id: 'foreign', connection_id: 'foreign-connection', title: 'Bad reference', description: '', category: 'Router', priority: 'normal', assigned_to: null, due_at: null, outage_id: null })).rejects.toThrow('Connection unavailable in this company')
    await expect(api.updateTicket('demo-t-0', 1, { outage_id: 'foreign-outage' }, '')).rejects.toThrow('Outage unavailable in this company')
  })
  it('seeds exactly eight fictional tickets and five customers without network calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    try {
      const api = createDemoApi(); const data = await api.load()
      expect(data.tickets).toHaveLength(8); expect(data.customers).toHaveLength(5)
      expect(data.customers.every(c => c.address.includes('Fictional'))).toBe(true)
      await api.createCustomer(customer)
      expect((await api.load()).customers).toHaveLength(6)
      expect((await createDemoApi().load()).customers).toHaveLength(5)
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })
  it('returns the connection UUID from customer creation', async () => {
    const api = createDemoApi(); const id = await api.createCustomer(customer)
    expect((await api.load()).connections.find(c => c.id === id)?.account_number).toBe(customer.account_number)
    await expect(api.createCustomer(customer)).rejects.toThrow(/already exists/)
  })
  it('restores an outage without closing linked tickets', async () => {
    const api = createDemoApi(); const before = await api.load(); await api.restoreOutage('demo-outage'); const after = await api.load()
    expect(after.outages[0].status).toBe('restored'); expect(after.tickets).toEqual(before.tickets)
  })
  it('enforces optimistic versions and the office resolution allowlist', async () => {
    const api = createDemoApi(); const ticket = (await api.load()).tickets[0]
    await api.updateTicket(ticket.id, 1, { priority: 'urgent' }, 'Customer called')
    await expect(api.updateTicket(ticket.id, 1, {}, 'Stale edit')).rejects.toThrow(/changed/)
    await api.updateTicket(ticket.id, 2, { status: 'resolved', resolution: 'Office fix' }, '')
    expect((await api.load()).tickets.find(t => t.id === ticket.id)).toMatchObject({ status: 'resolved', resolution: 'Office fix', version: 3 })
    expect((await api.events(ticket.id)).some(e => eventText(e.body) === 'Customer called')).toBe(true)
  })
  it('simulates staff create, role, active and reset actions without retaining passwords', async () => {
    const api = createDemoApi()
    await api.staff({ action: 'create', full_name: 'Fictional Staff', email: 'staff@example.test', password: 'not-a-real-password', role: 'technician' })
    const member = (await api.load()).profiles.find(p => p.full_name === 'Fictional Staff')!
    await api.staff({ action: 'update', id: member.id, role: 'office', active: false })
    await api.staff({ action: 'reset_password', id: member.id, password: 'another-test-password' })
    expect(await api.profile(member.id)).toMatchObject({ active: false, role: 'office', must_change_password: true })
    expect(JSON.stringify(await api.load())).not.toContain('not-a-real-password')
  })
})

describe('same-origin REST transport', () => {
  const respond = (data: unknown, status = 200) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(data), { status }))
  it('sends UUID arrays and empty removals without losing the optimistic version', async () => {
    const fetch = respond({ ok: true })
    const assigned_to = [crypto.randomUUID(), crypto.randomUUID()]
    await liveApi.createTicket({ id: crypto.randomUUID(), connection_id: null, title: 'Shared', description: '', category: 'Other', priority: 'normal', assigned_to, due_at: null, outage_id: null })
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body)).assigned_to).toEqual(assigned_to)
    await liveApi.updateTicket('ticket', 7, { assigned_to }, '')
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({ version: 7, patch: { assigned_to }, note: '' })
    await liveApi.updateTicket('ticket', 8, { assigned_to: [] }, '')
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({ version: 8, patch: { assigned_to: [] }, note: '' })
  })
  it('loads the complete server dataset in one cancellable cookie request', async () => {
    const seed = await createDemoApi().load()
    const data = { ...seed, tickets: Array.from({ length: 1251 }, (_, i) => ({ ...seed.tickets[0], id: String(i) })) }
    const fetch = respond(data); const signal = new AbortController().signal
    expect((await liveApi.load(signal)).tickets).toHaveLength(1251)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/workspace', expect.objectContaining({ credentials: 'same-origin', signal, cache: 'no-store', redirect: 'error' }))
  })
  it('sends only operational create fields and returns the connection UUID', async () => {
    const fetch = respond({ ok: true, id: 'connection-id' }); const extra = { company_id: 'untrusted' }
    expect(await liveApi.createCustomer({ ...customer, ...extra })).toBe('connection-id')
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual(customer)
    await liveApi.createOutage({ provider_id: 'niss', area: 'Example', title: 'Outage', ...extra })
    expect(fetch.mock.lastCall?.[0]).toBe('/api/outages')
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).not.toHaveProperty('company_id')
    const ticket = { id: 'new', connection_id: 'connection-id', title: 'Complaint', description: '', category: 'Router', priority: 'normal' as const, assigned_to: null, due_at: null, outage_id: null }
    await liveApi.createTicket({ ...ticket, ...extra })
    expect(fetch.mock.lastCall?.[0]).toBe('/api/tickets')
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual(ticket)
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get('content-type')).toBe('application/json')
    await liveApi.createTicket({ ...ticket, connection_id: null })
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({ ...ticket, connection_id: null })
  })
  it('maps ticket updates, events, restore and staff endpoints', async () => {
    const fetch = respond({ ok: true })
    await liveApi.updateTicket('ticket', 3, { priority: 'urgent' }, 'note')
    expect(fetch.mock.lastCall).toEqual(['/api/tickets/ticket', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ version: 3, patch: { priority: 'urgent' }, note: 'note' }) })])
    await liveApi.updateTicket('ticket', 4, { status: 'closed', customer_feedback: 'Customer confirmed service' }, '')
    expect(fetch.mock.lastCall).toEqual(['/api/tickets/ticket', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ version: 4, patch: { status: 'closed', customer_feedback: 'Customer confirmed service' }, note: '' }) })])
    await liveApi.events('ticket'); expect(fetch.mock.lastCall?.[0]).toBe('/api/tickets/ticket/events')
    await liveApi.restoreOutage('outage'); expect(fetch.mock.lastCall?.[0]).toBe('/api/outages/outage/restore')
    await liveApi.staff({ action: 'change_password', password: 'fictional-test-password' }); expect(fetch.mock.lastCall?.[0]).toBe('/api/staff')
  })
  it.each([400, 401, 403, 409, 422, 500, 503])('preserves HTTP %i for definite versus uncertain rejection', async status => {
    const fetch = respond({ error: 'Safe server error' }, status)
    await expect(apiRequest('/api/tickets', { method: 'POST', body: {} })).rejects.toMatchObject({ message: 'Safe server error', status })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not expose HTML or raw network errors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>secret</html>', { status: 502 })).mockRejectedValueOnce(new Error('secret'))
    await expect(apiRequest('/api/workspace')).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('secret') })
    await expect(apiRequest('/api/workspace')).rejects.toThrow('result is unconfirmed')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['https://evil.example/api/x', '//evil.example/api/x', '/api/../x', '/api/%2f%2fevil'])('rejects unsafe request URL %s', async path => {
    const fetch = respond({})
    await expect(apiRequest(path)).rejects.toThrow('Invalid API path')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uploads multipart image without overriding the boundary, then deletes by ID', async () => {
    const fetch = respond({ ok: true })
    const file = new File(['image'], 'test.png', { type: 'image/png' })
    await liveApi.uploadImage!('ticket', file)
    expect(fetch.mock.lastCall?.[0]).toBe('/api/tickets/ticket/images')
    const options = fetch.mock.lastCall?.[1]
    expect(options?.body).toBeInstanceOf(FormData)
    expect((options!.body as FormData).get('image')).toBe(file)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
    await liveApi.deleteImage!('ticket', 'image')
    expect(fetch.mock.lastCall).toEqual(['/api/tickets/ticket/images/image', expect.objectContaining({ method: 'DELETE' })])
  })
  it('validates MIME type, nonempty files and 5 MB boundary before networking', async () => {
    const fetch = respond({})
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(imageFileError(new File([new Uint8Array(5 * 1024 * 1024)], 'image', { type }))).toBeUndefined()
    for (const file of [new File(['x'], 'x.svg', { type: 'image/svg+xml' }), new File([], 'empty.png', { type: 'image/png' }), new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })]) await expect(liveApi.uploadImage!('ticket', file)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('accepts only exact protected image paths for the requested ticket', async () => {
    const image = { id: 'image', ticket_id: 'ticket', created_at: '', uploaded_by: 'user', url: '/api/tickets/ticket/images/image/content' }
    const fetch = respond([image])
    await expect(liveApi.attachments!('ticket')).resolves.toEqual([image])
    for (const url of ['https://cdn.example/image.png', '/api/tickets/other/images/image/content']) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ ...image, url }])))
      await expect(liveApi.attachments!('ticket')).rejects.toThrow('Protected ticket images')
    }
    expect(createDemoApi().attachments).toBeUndefined()
  })
})

describe('workspace cache lifecycle', () => {
  it('namespaces every identity dimension and keeps the initial profile key company-independent', () => {
    const profile = { id: 'user-a', company_id: 'company-a', role: 'owner' as const, full_name: 'Owner', active: true, must_change_password: false }
    expect(workspaceScope('live', profile)).toBe('live:company-a:user-a:owner')
    expect(new Set([workspaceScope('live', profile), workspaceScope('demo', profile), workspaceScope('live', { ...profile, company_id: 'company-b' }), workspaceScope('live', { ...profile, id: 'user-b' }), workspaceScope('live', { ...profile, role: 'office' })]).size).toBe(5)
    expect(profileKey(profile.id)).toEqual(['live:user-a', 'profile'])
    expect(deskQueryOptions).toMatchObject({ gcTime: 0, retry: false })
    expect(deskQueryOptions).not.toHaveProperty('placeholderData')
  })
  it('cancels in-flight old data and removes old companies, roles and events without deleting the active scope', async () => {
    const cache = new QueryClient()
    const active = 'live:company-b:user-a:office'
    let aborted = false
    const pending = cache.fetchQuery({ queryKey: ['live:company-a:user-a:owner', 'data'], queryFn: ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true })
      return new Promise(() => {})
    } }).catch(() => undefined)
    for (const key of [['live:company-a:user-a:owner', 'events', 'ticket'], ['live:company-b:user-a:owner', 'data'], ['live:user-b', 'profile'], [active, 'data'], [...profileKey('user-a')], ['test', 'data']]) cache.setQueryData(key, { private: true })
    discardOtherWorkspaces(cache, active, 'user-a')
    await pending
    expect(aborted).toBe(true)
    expect(cache.getQueryCache().getAll().map(q => q.queryKey)).toEqual([[active, 'data'], [...profileKey('user-a')], ['test', 'data']])
    cache.clear()
  })
})