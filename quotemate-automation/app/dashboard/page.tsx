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
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CATEGORIES } from '@/lib/estimate/categories'
import { categoryHasCatalogueProduct } from '@/lib/estimate/catalogue'
import {
  LayoutDashboard,
  FileText,
  MessageSquare,
  User,
  DollarSign,
  Wrench,
  Package,
  Calculator,
  ClipboardList,
  LogOut,
  PhoneCall,
  type LucideProps,
} from 'lucide-react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { ErrorBanner, Field, INPUT } from '../signup/page'

type NavIcon = ComponentType<LucideProps>

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
  /** Per-tenant overlay jsonb — carries the v8 early_bird discount
   *  config ({ enabled, discount_pct, window_hours }) among other keys. */
  overlays?: Record<string, unknown> | null
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
  /** Migration 023. TRUE for tenant_custom_assemblies rows, FALSE
   *  for shared_assemblies rows. Drives Edit/Delete affordances
   *  + which PATCH branch the toggle uses. */
  is_custom: boolean
  /** TRUE on custom rows that the tradie has flagged "always
   *  inspection." The LLM tools skip these rows for pricing so
   *  customer matches force inspection routing. */
  always_inspection: boolean
  /** Migration 029 — explicit grounding category. null on shared rows
   *  and on custom rows left to auto-detect from the name. */
  category?: string | null
}

// `EditingService` (the inline create/edit form state) is declared
// alongside the CustomServiceForm component lower in this file so the
// form's typed defaults stay co-located with their consumer.

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

type MaterialCategory = {
  trade: string
  category: string
  brands: string[]
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
  /** Material catalogue grouped by (trade, category) → unique brands.
   *  Migration 022. The Preferred Brands UI renders one dropdown per row. */
  material_categories: MaterialCategory[]
  /** Map of category → preferred brand. Absent key = no preference. */
  material_preferences: Record<string, string>
}

