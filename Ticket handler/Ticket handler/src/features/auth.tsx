import { useEffect, useRef, useState } from 'react'
import { Building2, ArrowLeft, ArrowRight, ShieldCheck, UserRoundPlus } from 'lucide-react'
import { z } from 'zod'
import { saveSessionHint, type Session } from '../lib/session'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ErrorNotice, Field, Modal, Submit } from '../components/shared'
import { apiRequest } from '../lib/http'
import { passwordSchema } from '../lib/format'
import { registerOwner, registrationSchema } from '../lib/registration'
import type { DataApi } from '../lib/types'

function OwnerRegistration({ onSuccess, onBack }: { onSuccess(email: string): void; onBack(): void }) {
  const [error, setError] = useState<unknown>()
  const [pending, setPending] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const form = formRef.current
    // Secrets live only in these uncontrolled inputs and the in-flight request.
    return () => { mounted.current = false; form?.reset() }
  }, [])
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    setError(undefined)
    const form = event.currentTarget
    const parsed = registrationSchema.safeParse(Object.fromEntries(new FormData(form)))
    if (!parsed.success) {
      setError(new Error(parsed.error.issues[0].message))
      const field = form.elements.namedItem(String(parsed.error.issues[0].path[0]))
      if (field instanceof HTMLInputElement) field.focus()
      return
    }
    inFlight.current = true; setPending(true)
    try {
      const result = await registerOwner(parsed.data)
      form.reset()
      if (mounted.current) onSuccess(result.email)
    } catch (error) { if (mounted.current) setError(error) }
    finally { inFlight.current = false; if (mounted.current) setPending(false) }
  }
  return <>
    <span className="eyebrow"><UserRoundPlus size={15} aria-hidden="true"/> OWNER SETUP</span>
    <h1>Register owner</h1>
    <div className="notice"><ShieldCheck size={18} aria-hidden="true"/><span>Create your company workspace with your email address and password. No email verification is required. Each company has its own staff, customers and tickets.</span></div>
    <form ref={formRef} onSubmit={submit} noValidate aria-busy={pending}>
      <Field label="Company name"><Input name="company_name" required autoComplete="organization" disabled={pending}/></Field>
      <Field label="Full name"><Input name="full_name" required autoComplete="name" disabled={pending}/></Field>
      <Field label="Email address"><Input name="email" required type="email" autoComplete="username" disabled={pending}/></Field>
      <Field label="Password"><Input name="password" required type="password" autoComplete="new-password" aria-label="Password" aria-describedby="registration-password-help" disabled={pending}/><small id="registration-password-help">At least 12 Unicode characters; at most 256 UTF-8 bytes.</small></Field>
      <Field label="Confirm password"><Input name="confirm_password" required type="password" autoComplete="new-password" disabled={pending}/></Field>
      <ErrorNotice error={error}/>
      <Submit pending={pending}><UserRoundPlus size={16} aria-hidden="true"/> Register owner</Submit>
    </form>
    <Button type="button" variant="ghost" className="mt-4 w-full" onClick={() => { formRef.current?.reset(); onBack() }} disabled={pending}><ArrowLeft size={16} aria-hidden="true"/> Sign in</Button>
  </>
}

export function Login({ onLogin, onPreview, initialError }: { onLogin(session: Session): void; onPreview(): void; initialError?: Error }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(initialError); const [pending, setPending] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [success, setSuccess] = useState(false)
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setError(undefined)
    const parsed = z.object({ email: z.email(), password: z.string().min(1, 'Enter your password.') }).safeParse({ email: email.trim(), password })
    if (!parsed.success) { setError(new Error('Enter a valid email address and password.')); return }
    setPending(true)
    try {
      const session = await apiRequest<Session>('/api/auth/login', { method: 'POST', body: parsed.data })
      if (!session?.user?.id || typeof session.user.email !== 'string') throw new Error('Sign-in could not be confirmed.')
      saveSessionHint(true)
      setPassword(''); onLogin({ user: { id: session.user.id, email: session.user.email } })
    } catch (error) { setError(error) } finally { setPending(false) }
  }
  return <div className="login-page">
    <div className="login-brand"><div className="brand-mark"><Building2 size={23} aria-hidden="true"/></div><div><strong>DSA</strong><span>Service Desk</span></div></div>
    <main className="login-card">
      {registering ? <OwnerRegistration onBack={() => setRegistering(false)} onSuccess={registeredEmail => { setEmail(registeredEmail); setPassword(''); setError(undefined); setSuccess(true); setRegistering(false) }}/> : <>
        <span className="eyebrow"><ShieldCheck size={15} aria-hidden="true"/> STAFF WORKSPACE</span><h1>Welcome back</h1><p>Sign in to keep your customers connected.</p>
        {success && <div role="status" className="notice"><ShieldCheck size={18} aria-hidden="true"/><span>Company created. Sign in with your email and password to open your workspace.</span></div>}
        <form onSubmit={submit} noValidate aria-busy={pending}>
          <Field label="Email address"><Input type="email" autoComplete="username" value={email} disabled={pending} onChange={e => setEmail(e.target.value)} placeholder="you@business.example"/></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={password} disabled={pending} onChange={e => setPassword(e.target.value)}/></Field>
          <ErrorNotice error={error}/>
          <Submit pending={pending}>Sign in <ArrowRight size={16} aria-hidden="true"/></Submit>
        </form>
        <Button type="button" variant="outline" className="mt-4 w-full" disabled={pending} onClick={() => { setPassword(''); setError(undefined); setSuccess(false); setRegistering(true) }}><UserRoundPlus size={16} aria-hidden="true"/> Register owner</Button>
        <p className="login-help">Staff accounts are created by their company owner.<br/>Need access or a password reset? Contact your owner.</p>
        <div className="preview-entry"><span>Explore the workspace without an account</span><Button variant="outline" onClick={() => { setPassword(''); onPreview() }} disabled={pending}>Preview demo</Button><small>Fictional data only · Changes reset on refresh</small></div>
      </>}
    </main>
    <footer>Internal operations · DSA Service Desk</footer>
  </div>
}

export function PasswordForm({ api, onSuccess, forced = false }: { api: DataApi; onSuccess(): void; forced?: boolean }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(); const [pending, setPending] = useState(false)
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined)
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) { setError(new Error(parsed.error.issues[0].message)); return }
    if (password !== confirm) { setError(new Error('Passwords do not match.')); return }
    setPending(true)
    try { await api.staff({ action: 'change_password', password }); setPassword(''); setConfirm(''); onSuccess() }
    catch (error) { setError(error) } finally { setPending(false) }
  }
  return <form onSubmit={submit}><p className="muted">{forced ? 'Your temporary password must be changed before you can access operations.' : 'Choose a unique password that you do not use elsewhere.'}</p><Field label="New password" hint="At least 12 characters. Passwords are never shown to teammates."><Input required type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></Field><Field label="Confirm new password"><Input required type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}/></Field><ErrorNotice error={error}/><Submit pending={pending}>Change password</Submit></form>
}
export function PasswordDialog({ api, companyName, onClose, onSuccess }: { api: DataApi; companyName: string; onClose(): void; onSuccess(): void }) {
  return <Modal title="Change password" description={`Update your staff account credentials for ${companyName}.`} onClose={onClose}><PasswordForm api={api} onSuccess={onSuccess}/></Modal>
}