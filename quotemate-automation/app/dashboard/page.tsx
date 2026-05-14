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

type ConvoMessage = {
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
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
  // Communication channel that produced this quote (Phase A + voice).
  //   'sms'   → conversation_id points at sms_conversations
  //   'voice' → messages come from parsed calls.transcript
  //   null    → legacy pre-v6 or unlinked
  channel: 'sms' | 'voice' | null
  conversation_id: string | null
  messages: ConvoMessage[]
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

type Tab = 'overview' | 'account' | 'pricing' | 'services' | 'quotes' | 'chats'

/** SMS conversation summary returned by /api/tenant/chats. Drives the
 *  Chats tab — communication history including leads that didn't
 *  convert to a drafted quote. */
type ChatRow = {
  id: string
  channel: 'sms' | 'voice'
  from_number: string | null
  to_number: string | null
  status: string | null
  conversation_type: string | null
  intake_id: string | null
  turn_count: number
  created_at: string
  last_message_at: string | null
  duration_seconds: number | null
  first_name: string | null
  job_type: string | null
  suburb: string | null
  messages: ConvoMessage[]
}

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

  // Compact subtitle for the top-nav profile chip — "Electrical · NSW"
  // style. Replaces the prior big greeting block under the top bar.
  const profileSubtitle = [
    tenantTradesLabel(data.tenant),
    data.tenant.state,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Shell
      businessName={data.tenant.business_name}
      onSignOut={signOut}
      wide
      ownerFirstName={data.tenant.owner_first_name ?? 'Tradie'}
      tenantStatus={data.tenant.status}
      tenantSubtitle={profileSubtitle || null}
    >
      {/* Mobile tab strip (< lg). Hidden on desktop — sidebar takes over. */}
      <MobileTabBar tab={tab} setTab={setTab} quoteCount={data.quotes.length} />

      {/* Desktop two-column grid: sidebar | content. On mobile this
          collapses to single-column with MobileTabBar handling section
          switching above. The grid starts immediately under the top
          nav — no big greeting block above so the sidebar aligns flush
          with the KPI row. */}
      <div className="mt-4 lg:mt-6 lg:grid lg:grid-cols-[14rem_1fr] lg:gap-8">
        <Sidebar tab={tab} setTab={setTab} quoteCount={data.quotes.length} />
        <section className="mt-6 lg:mt-0 pb-20 min-w-0">
          {/* `key={tab}` forces a tear-down + remount when the user
              switches tabs, so the inner fade-in keyframe re-fires.
              OverviewTab's chat fetch lives behind an effect so the
              brief loading state on first paint is acceptable. */}
          <div
            key={tab}
            className="motion-safe:animate-[fade-in_220ms_ease-out_both]"
          >
            {tab === 'overview' && (
              <OverviewTab data={data} accessToken={accessToken} setTab={setTab} />
            )}
            {tab === 'account' && (
              <AccountTab data={data} onSave={patch} onSaveTrades={saveTrades} />
            )}
            {tab === 'pricing' && <PricingTab data={data} onSave={patch} />}
            {tab === 'services' && <ServicesTab data={data} onSave={patch} />}
            {tab === 'quotes' && <QuotesTab data={data} />}
            {tab === 'chats' && (
              <ChatsTab accessToken={accessToken} isMultiTrade={
                Array.isArray(data.tenant.trades) && data.tenant.trades.length > 1
              } />
            )}
          </div>
        </section>
      </div>
    </Shell>
  )
}

// ─── Shell + Status badge ─────────────────────────────────────────

function Shell({
  businessName,
  onSignOut,
  children,
  wide,
  ownerFirstName,
  tenantStatus,
  tenantSubtitle,
}: {
  businessName: string | null
  onSignOut: () => void
  children: ReactNode
  /** When true, expands the inner container to 7xl so the authenticated
   *  dashboard has room for the sidebar+content grid. Loading + error
   *  states omit this flag and keep the narrower 5xl frame. */
  wide?: boolean
  /** Owner first name — when present, renders the compact profile chip
   *  in the top-right of the nav bar (avatar disc + name + status). */
  ownerFirstName?: string | null
  /** Tenant status drives the green/amber pulse next to the profile
   *  chip. Optional so the loading/error Shell can omit it. */
  tenantStatus?: 'onboarding' | 'active' | null
  /** Small one-line context under the name in the profile chip — e.g.
   *  "Electrical · NSW". */
  tenantSubtitle?: string | null
}) {
  const showProfile = !!ownerFirstName
  return (
    <main className="min-h-screen bg-ink-deep text-text-pri flex flex-col">
      <nav className="border-b border-ink-line bg-ink-deep sticky top-0 z-20">
        <div
          className={`mx-auto flex items-center justify-between gap-4 px-6 py-3 ${
            wide ? 'max-w-[88rem]' : 'max-w-7xl'
          }`}
        >
          <Link href="/dashboard" className="flex items-center gap-3 min-w-0">
            <span className="grid h-7 w-7 place-items-center bg-accent font-black text-white text-xs shrink-0">
              Q
            </span>
            <span className="font-extrabold uppercase tracking-tight text-text-pri shrink-0">
              QuoteMate
            </span>
            {businessName && (
              <>
                <span className="text-text-dim shrink-0">/</span>
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-text-sec truncate">
                  {businessName}
                </span>
              </>
            )}
          </Link>
          <div className="flex items-center gap-3 shrink-0">
            {showProfile && (
              <ProfileChip
                firstName={ownerFirstName!}
                subtitle={tenantSubtitle ?? null}
                status={tenantStatus ?? null}
              />
            )}
            <button
              type="button"
              onClick={onSignOut}
              className="text-xs font-semibold uppercase tracking-wider text-text-sec hover:text-text-pri transition-colors cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <div
        className={`flex-1 mx-auto w-full px-6 py-6 ${
          wide ? 'max-w-[88rem]' : 'max-w-5xl py-10'
        }`}
      >
        {children}
      </div>
    </main>
  )
}

