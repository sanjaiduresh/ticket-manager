export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type RequestOptions = Omit<RequestInit, 'body' | 'credentials'> & { body?: unknown }

/** The browser owns no bearer token. The server authenticates its HTTPOnly cookie. */
export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!/^\/api\/[a-zA-Z0-9/_%-]+(?:\?[^#]*)?$/.test(path) || /%2f|%5c|\.\./i.test(path)) throw new Error('Invalid API path.')
  const { body, headers: supplied, ...options } = opts
  const headers = new Headers(supplied)
  headers.set('Accept', 'application/json')
  const multipart = body instanceof FormData
  if (multipart) headers.delete('Content-Type')
  else if (body !== undefined) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) })
  } catch (error) {
    if (opts.signal?.aborted) throw error
    throw new Error('Unable to reach the service. The result is unconfirmed; check your connection before retrying.')
  }
  const data: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Request failed (${response.status}). Please try again or contact your administrator.`
    throw new ApiError(message, response.status)
  }
  if (response.status === 204) return undefined as T
  if (data === undefined) throw new Error('The service response could not be confirmed. Check the result before retrying.')
  return data as T
}