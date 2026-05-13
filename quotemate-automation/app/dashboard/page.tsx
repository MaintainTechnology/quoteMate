// /dashboard — Tradie portal. Maintain design system.
//
// Tabbed single-page app: Overview / Account / Pricing / Services / Quotes.
// Fetches everything from /api/tenant/me, posts updates back via PATCH.
//
// Client component start to finish — we want immediate optimistic feedback
// when the tradie toggles a service or saves pricing. Server-side rendering
// would force a round-trip on every save which is a worse UX.

'use client'

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { ErrorBanner, Field, INPUT } from '../signup/page'

// ─── Types ────────────────────────────────────────────────────────

type Tenant = {
  id: string
  owner_user_id: string
  business_name: string
  owner_first_name: string | null
  owner_email: string | null
  owner_mobile: string | null
  trade: 'electrical' | 'plumbing'
  state: string | null
  abn: string | null
  licence_type: string | null
  licence_number: string | null
  licence_expiry: string | null
  twilio_sms_number: string | null
  twilio_voice_number: string | null
  vapi_assistant_id: string | null
  vapi_voice_persona: string | null
  status: 'onboarding' | 'active'
  created_at: string
  activated_at: string | null
}

type Pricing = {
  tenant_id: string
  hourly_rate: number | null
  call_out_minimum: number | null
  default_markup_pct: number | null
  apprentice_rate: number | null
  senior_rate: number | null
  after_hours_multiplier: number | null
  min_labour_hours: number | null
  risk_buffer_pct: number | null
  gst_registered: boolean | null
} | null

type ServiceOffering = {
  assembly_id: string
  enabled: boolean
  name: string
  description: string | null
  trade: string
  default_unit: string | null
  default_unit_price_ex_gst: number | string | null
  default_labour_hours: number | string | null
  default_exclusions: string | null
}

type Quote = {
  id: string
  created_at: string
  status: string
  selected_tier: string | null
  total_inc_gst: number | string | null
  scope_of_works: string | null
  share_token: string | null
  needs_inspection: boolean | null
  routing_decision: string | null
  customer_first_name: string | null
  customer_phone: string | null
}

type DashboardData = {
  tenant: Tenant
  pricing: Pricing
  services: ServiceOffering[]
  quotes: Quote[]
}

type Tab = 'overview' | 'account' | 'pricing' | 'services' | 'quotes'

