import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth.store'
import { authApi } from '@/api/governance/auth.api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export default function SignupPage() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [consentGiven, setConsentGiven] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!fullName.trim() || !email.trim() || !password) {
      setError('All fields are required')
      return
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (!consentGiven) {
      setError('You must consent to data processing to create an account (DPDP Act §6)')
      return
    }

    setLoading(true)
    try {
      const res = await authApi.signup(email.trim(), password, fullName.trim(), consentGiven)
      const { access_token, refresh_token, user } = res.data
      setAuth(access_token, refresh_token, user)
      navigate('/dashboard', { replace: true })
    } catch (err: unknown) {
      const axiosError = err as { response?: { status: number; data?: { detail?: string } } }
      if (axiosError.response?.status === 409) {
        setError('An account with this email already exists.')
      } else {
        setError(axiosError.response?.data?.detail ?? 'Sign up failed. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-brand-600 flex items-center justify-center mb-4 shadow-lg shadow-brand-600/20">
            <span className="text-white text-2xl font-bold">KK</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Auralis</h1>
          <p className="text-muted text-sm mt-1">CX Operations Platform</p>
        </div>

        {/* Sign-up card */}
        <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-xl">
          <h2 className="text-base font-semibold text-foreground mb-5">Create your account</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Full Name"
              type="text"
              id="fullName"
              placeholder="Jane Smith"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
              autoFocus
            />
            <Input
              label="Email"
              type="email"
              id="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <Input
              label="Password"
              type="password"
              id="password"
              placeholder="Min. 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <Input
              label="Confirm Password"
              type="password"
              id="confirmPassword"
              placeholder="Re-enter password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={error}
              autoComplete="new-password"
            />

            {/* DPDP Act §6 — Explicit consent checkbox */}
            <div className="flex items-start gap-3 mt-2">
              <input
                type="checkbox"
                id="consent"
                checked={consentGiven}
                onChange={(e) => setConsentGiven(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-surface-border accent-brand-600 cursor-pointer"
              />
              <label htmlFor="consent" className="text-xs text-muted leading-relaxed cursor-pointer">
                I consent to Auralis processing my personal data for account management and
                service delivery as described in the{' '}
                <Link to="/privacy" className="text-brand-400 hover:text-brand-300 underline" target="_blank">
                  Privacy Policy
                </Link>{' '}
                (required under DPDP Act §6)
              </label>
            </div>

            <Button
              type="submit"
              className="w-full mt-2"
              loading={loading}
              disabled={!fullName.trim() || !email.trim() || !password || !confirmPassword || !consentGiven}
            >
              Create Account
            </Button>
          </form>

          <div className="mt-4 p-3 bg-surface rounded-md border border-surface-border">
            <p className="text-xs text-subtle">
              New accounts receive <span className="text-muted font-medium">viewer</span> access by default.
              An administrator can grant additional permissions.
            </p>
          </div>

          <p className="text-center text-sm text-muted mt-5">
            Already have an account?{' '}
            <Link to="/login" className="text-brand-400 hover:text-brand-300 font-medium">
              Sign in
            </Link>
          </p>
        </div>

        <p className="text-center text-xs text-subtle mt-6">
          Auralis · CX Operations Platform
        </p>
      </div>
    </div>
  )
}
