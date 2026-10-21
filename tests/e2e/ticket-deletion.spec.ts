import { test, expect, type Page } from '@playwright/test'

type DeletionAttempt = { id: string; version: number; confirmation: string; reason: string }
type FixtureWindow = Window & {
  deletionAttempts: DeletionAttempt[]
  ticketSaves: number
  releaseDeletion(): void
  changeTicket(): Promise<void>
  changeRole(role: string): void
}

// Real ticket UI and query lifecycle, with an isolated in-memory delete contract.
// The demo adapter may not implement deletion yet; never fall back to the live API.
async function fixture(page: Page, options: { role?: 'owner' | 'office' | 'technician'; pending?: boolean; failure?: boolean; unavailable?: boolean; sharing?: boolean } = {}) {
  const external: string[] = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.startsWith('/api/')) {
      external.push(url.origin + url.pathname)
      return route.abort()
    }
    return route.continue()
  })
  // Match Vite's optimized URLs so React and React Query share their contexts.
  const runtime = await (await page.request.get('/src/lib/runtime.tsx')).text()
  const tickets = await (await page.request.get('/src/features/tickets.tsx')).text()
  const reactUrl = runtime.match(/from ["']([^"']+\/react\.js[^"']*)["']/)?.[1]
  const queryUrl = runtime.match(/from ["']([^"']+@tanstack_react-query[^"']*)["']/)?.[1]
  const routerUrl = tickets.match(/from ["']([^"']+react-router-dom[^"']*)["']/)?.[1]
  if (!reactUrl || !queryUrl || !routerUrl) throw new Error('Local fixture modules unavailable')
  await page.route('**/__ticket-deletion-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
      import React from '${reactUrl}';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { QueryClient, QueryClientProvider, useQuery } from '${queryUrl}';
      import { MemoryRouter } from '${routerUrl}';
      import { TicketsPage } from '/src/features/tickets.tsx';
      import { RuntimeContext } from '/src/lib/runtime.tsx';
      import { createDemoApi } from '/src/lib/demo.ts';
      import '/src/index.css'; import '/src/App.css';
      const options = ${JSON.stringify(options)};
      const api = createDemoApi(); const load = api.load; const update = api.updateTicket;
      const deleted = new Set(); window.deletionAttempts = []; window.ticketSaves = 0;
      api.load = async () => {
        const data = await load();
        data.tickets = data.tickets.filter(t => !deleted.has(t.id));
        // A short number verifies DSA-7, not the display formatter's DSA-0007.
        const ticket = data.tickets.find(t => t.id === 'demo-t-2');
        if (ticket) ticket.number = 7;
        data.profiles.filter(p => p.role === 'technician').forEach(p => { p.whatsapp_number = '+919876543210'; });
        return data;
      };
      api.updateTicket = async (...args) => { window.ticketSaves++; return update(...args); };
      const gate = options.pending ? new Promise(resolve => { window.releaseDeletion = resolve; }) : Promise.resolve();
      api.deleteTicket = options.unavailable ? undefined : async (id, version, confirmation, reason) => {
        window.deletionAttempts.push({ id, version, confirmation, reason });
        await gate;
        if (options.failure) throw new Error('Deletion result unavailable');
        const ticket = (await api.load()).tickets.find(t => t.id === id);
        if (!ticket || ticket.version !== version) throw new Error('Ticket changed; reopen before deleting');
        if (confirmation !== 'DSA-' + ticket.number || !reason.trim() || reason.trim().length > 500) throw new Error('Invalid deletion confirmation');
        deleted.add(id);
      };
      api.attachments = async () => [];
      api.uploadImage = async () => { throw new Error('Uploads are not part of this fixture'); };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.changeTicket = async () => {
        const ticket = (await load()).tickets.find(t => t.id === 'demo-t-2');
        await update(ticket.id, ticket.version, { provider_reference: 'Updated elsewhere' }, '');
        await client.invalidateQueries({ queryKey: ['deletion-test', 'data'] });
      };
      function Fixture() {
        const [role, setRole] = React.useState(options.role ?? 'owner'); window.changeRole = setRole;
        const result = useQuery({ queryKey: ['deletion-test', 'data'], queryFn: () => api.load() });
        if (!result.data) return null;
        const profile = result.data.profiles.find(p => p.role === role);
        return React.createElement(RuntimeContext.Provider, { value: {
          api, profile, data: result.data, demo: !options.sharing, scope: 'deletion-test', logout: async () => {}
        } }, React.createElement(TicketsPage));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,
        { client }, React.createElement(MemoryRouter, { initialEntries: ['/tickets?ticket=demo-t-2'] }, React.createElement(Fixture))));
    </script></body></html>` }))
  await page.goto('/__ticket-deletion-test')
  await expect(page.getByRole('dialog')).toBeVisible()
  return external
}

const start = (page: Page) => page.getByRole('button', { name: 'Delete ticket permanently…', exact: true })
const confirm = (page: Page) => page.getByRole('button', { name: 'Permanently delete ticket', exact: true })
const attempts = (page: Page) => page.evaluate(() => (window as FixtureWindow).deletionAttempts)
async function fillConfirmation(page: Page, reason = '  Duplicate complaint  ') {
  await page.getByLabel('Type DSA-7 to confirm', { exact: true }).fill('DSA-7')
  await page.getByLabel('Reason for permanent deletion', { exact: true }).fill(reason)
}

for (const role of ['owner', 'office'] as const) test(`${role} confirms demo deletion with exact unpadded reference and a trimmed reason`, async ({ page }) => {
  if (role === 'office') await page.setViewportSize({ width: 390, height: 844 })
  const external = await fixture(page, { role })
  await expect(start(page)).toBeEnabled()
  await start(page).click()
  const group = page.getByRole('group', { name: 'Confirm permanent deletion of DSA-7' })
  await expect(group).toHaveAccessibleDescription(/irreversible.*events and in-app notifications.*queues images for deletion.*customer, connection and linked outage are retained.*deletion audit.*messages cannot be recalled/i)
  await expect(group.getByText('Demo only:', { exact: false })).toBeVisible()
  expect(await group.locator('xpath=ancestor::form').count()).toBe(0)
  await expect(confirm(page)).toBeDisabled()
  await fillConfirmation(page, '   ')
  await expect(confirm(page)).toBeDisabled()
  await fillConfirmation(page)
  for (const wrong of ['DSA-0007', 'dsa-7', ' DSA-7', 'DSA-7 ', 'DSA-8']) {
    await page.getByLabel('Type DSA-7 to confirm', { exact: true }).fill(wrong)
    await expect(confirm(page)).toBeDisabled()
  }
  await fillConfirmation(page, 'x'.repeat(501))
  await expect(confirm(page)).toBeDisabled()
  await expect(page.getByLabel('Reason for permanent deletion', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await fillConfirmation(page, '  ' + 'x'.repeat(500) + '  ')
  await expect(confirm(page)).toBeEnabled()
  await fillConfirmation(page)
  // Enter in the confirmation cannot submit the unrelated ticket save form.
  await page.getByLabel('Type DSA-7 to confirm', { exact: true }).press('Enter')
  expect(await attempts(page)).toEqual([])
  expect(await page.evaluate(() => (window as FixtureWindow).ticketSaves)).toBe(0)
  await confirm(page).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await attempts(page)).toEqual([{ id: 'demo-t-2', version: 1, confirmation: 'DSA-7', reason: 'Duplicate complaint' }])
  await page.getByLabel('Search tickets').fill('Red LOS light on optical terminal')
  await expect(page.getByText('No tickets in this view', { exact: true })).toBeVisible()
  await expect(page.getByText('This ticket is not in your current workspace.', { exact: false })).toHaveCount(0)
  expect(external).toEqual([])
})

test('technician never sees permanent deletion controls, including after a role change', async ({ page }) => {
  const external = await fixture(page, { role: 'technician' })
  await expect(start(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Permanent ticket deletion' })).toHaveCount(0)
  await page.evaluate(() => (window as FixtureWindow).changeRole('office'))
  await start(page).click()
  await fillConfirmation(page)
  await page.evaluate(() => (window as FixtureWindow).changeRole('technician'))
  await expect(confirm(page)).toHaveCount(0)
  await expect(page.getByLabel('Reason for permanent deletion', { exact: true })).toHaveCount(0)
  expect(await attempts(page)).toEqual([])
  expect(external).toEqual([])
})

test('unsaved drafts and notes block deletion; cancelling clears the confirmation', async ({ page }) => {
  await fixture(page)
  const title = page.getByLabel('Issue title', { exact: true })
  const original = await title.inputValue()
  await title.fill('Unsaved change')
  await expect(start(page)).toBeDisabled()
  await title.fill(original)
  await page.getByLabel('Add a note', { exact: false }).fill('Unsaved note')
  await expect(start(page)).toBeDisabled()
  await page.getByLabel('Add a note', { exact: false }).fill('')
  await start(page).click()
  await fillConfirmation(page)
  await expect(title).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click()
  await expect(title).toBeEnabled()
  await start(page).click()
  await expect(page.getByLabel('Type DSA-7 to confirm', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Reason for permanent deletion', { exact: true })).toHaveValue('')
  await expect(confirm(page)).toBeDisabled()
  expect(await attempts(page)).toEqual([])
})

test('a stale snapshot requires cancellation, reload and a new confirmation', async ({ page }) => {
  await fixture(page)
  await start(page).click()
  await fillConfirmation(page)
  await page.evaluate(() => (window as FixtureWindow).changeTicket())
  await expect(page.getByRole('alert')).toContainText('This deletion confirmation is stale')
  await expect(confirm(page)).toBeDisabled()
  await expect(page.getByRole('group', { name: 'Confirm permanent deletion of DSA-7' })).toContainText('Version 1')
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click()
  await expect(start(page)).toBeDisabled()
  await page.getByRole('button', { name: 'reload latest fields', exact: true }).click()
  await start(page).click()
  await expect(page.getByRole('group', { name: 'Confirm permanent deletion of DSA-7' })).toContainText('Version 2')
  await expect(confirm(page)).toBeDisabled()
  await fillConfirmation(page)
  await confirm(page).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect((await attempts(page)).map(attempt => attempt.version)).toEqual([2])
})

test('pending deletion blocks duplicate calls, editing, sharing, images and dismissal', async ({ page }) => {
  const external = await fixture(page, { role: 'office', pending: true, sharing: true })
  const shareName = 'Send via WhatsApp to Arun Kumar'
  await expect(page.getByRole('link', { name: shareName })).toBeVisible()
  await start(page).click()
  await fillConfirmation(page)
  await confirm(page).click()
  await expect(page.getByRole('button', { name: 'Deleting permanently…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Issue title', { exact: true })).toBeDisabled()
  await expect(page.getByLabel('Reason for permanent deletion', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Cancel deletion', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await expect(page.getByRole('link', { name: shareName })).toHaveCount(0)
  await expect(page.getByRole('button', { name: shareName })).toBeDisabled()
  await expect(page.getByLabel('Choose ticket image', { exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await attempts(page)).toHaveLength(1)
  await page.evaluate(() => (window as FixtureWindow).releaseDeletion())
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(external).toEqual([])
})

test('an unconfirmed deletion shows an error without closing or automatically retrying', async ({ page }) => {
  await fixture(page, { failure: true })
  await start(page).click()
  await fillConfirmation(page)
  await confirm(page).click()
  await expect(page.getByRole('alert')).toContainText('Deletion result unavailable')
  await expect(page.getByText('Deletion was not confirmed.', { exact: false })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await attempts(page)).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
})

test('an adapter without deletion fails closed rather than invoking a missing method', async ({ page }) => {
  const external = await fixture(page, { unavailable: true })
  await expect(start(page)).toBeDisabled()
  await expect(page.getByText('Permanent deletion is unavailable in this workspace.', { exact: true })).toBeVisible()
  expect(await attempts(page)).toEqual([])
  expect(external).toEqual([])
})