// ─── Page ─────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  // On mount: confirm we have a session, then load the dashboard payload.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = getBrowserSupabase()
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token ?? null
      if (!token) {
        // Not signed in → bounce to /signin.
        router.replace('/signin')
        return
      }
      if (cancelled) return
      setAccessToken(token)
      await refresh(token)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(token: string) {
    setLoadError(null)
    try {
      const res = await fetch('/api/tenant/me', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (res.status === 404) {
        // Authed but no tenant row yet → finish onboarding wizard.
        router.replace('/onboard')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Load failed (HTTP ${res.status})`)
      }
      const json = (await res.json()) as DashboardData
      setData(json)
    } catch (err: any) {
      setLoadError(err?.message ?? 'Failed to load dashboard')
    }
  }

  async function patch(payload: Record<string, unknown>) {
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch('/api/tenant/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(
        Array.isArray(body?.errors)
          ? body.errors.join(' · ')
          : body?.error ?? `Save failed (HTTP ${res.status})`,
      )
    }
    // Re-fetch to confirm what landed.
    await refresh(accessToken)
  }

  async function signOut() {
    const supabase = getBrowserSupabase()
    await supabase.auth.signOut()
    router.replace('/signin')
  }

  if (loadError) {
    return (
      <Shell businessName={null} onSignOut={signOut}>
        <div className="max-w-xl">
          <ErrorBanner>{loadError}</ErrorBanner>
          <button
            onClick={() => accessToken && refresh(accessToken)}
            className="mt-4 inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider"
          >
            Try again
          </button>
        </div>
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell businessName={null} onSignOut={signOut}>
        <div className="font-mono text-xs uppercase tracking-[0.16em] text-text-dim">
          Loading your portal…
        </div>
      </Shell>
    )
  }

  return (
    <Shell businessName={data.tenant.business_name} onSignOut={signOut}>
      {/* Hero / status row */}
      <header className="flex flex-wrap items-end justify-between gap-4 pb-8 border-b border-ink-line">
        <div>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-text-dim">
            QuoteMate · Portal
          </span>
          <h1 className="mt-2 font-extrabold uppercase text-[clamp(1.75rem,4vw,2.5rem)] leading-[1] tracking-[-0.03em]">
            G&rsquo;day{' '}
            <span className="text-accent">
              {data.tenant.owner_first_name || 'tradie'}
            </span>
            .
          </h1>
          <p className="mt-2 text-text-sec text-sm">
            {data.tenant.business_name} · {tradeLabel(data.tenant.trade)} ·{' '}
            {data.tenant.state ?? '—'}
          </p>
        </div>
        <StatusBadge status={data.tenant.status} />
      </header>

      {/* Tab nav */}
      <nav className="mt-8 flex flex-wrap gap-1 border-b border-ink-line">
        {(['overview', 'account', 'pricing', 'services', 'quotes'] as const).map(
          (t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-3 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold transition-colors ${
                tab === t
                  ? 'text-accent border-b-2 border-accent -mb-px'
                  : 'text-text-dim hover:text-text-pri'
              }`}
            >
              {tabLabel(t)}
              {t === 'quotes' && data.quotes.length > 0 && (
                <span className="ml-2 text-text-sec">({data.quotes.length})</span>
              )}
            </button>
          ),
        )}
      </nav>

      {/* Tab content */}
      <section className="mt-8 pb-20">
        {tab === 'overview' && <OverviewTab data={data} />}
        {tab === 'account' && <AccountTab data={data} onSave={patch} />}
        {tab === 'pricing' && <PricingTab data={data} onSave={patch} />}
        {tab === 'services' && <ServicesTab data={data} onSave={patch} />}
        {tab === 'quotes' && <QuotesTab data={data} />}
      </section>
    </Shell>
  )
}

// ─── Shell + Status badge ─────────────────────────────────────────

function Shell({
  businessName,
  onSignOut,
  children,
}: {
  businessName: string | null
  onSignOut: () => void
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-ink-deep text-text-pri flex flex-col">
      <nav className="border-b border-ink-line bg-ink-deep sticky top-0 z-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="flex items-center gap-3">
            <span className="grid h-7 w-7 place-items-center bg-accent font-black text-white text-xs">
              Q
            </span>
            <span className="font-extrabold uppercase tracking-tight text-text-pri">
              QuoteMate
            </span>
            {businessName && (
              <>
                <span className="text-text-dim">/</span>
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-text-sec">
                  {businessName}
                </span>
              </>
            )}
          </Link>
          <button
            onClick={onSignOut}
            className="text-sm font-semibold uppercase tracking-wider text-text-sec hover:text-text-pri transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="flex-1 mx-auto w-full max-w-5xl px-6 py-10">
        {children}
      </div>
    </main>
  )
}

