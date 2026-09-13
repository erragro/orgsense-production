/**
 * interceptors.ts
 *
 * Axios interceptors for governance and ingest API clients.
 *
 * Security: tokens are stored in HttpOnly cookies — the browser sends
 * them automatically on every request when `withCredentials: true` is set
 * on the Axios instance. We no longer read tokens from localStorage.
 *
 * Token refresh: on 401 the interceptor calls /auth/refresh, which:
 *   - reads the refresh token from the HttpOnly kk_refresh cookie
 *   - sets a new access token cookie (kk_access)
 *   - returns a new access_token in the JSON body (for Bearer header use)
 *
 * The Authorization: Bearer header is still sent for services that
 * cannot read HttpOnly cookies (e.g. WebSocket, external APIs).
 * It is populated from the in-memory access token returned by /auth/refresh.
 */

import { ingestClient, governanceClient } from './clients'
import { useAuthStore } from '@/stores/auth.store'

let isRefreshing = false
let refreshSubscribers: Array<(token: string) => void> = []

// In-memory access token (NOT in localStorage — only in memory for this session)
let _inMemoryAccessToken: string | null = null

function onRefreshed(token: string) {
  refreshSubscribers.forEach((cb) => cb(token))
  refreshSubscribers = []
}

function handleUnauthorized() {
  _inMemoryAccessToken = null
  useAuthStore.getState().logout()
  window.location.href = '/login'
}

async function tryRefresh(): Promise<string | null> {
  try {
    // The HttpOnly refresh cookie is sent automatically via withCredentials
    const res = await governanceClient.post<{ access_token: string; refresh_token: string }>(
      '/auth/refresh',
      {},
    )
    const { access_token } = res.data
    _inMemoryAccessToken = access_token
    return access_token
  } catch {
    return null
  }
}

// ─── Governance client interceptors ───────────────────────────────────────

governanceClient.interceptors.request.use((config) => {
  // Send Bearer token from memory if available (supplements HttpOnly cookie)
  if (_inMemoryAccessToken) {
    config.headers['Authorization'] = `Bearer ${_inMemoryAccessToken}`
  }
  return config
})

governanceClient.interceptors.response.use(
  (res) => {
    // Capture access token from login/refresh responses into memory
    if (res.data?.access_token) {
      _inMemoryAccessToken = res.data.access_token
    }
    return res
  },
  async (error) => {
    const originalRequest = error.config
    if (error.response?.status === 401 && !originalRequest._retry) {
      // Skip refresh for auth endpoints to avoid infinite loops
      if (originalRequest.url?.includes('/auth/')) {
        handleUnauthorized()
        return Promise.reject(error)
      }

      originalRequest._retry = true

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshSubscribers.push((token) => {
            originalRequest.headers['Authorization'] = `Bearer ${token}`
            resolve(governanceClient(originalRequest))
          })
          setTimeout(() => reject(error), 10_000)
        })
      }

      isRefreshing = true
      try {
        const newToken = await tryRefresh()
        if (newToken) {
          onRefreshed(newToken)
          originalRequest.headers['Authorization'] = `Bearer ${newToken}`
          return governanceClient(originalRequest)
        } else {
          handleUnauthorized()
          return Promise.reject(error)
        }
      } finally {
        isRefreshing = false
      }
    }
    return Promise.reject(error)
  }
)

// ─── Ingest client interceptors ───────────────────────────────────────────

ingestClient.interceptors.request.use((config) => {
  if (_inMemoryAccessToken) {
    config.headers['Authorization'] = `Bearer ${_inMemoryAccessToken}`
  }
  return config
})

ingestClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) handleUnauthorized()
    return Promise.reject(error)
  }
)

/**
 * Returns the current in-memory access token.
 * Use this in native fetch / SSE calls that bypass the axios interceptor
 * (e.g. BI Agent and QA Agent streaming endpoints).
 * Returns null until the first successful login or token refresh.
 */
export function getAccessToken(): string | null {
  return _inMemoryAccessToken
}
