import { test, expect, type Page } from '@playwright/test'

async function preview(page: Page) {
  // A fresh context has no live Auth session. Any accidental external request fails the test.
  const external: string[] = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { external.push(url.origin); return route.abort() }
    return route.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Preview demo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  await expect(page.getByText('All people, contacts and records are fictional.', { exact: false })).toBeVisible()
  return external
}

test('login validates invalid input locally', async ({ page }) => {
  let external = 0
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : (external++, route.abort()))
  await page.goto('/')
  await page.getByLabel('Email address').fill('not-an-email')
  await page.getByLabel('Password', { exact: true }).fill('test')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('valid email')
  expect(external).toBe(0)
})

test('demo queue creates, searches, edits, and records notes', async ({ page }) => {
  const external = await preview(page)
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Connection', { exact: true }).selectOption('demo-cn-0')
  await expect(dialog.getByText(/open ticket\(s\) already exist/)).toBeVisible()
  await dialog.getByLabel('Issue title').fill('Fictional acceptance test connection')
  await dialog.getByLabel('Details', { exact: true }).fill('Testing the isolated demo workflow')
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByLabel('Search tickets').fill('Fictional acceptance')
  await page.getByRole('button', { name: 'Fictional acceptance test connection', exact: true }).click()
  await dialog.getByLabel('Provider reference').fill('DEMO-PROVIDER-TEST')
  await dialog.getByLabel('Add a note', { exact: false }).fill('Fictional callback arranged')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Fictional acceptance test connection', exact: true }).click()
  await expect(dialog.getByText('Fictional callback arranged', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Provider reference')).toHaveValue('DEMO-PROVIDER-TEST')
  expect(external).toEqual([])
})

// Local component integration fixture: real ticket UI, query lifecycle and demo API.
// Inject role/transport failures here rather than adding test hooks to production code.
async function ticketFixture(page: Page, failures: { error: object; commit?: boolean }[] = [], role = 'office', options: { emptyCompany?: boolean; demo?: boolean; legacyFeedback?: 'missing' | 'null'; inactiveTechnician?: boolean } = {}) {
  const external: string[] = []
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.startsWith('/api/')) { external.push(url.origin + url.pathname); return route.abort() }
    return route.continue()
  })
  // Reuse Vite's exact optimized URL (including its version query) so the fixture
  // and production components share one React Query context, not two module copies.
  const runtimeSource = await (await page.request.get('/src/lib/runtime.tsx')).text()
  const queryUrl = runtimeSource.match(/from ["']([^"']+@tanstack_react-query[^"']*)["']/)?.[1]
  const reactUrl = runtimeSource.match(/from ["']([^"']+\/react\.js[^"']*)["']/)?.[1]
  if (!queryUrl) throw new Error('Could not locate the local React Query module')
  if (!reactUrl) throw new Error('Could not locate the local React module')
  await page.route('**/__ticket-test', route => route.fulfill({ contentType: 'text/html', body: `
    <html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
      import React from '${reactUrl}';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { QueryClient, QueryClientProvider, useQuery } from '${queryUrl}';
      import { TicketsPage } from '/src/features/tickets.tsx';
      import { RuntimeContext } from '/src/lib/runtime.tsx';
      import { createDemoApi } from '/src/lib/demo.ts';
      import '/src/index.css'; import '/src/App.css';
      const api = createDemoApi(); const originalCreate = api.createTicket;
      const options = ${JSON.stringify(options)};
      if (options.inactiveTechnician) await api.staff({ action: 'update', id: 'demo-tech-1', active: false });
      const originalUpdate = api.updateTicket; window.ticketUpdates = [];
      api.updateTicket = async (id, version, patch, note) => {
        window.ticketUpdates.push(structuredClone({ id, version, patch, note }));
        await originalUpdate(id, version, patch, note);
      };
      if (options.legacyFeedback) {
        const originalLoad = api.load;
        api.load = async () => {
          const data = await originalLoad();
          for (const ticket of data.tickets.filter(t => ['resolved', 'closed'].includes(t.status))) {
            if (options.legacyFeedback === 'null') ticket.customer_feedback = null;
            else delete ticket.customer_feedback;
          }
          return data;
        };
      }
      if (options.emptyCompany) {
        const originalLoad = api.load;
        const seededIds = new Set((await originalLoad()).tickets.map(t => t.id));
        api.load = async () => {
          const data = await originalLoad();
          return { ...data, customers: [], connections: [], tickets: data.tickets.filter(t => !seededIds.has(t.id)) };
        };
      }
      const failures = ${JSON.stringify(failures)}; window.ticketAttempts = [];
      api.createTicket = async input => {
        window.ticketAttempts.push(structuredClone(input));
        const failure = failures.shift();
        if (failure) { if (failure.commit) await originalCreate(input); throw failure.error; }
        await originalCreate(input);
      };
      const role = ${JSON.stringify(role)};
      function Fixture() {
        const [activeRole, setRole] = React.useState(role); window.setFixtureRole = setRole;
        const result = useQuery({ queryKey: ['test', 'data'], queryFn: () => api.load() });
        if (!result.data) return null;
        const profile = result.data.profiles.find(p => activeRole === 'technician' ? p.id === 'demo-tech-2' : p.role === activeRole);
        return React.createElement(RuntimeContext.Provider, { value: {
          api, profile, data: result.data, demo: options.demo ?? true, scope: 'test', logout: async () => {}
        } }, React.createElement(TicketsPage));
      }
      const client = new QueryClient();
      window.simulateStaleUpdate = async () => {
        await originalUpdate('demo-t-2', 1, { assigned_to: ['demo-tech-1'] }, 'Changed by another staff member');
        await client.invalidateQueries({ queryKey: ['test', 'data'] });
      };
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,
        { client }, React.createElement(Fixture)));
    </script></body></html>` }))
  await page.goto('/__ticket-test')
  await expect(page.getByRole('heading', { name: role === 'technician' ? 'My jobs' : 'Ticket queue' })).toBeVisible()
  return external
}

async function fillComplaint(page: Page, title: string) {
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Connection', { exact: true }).selectOption('demo-cn-0')
  await dialog.getByLabel('Issue title').fill(title)
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
}

for (const mobile of [false, true]) test(`${mobile ? 'mobile' : 'desktop'} multiple technician creation, filtering, edits and removal`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  const external = await ticketFixture(page)
  const dialog = page.getByRole('dialog'), title = 'Joint technician complaint'
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await dialog.getByLabel('Issue title').fill(title)
  const group = dialog.getByRole('group', { name: 'Assigned technicians', exact: true })
  await expect(group).toHaveAccessibleDescription(/Unassigned.*50 technicians/)
  await group.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).check()
  await group.getByRole('checkbox', { name: 'Meera Das', exact: true }).check()
  await expect(group).toHaveAccessibleDescription(/2 selected/)
  expect(await group.locator('label label').count()).toBe(0)
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await expect(dialog).toBeHidden()
  const attempts = await page.evaluate(() => (window as unknown as { ticketAttempts: { assigned_to: string[] }[] }).ticketAttempts)
  expect(attempts[0].assigned_to).toEqual(['demo-tech-1', 'demo-tech-2'])
  await page.getByLabel('Search tickets').fill(title)
  const row = mobile ? page.locator('.job-card').filter({ hasText: title }) : page.getByRole('row').filter({ hasText: title })
  await expect(row).toContainText('Arun Kumar; Meera Das')
  for (const id of ['demo-tech-1', 'demo-tech-2']) {
    await page.getByLabel('Filter assignee').selectOption(id)
    await expect(row).toBeVisible()
  }
  await page.getByLabel('Filter assignee').selectOption('none')
  await expect(row).toHaveCount(0)
  await page.getByLabel('Filter assignee').selectOption('')
  const open = () => page.getByRole('button', { name: title, exact: true }).click()
  const save = () => dialog.getByRole('button', { name: 'Save changes' }).click()
  await open()
  await expect(group.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await group.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).uncheck()
  await save(); await expect(dialog).toBeHidden()
  await expect(row).toContainText('Meera Das'); await expect(row).not.toContainText('Arun Kumar')
  await page.getByLabel('Filter assignee').selectOption('demo-tech-1')
  await expect(row).toHaveCount(0)
  await page.getByLabel('Filter assignee').selectOption('demo-tech-2')
  await open()
  await group.getByRole('checkbox', { name: 'Meera Das', exact: true }).uncheck()
  await dialog.getByLabel('Ticket status').selectOption('in_progress')
  await save(); await expect(dialog.getByRole('alert')).toContainText('Assign a technician')
  await dialog.getByLabel('Ticket status').selectOption('assigned')
  await save(); await expect(dialog).toBeHidden()
  await page.getByLabel('Filter assignee').selectOption('none')
  await page.getByRole('tab', { name: /^Unassigned/ }).click()
  await expect(row).toContainText('Unassigned'); await expect(row).toContainText('New')
  await open()
  await expect(dialog.locator('.timeline')).toContainText('Assigned to removed')
  await expect(group.getByRole('checkbox', { checked: true })).toHaveCount(0)
  const updates = await page.evaluate(() => (window as unknown as { ticketUpdates: { version: number; patch: { assigned_to: string[] } }[] }).ticketUpdates)
  expect(updates.map(u => u.patch.assigned_to)).toEqual([['demo-tech-2'], []])
  expect(updates.map(u => u.version)).toEqual([1, 2])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(external).toEqual([])
})