function StatusBadge({ status }: { status: 'onboarding' | 'active' }) {
  const isActive = status === 'active'
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-3 py-1.5 border ${
        isActive
          ? 'text-emerald-300 border-emerald-700/60 bg-emerald-950/30'
          : 'text-amber-300 border-amber-700/60 bg-amber-950/30'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isActive ? 'bg-emerald-300' : 'bg-amber-300'
        }`}
      />
      {isActive ? 'Active' : 'Onboarding'}
    </span>
  )
}

// ─── Overview tab ─────────────────────────────────────────────────

function OverviewTab({ data }: { data: DashboardData }) {
  const enabledServices = data.services.filter((s) => s.enabled).length
  const totalServices = data.services.length
  const activeQuotes = data.quotes.length
  const draftQuotes = data.quotes.filter((q) =>
    ['drafted', 'awaiting_review', 'review'].includes(q.status),
  ).length

  const tenant = data.tenant
  const smsNumber = tenant.twilio_sms_number
  const voiceNumber = tenant.twilio_voice_number ?? smsNumber
  const assistantId = tenant.vapi_assistant_id

  // Stub detection — the activate route returns deterministic
  // placeholders when *_PROVISIONING_ENABLED env flags are off. We
  // surface this clearly so the tradie (and you, debugging) know
  // whether a real Twilio purchase happened.
  const isStubTwilio = !!smsNumber && /^\+614820\d{5}$/.test(smsNumber)
  const isStubVapi = !!assistantId && assistantId.startsWith('vapi-stub-')
  const needsProvisioning = !smsNumber || !assistantId

  return (
    <div className="space-y-8">
      {/* HERO — your QuoteMate number, big and proud */}
      <div className="bg-ink-card border border-ink-line p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-text-dim">
              Your QuoteMate number
            </div>
            {smsNumber ? (
              <div className="mt-3 font-mono text-[clamp(1.5rem,4vw,2.5rem)] font-bold text-text-pri tracking-tight leading-none">
                {formatAuMobile(smsNumber)}
              </div>
            ) : (
              <div className="mt-3 text-amber-300">
                Provisioning didn&rsquo;t finish on activate. Hit retry — your
                account + pricing book are already saved, only the Twilio +
                Vapi half needs to re-run.
              </div>
            )}
            <p className="mt-3 text-sm text-text-sec max-w-md">
              Customer SMS lands at <span className="font-mono">/api/sms/inbound</span> →
              your pricing book. Customer calls land at Vapi → your AI assistant.
            </p>
            {needsProvisioning && <RetryProvisionButton />}
          </div>
          <div className="flex flex-col items-end gap-2">
            <Pill
              tone={needsProvisioning ? 'warn' : isStubTwilio ? 'warn' : 'ok'}
              label={
                needsProvisioning
                  ? 'PENDING · Provisioning incomplete'
                  : isStubTwilio
                    ? 'STUB · Twilio provisioning OFF'
                    : 'LIVE · Real Twilio number'
              }
            />
            {tenant.activated_at && (
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim">
                Activated {formatDate(tenant.activated_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Channel breakdown */}
      <Grid cols={3}>
        <Kpi
          label="SMS inbound"
          value={smsNumber ? formatAuMobile(smsNumber) : '—'}
          mono
        />
        <Kpi
          label="Voice inbound"
          value={voiceNumber ? formatAuMobile(voiceNumber) : '—'}
          mono
        />
        <Kpi
          label="AI assistant"
          value={
            assistantId
              ? isStubVapi
                ? 'Stub'
                : 'Live'
              : 'Not yet'
          }
        />
      </Grid>

      {/* Quotes / services KPIs */}
      <Grid cols={3}>
        <Kpi label="Auto-quote services" value={`${enabledServices} / ${totalServices}`} />
        <Kpi label="Quotes recorded" value={String(activeQuotes)} />
        <Kpi label="In review" value={String(draftQuotes)} />
      </Grid>

      {/* AI Receptionist — detailed setup card */}
      <Card title="AI receptionist setup" subtitle="The technical bits Vapi + Twilio need to route real customers.">
        <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <Row label="Twilio SMS number" value={smsNumber ?? null} mono />
          <Row label="Twilio Voice number" value={voiceNumber ?? null} mono />
          <Row label="Vapi assistant ID" value={assistantId ?? null} mono breakAll />
          <Row label="Voice persona" value={tenant.vapi_voice_persona ?? 'Default'} />
          <Row label="SMS webhook" value={`${appUrl()}/api/sms/inbound`} mono />
          <Row label="Voice webhook" value="api.vapi.ai/twilio/inbound_call" mono />
          <Row label="Status" value={tenant.status === 'active' ? 'Active' : 'Onboarding'} />
          <Row
            label="Provisioning mode"
            value={
              isStubTwilio && isStubVapi
                ? 'Stub (test mode)'
                : isStubTwilio
                  ? 'Twilio stub · Vapi real'
                  : isStubVapi
                    ? 'Twilio real · Vapi stub'
                    : 'Real (live)'
            }
          />
        </dl>
        {(isStubTwilio || isStubVapi) && (
          <div className="mt-6 bg-amber-950/30 border border-amber-700/50 px-4 py-3">
            <p className="text-sm text-amber-200">
              <strong>Test mode active.</strong> Fund your Twilio account and flip{' '}
              <span className="font-mono">TWILIO_PROVISIONING_ENABLED=true</span> +{' '}
              <span className="font-mono">VAPI_PROVISIONING_ENABLED=true</span> on Vercel,
              then re-activate to swap in real Twilio + Vapi resources.
            </p>
          </div>
        )}
      </Card>

      {/* Wired-up checklist (existing) */}
      <Card title="What's wired up">
        <ul className="space-y-2 text-sm text-text-sec">
          <Tick on={!!tenant.business_name}>Business identity saved</Tick>
          <Tick on={!!data.pricing?.hourly_rate}>Pricing book in place</Tick>
          <Tick on={enabledServices > 0}>
            {enabledServices} of {totalServices} auto-quote services enabled
          </Tick>
          <Tick on={!!smsNumber}>
            QuoteMate phone number assigned
            {isStubTwilio && <span className="text-amber-300"> (stub)</span>}
          </Tick>
          <Tick on={!!assistantId}>
            AI receptionist active
            {isStubVapi && <span className="text-amber-300"> (stub)</span>}
          </Tick>
        </ul>
      </Card>
    </div>
  )
}

function RetryProvisionButton() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setErr(null)
    try {
      const supabase = getBrowserSupabase()
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) throw new Error('not signed in')
      const res = await fetch('/api/onboard/retry-provision', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json().catch(() => ({}))
      if (!body.ok) {
        throw new Error(body.error ?? `retry failed (HTTP ${res.status})`)
      }
      // Number assigned — reload so the dashboard reflects the new state.
      window.location.reload()
    } catch (e: any) {
      setErr(e?.message ?? 'Retry failed')
      setBusy(false)
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
      >
        {busy ? 'Retrying…' : 'Retry provisioning'}
      </button>
      {err && (
        <p className="mt-2 text-xs text-amber-300 max-w-md">{err}</p>
      )}
    </div>
  )
}

function Pill({ tone, label }: { tone: 'ok' | 'warn' | 'dim'; label: string }) {
  const cls =
    tone === 'ok'
      ? 'text-emerald-300 border-emerald-700/60 bg-emerald-950/30'
      : tone === 'warn'
        ? 'text-amber-300 border-amber-700/60 bg-amber-950/30'
        : 'text-text-dim border-ink-line bg-ink-card'
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.16em] font-bold px-3 py-1.5 border ${cls}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          tone === 'ok'
            ? 'bg-emerald-300'
            : tone === 'warn'
              ? 'bg-amber-300'
              : 'bg-text-dim'
        }`}
      />
      {label}
    </span>
  )
}

