import { test, expect, type Page, type Route } from '@playwright/test'
import { createDemoApi } from '../../src/lib/demo'
import type { Dataset, Profile, TicketImage } from '../../src/lib/types'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
const owner = { company_name: 'Independent Example Networks', full_name: 'Fictional Test Owner', email: 'owner@independent.example', password: 'FAKE-password-for-tests-123' }
const hint = 'dsa-session-present'
type Attempt = { path: string; method: string; body: unknown; headers: Record<string, string> }
const unexpected = new WeakMap<Page, string[]>()
async function reply(route: Route, status: number, body: unknown) { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) }
async function mockApp(page: Page, respond: (route: Route, path: string) => Promise<void>) {
  const attempts: Attempt[] = []; const external: string[] = []; unexpected.set(page, external)
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin + url.pathname); return route.abort() }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const multipart = request.headers()['content-type']?.startsWith('multipart/')
    attempts.push({ path: url.pathname, method: request.method(), body: multipart ? request.postData() : request.postData() ? request.postDataJSON() : undefined, headers: request.headers() })
    return respond(route, url.pathname)
  })
  return attempts
}
async function fill(page: Page) {
  for (const [label, value] of [['Company name', owner.company_name], ['Full name', owner.full_name], ['Email address', owner.email], ['Password', owner.password], ['Confirm password', owner.password]]) await page.getByLabel(label, { exact: true }).fill(value)
}
async function openRegistration(page: Page, respond: (route: Route) => Promise<void>) {
  const attempts = await mockApp(page, respond)
  await page.goto('/')
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect(page.locator('input')).toHaveCount(5)
  await expect(page.getByLabel('Setup code', { exact: true })).toHaveCount(0)
  return attempts
}
async function signIn(page: Page, email = owner.email) {
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(owner.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
test.afterEach(async ({ page }) => {
  expect(unexpected.get(page) ?? []).toEqual([])
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(Object.keys(stored.local).filter(key => key !== hint)).toEqual([])
  expect(stored.session).toEqual({})
  expect(JSON.stringify(stored)).not.toContain(owner.password)
})

test('validates locally, focuses invalid fields and requires matching confirmation', async ({ page }) => {
  const attempts = await openRegistration(page, route => reply(route, 403, { error: 'Origin not allowed.' }))
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('company name')
  await expect(page.getByLabel('Company name', { exact: true })).toBeFocused()
  expect(attempts).toHaveLength(0)
  await fill(page)
  await page.getByLabel('Confirm password', { exact: true }).fill('mismatch')
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Passwords do not match.')
  expect(attempts).toHaveLength(0)
  await page.getByLabel('Confirm password', { exact: true }).fill(owner.password)
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Origin not allowed.')
  expect(attempts).toHaveLength(1)
})

test('company creation freezes the form, clears secrets and returns to sign-in without auto-login', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const attempts = await openRegistration(page, async route => { await gate; await reply(route, 201, { ok: true, email: owner.email }) })
  await fill(page)
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect.poll(() => attempts.length).toBe(1)
  for (const input of await page.locator('input').all()) await expect(input).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  release()
  await expect(page.getByRole('status')).toHaveText('Company created. Sign in with your email and password to open your workspace.')
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(owner.email)
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({ path: '/api/auth/register', method: 'POST', body: owner })
  expect(attempts[0].headers.authorization).toBeUndefined()
  expect(attempts[0].headers.apikey).toBeUndefined()
  expect(await page.evaluate(key => localStorage.getItem(key), hint)).toBeNull()
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  for (const input of await page.locator('input').all()) await expect(input).toHaveValue('')
})

for (const scenario of [
  { name: 'origin rejected', status: 403, message: 'Origin not allowed.', expected: 'Origin not allowed.' },
  { name: 'existing email', status: 409, message: 'Account already exists. Sign in.', expected: 'Account already exists.' },
  { name: 'rate limited', status: 429, message: 'Too many attempts. Try later.', expected: 'Too many attempts.' },
  { name: 'server unavailable', status: 503, message: 'Unavailable', expected: 'Sign in before retrying' },
  { name: 'network failure', status: 0, message: '', expected: 'Sign in before retrying' },
]) test(`${scenario.name} preserves inputs and never auto-retries`, async ({ page }) => {
  const attempts = await openRegistration(page, route => scenario.status ? reply(route, scenario.status, { error: scenario.message }) : route.abort('failed'))
  await fill(page)
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(scenario.expected)
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(owner.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  expect(attempts).toHaveLength(1)
})

test('mobile registration fits 360px and switching clears all secrets', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  const attempts = await openRegistration(page, route => reply(route, 500, {}))
  await expect(page.getByText('No email verification is required.', { exact: false })).toBeVisible()
  await fill(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('FAKE-signin-password')
  await page.getByRole('button', { name: 'Register owner', exact: true }).click()
  for (const input of await page.locator('input').all()) await expect(input).toHaveValue('')
  expect(attempts).toHaveLength(0)
})

const user = { id: 'user', email: owner.email }
const profile: Profile = { id: user.id, company_id: 'company', full_name: owner.full_name, role: 'owner', active: true, must_change_password: false }
async function dataset(name = 'Company', actor = profile): Promise<Dataset> {
  const seed = await createDemoApi().load()
  return {
    companies: [{ id: actor.company_id, name, created_at: '2026-10-16T00:00:00Z' }], profiles: [actor], providers: seed.providers, outages: [],
    customers: Array.from({ length: 12 }, (_, i) => ({ ...seed.customers[0], id: `${name}-customer-${i}`, company_id: actor.company_id, full_name: `${name} Private Customer ${i}` })),
    connections: Array.from({ length: 12 }, (_, i) => ({ ...seed.connections[0], id: `${name}-connection-${i}`, company_id: actor.company_id, customer_id: `${name}-customer-${i}`, account_number: `${name}-ACCOUNT-${i}` })),
    tickets: Array.from({ length: 12 }, (_, i) => ({ ...seed.tickets[0], id: `${name}-ticket-${i}`, company_id: actor.company_id, connection_id: `${name}-connection-${i}`, number: 2000 + i, title: `${name} Private Complaint ${i}` })),
  }
}
async function mockLive(page: Page, options: { profile?: unknown; profileStatus?: number; sessionStatus?: number; workspace?: Dataset; extra?: (route: Route, path: string) => Promise<void>; logoutStatus?: number } = {}) {
  const data = options.workspace ?? await dataset()
  return mockApp(page, async (route, path) => {
    if (path === '/api/auth/login') return reply(route, 200, { user })
    if (path === '/api/auth/session') return reply(route, options.sessionStatus ?? 200, options.sessionStatus ? { error: 'Session expired' } : { user })
    if (path === '/api/auth/logout') return reply(route, options.logoutStatus ?? 200, options.logoutStatus ? { error: 'Logout failed' } : { ok: true })
    if (path === '/api/profile') return reply(route, options.profileStatus ?? 200, options.profileStatus ? { error: 'Staff access unavailable' } : options.profile === undefined ? profile : options.profile)
    if (path === '/api/workspace') return reply(route, 200, data)
    if (path === '/api/notifications') return reply(route, 200, { items: [], unread_count: 0 })
    if (path.endsWith('/events')) return reply(route, 200, [])
    if (options.extra) return options.extra(route, path)
    if (path.endsWith('/images')) return reply(route, 200, [])
    throw new Error(`Unexpected API request: ${path}`)
  })
}

test('fresh login and demo including ticket images make zero API calls', async ({ page }) => {
  const attempts = await mockApp(page, route => reply(route, 500, {}))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  await page.getByRole('button', { name: /^Open DSA-/ }).first().click()
  await expect(page.getByRole('region', { name: 'Images', exact: true })).toContainText('Images are disabled in demo')
  await expect(page.getByLabel('Choose ticket image')).toHaveCount(0)
  expect(attempts).toHaveLength(0)
})

test('sign-in stores only a boolean and restores cookie session after reload', async ({ page }) => {
  const attempts = await mockLive(page)
  await page.goto('/'); await signIn(page)
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  expect(attempts.filter(a => a.path === '/api/auth/session')).toHaveLength(0)
  expect(await page.evaluate(key => localStorage.getItem(key), hint)).toBe('true')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  expect(attempts.some(a => a.path === '/api/auth/session')).toBe(true)
  await page.getByRole('button', { name: 'Account change password' }).click()
  await expect(page.getByRole('dialog')).toContainText('Company')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  expect(await page.evaluate(key => localStorage.getItem(key), hint)).toBeNull()
  expect(attempts.find(a => a.path === '/api/auth/logout')).toMatchObject({ method: 'POST', body: {} })
})

test('stale hint is cleared on 401 without reading private data', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'true'), hint)
  const attempts = await mockLive(page, { sessionStatus: 401 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  expect(attempts.every(a => a.path === '/api/auth/session')).toBe(true)
  expect(await page.evaluate(key => localStorage.getItem(key), hint)).toBeNull()
})

test('restoration transport failure stays gated without dropping the hint', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'true'), hint)
  const attempts = await mockLive(page, { sessionStatus: 503 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Workspace access unavailable' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Unable to restore your session')
  expect(attempts.every(a => a.path === '/api/auth/session')).toBe(true)
  expect(await page.evaluate(key => localStorage.getItem(key), hint)).toBe('true')
})

