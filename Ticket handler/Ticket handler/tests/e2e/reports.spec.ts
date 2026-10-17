import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createDemoApi } from '../../src/lib/demo'
import { recentRange } from '../../src/lib/reporting'
import type { Dataset, PerformanceReport, Role } from '../../src/lib/types'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
async function fixture(page: Page, role: Role = 'owner', empty = false) {
  const data: Dataset = await createDemoApi().load()
  const actor = { ...data.profiles[0], role }
  data.profiles[0] = actor
  data.tickets = empty ? [] : [
    { ...data.tickets[0], id: 'before', number: 3001, connection_id: null, created_at: '2026-10-15T18:29:59Z' },
    { ...data.tickets[0], id: 'at', number: 3002, title: '=FORMULA()', connection_id: null, assigned_to: ['demo-tech-1', 'demo-tech-2', 'demo-tech-1'], created_at: '2026-10-15T18:30:00Z', customer_feedback: 'Retained feedback' },
    { ...data.tickets[0], id: 'after', number: 3003, connection_id: null, created_at: '2026-10-16T18:30:00Z' },
    { ...data.tickets[6], id: 'resolved', number: 3004, created_at: '2026-10-16T00:00:00Z' },
    { ...data.tickets[7], id: 'closed', number: 3005, created_at: '2026-10-16T00:00:00Z' },
  ]
  const requests: URL[] = []
  let failure = 0
  const employees: PerformanceReport['employees'] = data.profiles.map((profile, index) => ({ ...profile, full_name: index === 1 ? '=Office Formula' : profile.full_name, active: index !== 3, open_assigned: index, overdue_assigned: 0, awaiting_feedback_assigned: 1, created: index + 1, resolved: index + 2, closed: index + 3, feedback_recorded: index + 4, median_resolution_hours: index === 3 ? null : 12.5 }))
  await page.addInitScript(() => localStorage.setItem('dsa-session-present', 'true'))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/session') return reply({ user: { id: actor.id, email: 'fake@example.test' } })
    if (url.pathname === '/api/profile') return reply(actor)
    if (url.pathname === '/api/workspace') return reply(data)
    if (url.pathname === '/api/reports/performance') {
      requests.push(url)
      return failure ? reply({ error: 'Performance access denied' }, failure) : reply({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), generated_at: '2026-10-16T10:00:00Z', employees: empty ? [] : employees })
    }
    throw new Error(`Unexpected API request: ${url.pathname}`)
  })
  return { requests, deny: (status: number) => { failure = status } }
}
async function downloadText(page: Page, name: string) {
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name, exact: true }).click()
  const download = await downloaded
  return readFile((await download.path())!, 'utf8')
}