/** Compact identity chip rendered in the top-nav right-side cluster.
 *  Avatar disc carries the owner's initial in accent orange; the name
 *  and status sit beside it. Status badge uses a tiny coloured dot so
 *  the chip doesn't visually outweigh the rest of the nav.
 *  On narrow screens the name + subtitle collapse — only the avatar
 *  remains, so the chip never wraps. */
function ProfileChip({
  firstName,
  subtitle,
  status,
}: {
  firstName: string
  subtitle: string | null
  status: 'onboarding' | 'active' | null
}) {
  const initial = (firstName.trim()[0] ?? '?').toUpperCase()
  const active = status === 'active'
  return (
    <div className="flex items-center gap-2.5 border border-ink-line bg-ink-card pl-1.5 pr-3 py-1">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 place-items-center bg-accent/15 border border-accent/40 text-accent font-mono font-extrabold text-xs"
      >
        {initial}
      </span>
      <div className="hidden md:flex flex-col leading-none min-w-0">
        <span className="font-extrabold text-text-pri text-xs uppercase tracking-[0.05em] truncate">
          {firstName}
        </span>
        {subtitle && (
          <span className="mt-0.5 font-mono text-[0.55rem] uppercase tracking-[0.14em] text-text-dim truncate">
            {subtitle}
          </span>
        )}
      </div>
      {status && (
        <span
          className={`flex items-center gap-1.5 pl-2 ml-1 border-l border-ink-line font-mono text-[0.55rem] uppercase tracking-[0.16em] font-bold ${
            active ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              active ? 'bg-emerald-300' : 'bg-amber-300'
            }`}
          />
          {active ? 'Active' : 'Onboarding'}
        </span>
      )}
    </div>
  )
}

// ─── Sidebar + nav config ─────────────────────────────────────────
//
// CRM-style left rail for desktop (>= lg). Replaces the original
// horizontal tab strip. On smaller viewports we render `MobileTabBar`
// instead — same Tab state, just laid out as wrap-friendly chips.

type NavItem = {
  tab: Tab
  label: string
  /** Optional badge count rendered next to the label (e.g. quote count). */
  count?: number | null
}

function buildNav(quoteCount: number): NavItem[] {
  return [
    { tab: 'overview', label: 'Overview' },
    { tab: 'quotes', label: 'Quotes', count: quoteCount },
    { tab: 'chats', label: 'Chats' },
    { tab: 'account', label: 'Account' },
    { tab: 'pricing', label: 'Pricing' },
    { tab: 'services', label: 'Services' },
  ]
}

