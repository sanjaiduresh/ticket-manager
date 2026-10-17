import { test, expect, type Download } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  // Branding checks must never reach live Auth or operational data.
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:4173') return route.continue()
    return route.abort()
  })
})

test('DSA brand and Lucide icons retain NISS provider identity', async ({ page }) => {
  const external: string[] = []
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url())
  })
  await page.goto('/')
  await expect(page).toHaveTitle('DSA Service Desk')
  await expect(page.locator('.login-brand strong')).toHaveText('DSA')
  const loginIcon = page.locator('.login-brand svg.lucide')
  await expect(loginIcon).toHaveAttribute('aria-hidden', 'true')
  const brandPaths = await loginIcon.locator('path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))
  expect(brandPaths.length).toBeGreaterThan(0)
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  const favicon = await page.request.get('/favicon.svg')
  expect(favicon.ok()).toBe(true)
  expect(favicon.headers()['content-type']).toContain('image/svg+xml')
  const svg = await favicon.text()
  expect([...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match => match[1])).toEqual(brandPaths)

  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  await expect(page.locator('.sidebar-brand strong')).toHaveText('DSA')
  await expect(page.locator('.breadcrumb')).toContainText('DSA')
  const sidebarIcon = page.locator('.sidebar-brand svg.lucide')
  await expect(sidebarIcon).toHaveAttribute('aria-hidden', 'true')
  expect(await sidebarIcon.locator('path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(brandPaths)
  const navigation = page.getByRole('navigation', { name: 'Main navigation' })
  await expect(navigation.locator('svg.lucide[aria-hidden="true"]')).toHaveCount(6)
  await expect(navigation.getByRole('link', { name: 'Performance', exact: true })).toBeVisible()

  const table = page.locator('.desktop-table')
  await expect(table.locator('.ticket-reference').first()).toContainText('DSA-')
  await expect(table.locator('.provider-niss').first()).toHaveText('NISS')
  await expect(page.getByLabel('Filter provider').locator('option[value="niss"]')).toHaveText('NISS')
  for (const [priority, icon, text] of [
    ['urgent', 'chevrons-up', 'Urgent'], ['high', 'arrow-up', 'High'],
    ['normal', 'minus', 'Normal'], ['low', 'arrow-down', 'Low'],
  ]) {
    const badge = table.locator(`.priority-${priority}`).first()
    await expect(badge).toHaveText(text)
    await expect(badge.locator(`svg.lucide-${icon}[aria-hidden="true"]`)).toBeVisible()
  }

  await page.getByLabel('Search tickets').fill('DSA-1042')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: 'Open DSA-1042', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('DSA-1042')
  expect(external).toEqual([])
})

async function csvContents(download: Download) {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

test('DSA CSV filenames leave provider IDs unchanged', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await page.getByRole('link', { name: 'Customers', exact: true }).click()
  const customersDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const customers = await customersDownload
  expect(customers.suggestedFilename()).toBe('dsa-customers.csv')
  expect(await csvContents(customers)).toContain(',niss,')

  await page.getByRole('link', { name: 'Reports', exact: true }).click()
  const ticketsDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all tickets', exact: true }).click()
  const tickets = await ticketsDownload
  expect(tickets.suggestedFilename()).toBe('dsa-tickets.csv')
  const csv = await csvContents(tickets)
  expect(csv).toContain('DSA-1042')
  expect(csv).toContain(',niss,')
  expect(csv).not.toContain('NISS-1042')
})