for (const role of ['office', 'technician'] as const) test(`${role} cannot see or directly load performance and never requests it`, async ({ page }) => {
  const { requests } = await fixture(page, role)
  await page.goto('/performance')
  await expect(page).toHaveURL(/\/tickets$/)
  await expect(page.getByRole('link', { name: 'Performance', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click()
  await page.goto('/reports')
  if (role === 'office') {
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Technician workload' })).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText('Arun Kumar')
  } else await expect(page).toHaveURL(/\/tickets$/)
  expect(requests).toHaveLength(0)
})

test('reports chart/table/filter/export parity includes unlinked provider and IST boundaries', async ({ page }) => {
  await fixture(page, 'office')
  await page.goto('/reports')
  await expect(page.getByRole('button', { name: 'Export all tickets', exact: true })).toBeEnabled()
  await expect(page.getByRole('region', { name: 'Awaiting feedback / resolved' })).toContainText('1')
  await expect(page.getByRole('region', { name: 'Closed', exact: true })).toContainText('1')
  await page.getByLabel('From (IST)', { exact: true }).fill('2026-10-16')
  await page.getByLabel('To (IST)', { exact: true }).fill('2026-10-16')
  await page.getByLabel('Provider', { exact: true }).selectOption('none')
  await page.getByLabel('Priority', { exact: true }).selectOption('high')
  await expect(page.getByRole('status').first()).toContainText('1 tickets')
  await expect(page.getByRole('img', { name: /^Provider workload/ })).toBeVisible()
  await page.getByText('View provider workload data table', { exact: true }).click()
  const provider = page.getByRole('table', { name: 'Provider workload', exact: true })
  await expect(provider.getByRole('row', { name: 'No connection 1', exact: true })).toBeVisible()
  const chartTable = await provider.innerText()
  await page.getByRole('button', { name: 'Tables', exact: true }).click()
  expect(await provider.innerText()).toBe(chartTable)
  await expect(page.getByRole('table', { name: 'Tickets-created trend' }).getByRole('row', { name: '2026-10-16 1', exact: true })).toBeVisible()
  const csv = await downloadText(page, 'Export filtered tickets')
  expect(csv).toContain('DSA-3002'); expect(csv).not.toContain('DSA-3001'); expect(csv).not.toContain('DSA-3003')
  expect(csv).toContain("'=FORMULA()"); expect(csv).toContain('Retained feedback'); expect(csv).toContain('No connection')
  expect(csv).toContain('Arun Kumar; Meera Das'); expect(csv).not.toContain('Arun Kumar; Meera Das; Arun Kumar')
  await page.getByLabel('Priority', { exact: true }).selectOption('low')
  await expect(page.getByRole('heading', { name: 'No tickets match' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export filtered tickets' })).toBeDisabled()
  await page.getByLabel('From (IST)', { exact: true }).fill('2026-10-17')
  await expect(page.getByRole('alert')).toContainText('on or before')
  await expect(page.getByRole('table')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reset filters' }).click()
  await expect(page.getByRole('button', { name: 'Export all tickets' })).toBeEnabled()
})

test('owner performance ranges are explicit, employee filters and chart/table CSV agree', async ({ page }) => {
  const { requests } = await fixture(page)
  await page.goto('/tickets')
  await page.getByRole('link', { name: 'Performance', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Employee performance', exact: true })).toBeVisible()
  expect(Object.fromEntries(requests[0].searchParams)).toEqual(recentRange())
  await expect(page.locator('main')).toContainText('not actual labor time')
  await expect(page.getByRole('row', { name: /Meera Das/ })).toContainText('Inactive')
  await expect(page.getByRole('row', { name: /Meera Das/ })).toContainText('No history')
  const initialRequests = requests.length // StrictMode may abort and restart the initial query.
  await page.getByLabel('From (IST)', { exact: true }).fill('2026-10-01')
  await page.getByLabel('To (IST)', { exact: true }).fill('2026-10-07')
  await expect(page.locator('main')).toContainText('not applied yet')
  expect(requests).toHaveLength(initialRequests)
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await expect.poll(() => requests.length).toBe(initialRequests + 1)
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
  await page.getByLabel('Role', { exact: true }).selectOption('office')
  const table = page.getByRole('table', { name: 'Employee performance', exact: true })
  await expect(table.locator('tbody tr')).toHaveCount(1)
  const csv = await downloadText(page, 'Export performance CSV')
  expect(csv).toContain("'=Office Formula"); expect(csv).not.toContain('Arun Kumar'); expect(csv).toContain('2026-10-01')
  await page.getByRole('button', { name: 'Charts', exact: true }).click()
  await page.getByText('View created data table', { exact: true }).click()
  await expect(page.getByRole('table', { name: 'Created', exact: true })).toContainText('=Office Formula')
  await expect(page.getByRole('table', { name: 'Created', exact: true }).getByRole('cell')).toHaveText('2')
  await page.getByRole('button', { name: 'Tables', exact: true }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await page.getByLabel('Search employees', { exact: true }).fill('nobody')
  await expect(page.getByRole('heading', { name: 'No employees match' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export performance CSV' })).toBeDisabled()
  await page.getByRole('button', { name: 'Clear employee filters' }).click()
  await page.getByLabel('Account activity', { exact: true }).selectOption('inactive')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('Meera Das')
  expect(requests).toHaveLength(initialRequests + 1)
  await page.getByLabel('From (IST)', { exact: true }).fill('2026-10-08')
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await expect(page.getByRole('alert')).toContainText('on or before')
  expect(requests).toHaveLength(initialRequests + 1)
  await page.getByLabel('From (IST)', { exact: true }).fill('2020-01-01')
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await expect(page.getByRole('alert')).toContainText('366 days')
  expect(requests).toHaveLength(initialRequests + 1)
})

for (const status of [401, 403]) test(`performance background ${status} hides stale tables/charts and exports until retry`, async ({ page }) => {
  const { deny, requests } = await fixture(page)
  await page.goto('/performance')
  await expect(page.getByRole('table', { name: 'Employee performance', exact: true })).toBeVisible()
  deny(status)
  const initialRequests = requests.length
  await page.getByRole('button', { name: 'Refresh performance', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Performance access denied')
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('=Office Formula')
  await expect(page.getByRole('button', { name: 'Export performance CSV' })).toBeDisabled()
  expect(requests).toHaveLength(initialRequests + 1)
  deny(0)
  await page.getByRole('button', { name: 'Retry performance', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Employee performance', exact: true })).toBeVisible()
})

test('empty reports and performance are meaningful on mobile without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, 'owner', true)
  await page.goto('/reports')
  await expect(page.getByRole('heading', { name: 'No tickets match' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export all tickets' })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto('/performance')
  await expect(page.getByRole('heading', { name: 'No employees match' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export performance CSV' })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('demo performance stays offline with no fabricated resolutions', async ({ page }) => {
  const requests: string[] = []
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort() })
  await page.goto('/')
  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await page.getByRole('link', { name: 'Performance', exact: true }).click()
  const table = page.getByRole('table', { name: 'Employee performance', exact: true })
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await expect(table.getByText('No history', { exact: true })).toHaveCount(4)
  expect(requests).toEqual([])
})

test('performance loading, preset Apply, employee selection and chart mobile layout', async ({ page }) => {
  const { requests } = await fixture(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/reports/performance?**', async route => { await pending; await route.fallback() })
  await page.goto('/performance')
  await expect(page.getByRole('status')).toContainText('Loading employee performance')
  await expect(page.getByRole('button', { name: 'Export performance CSV' })).toBeDisabled()
  release()
  const table = page.getByRole('table', { name: 'Employee performance', exact: true })
  await expect(table).toBeVisible()
  const initial = requests.length
  await page.getByLabel('Period', { exact: true }).selectOption('7')
  await expect(page.getByLabel('From (IST)', { exact: true })).toHaveValue(recentRange(7).from)
  expect(requests).toHaveLength(initial)
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await expect.poll(() => requests.length).toBe(initial + 1)
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual(recentRange(7))
  await page.getByLabel('Employee', { exact: true }).selectOption('demo-tech-1')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('Arun Kumar')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Charts', exact: true }).click()
  const chart = page.getByRole('img', { name: /^Created\./ })
  await expect(chart).toBeVisible()
  expect((await chart.boundingBox())!.height).toBeGreaterThanOrEqual(300)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})