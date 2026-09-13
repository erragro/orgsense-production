import { governanceClient } from '../clients'
import type { User } from '@/stores/auth.store'

interface TokenResponse {
  access_token: string
  refresh_token: string
  user: User
}

export const authApi = {
  login: (email: string, password: string) =>
    governanceClient.post<TokenResponse>('/auth/login', { email, password }),

  signup: (email: string, password: string, full_name: string, consent_given = false) =>
    governanceClient.post<TokenResponse>('/auth/signup', { email, password, full_name, consent_given }),

  // Refresh reads from HttpOnly cookie automatically; no body needed
  refresh: () =>
    governanceClient.post<{ access_token: string; refresh_token: string }>('/auth/refresh', {}),

  // Logout: cookie cleared server-side; no body needed
  logout: () =>
    governanceClient.post('/auth/logout', {}),

  me: () =>
    governanceClient.get<User>('/auth/me'),
}
