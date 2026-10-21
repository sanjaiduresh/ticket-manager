import { label, reference } from './format'
import type { Ticket } from './types'

export function whatsappNumberError(value: string) {
  return /^(?:\+[1-9]\d{6,14})?$/.test(value.trim()) ? '' : 'Use + followed by country code and number (7–15 digits), with no spaces or punctuation.'
}

export function whatsappTicketUrl(origin: string, id: string): string | null {
  try {
    const url = new URL(origin)
    // Never put localhost/dev links, URL credentials or session parameters in a message.
    if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) return null
    const ticket = new URL('/tickets', url.origin)
    ticket.searchParams.set('ticket', id)
    return ticket.href
  } catch { return null }
}

export function whatsappMessage(ticket: Pick<Ticket, 'id' | 'number' | 'priority'>, origin: string) {
  const link = whatsappTicketUrl(origin, ticket.id)
  return `DSA Service Desk\nTicket ${reference(ticket.number)} has been assigned to you.\nPriority: ${label(ticket.priority)}.\n${link ? `Sign in to view the details: ${link}` : 'Sign in to your company service desk to view the details.'}`
}

export function whatsappLink(number: string, message: string): string | null {
  const phone = number.trim()
  if (!phone || whatsappNumberError(phone)) return null
  return `https://wa.me/${phone.slice(1)}?text=${encodeURIComponent(message)}`
}