test('multi-assignee uncertain creation retries the identical frozen array even after a later denial', async ({ page }) => {
  await ticketFixture(page, [{ error: { status: 503, message: 'Unconfirmed' }, commit: true }, { error: { status: 403, message: 'Later denied' } }])
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Issue title').fill('Frozen multi draft')
  await dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).check()
  await dialog.getByRole('checkbox', { name: 'Meera Das', exact: true }).check()
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
  for (let i = 0; i < 2; i++) {
    await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('checkbox', { name: 'Meera Das', exact: true })).toBeChecked()
    await dialog.getByRole('button', { name: 'Retry same ticket' }).click()
  }
  await expect(dialog).toBeHidden()
  const attempts = await page.evaluate(() => (window as unknown as { ticketAttempts: { assigned_to: string[] }[] }).ticketAttempts)
  expect(attempts).toHaveLength(3); expect(attempts[0].assigned_to).toEqual(['demo-tech-1', 'demo-tech-2'])
  expect(attempts[1]).toEqual(attempts[0]); expect(attempts[2]).toEqual(attempts[0])
  await expect(page.getByRole('button', { name: 'Frozen multi draft', exact: true })).toHaveCount(1)
})

test('multi-assignee detail preserves the optimistic base and checkbox draft across background refetch', async ({ page }) => {
  await ticketFixture(page)
  await page.getByRole('button', { name: 'Red LOS light on optical terminal', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).uncheck()
  await page.evaluate(() => (window as unknown as { simulateStaleUpdate(): Promise<void> }).simulateStaleUpdate())
  await expect(dialog.getByText(/This ticket has changed/)).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Meera Das', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Ticket changed')
  expect(await page.evaluate(() => (window as unknown as { ticketUpdates: object[] }).ticketUpdates)).toEqual([{ id: 'demo-t-2', version: 1, patch: { assigned_to: ['demo-tech-2'] }, note: '' }])
  await dialog.getByRole('button', { name: 'reload latest fields' }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Meera Das', exact: true })).not.toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Meera Das', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
})

test('legacy scalar assignment stays selected without spurious patches and inactive history can be removed', async ({ page }) => {
  await ticketFixture(page, [], 'office', { inactiveTechnician: true })
  await page.getByRole('button', { name: 'Frequent disconnections after maintenance', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar (inactive)', exact: true })).toBeChecked()
  await dialog.getByLabel('Add a note', { exact: false }).fill('Keep legacy history')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: object }[] }).ticketUpdates[0].patch)).toEqual({})
  await page.getByRole('button', { name: 'Red LOS light on optical terminal', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar (inactive)', exact: true })).toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Arun Kumar (inactive)', exact: true }).uncheck()
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar (inactive)', exact: true })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Arun Kumar (inactive)', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
})