type Tab =
  | 'overview'
  | 'account'
  | 'pricing'
  | 'services'
  | 'catalogue'
  | 'estimating'
  | 'recipes'
  | 'quotes'
  | 'chats'
  | 'followups'

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

  // ── Custom-service helpers (migration 023) ───────────────────────
  // POST/PATCH/DELETE against /api/tenant/services. Each helper
  // re-fetches the dashboard payload on success so the list reflects
  // the new state. Throws a friendly Error message on failure so the
  // form can surface it inline.
  async function createCustomService(payload: Record<string, unknown>) {
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch('/api/tenant/services', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body?.message ?? body?.error ?? `Create failed (HTTP ${res.status})`)
    }
    await refresh(accessToken)
    return body as { ok: true; service: unknown }
  }

  async function updateCustomService(id: string, payload: Record<string, unknown>) {
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch(`/api/tenant/services/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body?.message ?? body?.error ?? `Update failed (HTTP ${res.status})`)
    }
    await refresh(accessToken)
    return body as { ok: true; service: unknown }
  }

  async function deleteCustomService(id: string) {
    if (!accessToken) throw new Error('not signed in')
    const res = await fetch(`/api/tenant/services/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `Delete failed (HTTP ${res.status})`)
    }
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
            {tab === 'services' && (
              <ServicesTab
                data={data}
                onSave={patch}
                onCreateCustom={createCustomService}
                onUpdateCustom={updateCustomService}
                onDeleteCustom={deleteCustomService}
              />
            )}
            {tab === 'catalogue' && <CatalogueTab accessToken={accessToken} />}
            {tab === 'estimating' && <EstimatingTab accessToken={accessToken} />}
            {tab === 'recipes' && <RecipesTab accessToken={accessToken} />}
            {tab === 'quotes' && <QuotesTab data={data} />}
            {tab === 'followups' && (
              <FollowupsTab accessToken={accessToken} />
            )}
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
          className={`mx-auto flex items-center justify-between gap-2 sm:gap-4 px-4 sm:px-6 py-3 ${
            wide ? 'max-w-[88rem]' : 'max-w-7xl'
          }`}
        >
          <Link href="/dashboard" className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className="grid h-7 w-7 place-items-center bg-accent font-black text-white text-xs shrink-0">
              Q
            </span>
            {/* Brand wordmark hidden on the smallest screens — the
                Q-logo carries the brand and we need the row for the
                business name + profile chip + sign-out. */}
            <span className="hidden sm:inline font-extrabold uppercase tracking-tight text-text-pri shrink-0">
              QuoteMate
            </span>
            {businessName && (
              <>
                <span className="hidden sm:inline text-text-dim shrink-0">/</span>
                <span className="font-mono text-xs uppercase tracking-[0.14em] text-text-sec truncate max-w-[10rem] sm:max-w-none">
                  {businessName}
                </span>
              </>
            )}
          </Link>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
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
              aria-label="Sign out"
              className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-sec hover:text-text-pri transition-colors cursor-pointer px-2 py-2 -mx-2"
            >
              <LogOut
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0"
              />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </nav>
      <div
        className={`flex-1 mx-auto w-full px-4 sm:px-6 py-5 sm:py-6 ${
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
  const dotColour = active ? 'bg-emerald-300' : 'bg-amber-300'
  return (
    <div className="flex items-center gap-2.5 border border-ink-line bg-ink-card pl-1.5 pr-1.5 sm:pr-3 py-1">
      <div className="relative shrink-0">
        <span
          aria-hidden="true"
          className="grid h-7 w-7 place-items-center bg-accent/15 border border-accent/40 text-accent font-mono font-extrabold text-xs"
        >
          {initial}
        </span>
        {/* Mobile-only status dot — pinned to the avatar corner. The
            full pill below carries the same info for >= sm, so this
            badge is hidden then to avoid duplicate status indication. */}
        {status && (
          <span
            aria-hidden="true"
            className={`sm:hidden absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-ink-deep ${dotColour}`}
          />
        )}
      </div>
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
          className={`hidden sm:flex items-center gap-1.5 pl-2 ml-1 border-l border-ink-line font-mono text-[0.55rem] uppercase tracking-[0.16em] font-bold ${
            active ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${dotColour}`}
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
  /** Lucide icon component rendered to the left of the label. Picked
   *  to match a tradie's mental model: dashboard for overview,
   *  document for quotes, message bubble for chats, user for account,
   *  dollar sign for pricing, wrench (trade tools) for services. */
  icon: NavIcon
  /** Optional badge count rendered next to the label (e.g. quote count). */
  count?: number | null
}

function buildNav(quoteCount: number): NavItem[] {
  return [
    { tab: 'overview', label: 'Overview', icon: LayoutDashboard },
    { tab: 'quotes', label: 'Quotes', icon: FileText, count: quoteCount },
    { tab: 'followups', label: 'Follow-ups', icon: PhoneCall },
    { tab: 'chats', label: 'Chats', icon: MessageSquare },
    { tab: 'account', label: 'Account', icon: User },
    { tab: 'pricing', label: 'Pricing', icon: DollarSign },
    { tab: 'services', label: 'Services', icon: Wrench },
    { tab: 'catalogue', label: 'Catalogue', icon: Package },
    { tab: 'estimating', label: 'Estimating', icon: Calculator },
    { tab: 'recipes', label: 'Recipes', icon: ClipboardList },
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
            const Icon = item.icon
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
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      size={16}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="shrink-0"
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span
                      className={`font-mono text-[0.6rem] px-1.5 py-0.5 border shrink-0 ${
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
      // Horizontal-scroll bar keeps all six tabs on one line on
      // mobile (vs. wrapping to two cluttered rows). Scrollbar is
      // hidden in both Firefox and Chromium via arbitrary utilities;
      // the active tab is still tabbable + scrollable into view.
      className="lg:hidden -mx-4 sm:mx-0 flex overflow-x-auto whitespace-nowrap border-b border-ink-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Dashboard sections"
    >
      {items.map((item, i) => {
        const active = item.tab === tab
        const Icon = item.icon
        return (
          <button
            key={item.tab}
            type="button"
            onClick={() => setTab(item.tab)}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-3 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold transition-colors cursor-pointer ${
              i === 0 ? 'pl-4 sm:pl-0' : ''
            } ${
              active
                ? 'text-accent border-b-2 border-accent -mb-px'
                : 'text-text-dim hover:text-text-pri'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{item.label}</span>
            {typeof item.count === 'number' && item.count > 0 && (
              <span className="ml-1 text-text-sec">({item.count})</span>
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
      {/* HERO — compact QuoteMate number. Padding scales up from
          mobile so the card doesn't dominate small screens. */}
      <div className="bg-ink-card border border-ink-line p-4 sm:p-5 md:p-6 motion-safe:animate-[fade-up_240ms_ease-out_both]">
        <div className="flex flex-wrap items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <div className="font-mono text-[0.6rem] sm:text-[0.65rem] uppercase tracking-[0.18em] text-text-dim">
              Your QuoteMate number
            </div>
            {smsNumber ? (
              <div className="mt-1.5 sm:mt-2 font-mono text-[clamp(1.25rem,5vw,2rem)] font-bold text-text-pri tracking-tight leading-none break-all">
                {formatAuMobile(smsNumber)}
              </div>
            ) : (
              <div className="mt-2 text-amber-300 text-sm">
                Provisioning didn&rsquo;t finish on activate. Hit retry —
                your account + pricing book are saved.
              </div>
            )}
            {needsProvisioning && <RetryProvisionButton />}
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
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
              <span className="hidden sm:inline font-mono text-[0.55rem] uppercase tracking-[0.16em] text-text-dim">
                Activated {formatDate(tenant.activated_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* PIPELINE — money view. Lifted to the top (right under the
          QuoteMate number hero) because revenue + conversion are what
          the tradie actually opens the dashboard to check first. */}
      <section className="bg-ink-card border border-ink-line motion-safe:animate-[fade-up_280ms_ease-out_both]">
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

      {/* KPI ROW — operational state below the money. Numbered-card
          pattern (big orange mono value, uppercase label). Each tile
          carries its own fade-up so the row reveals smoothly on first
          mount. */}
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
      {/* v8 — early-booking discount. One card per tenant (the offer is
          trade-agnostic, written to every pricing_book row). */}
      <EarlyBirdCard books={books} onSave={onSave} />
    </div>
  )
}

// v8 Phase A — early-booking discount editor. Reads the current config
// from pricing_book.overlays.early_bird (identical across the tenant's
// rows) and saves via PATCH { early_bird: {...} }, which the /api/tenant/me
// route merges back into overlays on every row. The discount is a
// WHOLE-JOB reduction realised when the customer books a time before the
// offer window closes — see docs/strategy.md v8.
function EarlyBirdCard({
  books,
  onSave,
}: {
  books: PricingBook[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  // The offer is per-tenant — every pricing_book row carries the same
  // overlay, so read row 0.
  const current = useMemo(() => {
    const raw = books[0]?.overlays?.early_bird
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    return {
      enabled: o.enabled === true,
      discount_pct: numString(
        typeof o.discount_pct === 'number' ? o.discount_pct : 10,
      ),
      window_hours: numString(
        typeof o.window_hours === 'number' ? o.window_hours : 24,
      ),
    }
  }, [books])

  const [form, setForm] = useState(current)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const discountPct = Number(form.discount_pct)
      const windowHours = Number(form.window_hours)
      if (form.enabled && (!Number.isFinite(discountPct) || discountPct <= 0)) {
        throw new Error('Enter a discount between 0.1 and 15%.')
      }
      await onSave({
        early_bird: {
          enabled: form.enabled,
          // 0 when blank — schema floor. The 15% cap is enforced by the
          // PATCH schema AND lib/quote/early-bird.ts (margin guard).
          discount_pct: Number.isFinite(discountPct) ? discountPct : 0,
          window_hours: Number.isFinite(windowHours) && windowHours >= 1 ? windowHours : 24,
        },
      })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (books.length === 0) return null

  return (
    <Card
      title="Early-booking discount"
      subtitle="Reward customers who lock in a time fast. The discount comes off the whole job and is applied automatically when they book before the window closes."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Offer this discount">
          <label className="inline-flex items-center gap-3 mt-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="h-5 w-5 accent-accent"
            />
            <span className="text-sm text-text-sec">
              Show an early-booking discount on new quotes
            </span>
          </label>
        </Field>

        <div className="grid md:grid-cols-2 gap-5">
          <Field label="Discount" hint="0–15 % of the job total">
            <input
              type="number"
              step="0.5"
              min="0"
              max="15"
              value={form.discount_pct}
              onChange={(e) => setForm({ ...form, discount_pct: e.target.value })}
              className={INPUT}
              disabled={!form.enabled}
            />
          </Field>
          <Field label="Booking window" hint="Hours the offer stays open (1–336)">
            <input
              type="number"
              step="1"
              min="1"
              max="336"
              value={form.window_hours}
              onChange={(e) => setForm({ ...form, window_hours: e.target.value })}
              className={INPUT}
              disabled={!form.enabled}
            />
          </Field>
        </div>

        <p className="text-xs text-text-dim leading-relaxed">
          Capped at 15% to protect your margin. The discount is locked in
          server-side the moment the customer picks a time — if the window
          closes first, they pay the full price.
        </p>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        <div className="flex items-center justify-between pt-2">
          <SaveHint savedAt={savedAt} />
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save discount'}
          </button>
        </div>
      </form>
    </Card>
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
  onCreateCustom,
  onUpdateCustom,
  onDeleteCustom,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onCreateCustom: (payload: Record<string, unknown>) => Promise<unknown>
  onUpdateCustom: (id: string, payload: Record<string, unknown>) => Promise<unknown>
  onDeleteCustom: (id: string) => Promise<void>
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // When non-null → the inline create/edit form is visible. `null` =
  // hidden; `{}` = empty (creating); `{id, ...row}` = editing.
  const [formState, setFormState] = useState<EditingService | null>(null)
  // Expansion state per assembly_id. We keep a Set rather than a Map<bool>
  // so a row's row is either present (expanded) or absent (collapsed) — no
  // stale `false` entries to clean up.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggleExpand(assemblyId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(assemblyId)) next.delete(assemblyId)
      else next.add(assemblyId)
      return next
    })
  }

  // Hourly rate used to render the labour estimate inside the expanded
  // detail view. Falls back to the trade's pricing book; when a tenant
  // has multiple trades, we look up by the service's trade so the figure
  // matches whichever rate would be applied when the AI drafts a quote.
  function hourlyRateFor(trade: string): number | null {
    const book = data.pricing_books.find((p) => p.trade === trade)
    const rate = book?.hourly_rate
    if (rate === null || rate === undefined) return null
    const n = typeof rate === 'string' ? parseFloat(rate) : rate
    return Number.isFinite(n) ? n : null
  }

  const dirty = Object.keys(pending).length > 0

  // Persist EVERY toggle immediately (optimistic UI + write-through),
  // exactly like the Catalogue tab. The old model buffered changes in
  // `pending` and only wrote on a separate "Save" click, and a second
  // toggle of the same service deleted the pending change — so the AI
  // kept reading the stale DB state (the bug Jon hit: "I enabled it but
  // it still says not offered"). Writing on each toggle removes that
  // whole class of bug: what you see is what's saved.
  async function toggle(assemblyId: string, current: boolean) {
    if (busy) return // ignore rapid double-clicks while a save is in flight
    const svc = data.services.find((s) => s.assembly_id === assemblyId)
    const liveNow =
      pending[assemblyId] !== undefined ? pending[assemblyId] : current
    const nextVal = !liveNow
    // Optimistic flip so the switch responds instantly.
    setPending((p) => ({ ...p, [assemblyId]: nextVal }))
    setError(null)
    setBusy(true)
    try {
      const payload: Record<string, unknown> = svc?.is_custom
        ? { custom_services: { [assemblyId]: nextVal } }
        : { services: { [assemblyId]: nextVal } }
      await onSave(payload) // PATCH /api/tenant/me → upsert → re-fetch
      // onSave re-fetched authoritative data; drop the optimistic entry
      // so the switch now reflects the saved state.
      setPending((p) => {
        const n = { ...p }
        delete n[assemblyId]
        return n
      })
      setSavedAt(Date.now())
    } catch (e: any) {
      // Revert the optimistic flip.
      setPending((p) => {
        const n = { ...p }
        delete n[assemblyId]
        return n
      })
      setError(e?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveAll() {
    setError(null)
    setBusy(true)
    try {
      // Split pending toggles into shared (services key) vs custom
      // (custom_services key). The API writes each to a different
      // table — tenant_service_offerings for shared, the row itself
      // for custom (migration 023).
      const shared: Record<string, boolean> = {}
      const custom: Record<string, boolean> = {}
      for (const [id, enabled] of Object.entries(pending)) {
        const svc = data.services.find((s) => s.assembly_id === id)
        if (svc?.is_custom) custom[id] = enabled
        else shared[id] = enabled
      }
      const payload: Record<string, unknown> = {}
      if (Object.keys(shared).length > 0) payload.services = shared
      if (Object.keys(custom).length > 0) payload.custom_services = custom
      if (Object.keys(payload).length === 0) {
        // Nothing pending — bail out cleanly instead of sending {}
        return
      }
      await onSave(payload)
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
      {/* v7 Phase 1 banner — Jon's "everything is pre-populated, toggle on/off"
         framing made explicit. Always shown (informational, not dismissible);
         the enabledCount in the Card subtitle already encodes the state. */}
      <div className="border-l-2 border-l-accent/60 bg-ink-card/60 px-4 py-3">
        <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-accent mb-1">
          Catalogue · pre-populated
        </div>
        <div className="text-sm text-text-sec">
          Every standard service for <span className="font-mono">{tenantTrades.join(' + ') || '—'}</span>{' '}
          is loaded for you, with the easy-5 pre-ticked. Untick anything you don&rsquo;t do —
          customers can still book it as a $99 inspection, your AI just won&rsquo;t auto-draft a price.
        </div>
      </div>

      <Card
        title="Auto-quote services"
        subtitle={`Tick the work your AI can auto-quote. Unticked services still get inspections — they just won't auto-draft a price. ${enabledCount} of ${totalCount} enabled.`}
      >
        {/* Top-of-card actions — add a custom service. The form below
            handles both create and edit; opening it from here defaults
            to create-mode (no existing row pre-filled). */}
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
            {data.services.filter((s) => s.is_custom).length} custom service
            {data.services.filter((s) => s.is_custom).length === 1 ? '' : 's'} ·{' '}
            {data.services.filter((s) => !s.is_custom).length} catalogue
          </div>
          <button
            type="button"
            onClick={() =>
              setFormState(
                formState
                  ? null
                  : { mode: 'create', trade: tenantTrades[0] ?? 'electrical' },
              )
            }
            className="inline-flex items-center gap-2 border border-accent/60 text-accent hover:bg-accent/10 font-mono font-bold uppercase tracking-[0.14em] text-[0.7rem] px-3.5 py-2 transition-colors"
          >
            {formState ? '× Cancel' : '+ Add custom service'}
          </button>
        </div>

        {formState && (
          <div className="mb-6">
            <CustomServiceForm
              key={formState.mode === 'edit' ? `edit-${formState.id}` : 'create'}
              initial={formState}
              tenantTrades={tenantTrades}
              onCancel={() => setFormState(null)}
              onSubmit={async (payload) => {
                if (formState.mode === 'edit') {
                  await onUpdateCustom(formState.id, payload)
                } else {
                  await onCreateCustom(payload)
                }
                setFormState(null)
              }}
            />
          </div>
        )}

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
              const isOpen = expanded.has(svc.assembly_id)
              const hourly = hourlyRateFor(svc.trade)
              const labourCost =
                hours !== null && hourly !== null ? hours * hourly : null
              const baseTotal =
                price !== null || labourCost !== null
                  ? (price ?? 0) + (labourCost ?? 0)
                  : null
              // Was this row pending (uncommitted toggle)? Show a dot so
              // the tradie knows they have unsaved changes on this card.
              const isPending = pending[svc.assembly_id] !== undefined
              return (
                <div
                  key={svc.assembly_id}
                  className={`border transition-colors ${
                    live
                      ? 'border-accent/70 bg-accent/5'
                      : 'border-ink-line bg-ink-card'
                  }`}
                >
                  {/* Header — click to expand. Toggle button is separate
                      so it doesn't fire expand-on-press. */}
                  <button
                    type="button"
                    onClick={() => toggleExpand(svc.assembly_id)}
                    aria-expanded={isOpen ? 'true' : 'false'}
                    className="w-full flex items-start justify-between gap-4 px-4 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-text-dim transition-transform shrink-0 ${
                            isOpen ? 'rotate-90 text-accent' : ''
                          }`}
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        <span
                          className={`font-semibold text-sm ${
                            live ? 'text-text-pri' : 'text-text-sec'
                          }`}
                        >
                          {svc.name}
                        </span>
                        {isPending && (
                          <span
                            className="font-mono text-[0.55rem] uppercase tracking-[0.18em] text-accent shrink-0"
                            title="Unsaved change"
                          >
                            • unsaved
                          </span>
                        )}
                      </div>
                      {svc.description && !isOpen && (
                        <div className="mt-1 ml-5 text-xs text-text-sec leading-snug line-clamp-2">
                          {svc.description}
                        </div>
                      )}
                      <div className="ml-5 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {price !== null && (
                          <span>
                            ${price.toFixed(2)} {svc.default_unit ? `/ ${svc.default_unit}` : ''}
                          </span>
                        )}
                        {hours !== null && hours > 0 && <span>{hours}h labour</span>}
                        <span className="text-text-dim/70">{svc.trade}</span>
                        {/* Row-level inspection notice — visible WITHOUT expanding,
                            so toggling a job like induction-cooktop hardwiring ON
                            doesn't surprise the tradie. Display-only; reads the
                            existing always_inspection flag. */}
                        {svc.always_inspection && (
                          <span
                            className="font-mono text-[0.55rem] uppercase tracking-[0.18em] px-2 py-0.5 border border-warning/40 text-warning"
                            title="Always books a $99 paid inspection. Turning this on does NOT auto-price it — the AI tells the customer a site visit is needed."
                          >
                            inspection only
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Toggle switch — sharp-cornered to match the
                        Maintain brand language. role=switch + aria-checked
                        so it announces properly to screen readers. Click
                        propagation is stopped so flipping the switch
                        doesn't also expand the card. */}
                    <span
                      role="switch"
                      aria-checked={live}
                      aria-label={`${svc.name} — ${live ? 'enabled, click to turn off' : 'disabled, click to turn on'}`}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(svc.assembly_id, svc.enabled)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          toggle(svc.assembly_id, svc.enabled)
                        }
                      }}
                      className="shrink-0 inline-flex items-center gap-2.5 cursor-pointer group select-none"
                    >
                      <span
                        className={`relative inline-block h-5 w-10 border transition-colors ${
                          live
                            ? 'border-accent bg-accent/20'
                            : 'border-ink-line bg-ink-base group-hover:border-text-dim'
                        }`}
                      >
                        <span
                          className={`absolute top-[1px] h-[14px] w-[14px] transition-transform ${
                            live
                              ? 'translate-x-[22px] bg-accent'
                              : 'translate-x-[2px] bg-text-dim group-hover:bg-text-sec'
                          }`}
                        />
                      </span>
                      <span
                        className={`font-mono text-[0.65rem] uppercase tracking-[0.18em] font-bold transition-colors w-7 ${
                          live ? 'text-accent' : 'text-text-dim group-hover:text-text-sec'
                        }`}
                      >
                        {live ? 'On' : 'Off'}
                      </span>
                    </span>
                  </button>

                  {/* Expanded detail — full description, exclusions,
                      pricing breakdown using the tradie's hourly rate. */}
                  {isOpen && (
                    <div className="border-t border-ink-line/70 px-4 py-4 ml-5 mr-4 bg-ink-base/30 space-y-4 text-xs">
                      {svc.description && (
                        <div>
                          <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim mb-1">
                            What&rsquo;s included
                          </div>
                          <p className="text-sm text-text-sec leading-relaxed">
                            {svc.description}
                          </p>
                        </div>
                      )}

                      {svc.default_exclusions && (
                        <div>
                          <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-warning mb-1">
                            Excludes
                          </div>
                          <p className="text-sm text-text-sec leading-relaxed">
                            {svc.default_exclusions}
                          </p>
                        </div>
                      )}

                      {(price !== null || labourCost !== null) && (
                        <div>
                          <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim mb-2">
                            Base cost breakdown (ex-GST)
                          </div>
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-ink-line/40">
                              {price !== null && (
                                <tr>
                                  <td className="py-1.5 text-text-sec">
                                    Sundries / equipment
                                  </td>
                                  <td className="py-1.5 text-right font-mono text-text-pri">
                                    ${price.toFixed(2)}
                                    {svc.default_unit ? (
                                      <span className="text-text-dim"> / {svc.default_unit}</span>
                                    ) : null}
                                  </td>
                                </tr>
                              )}
                              {hours !== null && hours > 0 && (
                                <tr>
                                  <td className="py-1.5 text-text-sec">
                                    Labour estimate
                                    {hourly !== null ? (
                                      <span className="text-text-dim">
                                        {' '}
                                        — {hours}h × ${hourly}/h
                                      </span>
                                    ) : (
                                      <span className="text-text-dim">
                                        {' '}
                                        — {hours}h
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 text-right font-mono text-text-pri">
                                    {labourCost !== null
                                      ? `$${labourCost.toFixed(2)}`
                                      : '—'}
                                  </td>
                                </tr>
                              )}
                              {baseTotal !== null && labourCost !== null && (
                                <tr>
                                  <td className="py-1.5 text-text-pri font-semibold">
                                    Base total
                                  </td>
                                  <td className="py-1.5 text-right font-mono font-semibold text-accent">
                                    ${baseTotal.toFixed(2)}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                          <p className="mt-2 text-[0.65rem] text-text-dim leading-snug">
                            Materials and product cost are added on top by the AI when it
                            picks a tier-appropriate SKU. Markup
                            {data.pricing
                              ? ` (${data.pricing.default_markup_pct ?? 28}%)`
                              : ''}{' '}
                            and GST applied at quote time.
                          </p>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <span className="font-mono text-[0.55rem] uppercase tracking-[0.18em] px-2 py-1 border border-ink-line text-text-dim">
                          {svc.trade}
                        </span>
                        {svc.default_unit && (
                          <span className="font-mono text-[0.55rem] uppercase tracking-[0.18em] px-2 py-1 border border-ink-line text-text-dim">
                            per {svc.default_unit}
                          </span>
                        )}
                        {svc.is_custom && (
                          <span className="font-mono text-[0.55rem] uppercase tracking-[0.18em] px-2 py-1 border border-accent/40 text-accent">
                            custom
                          </span>
                        )}
                        <span
                          className={`font-mono text-[0.55rem] uppercase tracking-[0.18em] px-2 py-1 border ${
                            !live
                              ? 'border-ink-line text-text-dim'
                              : svc.always_inspection
                                ? 'border-warning/40 text-warning'
                                : 'border-accent/40 text-accent'
                          }`}
                        >
                          {!live
                            ? 'Off — not offered'
                            : svc.always_inspection
                              ? 'Always routes to paid inspection'
                              : 'AI will auto-quote'}
                        </span>
                      </div>

                      {/* Edit + Delete affordances for tenant-owned
                          custom rows. Shared catalogue rows aren't
                          editable from the dashboard — those are
                          curated at the platform level. */}
                      {svc.is_custom && (
                        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-ink-line/40 mt-2">
                          <button
                            type="button"
                            onClick={() =>
                              setFormState({
                                mode: 'edit',
                                id: svc.assembly_id,
                                trade: svc.trade,
                                name: svc.name,
                                description: svc.description ?? '',
                                default_unit: svc.default_unit ?? 'each',
                                default_unit_price_ex_gst:
                                  toNum(svc.default_unit_price_ex_gst) ?? 0,
                                default_labour_hours:
                                  toNum(svc.default_labour_hours) ?? 0,
                                default_exclusions: svc.default_exclusions ?? '',
                                always_inspection: svc.always_inspection,
                                enabled: svc.enabled,
                                category: svc.category ?? '',
                              })
                            }
                            className="inline-flex items-center gap-1.5 border border-ink-line text-text-sec hover:border-accent/60 hover:text-accent font-mono font-bold uppercase tracking-[0.14em] text-[0.65rem] px-3 py-1.5 transition-colors"
                          >
                            ✎ Edit
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Delete "${svc.name}"? Customers asking about this service will no longer get an auto-quote — they'll fall back to your $99 paid inspection.`,
                                )
                              ) {
                                return
                              }
                              try {
                                await onDeleteCustom(svc.assembly_id)
                              } catch (err: any) {
                                setError(err?.message ?? 'Delete failed')
                              }
                            }}
                            className="inline-flex items-center gap-1.5 border border-ink-line text-text-dim hover:border-warning/60 hover:text-warning font-mono font-bold uppercase tracking-[0.14em] text-[0.65rem] px-3 py-1.5 transition-colors"
                          >
                            ⌫ Delete
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
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

      {/* Preferred brands — migration 022. Per-category dropdown the
          tradie uses to bias the AI's material picks toward their
          supplier of choice. Soft hint only: if the customer needs a
          tier the preferred brand can't fulfil, the AI picks the best
          alternative regardless. */}
      <PreferredBrandsCard data={data} onSave={onSave} />

      {/* Inspection-only educational footer */}
      <Card title="Always require a site visit" subtitle="These jobs route to a $99 paid inspection regardless of toggles above. Your AI tells the customer up front.">
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

// ─── Preferred brands card ───────────────────────────────────────
//
// One row per (trade, category) — each row shows the category name,
// a dropdown of available brands, and a count of how many SKUs the
// tradie's selection will cover. Save batches all changes into a
// single PATCH /api/tenant/me call.

function categoryLabel(category: string): string {
  // Map snake_case slugs → human labels. Falls through to a title-cased
  // best-effort for any future category that wasn't pre-mapped.
  const labels: Record<string, string> = {
    downlight: 'Downlights',
    gpo: 'Power points (GPOs)',
    smoke_alarm: 'Smoke alarms',
    safety_switch: 'Safety switches',
    ceiling_fan: 'Ceiling fans',
    outdoor_light: 'Outdoor lights',
    hws_electric: 'Hot water — electric',
    hws_gas: 'Hot water — gas',
    hws_heat_pump: 'Hot water — heat pump',
    tapware_basin: 'Tapware — basin / bath',
    tapware_kitchen: 'Tapware — kitchen',
    tapware_laundry: 'Tapware — laundry',
    tapware_outdoor: 'Tapware — outdoor',
    toilet: 'Toilet suites',
    toilet_repair: 'Toilet repair parts',
    sundries: 'Sundries',
  }
  return labels[category] ?? category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function PreferredBrandsCard({
  data,
  onSave,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const initial = data.material_preferences ?? {}
  const [pending, setPending] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Group by trade so multi-trade tenants see two sections.
  const tenantTrades =
    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 0
      ? (data.tenant.trades as string[])
      : data.tenant.trade
        ? [data.tenant.trade]
        : []
  const showGrouped = tenantTrades.length > 1

  const grouped: Array<{ trade: string; rows: MaterialCategory[] }> =
    tenantTrades.map((t) => ({
      trade: t,
      rows: (data.material_categories ?? []).filter((c) => c.trade === t),
    }))

  const totalCategories = (data.material_categories ?? []).length
  if (totalCategories === 0) {
    // Migration 022 hasn't run yet (or no branded SKUs in catalogue).
    // Render nothing — silently degrades for legacy environments.
    return null
  }

  function liveValue(category: string): string {
    if (pending[category] !== undefined) return pending[category]
    return initial[category] ?? ''
  }

  function change(category: string, value: string) {
    setPending((prev) => {
      const next = { ...prev }
      // If the selection is reverting to whatever was saved, drop it
      // from `pending` so the dirty count is accurate.
      if ((initial[category] ?? '') === value) {
        delete next[category]
      } else {
        next[category] = value
      }
      return next
    })
  }

  async function saveAll() {
    setError(null)
    setBusy(true)
    try {
      // Empty-string values become null (clears the preference).
      const payload: Record<string, string | null> = {}
      for (const [cat, val] of Object.entries(pending)) {
        payload[cat] = val === '' ? null : val
      }
      await onSave({ material_preferences: payload })
      setPending({})
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const dirty = Object.keys(pending).length > 0
  const setCount = Object.values({ ...initial, ...pending }).filter((v) => !!v).length

  return (
    <Card
      title="Preferred brands"
      subtitle={`Your AI quote draft will lean toward these brands when the customer's tier and specs allow. Soft hint — never starves a quote. ${setCount} of ${totalCategories} categories set.`}
    >
      <div className="space-y-6">
        {grouped.map(({ trade, rows }) => {
          if (rows.length === 0) return null
          return (
            <div key={trade} className="space-y-2">
              {showGrouped && (
                <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent font-bold pt-1 pb-1">
                  {tradeLabel(trade as 'electrical' | 'plumbing')}
                </div>
              )}
              <div className="grid sm:grid-cols-2 gap-2">
                {rows.map((row) => {
                  const value = liveValue(row.category)
                  const isSet = value !== ''
                  return (
                    <label
                      key={`${row.trade}::${row.category}`}
                      className={`flex flex-col gap-2 px-4 py-3 border transition-colors ${
                        isSet
                          ? 'border-accent/40 bg-accent/[0.04]'
                          : 'border-ink-line bg-ink-card'
                      }`}
                    >
                      <span className="text-sm font-semibold text-text-pri">
                        {categoryLabel(row.category)}
                      </span>
                      <select
                        value={value}
                        onChange={(e) => change(row.category, e.target.value)}
                        className="bg-ink-base border border-ink-line text-text-pri text-sm px-3 py-2 focus:outline-none focus:border-accent"
                      >
                        <option value="">Any (use catalogue default)</option>
                        {row.brands.map((brand) => (
                          <option key={brand} value={brand}>
                            {brand}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                })}
              </div>
            </div>
          )
        })}
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
  )
}

// ─── Custom service form (create + edit) ───────────────────────────
//
// Single form component used in two modes:
//   mode='create' → seeded blank (with the tenant's trade pre-picked)
//   mode='edit'   → pre-filled from an existing tenant_custom_assemblies row
// On submit, the parent decides whether to POST (create) or PATCH (edit).
// The form does its own input validation matching CustomServiceSchema
// on the server, so the user gets fast feedback before the round-trip.

type EditingService =
  | {
      mode: 'create'
      trade: string
      name?: string
      description?: string
      default_unit?: string
      default_unit_price_ex_gst?: number
      default_labour_hours?: number
      default_exclusions?: string
      always_inspection?: boolean
      enabled?: boolean
      category?: string
    }
  | {
      mode: 'edit'
      id: string
      trade: string
      name: string
      description: string
      default_unit: string
      default_unit_price_ex_gst: number
      default_labour_hours: number
      default_exclusions: string
      always_inspection: boolean
      enabled: boolean
      category: string
    }

function CustomServiceForm({
  initial,
  tenantTrades,
  onCancel,
  onSubmit,
}: {
  initial: EditingService
  tenantTrades: string[]
  onCancel: () => void
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [trade, setTrade] = useState(initial.trade)
  const [name, setName] = useState(initial.mode === 'edit' ? initial.name : '')
  const [description, setDescription] = useState(
    initial.mode === 'edit' ? initial.description : '',
  )
  const [defaultUnit, setDefaultUnit] = useState(
    initial.mode === 'edit' ? initial.default_unit : 'each',
  )
  const [priceStr, setPriceStr] = useState(
    initial.mode === 'edit' ? String(initial.default_unit_price_ex_gst) : '',
  )
  const [hoursStr, setHoursStr] = useState(
    initial.mode === 'edit' ? String(initial.default_labour_hours) : '',
  )
  const [exclusions, setExclusions] = useState(
    initial.mode === 'edit' ? initial.default_exclusions : '',
  )
  const [alwaysInspection, setAlwaysInspection] = useState(
    initial.mode === 'edit' ? initial.always_inspection : false,
  )
  // Explicit grounding category (migration 029). '' = auto-detect from
  // the service name (the safe default — see lib/estimate/categories).
  const [category, setCategory] = useState(
    initial.mode === 'edit' ? (initial.category ?? '') : '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEditing = initial.mode === 'edit'
  const canChangeTrade = tenantTrades.length > 1

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const trimmedName = name.trim()
    if (trimmedName.length < 2) {
      setError('Service name must be at least 2 characters.')
      return
    }
    const price = Number(priceStr)
    if (!Number.isFinite(price) || price < 0) {
      setError('Default price must be a positive number.')
      return
    }
    const hours = hoursStr.trim() === '' ? 0 : Number(hoursStr)
    if (!Number.isFinite(hours) || hours < 0 || hours > 80) {
      setError('Labour hours must be a number between 0 and 80.')
      return
    }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        trade,
        name: trimmedName,
        description: description.trim(),
        default_unit: defaultUnit.trim() || 'each',
        default_unit_price_ex_gst: price,
        default_labour_hours: hours,
        default_exclusions: exclusions.trim(),
        always_inspection: alwaysInspection,
        // '' is accepted by CustomServiceSchema (→ null → name-regex
        // fallback). Sent on every submit so an edit can also CLEAR it.
        category,
      }
      await onSubmit(payload)
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-accent/40 bg-accent/[0.04] p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3 border-b border-ink-line/60 pb-3">
        <div className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-accent font-bold">
          {isEditing ? 'Edit custom service' : 'New custom service'}
        </div>
        {canChangeTrade ? (
          <select
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            aria-label="Trade for this service"
            className="bg-ink-base border border-ink-line text-text-pri text-xs font-mono uppercase tracking-[0.14em] px-2.5 py-1.5 focus:outline-none focus:border-accent"
          >
            {tenantTrades.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.16em] text-text-dim">
            {trade}
          </span>
        )}
      </div>

      <FormField label="Service name" required>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="e.g. Install pool light"
          className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
      </FormField>

      <FormField label="Description" hint="What's included. Shown to customers on quotes.">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Mount, terminate, test on existing circuit"
          className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent resize-y"
        />
      </FormField>

      <FormField
        label="Grounding category"
        hint="How the AI matches this service when pricing a quote. Leave on auto-detect unless the AI keeps sending this job to a $99 inspection."
      >
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Grounding category for this service"
          className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
        >
          <option value="">Auto-detect from name (recommended)</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </FormField>

      <div className="grid sm:grid-cols-3 gap-3">
        <FormField label="Unit" hint="each / metre / lot">
          <input
            type="text"
            value={defaultUnit}
            onChange={(e) => setDefaultUnit(e.target.value)}
            maxLength={30}
            placeholder="each"
            className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
          />
        </FormField>
        <FormField label="Sundries / equipment price (ex-GST)" required>
          <input
            type="number"
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            min={0}
            max={100000}
            step="0.01"
            required
            placeholder="80.00"
            className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
          />
        </FormField>
        <FormField label="Default labour hours">
          <input
            type="number"
            value={hoursStr}
            onChange={(e) => setHoursStr(e.target.value)}
            min={0}
            max={80}
            step="0.25"
            placeholder="2.0"
            className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
          />
        </FormField>
      </div>

      <FormField label="Excludes" hint="What this price doesn't cover.">
        <textarea
          value={exclusions}
          onChange={(e) => setExclusions(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Excludes new wiring runs and ceiling repair"
          className="w-full bg-ink-base border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent resize-y"
        />
      </FormField>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={alwaysInspection}
          onChange={(e) => setAlwaysInspection(e.target.checked)}
          className="mt-1 accent-warning"
        />
        <span className="text-sm">
          <span className="text-text-pri font-semibold">Always route to paid inspection</span>
          <span className="block text-xs text-text-dim mt-0.5">
            When ticked, the AI will never auto-quote this service. Customers
            asking about it get the $99 paid inspection instead. Useful for
            jobs where conditions vary too much for a flat rate.
          </span>
        </span>
      </label>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex items-center justify-end gap-2 border-t border-ink-line/60 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="border border-ink-line text-text-sec hover:text-text-pri font-mono font-bold uppercase tracking-[0.14em] text-[0.7rem] px-4 py-2 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2 text-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : isEditing ? 'Save changes' : 'Add service'}
        </button>
      </div>
    </form>
  )
}

function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[0.6rem] uppercase tracking-[0.16em] text-text-dim mb-1.5">
        {label}
        {required && <span className="text-accent ml-1">*</span>}
      </span>
      {children}
      {hint && (
        <span className="block mt-1 text-[0.65rem] text-text-dim/80 leading-snug">
          {hint}
        </span>
      )}
    </label>
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
            className="inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-5 py-3 min-h-[44px] transition-colors cursor-pointer w-full sm:w-auto justify-center"
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
        className="w-full text-left flex items-center justify-between gap-3 sm:gap-4 px-4 sm:px-5 py-3.5 hover:bg-ink-deep/40 transition-colors cursor-pointer"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap">
            <span className="font-extrabold text-base text-text-pri tracking-tight truncate">
              {customerLabel}
            </span>
            {q.channel && <ChannelBadge channel={q.channel} />}
            {/* Suburb hidden < sm so the customer name + channel pill
                fit the line. It's still in the expanded metadata grid. */}
            {q.suburb && (
              <span className="hidden sm:inline font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
                · {q.suburb}
              </span>
            )}
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-text-sec truncate">
              · {formatJobType(q.job_type)}
            </span>
            {/* Trade label only when actually relevant (multi-trade) +
                large enough to fit. */}
            {isMultiTrade && trade && (
              <span className="hidden sm:inline font-mono text-[0.6rem] uppercase tracking-[0.14em] text-accent font-bold">
                · {tradeLabel(trade)}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2 sm:gap-3">
          {/* Primary status pill hidden < sm — kept inside the expanded
              body. Avoids the right rail outgrowing the price. */}
          {primaryBadge && (
            <span
              className={`hidden sm:inline-flex items-center font-mono text-[0.55rem] uppercase tracking-[0.14em] font-bold px-2 py-0.5 border ${
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
            <div className="font-mono text-base sm:text-lg font-extrabold text-text-pri leading-none tabular-nums">
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
                  className="inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-4 py-3 text-xs uppercase tracking-wider transition-colors min-h-[44px] w-full sm:w-auto"
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

// ─── Follow-ups tab (WP7) ─────────────────────────────────────────
//
// The "setter" queue: customers who received a quote but did NOT accept
// it, stale enough to chase, oldest-first. A VA opens this tab and can
// immediately see who to contact, why, the quote summary, and a direct
// tap-to-call / tap-to-text path — then "Mark contacted" to clear it.
// Data + filtering come from /api/tenant/followups (single-sourced with
// the unit-tested lib/quote/followup.ts selector).

type FollowupItem = {
  quote_id: string
  share_token: string | null
  status: string | null
  followup_reason: string
  last_activity: string | null
  age_hours: number | null
  total_inc_gst: number | null
  selected_tier: string | null
  job_type: string | null
  needs_inspection: boolean
  scope_of_works: string | null
  followed_up_at: string | null
  followup_note: string | null
  customer: {
    first_name: string | null
    full_name: string | null
    phone: string | null
    suburb: string | null
    email: string | null
  }
}

function fmtAgeHours(h: number | null): string {
  if (h === null || !Number.isFinite(h)) return 'unknown'
  if (h < 48) return `${Math.max(0, Math.round(h))}h ago`
  return `${Math.round(h / 24)}d ago`
}

function fmtAUD(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `$${Math.round(n).toLocaleString('en-AU')}`
}

function fmtJobType(j: string | null): string {
  if (!j) return 'Job'
  return j.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── WP2 · Operator product catalogue tab ─────────────────────────
// Self-contained (mirrors FollowupsTab): takes the bearer accessToken,
// does its own fetches against /api/tenant/catalogue. Lets a tradie
// list / add / on-off toggle / delete their branded products. The
// brand+range -> tier mapping the estimator uses is shown per row.
type CatalogueRow = {
  id: string
  trade: string
  category: string
  name: string
  brand: string | null
  range_series: string | null
  supplier: string | null
  unit: string | null
  unit_price_ex_gst: number | string
  customer_supply_price_ex_gst: number | string | null
  cost_price_ex_gst: number | string | null
  description: string | null
  tier_hint: 'good' | 'better' | 'best' | null
  image_path: string | null
  is_preferred: boolean
  active: boolean
}

// v7 Phase 2b — supplier_catalogue row shape returned by
// GET /api/supplier-catalogue (a subset of the table's columns; pricing
// + tier_hint + image carry through for the browse UI).
type SupplierCatalogueRow = {
  id: string
  trade: string
  category: string
  brand: string
  range_series: string | null
  name: string
  supplier_label: string | null
  default_unit: string
  default_unit_price_ex_gst: number | string
  tier_hint: 'good' | 'better' | 'best' | null
  image_url: string | null
  description: string | null
  supplier_revision: number
}

// CSV bulk-upload into the shared supplier_catalogue. Two-phase: a
// dry-run POST returns the new/already-in-library/error split, then a
// commit POST writes. Insert-only on the server (collisions are skipped),
// rows tagged source='tenant_csv'. Rendered at the top of
// BrowseSupplierPanel; calls onImported() so the browse list refreshes.
type CsvDryRun = {
  summary: {
    totalDataRows: number
    validRows: number
    errorRows: number
    toInsert: number
    alreadyInLibrary: number
    maxRows: number
  }
  errors: Array<{ line: number; column: string; message: string }>
}

function SupplierCsvUpload({
  accessToken,
  onImported,
}: {
  accessToken: string | null
  onImported: () => void
}) {
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [csvText, setCsvText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<CsvDryRun | null>(null)
  const [alsoStock, setAlsoStock] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function reset() {
    setFileName(null)
    setCsvText(null)
    setReport(null)
    setMsg(null)
    setErr(null)
  }

  async function callImport(text: string, dryRun: boolean): Promise<unknown> {
    const res = await fetch('/api/supplier-catalogue/import', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ csvText: text, dryRun, alsoStockMine: alsoStock }),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !json.ok) {
      throw new Error((json.error as string) || `HTTP ${res.status}`)
    }
    return json
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file || !accessToken) return
    reset()
    setBusy(true)
    try {
      const text = await file.text()
      setFileName(file.name)
      setCsvText(text)
      const json = (await callImport(text, true)) as CsvDryRun
      setReport(json)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  async function onCommit() {
    if (!csvText || !accessToken) return
    setBusy(true)
    setErr(null)
    try {
      const json = (await callImport(csvText, false)) as {
        inserted: number
        stockedToMyCatalogue: { stocked: number; skipped: number } | null
      }
      const stockedNote = json.stockedToMyCatalogue
        ? ` · ${json.stockedToMyCatalogue.stocked} added to your catalogue`
        : ''
      setMsg(
        `Imported ${json.inserted} new product(s) to the supplier library${stockedNote}.`,
      )
      setReport(null)
      setFileName(null)
      setCsvText(null)
      onImported()
    } catch (e2) {
      setErr(`Import failed: ${e2 instanceof Error ? e2.message : String(e2)}`)
    } finally {
      setBusy(false)
    }
  }

  const canCommit =
    !!report &&
    !busy &&
    (report.summary.toInsert > 0 || (alsoStock && report.summary.validRows > 0))

  return (
    <div className="border border-ink-line bg-ink-deep">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold text-text-pri hover:text-accent transition-colors cursor-pointer"
        >
          {open ? '▲' : '▼'} Upload products via CSV
        </button>
        <a
          href="/docs/supplier-catalogue-template.csv"
          download
          className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim hover:text-accent transition-colors"
        >
          ↓ Download CSV template
        </a>
      </div>

      {open && (
        <div className="border-t border-ink-line px-4 py-4 space-y-4">
          <p className="text-xs text-text-sec leading-snug">
            Bulk-add products to the shared supplier catalogue. Columns:{' '}
            <span className="font-mono text-text-dim">
              trade, category, brand, name, default_unit_price_ex_gst
            </span>{' '}
            (required) + range_series, supplier_label, default_unit, tier_hint,
            image_url, description. Uploaded products become browsable here for
            you to add to your catalogue.
          </p>

          <div>
            <label className="inline-flex items-center gap-2 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors cursor-pointer">
              {busy && !report ? 'Reading…' : 'Choose CSV file'}
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void onPickFile(e)}
                disabled={busy}
                className="hidden"
              />
            </label>
            {fileName && (
              <span className="ml-3 text-xs text-text-dim font-mono">{fileName}</span>
            )}
          </div>

          {err && (
            <div className="bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line px-3 py-2 text-sm text-text-sec">
              {err}
            </div>
          )}
          {msg && (
            <div className="bg-ink-card border-l-2 border-l-accent border-y border-r border-ink-line px-3 py-2 text-sm text-accent">
              {msg}
            </div>
          )}

          {report && (
            <div className="space-y-3">
              {/* Dry-run summary. */}
              <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.65rem] uppercase tracking-[0.14em]">
                <span className="text-accent">{report.summary.toInsert} new</span>
                <span className="text-text-dim">
                  {report.summary.alreadyInLibrary} already in library
                </span>
                <span
                  className={
                    report.summary.errorRows > 0 ? 'text-warning' : 'text-text-dim'
                  }
                >
                  {report.summary.errorRows} row error(s)
                </span>
                <span className="text-text-dim">
                  {report.summary.totalDataRows} data row(s) read
                </span>
              </div>

              {/* Row errors — bounded scroll list. */}
              {report.errors.length > 0 && (
                <div className="bg-ink-card border border-ink-line max-h-44 overflow-y-auto">
                  {report.errors.map((e, i) => (
                    <div
                      key={`${e.line}-${e.column}-${i}`}
                      className="px-3 py-1.5 text-xs text-text-sec border-b border-ink-line/50 last:border-b-0"
                    >
                      <span className="font-mono text-text-dim">
                        line {e.line}
                        {e.column ? ` · ${e.column}` : ''}
                      </span>{' '}
                      — {e.message}
                    </div>
                  ))}
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-text-sec cursor-pointer">
                <input
                  type="checkbox"
                  checked={alsoStock}
                  onChange={(e) => setAlsoStock(e.target.checked)}
                  className="cursor-pointer"
                />
                Also add every uploaded product to my catalogue
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={() => void onCommit()}
                  className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? 'Importing…' : `Confirm import (${report.summary.toInsert} new)`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={reset}
                  className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim hover:text-text-pri transition-colors cursor-pointer disabled:opacity-40"
                >
                  Cancel
                </button>
                {report.summary.toInsert === 0 && (
                  <span className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-text-dim">
                    no new products — all rows already in the library
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// v7 Phase 2b — "Browse supplier catalogue" panel rendered inside
// CatalogueTab when viewMode === 'browse'. Self-contained: own fetch,
// own filters (trade / category / brand), multi-select state, and a
// single "Add N selected to my catalogue" action that POSTs to
// /api/tenant/catalogue/bulk-add and calls onAdded() so the parent
// can refresh its own list.
function BrowseSupplierPanel({
  accessToken,
  onAdded,
}: {
  accessToken: string | null
  onAdded: () => void
}) {
  const [supplierRows, setSupplierRows] = useState<SupplierCatalogueRow[] | null>(null)
  const [alreadyStocked, setAlreadyStocked] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState<string | null>(null)
  const [tradeFilter, setTradeFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [brandFilter, setBrandFilter] = useState<string>('all')
  // Per-row expand/collapse — present = expanded. We use a Set instead of
  // a Map<bool> so a row is either present (expanded) or absent (collapsed);
  // no stale `false` entries to garbage-collect.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Load the supplier rows + already-stocked link set once on mount.
  // Re-runs after a successful bulk-add (parent calls onAdded which
  // refreshes the My-catalogue list; the browse view re-fetches too so
  // the "already in your catalogue" badge updates immediately).
  const load = useCallback(async () => {
    if (!accessToken) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/supplier-catalogue', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        supplier_rows: SupplierCatalogueRow[]
        already_stocked: string[]
      }
      setSupplierRows(json.supplier_rows)
      setAlreadyStocked(new Set(json.already_stocked))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function addSelected() {
    if (selected.size === 0 || !accessToken) return
    setAdding(true)
    setAddMsg(null)
    try {
      const res = await fetch('/api/tenant/catalogue/bulk-add', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ supplier_catalogue_ids: [...selected] }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        added?: number
        total?: number
        results?: Array<{ supplier_catalogue_id: string; status: string; error?: string }>
        error?: string
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      const partialFails = (json.results ?? []).filter(
        (r) => r.status !== 'added' && r.status !== 'already_stocked',
      )
      setAddMsg(
        partialFails.length === 0
          ? `Added ${json.added} of ${json.total} to your catalogue.`
          : `Added ${json.added}; ${partialFails.length} failed (${partialFails[0]?.status}).`,
      )
      setSelected(new Set())
      await load()
      onAdded()
    } catch (e) {
      setAddMsg(`Add failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdding(false)
    }
  }

  const rows = supplierRows ?? []
  // Filter chips' option lists. We compute these off the UNFILTERED
  // rows so the chip labels stay stable as the user narrows the view.
  const trades = Array.from(new Set(rows.map((r) => r.trade))).sort()
  const categoriesByTrade = (() => {
    const visible =
      tradeFilter === 'all' ? rows : rows.filter((r) => r.trade === tradeFilter)
    return Array.from(new Set(visible.map((r) => r.category))).sort()
  })()
  const brandsByTradeCat = (() => {
    const visible = rows
      .filter((r) => tradeFilter === 'all' || r.trade === tradeFilter)
      .filter((r) => categoryFilter === 'all' || r.category === categoryFilter)
    return Array.from(new Set(visible.map((r) => r.brand))).sort()
  })()
  const filtered = rows
    .filter((r) => tradeFilter === 'all' || r.trade === tradeFilter)
    .filter((r) => categoryFilter === 'all' || r.category === categoryFilter)
    .filter((r) => brandFilter === 'all' || r.brand === brandFilter)

  if (loading) {
    return (
      <div className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim py-10">
        Loading supplier catalogue…
      </div>
    )
  }
  if (err) {
    return (
      <div className="mt-4 bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-2">
          Couldn&apos;t load supplier catalogue
        </div>
        <p className="text-sm text-text-sec">{err}</p>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="mt-4 space-y-4">
        <SupplierCsvUpload accessToken={accessToken} onImported={() => void load()} />
        <div className="bg-ink-card/40 border border-dashed border-ink-line p-6">
          <p className="text-sm text-text-sec">
            The supplier catalogue is empty for your trade(s). Upload a CSV above to
            populate it, or ask QuoteMate to add a brand.
          </p>
        </div>
      </div>
    )
  }

  const fmtMoney = (v: number | string) => {
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'
  }

  return (
    <div className="mt-4 space-y-4">
      {/* CSV bulk-upload — populate the shared library faster than ticking
         rows one by one. After a commit, load() refreshes this list. */}
      <SupplierCsvUpload accessToken={accessToken} onImported={() => void load()} />

      {/* Filter chips. */}
      <div className="flex flex-wrap items-center gap-2 text-[0.65rem] font-mono uppercase tracking-[0.14em]">
        {trades.length > 1 && (
          <>
            <span className="text-text-dim">Trade:</span>
            {['all', ...trades].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTradeFilter(t)
                  setCategoryFilter('all')
                  setBrandFilter('all')
                }}
                className={`px-2 py-1 border transition-colors cursor-pointer ${
                  tradeFilter === t
                    ? 'border-accent text-accent'
                    : 'border-ink-line text-text-dim hover:text-text-pri'
                }`}
              >
                {t}
              </button>
            ))}
            <span className="text-text-dim/40">·</span>
          </>
        )}
        <span className="text-text-dim">Category:</span>
        {['all', ...categoriesByTrade].map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setCategoryFilter(c)
              setBrandFilter('all')
            }}
            className={`px-2 py-1 border transition-colors cursor-pointer ${
              categoryFilter === c
                ? 'border-accent text-accent'
                : 'border-ink-line text-text-dim hover:text-text-pri'
            }`}
          >
            {c}
          </button>
        ))}
        {brandsByTradeCat.length > 1 && (
          <>
            <span className="text-text-dim/40">·</span>
            <span className="text-text-dim">Brand:</span>
            {['all', ...brandsByTradeCat].map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBrandFilter(b)}
                className={`px-2 py-1 border transition-colors cursor-pointer ${
                  brandFilter === b
                    ? 'border-accent text-accent'
                    : 'border-ink-line text-text-dim hover:text-text-pri'
                }`}
              >
                {b}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Action bar — sticky at the top of the list when items are selected. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-ink-line bg-ink-deep px-4 py-3">
        <div className="text-xs text-text-sec">
          {filtered.length} matching · <span className="text-text-pri font-semibold">{selected.size} selected</span>
        </div>
        <div className="flex items-center gap-3">
          {addMsg && (
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-accent">
              {addMsg}
            </span>
          )}
          <button
            type="button"
            disabled={selected.size === 0 || adding}
            onClick={() => void addSelected()}
            className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {adding ? 'Adding…' : `+ Add ${selected.size || ''} to my catalogue`}
          </button>
        </div>
      </div>

      {/* Rows. */}
      <div className="space-y-1">
        {filtered.map((r) => {
          const stocked = alreadyStocked.has(r.id)
          const isSelected = selected.has(r.id)
          const isExpanded = expanded.has(r.id)
          return (
            <div
              key={r.id}
              className={`border transition-colors ${
                isSelected
                  ? 'border-accent bg-accent/5'
                  : stocked
                    ? 'border-ink-line bg-ink-card/40 opacity-80'
                    : 'border-ink-line hover:border-accent/40'
              }`}
            >
              {/* Compact top row — checkbox + name + summary + expand chevron.
                 We keep the checkbox in its own <label> so it remains an
                 accessible click target without the chevron bubbling. */}
              <div className="flex items-start gap-3 px-3 py-2">
                <label className="flex items-start gap-3 cursor-pointer flex-1 min-w-0">
                  <input
                    type="checkbox"
                    disabled={stocked}
                    checked={isSelected}
                    onChange={() => toggleSelect(r.id)}
                    className="mt-1 cursor-pointer disabled:cursor-not-allowed"
                    aria-label={`Select ${r.name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm text-text-pri font-medium">{r.name}</span>
                      {r.tier_hint && (
                        <span className="font-mono text-[0.55rem] uppercase tracking-[0.15em] text-text-dim border border-ink-line px-1.5 py-0.5">
                          {r.tier_hint}
                        </span>
                      )}
                      {stocked && (
                        <span className="font-mono text-[0.55rem] uppercase tracking-[0.15em] text-accent border border-accent/40 px-1.5 py-0.5">
                          ✓ in your catalogue
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim mt-1">
                      {r.brand}
                      {r.range_series ? ` · ${r.range_series}` : ''} · {r.category} ·
                      {r.supplier_label ? ` ${r.supplier_label} · ` : ' '}
                      {fmtMoney(r.default_unit_price_ex_gst)} ex GST RRP
                    </div>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={() => toggleExpand(r.id)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? `Hide details for ${r.name}` : `Show details for ${r.name}`}
                  className="shrink-0 mt-0.5 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim hover:text-accent transition-colors cursor-pointer px-2 py-1"
                >
                  {isExpanded ? '▲ Hide' : '▼ Details'}
                </button>
              </div>

              {/* Expanded details — mirrors the My Catalogue field set
                 (Trade, Category, Name, Brand, Range, Supplier, Unit, RRP,
                 Tier, Description, Image). Three fields exist only on the
                 tenant side (customer-supply price, cost price, is_preferred)
                 — they're called out at the bottom so the tradie knows what
                 they'll set after "Add to my catalogue". */}
              {isExpanded && (
                <div className="px-3 pb-3 pt-1 border-t border-ink-line/60 bg-ink-deep/40">
                  <div className="grid gap-4 sm:grid-cols-[auto_1fr] mt-3">
                    {/* Product image — left column. Falls back to a typed
                        placeholder when supplier hasn't supplied a URL. */}
                    <div className="w-28 h-28 sm:w-32 sm:h-32 border border-ink-line bg-ink-card/40 flex items-center justify-center overflow-hidden">
                      {r.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.image_url}
                          alt={r.name}
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <span className="font-mono text-[0.55rem] uppercase tracking-[0.14em] text-text-dim text-center px-2">
                          no photo
                          <br />
                          on file
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <SupplierField label="Trade" value={r.trade} mono />
                      <SupplierField label="Category" value={r.category} mono />
                      <SupplierField label="Brand" value={r.brand} />
                      <SupplierField label="Range / series" value={r.range_series} />
                      <SupplierField label="Supplier" value={r.supplier_label} />
                      <SupplierField label="Unit" value={r.default_unit} mono />
                      <SupplierField
                        label="Supplier RRP ex-GST"
                        value={fmtMoney(r.default_unit_price_ex_gst)}
                      />
                      <SupplierField label="Tier" value={r.tier_hint ?? null} mono />
                    </div>
                  </div>
                  {r.description && (
                    <div className="mt-3">
                      <div className="font-mono text-[0.55rem] uppercase tracking-[0.15em] text-text-dim mb-1">
                        Description
                      </div>
                      <div className="text-sm text-text-sec leading-snug">{r.description}</div>
                    </div>
                  )}
                  {/* Footer note — the three tradie-only fields that don't
                     exist on supplier rows. Surfacing this explicitly stops
                     the tradie wondering "where's the cost price?" — it's
                     a field they fill in once the row lands in My Catalogue. */}
                  <div className="mt-4 border-l-2 border-l-accent/40 pl-3 py-1">
                    <div className="font-mono text-[0.55rem] uppercase tracking-[0.15em] text-accent mb-1">
                      You&rsquo;ll set after &ldquo;Add to my catalogue&rdquo;
                    </div>
                    <div className="text-xs text-text-sec leading-snug">
                      Your sell price (defaults to RRP — editable) · customer-supply price (install-only) ·
                      cost price (your margin insight) · &ldquo;preferred&rdquo; flag · your own photo upload.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Compact key/value row used inside the expanded supplier-card details.
// Centralised so the eight fields render with identical typography +
// fallback (em-dash for nulls). Kept local — the only consumer is the
// Browse Supplier Catalogue expanded view above.
function SupplierField({
  label,
  value,
  mono,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
}) {
  const shown = value !== null && value !== undefined && String(value).trim() !== ''
  return (
    <div className="min-w-0">
      <div className="font-mono text-[0.55rem] uppercase tracking-[0.15em] text-text-dim mb-0.5">
        {label}
      </div>
      <div
        className={`${mono ? 'font-mono text-[0.75rem]' : 'text-sm'} text-text-pri leading-snug truncate`}
        title={shown ? String(value) : undefined}
      >
        {shown ? String(value) : <span className="text-text-dim/60">—</span>}
      </div>
    </div>
  )
}

// v7 Phase 3 — Per-category Good/Better/Best ladder picker.
// Sourced from tenant_tier_ladder (migration 043) joined with the
// tenant's active tenant_material_catalogue rows for label rendering.
// Self-contained: own fetch, own writes via POST/DELETE
// /api/tenant/tier-ladder. The estimator path reads the same rows
// through buildCatalogueHint() (run.ts) and chooseMaterial() (Phase 3
// wiring), so the picker IS the source of truth.
type LadderRow = {
  category: string
  tier: 'good' | 'better' | 'best'
  catalogue_id: string
  updated_at: string
}
type LadderCatalogueRow = {
  id: string
  trade: string
  category: string
  name: string
  brand: string | null
  range_series: string | null
  tier_hint: 'good' | 'better' | 'best' | null
}

function TierLadderPanel({ accessToken }: { accessToken: string | null }) {
  const [ladder, setLadder] = useState<LadderRow[] | null>(null)
  const [catalogueByCategory, setCatalogueByCategory] = useState<
    Record<string, LadderCatalogueRow[]>
  >({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/tenant/tier-ladder', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        ladder: LadderRow[]
        catalogue_by_category: Record<string, LadderCatalogueRow[]>
      }
      setLadder(json.ladder)
      setCatalogueByCategory(json.catalogue_by_category ?? {})
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  async function setSlot(category: string, tier: 'good' | 'better' | 'best', catalogueId: string) {
    if (!accessToken) return
    const key = `${category}::${tier}`
    setBusyKey(key)
    try {
      if (!catalogueId) {
        // Empty selection = delete the slot.
        const res = await fetch(
          `/api/tenant/tier-ladder?category=${encodeURIComponent(category)}&tier=${tier}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(b.error || `HTTP ${res.status}`)
        }
      } else {
        const res = await fetch('/api/tenant/tier-ladder', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ category, tier, catalogue_id: catalogueId }),
        })
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(b.error || `HTTP ${res.status}`)
        }
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <div className="mt-4 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim py-6">
        Loading tier ladder…
      </div>
    )
  }
  if (err) {
    return (
      <div className="mt-4 bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-2">
          Couldn&apos;t load tier ladder
        </div>
        <p className="text-sm text-text-sec">{err}</p>
      </div>
    )
  }

  // Categories with at least one catalogue product. If the tenant has
  // no stocked products, nothing to pick from — point them at Stock-the-
  // essentials / Browse instead of showing empty dropdowns.
  const categoriesWithProducts = Object.keys(catalogueByCategory).sort()
  if (categoriesWithProducts.length === 0) {
    return (
      <div className="mt-4 bg-ink-card/40 border border-dashed border-ink-line p-6">
        <p className="text-sm text-text-sec">
          Stock some products first — the G/B/B ladder picks from your own catalogue.
          Use <span className="font-mono">Stock the essentials</span> or{' '}
          <span className="font-mono">Browse supplier catalogue</span> on this tab first.
        </p>
      </div>
    )
  }

  const slotsByKey = new Map<string, LadderRow>()
  for (const l of ladder ?? []) slotsByKey.set(`${l.category}::${l.tier}`, l)

  const TIERS: Array<'good' | 'better' | 'best'> = ['good', 'better', 'best']

  return (
    <div className="mt-4 space-y-4">
      <div className="border-l-2 border-l-accent/60 bg-ink-card/40 px-4 py-3">
        <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-accent mb-1">
          Good / Better / Best — your ladder
        </div>
        <div className="text-sm text-text-sec">
          Pin a specific product per category and tier. When the AI quotes a job at a tier
          you&rsquo;ve set, it uses THIS exact product — overriding brand+range inference.
          Empty slots fall back to the inference (no regression).
        </div>
      </div>

      <div className="space-y-3">
        {categoriesWithProducts.map((cat) => {
          const products = catalogueByCategory[cat] ?? []
          return (
            <div key={cat} className="border border-ink-line p-4">
              <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-text-pri font-bold mb-3">
                {cat} <span className="text-text-dim font-normal">({products.length} stocked)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {TIERS.map((tier) => {
                  const key = `${cat}::${tier}`
                  const current = slotsByKey.get(key)?.catalogue_id ?? ''
                  return (
                    <label key={tier} className="flex flex-col gap-1">
                      <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
                        {tier}
                      </span>
                      <select
                        value={current}
                        disabled={busyKey === key}
                        aria-label={`${cat} ${tier} product`}
                        onChange={(e) => void setSlot(cat, tier, e.target.value)}
                        className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri disabled:opacity-50"
                      >
                        <option value="">— inference fallback —</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.brand ? `${p.brand} ` : ''}
                            {p.range_series ? `${p.range_series} ` : ''}
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CatalogueTab({ accessToken }: { accessToken: string | null }) {
  const [rows, setRows] = useState<CatalogueRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  // v7 Phase 2b/3 — mode toggle: 'mine' shows stocked products;
  // 'browse' shows the supplier library; 'ladder' shows the per-category
  // Good/Better/Best ladder picker (tenant_tier_ladder, migration 043).
  const [viewMode, setViewMode] = useState<'mine' | 'browse' | 'ladder'>('mine')
  // v7 Phase 2d — Stock-the-essentials 1-click button state.
  const [essentialsBusy, setEssentialsBusy] = useState(false)
  const [essentialsMsg, setEssentialsMsg] = useState<string | null>(null)
  const blankForm = {
    trade: 'electrical',
    category: '',
    name: '',
    brand: '',
    range_series: '',
    supplier: '',
    unit_price_ex_gst: '',
    customer_supply_price_ex_gst: '',
    cost_price_ex_gst: '',
    description: '',
    image_path: '',
    tier_hint: '',
    is_preferred: '',
    unit: 'each',
  }
  const [form, setForm] = useState({ ...blankForm })
  // null = not editing (form is in "add" mode). A row id = editing that
  // row (form is prefilled, submit PATCHes instead of POSTs).
  const [editingId, setEditingId] = useState<string | null>(null)
  // 'all' or a Category value — narrows the visible list to one category.
  // Filter chips below the header drive this; persisted only in memory.
  const [categoryFilter, setCategoryFilter] = useState<string>('all')

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tenant/catalogue', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { catalogue: CatalogueRow[] }
      setRows(json.catalogue)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  async function toggleActive(row: CatalogueRow) {
    if (!accessToken) return
    setBusyId(row.id)
    const next = !row.active
    setRows((p) => (p ? p.map((r) => (r.id === row.id ? { ...r, active: next } : r)) : p))
    try {
      const res = await fetch(`/api/tenant/catalogue/${row.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      setRows((p) => (p ? p.map((r) => (r.id === row.id ? { ...r, active: row.active } : r)) : p))
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  // v7 Phase 2d — stock the essentials for the tenant's trade(s).
  // Posts to /api/tenant/catalogue/stock-essentials which picks one
  // good-tier SKU per essential category and bulk-adds them with the
  // granular→grounding mapping. Server-side curation means every tradie
  // gets the same starter set, deterministic.
  async function stockEssentials() {
    if (!accessToken || essentialsBusy) return
    setEssentialsBusy(true)
    setEssentialsMsg(null)
    try {
      const res = await fetch('/api/tenant/catalogue/stock-essentials', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        added?: number
        skipped?: number
        total?: number
        error?: string
        message?: string
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || json.message || `HTTP ${res.status}`)
      }
      setEssentialsMsg(
        json.added && json.added > 0
          ? `Stocked ${json.added} essential${json.added === 1 ? '' : 's'} (skipped ${json.skipped ?? 0} already on file).`
          : 'No new essentials to stock — your catalogue already has them.',
      )
      await load()
    } catch (e) {
      setEssentialsMsg(`Couldn't stock essentials: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setEssentialsBusy(false)
    }
  }

  async function remove(row: CatalogueRow) {
    if (!accessToken) return
    if (!window.confirm(`Delete "${row.name}" from your catalogue?`)) return
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/tenant/catalogue/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      setRows((p) => (p ? p.filter((r) => r.id !== row.id) : p))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function create() {
    if (!accessToken) return
    setSaving(true)
    setFormErr(null)
    try {
      const res = await fetch('/api/tenant/catalogue', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade: form.trade,
          category: form.category.trim(),
          name: form.name.trim(),
          brand: form.brand.trim() || undefined,
          range_series: form.range_series.trim() || undefined,
          supplier: form.supplier.trim() || undefined,
          unit: form.unit || undefined,
          unit_price_ex_gst: form.unit_price_ex_gst,
          customer_supply_price_ex_gst: form.customer_supply_price_ex_gst || undefined,
          cost_price_ex_gst: form.cost_price_ex_gst || undefined,
          description: form.description.trim() || undefined,
          image_path: form.image_path.trim() || undefined,
          tier_hint: form.tier_hint || undefined,
          is_preferred: form.is_preferred === 'yes',
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      setForm({ ...blankForm, trade: form.trade })
      setShowForm(false)
      await load()
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Close the form and drop any edit-in-progress, resetting to a blank
  // "add" form (keeping the last-used trade so adding several products
  // in the same trade isn't tedious).
  function closeForm() {
    setShowForm(false)
    setEditingId(null)
    setFormErr(null)
    setForm({ ...blankForm, trade: form.trade })
  }

  // Prefill the shared top form from an existing row and switch it into
  // edit mode. Numbers are coerced to plain strings so the inputs are
  // controlled; nulls become '' so clearing a field is possible.
  function beginEdit(row: CatalogueRow) {
    const str = (v: number | string | null | undefined) =>
      v == null || v === '' ? '' : String(v)
    setForm({
      trade: row.trade || 'electrical',
      category: row.category || '',
      name: row.name || '',
      brand: row.brand ?? '',
      range_series: row.range_series ?? '',
      supplier: row.supplier ?? '',
      unit_price_ex_gst: str(row.unit_price_ex_gst),
      customer_supply_price_ex_gst: str(row.customer_supply_price_ex_gst),
      cost_price_ex_gst: str(row.cost_price_ex_gst),
      description: row.description ?? '',
      image_path: row.image_path ?? '',
      tier_hint: row.tier_hint ?? '',
      is_preferred: row.is_preferred ? 'yes' : '',
      unit: row.unit || 'each',
    })
    setEditingId(row.id)
    setShowForm(true)
    setFormErr(null)
  }

  // PATCH an existing row. Unlike create(), empty text fields are sent
  // as '' (the API maps '' → null) so a tradie can actually CLEAR a
  // brand/photo/etc; the two optional money fields send null when blank
  // so they don't silently coerce to $0.
  async function update() {
    if (!accessToken || !editingId) return
    setSaving(true)
    setFormErr(null)
    try {
      const optMoney = (v: string) => {
        const t = v.trim()
        return t === '' ? null : t
      }
      const res = await fetch(`/api/tenant/catalogue/${editingId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade: form.trade,
          category: form.category.trim(),
          name: form.name.trim(),
          brand: form.brand.trim(),
          range_series: form.range_series.trim(),
          supplier: form.supplier.trim(),
          unit: form.unit || 'each',
          unit_price_ex_gst: form.unit_price_ex_gst,
          customer_supply_price_ex_gst: optMoney(form.customer_supply_price_ex_gst),
          cost_price_ex_gst: optMoney(form.cost_price_ex_gst),
          description: form.description.trim(),
          image_path: form.image_path.trim(),
          tier_hint: form.tier_hint,
          is_preferred: form.is_preferred === 'yes',
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      closeForm()
      await load()
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Upload a chosen file to the public catalogue-images bucket and put
  // the returned permanent URL into the form's image_path (same field
  // the "paste a URL" input writes to — the rest of the app only ever
  // sees a URL, whether pasted or uploaded).
  async function uploadImage(file: File) {
    if (!accessToken) return
    setUploading(true)
    setFormErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/tenant/catalogue/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd,
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        url?: string
        error?: string
        message?: string
      }
      if (!res.ok || !json.url) {
        throw new Error(json.message || json.error || `HTTP ${res.status}`)
      }
      set('image_path', json.url)
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const money = (v: number | string | null) => {
    if (v == null || v === '') return null
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : null
  }
  const set = (k: keyof typeof blankForm, v: string) => setForm((f) => ({ ...f, [k]: v }))

  if (loading) {
    return (
      <div className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim py-10">
        Loading catalogue…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-2">
          Couldn&apos;t load catalogue
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </div>
    )
  }

  const list = rows ?? []

  // Per-category counts off the unfiltered list so the chip labels stay
  // stable as the user clicks between filters (otherwise "All (12)" would
  // flicker to "All (3)" when narrowed).
  const counts = new Map<string, number>()
  for (const r of list) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)

  const filtered =
    categoryFilter === 'all' ? list : list.filter((r) => r.category === categoryFilter)

  // Group by (trade, category) — same key as before so the visual sections
  // are unchanged, just sorted deterministically by the canonical category
  // order and tier-sorted within each section.
  const TIER_RANK: Record<string, number> = { good: 0, better: 1, best: 2 }
  const tierSort = (a: CatalogueRow, b: CatalogueRow) => {
    const ai = a.tier_hint ? TIER_RANK[a.tier_hint] : 3
    const bi = b.tier_hint ? TIER_RANK[b.tier_hint] : 3
    if (ai !== bi) return ai - bi
    if (a.is_preferred !== b.is_preferred) return a.is_preferred ? -1 : 1
    return a.name.localeCompare(b.name)
  }
  const CATEGORY_ORDER = new Map(CATEGORIES.map((c, i) => [c.value as string, i]))
  const categoryLabel = (v: string) =>
    CATEGORIES.find((c) => c.value === v)?.label ?? v

  const groupMap = new Map<
    string,
    { trade: string; category: string; items: CatalogueRow[] }
  >()
  for (const r of filtered) {
    const key = `${r.trade}·${r.category}`
    const g = groupMap.get(key) ?? { trade: r.trade, category: r.category, items: [] }
    g.items.push(r)
    groupMap.set(key, g)
  }
  const groups = [...groupMap.values()]
    .map((g) => ({ ...g, items: [...g.items].sort(tierSort) }))
    .sort((a, b) => {
      if (a.trade !== b.trade) return a.trade.localeCompare(b.trade)
      return (CATEGORY_ORDER.get(a.category) ?? 999) - (CATEGORY_ORDER.get(b.category) ?? 999)
    })

  return (
    <div className="bg-ink-card border border-ink-line p-6 sm:p-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
            Product catalogue
          </h2>
          <p className="mt-1 text-xs text-text-dim leading-snug max-w-xl">
            Your real branded products and prices. The AI quotes these ahead of generic items and
            maps brand + range to a tier (e.g. Clipsal Iconic → Better, Clipsal 2000 → Good).
            Off rows are never offered. {list.length} product{list.length === 1 ? '' : 's'}.
          </p>
        </div>
        {viewMode === 'mine' && (
          <button
            type="button"
            onClick={() => {
              if (showForm) {
                closeForm()
              } else {
                setForm({ ...blankForm, trade: form.trade })
                setEditingId(null)
                setShowForm(true)
                setFormErr(null)
              }
            }}
            className="shrink-0 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/50 text-accent hover:bg-accent/10 transition-colors cursor-pointer"
          >
            {showForm ? '× Cancel' : '+ Add product'}
          </button>
        )}
      </div>

      {/* v7 Phase 2b — mode toggle. "Browse supplier catalogue" exposes
         the seeded master library so the tradie can tick what they stock
         instead of hand-typing every SKU. */}
      <div className="mt-4 flex items-center gap-1 border-b border-ink-line">
        <button
          type="button"
          onClick={() => setViewMode('mine')}
          className={`font-mono text-[0.65rem] uppercase tracking-[0.16em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
            viewMode === 'mine'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-dim hover:text-text-pri'
          }`}
        >
          My catalogue ({list.length})
        </button>
        <button
          type="button"
          onClick={() => setViewMode('browse')}
          className={`font-mono text-[0.65rem] uppercase tracking-[0.16em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
            viewMode === 'browse'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-dim hover:text-text-pri'
          }`}
        >
          + Browse supplier catalogue
        </button>
        <button
          type="button"
          onClick={() => setViewMode('ladder')}
          className={`font-mono text-[0.65rem] uppercase tracking-[0.16em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
            viewMode === 'ladder'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-dim hover:text-text-pri'
          }`}
        >
          G/B/B ladder
        </button>
      </div>

      {viewMode === 'browse' && (
        <BrowseSupplierPanel
          accessToken={accessToken}
          onAdded={() => {
            // After a successful bulk-add, refresh the tenant's own catalogue
            // so the "+ N" count + the My catalogue view reflect the new rows.
            void load()
          }}
        />
      )}

      {viewMode === 'ladder' && <TierLadderPanel accessToken={accessToken} />}

      {viewMode === 'mine' && (
        <>
      {/* My-catalogue UI: existing form + filter chips + list of groups. */}

      {/* v7 Phase 2d — Stock-the-essentials prompt. Prominent when the
         catalogue is empty (the "new tradie, AI ready in 5s" win Jon
         described). Quieter once they've stocked some items but still
         available. Hides when they have a meaningful catalogue (≥10
         products) so it doesn't nag forever. */}
      {list.length < 10 && (
        <div
          className={`mt-4 border-l-2 ${list.length === 0 ? 'border-l-accent bg-accent/5' : 'border-l-accent/40 bg-ink-card/40'} px-4 py-3`}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-accent mb-1">
                {list.length === 0 ? 'Get started in one click' : 'Quick start'}
              </div>
              <div className="text-sm text-text-sec">
                {list.length === 0
                  ? "Your catalogue is empty. Stock the essentials for your trade and the AI can auto-quote your wedge from the next call."
                  : 'Stock common products in one click — covers the most-quoted categories with one good-tier SKU each. Already-stocked items are skipped.'}
              </div>
              {essentialsMsg && (
                <div className="mt-1 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
                  {essentialsMsg}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void stockEssentials()}
              disabled={essentialsBusy}
              className="shrink-0 font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {essentialsBusy ? 'Stocking…' : 'Stock the essentials'}
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void (editingId ? update() : create())
          }}
          className="mt-5 border border-ink-line bg-ink-deep p-4 grid gap-3 sm:grid-cols-2"
        >
          {editingId && (
            <div className="sm:col-span-2 font-mono text-[0.65rem] uppercase tracking-[0.15em] text-accent">
              Editing “{form.name || 'product'}” — change anything and save
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Trade</span>
            <select
              value={form.trade}
              onChange={(e) => set('trade', e.target.value)}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            >
              <option value="electrical">electrical</option>
              <option value="plumbing">plumbing</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Category</span>
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            >
              <option value="">— choose a category —</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-[0.65rem] text-text-dim leading-snug">
              This must match the category your Recipes use, so the AI prices this product on the right jobs.
            </span>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Product name</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Clipsal Iconic GPO"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Brand</span>
            <input
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
              placeholder="Clipsal"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Range / series</span>
            <input
              value={form.range_series}
              onChange={(e) => set('range_series', e.target.value)}
              placeholder="Iconic / 2000"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Supplier</span>
            <input
              value={form.supplier}
              onChange={(e) => set('supplier', e.target.value)}
              placeholder="Reece / Bunnings"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Unit</span>
            <select
              value={form.unit}
              onChange={(e) => set('unit', e.target.value)}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            >
              <option value="each">each</option>
              <option value="m">per metre (m)</option>
              <option value="pack">per pack</option>
              <option value="set">per set</option>
              <option value="pair">per pair</option>
              <option value="hr">per hour (hr)</option>
            </select>
            <span className="text-[0.65rem] text-text-dim leading-snug">
              How the price below is measured — &ldquo;each&rdquo; for fittings, &ldquo;per metre&rdquo; for cable/pipe.
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Price ex-GST</span>
            <input
              value={form.unit_price_ex_gst}
              onChange={(e) => set('unit_price_ex_gst', e.target.value)}
              inputMode="decimal"
              placeholder="42"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
              Customer-supply price ex-GST (optional)
            </span>
            <input
              value={form.customer_supply_price_ex_gst}
              onChange={(e) => set('customer_supply_price_ex_gst', e.target.value)}
              inputMode="decimal"
              placeholder="Price if the customer buys this part themselves"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
              Cost price ex-GST (optional)
            </span>
            <input
              value={form.cost_price_ex_gst}
              onChange={(e) => set('cost_price_ex_gst', e.target.value)}
              inputMode="decimal"
              placeholder="What you pay for it — for your margin only, never quoted"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
              Product description (optional)
            </span>
            <input
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="e.g. Modern square matte-black finish"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-text-sec sm:col-span-2">
            <input
              type="checkbox"
              checked={form.is_preferred === 'yes'}
              onChange={(e) => set('is_preferred', e.target.checked ? 'yes' : '')}
            />
            This is my go-to product for its category (preferred)
          </label>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
              Product photo (optional)
            </span>
            <div className="flex flex-wrap items-start gap-3">
              {form.image_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.image_path}
                  alt="Product photo preview"
                  className="h-16 w-16 object-cover border border-ink-line bg-ink-deep shrink-0"
                />
              )}
              <div className="flex-1 min-w-[12rem] flex flex-col gap-2">
                <input
                  value={form.image_path}
                  onChange={(e) => set('image_path', e.target.value)}
                  placeholder="Paste an image URL (https://…)"
                  className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
                />
                <div className="flex items-center gap-3">
                  <label className="font-mono text-[0.6rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-ink-line text-text-sec hover:border-accent/50 hover:text-text-pri transition-colors cursor-pointer">
                    {uploading ? 'Uploading…' : '⬆ Upload a photo'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        e.target.value = '' // allow re-selecting the same file
                        if (f) void uploadImage(f)
                      }}
                      className="hidden"
                    />
                  </label>
                  {form.image_path && (
                    <button
                      type="button"
                      onClick={() => set('image_path', '')}
                      className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim hover:text-warning transition-colors cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <span className="text-[0.65rem] text-text-dim leading-snug">
                  Paste a link, or upload a JPG/PNG/WebP (max 8&nbsp;MB). Shown to the
                  customer and used by the AI image preview.
                </span>
              </div>
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Tier (optional)</span>
            <select
              value={form.tier_hint}
              onChange={(e) => set('tier_hint', e.target.value)}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            >
              <option value="">Auto (from brand/range)</option>
              <option value="good">good</option>
              <option value="better">better</option>
              <option value="best">best</option>
            </select>
          </label>
          {formErr && (
            <p className="sm:col-span-2 text-xs text-warning">{formErr}</p>
          )}
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
            >
              {saving
                ? 'Saving…'
                : editingId
                  ? 'Save changes'
                  : 'Add to catalogue'}
            </button>
          </div>
        </form>
      )}

      {list.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim mr-1">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={`font-mono text-[0.65rem] uppercase tracking-[0.14em] px-2.5 py-1 border transition-colors cursor-pointer ${
              categoryFilter === 'all'
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-ink-line text-text-dim hover:border-accent/50 hover:text-text-pri'
            }`}
          >
            All ({list.length})
          </button>
          {CATEGORIES.filter((c) => counts.has(c.value)).map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCategoryFilter(c.value)}
              className={`font-mono text-[0.65rem] uppercase tracking-[0.14em] px-2.5 py-1 border transition-colors cursor-pointer ${
                categoryFilter === c.value
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-ink-line text-text-dim hover:border-accent/50 hover:text-text-pri'
              }`}
            >
              {c.label} ({counts.get(c.value)})
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <p className="mt-6 text-sm text-text-sec">
          No catalogue products yet. Add your first so the AI quotes your real products and prices.
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-6 text-sm text-text-sec">
          No products in <span className="text-text-pri">{categoryLabel(categoryFilter)}</span>.{' '}
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-accent hover:underline cursor-pointer"
          >
            Show all
          </button>
        </p>
      ) : (
        <div className="mt-6 space-y-5">
          {groups.map((g) => (
            <div key={`${g.trade}·${g.category}`}>
              <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent font-bold pb-1 flex items-baseline gap-2">
                <span>
                  {g.trade} · {categoryLabel(g.category)}
                </span>
                <span className="text-text-dim font-normal tracking-[0.14em]">
                  {g.items.length}
                </span>
              </div>
              <div className="space-y-2">
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    className={`border px-4 py-3 flex items-start justify-between gap-4 ${
                      r.active ? 'border-accent/60 bg-accent/5' : 'border-ink-line bg-ink-card'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {r.image_path && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.image_path}
                          alt={r.name}
                          className="h-12 w-12 object-cover border border-ink-line shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className={`font-semibold text-sm ${r.active ? 'text-text-pri' : 'text-text-sec'}`}>
                          {r.name}
                        </div>
                        <div className="mt-1 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim flex flex-wrap items-center gap-x-3 gap-y-1">
                          {money(r.unit_price_ex_gst) && (
                            <span>
                              {money(r.unit_price_ex_gst)}
                              {r.unit && r.unit !== 'each' ? ` / ${r.unit}` : ''} ex-GST
                            </span>
                          )}
                          {money(r.customer_supply_price_ex_gst) && (
                            <span>cust-supply {money(r.customer_supply_price_ex_gst)}</span>
                          )}
                          {money(r.cost_price_ex_gst) && (
                            <span className="text-text-dim/70">cost {money(r.cost_price_ex_gst)}</span>
                          )}
                          {(r.brand || r.range_series) && (
                            <span className="text-text-dim/80">
                              {[r.brand, r.range_series].filter(Boolean).join(' ')}
                            </span>
                          )}
                          {r.supplier && <span className="text-text-dim/70">{r.supplier}</span>}
                          {r.tier_hint && (
                            <span className="px-2 py-0.5 border border-accent/40 text-accent">
                              {r.tier_hint}
                            </span>
                          )}
                          {r.is_preferred && (
                            <span className="px-2 py-0.5 border border-accent/40 text-accent">
                              ★ preferred
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div className="mt-1 text-xs text-text-dim normal-case tracking-normal">
                            {r.description}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      <span
                        role="switch"
                        aria-checked={r.active}
                        aria-label={`${r.name} — ${r.active ? 'active, click to turn off' : 'off, click to turn on'}`}
                        tabIndex={0}
                        onClick={() => busyId !== r.id && toggleActive(r)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && busyId !== r.id) {
                            e.preventDefault()
                            void toggleActive(r)
                          }
                        }}
                        className="inline-flex items-center cursor-pointer group select-none"
                      >
                        <span
                          className={`relative inline-block h-5 w-10 border transition-colors ${
                            r.active
                              ? 'border-accent bg-accent/20'
                              : 'border-ink-line bg-ink-base group-hover:border-text-dim'
                          }`}
                        >
                          <span
                            className={`absolute top-[1px] h-[14px] w-[14px] transition-transform ${
                              r.active
                                ? 'translate-x-[22px] bg-accent'
                                : 'translate-x-[2px] bg-text-dim group-hover:bg-text-sec'
                            }`}
                          />
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => beginEdit(r)}
                        disabled={busyId === r.id}
                        className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim hover:text-accent transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r)}
                        disabled={busyId === r.id}
                        className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
        </>
      )}
    </div>
  )
}

// ─── WP3 · Recipes editor — the tradie's own bills of materials ───
// Each tradie's OWN parts list per job (tenant_assembly_bom, migration
// 031). Add / edit quantity / toggle required / remove — all from the
// dashboard, no scripts. Self-contained (mirrors CatalogueTab).
//
// 2026-05-20 — empty-state shows the SHARED baseline (read-only) plus a
// "Customise this recipe" button that forks it into tenant_assembly_bom
// so the tradie isn't forced to type every line from scratch. Forking is
// an explicit, single-click action — never silent — so a tradie always
// knows when their recipe has diverged from the standard.
type BomLineRow = {
  id: string
  assembly_id: string
  trade: string
  material_category: string
  description: string | null
  quantity: number | string
  required: boolean
  sort: number
}
type BaselineLine = {
  material_category: string
  description: string | null
  quantity: number
  required: boolean
  sort: number
}
type AsmOpt = { id: string; name: string; trade: string }

function RecipesTab({ accessToken }: { accessToken: string | null }) {
  const [assemblies, setAssemblies] = useState<AsmOpt[]>([])
  const [lines, setLines] = useState<BomLineRow[] | null>(null)
  const [baselines, setBaselines] = useState<Record<string, BaselineLine[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string>('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [forking, setForking] = useState(false)
  const [forkErr, setForkErr] = useState<string | null>(null)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [draftQty, setDraftQty] = useState<Record<string, string>>({})
  // Categories this tradie has a priced, active Catalogue product for —
  // used to badge each recipe line so a Catalogue↔Recipe mismatch is
  // visible instead of silently costing them their real product + price.
  const [catalogueCats, setCatalogueCats] = useState<string[]>([])
  const blank = { material_category: '', quantity: '1', required: true, description: '' }
  const [form, setForm] = useState({ ...blank })

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tenant/bom', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        assemblies: AsmOpt[]
        lines: BomLineRow[]
        baselines?: Record<string, BaselineLine[]>
        catalogue_categories?: string[]
      }
      setAssemblies(json.assemblies)
      setLines(json.lines)
      setBaselines(json.baselines ?? {})
      setCatalogueCats(json.catalogue_categories ?? [])
      setSelectedId((cur) => cur || (json.assemblies[0]?.id ?? ''))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  const selectedAsm = assemblies.find((a) => a.id === selectedId) ?? null
  const jobLines = (lines ?? [])
    .filter((l) => l.assembly_id === selectedId)
    .sort((a, b) => a.sort - b.sort)
  const jobBaseline = (baselines[selectedId] ?? [])
    .slice()
    .sort((a, b) => a.sort - b.sort)

  async function forkBaseline() {
    if (!accessToken || !selectedAsm) return
    if (jobLines.length > 0) return // safety: never fork over an existing recipe
    setForking(true)
    setForkErr(null)
    try {
      const res = await fetch('/api/tenant/bom/fork', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assembly_id: selectedAsm.id }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        message?: string
      }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setForkErr(e instanceof Error ? e.message : String(e))
    } finally {
      setForking(false)
    }
  }

  async function addLine() {
    if (!accessToken || !selectedAsm) return
    setSaving(true)
    setFormErr(null)
    try {
      const res = await fetch('/api/tenant/bom', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assembly_id: selectedAsm.id,
          trade: selectedAsm.trade,
          material_category: form.material_category.trim(),
          quantity: form.quantity,
          required: form.required,
          description: form.description.trim() || undefined,
          sort: jobLines.length + 1,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        message?: string
        line?: BomLineRow
      }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      setForm({ ...blank })
      await load()
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function patchLine(id: string, fields: Record<string, unknown>) {
    if (!accessToken) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/tenant/bom/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { line: BomLineRow }
      setLines((p) => (p ? p.map((l) => (l.id === id ? json.line : l)) : p))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function deleteLine(id: string) {
    if (!accessToken) return
    if (!window.confirm('Remove this part from the recipe?')) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/tenant/bom/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      setLines((p) => (p ? p.filter((l) => l.id !== id) : p))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim py-10">
        Loading recipes…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-2">
          Couldn&apos;t load recipes
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </div>
    )
  }

  return (
    <div className="bg-ink-card border border-ink-line p-6 sm:p-7">
      <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
        Recipes — your parts list per job
      </h2>
      <p className="mt-1 text-xs text-text-dim leading-snug max-w-xl">
        Define the parts a job always needs so the same job is quoted the same way every time.
        These are <strong>yours</strong> — editing them never affects other tradies. A job with
        no recipe here, you can start from our baseline and edit it.
      </p>

      <div className="mt-5 flex flex-col gap-1 max-w-md">
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Job</span>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-ink-deep border border-ink-line px-3 py-2 text-sm text-text-pri"
        >
          {assemblies.length === 0 && <option value="">No jobs available</option>}
          {assemblies.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.trade})
            </option>
          ))}
        </select>
      </div>

      {selectedAsm && (
        <div className="mt-6">
          <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-accent font-bold pb-2">
            {selectedAsm.name} — recipe
          </div>

          {jobLines.length === 0 ? (
            jobBaseline.length > 0 ? (
              // Empty state WITH a shared baseline available — surface it
              // read-only and offer the one-click fork. The tradie sees
              // exactly what the AI would use today and can either accept
              // it (no DB writes, baseline keeps applying) or fork it to
              // start editing. After fork, this block disappears and the
              // normal editable list takes over.
              <div className="space-y-3">
                <p className="text-sm text-text-sec">
                  No saved recipe for this job yet — here&apos;s the standard baseline we&apos;d use.
                  Hit <strong>Customise this recipe</strong> to make it yours and start editing.
                </p>
                <div className="space-y-2">
                  {jobBaseline.map((b, i) => (
                    <div
                      key={`${b.material_category}|${b.description ?? ''}|${i}`}
                      className="border border-ink-line bg-ink-deep px-4 py-3 flex items-center justify-between gap-4 flex-wrap opacity-90"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-text-pri font-medium">
                          {b.material_category}
                        </div>
                        {b.description && (
                          <div className="text-xs text-text-dim mt-0.5">{b.description}</div>
                        )}
                        <div className="mt-1.5">
                          <span className="inline-block px-1.5 py-0.5 border border-ink-line text-text-dim font-mono text-[0.55rem] uppercase tracking-[0.15em]">
                            shared baseline
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-text-dim">
                        <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em]">
                          qty {Number(b.quantity)}
                        </span>
                        <span className="font-mono text-[0.55rem] uppercase tracking-[0.15em] px-2 py-1 border border-ink-line">
                          {b.required ? 'required' : 'optional'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 flex-wrap pt-1">
                  <button
                    type="button"
                    onClick={() => void forkBaseline()}
                    disabled={forking}
                    className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {forking ? 'Forking baseline…' : 'Customise this recipe'}
                  </button>
                  <span className="text-[0.65rem] text-text-dim leading-snug">
                    Copies these {jobBaseline.length} line{jobBaseline.length === 1 ? '' : 's'} into your recipe so you can edit qty, toggle required/optional, or add more parts.
                  </span>
                </div>
                {forkErr && (
                  <p className="text-xs text-warning">{forkErr}</p>
                )}
              </div>
            ) : (
              // No tenant recipe AND no shared baseline — only the
              // add-line form below is available.
              <p className="text-sm text-text-sec">
                No recipe yet for this job, and no standard baseline either. Add the parts it always needs below.
              </p>
            )
          ) : (
            <div className="space-y-2">
              {jobLines.map((l) => {
                const qv = draftQty[l.id] ?? String(Number(l.quantity))
                const priced = categoryHasCatalogueProduct(l.material_category, catalogueCats)
                return (
                  <div
                    key={l.id}
                    className="border border-ink-line bg-ink-deep px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-text-pri font-medium">{l.material_category}</div>
                      {l.description && (
                        <div className="text-xs text-text-dim mt-0.5">{l.description}</div>
                      )}
                      <div className="mt-1.5">
                        {priced ? (
                          <span className="inline-block px-1.5 py-0.5 border border-accent/40 text-accent font-mono text-[0.55rem] uppercase tracking-[0.15em]">
                            ✓ priced from your catalogue
                          </span>
                        ) : (
                          <span
                            className="inline-block px-1.5 py-0.5 border border-warning/50 text-warning font-mono text-[0.55rem] uppercase tracking-[0.15em]"
                            title="No active Catalogue product in this category. The AI will fall back to a generic price (or inspection). Add a Catalogue product with this exact category to use your real product + price."
                          >
                            ⚠ no catalogue product — generic price
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim">
                        qty
                        <input
                          value={qv}
                          inputMode="decimal"
                          onChange={(e) => setDraftQty((d) => ({ ...d, [l.id]: e.target.value }))}
                          onBlur={() => {
                            const n = parseFloat(qv)
                            if (Number.isFinite(n) && n > 0 && n !== Number(l.quantity)) {
                              void patchLine(l.id, { quantity: n })
                            }
                          }}
                          className="w-16 bg-ink-card border border-ink-line px-2 py-1 text-sm text-text-pri"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => patchLine(l.id, { required: !l.required })}
                        disabled={busyId === l.id}
                        className={`font-mono text-[0.55rem] uppercase tracking-[0.15em] px-2 py-1 border transition-colors cursor-pointer disabled:opacity-50 ${
                          l.required
                            ? 'border-accent/40 text-accent'
                            : 'border-ink-line text-text-dim'
                        }`}
                      >
                        {l.required ? 'required' : 'optional'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteLine(l.id)}
                        disabled={busyId === l.id}
                        className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void addLine()
            }}
            className="mt-4 border border-ink-line bg-ink-deep p-4 grid gap-3 sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Material category</span>
              <select
                value={form.material_category}
                onChange={(e) => setForm((f) => ({ ...f, material_category: e.target.value }))}
                className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
              >
                <option value="">— choose a category —</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <span className="text-[0.65rem] text-text-dim leading-snug">
                Pick the same category you use in Catalogue so your real product (and price) is used for this part.
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Quantity</span>
              <input
                value={form.quantity}
                inputMode="decimal"
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">Description (optional)</span>
              <input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g. clips + connectors"
                className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-text-sec">
              <input
                type="checkbox"
                checked={form.required}
                onChange={(e) => setForm((f) => ({ ...f, required: e.target.checked }))}
              />
              Required part (always quoted)
            </label>
            {formErr && <p className="sm:col-span-2 text-xs text-warning">{formErr}</p>}
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={saving}
                className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
              >
                {saving ? 'Adding…' : '+ Add part to this recipe'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

// ─── WP3 · "How each job is estimated" (read-only) ────────────────
// Per shared assembly that has a structured bill of materials, shows
// the BOM + the EFFECTIVE labour-hours & markup, with a badge saying
// whether each came from the global default or this tradie's local
// override. Pure read — mirrors CatalogueTab's fetch/auth pattern.
type EstimationJob = {
  assembly_id: string
  name: string
  trade: string
  hourly_rate: number | null
  // 'tenant' = this is YOUR edited recipe (what actually gets quoted);
  // 'shared' = the standard baseline (you haven't customised it).
  recipe_source: 'tenant' | 'shared'
  // v7 Phase 0: `enabled` is now sourced from tenant_service_offerings
  // (the Services-tab toggle) instead of the write-orphaned
  // tenant_assembly_overrides.enabled column. Same field name on the
  // wire, just promoted out of `effective` (which is labour/markup only).
  enabled: boolean
  bom: Array<{
    material_category: string
    quantity: number
    required: boolean
    description: string | null
  }>
  effective: {
    labour_hours: { value: number; source: 'local' | 'global' }
    markup_pct: { value: number; source: 'local' | 'global' }
    global_labour_hours: number
    global_markup_pct: number
  }
}

function SourceBadge({ source }: { source: 'local' | 'global' }) {
  return source === 'local' ? (
    <span className="px-1.5 py-0.5 border border-accent/40 text-accent font-mono text-[0.55rem] uppercase tracking-[0.15em]">
      your override
    </span>
  ) : (
    <span className="px-1.5 py-0.5 border border-ink-line text-text-dim font-mono text-[0.55rem] uppercase tracking-[0.15em]">
      global default
    </span>
  )
}

function EstimatingTab({ accessToken }: { accessToken: string | null }) {
  const [jobs, setJobs] = useState<EstimationJob[] | null>(null)
  const [catalogueCats, setCatalogueCats] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // v7 Phase 4 — inline labour/markup override editor.
  // editingId = the assembly currently being edited (null = closed).
  // editForm holds the in-progress values; the values are committed
  // to tenant_assembly_overrides via PATCH /api/tenant/estimation/[id]
  // or cleared via DELETE.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ labour: string; markup: string }>({
    labour: '',
    markup: '',
  })
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tenant/estimation', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        jobs: EstimationJob[]
        catalogue_categories?: string[]
      }
      setJobs(json.jobs)
      setCatalogueCats(json.catalogue_categories ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  // v7 Phase 4 — open the edit form for one assembly. Pre-fill with the
  // CURRENT effective values (whether they came from a local override
  // or the global default — both pre-fill the same way so a tradie
  // tweaking from the global value as a starting point is one click).
  function startEdit(j: EstimationJob) {
    setEditingId(j.assembly_id)
    setEditForm({
      labour: String(j.effective.labour_hours.value ?? ''),
      markup: String(j.effective.markup_pct.value ?? ''),
    })
    setSaveErr(null)
  }
  function cancelEdit() {
    setEditingId(null)
    setSaveErr(null)
  }
  async function saveEdit(j: EstimationJob) {
    if (!accessToken) return
    const labour = parseFloat(editForm.labour)
    const markup = parseFloat(editForm.markup)
    if (!Number.isFinite(labour) || labour <= 0 || labour > 40) {
      setSaveErr('Labour hours must be > 0 and ≤ 40')
      return
    }
    if (!Number.isFinite(markup) || markup < 0 || markup > 200) {
      setSaveErr('Markup % must be between 0 and 200')
      return
    }
    setSavingId(j.assembly_id)
    setSaveErr(null)
    try {
      const res = await fetch(
        `/api/tenant/estimation/${encodeURIComponent(j.assembly_id)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          // Always send both fields so a partial edit doesn't leave the
          // OTHER field stale at its pre-edit override (or NULL).
          body: JSON.stringify({
            labour_hours_override: labour,
            markup_pct_override: markup,
          }),
        },
      )
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      setEditingId(null)
      await load()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }
  async function resetOverride(j: EstimationJob) {
    if (!accessToken) return
    if (!window.confirm(`Reset "${j.name}" to the global defaults?`)) return
    setSavingId(j.assembly_id)
    setSaveErr(null)
    try {
      const res = await fetch(
        `/api/tenant/estimation/${encodeURIComponent(j.assembly_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      if (editingId === j.assembly_id) setEditingId(null)
      await load()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingId(null)
    }
  }

  if (loading) {
    return (
      <div className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim py-10">
        Loading estimation breakdown…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-2">
          Couldn&apos;t load estimation breakdown
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </div>
    )
  }

  const list = jobs ?? []

  return (
    <div className="bg-ink-card border border-ink-line p-6 sm:p-7">
      <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
        How each job is estimated
      </h2>
      <p className="mt-1 text-xs text-text-dim leading-snug max-w-xl">
        For every job, this shows the exact parts the AI quotes — <strong>your own recipe</strong>{' '}
        when you&apos;ve set one, otherwise the standard baseline — plus the labour &amp; markup it
        uses and whether each value is the global default or your override. Each part shows whether
        your catalogue prices it or it falls back to a generic price. Read‑only.
      </p>

      {list.length === 0 ? (
        <p className="mt-6 text-sm text-text-sec">
          No jobs have a structured bill of materials yet. Once the validated job/BOM list is
          loaded, every standard job will show its fixed parts and pricing here.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {list.map((j) => (
            <div key={j.assembly_id} className="border border-ink-line bg-ink-deep p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-semibold text-sm text-text-pri">{j.name}</div>
                <div className="flex items-center gap-2">
                  {j.recipe_source === 'tenant' ? (
                    <span className="px-1.5 py-0.5 border border-accent/40 text-accent font-mono text-[0.55rem] uppercase tracking-[0.15em]">
                      your recipe
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 border border-ink-line text-text-dim font-mono text-[0.55rem] uppercase tracking-[0.15em]">
                      standard recipe
                    </span>
                  )}
                  <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim/80">
                    {j.trade}
                    {!j.enabled && ' · disabled for you'}
                  </span>
                </div>
              </div>

              <div className="mt-3">
                <div className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim mb-1">
                  Bill of materials
                </div>
                <ul className="text-sm text-text-sec space-y-1">
                  {j.bom.map((b, i) => {
                    const priced = categoryHasCatalogueProduct(b.material_category, catalogueCats)
                    return (
                      <li key={i} className="flex items-center gap-2 flex-wrap">
                        <span>
                          • {b.quantity} × {b.material_category}
                          {b.description ? ` ${b.description}` : ''}
                          {b.required ? '' : ' (optional)'}
                        </span>
                        {priced ? (
                          <span className="px-1.5 py-0.5 border border-accent/40 text-accent font-mono text-[0.5rem] uppercase tracking-[0.14em]">
                            ✓ your catalogue
                          </span>
                        ) : (
                          <span
                            className="px-1.5 py-0.5 border border-warning/50 text-warning font-mono text-[0.5rem] uppercase tracking-[0.14em]"
                            title="No active Catalogue product in this category — the AI uses a generic price. Add a Catalogue product with this exact category to use your real product + price."
                          >
                            ⚠ generic price
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm text-text-sec">
                  <span className="text-text-dim">Labour:</span>
                  <span className="text-text-pri font-medium">
                    {j.effective.labour_hours.value} hr
                  </span>
                  <SourceBadge source={j.effective.labour_hours.source} />
                  {j.hourly_rate != null && (
                    <span className="text-text-dim/70 font-mono text-[0.65rem]">
                      @ ${j.hourly_rate}/hr
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-sm text-text-sec">
                  <span className="text-text-dim">Markup:</span>
                  <span className="text-text-pri font-medium">
                    {j.effective.markup_pct.value}%
                  </span>
                  <SourceBadge source={j.effective.markup_pct.source} />
                </div>
              </div>

              {/* v7 Phase 4 — labour / markup override controls. Edit
                 opens an inline form pre-filled with the current effective
                 values; Reset clears the override row entirely. */}
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {editingId !== j.assembly_id && (
                  <button
                    type="button"
                    onClick={() => startEdit(j)}
                    className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-accent hover:text-accent/80 transition-colors cursor-pointer"
                  >
                    Edit overrides
                  </button>
                )}
                {(j.effective.labour_hours.source === 'local' ||
                  j.effective.markup_pct.source === 'local') && (
                  <button
                    type="button"
                    onClick={() => void resetOverride(j)}
                    disabled={savingId === j.assembly_id}
                    className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                )}
              </div>

              {editingId === j.assembly_id && (
                <div className="mt-3 border border-accent/40 bg-accent/5 p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
                        Labour hours (global: {j.effective.global_labour_hours})
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={40}
                        step={0.25}
                        value={editForm.labour}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, labour: e.target.value }))
                        }
                        aria-label="Labour hours override"
                        className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
                        Markup % (global: {j.effective.global_markup_pct}%)
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={editForm.markup}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, markup: e.target.value }))
                        }
                        aria-label="Markup % override"
                        className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
                      />
                    </label>
                  </div>
                  {/* Sanity warning when an override is ≥2× or ≤0.5× the
                     global value — extreme settings can push quotes
                     out of the validator's expected band. Doesn't block. */}
                  {(() => {
                    const labour = parseFloat(editForm.labour)
                    const markup = parseFloat(editForm.markup)
                    const gLab = j.effective.global_labour_hours
                    const gMu = j.effective.global_markup_pct
                    const labourWild =
                      Number.isFinite(labour) && gLab > 0 && (labour >= gLab * 2 || labour <= gLab * 0.5)
                    const markupWild =
                      Number.isFinite(markup) && gMu > 0 && (markup >= gMu * 2 || markup <= gMu * 0.5)
                    if (!labourWild && !markupWild) return null
                    return (
                      <div className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-warning">
                        ⚠ This is a big shift from the global default — double-check before saving.
                      </div>
                    )
                  })()}
                  {saveErr && (
                    <div className="mt-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-warning">
                      {saveErr}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={savingId === j.assembly_id}
                      onClick={() => void saveEdit(j)}
                      className="font-mono text-[0.7rem] uppercase tracking-[0.14em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      {savingId === j.assembly_id ? 'Saving…' : 'Save overrides'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim hover:text-text-pri transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FollowupsTab({ accessToken }: { accessToken: string | null }) {
  const [rows, setRows] = useState<FollowupItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [minAgeHours, setMinAgeHours] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [callBusy, setCallBusy] = useState<string | null>(null)
  const [composeFor, setComposeFor] = useState<FollowupItem | null>(null)
  const [actionState, setActionState] = useState<
    Record<string, { kind: 'ok' | 'err'; text: string }>
  >({})
  const [threadOpen, setThreadOpen] = useState<Record<string, boolean>>({})
  // CRM touch-log UI (migration 039). logFor[id] = the log form is
  // open on that row; historyOpen[id] = the timeline is expanded;
  // historyRefresh[id] = bumped after a successful log so the panel
  // re-fetches without a manual reload.
  const [logFor, setLogFor] = useState<Record<string, boolean>>({})
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  const [historyRefresh, setHistoryRefresh] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // includeActioned=1 → contacted leads come back too (CRM style),
      // so "Mark contacted" moves a row to the Contacted section
      // instead of vanishing it. Split by followed_up_at below.
      const res = await fetch('/api/tenant/followups?includeActioned=1', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        followups: FollowupItem[]
        meta: { min_age_hours: number }
      }
      setRows(json.followups)
      setMinAgeHours(json.meta?.min_age_hours ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await load()
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  // Bump the History panel's refresh key for one quote — used after a
  // call or text auto-logs an event server-side so the open panel
  // (if any) re-fetches and shows the new row immediately.
  function bumpHistory(quoteId: string) {
    setHistoryRefresh((s) => ({ ...s, [quoteId]: (s[quoteId] ?? 0) + 1 }))
  }

  async function reopen(quoteId: string) {
    if (!accessToken) return
    setBusyId(quoteId)
    try {
      const res = await fetch('/api/tenant/followups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ quoteId, action: 'reopen' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      // Optimistic: move it back to "To chase". Reason is a sensible
      // best-guess from status; the next real load reconciles it.
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.quote_id === quoteId
                ? {
                    ...r,
                    followed_up_at: null,
                    followup_reason:
                      r.status === 'viewed'
                        ? 'Opened, not paid'
                        : 'Sent, not opened',
                  }
                : r,
            )
          : prev,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  function setRowMsg(quoteId: string, kind: 'ok' | 'err', text: string) {
    setActionState((s) => ({ ...s, [quoteId]: { kind, text } }))
  }
  function clearRowMsg(quoteId: string) {
    setActionState((s) => {
      const next = { ...s }
      delete next[quoteId]
      return next
    })
  }

  async function startCall(item: FollowupItem) {
    if (!accessToken) return
    if (
      !window.confirm(
        `Call ${
          item.customer.full_name || 'this customer'
        }? Your phone rings first, then we connect you to the customer.`,
      )
    )
      return
    setCallBusy(item.quote_id)
    clearRowMsg(item.quote_id)
    try {
      const res = await fetch('/api/tenant/followups/call', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ quoteId: item.quote_id }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        message?: string
        error?: string
      }
      if (!res.ok || !json.ok) {
        setRowMsg(
          item.quote_id,
          'err',
          json.message ||
            json.error ||
            `Couldn't start the call (HTTP ${res.status}).`,
        )
        return
      }
      setRowMsg(
        item.quote_id,
        'ok',
        'Calling — your phone will ring, then we connect the customer.',
      )
      bumpHistory(item.quote_id)
    } catch (e) {
      setRowMsg(
        item.quote_id,
        'err',
        e instanceof Error ? e.message : 'Network error starting the call.',
      )
    } finally {
      setCallBusy(null)
    }
  }

  if (loading) {
    return (
      <Card title="Follow-ups">
        <p className="text-sm text-text-dim">Loading the follow-up queue…</p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card title="Follow-ups">
        <p className="text-sm text-amber-300">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-5 py-3 min-h-[44px] transition-colors cursor-pointer"
        >
          Retry
        </button>
      </Card>
    )
  }

  const list = rows ?? []
  // CRM split: active queue first, contacted-but-still-unpaid after.
  // Server already returns both (includeActioned=1); we group by
  // followed_up_at and render one ordered list with a divider so a
  // contacted lead is parked, not lost.
  const toChase = list.filter((f) => !f.followed_up_at)
  const done = list.filter((f) => !!f.followed_up_at)
  const ordered = [...toChase, ...done]
  const thresholdNote =
    minAgeHours !== null
      ? `Quotes sent over ${
          minAgeHours >= 48
            ? `${Math.round(minAgeHours / 24)} days`
            : `${minAgeHours}h`
        } ago with no payment.`
      : 'Quotes sent but not accepted.'

  if (list.length === 0) {
    return (
      <Card
        title="Follow-ups"
        subtitle={`${thresholdNote} Nothing to chase right now.`}
      >
        <p className="text-sm text-text-dim">
          No follow-ups. Every quote is either too recent, already paid, or
          accepted — or you have contacted them all. Newly sent quotes will
          appear here once they go stale without converting.
        </p>
      </Card>
    )
  }

  return (
    <>
    <Card
      title="Follow-ups"
      subtitle={`${toChase.length} to chase${
        done.length ? ` · ${done.length} contacted` : ''
      } · ${thresholdNote} Oldest first.`}
    >
      {toChase.length === 0 && done.length > 0 && (
        <p className="mb-3 text-sm text-text-dim">
          Nothing left to chase — everyone&apos;s been contacted. Reopen
          any below if they still need a nudge.
        </p>
      )}
      <div className="space-y-3">
        {ordered.map((f, _idx) => {
          const name = f.customer.full_name || 'Unknown customer'
          const hasPhone =
            !!f.customer.phone &&
            f.customer.phone.replace(/\D/g, '').length >= 6
          const act = actionState[f.quote_id]
          const calling = callBusy === f.quote_id
          const isDone = !!f.followed_up_at
          const opened = f.followup_reason.startsWith('Opened')
          const showChaseHeader = !isDone && _idx === 0
          const showContactedHeader =
            isDone && (_idx === 0 || !ordered[_idx - 1].followed_up_at)
          return [
            showChaseHeader ? (
              <p
                key={`${f.quote_id}-h`}
                className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-text-dim"
              >
                To chase ({toChase.length})
              </p>
            ) : null,
            showContactedHeader ? (
              <p
                key={`${f.quote_id}-h`}
                className="mt-6 border-t border-ink-line pt-4 font-mono text-[0.62rem] uppercase tracking-[0.18em] text-text-dim"
              >
                Contacted ({done.length}) · still no payment
              </p>
            ) : null,
            (
            <div
              key={f.quote_id}
              className={`border border-ink-line bg-ink p-4 ${
                isDone ? 'opacity-70' : ''
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-text-pri truncate">
                      {name}
                    </span>
                    <span
                      className={`font-mono text-[0.6rem] uppercase tracking-[0.16em] font-bold px-2 py-0.5 border ${
                        isDone
                          ? 'border-emerald-500/50 text-emerald-300'
                          : opened
                            ? 'border-amber-500/60 text-amber-300'
                            : 'border-accent/60 text-accent'
                      }`}
                    >
                      {f.followup_reason}
                    </span>
                    {f.needs_inspection && (
                      <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] font-bold px-2 py-0.5 border border-ink-line text-text-dim">
                        Inspection
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-sec">
                    {fmtJobType(f.job_type)}
                    {f.customer.suburb ? ` · ${f.customer.suburb}` : ''} ·{' '}
                    {fmtAUD(f.total_inc_gst)} inc GST
                    {f.selected_tier ? ` · ${f.selected_tier} tier` : ''}
                  </p>
                  <p className="mt-1 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-text-dim">
                    Last activity {fmtAgeHours(f.age_hours)}
                  </p>
                </div>
                <div className="flex flex-col items-stretch gap-2 shrink-0">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!hasPhone || calling}
                      onClick={() => void startCall(f)}
                      className="inline-flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-press text-white font-mono text-[0.62rem] uppercase tracking-[0.14em] font-bold px-3 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {calling ? 'Ringing…' : 'Call'}
                    </button>
                    <button
                      type="button"
                      disabled={!hasPhone}
                      onClick={() => {
                        clearRowMsg(f.quote_id)
                        setComposeFor(f)
                      }}
                      className="inline-flex items-center justify-center gap-1.5 border border-accent/60 text-accent hover:bg-accent/10 font-mono text-[0.62rem] uppercase tracking-[0.14em] font-bold px-3 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Text
                    </button>
                  </div>
                  {!hasPhone && (
                    <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-amber-300">
                      No phone on file
                    </span>
                  )}
                  {f.customer.phone && (
                    <span className="text-center text-xs text-text-dim tabular-nums">
                      {f.customer.phone}
                    </span>
                  )}
                  {act && (
                    <span
                      className={`text-center font-mono text-[0.6rem] uppercase tracking-[0.12em] leading-relaxed ${
                        act.kind === 'ok'
                          ? 'text-emerald-300'
                          : 'text-amber-300'
                      }`}
                    >
                      {act.text}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-line pt-3">
                {f.share_token && (
                  <Link
                    href={`/q/${f.share_token}`}
                    target="_blank"
                    className="font-mono text-[0.62rem] uppercase tracking-[0.14em] font-bold text-accent hover:text-accent-press"
                  >
                    Open quote ↗
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setThreadOpen((s) => ({
                      ...s,
                      [f.quote_id]: !s[f.quote_id],
                    }))
                  }
                  className="inline-flex items-center gap-1.5 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer"
                >
                  {threadOpen[f.quote_id] ? 'Hide messages ▾' : 'Messages ▸'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setHistoryOpen((s) => ({
                      ...s,
                      [f.quote_id]: !s[f.quote_id],
                    }))
                  }
                  className="inline-flex items-center gap-1.5 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer"
                >
                  {historyOpen[f.quote_id] ? 'Hide history ▾' : 'History ▸'}
                </button>
                {isDone && (
                  <button
                    type="button"
                    disabled={busyId === f.quote_id}
                    onClick={() => void reopen(f.quote_id)}
                    className="inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {busyId === f.quote_id ? 'Saving…' : 'Reopen ↩'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setLogFor((s) => ({
                      ...s,
                      [f.quote_id]: !s[f.quote_id],
                    }))
                  }
                  className={`ml-auto inline-flex items-center gap-2 font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer ${
                    logFor[f.quote_id]
                      ? 'border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri'
                      : 'border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20'
                  }`}
                >
                  {logFor[f.quote_id]
                    ? '× Cancel'
                    : isDone
                      ? '+ Log another'
                      : '+ Log touch'}
                </button>
              </div>
              {logFor[f.quote_id] && (
                <FollowupLogForm
                  quoteId={f.quote_id}
                  accessToken={accessToken}
                  onCancel={() =>
                    setLogFor((s) => ({ ...s, [f.quote_id]: false }))
                  }
                  onLogged={(evt) => {
                    const nowIso = new Date().toISOString()
                    setRows((prev) =>
                      prev
                        ? prev.map((r) =>
                            r.quote_id === f.quote_id
                              ? {
                                  ...r,
                                  followed_up_at: nowIso,
                                  followup_reason: `Contacted — ${
                                    (evt.outcome &&
                                      OUTCOME_LABELS[evt.outcome]) ||
                                    'logged'
                                  }`,
                                  followup_note: evt.note ?? r.followup_note,
                                }
                              : r,
                          )
                        : prev,
                    )
                    setLogFor((s) => ({ ...s, [f.quote_id]: false }))
                    setHistoryOpen((s) => ({ ...s, [f.quote_id]: true }))
                    setHistoryRefresh((s) => ({
                      ...s,
                      [f.quote_id]: (s[f.quote_id] ?? 0) + 1,
                    }))
                  }}
                />
              )}
              {historyOpen[f.quote_id] && (
                <div className="mt-3 border-t border-ink-line pt-3">
                  <FollowupHistory
                    quoteId={f.quote_id}
                    accessToken={accessToken}
                    refreshKey={historyRefresh[f.quote_id] ?? 0}
                  />
                </div>
              )}
              {threadOpen[f.quote_id] && (
                <div className="mt-3 border-t border-ink-line pt-3">
                  <FollowupThread
                    quoteId={f.quote_id}
                    accessToken={accessToken}
                  />
                </div>
              )}
            </div>
          ),
          ]
        })}
      </div>
    </Card>
      {composeFor && (
        <FollowupTextModal
          item={composeFor}
          accessToken={accessToken}
          onClose={() => setComposeFor(null)}
          onSent={(quoteId, channel) => {
            setComposeFor(null)
            setRowMsg(
              quoteId,
              'ok',
              channel === 'whatsapp' ? 'Sent via WhatsApp ✓' : 'Text sent ✓',
            )
            bumpHistory(quoteId)
          }}
        />
      )}
    </>
  )
}

// ─── Follow-up touch log + history (migration 039) ────────────────
// A touch event is one row in quote_followup_events: a call placed
// (auto-logged by /followups/call), an SMS sent (auto-logged by
// /followups/text), or a manual outcome a VA records via the form
// below. The History panel shows all of them newest-first so a VA
// can see prior contact attempts before calling again.

const OUTCOME_LABELS: Record<string, string> = {
  call_dialed: 'Called',
  text_sent: 'Texted',
  left_voicemail: 'Left voicemail',
  spoke: 'Spoke with customer',
  no_answer: 'No answer',
  wants_callback: 'Wants callback',
  not_interested: 'Not interested',
  other: 'Other',
}
const NOTE_OUTCOMES: Array<{ value: string; label: string }> = [
  { value: 'spoke', label: 'Spoke with customer' },
  { value: 'left_voicemail', label: 'Left voicemail' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'wants_callback', label: 'Wants callback' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'other', label: 'Other' },
]

type FollowupEvent = {
  id: string
  kind: 'call' | 'sms' | 'note'
  outcome: string | null
  summary: string | null
  note: string | null
  created_at: string
  actor_user_id: string | null
}

// Inline form (not a modal) so the card retains context — the VA can
// glance at the quote summary above while picking an outcome.
function FollowupLogForm({
  quoteId,
  accessToken,
  onCancel,
  onLogged,
}: {
  quoteId: string
  accessToken: string | null
  onCancel: () => void
  onLogged: (evt: FollowupEvent) => void
}) {
  const [outcome, setOutcome] = useState<string>('spoke')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!accessToken || saving) return
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch('/api/tenant/followups/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteId,
          kind: 'note',
          outcome,
          note: note.trim() || undefined,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        event?: FollowupEvent
        error?: string
      }
      if (!res.ok || !json.event) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      onLogged(json.event)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 border-t border-ink-line pt-3">
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.16em] text-text-dim mb-2">
        Log touch — what happened?
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {NOTE_OUTCOMES.map((o) => (
          <label
            key={o.value}
            className={`flex items-center gap-2 border px-3 py-2 cursor-pointer transition-colors ${
              outcome === o.value
                ? 'border-accent bg-accent/10 text-text-pri'
                : 'border-ink-line text-text-sec hover:border-accent/40 hover:text-text-pri'
            }`}
          >
            <input
              type="radio"
              name={`outcome-${quoteId}`}
              value={o.value}
              checked={outcome === o.value}
              onChange={() => setOutcome(o.value)}
              className="accent-accent"
            />
            <span className="text-sm">{o.label}</span>
          </label>
        ))}
      </div>
      <label className="mt-3 flex flex-col gap-1">
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim">
          Note (optional, up to 500 chars)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          placeholder="e.g. Wants to decide by Friday — call back after 3pm"
          rows={2}
          className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri resize-none"
        />
      </label>
      {err && <p className="mt-2 text-xs text-amber-300">{err}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="bg-accent hover:bg-accent-press text-white font-mono text-[0.62rem] uppercase tracking-[0.14em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save touch'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri font-mono text-[0.62rem] uppercase tracking-[0.14em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function FollowupHistory({
  quoteId,
  accessToken,
  refreshKey,
}: {
  quoteId: string
  accessToken: string | null
  // Bumping this prop forces a re-fetch — used after logging a new touch
  // so the History panel reflects the new event without a manual reload.
  refreshKey: number
}) {
  const [events, setEvents] = useState<FollowupEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!accessToken) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/tenant/followups/events?quoteId=${encodeURIComponent(quoteId)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
          },
        )
        const json = (await res.json().catch(() => ({}))) as {
          events?: FollowupEvent[]
          error?: string
        }
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setEvents(json.events ?? [])
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [quoteId, accessToken, refreshKey])

  if (loading) {
    return (
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-text-dim">
        Loading history…
      </p>
    )
  }
  if (err) {
    return <p className="text-xs text-amber-300">{err}</p>
  }
  if (!events || events.length === 0) {
    return (
      <p className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-text-dim">
        No touches logged yet. Calls, texts, and notes you log will appear here.
      </p>
    )
  }
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li
          key={e.id}
          className="border-l-2 border-ink-line pl-3 py-1 text-sm text-text-sec"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={`font-mono text-[0.6rem] uppercase tracking-[0.16em] font-bold px-1.5 py-0.5 border ${
                e.kind === 'note'
                  ? 'border-accent/60 text-accent'
                  : 'border-ink-line text-text-dim'
              }`}
            >
              {e.kind}
            </span>
            <span className="text-text-pri">
              {(e.outcome && OUTCOME_LABELS[e.outcome]) ||
                e.summary ||
                'Touch logged'}
            </span>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.14em] text-text-dim ml-auto">
              {fmtRelative(e.created_at)}
            </span>
          </div>
          {e.note && (
            <p className="mt-0.5 text-xs text-text-sec normal-case">
              {e.note}
            </p>
          )}
          {!e.note && e.kind === 'sms' && e.summary && (
            <p className="mt-0.5 text-xs text-text-dim normal-case">
              {e.summary.replace(/^SMS:\s*/, '')}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

function fmtRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const h = (Date.now() - t) / 36e5
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60))
    return `${m}m ago`
  }
  if (h < 48) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

// ─── Follow-up text modal ─────────────────────────────────────────
// Compose + send a real SMS from the tenant's provisioned number. Send
// failures (bad number, opted-out, no sender, carrier reject) surface
// INLINE here — the modal stays open with the text preserved so the VA
// can fix and retry. Success closes the modal and the card shows "sent".
function FollowupTextModal({
  item,
  accessToken,
  onClose,
  onSent,
}: {
  item: FollowupItem
  accessToken: string | null
  onClose: () => void
  onSent: (quoteId: string, channel: 'sms' | 'whatsapp') => void
}) {
  const firstName = item.customer.first_name || ''
  const jobLabel = fmtJobType(item.job_type)
  const amount =
    item.total_inc_gst != null ? fmtAUD(item.total_inc_gst) : null
  const defaultMsg =
    `Hi ${firstName || 'there'}, just following up on your ${jobLabel} quote` +
    `${amount ? ` (${amount} inc GST)` : ''}. Happy to answer any questions ` +
    `or lock in a time — just reply to this message.`
  const [text, setText] = useState(defaultMsg)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = text.trim()
  const segments = trimmed.length === 0 ? 0 : Math.ceil(trimmed.length / 153)

  async function send() {
    if (!accessToken || !trimmed || sending) return
    setSending(true)
    setErr(null)
    try {
      const res = await fetch('/api/tenant/followups/text', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ quoteId: item.quote_id, text: trimmed }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        channel?: 'sms' | 'whatsapp'
        message?: string
        error?: string
      }
      if (!res.ok || !json.ok) {
        setErr(
          json.message || json.error || `Couldn't send (HTTP ${res.status}).`,
        )
        return
      }
      onSent(item.quote_id, json.channel ?? 'sms')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error sending the text.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-ink border border-ink-line p-5 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-extrabold uppercase tracking-tight text-text-pri">
              Text {item.customer.full_name || 'customer'}
            </h3>
            <p className="mt-1 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-text-dim">
              From your QuoteMate number · {item.customer.phone ?? 'no number'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-dim hover:text-text-pri font-mono text-sm cursor-pointer"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {err && (
          <div className="mt-4 border border-amber-500/50 bg-amber-500/10 text-amber-200 text-sm px-3 py-2">
            {err}
          </div>
        )}

        <div className="mt-4 border border-ink-line bg-ink-deep p-3">
          <p className="mb-2 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-text-dim">
            Conversation
          </p>
          <FollowupThread
            quoteId={item.quote_id}
            accessToken={accessToken}
            compact
          />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={640}
          disabled={sending}
          aria-label="Follow-up message to the customer"
          placeholder="Type your follow-up message…"
          className="mt-3 w-full bg-ink-deep border border-ink-line text-text-pri text-sm p-3 outline-none focus:border-accent/60 disabled:opacity-60"
        />
        <p className="mt-1.5 font-mono text-[0.58rem] uppercase tracking-[0.14em] text-text-dim">
          {trimmed.length}/640 chars · ~{segments} SMS{' '}
          {segments === 1 ? 'segment' : 'segments'}
        </p>

        <div className="mt-5 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-4 py-2.5 min-h-[44px] transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || trimmed.length === 0}
            className="bg-accent hover:bg-accent-press text-white font-mono text-[0.62rem] uppercase tracking-[0.16em] font-bold px-5 py-2.5 min-h-[44px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending…' : 'Send text'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Follow-up SMS thread ─────────────────────────────────────────
// The two-way conversation with this customer (their replies + what we
// sent), oldest-first, each line stamped with WHEN it was sent. Used
// both as a card expander and inside the compose modal so the VA can
// read a reply before answering. Lazy-loads on mount.
function fmtSmsWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

type ThreadMsg = {
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
}

function FollowupThread({
  quoteId,
  accessToken,
  compact = false,
}: {
  quoteId: string
  accessToken: string | null
  compact?: boolean
}) {
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; msg: string }
    | {
        phase: 'ok'
        messages: ThreadMsg[]
        lastInbound: string | null
        lastOutbound: string | null
      }
  >({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!accessToken) {
        setState({ phase: 'error', msg: 'Not signed in' })
        return
      }
      try {
        const res = await fetch(
          `/api/tenant/followups/messages?quoteId=${encodeURIComponent(quoteId)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
          },
        )
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          messages?: ThreadMsg[]
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          error?: string
        }
        if (!res.ok || !json.ok) {
          throw new Error(json.error || `HTTP ${res.status}`)
        }
        if (!cancelled) {
          setState({
            phase: 'ok',
            messages: json.messages ?? [],
            lastInbound: json.last_inbound_at ?? null,
            lastOutbound: json.last_outbound_at ?? null,
          })
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            phase: 'error',
            msg: e instanceof Error ? e.message : 'Failed to load messages',
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [quoteId, accessToken])

  if (state.phase === 'loading') {
    return <p className="text-xs text-text-dim">Loading messages…</p>
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-amber-300">{state.msg}</p>
  }
  if (state.messages.length === 0) {
    return (
      <p className="text-xs text-text-dim">
        No messages yet. Your text and any reply from the customer will
        appear here.
      </p>
    )
  }

  const customerRepliedLast =
    !!state.lastInbound &&
    (!state.lastOutbound ||
      new Date(state.lastInbound) > new Date(state.lastOutbound))

  return (
    <div>
      {customerRepliedLast && (
        <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-emerald-300">
          Customer replied — awaiting your response
        </p>
      )}
      <div
        className={`space-y-2 overflow-y-auto pr-1 ${
          compact ? 'max-h-44' : 'max-h-72'
        }`}
      >
        {state.messages.map((m, i) => {
          const mine = m.direction === 'outbound'
          return (
            <div
              key={i}
              className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] px-3 py-2 text-sm ${
                  mine
                    ? 'bg-accent/15 border border-accent/40 text-text-pri'
                    : 'bg-ink-card border border-ink-line text-text-sec'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p
                  className={`mt-1 font-mono text-[0.55rem] uppercase tracking-[0.12em] ${
                    mine ? 'text-accent/80' : 'text-text-dim'
                  }`}
                >
                  {mine ? 'You' : 'Customer'} · {fmtSmsWhen(m.created_at)}
                </p>
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
            className="inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri font-mono text-[0.7rem] uppercase tracking-[0.16em] font-bold px-5 py-3 min-h-[44px] transition-colors cursor-pointer w-full sm:w-auto justify-center"
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
        className="w-full flex items-start justify-between gap-3 sm:gap-4 px-3 sm:px-4 py-3 text-left hover:bg-ink-deep/40 transition-colors cursor-pointer"
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
                <span className="hidden sm:inline text-text-dim">·</span>
                <span className="hidden sm:inline font-mono text-text-dim">{chat.from_number}</span>
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
      <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-ink-line">
        <h2 className="font-extrabold uppercase text-base tracking-[-0.01em] text-text-pri">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1.5 text-text-sec text-sm">{subtitle}</p>
        )}
      </div>
      <div className="px-4 sm:px-6 py-5 sm:py-6">{children}</div>
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
    case 'followups':
      return 'Follow-ups'
    case 'catalogue':
      return 'Catalogue'
    case 'estimating':
      return 'Estimating'
    case 'recipes':
      return 'Recipes'
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
