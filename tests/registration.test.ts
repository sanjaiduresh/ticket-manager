import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerOwner, registrationSchema } from '../src/lib/registration'
import { CompanyWorkspaceError, liveApi, NoStaffProfileError } from '../src/lib/data'

const input = { company_name: ' Fictional Networks ', full_name: ' Fictional Owner ', email: ' OWNER@example.test ', password: 'FAKE-password-for-tests-123', confirm_password: 'FAKE-password-for-tests-123' }
const respond = (data: unknown, status = 200) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(data), { status }))
afterEach(() => vi.restoreAllMocks())

describe('owner registration validation', () => {
  it('normalizes identity fields but preserves password whitespace', () => {
    const password = ` ${input.password} `
    expect(registrationSchema.parse({ ...input, password, confirm_password: password })).toEqual({ ...input, company_name: 'Fictional Networks', full_name: 'Fictional Owner', email: 'owner@example.test', password, confirm_password: password })
  })
  it.each([undefined, '', '   ', '\0Company', 'a'.repeat(201)])('requires valid company name %j', company_name => {
    expect(registrationSchema.safeParse({ ...input, company_name }).success).toBe(false)
  })
  it.each(['', '   ', '\0Owner', 'a'.repeat(201)])('requires valid owner name %j', full_name => {
    expect(registrationSchema.safeParse({ ...input, full_name }).success).toBe(false)
  })
  it('counts Unicode characters and allows independent owner mailboxes', () => {
    expect(registrationSchema.parse({ ...input, company_name: '😀'.repeat(200), full_name: '😀'.repeat(200), email: 'another@independent.example' }).email).toBe('another@independent.example')
  })
  it.each(['bad', 'owner@localhost', 'a'.repeat(250) + '@x.test'])('rejects invalid email %j', email => {
    expect(registrationSchema.safeParse({ ...input, email }).success).toBe(false)
  })
  it.each([
    ['a'.repeat(11), false], ['a'.repeat(12), true], ['😀'.repeat(6), false], ['😀'.repeat(12), true],
    ['😀'.repeat(64), true], ['😀'.repeat(65), false], ['a'.repeat(256), true], ['a'.repeat(257), false], ['valid-password\0', false],
  ])('enforces Unicode and UTF-8 password limits (%#)', (password, valid) => {
    expect(registrationSchema.safeParse({ ...input, password, confirm_password: password }).success).toBe(valid)
  })
  it('attaches confirmation mismatch to its field and drops unknown input', () => {
    const result = registrationSchema.safeParse({ ...input, confirm_password: 'different' })
    if (result.success) throw new Error('Expected validation failure')
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['confirm_password'], message: 'Passwords do not match.' }))
    expect(registrationSchema.parse({ ...input, role: 'owner', setup_code: 'obsolete' })).not.toHaveProperty('role')
  })
})

describe('immediate company registration REST request', () => {
  it('sends exactly four allowed fields once, without signing in or storing a session', async () => {
    const fetch = respond({ ok: true, email: 'owner@example.test' }, 201)
    await expect(registerOwner({ ...input, role: 'owner', setup_code: 'obsolete' } as typeof input)).resolves.toEqual({ email: 'owner@example.test' })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/register', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ company_name: 'Fictional Networks', full_name: 'Fictional Owner', email: 'owner@example.test', password: input.password }) }))
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).has('Authorization')).toBe(false)
  })
  it('does not request on validation failure', async () => {
    const fetch = respond({})
    await expect(registerOwner({ ...input, confirm_password: '' })).rejects.toThrow('Passwords do not match.')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([null, {}, { ok: false }, { ok: true }, { ok: true, email: 42 }, { ok: true, email: 'other@example.test' }])('treats malformed success as uncertain without retry (%#)', async data => {
    const fetch = respond(data)
    await expect(registerOwner(input)).rejects.toThrow('Sign in before retrying')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([400, 401, 403, 409, 422, 429])('preserves safe HTTP %i errors and never auto-retries', async status => {
    const fetch = respond({ error: 'Company creation rejected. Contact your administrator.' }, status)
    await expect(registerOwner(input)).rejects.toMatchObject({ status, message: 'Company creation rejected. Contact your administrator.' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('handles uncertain server and network errors without raw error content', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(input.password)).mockResolvedValueOnce(new Response('<html>private</html>', { status: 503 }))
    for (let i = 0; i < 2; i++) await expect(registerOwner(input)).rejects.toThrow('Sign in before retrying')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('current staff profile gate', () => {
  const profile = { id: 'user', company_id: 'company', full_name: 'Owner', role: 'owner', active: true, must_change_password: false }
  it('distinguishes an empty profile without offering completion', async () => {
    respond(null)
    await expect(liveApi.profile('user')).rejects.toBeInstanceOf(NoStaffProfileError)
  })
  it.each([undefined, null, '', '   '])('rejects malformed company membership %j', async company_id => {
    respond({ ...profile, company_id })
    await expect(liveApi.profile('user')).rejects.toBeInstanceOf(CompanyWorkspaceError)
  })
  it('uses current cookie identity, never a client profile ID in the URL', async () => {
    const fetch = respond(profile); const signal = new AbortController().signal
    await expect(liveApi.profile('user', signal)).resolves.toEqual(profile)
    expect(fetch.mock.lastCall).toEqual(['/api/profile', expect.objectContaining({ signal })])
  })
  it('rejects a changed cookie identity before loading a workspace', async () => {
    respond({ ...profile, id: 'other-user' })
    await expect(liveApi.profile('user')).rejects.toThrow('account changed')
  })
  it.each([{ role: 'unexpected' }, { active: undefined }, { must_change_password: undefined }])('fails closed for malformed access flags %j', async patch => {
    respond({ ...profile, ...patch })
    await expect(liveApi.profile('user')).rejects.toThrow('Staff access could not be verified')
  })
  it.each([401, 403, 404, 500])('preserves HTTP %i failures instead of offering enrollment', async status => {
    respond({ error: 'Lookup failed' }, status)
    await expect(liveApi.profile('user')).rejects.toMatchObject({ status, message: 'Lookup failed' })
  })
})