import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { clearLegacyAuth, hasSavedSession, saveSessionHint, sessionHintKey, type Session } from './lib/session'
import { apiRequest, ApiError } from './lib/http'
import { Building2, Ticket, Users, Radio, ChartNoAxesCombined, UserRoundCog, LogOut, ChevronRight, Menu, RefreshCw, KeyRound, X, Clock3 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from './components/ui/button'
import { ErrorNotice, Loading } from './components/shared'
import { Login, PasswordDialog, PasswordForm } from './features/auth'
import { TicketsPage } from './features/tickets'
import { Notifications } from './features/notifications'
import { CompanyWorkspaceError, liveApi } from './lib/data'
import { deskQueryOptions, discardOtherWorkspaces, profileKey, workspaceScope } from './lib/queries'
import { createDemoApi, demoOwner } from './lib/demo'
import { RuntimeContext, useDesk } from './lib/runtime'
import { errorMessage, label } from './lib/format'
import type { DataApi, Profile } from './lib/types'
import './App.css'

const CustomersPage = lazy(() => import('./features/customers').then(m => ({ default: m.CustomersPage })))
const OutagesPage = lazy(() => import('./features/outages').then(m => ({ default: m.OutagesPage })))
const TeamPage = lazy(() => import('./features/team').then(m => ({ default: m.TeamPage })))
const ReportsPage = lazy(() => import('./features/reports').then(m => ({ default: m.ReportsPage })))
const PerformancePage = lazy(() => import('./features/performance').then(m => ({ default: m.PerformancePage })))
const AttendancePage = lazy(() => import('./features/attendance').then(m => ({ default: m.AttendancePage })))

type Mode = { kind: 'login'; error?: Error } | { kind: 'live'; session: Session | null } | { kind: 'demo'; api: DataApi }
export default function App() {
  const [mode, setMode] = useState<Mode>(() => hasSavedSession() ? { kind: 'live', session: null } : { kind: 'login' })
  const cache = useQueryClient()
  useEffect(() => { clearLegacyAuth() }, [])
  const exit = useCallback((error?: Error) => { cache.clear(); setMode({ kind: 'login', error }) }, [cache])
  if (mode.kind === 'login') return <Login initialError={mode.error} onLogin={session => { cache.clear(); setMode({ kind: 'live', session }) }} onPreview={() => { cache.clear(); setMode({ kind: 'demo', api: createDemoApi() }) }}/>
  return <BrowserRouter><Suspense fallback={<Loading text="Loading workspace…"/>}>{mode.kind === 'demo' ? <Workspace api={mode.api} profile={demoOwner} demo logout={async () => exit()}/> : <LiveWorkspace initial={mode.session} onExit={exit}/>}</Suspense></BrowserRouter>
}

function LiveWorkspace({ initial, onExit }: { initial: Session | null; onExit(error?: Error): void }) {
  const [session, setSession] = useState(initial); const [authError, setAuthError] = useState<unknown>()
  const cache = useQueryClient()
  useEffect(() => {
    if (initial) return
    const controller = new AbortController()
    void apiRequest<Session>('/api/auth/session', { signal: controller.signal }).then(next => {
      if (controller.signal.aborted) return
      if (!next?.user?.id || typeof next.user.email !== 'string') throw new Error('Invalid session response.')
      setSession({ user: { id: next.user.id, email: next.user.email } })
    }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) { saveSessionHint(false); onExit() }
      else setAuthError(new Error('Unable to restore your session. Retry or sign out and sign in again.'))
    })
    return () => controller.abort()
  }, [initial, onExit])
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === sessionHintKey || event.key === null) onExit(new Error('Session changed in another tab. Sign in again.')) }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [onExit])
  const profile = useQuery({ ...deskQueryOptions, queryKey: profileKey(session?.user.id), queryFn: ({ signal }) => liveApi.profile(session!.user.id, signal), enabled: !!session, refetchInterval: 30_000, refetchIntervalInBackground: true, staleTime: 0 })
  const activeScope = !profile.isError && profile.data?.active && !profile.data.must_change_password ? workspaceScope('live', profile.data) : undefined
  useEffect(() => { discardOtherWorkspaces(cache, activeScope, session?.user.id) }, [cache, activeScope, session?.user.id])
  useEffect(() => {
    if (profile.error instanceof ApiError && profile.error.status === 401) { saveSessionHint(false); onExit(new Error('Your session expired. Sign in again.')) }
  }, [profile.error, onExit])
  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', body: {} })
      saveSessionHint(false)
      cache.clear(); onExit()
    } catch (error) { toast.error(errorMessage(error)) }
  }, [cache, onExit])
  if (authError || profile.isError) return <Gate title="Workspace access unavailable"><ErrorNotice error={authError || profile.error}/><div className="actions"><Button onClick={() => { if (authError) location.reload(); else void profile.refetch() }}>Retry</Button><Button variant="outline" onClick={() => void logout()}>Sign out</Button></div></Gate>
  if (!session || profile.isPending) return <Loading text="Checking staff access…"/>
  if (!profile.data.active) return <Gate title="Staff access is inactive"><p>Ask your administrator to reactivate your account.</p><Button variant="outline" onClick={() => void logout()}>Sign out</Button></Gate>
  if (profile.data.must_change_password) return <Gate title="Choose a new password"><PasswordForm api={liveApi} forced onSuccess={() => { void profile.refetch() }}/><Button variant="ghost" onClick={() => void logout()}>Sign out</Button></Gate>
  return <Workspace key={activeScope} api={liveApi} profile={profile.data} demo={false} logout={logout}/>
}
function Gate({ title, children }: { title: string; children: ReactNode }) { return <main className="gate panel"><div className="brand-mark"><Building2 aria-hidden="true"/></div><h1>{title}</h1>{children}</main> }

