import { MessageCircle } from 'lucide-react'
import { Button } from './ui/button'
import { assigneeIds, assigneeName } from '../lib/assignees'
import { useDesk } from '../lib/runtime'
import { whatsappLink, whatsappMessage, whatsappTicketUrl } from '../lib/whatsapp'
import type { Ticket } from '../lib/types'

export function TicketWhatsApp({ ticket, blocked = false }: { ticket: Ticket; blocked?: boolean }) {
  const { profile, data, demo } = useDesk()
  if (profile.role === 'technician') return null
  const ids = assigneeIds(ticket.assigned_to)
  const message = whatsappMessage(ticket, window.location.origin)
  return <section className="ticket-whatsapp" aria-label="WhatsApp assignment messages">
    <h2><MessageCircle size={18} aria-hidden="true"/>Notify assigned technicians</h2>
    <p>Opens a prepared message in WhatsApp or WhatsApp Web. Check the recipient and press <strong>Send</strong> there. Nothing is sent automatically; this app cannot confirm delivery.</p>
    {demo && <p className="notice">WhatsApp is disabled in preview. No messages or external requests are made.</p>}
    {blocked && <p className="notice warning">Save changes and reopen the ticket before sharing. Messages use saved ticket assignments and priority only.</p>}
    {!ids.length ? <p className="muted">Assign a technician and save the ticket to prepare a message.</p> : <>
      <details><summary>Preview prepared message</summary><p className="whatsapp-message">{message}</p></details>
      {!whatsappTicketUrl(window.location.origin, ticket.id) && <p className="muted">This local or non-HTTPS address is not included. Use the deployed HTTPS app to include a ticket sign-in link.</p>}
      <ul>{ids.map(id => {
        const employee = data.profiles.find(p => p.id === id && p.company_id === profile.company_id)
        const name = assigneeName(id, data.profiles)
        const active = employee?.active && employee.role === 'technician'
        const href = active ? whatsappLink(employee.whatsapp_number ?? '', message) : null
        return <li key={id}><div><strong>{name}</strong><small>{!active ? 'Active technician required' : href ? employee.whatsapp_number : 'No valid WhatsApp number. Ask the owner to add it in Team → Edit WhatsApp.'}</small></div>
          {href && !demo && !blocked ? <a className="whatsapp-send" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Send via WhatsApp to ${name}`}><MessageCircle size={16} aria-hidden="true"/>Send via WhatsApp</a> : <Button type="button" variant="outline" size="sm" disabled aria-label={`Send via WhatsApp to ${name}`}><MessageCircle size={16} aria-hidden="true"/>Send via WhatsApp</Button>}
        </li>
      })}</ul>
    </>}
  </section>
}