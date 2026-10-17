export interface Session { user: { id: string; email: string } }
export const sessionHintKey = 'dsa-session-present'
export function hasSavedSession(): boolean {
  try { return localStorage.getItem(sessionHintKey) === 'true' } catch { return false }
}
export function saveSessionHint(present: boolean) {
  try {
    // Discard the retired browser-token store; never migrate its credentials.
    localStorage.removeItem('niss-auth')
    if (present) localStorage.setItem(sessionHintKey, 'true')
    else localStorage.removeItem(sessionHintKey)
  } catch { /* Storage may be disabled; this tab's cookie session still works. */ }
}
export function clearLegacyAuth() {
  try { localStorage.removeItem('niss-auth') } catch { /* Storage unavailable. */ }
}