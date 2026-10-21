import { test, expect, type Page } from '@playwright/test'
import { createDemoApi } from '../../src/lib/demo'
import type { Role } from '../../src/lib/types'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function fixture(page: Page, role: Role = 'office') {
  const data = await createDemoApi().load()
  const actor = data.profiles.find(p => p.role === role)!
  const tech = data.profiles.find(p => p.id === 'demo-tech-1')!
  tech.whatsapp_number = '+12025550123'
  const ticket = data.tickets.find(t => t.id === 'demo-t-2')!
  ticket.title = 'PRIVATE CUSTOMER DETAILS'
  const external: string[] = []
  const staffWrites: unknown[] = []
  await page.addInitScript(() => localStorage.setItem('dsa-session-present', 'true'))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { external.push(url.href); return route.abort() }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const reply = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/session') return reply({ user: { id: actor.id, email: 'fake@example.test' } })
    if (url.pathname === '/api/profile') return reply(actor)
    if (url.pathname === '/api/workspace') return reply(data)
    if (url.pathname === '/api/notifications') return reply({ items: [], unread_count: 0 })
    if (url.pathname.endsWith('/events') || url.pathname.endsWith('/images')) return reply([])
    if (url.pathname === '/api/staff') {
      const input = route.request().postDataJSON(); staffWrites.push(input)
      data.profiles.find(p => p.id === input.id)!.whatsapp_number = input.whatsapp_number
      return reply({ ok: true })
    }
    throw new Error(`Unexpected API request: ${url.pathname}`)
  })
  return { external, staffWrites }
}

for (const role of ['owner', 'office'] as const) test(`${role} has manual WhatsApp links per saved assignee, disabled for unsaved changes`, async ({ page }) => {
  const { external } = await fixture(page, role)
  await page.goto('/tickets?ticket=demo-t-2')
  const section = page.getByRole('region', { name: 'WhatsApp assignment messages' })
  await expect(section).toBeVisible()
  const link = section.getByRole('link', { name: 'Send via WhatsApp to Arun Kumar', exact: true })
  await expect(link).toBeVisible()
  const url = new URL((await link.getAttribute('href'))!)
  expect(url.origin).toBe('https://wa.me')
  expect(url.pathname).toBe('/12025550123')
  expect(url.searchParams.get('text')).toContain('DSA-1044')
  expect(url.searchParams.get('text')).toContain('Priority: Urgent')
  expect(url.searchParams.get('text')).not.toContain('PRIVATE CUSTOMER DETAILS')
  expect(url.searchParams.get('text')).not.toContain('127.0.0.1')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(section.getByRole('button', { name: 'Send via WhatsApp to Meera Das' })).toBeDisabled()
  await expect(section).toContainText('Ask the owner')
  await page.getByLabel('Issue title', { exact: true }).fill('Unsaved change')
  await expect(section.getByRole('link')).toHaveCount(0)
  await expect(section).toContainText('Save changes and reopen')
  await page.getByLabel('Issue title', { exact: true }).fill('PRIVATE CUSTOMER DETAILS')
  await expect(link).toBeVisible()
  expect(external).toEqual([]) // Inspect links only: never send a real message.
})

test('technicians cannot access WhatsApp sharing controls', async ({ page }) => {
  const { external } = await fixture(page, 'technician')
  await page.goto('/tickets?ticket=demo-t-2')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('region', { name: 'WhatsApp assignment messages' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0)
  expect(external).toEqual([])
})

test('owner edits, validates and removes a WhatsApp contact in Team', async ({ page }) => {
  const { staffWrites, external } = await fixture(page, 'owner')
  await page.goto('/team')
  await page.getByRole('button', { name: 'Edit WhatsApp for Arun Kumar' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('WhatsApp number', { exact: true })).toHaveValue('+12025550123')
  await dialog.getByLabel('WhatsApp number', { exact: true }).fill('bad-number')
  await dialog.getByRole('button', { name: 'Save WhatsApp contact' }).click()
  await expect(dialog.getByRole('alert')).toContainText('country code')
  expect(staffWrites).toEqual([])
  await dialog.getByLabel('WhatsApp number', { exact: true }).fill('+12025550124')
  await dialog.getByRole('button', { name: 'Save WhatsApp contact' }).click()
  await expect(dialog).toHaveCount(0)
  expect(staffWrites).toEqual([{ action: 'set_whatsapp', id: 'demo-tech-1', whatsapp_number: '+12025550124' }])
  await expect(page.getByRole('row', { name: /Arun Kumar/ })).toContainText('+12025550124')
  await page.getByRole('button', { name: 'Edit WhatsApp for Arun Kumar' }).click()
  await dialog.getByLabel('WhatsApp number', { exact: true }).fill('')
  await dialog.getByRole('button', { name: 'Save WhatsApp contact' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('row', { name: /Arun Kumar/ })).toContainText('Not set')
  expect(external).toEqual([])
})

test('mobile demo exposes sharing after creation but never opens WhatsApp', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const external: string[] = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname.startsWith('/api/')) { external.push(url.href); return route.abort() }
    return route.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await page.getByLabel('Issue title', { exact: true }).fill('WhatsApp manual demo')
  await page.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Create ticket', exact: true }).click()
  await page.getByRole('button', { name: 'Open ticket to send via WhatsApp' }).click()
  const section = page.getByRole('region', { name: 'WhatsApp assignment messages' })
  await expect(section).toContainText('WhatsApp is disabled in preview')
  await expect(section.getByRole('button', { name: 'Send via WhatsApp to Arun Kumar' })).toBeDisabled()
  await expect(section.getByRole('link')).toHaveCount(0)
  expect(external).toEqual([])
})