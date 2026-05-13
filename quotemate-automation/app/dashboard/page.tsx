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
  trades: Array<'electrical' | 'plumbing'>
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

type TierJson = {
  subtotal_ex_gst?: number | string
  /** total_inc_gst is computed dashboard-side from subtotal_ex_gst and
   *  the quote's headline GST ratio — see deriveTierTotal in QuoteCard.
   *  The estimator currently only stores subtotal_ex_gst on the tier
   *  JSONB; GST is applied at the quote level (quotes.total_inc_gst). */
  total_inc_gst?: number | string
  label?: string
  timeframe?: string
} | null

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
  estimated_timeframe: string | null
  good: TierJson
  better: TierJson
  best: TierJson
  // Joined from intakes/payments
  customer_first_name: string | null
  customer_full_name: string | null
  customer_phone: string | null
  suburb: string | null
  job_type: string | null
  trade: string | null
  inspection_required: boolean | null
  deposit_paid: boolean
}

type PricingBook = NonNullable<Pricing> & { trade: 'electrical' | 'plumbing' }

type LicenceRow = {
  trade: 'electrical' | 'plumbing'
  licence_type: string | null
  licence_number: string | null
  licence_state: string | null
  licence_expiry: string | null
}

type DashboardData = {
  tenant: Tenant
  pricing: Pricing
  /** One row per trade for multi-trade tenants. Always present (length 1+). */
  pricing_books: PricingBook[]
  services: ServiceOffering[]
  quotes: Quote[]
  /** One row per active trade — per-trade licence storage from migration 018. */
  licences: LicenceRow[]
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

  /**
   * Reconcile the tenant's trades[] via POST /api/tenant/trades.
   * Triggers the pricing_book + service_offerings + Vapi prompt update
   * server-side and reloads the dashboard. Returns the response body so
   * the caller can show e.g. "AI receptionist updated".
   */
  async function saveTrades(trades: Array<'electrical' | 'plumbing'>) {
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch('/api/tenant/trades', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trades }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.error ?? `Trade update failed (HTTP ${res.status})`)
    }
    await refresh(accessToken)
    return body as {
      ok: true
      added: Array<'electrical' | 'plumbing'>
      removed: Array<'electrical' | 'plumbing'>
      warning?: string
      noop?: boolean
    }
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
            {data.tenant.business_name} ·{' '}
            {tenantTradesLabel(data.tenant)} · {data.tenant.state ?? '—'}
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
        {tab === 'account' && (
          <AccountTab data={data} onSave={patch} onSaveTrades={saveTrades} />
        )}
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
  onSaveTrades,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onSaveTrades: (
    trades: Array<'electrical' | 'plumbing'>,
  ) => Promise<{
    added: Array<'electrical' | 'plumbing'>
    removed: Array<'electrical' | 'plumbing'>
    warning?: string
    noop?: boolean
  }>
}) {
  const [form, setForm] = useState({
    business_name: data.tenant.business_name ?? '',
    owner_first_name: data.tenant.owner_first_name ?? '',
    owner_email: data.tenant.owner_email ?? '',
    owner_mobile: data.tenant.owner_mobile ?? '',
    state: data.tenant.state ?? '',
    abn: data.tenant.abn ?? '',
    // Note: licence_type / licence_number / licence_expiry intentionally
    // omitted from this form — they're owned by <LicencesCard> below
    // so multi-trade tenants can hold one set per trade.
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // Note: trades are managed by <TradesCard> (separate POST endpoint
      // that reconciles pricing_book + service offerings + Vapi prompt).
      // This form only handles identity / regulatory fields.
      await onSave({ tenant: form })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <TradesCard tenant={data.tenant} onSaveTrades={onSaveTrades} />

      <LicencesCard
        licences={data.licences ?? []}
        onSave={onSave}
        primaryState={data.tenant.state ?? null}
      />

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
          {/* Licence fields moved to the LicencesCard below so multi-
              trade tenants can hold one set of regulatory details per
              trade (a sparky who also plumbs has a NECA NSW number AND
              a NSW Fair Trading plumber number). */}
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
    </div>
  )
}

// ─── Licences card — one section per trade (Account tab) ─────────

function LicencesCard({
  licences,
  onSave,
  primaryState,
}: {
  licences: LicenceRow[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
  primaryState: string | null
}) {
  // Each trade's licence fields are tracked in a local map keyed by
  // trade name. Save fires a single PATCH carrying every dirty trade so
  // a multi-trade tradie can update both licences in one click.
  type LicenceForm = {
    licence_type: string
    licence_number: string
    licence_state: string
    licence_expiry: string
  }
  const initial: Record<string, LicenceForm> = useMemo(() => {
    const m: Record<string, LicenceForm> = {}
    for (const l of licences) {
      m[l.trade] = {
        licence_type: l.licence_type ?? '',
        licence_number: l.licence_number ?? '',
        licence_state: l.licence_state ?? primaryState ?? '',
        licence_expiry: l.licence_expiry ?? '',
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licences.map((l) => `${l.trade}:${l.licence_number}:${l.licence_expiry}:${l.licence_state}:${l.licence_type}`).join('|'), primaryState])

  const [form, setForm] = useState<Record<string, LicenceForm>>(initial)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Re-sync local state whenever the backing data changes (after save).
  useEffect(() => {
    setForm(initial)
  }, [initial])

  function update(trade: string, field: keyof LicenceForm, value: string) {
    setForm((f) => ({
      ...f,
      [trade]: { ...f[trade], [field]: value },
    }))
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // Build the per-trade licence payload. Empty strings stay in the
      // payload — the server's emptyToNull() normalises them to null so
      // a cleared field actually wipes the column.
      const licences_by_trade: Record<string, LicenceForm> = {}
      for (const [trade, fields] of Object.entries(form)) {
        licences_by_trade[trade] = fields
      }
      await onSave({ licences_by_trade })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (licences.length === 0) {
    return null
  }

  const isMulti = licences.length > 1
  return (
    <Card
      title={isMulti ? 'Trade licences' : 'Licence details'}
      subtitle={
        isMulti
          ? 'Each trade carries its own regulator and licence — fill in what applies. Customers see the relevant one on each quote.'
          : 'What the regulator gave you. Customers see this on quotes.'
      }
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {licences.map((l) => {
          const f = form[l.trade] ?? initial[l.trade]
          if (!f) return null
          return (
            <div key={l.trade} className="space-y-4">
              {isMulti && (
                <h3 className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent font-bold">
                  {tradeLabel(l.trade)}
                </h3>
              )}
              <div className="grid md:grid-cols-2 gap-5">
                <Field label="Licence body / type">
                  <input
                    type="text"
                    value={f.licence_type}
                    onChange={(e) => update(l.trade, 'licence_type', e.target.value)}
                    className={INPUT}
                    maxLength={40}
                    placeholder={l.trade === 'electrical' ? 'e.g. NECA NSW' : 'e.g. NSW Fair Trading'}
                  />
                </Field>
                <Field label="Licence number">
                  <input
                    type="text"
                    value={f.licence_number}
                    onChange={(e) => update(l.trade, 'licence_number', e.target.value)}
                    className={INPUT}
                    maxLength={60}
                  />
                </Field>
                <Field label="Licence state">
                  <select
                    value={f.licence_state}
                    onChange={(e) => update(l.trade, 'licence_state', e.target.value)}
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
                <Field label="Licence expiry">
                  <input
                    type="date"
                    value={f.licence_expiry}
                    onChange={(e) => update(l.trade, 'licence_expiry', e.target.value)}
                    className={INPUT}
                  />
                </Field>
              </div>
            </div>
          )
        })}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div className="flex items-center justify-between pt-2 border-t border-ink-line">
          <SaveHint savedAt={savedAt} />
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : isMulti ? 'Save licences' : 'Save licence'}
          </button>
        </div>
      </form>
    </Card>
  )
}

// ─── Trades card (sits at the top of the Account tab) ────────────

function TradesCard({
  tenant,
  onSaveTrades,
}: {
  tenant: Tenant
  onSaveTrades: (
    trades: Array<'electrical' | 'plumbing'>,
  ) => Promise<{
    added: Array<'electrical' | 'plumbing'>
    removed: Array<'electrical' | 'plumbing'>
    warning?: string
    noop?: boolean
  }>
}) {
  // The card is its own little state machine because the user can stage
  // changes locally (toggle pills), but we only fire the API on Save.
  // A confirm prompt fires when the staged set REMOVES a trade — that's
  // a destructive change worth pausing on.
  const initialTrades: Array<'electrical' | 'plumbing'> =
    Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []
  const [staged, setStaged] = useState(initialTrades)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<
    null | { trades: Array<'electrical' | 'plumbing'>; removed: Array<'electrical' | 'plumbing'> }
  >(null)

  // Keep `staged` aligned with the latest server state when the tenant
  // refetches (e.g. after a successful save).
  useEffect(() => {
    setStaged(initialTrades)
    setSuccess(null)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.trades?.join(','), tenant.trade])

  const dirty =
    staged.length !== initialTrades.length ||
    staged.some((t) => !initialTrades.includes(t)) ||
    initialTrades.some((t) => !staged.includes(t))

  function toggle(t: 'electrical' | 'plumbing') {
    setError(null)
    setSuccess(null)
    setStaged((cur) => {
      const has = cur.includes(t)
      const next = has ? cur.filter((x) => x !== t) : [...cur, t]
      // Enforce min 1 — refuse the toggle rather than going to empty.
      if (next.length === 0) return cur
      return next
    })
  }

  async function commit(trades: Array<'electrical' | 'plumbing'>) {
    setBusy(true)
    setError(null)
    setSuccess(null)
    setConfirmRemove(null)
    try {
      const res = await onSaveTrades(trades)
      const parts: string[] = []
      if (res.added.length > 0) parts.push(`Added ${res.added.join(', ')}`)
      if (res.removed.length > 0) parts.push(`Removed ${res.removed.join(', ')}`)
      if (res.warning) parts.push(res.warning)
      setSuccess(parts.join(' · ') || 'Saved')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    // Anything being removed is destructive — confirm first.
    const removed = initialTrades.filter((t) => !staged.includes(t))
    if (removed.length > 0) {
      setConfirmRemove({ trades: staged, removed })
      return
    }
    await commit(staged)
  }

  return (
    <Card
      title="Trades"
      subtitle="Add a second trade to your account, or drop one. Adding seeds the easy-5 catalogue and refreshes your AI receptionist."
    >
      <div className="grid grid-cols-2 gap-2 max-w-md">
        {(['electrical', 'plumbing'] as const).map((t) => {
          const selected = staged.includes(t)
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              disabled={busy}
              className={`px-4 py-3.5 text-sm font-semibold uppercase tracking-wider transition-colors border ${
                selected
                  ? 'border-accent bg-accent text-white'
                  : 'border-ink-line bg-ink-deep text-text-sec hover:border-accent-soft hover:text-text-pri'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {tradeLabel(t)}
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {success && !error && (
        <div className="mt-4 border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-text-pri">
          {success}
        </div>
      )}

      <div className="mt-5 flex items-center justify-between">
        <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
          Current: {initialTrades.join(' + ') || '—'}
        </p>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || busy}
          className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : 'Save trades'}
        </button>
      </div>

      {confirmRemove && (
        <ConfirmRemoveTrade
          removed={confirmRemove.removed}
          busy={busy}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => commit(confirmRemove.trades)}
        />
      )}
    </Card>
  )
}

function ConfirmRemoveTrade({
  removed,
  busy,
  onCancel,
  onConfirm,
}: {
  removed: Array<'electrical' | 'plumbing'>
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const list = removed.map((t) => tradeLabel(t)).join(' and ')
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/80 backdrop-blur-sm px-4"
    >
      <div className="w-full max-w-md bg-ink-card border border-ink-line p-6 space-y-4">
        <h3 className="font-extrabold uppercase text-lg tracking-[-0.02em]">
          Remove {list}?
        </h3>
        <p className="text-sm text-text-sec leading-relaxed">
          We&rsquo;ll delete the {list.toLowerCase()} pricing book and disable
          those catalogue items. Quotes you&rsquo;ve already drafted are
          unaffected. Your AI receptionist will stop greeting callers about{' '}
          {list.toLowerCase()} work.
        </p>
        <p className="text-xs text-text-dim">
          You can re-add the trade any time — your pricing rates will reset to
          the defaults though.
        </p>
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-sm font-semibold uppercase tracking-wider text-text-sec hover:text-text-pri px-4 py-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {busy ? 'Removing…' : `Remove ${list}`}
          </button>
        </div>
      </div>
    </div>
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
  // Multi-trade tenants get one PricingBookCard per trade. Single-trade
  // tenants get exactly one card — same component, no special UI.
  const books = data.pricing_books?.length
    ? data.pricing_books
    : data.pricing
      ? [data.pricing as PricingBook]
      : []

  if (books.length === 0) {
    return (
      <Card title="Pricing book">
        <p className="text-sm text-text-sec">
          No pricing book yet — finish activation to generate one.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {books.map((book) => (
        <PricingBookCard
          key={book.trade ?? 'default'}
          book={book}
          isMultiTrade={books.length > 1}
          onSave={onSave}
        />
      ))}
    </div>
  )
}

function PricingBookCard({
  book,
  isMultiTrade,
  onSave,
}: {
  book: PricingBook
  isMultiTrade: boolean
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const initial = useMemo(
    () => ({
      hourly_rate: numString(book.hourly_rate),
      call_out_minimum: numString(book.call_out_minimum),
      default_markup_pct: numString(book.default_markup_pct),
      apprentice_rate: numString(book.apprentice_rate),
      senior_rate: numString(book.senior_rate),
      after_hours_multiplier: numString(book.after_hours_multiplier),
      min_labour_hours: numString(book.min_labour_hours),
      risk_buffer_pct: numString(book.risk_buffer_pct),
      gst_registered: book.gst_registered ?? false,
    }),
    [book],
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
      if (isMultiTrade) {
        // Scope this save to ONE trade's pricing_book row.
        await onSave({ pricing_by_trade: { [book.trade]: payload } })
      } else {
        await onSave({ pricing: payload })
      }
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  const title = isMultiTrade
    ? `${tradeLabel(book.trade)} pricing`
    : 'Pricing book'
  const subtitle = isMultiTrade
    ? `Rates the AI uses when drafting ${tradeLabel(book.trade).toLowerCase()} quotes.`
    : 'Every quote your AI drafts pulls from these numbers. Update any time.'

  return (
    <Card title={title} subtitle={subtitle}>
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

  // Multi-trade tenants see services grouped by trade so the dashboard
  // makes it obvious which catalogue half each row belongs to. Single-
  // trade tenants get the original flat list (no group header).
  const tenantTrades =
    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 0
      ? data.tenant.trades
      : data.tenant.trade
        ? [data.tenant.trade]
        : []
  const showGrouped = tenantTrades.length > 1
  const groupedServices: Array<{ trade: string; rows: typeof data.services }> = showGrouped
    ? tenantTrades.map((t) => ({
        trade: t,
        rows: data.services.filter((s) => s.trade === t),
      }))
    : [{ trade: tenantTrades[0] ?? '', rows: data.services }]

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
                <span className="font-mono">{tenantTrades.join(', ') || '—'}</span>.
                This usually means the seed data hasn&rsquo;t loaded — check the
                Supabase <span className="font-mono">shared_assemblies</span> table.
              </p>
            </div>
          ) : (
            groupedServices.map(({ trade: groupTrade, rows }) => (
              <div key={groupTrade || 'all'} className="space-y-2">
                {showGrouped && (
                  <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent font-bold pt-3 pb-1">
                    {tradeLabel(groupTrade as 'electrical' | 'plumbing')}
                  </div>
                )}
                {rows.map((svc) => {
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
            })}
              </div>
            ))
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
  const isMultiTrade =
    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 1

  if (data.quotes.length === 0) {
    return (
      <Card title="Quotes">
        <p className="text-sm text-text-dim">
          No quotes drafted yet. Customers texting your QuoteMate number will
          appear here once their first quote is drafted.
        </p>
      </Card>
    )
  }
  return (
    <Card
      title="Quotes"
      subtitle="Last 20 drafted by your AI. Click a row to expand the scope, tier breakdown, and customer-facing link."
    >
      <div className="space-y-4">
        {data.quotes.map((q) => (
          <QuoteCard key={q.id} q={q} isMultiTrade={isMultiTrade} />
        ))}
      </div>
    </Card>
  )
}

function QuoteCard({ q, isMultiTrade }: { q: Quote; isMultiTrade: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const url = q.share_token ? `/q/${q.share_token}` : null

  // Tier prices. Each tier JSONB stores `subtotal_ex_gst` but NOT
  // total_inc_gst (the estimator applies GST at the quote level on
  // `quotes.total_inc_gst`). Derive each tier's inc-GST figure by
  // multiplying its subtotal by the actual GST ratio used on this
  // quote (headline total / selected-tier subtotal). That way the
  // ladder matches the customer-facing page exactly whether or not the
  // tradie is GST-registered, without needing to look up tenant flags.
  const selectedTotal = toNum(q.total_inc_gst)
  const selectedTier = q.selected_tier as 'good' | 'better' | 'best' | null
  const selectedSubtotal = selectedTier
    ? toNum(q[selectedTier]?.subtotal_ex_gst)
    : null
  const gstRatio =
    selectedTotal !== null && selectedSubtotal !== null && selectedSubtotal > 0
      ? selectedTotal / selectedSubtotal
      : 1
  const goodSub = toNum(q.good?.subtotal_ex_gst)
  const betterSub = toNum(q.better?.subtotal_ex_gst)
  const bestSub = toNum(q.best?.subtotal_ex_gst)
  const goodTotal = goodSub !== null ? +(goodSub * gstRatio).toFixed(2) : null
  const betterTotal = betterSub !== null ? +(betterSub * gstRatio).toFixed(2) : null
  const bestTotal = bestSub !== null ? +(bestSub * gstRatio).toFixed(2) : null
  const customerLabel = q.customer_full_name || q.customer_first_name || '—'
  const trade = q.trade as 'electrical' | 'plumbing' | null
  const isInspection = !!(q.needs_inspection || q.inspection_required)
  const hasTierLadder =
    goodTotal !== null || betterTotal !== null || bestTotal !== null

  // Status badges — composed in priority order:
  //   • Deposit paid (the most actionable signal — overrides status)
  //   • Inspection required (parallel context badge)
  //   • Raw status as a final pill (draft / sent / accepted)
  type Badge = {
    label: string
    tone: 'paid' | 'inspect' | 'draft' | 'sent' | 'accepted'
  }
  const badges: Badge[] = []
  if (q.deposit_paid) badges.push({ label: 'Deposit paid', tone: 'paid' })
  if (isInspection) badges.push({ label: 'Inspection required', tone: 'inspect' })
  if (!q.deposit_paid) {
    const raw = (q.status ?? 'draft').toLowerCase()
    const tone: Badge['tone'] =
      raw === 'accepted' ? 'accepted' : raw === 'sent' ? 'sent' : 'draft'
    badges.push({ label: raw, tone })
  }

  return (
    <div className="border border-ink-line bg-ink-card">
      {/* ── Header row: customer + headline price ───────────────────── */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-extrabold text-base text-text-pri tracking-tight">
              {customerLabel}
            </span>
            {q.suburb && (
              <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
                · {q.suburb}
              </span>
            )}
          </div>
          {q.customer_phone && (
            <div className="mt-1 font-mono text-xs text-text-sec">
              {q.customer_phone}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-2xl font-extrabold text-text-pri leading-none">
            {selectedTotal !== null ? `$${formatMoney(selectedTotal)}` : '—'}
          </div>
          {q.selected_tier && (
            <div className="mt-1 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-accent font-bold">
              {q.selected_tier} tier · inc GST
            </div>
          )}
        </div>
      </div>

      {/* ── Metadata grid: type / service / when / routing ──────────── */}
      <div className="mt-3 mx-5 grid grid-cols-2 md:grid-cols-4 gap-px bg-ink-line border border-ink-line">
        <MetaCell
          label="Work"
          value={formatJobType(q.job_type)}
        />
        <MetaCell
          label="Service"
          value={trade ? tradeLabel(trade) : '—'}
          highlight={isMultiTrade}
        />
        <MetaCell
          label="Drafted"
          value={formatDate(q.created_at)}
          sub={formatTime(q.created_at)}
        />
        <MetaCell
          label="Routing"
          value={q.routing_decision ? formatJobType(q.routing_decision) : '—'}
        />
      </div>

      {/* ── Tier ladder: Good / Better / Best always visible ────────── */}
      {hasTierLadder && (
        <div className="mt-4 px-5">
          <div className="grid grid-cols-3 gap-2">
            <TierCell label="Good" amount={goodTotal} selected={q.selected_tier === 'good'} />
            <TierCell label="Better" amount={betterTotal} selected={q.selected_tier === 'better'} />
            <TierCell label="Best" amount={bestTotal} selected={q.selected_tier === 'best'} />
          </div>
        </div>
      )}

      {/* ── Status badges + actions ─────────────────────────────────── */}
      <div className="mt-4 px-5 pb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {badges.map((b, i) => (
            <span
              key={i}
              className={`inline-flex items-center font-mono text-[0.6rem] uppercase tracking-[0.14em] font-bold px-2.5 py-1 border ${
                b.tone === 'paid'
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                  : b.tone === 'inspect'
                    ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
                    : b.tone === 'accepted'
                      ? 'border-accent/60 bg-accent/10 text-accent'
                      : b.tone === 'sent'
                        ? 'border-text-sec/40 bg-text-sec/5 text-text-sec'
                        : 'border-ink-line bg-ink-deep text-text-dim'
              }`}
            >
              {b.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-sec hover:text-text-pri transition-colors"
          >
            {expanded ? '− Hide scope' : '+ Show scope'}
          </button>
          {url && (
            <Link
              href={url}
              target="_blank"
              className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-4 py-2 text-xs uppercase tracking-wider transition-colors"
            >
              View customer page →
            </Link>
          )}
        </div>
      </div>

      {/* ── Expanded scope/timeframe detail ──────────────────────────── */}
      {expanded && (
        <div className="border-t border-ink-line px-5 py-4 space-y-4 bg-ink-deep/30">
          {q.scope_of_works && (
            <div>
              <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim font-bold mb-2">
                Scope of works
              </div>
              <p className="text-sm text-text-sec leading-relaxed">
                {q.scope_of_works}
              </p>
            </div>
          )}

          {q.estimated_timeframe && (
            <div>
              <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim font-bold mb-1">
                Estimated timeframe
              </div>
              <p className="text-sm text-text-sec">{q.estimated_timeframe}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MetaCell({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div className="bg-ink-card px-3 py-2">
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-1 font-semibold text-sm ${
          highlight ? 'text-accent uppercase' : 'text-text-pri'
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[0.65rem] text-text-dim mt-0.5">{sub}</div>
      )}
    </div>
  )
}

function TierCell({
  label,
  amount,
  selected,
}: {
  label: string
  amount: number | null
  selected: boolean
}) {
  return (
    <div
      className={`px-3 py-2 border ${
        selected
          ? 'border-accent bg-accent/10 text-text-pri'
          : 'border-ink-line bg-ink-card text-text-sec'
      }`}
    >
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
        {label}
      </div>
      <div className="mt-1 font-mono font-bold text-sm">
        {amount !== null ? `$${formatMoney(amount)}` : '—'}
      </div>
    </div>
  )
}

/** Render a snake_case job_type as title case ("blocked_drain" → "Blocked drain"). */
function formatJobType(j: string | null): string {
  if (!j) return '—'
  return j.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
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

/** Render the tenant's full trade portfolio. Falls back to the legacy
 *  scalar `trade` when `trades[]` is empty (pre-017 rows that may have
 *  slipped through). */
function tenantTradesLabel(tenant: Tenant): string {
  const trades =
    Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []
  if (trades.length === 0) return '—'
  return trades.map(tradeLabel).join(' + ')
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

/** AU 24-hour time component for the quote card timestamp. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return ''
  }
}
