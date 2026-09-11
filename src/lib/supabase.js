// Minimal Supabase client built on plain fetch -- Manifest V3 extensions
// can't load remotely-hosted/bundled scripts, so rather than vendoring the
// full supabase-js library this talks directly to Supabase's REST (PostgREST),
// Auth (GoTrue), and Edge Function HTTP APIs.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const SESSION_KEY = 'eha_session'

async function getStoredSession() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY)
  return session ?? null
}

async function storeSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session })
}

export async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY)
}

export async function signIn(email, password) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error_description || data.msg || 'Sign in failed')
  await storeSession(data)
  return data
}

export async function signOut() {
  const session = await getStoredSession()
  if (session?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {})
  }
  await clearSession()
}

async function refreshSession(refreshToken) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error('Session expired, please sign in again')
  await storeSession(data)
  return data
}

// Returns a valid access token, refreshing if the stored one is expired.
export async function getAccessToken() {
  const session = await getStoredSession()
  if (!session) return null
  const expiresAtMs = (session.expires_at ?? 0) * 1000
  if (Date.now() > expiresAtMs - 30_000) {
    const refreshed = await refreshSession(session.refresh_token)
    return refreshed.access_token
  }
  return session.access_token
}

export async function getCurrentUser() {
  const session = await getStoredSession()
  return session?.user ?? null
}

async function authedFetch(path, options = {}) {
  const token = await getAccessToken()
  if (!token) throw new Error('Not signed in')
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body.message || body.error || `Request failed (${resp.status})`)
  }
  return resp.status === 204 ? null : resp.json()
}

export const rest = {
  select: (table, query = '') => authedFetch(`/rest/v1/${table}?${query}`),
  insert: (table, rows) =>
    authedFetch(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    }),
  update: (table, query, patch) =>
    authedFetch(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }),
}

export function callFunction(name, payload) {
  return authedFetch(`/functions/v1/${name}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
