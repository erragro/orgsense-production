/**
 * OAuthCallbackPage.tsx
 *
 * Security: OAuth tokens are no longer passed via URL query parameters
 * (prevents token exposure in browser history, referer headers, server logs).
 *
 * Instead, the backend sets HttpOnly cookies on the redirect and this page
 * simply calls /auth/me to fetch the user profile using the cookie.
 * If the cookie was not set (OAuth failed), the ?error param will be present.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth.store'
import { authApi } from '@/api/governance/auth.api'
import { Spinner } from '@/components/ui/Spinner'

export default function OAuthCallbackPage() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [error, setError] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('error')

    if (oauthError) {
      setError(`OAuth login failed: ${oauthError}`)
      return
    }

    // Tokens are in HttpOnly cookies — just fetch the user profile
    ;(async () => {
      try {
        const res = await authApi.me()
        // setAuth with empty token strings — cookie is the authoritative source
        setAuth('', '', res.data)
        // Clean up URL to remove any query params
        window.history.replaceState({}, '', '/auth/callback')
        navigate('/dashboard', { replace: true })
      } catch {
        setError('OAuth login failed. Please try logging in again.')
      }
    })()
  }, [navigate, setAuth])

  if (error) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-red-400 font-medium mb-4">{error}</p>
          <a href="/login" className="text-brand-400 hover:text-brand-300 text-sm">
            Back to login
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Spinner size="lg" />
        <p className="text-muted text-sm">Completing sign in…</p>
      </div>
    </div>
  )
}