function Workspace({ api, profile, demo, logout }: { api: DataApi; profile: Profile; demo: boolean; logout(): Promise<void> }) {
  const scope = workspaceScope(demo ? 'demo' : 'live', profile)
  const dataset = useQuery({ ...deskQueryOptions, queryKey: [scope, 'data'], queryFn: async ({ signal }) => {
    const data = await api.load(signal)
    if (data.companies.length !== 1 || data.companies[0].id !== profile.company_id || !data.companies[0].name.trim()) throw new CompanyWorkspaceError()
    return data
  }, refetchInterval: 30_000 })
  if (dataset.isPending) return <Loading/>
  if (!dataset.data || dataset.error instanceof CompanyWorkspaceError || (dataset.error instanceof ApiError && [401, 403].includes(dataset.error.status))) return <Gate title="Unable to load workspace"><ErrorNotice error={dataset.error}/><p>Check your connection or ask your administrator to verify company access and server setup.</p><div className="actions"><Button onClick={() => void dataset.refetch()}>Retry</Button><Button variant="outline" onClick={() => void logout()}>Sign out</Button></div></Gate>
  return <RuntimeContext.Provider value={{ api, profile, demo, scope, data: dataset.data, logout }}>{dataset.isError && <div className="refresh-warning" role="alert">Refresh failed. Showing the last loaded records; open drafts are preserved. <button onClick={() => void dataset.refetch()}>Retry</button> · {errorMessage(dataset.error)}</div>}<Shell/></RuntimeContext.Provider>
}