test('technician sees all colleagues on a shared ticket but no assignment controls', async ({ page }) => {
  await ticketFixture(page, [], 'technician')
  await expect(page.getByRole('button', { name: 'Create ticket', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Red LOS light on optical terminal', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Assigned technicians: Arun Kumar; Meera Das', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByLabel('Add a note', { exact: false }).fill('Shared job update')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: object }[] }).ticketUpdates[0].patch)).toEqual({})
})

test('demo shared work appears for both employees but only the actual resolver receives activity credit', async ({ page }) => {
  const external = await preview(page)
  await page.getByRole('link', { name: 'Performance', exact: true }).click()
  const table = page.getByRole('table', { name: 'Employee performance', exact: true })
  const employee = (name: string) => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) })
  const before: Record<string, number> = {}
  for (const name of ['Arun Kumar', 'Meera Das']) {
    before[name] = Number(await employee(name).getByRole('cell').nth(7).innerText())
    await expect(employee(name).getByRole('cell').nth(3)).toHaveText('0')
  }
  await page.getByRole('link', { name: 'Tickets', exact: true }).click()
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Issue title').fill('Shared workload acceptance')
  await dialog.getByRole('checkbox', { name: 'Arun Kumar', exact: true }).check()
  await dialog.getByRole('checkbox', { name: 'Meera Das', exact: true }).check()
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: 'Performance', exact: true }).click()
  for (const name of ['Arun Kumar', 'Meera Das']) await expect(employee(name).getByRole('cell').nth(7)).toHaveText(String(before[name] + 1))
  await page.getByRole('link', { name: 'Tickets', exact: true }).click()
  await page.getByRole('button', { name: 'Shared workload acceptance', exact: true }).click()
  await dialog.getByLabel('Ticket status').selectOption('resolved')
  await dialog.getByLabel('Resolution note', { exact: false }).fill('Owner verified service by phone')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: 'Performance', exact: true }).click()
  for (const name of ['Arun Kumar', 'Meera Das']) {
    await expect(employee(name).getByRole('cell').nth(7)).toHaveText(String(before[name]))
    await expect(employee(name).getByRole('cell').nth(3)).toHaveText('0')
  }
  await expect(employee('Ananya Rao').getByRole('cell').nth(3)).toHaveText('1')
  expect(external).toEqual([])
})