for (const scenario of [
  { name: 'missing profile', value: null, heading: 'Workspace access unavailable' },
  { name: 'missing company', value: { ...profile, company_id: '' }, heading: 'Workspace access unavailable' },
  { name: 'inactive', value: { ...profile, active: false }, heading: 'Staff access is inactive' },
  { name: 'temporary password', value: { ...profile, must_change_password: true }, heading: 'Choose a new password' },
]) test(`${scenario.name} remains gated without company completion or workspace calls`, async ({ page }) => {
  const attempts = await mockLive(page, { profile: scenario.value })
  await page.goto('/'); await signIn(page)
  await expect(page.getByRole('heading', { name: scenario.heading })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish company setup' })).toHaveCount(0)
  expect(attempts.some(a => a.path === '/api/workspace')).toBe(false)
})

for (const status of [403, 404, 500]) test(`profile HTTP ${status} never grants workspace access`, async ({ page }) => {
  const attempts = await mockLive(page, { profileStatus: status })
  await page.goto('/'); await signIn(page)
  await expect(page.getByRole('heading', { name: 'Workspace access unavailable' })).toBeVisible()
  expect(attempts.some(a => a.path === '/api/workspace')).toBe(false)
})

test('company A logout then B login never renders A data, events or images', async ({ page }) => {
  const actors = ['A', 'B'].map(name => ({ ...profile, id: name, company_id: `${name}-company` }))
  const datasets = await Promise.all(actors.map((actor, i) => dataset(i ? 'B' : 'A', actor)))
  let actor = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let bLoads = 0
  await mockApp(page, async (route, path) => {
    if (path === '/api/auth/login') { actor = route.request().postDataJSON().email.startsWith('b@') ? 1 : 0; return reply(route, 200, { user: { id: actors[actor].id, email: actor ? 'b@example.test' : owner.email } }) }
    if (path === '/api/auth/logout') return reply(route, 200, { ok: true })
    if (path === '/api/profile') return reply(route, 200, actors[actor])
    if (path === '/api/workspace') { if (actor) { bLoads++; await gate } return reply(route, 200, datasets[actor]) }
    if (path === '/api/notifications') return reply(route, 200, { items: [], unread_count: 0 })
    if (path.endsWith('/events')) return reply(route, 200, [{ id: 'event', ticket_id: path.split('/')[3], company_id: actors[actor].company_id, actor_id: actors[actor].id, body: `${actor ? 'B' : 'A'} Private Activity`, created_at: '2026-10-16T00:00:00Z' }])
    if (path.endsWith('/images')) return reply(route, 200, [])
    throw new Error(path)
  })
  await page.goto('/'); await signIn(page)
  await page.getByRole('button', { name: 'A Private Complaint 11', exact: true }).click()
  await expect(page.locator('.timeline')).toContainText('A Private Activity')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('link', { name: 'Customers', exact: true }).click()
  await expect(page.getByRole('cell', { name: 'A Private Customer 0', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.evaluate(() => {
    const state = window as unknown as { leaked: boolean }; state.leaked = false
    new MutationObserver(() => { if (/A Private/.test(document.body.textContent ?? '')) state.leaked = true }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await signIn(page, 'b@example.test')
  await expect.poll(() => bLoads).toBeGreaterThan(0)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  release()
  await expect(page.getByRole('cell', { name: 'B Private Customer 0', exact: true })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(10)
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await page.getByRole('link', { name: 'Tickets', exact: true }).click()
  await page.getByRole('button', { name: 'B Private Complaint 11', exact: true }).click()
  await expect(page.locator('.timeline')).toContainText('B Private Activity')
  await expect(page.getByRole('dialog')).not.toContainText('A Private')
  expect(await page.evaluate(() => (window as unknown as { leaked: boolean }).leaked)).toBe(false)
})

test('images upload multipart, reset file selection and delete outside the ticket form', async ({ page }) => {
  let images: TicketImage[] = []
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const attempts = await mockLive(page, { extra: async (route, path) => {
    if (path.endsWith('/content')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64') })
    if (route.request().method() === 'POST') {
      await gate
      const ticketId = path.split('/')[3]
      images = [{ id: 'image', ticket_id: ticketId, created_at: '2026-10-16T00:00:00Z', uploaded_by: user.id, url: `${path}/image/content` }]
      return reply(route, 201, { ok: true })
    }
    if (route.request().method() === 'DELETE') { images = []; return reply(route, 200, { ok: true }) }
    return reply(route, 200, images)
  } })
  await page.goto('/'); await signIn(page)
  await page.getByRole('button', { name: 'Company Private Complaint 11', exact: true }).click()
  const section = page.getByRole('region', { name: 'Images', exact: true })
  await expect(section).toContainText('No images attached yet')
  expect(await section.locator('input').evaluate(input => input.closest('form') === null)).toBe(true)
  await page.getByLabel('Choose ticket image').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('fixture') })
  await page.getByRole('button', { name: 'Upload image', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Uploading…' })).toBeDisabled()
  await expect(page.getByLabel('Choose ticket image')).toBeDisabled()
  release()
  await expect(section.getByRole('img')).toHaveCount(1)
  await expect(page.getByLabel('Choose ticket image')).toHaveValue('')
  const upload = attempts.find(a => a.method === 'POST' && a.path.endsWith('/images'))!
  expect(upload.headers['content-type']).toContain('multipart/form-data; boundary=')
  expect(upload.body).toContain('name="image"')
  await page.getByRole('button', { name: 'Delete image 1', exact: true }).click()
  await expect(section).toContainText('No images attached yet')
  expect(attempts.filter(a => a.method === 'PATCH')).toHaveLength(0)
})

test('image validation, upload failure and six-image limit are accessible', async ({ page }) => {
  let full = false
  const attempts = await mockLive(page, { extra: async (route, path) => {
    if (route.request().method() === 'POST') { full = true; return reply(route, 413, { error: 'Image too large.' }) }
    if (path.endsWith('/content')) return route.fulfill({ status: 403, body: '' })
    const ticketId = path.split('/')[3]
    return reply(route, 200, full ? Array.from({ length: 6 }, (_, i) => ({ id: String(i), ticket_id: ticketId, uploaded_by: user.id, created_at: '2026-10-16T00:00:00Z', url: `${path}/${i}/content` })) : [])
  } })
  await page.goto('/'); await signIn(page)
  await page.getByRole('button', { name: 'Company Private Complaint 11', exact: true }).click()
  await expect(page.getByLabel('Choose ticket image')).toBeEnabled()
  await page.getByLabel('Choose ticket image').setInputFiles({ name: 'test.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('svg') })
  await expect(page.getByRole('alert')).toContainText('JPEG, PNG or WebP')
  await expect(page.getByLabel('Choose ticket image')).toHaveValue('')
  expect(attempts.filter(a => a.method === 'POST' && a.path.endsWith('/images'))).toHaveLength(0)
  await page.getByLabel('Choose ticket image').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
  await expect(page.getByRole('alert')).toContainText('at most 5 MB')
  await page.getByLabel('Choose ticket image').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('fixture') })
  await page.getByRole('button', { name: 'Upload image', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Image too large.')
  await expect(page.getByLabel('Choose ticket image')).toHaveValue('')
  await page.getByRole('button', { name: 'Refresh images', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Images', exact: true })).toContainText('This ticket has 6 images')
  await expect(page.getByLabel('Choose ticket image')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Upload image', exact: true })).toBeDisabled()
})