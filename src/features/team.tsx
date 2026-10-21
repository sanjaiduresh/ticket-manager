import { useState } from 'react'
import { Plus, KeyRound } from 'lucide-react'
import { z } from 'zod'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorNotice, Field, Modal, PageHeader, Pagination, Select, StatusBadge, Submit } from '../components/shared'
import { useAction, useDesk } from '../lib/runtime'
import { label, passwordSchema } from '../lib/format'
import { whatsappNumberError } from '../lib/whatsapp'
import type { Profile, StaffInput } from '../lib/types'

export function TeamPage() {
  const { data, api, profile } = useDesk(); const [create, setCreate] = useState(false); const [edit, setEdit] = useState<Profile | null>(null); const [reset, setReset] = useState<Profile | null>(null); const [page, setPage] = useState(0)
  const [contact, setContact] = useState<Profile | null>(null)
  const action = useAction((input: StaffInput) => api.staff(input), 'Staff member updated')
  const rows = [...data.profiles].sort((a, b) => a.full_name.localeCompare(b.full_name))
  return <>
    <PageHeader title="Team" subtitle="Manage staff access and WhatsApp contacts. Roles are enforced by the backend."><Button onClick={() => setCreate(true)}><Plus/>Add staff</Button></PageHeader>
    <div className="notice">Temporary passwords must be shared privately with the intended staff member. They must change the password before accessing operations. Do not send passwords in tickets or team notes.</div>
    <ErrorNotice error={action.error}/>
    <section className="panel"><div className="table-scroll"><table><thead><tr><th>Staff member</th><th>Role</th><th>Access</th><th>Password</th><th>WhatsApp</th><th>Actions</th></tr></thead><tbody>{rows.slice(page * 10, page * 10 + 10).map(p => <tr key={p.id}>
      <td><strong>{p.full_name}</strong>{p.id === profile.id && <small className="cell-secondary">You</small>}</td><td>{label(p.role)}</td><td><StatusBadge value={p.active ? 'active' : 'inactive'}/></td><td className="muted">{p.must_change_password ? 'Change required' : 'Ready'}</td>
      <td>{p.role !== 'owner' ? <><span className="cell-secondary">{p.whatsapp_number || 'Not set'}</span><Button variant="ghost" size="sm" aria-label={`Edit WhatsApp for ${p.full_name}`} onClick={() => setContact(p)}>Edit WhatsApp</Button></> : '—'}</td>
      <td><div className="actions">{p.role !== 'owner' && <><Button variant="outline" size="sm" onClick={() => setEdit(p)}>Change role</Button><Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => action.mutate({ action: 'update', id: p.id, active: !p.active })}>{p.active ? 'Deactivate' : 'Activate'}</Button></>}{p.id !== profile.id && <Button variant="ghost" size="sm" onClick={() => setReset(p)}><KeyRound size={14}/>Reset password</Button>}{p.role === 'owner' && <small className="muted">Owner role protected</small>}</div></td>
    </tr>)}</tbody></table></div><Pagination page={page} total={rows.length} onChange={setPage}/></section>
    {create && <StaffForm onClose={() => setCreate(false)}/>}{reset && <StaffForm target={reset} onClose={() => setReset(null)}/>}{edit && <RoleForm target={edit} onClose={() => setEdit(null)}/>}{contact && <WhatsAppContactForm target={contact} onClose={() => setContact(null)}/>}
  </>
}
function WhatsAppContactForm({ target, onClose }: { target: Profile; onClose(): void }) {
  const { api } = useDesk()
  const [number, setNumber] = useState(target.whatsapp_number ?? '')
  const [error, setError] = useState('')
  const save = useAction(() => api.staff({ action: 'set_whatsapp', id: target.id, whatsapp_number: number.trim() }), 'WhatsApp contact saved', onClose)
  return <Modal title="WhatsApp contact" description={`Set the work notification number for ${target.full_name}.`} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); const message = whatsappNumberError(number); setError(message); if (!message) save.mutate() }}>
      <Field label="WhatsApp number" hint="Include + and country code, then digits only. Leave blank to remove the contact."><Input aria-label="WhatsApp number" type="tel" autoComplete="off" maxLength={16} value={number} disabled={save.isPending} onChange={event => { setNumber(event.target.value); setError('') }}/></Field>
      <p className="muted">Confirm the number with the employee and obtain permission for work messages. Owners and office staff can view this contact. Saving it does not send a message or verify that WhatsApp is registered.</p>
      <ErrorNotice error={error ? new Error(error) : save.error}/><div className="form-footer"><Submit pending={save.isPending}>Save WhatsApp contact</Submit></div>
    </form>
  </Modal>
}
function StaffForm({ target, onClose }: { target?: Profile; onClose(): void }) {
  const { api, demo } = useDesk(); const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState<'office' | 'technician'>('technician'); const [error, setError] = useState<unknown>()
  const save = useAction((input: StaffInput) => api.staff(input), demo ? 'Demo staff action simulated' : target ? 'Temporary password reset' : 'Staff account created', () => { setPassword(''); onClose() })
  return <Modal title={target ? 'Reset staff password' : 'Add staff member'} description={target ? `Set a private temporary password for ${target.full_name}.` : 'Create an office or technician account. Public signup is disabled.'} onClose={onClose}><form onSubmit={e => { e.preventDefault(); setError(undefined); const result = passwordSchema.safeParse(password); if (!result.success) { setError(new Error(result.error.issues[0].message)); return } if (!target && (!name.trim() || !z.email().safeParse(email.trim()).success)) { setError(new Error('Enter a name and a valid email address.')); return } save.mutate(target ? { action: 'reset_password', id: target.id, password } : { action: 'create', full_name: name.trim(), email: email.trim(), password, role }) }}><fieldset disabled={save.isPending}>{!target && <><Field label="Full name"><Input required maxLength={200} value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Email"><Input required type="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></Field><Field label="Role"><Select label="Staff role" value={role} onChange={e => setRole(e.target.value as 'office' | 'technician')}><option value="technician">Technician</option><option value="office">Office</option></Select></Field></>}<Field label="Temporary password" hint="At least 12 characters. Share privately; the app does not send an email."><Input type="password" required autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></Field></fieldset><ErrorNotice error={error || save.error}/>{save.isError && <p className="muted">Do not repeatedly retry uncertain staff operations. Ask the administrator to verify account state first.</p>}<div className="form-footer"><Submit pending={save.isPending}>{target ? 'Reset password' : 'Create staff'}</Submit></div></form></Modal>
}
function RoleForm({ target, onClose }: { target: Profile; onClose(): void }) {
  const { api } = useDesk(); const [role, setRole] = useState<'office' | 'technician'>(target.role === 'office' ? 'office' : 'technician')
  const save = useAction(() => api.staff({ action: 'update', id: target.id, role }), 'Staff role updated', onClose)
  return <Modal title="Change staff role" description={`Update access for ${target.full_name}. Existing ticket assignments are retained as history.`} onClose={onClose}><form onSubmit={e => { e.preventDefault(); save.mutate() }}><Field label="Role"><Select label="New staff role" value={role} onChange={e => setRole(e.target.value as 'office' | 'technician')}><option value="office">Office</option><option value="technician">Technician</option></Select></Field><ErrorNotice error={save.error}/><Submit pending={save.isPending}/></form></Modal>
}