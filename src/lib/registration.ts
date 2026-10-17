import { z } from 'zod'
import { apiRequest, ApiError } from './http'

const encoder = new TextEncoder()
export const registrationSchema = z.object({
  company_name: z.string().trim().refine(value => !!value && [...value].length <= 200 && !value.includes('\0'), 'Enter your company name (1–200 characters).'),
  full_name: z.string().trim().refine(value => !!value && [...value].length <= 200 && !value.includes('\0'), 'Enter your full name (1–200 characters).'),
  email: z.string().trim().toLowerCase().max(254, 'Email must be at most 254 characters.').pipe(z.email('Enter a valid email address.')),
  password: z.string().refine(value => !value.includes('\0') && [...value].length >= 12 && encoder.encode(value).length <= 256, 'Use at least 12 Unicode characters and at most 256 UTF-8 bytes, without NUL characters.'),
  confirm_password: z.string(),
}).refine(value => value.password === value.confirm_password, { message: 'Passwords do not match.', path: ['confirm_password'] })

export type RegistrationInput = z.input<typeof registrationSchema>
const uncertain = 'Company creation could not be confirmed. Sign in before retrying; ask your administrator to reconcile the account if needed.'

/** One explicit attempt only: no role selection, confirmation flow or auto-login. */
export async function registerOwner(input: RegistrationInput): Promise<{ email: string }> {
  const { company_name, full_name, email, password } = registrationSchema.parse(input)
  try {
    const result = await apiRequest<{ ok: boolean; email: string }>('/api/auth/register', { method: 'POST', body: { company_name, full_name, email, password } })
    if (!result || result.ok !== true || result.email !== email) throw new Error(uncertain)
    return { email: result.email }
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error
    throw new Error(uncertain)
  }
}