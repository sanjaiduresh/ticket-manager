import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Empty, ErrorNotice, Loading, Modal } from '../components/shared'
import { useAction, useDesk } from '../lib/runtime'
import { deskQueryOptions } from '../lib/queries'
import { formatDate, reference } from '../lib/format'

export function Notifications() {
  const { api, scope, demo } = useDesk(); const cache = useQueryClient(); const navigate = useNavigate()
  const [open, setOpen] = useState(false), [browser, setBrowser] = useState(false), [permissionError, setPermissionError] = useState('')
  const seen = useRef<Set<string> | null>(null)
  const desktopAlerts = useRef<Notification[]>([])
  const feed = useQuery({ ...deskQueryOptions, queryKey: [scope, 'notifications'], queryFn: ({ signal }) => api.notifications(signal), refetchInterval: 15_000, refetchIntervalInBackground: true })
  const result = feed.isError ? undefined : feed.data
  const read = useAction((id: string | undefined) => api.readNotifications(id), 'Notifications marked as read')
  useEffect(() => {
    if (!result) return
    const previous = seen.current
    seen.current = new Set(result.items.map(item => item.id))
    if (!previous) return // Existing unread items are shown in the inbox, not replayed as alerts.
    for (const item of result.items.filter(item => !item.read_at && !previous.has(item.id))) {
      toast.info(`${reference(item.ticket_number)} was assigned to you`, { id: item.id })
      if (browser && !demo && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const alert = new Notification('DSA · Ticket assigned', { body: `${reference(item.ticket_number)} was assigned to you. Open the service desk to view it.`, tag: item.id })
          desktopAlerts.current.push(alert)
          alert.onclose = () => { desktopAlerts.current = desktopAlerts.current.filter(entry => entry !== alert) }
        } catch { toast.warning('Browser alerts are unavailable on this device. In-app notifications still work.', { id: 'browser-alert-unavailable' }) }
      }
    }
    if (result.items.some(item => !previous.has(item.id))) void cache.invalidateQueries({ queryKey: [scope, 'data'] })
  }, [result, browser, demo, cache, scope])
  useEffect(() => () => { desktopAlerts.current.forEach(alert => alert.close()); desktopAlerts.current = [] }, [])
  async function enableBrowser() {
    setPermissionError('')
    if (browser) { setBrowser(false); desktopAlerts.current.forEach(alert => alert.close()); return }
    if (!('Notification' in window) || !window.isSecureContext) { setPermissionError('Browser alerts need a supported browser and HTTPS. In-app notifications still work.'); return }
    try {
      const permission = await Notification.requestPermission()
      setBrowser(permission === 'granted')
      if (permission !== 'granted') setPermissionError('Permission was not granted. You can change notifications in your browser’s site settings.')
    } catch { setPermissionError('Browser permission could not be requested. In-app notifications still work.') }
  }
  return <>
    <Button variant="ghost" size="sm" className="notification-bell" aria-label={`Notifications${result?.unread_count ? `, ${result.unread_count} unread` : ''}${feed.isError ? ', unavailable' : ''}`} onClick={() => setOpen(true)}><Bell size={17} aria-hidden="true"/>{!!result?.unread_count && <span className="notification-count">{result.unread_count > 99 ? '99+' : result.unread_count}</span>}{feed.isError && <span aria-hidden="true">!</span>}</Button>
    {open && <Modal title="Notifications" description="Ticket assignments for you. Your latest 100 notifications are saved here, including assignments received while signed out." onClose={() => setOpen(false)}>
      <div className="notification-controls"><Button variant="outline" disabled={demo} onClick={() => void enableBrowser()}>{browser ? 'Disable browser alerts' : 'Enable browser alerts'}</Button><Button variant="ghost" disabled={!result?.unread_count || read.isPending} onClick={() => read.mutate(undefined)}>Mark all as read</Button></div>
      <p className="muted">Alerts refresh about every 15 seconds while the app is open. Browser alerts are optional for this session; delivery may be delayed by background tab throttling. {demo && 'Browser alerts are disabled in preview.'}</p>
      {permissionError && <p role="status" className="notice warning">{permissionError}</p>}<ErrorNotice error={read.error}/>
      {feed.isError ? <><ErrorNotice error={feed.error}/><Button onClick={() => void feed.refetch()}>Retry notifications</Button></> : feed.isPending ? <Loading text="Loading notifications…"/> : !result?.items.length ? <Empty title="No notifications yet">New ticket assignments will appear here.</Empty> : <ul className="notification-list">{result.items.map(item => <li key={item.id} className={item.read_at ? '' : 'notification-unread'}><div><strong>{reference(item.ticket_number)}</strong><span>{item.kind === 'created' ? 'New ticket created and assigned to you' : 'Ticket assigned to you'}</span><small>{formatDate(item.created_at)} IST · {item.read_at ? 'Read' : 'Unread'}</small></div><div className="actions"><Button size="sm" variant="outline" onClick={() => { void cache.invalidateQueries({ queryKey: [scope, 'data'] }); navigate(`/tickets?ticket=${encodeURIComponent(item.ticket_id)}`); setOpen(false) }}>View ticket</Button>{!item.read_at && <Button size="sm" variant="ghost" disabled={read.isPending} onClick={() => read.mutate(item.id)}>Mark as read</Button>}</div></li>)}</ul>}
    </Modal>}
  </>
}