function Sidebar({
  tab,
  setTab,
  quoteCount,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  quoteCount: number
}) {
  const items = buildNav(quoteCount)
  return (
    <aside className="hidden lg:block">
      <nav
        className="sticky top-20 bg-ink border border-ink-line"
        aria-label="Dashboard sections"
      >
        <div className="px-4 py-3 border-b border-ink-line">
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim">
            Sections
          </span>
        </div>
        <ul className="py-2">
          {items.map((item) => {
            const active = item.tab === tab
            return (
              <li key={item.tab}>
                <button
                  type="button"
                  onClick={() => setTab(item.tab)}
                  className={`w-full text-left flex items-center justify-between gap-3 pl-4 pr-3 py-2.5 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold transition-colors border-l-2 cursor-pointer ${
                    active
                      ? 'border-accent text-accent bg-ink-card'
                      : 'border-transparent text-text-dim hover:text-text-pri hover:bg-ink-card/60'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  <span>{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span
                      className={`font-mono text-[0.6rem] px-1.5 py-0.5 border ${
                        active
                          ? 'border-accent/60 text-accent'
                          : 'border-ink-line text-text-sec'
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}

function MobileTabBar({
  tab,
  setTab,
  quoteCount,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  quoteCount: number
}) {
  const items = buildNav(quoteCount)
  return (
    <nav
      className="lg:hidden flex flex-wrap gap-1 border-b border-ink-line"
      aria-label="Dashboard sections"
    >
      {items.map((item) => {
        const active = item.tab === tab
        return (
          <button
            key={item.tab}
            type="button"
            onClick={() => setTab(item.tab)}
            className={`px-4 py-3 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold transition-colors cursor-pointer ${
              active
                ? 'text-accent border-b-2 border-accent -mb-px'
                : 'text-text-dim hover:text-text-pri'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
            {typeof item.count === 'number' && item.count > 0 && (
              <span className="ml-2 text-text-sec">({item.count})</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

// ─── Overview tab ─────────────────────────────────────────────────

function OverviewTab({
  data,
  accessToken,
  setTab,
}: {
  data: DashboardData
  accessToken: string | null
  setTab: (t: Tab) => void
}) {
  const enabledServices = data.services.filter((s) => s.enabled).length
  const totalServices = data.services.length
  const activeQuotes = data.quotes.length
  const draftQuotes = data.quotes.filter((q) =>
    ['drafted', 'awaiting_review', 'review'].includes(q.status),
  ).length

  // Pipeline numbers — the money/conversion view the tradie actually
  // cares about. A quote counts as "accepted" if its status is
  // 'accepted' OR a deposit has landed (deposit_paid overrides status
  // in the QuoteCard badge ordering, same logic applied here).
  const acceptedQuotes = data.quotes.filter(
    (q) => q.deposit_paid || (q.status ?? '').toLowerCase() === 'accepted',
  )
  const quotedValue = data.quotes.reduce(
    (sum, q) => sum + (toNum(q.total_inc_gst) ?? 0),
    0,
  )
  const acceptedValue = acceptedQuotes.reduce(
    (sum, q) => sum + (toNum(q.total_inc_gst) ?? 0),
    0,
  )
  const conversionPct =
    activeQuotes > 0
      ? Math.round((acceptedQuotes.length / activeQuotes) * 100)
      : 0
  const avgQuoteValue = activeQuotes > 0 ? quotedValue / activeQuotes : 0
  const depositsPaidCount = data.quotes.filter((q) => q.deposit_paid).length

  const tenant = data.tenant
  const smsNumber = tenant.twilio_sms_number
  const assistantId = tenant.vapi_assistant_id

  // Stub detection — the activate route returns deterministic
  // placeholders when *_PROVISIONING_ENABLED env flags are off. We
  // surface this clearly so the tradie (and you, debugging) know
  // whether a real Twilio purchase happened.
  const isStubTwilio = !!smsNumber && /^\+614820\d{5}$/.test(smsNumber)
  const isStubVapi = !!assistantId && assistantId.startsWith('vapi-stub-')
  const needsProvisioning = !smsNumber || !assistantId

  // Recent quotes preview — top 5 by created_at desc. data.quotes is
  // already ordered desc by the /api/tenant/me endpoint, so this is a
  // pure client-side slice.
  const latestQuotes = data.quotes.slice(0, 5)

  // Recent chats — fetched lazily on Overview mount so the Chats tab can
  // keep doing its own larger fetch independently. 5-row preview only;
  // clicking a row jumps to the Chats tab where the full list lives.
  const [latestChats, setLatestChats] = useState<ChatRow[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    setChatsLoading(true)
    fetch('/api/tenant/chats', {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    })
      .then((r) => r.json().catch(() => ({ chats: [] })))
      .then((j) => {
        if (cancelled) return
        const rows = (j?.chats ?? []) as ChatRow[]
        setLatestChats(rows.slice(0, 5))
      })
      .catch(() => {
        if (!cancelled) setLatestChats([])
      })
      .finally(() => {
        if (!cancelled) setChatsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accessToken])

  // KPI tone for the AI receptionist tile — green when fully live,
  // amber for stub/missing, so the tradie's eye lands on the right
  // thing when something needs attention.
  const aiTone: 'ok' | 'warn' = !assistantId || isStubVapi ? 'warn' : 'ok'
  const aiValue = !assistantId
    ? 'Not yet'
    : isStubVapi
      ? 'Stub'
      : 'Live'

  return (
    <div className="space-y-6 motion-safe:animate-[fade-in_180ms_ease-out_both]">
      {/* HERO — compact QuoteMate number. Tighter padding + a single
          one-line subtitle instead of the prior wordy explainer. */}
      <div className="bg-ink-card border border-ink-line p-5 md:p-6 motion-safe:animate-[fade-up_240ms_ease-out_both]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-text-dim">
              Your QuoteMate number
            </div>
            {smsNumber ? (
              <div className="mt-2 font-mono text-[clamp(1.25rem,3vw,2rem)] font-bold text-text-pri tracking-tight leading-none">
                {formatAuMobile(smsNumber)}
              </div>
            ) : (
              <div className="mt-2 text-amber-300 text-sm max-w-md">
                Provisioning didn&rsquo;t finish on activate. Hit retry —
                your account + pricing book are saved.
              </div>
            )}
            {needsProvisioning && <RetryProvisionButton />}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Pill
              tone={needsProvisioning ? 'warn' : isStubTwilio ? 'warn' : 'ok'}
              label={
                needsProvisioning
                  ? 'Pending'
                  : isStubTwilio
                    ? 'Stub mode'
                    : 'Live'
              }
            />
            {tenant.activated_at && (
              <span className="font-mono text-[0.55rem] uppercase tracking-[0.16em] text-text-dim">
                Activated {formatDate(tenant.activated_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* KPI ROW — at-a-glance triage state. Numbered-card pattern (big
          orange mono value, uppercase label). Each tile carries its
          own fade-up so the row reveals smoothly on first mount. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-ink-line border border-ink-line">
        <KpiTile
          label="Quotes total"
          value={activeQuotes}
          hint={activeQuotes === 0 ? 'No quotes yet' : 'All time'}
        />
        <KpiTile
          label="In review"
          value={draftQuotes}
          hint="Awaiting your send"
          tone={draftQuotes > 0 ? 'warn' : 'default'}
        />
        <KpiTile
          label="Services on"
          value={`${enabledServices}/${totalServices}`}
          hint="Auto-quote enabled"
        />
        <KpiTile
          label="AI receptionist"
          value={aiValue}
          hint={tenant.status === 'active' ? 'Account active' : 'Onboarding'}
          tone={aiTone}
        />
      </div>

      {/* TWO-COLUMN GRID — latest quotes hero + latest chats sidebar */}
      <div className="grid gap-6 lg:grid-cols-3 motion-safe:animate-[fade-up_280ms_ease-out_both]">
        {/* Latest quotes — primary scan target, takes 2/3 of the row */}
        <section className="lg:col-span-2 bg-ink-card border border-ink-line">
          <header className="flex items-center justify-between px-5 py-3 border-b border-ink-line">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold text-text-pri">
              Latest quotes
            </h2>
            <button
              type="button"
              onClick={() => setTab('quotes')}
              className="font-mono text-[0.65rem] uppercase tracking-[0.14em] font-bold text-accent hover:text-accent-press cursor-pointer"
            >
              See all →
            </button>
          </header>
          {latestQuotes.length === 0 ? (
            <div className="px-5 py-8 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
              No quotes drafted yet. Customer SMS or calls will land here.
            </div>
          ) : (
            <div>
              {latestQuotes.map((q) => (
                <LatestQuoteRow key={q.id} q={q} onOpen={() => setTab('quotes')} />
              ))}
            </div>
          )}
        </section>

        {/* Latest chats — secondary scan target */}
        <section className="bg-ink-card border border-ink-line">
          <header className="flex items-center justify-between px-5 py-3 border-b border-ink-line">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold text-text-pri">
              Latest chats
            </h2>
            <button
              type="button"
              onClick={() => setTab('chats')}
              className="font-mono text-[0.65rem] uppercase tracking-[0.14em] font-bold text-accent hover:text-accent-press cursor-pointer"
            >
              See all →
            </button>
          </header>
          {chatsLoading ? (
            <div className="px-5 py-8 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
              Loading…
            </div>
          ) : latestChats.length === 0 ? (
            <div className="px-5 py-8 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
              No conversations yet.
            </div>
          ) : (
            <div>
              {latestChats.map((c) => (
                <LatestChatRow key={c.id} chat={c} onOpen={() => setTab('chats')} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* PIPELINE — the money view. Total quoted, total converted,
          conversion %, deposits, average ticket. Numbered-card pattern
          again so it reads as a continuation of the KPI row, not a new
          design language. */}
      <section className="bg-ink-card border border-ink-line motion-safe:animate-[fade-up_320ms_ease-out_both]">
        <header className="flex items-center justify-between px-5 py-3 border-b border-ink-line">
          <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold text-text-pri">
            Pipeline
          </h2>
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
            All time
          </span>
        </header>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-ink-line border-t border-ink-line">
          <PipelineStat
            label="Quoted"
            value={`$${formatMoney(Math.round(quotedValue))}`}
            hint={`${activeQuotes} ${activeQuotes === 1 ? 'quote' : 'quotes'} drafted`}
          />
          <PipelineStat
            label="Converted"
            value={`$${formatMoney(Math.round(acceptedValue))}`}
            hint={`${acceptedQuotes.length} accepted`}
            tone={acceptedQuotes.length > 0 ? 'ok' : 'default'}
          />
          <PipelineStat
            label="Conversion"
            value={`${conversionPct}%`}
            hint={`${acceptedQuotes.length} of ${activeQuotes}`}
          />
          <PipelineStat
            label="Avg quote"
            value={`$${formatMoney(Math.round(avgQuoteValue))}`}
            hint={`${depositsPaidCount} ${depositsPaidCount === 1 ? 'deposit' : 'deposits'} paid`}
          />
        </div>
      </section>
    </div>
  )
}

/** Stat cell inside the Pipeline section. Mirrors KpiTile's visual
 *  language (mono accent number, uppercase label, optional hint) but
 *  uses string values (currency formatted) instead of count-up so
 *  dollar totals don't tick from $0 — which would feel jittery for a
 *  number that's already large on first paint. */
function PipelineStat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'ok'
}) {
  const valueTone = tone === 'ok' ? 'text-emerald-300' : 'text-accent'
  return (
    <div className="bg-ink-card p-5">
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-2 font-mono font-extrabold leading-none text-[clamp(1.25rem,2.2vw,1.75rem)] tabular-nums ${valueTone}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 font-mono text-[0.55rem] uppercase tracking-[0.14em] text-text-sec">
          {hint}
        </div>
      )}
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

/** Animate an integer from 0 to `target` over `durationMs`. Returns the
 *  current displayed value. Uses requestAnimationFrame with an
 *  ease-out-cubic curve so the number lands softly. Honours
 *  prefers-reduced-motion by snapping immediately to the target. */
function useCountUp(target: number, durationMs = 700): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined' || !Number.isFinite(target)) {
      setN(target)
      return
    }
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || target <= 0) {
      setN(target)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs)
      // ease-out-cubic
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])
  return n
}

/** Hero KPI tile — uses the brand's numbered-card pattern (big orange
 *  mono number, white uppercase label, ink-card panel). Used in the
 *  Overview KPI row. Numeric values tick up from 0 on first mount via
 *  useCountUp; string values render as-is. */
function KpiTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'warn' | 'ok'
}) {
  const isNumber = typeof value === 'number'
  const animated = useCountUp(isNumber ? value : 0)
  const display = isNumber ? animated : value
  const valueTone =
    tone === 'warn'
      ? 'text-amber-300'
      : tone === 'ok'
        ? 'text-emerald-300'
        : 'text-accent'
  return (
    <div className="bg-ink-card border border-ink-line p-5 md:p-6 motion-safe:animate-[fade-up_240ms_ease-out_both]">
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-2 font-mono font-extrabold leading-none text-[clamp(1.75rem,3vw,2.5rem)] tabular-nums ${valueTone}`}
      >
        {display}
      </div>
      {hint && (
        <div className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-sec">
          {hint}
        </div>
      )}
    </div>
  )
}

/** Compact one-line preview of a Quote, rendered in the Overview's
 *  "Latest quotes" panel. Clicking jumps to the Quotes tab so the full
 *  QuoteCard layout is the canonical viewer. */
function LatestQuoteRow({
  q,
  onOpen,
}: {
  q: Quote
  onOpen: () => void
}) {
  const customer = q.customer_full_name || q.customer_first_name || '—'
  const total = toNum(q.total_inc_gst)
  const status = (q.status ?? 'draft').toLowerCase()
  const isPaid = !!q.deposit_paid
  const isInspect = !!(q.needs_inspection || q.inspection_required)
  const tone = isPaid
    ? 'border-emerald-500/60 text-emerald-300'
    : isInspect
      ? 'border-amber-500/60 text-amber-300'
      : status === 'accepted'
        ? 'border-accent/60 text-accent'
        : 'border-ink-line text-text-sec'
  const badge = isPaid
    ? 'Paid'
    : isInspect
      ? 'Inspect'
      : status
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-line last:border-b-0 hover:bg-ink-deep/40 transition-colors cursor-pointer"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-text-pri truncate">
            {customer}
          </span>
          {q.channel && <ChannelBadge channel={q.channel} />}
        </div>
        <div className="mt-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-text-dim">
          {q.job_type ? formatJobType(q.job_type) : 'Unclassified'}
          {q.suburb ? ` · ${q.suburb}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm font-bold text-text-pri">
          {total !== null ? `$${formatMoney(total)}` : '—'}
        </div>
        <span
          className={`mt-1 inline-flex items-center font-mono text-[0.55rem] uppercase tracking-[0.14em] font-bold px-1.5 py-0.5 border ${tone}`}
        >
          {badge}
        </span>
      </div>
    </button>
  )
}

/** Compact one-line preview of a recent conversation. Renders the
 *  customer's first name + channel pill + last-activity time. Click
 *  jumps to the Chats tab. */
function LatestChatRow({
  chat,
  onOpen,
}: {
  chat: ChatRow
  onOpen: () => void
}) {
  const who = chat.first_name || chat.from_number || 'Unknown'
  const when = chat.last_message_at ?? chat.created_at
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-line last:border-b-0 hover:bg-ink-deep/40 transition-colors cursor-pointer"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-text-pri truncate">{who}</span>
          <ChannelBadge channel={chat.channel} />
        </div>
        <div className="mt-1 font-mono text-[0.65rem] uppercase tracking-[0.12em] text-text-dim">
          {chat.job_type ? formatJobType(chat.job_type) : 'Unclassified'}
          {chat.suburb ? ` · ${chat.suburb}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
          {formatDate(when)}
        </div>
        <div className="mt-0.5 font-mono text-[0.6rem] text-text-sec">
          {formatTime(when)}
        </div>
      </div>
    </button>
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

// Page size for the Quotes + Chats lists. Tradies typically scan the
// last few days at a time; 10 lets the page sit at one screen with
// collapsed rows. Increase if real-volume usage shows it's too small.
const LIST_PAGE_SIZE = 10

function QuotesTab({ data }: { data: DashboardData }) {
  const isMultiTrade =
    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 1

  const [visible, setVisible] = useState(LIST_PAGE_SIZE)
  const total = data.quotes.length
  const visibleQuotes = data.quotes.slice(0, visible)
  const remaining = Math.max(0, total - visible)

  if (total === 0) {
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
      subtitle={`${Math.min(visible, total)} of ${total} shown · click a row to see the scope, tier breakdown, and customer page.`}
    >
      <div className="space-y-2">
        {visibleQuotes.map((q) => (
          <QuoteCard key={q.id} q={q} isMultiTrade={isMultiTrade} />
        ))}
      </div>
      {remaining > 0 && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + LIST_PAGE_SIZE)}
            className="inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-5 py-2.5 transition-colors cursor-pointer"
          >
            Load {Math.min(LIST_PAGE_SIZE, remaining)} more · {remaining} left
          </button>
        </div>
      )}
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

  // Compact badge label for the collapsed summary row. We surface the
  // single most-actionable badge (paid > inspect > accepted > sent >
  // draft) so the row stays one line. The full set is shown inside the
  // expanded body.
  const primaryBadge = badges[0]

  return (
    <div className="border border-ink-line bg-ink-card motion-safe:animate-[fade-up_240ms_ease-out_both]">
      {/* ── Collapsed summary row (always visible — also the trigger) ─ */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded ? 'true' : 'false'}
        className="w-full text-left flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-ink-deep/40 transition-colors cursor-pointer"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-extrabold text-base text-text-pri tracking-tight truncate">
              {customerLabel}
            </span>
            {q.channel && <ChannelBadge channel={q.channel} />}
            {q.suburb && (
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
                · {q.suburb}
              </span>
            )}
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-text-sec">
              · {formatJobType(q.job_type)}
            </span>
            {isMultiTrade && trade && (
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-accent font-bold">
                · {tradeLabel(trade)}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-3">
          {primaryBadge && (
            <span
              className={`inline-flex items-center font-mono text-[0.55rem] uppercase tracking-[0.14em] font-bold px-2 py-0.5 border ${
                primaryBadge.tone === 'paid'
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                  : primaryBadge.tone === 'inspect'
                    ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
                    : primaryBadge.tone === 'accepted'
                      ? 'border-accent/60 bg-accent/10 text-accent'
                      : primaryBadge.tone === 'sent'
                        ? 'border-text-sec/40 bg-text-sec/5 text-text-sec'
                        : 'border-ink-line bg-ink-deep text-text-dim'
              }`}
            >
              {primaryBadge.label}
            </span>
          )}
          <div className="text-right">
            <div className="font-mono text-lg font-extrabold text-text-pri leading-none tabular-nums">
              {selectedTotal !== null ? `$${formatMoney(selectedTotal)}` : '—'}
            </div>
            {q.selected_tier && (
              <div className="mt-0.5 font-mono text-[0.55rem] uppercase tracking-[0.14em] text-accent font-bold">
                {q.selected_tier}
              </div>
            )}
          </div>
          <span
            className={`font-mono text-[0.7rem] text-text-dim transition-transform duration-200 ${
              expanded ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          >
            ›
          </span>
        </div>
      </button>

      {/* ── Expansion region — grid-row trick gives a CSS-only height
          transition for variable-height content. The inner wrapper
          uses overflow-hidden so the children clip during the
          0fr ↔ 1fr animation. ─────────────────────────────────── */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-ink-line">
            {/* Metadata grid */}
            <div className="mx-5 mt-4 grid grid-cols-2 md:grid-cols-4 gap-px bg-ink-line border border-ink-line">
              <MetaCell label="Work" value={formatJobType(q.job_type)} />
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

            {/* Tier ladder */}
            {hasTierLadder && (
              <div className="mt-4 px-5">
                <div className="grid grid-cols-3 gap-2">
                  <TierCell label="Good" amount={goodTotal} selected={q.selected_tier === 'good'} />
                  <TierCell label="Better" amount={betterTotal} selected={q.selected_tier === 'better'} />
                  <TierCell label="Best" amount={bestTotal} selected={q.selected_tier === 'best'} />
                </div>
              </div>
            )}

            {/* All status badges + actions */}
            <div className="mt-4 px-5 pb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {q.customer_phone && (
                  <span className="font-mono text-xs text-text-sec">
                    {q.customer_phone}
                  </span>
                )}
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

            {/* Scope + timeframe + transcript */}
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

              {q.messages && q.messages.length > 0 && (
                <Transcript messages={q.messages} channel={q.channel} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Small pill rendered in card headers to make the channel of origin
 *  unambiguous: an SMS thread vs. a voice-call transcript look similar
 *  in the expanded view, so the badge prevents the tradie from
 *  misreading one for the other. Two-tone palette — emerald for SMS
 *  (matches the inbound-bubble accent), violet for voice (visually
 *  distinct so it doesn't blend with the SMS green). */
function ChannelBadge({ channel }: { channel: 'sms' | 'voice' }) {
  const tone =
    channel === 'voice'
      ? 'border-violet-500/60 bg-violet-500/10 text-violet-300'
      : 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
  return (
    <span
      className={`inline-flex items-center font-mono text-[0.55rem] uppercase tracking-[0.16em] font-bold px-1.5 py-0.5 border ${tone}`}
    >
      {channel === 'voice' ? 'Voice' : 'SMS'}
    </span>
  )
}

/** Render an SMS thread or parsed voice transcript as a chat-bubble view.
 *  Customer messages align right (mimicking the customer's own phone
 *  view); AI/agent messages align left. Designed for the tradie to scan
 *  quickly while reviewing the quote. The channel prop just relabels the
 *  header — bubble rendering is identical for both. */
function Transcript({
  messages,
  channel,
}: {
  messages: ConvoMessage[]
  channel?: 'sms' | 'voice' | null
}) {
  const headerLabel =
    channel === 'voice' ? 'Voice call transcript' : 'SMS conversation'
  return (
    <div>
      <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim font-bold mb-2 flex items-center justify-between">
        <span>{headerLabel}</span>
        <span className="text-text-dim font-normal normal-case tracking-normal">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'}
        </span>
      </div>
      <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
        {messages.map((m, i) => {
          const isInbound = m.direction === 'inbound'
          return (
            <div
              key={i}
              className={`flex ${isInbound ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[78%] px-3 py-2 text-sm leading-snug ${
                  isInbound
                    ? 'bg-accent/15 text-text-pri border border-accent/30'
                    : 'bg-ink-card text-text-sec border border-ink-line'
                }`}
              >
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className="mt-1 font-mono text-[0.55rem] uppercase tracking-[0.12em] text-text-dim">
                  {isInbound ? 'Customer' : 'AI'} · {formatTime(m.created_at)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Chats tab ────────────────────────────────────────────────────
//
// Lazy-loaded communication-history view. Lists every SMS conversation
// for this tenant (capped at 30 most-recent) — including ones that
// never produced a quote (escalated to inspection, ended without a
// job, in-progress dialogs, lead drop-offs). Each row is collapsible
// to reveal the full transcript. Complement to the inline transcript
// embedded on each Quote card in the Quotes tab.

function ChatsTab({
  accessToken,
  isMultiTrade,
}: {
  accessToken: string | null
  isMultiTrade: boolean
}) {
  const [chats, setChats] = useState<ChatRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    ;(async () => {
      try {
        const res = await fetch('/api/tenant/chats', {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        const json = (await res.json()) as { chats: ChatRow[] }
        if (!cancelled) setChats(json.chats ?? [])
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken])

  if (loading) {
    return (
      <Card title="Chats">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-text-dim">
          Loading conversations…
        </p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card title="Chats">
        <ErrorBanner>{error}</ErrorBanner>
      </Card>
    )
  }
  if (!chats || chats.length === 0) {
    return (
      <Card title="Chats">
        <p className="text-sm text-text-dim">
          No conversations yet. Customers who text your QuoteMate number
          will appear here.
        </p>
      </Card>
    )
  }

  return <ChatsList chats={chats} isMultiTrade={isMultiTrade} />
}

/** Renders the paginated chat list. Split out from `ChatsTab` so the
 *  Load-more state is scoped to the rendered list — opening Chats fresh
 *  always starts at the first page. */
function ChatsList({
  chats,
  isMultiTrade,
}: {
  chats: ChatRow[]
  isMultiTrade: boolean
}) {
  const [visible, setVisible] = useState(LIST_PAGE_SIZE)
  const total = chats.length
  const visibleChats = chats.slice(0, visible)
  const remaining = Math.max(0, total - visible)

  return (
    <Card
      title="Chats"
      subtitle={`${Math.min(visible, total)} of ${total} shown · click a row to expand the full thread.`}
    >
      <div className="space-y-2">
        {visibleChats.map((c) => (
          <ChatCard key={c.id} chat={c} isMultiTrade={isMultiTrade} />
        ))}
      </div>
      {remaining > 0 && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + LIST_PAGE_SIZE)}
            className="inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-5 py-2.5 transition-colors cursor-pointer"
          >
            Load {Math.min(LIST_PAGE_SIZE, remaining)} more · {remaining} left
          </button>
        </div>
      )}
    </Card>
  )
}

function ChatCard({ chat, isMultiTrade }: { chat: ChatRow; isMultiTrade: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const trade = chat.job_type
    ? deriveTradeFromJobType(chat.job_type)
    : null
  const inboundCount = chat.messages.filter((m) => m.direction === 'inbound').length

  // Status badge tone:
  //   done           → green (completed dialog)
  //   structuring    → amber (quote drafting in progress)
  //   open           → grey (mid-dialog)
  //   anything else  → grey (default)
  const statusTone =
    chat.status === 'done'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/60'
      : chat.status === 'structuring'
        ? 'bg-amber-500/10 text-amber-300 border-amber-500/60'
        : 'bg-ink-deep text-text-dim border-ink-line'

  return (
    <div className="border border-ink-line bg-ink-card motion-safe:animate-[fade-up_240ms_ease-out_both]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded ? 'true' : 'false'}
        className="w-full flex items-start justify-between gap-4 px-4 py-3 text-left hover:bg-ink-deep/40 transition-colors cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-semibold text-text-pri">
              {chat.first_name || chat.from_number || 'Unknown caller'}
            </span>
            <ChannelBadge channel={chat.channel} />
            {chat.suburb && (
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
                · {chat.suburb}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-mono uppercase tracking-[0.12em] text-text-sec">
              {chat.job_type ? formatJobType(chat.job_type) : 'Unclassified'}
              {isMultiTrade && trade ? ` · ${trade}` : ''}
            </span>
            <span className="text-text-dim">·</span>
            <span className="font-mono text-text-dim whitespace-nowrap">
              {chat.last_message_at
                ? `${formatDate(chat.last_message_at)} ${formatTime(chat.last_message_at)}`
                : formatDate(chat.created_at)}
            </span>
            {chat.from_number && (
              <>
                <span className="text-text-dim">·</span>
                <span className="font-mono text-text-dim">{chat.from_number}</span>
              </>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span
              className={`inline-flex items-center font-mono text-[0.6rem] uppercase tracking-[0.14em] font-bold px-2 py-0.5 border ${statusTone}`}
            >
              {chat.status ?? 'unknown'}
            </span>
            {chat.intake_id && (
              <span className="inline-flex items-center font-mono text-[0.6rem] uppercase tracking-[0.14em] font-bold px-2 py-0.5 border border-accent/60 bg-accent/10 text-accent">
                Quote drafted
              </span>
            )}
            {chat.conversation_type === 'tradie_registration' && (
              <span className="inline-flex items-center font-mono text-[0.6rem] uppercase tracking-[0.14em] font-bold px-2 py-0.5 border border-text-sec/40 bg-text-sec/5 text-text-sec">
                Tradie signup
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-xs text-text-dim">
            {inboundCount} in · {chat.messages.length - inboundCount} out
          </div>
          <div className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim mt-0.5">
            {expanded ? '− Hide' : '+ Open'}
          </div>
        </div>
      </button>

      {/* Grid-row trick gives a CSS-only height transition. Keeps the
          markup mounted so the transcript fades in/out smoothly instead
          of popping when the user toggles. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-ink-line px-4 py-3 bg-ink-deep/30">
            {chat.messages.length > 0 ? (
              <Transcript messages={chat.messages} channel={chat.channel} />
            ) : (
              <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
                No messages recorded on this conversation.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Lightweight job_type → trade map; mirrors lib/intake/schema's
 *  deriveTradeFromJobType but kept local here so the dashboard doesn't
 *  need a server-only import. */
function deriveTradeFromJobType(jobType: string): 'electrical' | 'plumbing' | null {
  const ELECTRICAL = new Set([
    'downlights', 'power_points', 'ceiling_fans', 'smoke_alarms', 'outdoor_lighting',
  ])
  const PLUMBING = new Set([
    'blocked_drain', 'hot_water', 'tap_repair', 'tap_replace', 'toilet_repair', 'toilet_replace',
  ])
  if (ELECTRICAL.has(jobType)) return 'electrical'
  if (PLUMBING.has(jobType)) return 'plumbing'
  return null
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
    case 'chats':
      return 'Chats'
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
