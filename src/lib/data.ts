import { apiRequest } from './http'
import type { DataApi, Dataset, Profile, TicketEvent, TicketImage, PerformanceReport, AttendanceReport, NotificationFeed } from './types'

export class CompanyWorkspaceError extends Error {
  constructor() { super('Company workspace unavailable. Ask your administrator to verify your company membership and server setup.'); this.name = 'CompanyWorkspaceError' }
}

export class NoStaffProfileError extends Error {
  constructor() { super('No staff profile is linked to this account.'); this.name = 'NoStaffProfileError' }
}

const ticketPath = (id: string) => `/api/tickets/${encodeURIComponent(id)}`
export function imageFileError(file: File): string | undefined {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Choose a JPEG, PNG or WebP image.'
  if (!file.size || file.size > 5 * 1024 * 1024) return 'Images must be nonempty and at most 5 MB.'
}
async function mutate(path: string, body: unknown, method = 'POST'): Promise<void> {
  const result = await apiRequest<{ ok: boolean }>(path, { method, body })
  if (!result || result.ok !== true) throw new Error('The change could not be confirmed. Refresh before retrying.')
}
export const liveApi: DataApi = {
  attendance: ({ from, to }, signal) => apiRequest<AttendanceReport>(`/api/attendance?${new URLSearchParams({ from, to })}`, { signal }),
  saveAttendance: input => mutate('/api/attendance', input),
  notifications: signal => apiRequest<NotificationFeed>('/api/notifications', { signal }),
  readNotifications: id => mutate('/api/notifications/read', id ? { id } : {}),
  performance: ({ from, to }, signal) => apiRequest<PerformanceReport>(`/api/reports/performance?${new URLSearchParams({ from, to })}`, { signal }),
  load: signal => apiRequest<Dataset>('/api/workspace', { signal }),
  async profile(id, signal) {
    const data = await apiRequest<Profile>('/api/profile', { signal })
    if (!data) throw new NoStaffProfileError()
    if (data.id !== id) throw new Error('Your signed-in account changed. Sign out and sign in again.')
    if (typeof data.company_id !== 'string' || !data.company_id.trim()) throw new CompanyWorkspaceError()
    if (!['owner', 'office', 'technician'].includes(data.role) || typeof data.active !== 'boolean' || typeof data.must_change_password !== 'boolean') throw new Error('Staff access could not be verified.')
    return data
  },
  events: (id, signal) => apiRequest<TicketEvent[]>(`${ticketPath(id)}/events`, { signal }),
  async createCustomer(input) {
    const { full_name, phone, address, area, provider_id, account_number, network_node } = input
    const data = await apiRequest<{ id: string }>('/api/customers', { method: 'POST', body: { full_name, phone, address, area, provider_id, account_number, network_node } })
    if (!data || typeof data.id !== 'string' || !data.id) throw new Error('Customer creation could not be confirmed. Check the directory before retrying.')
    return data.id
  },
  async createTicket(input) {
    const { id, connection_id, title, description, category, priority, assigned_to, due_at, outage_id } = input
    await mutate('/api/tickets', { id, connection_id, title, description, category, priority, assigned_to, due_at, outage_id })
  },
  async updateTicket(id, version, patch, note) {
    await mutate(ticketPath(id), { version, patch, note }, 'PATCH')
  },
  deleteTicket: (id, version, confirmation, reason) => mutate(ticketPath(id), { version, confirmation, reason }, 'DELETE'),
  async createOutage(input) {
    const { provider_id, area, title } = input
    await mutate('/api/outages', { provider_id, area, title })
  },
  restoreOutage: id => mutate(`/api/outages/${encodeURIComponent(id)}/restore`, {}),
  staff: input => mutate('/api/staff', input),
  async attachments(id, signal) {
    const images = await apiRequest<TicketImage[]>(`${ticketPath(id)}/images`, { signal })
    // Never render arbitrary CDN/external URLs, even if a response is malformed.
    if (!Array.isArray(images) || images.some(image => image.ticket_id !== id || image.url !== `${ticketPath(id)}/images/${encodeURIComponent(image.id)}/content`)) throw new Error('Protected ticket images could not be verified.')
    return images
  },
  async uploadImage(id, file) {
    const error = imageFileError(file)
    if (error) throw new Error(error)
    const body = new FormData(); body.append('image', file)
    await apiRequest(`${ticketPath(id)}/images`, { method: 'POST', body })
  },
  async deleteImage(id, imageId) { await apiRequest(`${ticketPath(id)}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' }) },
}