function Shell() {
  const { api, profile, data, demo, scope, logout } = useDesk(); const cache = useQueryClient(); const location = useLocation()
  const company = data.companies.find(company => company.id === profile.company_id)!
  const [password, setPassword] = useState(false); const [menu, setMenu] = useState(false)
  const office = profile.role !== 'technician'
  const navigation = [ { path: '/tickets', text: office ? 'Tickets' : 'My jobs', icon: Ticket }, { path: '/attendance', text: 'Attendance', icon: Clock3 }, ...(office ? [{ path: '/customers', text: 'Customers', icon: Users }] : []), { path: '/outages', text: 'Outages', icon: Radio }, ...(office ? [{ path: '/reports', text: 'Reports', icon: ChartNoAxesCombined }] : []), ...(profile.role === 'owner' ? [{ path: '/performance', text: 'Performance', icon: ChartNoAxesCombined }, { path: '/team', text: 'Team', icon: UserRoundCog }] : []) ]
  const title = navigation.find(n => n.path === location.pathname)?.text ?? 'Tickets'
  const nav = <>
    <div className="sidebar-brand"><div className="brand-mark"><Building2 size={21} aria-hidden="true"/></div><div><strong>DSA</strong><span>Service Desk</span></div></div>
    <div className="workspace-label">WORKSPACE<strong className="company-name" title={company.name}>{company.name}</strong></div>
    <nav aria-label="Main navigation">{navigation.map(item => <NavLink key={item.path} to={item.path} onClick={() => setMenu(false)}><item.icon size={18} aria-hidden="true"/>{item.text}</NavLink>)}</nav>
    <div className="sidebar-bottom">
      <div className="workspace-note"><span className="summary-dot teal" aria-hidden="true"/>Company staff workspace<small>Your team. Your customer records.</small></div>
      <button className="account-button" onClick={() => { setPassword(true); setMenu(false) }} aria-label="Account change password"><span className="account-avatar">{profile.full_name.split(' ').map(n => n[0]).slice(0, 2).join('')}</span><span><strong>{profile.full_name}</strong><small>{label(profile.role)}{demo ? ' · Demo' : ''}</small><small className="company-name" title={company.name}>{company.name}</small></span><KeyRound size={15} aria-hidden="true"/></button>
      <Button variant="ghost" className="logout-button" onClick={() => void logout()}><LogOut size={15} aria-hidden="true"/>{demo ? 'Exit preview' : 'Sign out'}</Button>
    </div>
  </>
  return <div className={`app-shell ${demo ? 'is-demo' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    {demo && <div className="preview-banner"><span><strong>PREVIEW DEMO</strong> All people, contacts and records are fictional. No API calls. Changes reset on refresh.</span><button onClick={() => void logout()}>Exit preview <X size={13} aria-hidden="true"/></button></div>}
    <aside className="sidebar">{nav}</aside>
    {menu && <div className="mobile-nav"><button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMenu(false)}/><aside>{nav}</aside></div>}
    <div className="workspace-main">
      <header className="topbar">
        <div className="actions"><Button className="mobile-menu-button" variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu aria-hidden="true"/></Button><div className="breadcrumb"><span title={company.name}>{company.name}</span><ChevronRight size={13} aria-hidden="true"/><strong>{title}</strong></div></div>
        <div className="actions"><span className="timezone">Asia/Kolkata · IST</span><Notifications/><Button variant="ghost" size="icon-sm" aria-label="Refresh workspace" onClick={() => { void cache.invalidateQueries({ queryKey: [scope] }) }}><RefreshCw size={15} aria-hidden="true"/></Button><Button variant="ghost" size="icon-sm" aria-label="Change password" onClick={() => setPassword(true)}><KeyRound size={15} aria-hidden="true"/></Button></div>
      </header>
      <main id="main-content" className="page-content"><Routes><Route path="/tickets" element={<TicketsPage/>}/><Route path="/attendance" element={<AttendancePage/>}/><Route path="/customers" element={office ? <CustomersPage/> : <Navigate to="/tickets" replace/>}/><Route path="/outages" element={<OutagesPage/>}/><Route path="/reports" element={office ? <ReportsPage/> : <Navigate to="/tickets" replace/>}/><Route path="/performance" element={profile.role === 'owner' ? <PerformancePage/> : <Navigate to="/tickets" replace/>}/><Route path="/team" element={profile.role === 'owner' ? <TeamPage/> : <Navigate to="/tickets" replace/>}/><Route path="*" element={<Navigate to="/tickets" replace/>}/></Routes></main>
    </div>
    {password && <PasswordDialog api={api} companyName={company.name} onClose={() => setPassword(false)} onSuccess={() => { toast.success(demo ? 'Demo password change simulated' : 'Password changed'); setPassword(false); void cache.invalidateQueries() }}/>}
  </div>
}
