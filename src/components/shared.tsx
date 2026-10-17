import { useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUp, Inbox, LoaderCircle, Minus } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { errorMessage, label } from '../lib/format'

export function Field({ label: text, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{text}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function Select({ label: text, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId()
  return <select id={id} aria-label={text} {...props}>{children}</select>
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? <div role="alert" className="notice error"><AlertCircle size={17} aria-hidden="true"/><span>{errorMessage(error)}</span></div> : null
}
export function Loading({ text = 'Loading service desk…' }: { text?: string }) { return <div className="empty"><LoaderCircle className="spin" size={22} aria-hidden="true"/><p>{text}</p></div> }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><Inbox size={28} aria-hidden="true"/><h3>{title}</h3>{children && <p>{children}</p>}</div> }
export function PageHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="actions">{children}</div></header>
}
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className={wide ? 'desk-dialog detail-dialog' : 'desk-dialog'}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>
}
export function StatusBadge({ value }: { value: string }) { return <span className={`status status-${value}`}><span className="status-dot" aria-hidden="true"/>{label(value)}</span> }
export function PriorityBadge({ value }: { value: string }) {
  const Icon = value === 'urgent' ? ChevronsUp : value === 'high' ? ArrowUp : value === 'low' ? ArrowDown : Minus
  return <span className={`priority priority-${value}`}><Icon size={13} className="mr-1 inline-block align-text-bottom" aria-hidden="true"/>{label(value)}</span>
}
export function Pagination({ page, total, size = 10, onChange }: { page: number; total: number; size?: number; onChange(page: number): void }) {
  const last = Math.max(0, Math.ceil(total / size) - 1)
  return <footer className="pagination"><span>{total ? `${page * size + 1}–${Math.min((page + 1) * size, total)} of ${total}` : '0 results'}</span><div className="actions"><Button aria-label="Previous page" size="icon-sm" variant="outline" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft aria-hidden="true"/></Button><span>Page {page + 1} of {last + 1}</span><Button aria-label="Next page" size="icon-sm" variant="outline" disabled={page >= last} onClick={() => onChange(page + 1)}><ChevronRight aria-hidden="true"/></Button></div></footer>
}
export function Submit({ pending, children = 'Save changes' }: { pending: boolean; children?: ReactNode }) { return <Button type="submit" disabled={pending}>{pending && <LoaderCircle className="spin" aria-hidden="true"/>}{pending ? 'Saving…' : children}</Button> }