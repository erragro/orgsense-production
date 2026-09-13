/**
 * auth.store.ts
 *
 * Security note: Tokens are stored in HttpOnly cookies set by the backend.
 * The frontend Zustand store holds ONLY the user profile object.
 * This eliminates XSS-accessible token storage in localStorage.
 *
 * The persisted store key 'kk_auth' now only persists the user object.
 * Tokens are sent automatically by the browser via cookies on every request
 * when `credentials: 'include'` is set on the Axios clients.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UserPermissions {
  view: boolean
  edit: boolean
  admin: boolean
}

export interface User {
  id: number
  email: string
  full_name: string
  avatar_url?: string | null
  is_super_admin: boolean
  permissions: Record<string, UserPermissions>
}

interface AuthStore {
  user: User | null
  // Legacy token fields — kept for API response compatibility during
  // HttpOnly cookie migration. Not persisted to localStorage.
  accessToken: string | null
  refreshToken: string | null
  setAuth: (accessToken: string, refreshToken: string, user: User) => void
  setAccessToken: (token: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,   // not persisted — kept in memory only
      refreshToken: null,  // not persisted — cookie is authoritative
      setAuth: (_accessToken, _refreshToken, user) => set({ user }),
      setAccessToken: (_token) => set({}), // no-op: cookie is authoritative
      logout: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    {
      name: 'kk_auth',
      // Only persist the user profile — never persist tokens to localStorage
      partialize: (state) => ({ user: state.user }),
    }
  )
)