for (const mobile of [false, true]) {
  for (const emptyCompany of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} creates, edits and resolves an unlinked ticket${emptyCompany ? ' in an empty live-mode company fixture' : ' in demo'}`, async ({ page }) => {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      const external = await ticketFixture(page, [], 'office', { emptyCompany, demo: !emptyCompany })
      const title = 'Manual service complaint'
      const dialog = page.getByRole('dialog')
      await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
      const connection = dialog.getByRole('combobox', { name: 'Connection', exact: true })
      await expect(connection).toHaveValue('')
      await expect(connection).not.toHaveAttribute('required', '')
      await expect(connection.locator('option:checked')).toHaveText('No connection (optional)')
      await expect(connection).toHaveAccessibleDescription(/optional.*manually/)
      if (emptyCompany) await expect(connection.locator('option')).toHaveCount(1)
      // Keep the default blank selection: no customer or connection is needed.
      await dialog.getByLabel('Issue title').fill(title)
      await dialog.getByLabel('Details', { exact: true }).fill('Caller gave contact details manually')
      await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
      await expect(dialog).toBeHidden()
      expect(await page.evaluate(() => (window as unknown as { ticketAttempts: { connection_id: string | null }[] }).ticketAttempts)).toEqual([expect.objectContaining({ connection_id: null })])
      await page.getByLabel('Search tickets').fill(title)
      const row = mobile ? page.locator('.job-card').filter({ hasText: title }) : page.getByRole('row').filter({ hasText: title })
      await expect(row.getByText('No connection linked', { exact: true })).toBeVisible()
      await expect(row.locator('.ticket-reference')).not.toContainText('·')
      if (mobile) await expect(row.locator('p')).toHaveText('No connection linked')
      else await expect(row.locator('.cell-secondary')).toHaveText('No connection linked')
      const open = () => page.getByRole('button', { name: title, exact: true }).click()
      const save = () => dialog.getByRole('button', { name: 'Save changes' }).click()
      await open()
      await expect(dialog.locator('.detail-customer')).toContainText('No connection linked')
      await expect(dialog.locator('.detail-customer')).not.toContainText('·')
      await expect(dialog.getByText(/Fictional contact/)).toHaveCount(0)
      await expect(dialog.locator('a[href^="tel:"], a[href*="google.com/maps"]')).toHaveCount(0)
      await expect(dialog.getByRole('combobox', { name: 'Connection', exact: true })).toHaveCount(0)
      const outage = dialog.getByRole('combobox', { name: 'Linked outage', exact: true })
      await expect(outage).toBeDisabled()
      await expect(outage).toHaveValue('')
      await expect(outage.locator('option')).toHaveCount(1)
      await expect(outage).toHaveAccessibleDescription('An outage can only be linked to a ticket with a connection.')
      await dialog.getByRole('textbox', { name: 'Details', exact: true }).fill('Caller confirmed a router restart is needed')
      await dialog.getByLabel('Add a note', { exact: false }).fill('Manual callback arranged')
      await save()
      await expect(dialog).toBeHidden()
      await open()
      await expect(dialog.getByRole('textbox', { name: 'Details', exact: true })).toHaveValue('Caller confirmed a router restart is needed')
      await expect(dialog.locator('.timeline')).toContainText('Manual callback arranged')
      await dialog.getByLabel('Ticket status').selectOption('resolved')
      await dialog.getByLabel('Resolution note', { exact: false }).fill('Caller confirmed service after restart')
      await save()
      await expect(dialog).toBeHidden()
      await page.getByRole('tab', { name: /^Resolved/ }).click()
      await expect(row.getByText('No connection linked', { exact: true })).toBeVisible()
      await open()
      await expect(dialog.getByLabel('Ticket status')).toHaveValue('resolved')
      await expect(dialog.getByLabel('Resolution note', { exact: false })).toHaveValue('Caller confirmed service after restart')
      await expect(dialog.getByText('No connection linked', { exact: true })).toBeVisible()
      await expect(outage).toBeDisabled()
      await expect(dialog.locator('a[href^="tel:"], a[href*="google.com/maps"]')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(external).toEqual([])
    })
  }
}

test('office demo creates a phone fix, resolves, closes and reopens without a technician', async ({ page }) => {
  const external = await ticketFixture(page)
  const title = 'Office phone-fixed complaint'
  const dialog = page.getByRole('dialog')
  await fillComplaint(page, title)
  await expect(dialog).toBeHidden()
  const open = () => page.getByRole('button', { name: title, exact: true }).click()
  const save = () => dialog.getByRole('button', { name: 'Save changes' }).click()
  await open()
  await expect(dialog.getByRole('group', { name: 'Assigned technicians', exact: true }).getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(dialog.getByLabel('Ticket status').locator('option[value="closed"]')).toHaveCount(0)
  await dialog.getByLabel('Ticket status').selectOption('resolved')
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveCount(0)
  const resolution = dialog.getByLabel('Resolution note', { exact: false })
  await expect(resolution).toHaveAttribute('required', '')
  await save()
  await expect(dialog).toBeVisible()
  await resolution.fill('   ')
  await save()
  await expect(dialog.getByRole('alert')).toContainText('resolution note is required')
  const fix = 'Phone-guided router restart; customer verified service'
  await resolution.fill(fix)
  await save()
  await expect(dialog).toBeHidden()
  await page.getByRole('tab', { name: /^Resolved/ }).click()
  await open()
  await expect(resolution).toHaveValue(fix)
  await dialog.getByLabel('Ticket status').selectOption('closed')
  const feedback = dialog.getByLabel('Customer feedback', { exact: true })
  await expect(feedback).toHaveAttribute('required', '')
  await save()
  await expect(dialog).toBeVisible()
  await feedback.fill(' \n ')
  await save()
  await expect(dialog.getByRole('alert')).toContainText('Customer feedback is required')
  await feedback.fill('Customer confirmed stable service during office callback')
  await resolution.fill(' ')
  await save()
  await expect(dialog.getByRole('alert')).toContainText('resolution note is required')
  await resolution.fill(fix)
  await save()
  await expect(dialog).toBeHidden()
  await open()
  await expect(dialog.getByLabel('Ticket status')).toHaveValue('closed')
  await expect(feedback).toHaveValue('Customer confirmed stable service during office callback')
  await expect(feedback).toHaveAttribute('readonly', '')
  await expect(dialog.getByLabel('Ticket status').locator('option[value="resolved"]')).toHaveCount(0)
  await dialog.getByLabel('Ticket status').selectOption('new')
  await expect(resolution).toHaveValue('')
  await expect(feedback).toHaveValue('')
  await expect(feedback).toHaveAttribute('readonly', '')
  await dialog.getByLabel('Add a note', { exact: false }).fill('Customer reports recurrence')
  await save()
  await expect(dialog).toBeHidden()
  await page.getByRole('tab', { name: /^All open/ }).click()
  await open()
  await expect(dialog.getByLabel('Ticket status')).toHaveValue('new')
  await expect(resolution).toHaveValue('')
  await expect(dialog.locator('.timeline')).toContainText(fix)
  await expect(dialog.locator('.timeline')).toContainText('Customer reports recurrence')
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Ticket status').selectOption('resolved')
  await resolution.fill('Second repair completed')
  await save()
  await expect(dialog).toBeHidden()
  await page.getByRole('tab', { name: /^Awaiting feedback/ }).click()
  await open()
  await expect(feedback).toHaveValue('')
  await dialog.getByLabel('Ticket status').selectOption('closed')
  await feedback.fill(' ')
  await save()
  await expect(dialog.getByRole('alert')).toContainText('Customer feedback is required')
  const updates = await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: Record<string, unknown> }[] }).ticketUpdates)
  expect(updates.filter(u => ['new', 'resolved'].includes(String(u.patch.status))).every(u => !('customer_feedback' in u.patch))).toBe(true)
  expect(external).toEqual([])
})

test('office demo requires a new note for customer and provider wait transitions', async ({ page }) => {
  const external = await ticketFixture(page)
  const title = 'No internet since this morning'
  const dialog = page.getByRole('dialog')
  for (const status of ['waiting_customer', 'waiting_provider']) {
    await page.getByRole('button', { name: title, exact: true }).click()
    await dialog.getByLabel('Ticket status').selectOption(status)
    const note = dialog.getByLabel('Add a note', { exact: false })
    await expect(note).toHaveAttribute('required', '')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeVisible()
    await note.fill(' \n ')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog.getByRole('alert')).toContainText('waiting reason')
    await note.fill(`Reason for ${status}`)
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
  }
  await page.getByRole('button', { name: title, exact: true }).click()
  await expect(dialog.locator('.timeline')).toContainText('Reason for waiting_customer')
  await expect(dialog.locator('.timeline')).toContainText('Reason for waiting_provider')
  await expect(dialog.getByLabel('Add a note', { exact: false })).not.toHaveAttribute('required', '')
  // Editing metadata in an existing wait does not require another waiting reason.
  await dialog.getByLabel('Provider reference').fill('DEMO-WAIT')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  expect(external).toEqual([])
})

for (const code of ['23514', '42501']) {
  test(`creation rejection ${code} unlocks fields while preserving the ticket UUID`, async ({ page }) => {
    const external = await ticketFixture(page, [{ error: { code, message: 'Rejected test draft' } }])
    await fillComplaint(page, 'Original draft')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByLabel('Issue title')).toBeEnabled()
    await dialog.getByLabel('Issue title').fill('Corrected draft')
    await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click()
    await expect(dialog).toBeHidden()
    const attempts = await page.evaluate(() => (window as unknown as { ticketAttempts: { id: string; title: string }[] }).ticketAttempts)
    expect(attempts).toHaveLength(2)
    expect(attempts[0].id).toBe(attempts[1].id)
    expect(attempts.map(a => a.title)).toEqual(['Original draft', 'Corrected draft'])
    await expect(page.getByRole('button', { name: 'Corrected draft', exact: true })).toBeVisible()
    expect(external).toEqual([])
  })
}

for (const error of [{ message: 'Failed to fetch' }, { status: 503, message: 'Service unavailable' }]) {
  test(`uncertain creation ${error.message} preserves the frozen draft through retries`, async ({ page }) => {
    const external = await ticketFixture(page, [{ error, commit: true }, { error: { code: '42501', message: 'Later denial cannot rule out the original commit' } }])
    await fillComplaint(page, 'Lost response complaint')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByLabel('Issue title')).toBeDisabled()
    await dialog.getByRole('button', { name: 'Retry same ticket' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Later denial')
    await expect(dialog.getByLabel('Issue title')).toBeDisabled()
    await dialog.getByRole('button', { name: 'Retry same ticket' }).click()
    await expect(dialog).toBeHidden()
    const attempts = await page.evaluate(() => (window as unknown as { ticketAttempts: object[] }).ticketAttempts)
    expect(attempts).toHaveLength(3)
    expect(attempts[1]).toEqual(attempts[0]); expect(attempts[2]).toEqual(attempts[0])
    await expect(page.getByRole('button', { name: 'Lost response complaint', exact: true })).toHaveCount(1)
    expect(external).toEqual([])
  })
}

test('technician closed-ticket resolution is read-only and cannot close or reopen', async ({ page }) => {
  const external = await ticketFixture(page, [], 'technician')
  await page.getByRole('tab', { name: /^Resolved/ }).click()
  await page.getByRole('button', { name: 'Replace damaged fibre patch cord', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Ticket status')).toBeDisabled()
  await expect(dialog.getByLabel('Resolution note', { exact: false })).toHaveAttribute('readonly', '')
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveAttribute('readonly', '')
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveValue(/Fictional customer/)
  await dialog.getByLabel('Add a note', { exact: false }).fill('Technician added an archive note')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: object }[] }).ticketUpdates.map(u => u.patch))).toEqual([{}])
  expect(external).toEqual([])
})

test('technician resolves, office captures feedback without closing, then closes from the awaiting-feedback queue', async ({ page }) => {
  const external = await ticketFixture(page, [], 'technician')
  const title = 'Red LOS light on optical terminal'
  const dialog = page.getByRole('dialog')
  const open = () => page.getByRole('button', { name: title, exact: true }).click()
  const save = () => dialog.getByRole('button', { name: 'Save changes' }).click()
  await open()
  await expect(dialog.getByLabel('Ticket status').locator('option[value="closed"]')).toHaveCount(0)
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Ticket status').selectOption('resolved')
  await dialog.getByLabel('Resolution note', { exact: false }).fill('Repaired fibre and checked optical levels')
  await save()
  await expect(dialog).toBeHidden()
  await page.getByRole('tab', { name: /^Awaiting feedback/ }).click()
  await expect(page.getByRole('tab', { name: /^Awaiting feedback/ })).toHaveText('Awaiting feedback2')
  await expect(page.getByText(/Resolved tickets: pending customer feedback/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace damaged fibre patch cord', exact: true })).toHaveCount(0)
  await open()
  await expect(dialog.getByLabel('Ticket status')).toBeDisabled()
  await expect(dialog.getByText(/Repair handed off/)).toBeVisible()
  await expect(dialog.getByLabel('Customer feedback', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('Add a note', { exact: false }).fill('Ready for office callback')
  await save()
  await expect(dialog).toBeHidden()
  await page.evaluate(() => (window as unknown as { setFixtureRole(role: string): void }).setFixtureRole('office'))
  await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible()
  await open()
  const feedback = dialog.getByLabel('Customer feedback', { exact: true })
  await expect(feedback).toHaveValue('')
  await expect(feedback).not.toHaveAttribute('required', '')
  await feedback.fill('Customer confirms the connection is stable after repair.')
  await save()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: /^Awaiting feedback/ })).toHaveText('Awaiting feedback2')
  await open()
  await expect(dialog.getByLabel('Ticket status')).toHaveValue('resolved')
  await expect(feedback).toHaveValue('Customer confirms the connection is stable after repair.')
  // An abandoned reopen clears the visible draft, then restores the saved values on cancellation.
  await dialog.getByLabel('Ticket status').selectOption('assigned')
  await expect(feedback).toHaveValue('')
  await expect(feedback).toHaveAttribute('readonly', '')
  await dialog.getByLabel('Ticket status').selectOption('resolved')
  await expect(feedback).toHaveValue('Customer confirms the connection is stable after repair.')
  await dialog.getByLabel('Ticket status').selectOption('closed')
  await save()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: /^Awaiting feedback/ })).toHaveText('Awaiting feedback1')
  await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: /^Resolved/ }).click()
  await open()
  await expect(dialog.getByLabel('Ticket status')).toHaveValue('closed')
  await expect(feedback).toHaveAttribute('readonly', '')
  const updates = await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: object }[] }).ticketUpdates.map(u => u.patch))
  expect(updates).toEqual([
    { status: 'resolved', resolution: 'Repaired fibre and checked optical levels' }, {},
    { customer_feedback: 'Customer confirms the connection is stable after repair.' }, { status: 'closed' },
  ])
  expect(external).toEqual([])
})

for (const legacyFeedback of ['missing', 'null'] as const) {
  test(`legacy ${legacyFeedback} feedback displays empty and notes do not fabricate feedback`, async ({ page }) => {
    const external = await ticketFixture(page, [], 'office', { legacyFeedback })
    const dialog = page.getByRole('dialog')
    await page.getByRole('tab', { name: /^Resolved/ }).click()
    for (const title of ['Replace damaged fibre patch cord', 'Connection drops during video calls']) {
      await page.getByRole('button', { name: title, exact: true }).click()
      const feedback = dialog.getByLabel('Customer feedback', { exact: true })
      await expect(feedback).toHaveValue('')
      if (title.startsWith('Replace')) await expect(feedback).toHaveAttribute('readonly', '')
      else {
        // Even an explicit empty editor value must compare equal to missing/null base feedback.
        await feedback.fill('Temporary draft')
        await feedback.fill('')
      }
      await dialog.getByLabel('Add a note', { exact: false }).fill('Historical follow-up note')
      await dialog.getByRole('button', { name: 'Save changes' }).click()
      await expect(dialog).toBeHidden()
      await page.getByRole('button', { name: title, exact: true }).click()
      await expect(dialog.locator('.timeline')).toContainText('Historical follow-up note')
      await expect(feedback).toHaveValue('')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    expect(await page.evaluate(() => (window as unknown as { ticketUpdates: { patch: object }[] }).ticketUpdates.map(u => u.patch))).toEqual([{}, {}])
    expect(external).toEqual([])
  })
}

test('demo customer creation is searchable and CSV validates duplicates', async ({ page }) => {
  const external = await preview(page)
  await page.getByRole('link', { name: 'Customers', exact: true }).click()
  await page.getByRole('button', { name: 'Add customer', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full name').fill('Fictional New Customer')
  await dialog.getByLabel('Phone', { exact: true }).fill('0000000099')
  await dialog.getByLabel('Area', { exact: true }).fill('Example area')
  await dialog.getByLabel('Address', { exact: true }).fill('99 Example Road, Fictional Town')
  await dialog.getByLabel('Account number').fill('DEMO-E2E-99')
  await dialog.getByRole('button', { name: 'Create customer' }).click()
  await expect(dialog).toBeHidden()
  await page.getByLabel('Search customers').fill('DEMO-E2E-99')
  await expect(page.getByRole('cell', { name: 'Fictional New Customer' })).toBeVisible()
  await page.getByRole('button', { name: 'Import CSV' }).click()
  await dialog.getByLabel('Customer CSV').setInputFiles({ name: 'fictional.csv', mimeType: 'text/csv', buffer: Buffer.from('full_name,phone,address,area,provider_id,account_number,network_node\nFictional CSV,0000000000,Example Road,Example area,niss,DEMO-E2E-99,\n') })
  await expect(dialog.getByText(/Duplicate provider\/account/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Import 0 valid rows' })).toBeDisabled()
  expect(external).toEqual([])
})

test('restoring an outage does not resolve its linked ticket', async ({ page }) => {
  await preview(page)
  await page.getByRole('link', { name: 'Outages', exact: true }).click()
  await page.getByRole('button', { name: 'Mark restored' }).click()
  await page.getByRole('button', { name: 'Confirm restored' }).click()
  await expect(page.getByRole('heading', { name: 'No active outages' })).toBeVisible()
  await page.getByRole('tab', { name: /^Restored/ }).click()
  await expect(page.getByRole('heading', { name: /Upstream fibre maintenance/ })).toBeVisible()
  await page.getByRole('link', { name: 'Tickets', exact: true }).click()
  await page.getByRole('tab', { name: /Waiting for provider/ }).click()
  await expect(page.getByRole('button', { name: 'Frequent disconnections after maintenance', exact: true })).toBeVisible()
})

test('owner demo team create, change role, toggle access and reset password', async ({ page }) => {
  await preview(page)
  await page.getByRole('link', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Add staff' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full name').fill('Fictional Test Staff')
  await dialog.getByLabel('Email', { exact: true }).fill('fictional@example.test')
  await dialog.getByLabel('Temporary password', { exact: false }).fill('fictional-test-password')
  await dialog.getByRole('button', { name: 'Create staff' }).click()
  await expect(dialog).toBeHidden()
  const row = page.getByRole('row').filter({ hasText: 'Fictional Test Staff' })
  await row.getByRole('button', { name: 'Change role' }).click()
  await dialog.getByLabel('New staff role').selectOption('office')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(row.getByRole('cell', { name: 'Office', exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Activate', exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Reset password' }).click()
  await dialog.getByLabel('Temporary password', { exact: false }).fill('another-fictional-password')
  await dialog.getByRole('button', { name: 'Reset password', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText('Change required')
})

test('mobile shows job cards, working navigation and usable ticket details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const external = await preview(page)
  await expect(page.locator('.job-cards')).toBeVisible()
  await expect(page.locator('.desktop-table')).toBeHidden()
  await page.getByRole('button', { name: 'No internet since this morning', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.getByRole('link', { name: 'Reports', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(external).toEqual([])
})

test('demo resets on reload and never persists operational records', async ({ page }) => {
  await preview(page)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Preview demo', exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain('niss-auth')
})