function Row({
  label,
  value,
  mono,
  breakAll,
}: {
  label: string
  value: string | null
  mono?: boolean
  breakAll?: boolean
}) {
  return (
    <div>
      <dt className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        {label}
      </dt>
      <dd
        className={`mt-1 ${mono ? 'font-mono' : ''} ${
          breakAll ? 'break-all' : ''
        } text-text-pri text-sm ${value ? '' : 'text-text-dim italic'}`}
      >
        {value || '—'}
      </dd>
    </div>
  )
}

function appUrl(): string {
  if (typeof window !== 'undefined') return window.location.origin
  return 'https://quote-mate-rho.vercel.app'
}

function formatAuMobile(e164: string): string {
  const cleaned = e164.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+61') && cleaned.length === 12) {
    return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6, 9)} ${cleaned.slice(9, 12)}`
  }
  return e164
}

function Kpi({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="bg-ink-card border border-ink-line p-5">
      <div className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-2 text-text-pri font-bold text-lg ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Tick({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3">
      <span
        className={`font-mono text-xs ${
          on ? 'text-emerald-400' : 'text-text-dim'
        }`}
      >
        {on ? '✓' : '○'}
      </span>
      <span className={on ? 'text-text-sec' : 'text-text-dim'}>{children}</span>
    </li>
  )
}

// ─── Account tab ──────────────────────────────────────────────────

function AccountTab({
  data,
  onSave,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [form, setForm] = useState({
    business_name: data.tenant.business_name ?? '',
    owner_first_name: data.tenant.owner_first_name ?? '',
    owner_email: data.tenant.owner_email ?? '',
    owner_mobile: data.tenant.owner_mobile ?? '',
    trade: data.tenant.trade,
    state: data.tenant.state ?? '',
    abn: data.tenant.abn ?? '',
    licence_type: data.tenant.licence_type ?? '',
    licence_number: data.tenant.licence_number ?? '',
    licence_expiry: data.tenant.licence_expiry ?? '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await onSave({ tenant: form })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="Account details"
      subtitle="What customers see on quotes, where the regulator finds you."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid md:grid-cols-2 gap-5">
          <Field label="Business name">
            <input
              type="text"
              value={form.business_name}
              onChange={(e) => setForm({ ...form, business_name: e.target.value })}
              className={INPUT}
              required
            />
          </Field>
          <Field label="Your first name">
            <input
              type="text"
              value={form.owner_first_name}
              onChange={(e) => setForm({ ...form, owner_first_name: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={form.owner_email}
              onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Mobile">
            <input
              type="tel"
              value={form.owner_mobile}
              onChange={(e) => setForm({ ...form, owner_mobile: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Trade">
            <select
              value={form.trade}
              onChange={(e) => setForm({ ...form, trade: e.target.value as 'electrical' | 'plumbing' })}
              className={INPUT}
            >
              <option value="electrical">Electrical</option>
              <option value="plumbing">Plumbing</option>
            </select>
          </Field>
          <Field label="State">
            <select
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
              className={INPUT}
            >
              <option value="">Select state</option>
              {['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ABN">
            <input
              type="text"
              value={form.abn}
              onChange={(e) => setForm({ ...form, abn: e.target.value })}
              className={INPUT}
              maxLength={20}
            />
          </Field>
          <Field label="Licence number">
            <input
              type="text"
              value={form.licence_number}
              onChange={(e) => setForm({ ...form, licence_number: e.target.value })}
              className={INPUT}
              maxLength={40}
            />
          </Field>
          <Field label="Licence type">
            <input
              type="text"
              value={form.licence_type}
              onChange={(e) => setForm({ ...form, licence_type: e.target.value })}
              className={INPUT}
              maxLength={20}
              placeholder="e.g. NECA NSW"
            />
          </Field>
          <Field label="Licence expiry">
            <input
              type="date"
              value={form.licence_expiry}
              onChange={(e) => setForm({ ...form, licence_expiry: e.target.value })}
              className={INPUT}
            />
          </Field>
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div className="flex items-center justify-between pt-2">
          <SaveHint savedAt={savedAt} />
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save account'}
          </button>
        </div>
      </form>
    </Card>
  )
}

// ─── Pricing tab ──────────────────────────────────────────────────

function PricingTab({
  data,
  onSave,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const initial = useMemo(
    () => ({
      hourly_rate: numString(data.pricing?.hourly_rate),
      call_out_minimum: numString(data.pricing?.call_out_minimum),
      default_markup_pct: numString(data.pricing?.default_markup_pct),
      apprentice_rate: numString(data.pricing?.apprentice_rate),
      senior_rate: numString(data.pricing?.senior_rate),
      after_hours_multiplier: numString(data.pricing?.after_hours_multiplier),
      min_labour_hours: numString(data.pricing?.min_labour_hours),
      risk_buffer_pct: numString(data.pricing?.risk_buffer_pct),
      gst_registered: data.pricing?.gst_registered ?? false,
    }),
    [data.pricing],
  )
  const [form, setForm] = useState(initial)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'boolean') payload[k] = v
        else if (v !== '') payload[k] = Number(v)
      }
      await onSave({ pricing: payload })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="Pricing book"
      subtitle="Every quote your AI drafts pulls from these numbers. Update any time."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid md:grid-cols-3 gap-5">
          <Field label="Hourly rate" hint="$AUD ex GST">
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.hourly_rate}
              onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })}
              className={INPUT}
              required
            />
          </Field>
          <Field label="Callout minimum" hint="$AUD ex GST">
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.call_out_minimum}
              onChange={(e) => setForm({ ...form, call_out_minimum: e.target.value })}
              className={INPUT}
            />
          </Field>
          <Field label="Default markup" hint="0–100 %">
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={form.default_markup_pct}
              onChange={(e) => setForm({ ...form, default_markup_pct: e.target.value })}
              className={INPUT}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-sm font-mono uppercase tracking-[0.14em] text-text-sec hover:text-text-pri"
        >
          {showAdvanced ? '− Hide advanced' : '+ Show advanced'}
        </button>

        {showAdvanced && (
          <div className="grid md:grid-cols-3 gap-5 pt-2 border-t border-ink-line">
            <Field label="Apprentice rate" hint="$AUD ex GST">
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.apprentice_rate}
                onChange={(e) => setForm({ ...form, apprentice_rate: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="Senior rate" hint="$AUD ex GST">
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.senior_rate}
                onChange={(e) => setForm({ ...form, senior_rate: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="After-hours multiplier" hint="1.0–3.0">
              <input
                type="number"
                step="0.1"
                min="1"
                max="3"
                value={form.after_hours_multiplier}
                onChange={(e) => setForm({ ...form, after_hours_multiplier: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="Min labour hours">
              <input
                type="number"
                step="0.5"
                min="0"
                max="8"
                value={form.min_labour_hours}
                onChange={(e) => setForm({ ...form, min_labour_hours: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="Risk buffer" hint="0–100 %">
              <input
                type="number"
                step="0.5"
                min="0"
                max="100"
                value={form.risk_buffer_pct}
                onChange={(e) => setForm({ ...form, risk_buffer_pct: e.target.value })}
                className={INPUT}
              />
            </Field>
            <Field label="GST registered">
              <label className="inline-flex items-center gap-3 mt-2">
                <input
                  type="checkbox"
                  checked={form.gst_registered}
                  onChange={(e) => setForm({ ...form, gst_registered: e.target.checked })}
                  className="h-5 w-5 accent-accent"
                />
                <span className="text-sm text-text-sec">Yes, I&rsquo;m GST registered</span>
              </label>
            </Field>
          </div>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div className="flex items-center justify-between pt-2">
          <SaveHint savedAt={savedAt} />
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save pricing'}
          </button>
        </div>
      </form>
    </Card>
  )
}

// ─── Services tab ─────────────────────────────────────────────────

function ServicesTab({
  data,
  onSave,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const dirty = Object.keys(pending).length > 0

  function toggle(assemblyId: string, current: boolean) {
    setPending((prev) => {
      const next = { ...prev }
      if (next[assemblyId] !== undefined) {
        // Already toggled in this session → revert removes it from pending
        if (next[assemblyId] !== current) {
          delete next[assemblyId]
        } else {
          next[assemblyId] = !current
        }
      } else {
        next[assemblyId] = !current
      }
      return next
    })
  }

  async function saveAll() {
    setError(null)
    setBusy(true)
    try {
      await onSave({ services: pending })
      setPending({})
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const enabledCount = data.services.filter((s) => {
    const live = pending[s.assembly_id] !== undefined ? pending[s.assembly_id] : s.enabled
    return live
  }).length
  const totalCount = data.services.length

  return (
    <div className="space-y-6">
      <Card
        title="Auto-quote services"
        subtitle={`Tick the work your AI can auto-quote. Unticked services still get inspections — they just won't auto-draft a price. ${enabledCount} of ${totalCount} enabled.`}
      >
        <div className="space-y-2">
          {data.services.length === 0 ? (
            <div className="bg-amber-950/30 border border-amber-700/50 px-4 py-3">
              <p className="text-sm text-amber-200">
                No services found in the catalogue for{' '}
                <span className="font-mono">{data.tenant.trade}</span>. This usually
                means the seed data hasn&rsquo;t loaded — check the Supabase{' '}
                <span className="font-mono">shared_assemblies</span> table.
              </p>
            </div>
          ) : (
            data.services.map((svc) => {
              const live =
                pending[svc.assembly_id] !== undefined
                  ? pending[svc.assembly_id]
                  : svc.enabled
              const price = toNum(svc.default_unit_price_ex_gst)
              const hours = toNum(svc.default_labour_hours)
              return (
                <button
                  key={svc.assembly_id}
                  type="button"
                  onClick={() => toggle(svc.assembly_id, svc.enabled)}
                  className={`w-full flex items-start justify-between gap-4 px-4 py-3.5 border transition-colors text-left ${
                    live
                      ? 'border-accent/70 bg-accent/5 text-text-pri'
                      : 'border-ink-line bg-ink-card text-text-sec hover:border-ink-line/70'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm">{svc.name}</div>
                    {svc.description && (
                      <div className="mt-1 text-xs text-text-sec leading-snug">
                        {svc.description}
                      </div>
                    )}
                    <div className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {price !== null && (
                        <span>
                          ${price.toFixed(2)} {svc.default_unit ? `/ ${svc.default_unit}` : ''}
                        </span>
                      )}
                      {hours !== null && hours > 0 && <span>{hours}h labour</span>}
                      <span className="text-text-dim/70">{svc.trade}</span>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 inline-flex items-center font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-3 py-1 ${
                      live ? 'text-accent' : 'text-text-dim'
                    }`}
                  >
                    {live ? '● Enabled' : '○ Off'}
                  </span>
                </button>
              )
            })
          )}
        </div>

        {error && (
          <div className="mt-4">
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <SaveHint savedAt={savedAt} />
          <button
            type="button"
            onClick={saveAll}
            disabled={busy || !dirty}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy
              ? 'Saving…'
              : dirty
                ? `Save ${Object.keys(pending).length} change(s)`
                : 'No changes'}
          </button>
        </div>
      </Card>

      {/* Inspection-only educational footer */}
      <Card title="Always require a site visit" subtitle="These jobs route to a $199 paid inspection regardless of toggles above. Your AI tells the customer up front.">
        <ul className="grid sm:grid-cols-2 gap-2 text-sm">
          {(data.tenant.trade === 'plumbing'
            ? PLUMBING_INSPECTION_ONLY
            : ELECTRICAL_INSPECTION_ONLY
          ).map((item) => (
            <li
              key={item}
              className="flex items-baseline gap-3 text-text-sec border border-ink-line bg-ink-card px-3.5 py-2.5"
            >
              <span className="font-mono text-xs text-accent">!</span>
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-text-dim">
          These are out-of-scope for SMS auto-quote in v1. Need to handle one yourself?
          The customer&rsquo;s details are still captured in the dialog — you take it from
          there after the site visit fee is paid.
        </p>
      </Card>
    </div>
  )
}

const ELECTRICAL_INSPECTION_ONLY = [
  'Switchboard upgrade or repair',
  'Fault finding',
  'EV charger install',
  'Underground cabling',
  'Whole-house renovation rewires',
]

const PLUMBING_INSPECTION_ONLY = [
  'Gas fitting',
  'Burst pipe repair',
  'Bathroom renovation',
  'CCTV drain inspection',
  'Pressure reduction valve install',
]

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

// ─── Quotes tab ───────────────────────────────────────────────────

function QuotesTab({ data }: { data: DashboardData }) {
  if (data.quotes.length === 0) {
    return (
      <Card title="Quotes">
        <p className="text-sm text-text-dim">
          No quotes drafted yet. Customers texting your QuoteMate number will appear here once their first quote is drafted.
        </p>
      </Card>
    )
  }
  return (
    <Card title="Quotes" subtitle="Last 20 drafted by your AI. Tap to view the full customer page.">
      <div className="overflow-x-auto -mx-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-line text-left font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
              <th className="px-6 py-3">Drafted</th>
              <th className="px-6 py-3">Customer</th>
              <th className="px-6 py-3">Status</th>
              <th className="px-6 py-3 text-right">Total</th>
              <th className="px-6 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {data.quotes.map((q) => {
              const total = pickTierTotal(q)
              const url = q.share_token ? `/q/${q.share_token}` : null
              return (
                <tr key={q.id} className="border-b border-ink-line/60">
                  <td className="px-6 py-3 font-mono text-xs text-text-sec whitespace-nowrap">
                    {formatDate(q.created_at)}
                  </td>
                  <td className="px-6 py-3">
                    {q.customer_first_name ?? '—'}
                    {q.customer_phone && (
                      <span className="block font-mono text-[0.65rem] text-text-dim">
                        {q.customer_phone}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-sec">
                      {q.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-text-pri">
                    {total !== null ? `$${formatMoney(total)}` : '—'}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {url ? (
                      <Link
                        href={url}
                        className="text-accent hover:text-accent-press font-semibold text-xs uppercase tracking-wider"
                        target="_blank"
                      >
                        View
                      </Link>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ─── Shared UI primitives ─────────────────────────────────────────

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="bg-ink-card border border-ink-line">
      <div className="px-6 py-5 border-b border-ink-line">
        <h2 className="font-extrabold uppercase text-base tracking-[-0.01em] text-text-pri">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1.5 text-text-sec text-sm">{subtitle}</p>
        )}
      </div>
      <div className="px-6 py-6">{children}</div>
    </div>
  )
}

function Grid({ cols, children }: { cols: number; children: ReactNode }) {
  const gridClass =
    cols === 3
      ? 'grid grid-cols-1 sm:grid-cols-3 gap-4'
      : 'grid grid-cols-1 sm:grid-cols-2 gap-4'
  return <div className={gridClass}>{children}</div>
}

function SaveHint({ savedAt }: { savedAt: number | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setShow(true)
    const t = setTimeout(() => setShow(false), 3000)
    return () => clearTimeout(t)
  }, [savedAt])
  if (!show) return <span />
  return (
    <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-emerald-400">
      ✓ Saved
    </span>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────

function tradeLabel(t: 'electrical' | 'plumbing'): string {
  return t === 'electrical' ? 'Electrical' : 'Plumbing'
}

function tabLabel(t: Tab): string {
  switch (t) {
    case 'overview':
      return 'Overview'
    case 'account':
      return 'Account'
    case 'pricing':
      return 'Pricing'
    case 'services':
      return 'Services'
    case 'quotes':
      return 'Quotes'
  }
}

function numString(v: number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

function pickTierTotal(q: Quote): number | null {
  // total_inc_gst is already computed off the selected tier server-side
  // in /api/estimate/draft. Numeric Postgres columns sometimes deserialise
  // as strings depending on the client config — coerce defensively.
  if (q.total_inc_gst === null || q.total_inc_gst === undefined) return null
  const n =
    typeof q.total_inc_gst === 'string'
      ? parseFloat(q.total_inc_gst)
      : q.total_inc_gst
  return Number.isFinite(n) ? n : null
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
    })
  } catch {
    return iso
  }
}
