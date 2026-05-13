// /signin — Maintain design system. Returning-tradie login.

'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { AuthShell, Field, INPUT, ErrorBanner, Arrow } from '../signup/page'

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const supabase = getBrowserSupabase()
      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      })
      if (authErr) throw authErr
      if (!authData.user || !authData.session) throw new Error('Sign in returned no user')

      // Look up the tenant via the server-side endpoint so the read uses
      // the service role (same as the dashboard). A browser-side
      // `from('tenants').select()` here returns silently-empty when RLS is
      // enabled on the table — the symptom is that a returning tradie
      // who finished onboarding still gets bounced to /onboard.
      const meRes = await fetch('/api/tenant/me', {
        headers: { Authorization: `Bearer ${authData.session.access_token}` },
        cache: 'no-store',
      })

      // Routing rules:
      //   • 404 (no tenant row yet) → start onboarding wizard.
      //   • Tenant exists           → dashboard, regardless of status.
      //
      // We deliberately do NOT route status='onboarding' back to the
      // wizard. A tenant in that state means activation persisted the
      // form data but provisioning (Twilio/Vapi) failed mid-chain. The
      // tradie should NOT be asked to refill the wizard — their data is
      // safe in the DB. The dashboard surfaces a "retry provisioning"
      // affordance for stuck tenants.
      if (meRes.status === 404) {
        router.push(`/onboard?owner_user_id=${authData.user.id}`)
        return
      }
      if (!meRes.ok) {
        const body = await meRes.json().catch(() => ({}))
        throw new Error(body?.error ?? `Tenant lookup failed (HTTP ${meRes.status})`)
      }
      router.push('/dashboard')
    } catch (err: any) {
      setError(err?.message ?? 'Sign in failed')
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title={<>Welcome <span className="text-accent">back</span></>}
      subtitle="Sign in to manage your pricing, view quotes, and check on your AI receptionist."
      footer={
        <>
          New here?{' '}
          <Link href="/signup" className="text-accent hover:text-accent-press font-semibold">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com.au"
            className={INPUT}
            required
            autoComplete="email"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT}
            required
            autoComplete="current-password"
          />
        </Field>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-4 text-sm uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-soft focus:ring-offset-2 focus:ring-offset-ink-deep"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
          {!submitting && <Arrow />}
        </button>
      </form>
    </AuthShell>
  )
}
