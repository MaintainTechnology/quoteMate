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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'
import { getAuthToken } from '@/lib/auth/client-token'
import { useFollowupBrowserOperations } from '@/lib/quote/use-followup-browser-operations'
import { CATEGORIES } from '@/lib/estimate/categories'
import { materialCategoriesFor } from '@/lib/estimate/material-vocabulary'
import {
  defaultAvailabilityForState,
  parseAvailability,
  type WeeklyAvailability,
} from '@/lib/quote/availability'
import { AvailabilityEditor } from '@/app/_components/AvailabilityEditor'
import { ChangePasswordCard } from './_components/ChangePasswordCard'
import { OverviewAnalytics } from './_components/OverviewAnalytics'
import { resolveTradeFormat, tierLabelsForTrade } from '@/lib/quote/trade-format'
import { confirmSendCta } from '@/lib/quote/send-customer'
import SendQuotePanel from '@/app/dashboard/quote/[token]/SendQuotePanel'
import {
  ALL_CATEGORY,
  filterFollowups,
  followupCategoryOptions,
} from '@/lib/quote/followup-filter'
import { asQuoteTierMode, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import { asQuoteKind } from '@/lib/quote/mint-tier'
import { resolveCatalogueBadge, badgeLabel } from '@/lib/dashboard/badge-state'
import {
  buildServiceTogglePayload,
  nextEnabledFor,
  applyOptimistic,
  reconcilePending,
  type PendingMap,
} from '@/lib/dashboard/service-toggle'
import { mapForkGaps, type ForkGapDisplay } from '@/lib/dashboard/fork-gaps'
import { licenceFieldsetsForTrades } from '@/lib/dashboard/licence-fieldsets'
import { collisionView } from '@/lib/dashboard/name-collision'
import {
  parseSearchTerms,
  quoteMatchesSearch,
  quoteInDateRange,
  quoteMatchesTrade,
  tradeOptionsFromQuotes,
  quoteTradeLabel,
  dateInRange,
} from '@/lib/dashboard/quote-filters'
import {
  jobQueueKey,
  jobTradieCtaLabel,
  jobTradeSlug,
  jobMatchesFilter,
  jobMatchesSearch,
  queueTradeOptions,
  compareQueueEntries,
  type QueueJob,
  type QueueEntry,
} from '@/lib/dashboard/quote-queue'
import {
  type Period,
  PERIODS,
  inPeriod,
  periodLabel,
  periodRange,
} from '@/lib/dashboard/period'
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
  Building2,
  LogOut,
  PhoneCall,
  Copy,
  Check,
  Banknote,
  CreditCard,
  Landmark,
  Wallet,
  Shield,
  Home,
  Megaphone,
  Paintbrush,
  AirVent,
  ScanLine,
  Sun,
  FolderOpen,
  History,
  CalendarDays,
  LayoutTemplate,
  Clapperboard,
  Sparkles,
  Trash2,
  Loader2,
  Zap,
  Droplets,
  Search,
  Bell,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  type LucideProps,
} from 'lucide-react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { hasPlanIntent } from '@/lib/billing/plan-intent'
import { tenantHasRoofingTrade } from '@/lib/roofing/tenant'
import { NO_BOOK_HUB_TRADES, showsHourlyPricingBook } from '@/lib/dashboard/pricing-visibility'
import { tenantHasFeature } from '@/lib/features/catalog'
import { isFeatureTab, isTabEnabled } from '@/lib/features/catalog'
import { RoofRatesEditor } from './_components/RoofRatesEditor'
import { SolarRatesEditor } from './_components/SolarRatesEditor'
import { PaintRatesEditor } from './_components/PaintRatesEditor'
import { EstimatorBetaTab } from './_components/EstimatorBetaTab'
import { SolarTab } from './_components/SolarTab'
import { BillingTab } from './_components/BillingTab'
import FlyerDesignerTab from './_components/FlyerDesignerTab'
import { FilesTab } from './_components/FilesTab'
import { HistoricalQuotesTab } from './_components/HistoricalQuotesTab'
import { CalendarTab } from './_components/CalendarTab'
import { VideosTab } from './_components/VideosTab'
import { HistoricalHint } from './_components/HistoricalHint'
import { savedJobsMode } from './_components/saved-jobs-mode'
import {
  mergeRecentActivity,
  jobRowView,
  attentionCandidate,
  widgetState,
  shouldRefresh,
  type TradeJobSummary,
} from '@/lib/dashboard/recent-activity'
import { isQuotesSurface } from '@/lib/dashboard/quotes-refresh'
import {
  clearTabCache,
  isFresh,
  readTabCache,
  staleTabCache,
  tabCacheKey,
  writeTabCache,
} from '@/lib/dashboard/tab-cache'
import { BootBanner } from './_components/BootBanner'
import CommercialPaintingTab from './_components/commercial-painting/CommercialPaintingTab'
import { PaginationControls, usePagination } from './_components/Pagination'
import { StatusPill, type Tone } from './_components/quote-ui'
import { BrandMark } from '@/app/_components/BrandMark'
import ThemeToggle from '@/app/_components/ThemeToggle'
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
  // Stripe Connect (Express) payout-account state — migration 056.
  // Synced from Stripe's account.updated event by the connect-webhook.
  stripe_connect_account_id: string | null
  stripe_connect_charges_enabled: boolean | null
  stripe_connect_payouts_enabled: boolean | null
  stripe_connect_details_submitted: boolean | null
  stripe_connect_onboarded_at: string | null
  /** Migration 104 — SMS electrical-plan estimation opt-in (Account tab). */
  sms_estimator_enabled: boolean | null
  /** Migration 141 — business logo shown on the customer quote letterhead.
   *  Changeable from the Account tab; the quote page reads logo_url live. */
  logo_url: string | null
  logo_path: string | null
  /** Migration 180 — the tradie's own photo, shown in the "Your tradie"
   *  section of the customer quote page AND the quote PDF. Set from the
   *  Account tab; null renders a placeholder avatar and prompts on Overview. */
  photo_url: string | null
  photo_path: string | null
  /** Migration 147 — default schedule availability (weekly working-hours
   *  template). Drives the customer-facing AM/PM booking windows. NULL for
   *  legacy tenants (falls back to available_slots / rolling window). */
  default_availability: WeeklyAvailability | null
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
  /** Migration 071 — customer-quote display preference. 'itemised' shows
   *  the full per-line breakdown (today's default); 'summary' rolls the
   *  line items up into a single scope paragraph + hours/items hint. */
  quote_display?: 'itemised' | 'summary' | null
  /** Migration 078 — tradie review-before-send policy. 'auto_send' is
   *  the default; 'always_review' holds every quote for tradie approval;
   *  'review_over_threshold' holds only when total_inc_gst >= threshold. */
  review_policy?: 'auto_send' | 'always_review' | 'review_over_threshold' | null
  /** Migration 078 — dollar threshold (inc-GST) used only when
   *  review_policy === 'review_over_threshold'. */
  review_threshold_inc_gst?: number | string | null
  /** Migration 079 — opt-in toggle for the 2-hour customer follow-up
   *  check-in cron. Fanned out across every pricing_book row this tenant
   *  owns by /api/tenant/me PATCH (same shape as quote_display +
   *  review_policy). Default false. */
  followup_2h_enabled?: boolean | null
  /** Migration 142 — per-feature customer-quote tier presentation mode.
   *  'single' (default) shows one price = the recommended tier;
   *  'good_better_best' shows all three; 'good'|'better'|'best' force one
   *  tier. PER-ROW (per-trade) — not fanned out. Resolver:
   *  lib/quote/tier-visibility.ts. */
  quote_tier_mode?: QuoteTierMode | null
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
  /** R40 — set by /api/tenant/me GET (annotateNameCollisions): TRUE when a
   *  row in the OTHER table (shared↔custom) shares this row's normalised name
   *  within the SAME trade. Drives the disambiguation badge in ServicesTab.
   *  Optional so older GET payloads / optimistic rows degrade to "no badge". */
  name_collision?: boolean
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
  /** quotes.paid_tier — WHAT was paid, not just that something was:
   *  'inspection' = the $99 site visit, 'deposit'/'credit' = the final
   *  quote's deposit, 'balance' = the completion payment. */
  paid_tier: string | null
  /** Mig 194 — the post-visit chain. A job is initial ($99) → final (deposit)
   *  → balance; children carry the kind and point at their parent. NULL/absent
   *  on every pre-194 row, which is 'initial' by definition. */
  quote_kind: 'initial' | 'final' | 'balance' | null
  parent_quote_id: string | null
  good: TierJson
  better: TierJson
  best: TierJson
  /** Migration 073 — per-quote override of the customer-facing display
   *  mode. NULL = inherit pricing_book.quote_display (Phase A default).
   *  'itemised' / 'summary' = explicit override applied to THIS quote. */
  display_mode: 'itemised' | 'summary' | null
  // Joined from intakes/payments
  customer_first_name: string | null
  customer_full_name: string | null
  customer_phone: string | null
  customer_email: string | null
  suburb: string | null
  job_type: string | null
  trade: string | null
  inspection_required: boolean | null
  deposit_paid: boolean
  /** Tradie-facing Measurement Results page (/m/[measure_token]) for a
   *  roofing quote promoted from a saved measurement. Null otherwise. */
  measure_href: string | null
  // Communication channel that produced this quote (Phase A + voice).
  //   'sms'   → conversation_id points at sms_conversations
  //   'voice' → messages come from parsed calls.transcript
  //   null    → legacy pre-v6 or unlinked
  channel: 'sms' | 'voice' | null
  conversation_id: string | null
  messages: ConvoMessage[]
}

/** A chained job (spec post-visit-money-sequence) is ONE job spread over three
 *  rows: the initial $99 site visit, the 'final' deposit and the 'balance'.
 *  Every count-of-jobs figure reads the ROOT only — counting the children would
 *  treble the pipeline volume and the conversion rate off one real job. */
function isChainRoot(q: Quote): boolean {
  return asQuoteKind(q.quote_kind) === 'initial'
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
  | 'payouts'
  | 'billing'
  | 'pricing'
  | 'services'
  | 'catalogue'
  | 'estimating'
  | 'recipes'
  | 'quotes'
  | 'chats'
  | 'followups'
  /** Calendar — every booking (self-serve request, reserved, confirmed, booked). Core tab. */
  | 'calendar'
  /** v10 — only rendered when tenant.trades includes 'roofing'. */
  | 'roofing'
  /** Signage compliance (HQ product) — links to standalone /dashboard/signage routes. */
  | 'signage'
  /** Painting estimate (Phase 1 scaffold) — links to /dashboard/painting. Not trade-gated yet. */
  | 'painting'
  /** Commercial painting (strategy v11) — document-driven takeoff → tender quote. Not trade-gated. */
  | 'commercial-painting'
  /** AC recommender (Phase 1) — links to /dashboard/aircon. Not trade-gated yet. */
  | 'aircon'
  /** Estimator (Beta) — electrical plan PDF → AI quantity take-off. Not trade-gated. */
  | 'estimator'
  /** Solar — AI solar PV estimates (share link, list, confirm & release). Not trade-gated. */
  | 'solar'
  /** Invitation codes — generate/manage onboarding allowlist + campaign codes. */
  | 'invites'
  /** Files — per-tenant document store: archived quotes/invoices + ask-your-docs chat. */
  | 'files'
  /** Historical quotes — import + analyse the tradie's own past pricing. */
  | 'historical-quotes'
  /** Flyer Designer — template-based marketing flyer editor (Marketing tool, all tenants). */
  | 'flyer'
  /** Trust videos — AI-generated welcome + thank-you videos for the customer
   *  quote pages (spec tradie-trust-video-generation). All tenants. */
  | 'videos'
  /** Trade hubs — one tab per enabled trade consolidating that trade's
   *  pricing, services, brands, catalogue, recipes, estimating, quotes,
   *  tools, and pricing-wizard entry. Gated by tenants.trades[]. */
  | HubTab

/** Every trade that can own a hub tab. Slugs match tenants.trades[] entries
 *  (lib/admin/trades.ts KNOWN_TRADES — note commercial_painting's underscore). */
const TRADE_HUB_SLUGS = [
  'electrical',
  'plumbing',
  'roofing',
  'signage',
  'painting',
  'commercial_painting',
  'aircon',
  'solar',
] as const
type TradeHubSlug = (typeof TRADE_HUB_SLUGS)[number]
type HubTab = `hub-${TradeHubSlug}`

const HUB_TABS: readonly HubTab[] = TRADE_HUB_SLUGS.map((s) => `hub-${s}` as HubTab)

// NO_BOOK_HUB_TRADES + showsHourlyPricingBook live in @/lib/dashboard/pricing-visibility
// (pure + unit-tested) — the trades priced by a rate-card editor rather than an
// hourly labour book. Used to suppress the hub pricing empty-state AND the
// hourly PricingBookCard for those trades.

function isHubTab(tab: string): tab is HubTab {
  return (HUB_TABS as readonly string[]).includes(tab)
}

/** hub-electrical → electrical */
function hubTrade(tab: HubTab): TradeHubSlug {
  return tab.slice(4) as TradeHubSlug
}

/** A hub is enabled when the trade slug appears in tenants.trades[]
 *  (case-insensitive; legacy single-trade tenants fall back to tenant.trade). */
function hubEnabled(slug: TradeHubSlug, trades: string[]): boolean {
  return trades.some((t) => typeof t === 'string' && t.toLowerCase() === slug)
}

/** Resolve the tenant's trade portfolio with the legacy single-trade fallback
 *  (pre-migration-017 tenants have trades=[] but a scalar trade). */
function tenantTradeList(tenant: { trades?: unknown; trade?: unknown } | null | undefined): string[] {
  const arr = Array.isArray(tenant?.trades)
    ? (tenant.trades as unknown[]).filter((t): t is string => typeof t === 'string')
    : []
  if (arr.length > 0) return arr
  return typeof tenant?.trade === 'string' && tenant.trade ? [tenant.trade] : []
}

/** Tabs reachable via /dashboard?tab=… (e.g. the estimator run page's breadcrumb). */
const DEEP_LINK_TABS: readonly Tab[] = [
  'overview', 'account', 'payouts', 'billing', 'pricing', 'services', 'catalogue', 'estimating',
  'recipes', 'quotes', 'chats', 'followups', 'calendar', 'roofing', 'signage', 'painting',
  'commercial-painting', 'aircon', 'estimator', 'solar', 'invites', 'files', 'historical-quotes', 'flyer',
  'videos',
  ...HUB_TABS,
]

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
  // Chats-tab filter. The Overview "chats went cold" CTA flips this to 'cold'
  // so the Chats tab lands on just the abandoned conversations that count
  // refers to — not the full recent list. Reset to 'all' whenever the user
  // leaves Chats (effect below) so a later plain visit starts unfiltered.
  const [chatFilter, setChatFilter] = useState<'all' | 'cold'>('all')
  // Desktop rail fold (reference design) — persisted so the tradie's
  // choice survives reloads. Read after mount to keep SSR/CSR in sync.
  const [railCollapsed, setRailCollapsed] = useState(false)
  useEffect(() => {
    try {
      if (localStorage.getItem('qm-dash-rail') === 'collapsed') {
        setRailCollapsed(true)
      }
    } catch {
      /* private mode / blocked storage — ignore */
    }
  }, [])
  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem('qm-dash-rail', next ? 'collapsed' : 'open')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])
  // is_admin gates the "Admin loader" sidebar entry. Probe lazily off the
  // access token — non-admin users never see the link. Server still
  // enforces admin on every /admin/* route (the link is just UX).
  const [isAdmin, setIsAdmin] = useState(false)

  // Clerk session (dual-auth Supabase↔Clerk). getToken() yields a Clerk JWT
  // the API verifies (→ clerk_user_id); clerkLoaded gates the mount effect so
  // we don't misfire the sign-in bounce before Clerk has hydrated.
  const {
    getToken,
    isLoaded: clerkLoaded,
    isSignedIn: clerkSignedIn,
    signOut: clerkSignOut,
  } = useAuth()

  // On mount: confirm we have a session, then load the dashboard payload.
  useEffect(() => {
    let cancelled = false
    if (!clerkLoaded) return // wait for Clerk to hydrate so getToken() is reliable
    ;(async () => {
      // Dual-auth: prefer a Clerk session token; fall back to the legacy
      // Supabase session so users mid-migration are never bounced out.
      const supabase = getBrowserSupabase()
      let token: string | null = null
      if (clerkSignedIn) {
        token = await getToken().catch(() => null)
      }
      if (!token) {
        const { data: sessionData } = await supabase.auth.getSession()
        token = sessionData.session?.access_token ?? null
      }
      if (!token) {
        // Not signed in to either provider → bounce to Clerk sign-in.
        router.replace('/sign-in')
        return
      }
      if (cancelled) return
      setAccessToken(token)
      // Deep-link: /dashboard?tab=estimator lands straight on that tab (used
      // by the estimator run page's breadcrumb).
      const want = new URLSearchParams(window.location.search).get('tab')
      if (want && (DEEP_LINK_TABS as readonly string[]).includes(want)) {
        setTab(want as Tab)
      } else if (hasPlanIntent()) {
        // A plan was chosen on /pricing before signup — land on Billing so
        // the tab resumes that plan's Checkout (plan-intent hand-off).
        setTab('billing')
      }
      await refresh(token)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clerkLoaded])

  // If a deep-link (?tab=) or a remembered tab points at a feature the tenant
  // doesn't have (no gating slug in trades[]), fall back to overview once the
  // tenant payload loads. buildNav already hides the tab; this covers the
  // direct-URL path so a disabled feature never renders its tool.
  useEffect(() => {
    if (!data) return
    const trades = tenantTradeList(data.tenant)
    if (isFeatureTab(tab) && !isTabEnabled(tab, trades)) setTab('overview')
    if (isHubTab(tab) && !hubEnabled(hubTrade(tab), trades)) setTab('overview')
  }, [data, tab])

  // Reset the Chats filter once the tradie navigates away from Chats, so the
  // cold-only view set by the "chats went cold" CTA doesn't stick to the next
  // plain visit. Entering Chats via the CTA sets 'cold' then switches tab in
  // the same batch, so this never clobbers that intent.
  useEffect(() => {
    if (tab !== 'chats') setChatFilter('all')
  }, [tab])

  // Lazily probe is_admin once the access token lands. Fails CLOSED — any
  // network/server hiccup leaves isAdmin false so the link stays hidden.
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    void (async () => {
      try {
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/admin/whoami', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) return
        const json = (await res.json()) as { ok?: boolean; is_admin?: boolean }
        if (!cancelled && json?.is_admin === true) setIsAdmin(true)
      } catch {
        // swallow — keep isAdmin=false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken])

  // Welcome email — fire once when a freshly-activated tradie first reaches the
  // dashboard. The endpoint (POST /api/tenant/welcome-email) is idempotent: the
  // single send is guarded server-side by tenants.welcome_email_sent_at, so
  // this is genuinely fire-and-forget — we never surface its result in the UI.
  // Gated on status='active' so a tenant still finishing provisioning doesn't
  // trigger it early. On a network error we clear the ref so the next load
  // retries (the server still won't double-send if it actually went out).
  const welcomeFiredRef = useRef(false)
  useEffect(() => {
    if (!accessToken || welcomeFiredRef.current) return
    const status = (data?.tenant as { status?: string } | undefined)?.status
    if (status !== 'active') return
    welcomeFiredRef.current = true
    void (async () => {
      const token = (await getAuthToken()) ?? accessToken
      await fetch('/api/tenant/welcome-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    })().catch(() => {
      welcomeFiredRef.current = false
    })
  }, [accessToken, data])

  // Refresh-on-return (spec dashboard-overview-quotes-sync T6): re-pull the
  // dashboard payload in the background when the tradie comes back — window
  // focus / visibility, or switching back to Overview/Quotes — throttled to
  // once per 15s. refresh() keeps the old payload until the new one lands,
  // so a background refresh never flashes the loading skeleton.
  const lastFetchedRef = useRef<number | null>(null)
  // Bumped on every throttled return-refresh so OverviewTab re-pulls its own
  // lazy fetches (trade jobs + chats) too — /api/tenant/me alone would leave
  // the merged feed stale for work done in another browser tab.
  const [returnRefreshSignal, setReturnRefreshSignal] = useState(0)
  async function maybeRefreshOnReturn() {
    if (!accessToken) return // mount effect owns the first load
    if (!shouldRefresh(lastFetchedRef.current, Date.now())) return
    // Stamp BEFORE any await — window 'focus' and 'visibilitychange' fire in
    // the same tick on tab return, and both passing the guard would fire a
    // duplicate /api/tenant/me fetch.
    lastFetchedRef.current = Date.now()
    setReturnRefreshSignal((n) => n + 1)
    const token = (await getAuthToken()) ?? accessToken
    await refresh(token)
  }
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return
      void maybeRefreshOnReturn()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken])
  useEffect(() => {
    // Quotes surfaces (workspace + trade hubs, spec quotes-tab-sync T5) and
    // the Overview (spec dashboard-overview-quotes-sync T6) both re-pull on
    // return; maybeRefreshOnReturn owns the shared 15s throttle.
    if (tab === 'overview' || isQuotesSurface(tab)) void maybeRefreshOnReturn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  async function refresh(token: string) {
    setLoadError(null)
    lastFetchedRef.current = Date.now()
    try {
      const res = await fetch('/api/tenant/me', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        // Bounded so a hung connection can't leave the boot banner up
        // forever — the catch below lands on the error screen with Retry.
        signal: AbortSignal.timeout(30_000),
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
    } catch (err: unknown) {
      // AbortSignal.timeout rejects with a DOMException named TimeoutError.
      setLoadError(
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The dashboard took too long to load — try again.'
          : err instanceof Error && err.message
            ? err.message
            : 'Failed to load dashboard',
      )
    }
  }

  async function patch(payload: Record<string, unknown>) {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch('/api/tenant/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
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
    await refresh(token)
  }

  // Brand-image change — logo (migration 141) or the tradie's photo
  // (migration 180). Uploads to /api/tenant/<kind> (authenticated, multipart)
  // which stores it + writes tenants.<kind>_url, then re-fetches so the
  // Account-tab preview — and every customer quote surface — reflects it.
  async function uploadBrandImage(kind: 'logo' | 'photo', file: File): Promise<void> {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/tenant/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      throw new Error(body?.error ?? `Upload failed (HTTP ${res.status})`)
    }
    await refresh(token)
  }

  // ── Custom-service helpers (migration 023) ───────────────────────
  // POST/PATCH/DELETE against /api/tenant/services. Each helper
  // re-fetches the dashboard payload on success so the list reflects
  // the new state. Throws a friendly Error message on failure so the
  // form can surface it inline.
  async function createCustomService(payload: Record<string, unknown>) {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch('/api/tenant/services', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body?.message ?? body?.error ?? `Create failed (HTTP ${res.status})`)
    }
    await refresh(token)
    return body as { ok: true; service: unknown }
  }

  async function updateCustomService(id: string, payload: Record<string, unknown>) {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch(`/api/tenant/services/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body?.message ?? body?.error ?? `Update failed (HTTP ${res.status})`)
    }
    await refresh(token)
    return body as { ok: true; service: unknown }
  }

  async function deleteCustomService(id: string) {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch(`/api/tenant/services/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.error ?? `Delete failed (HTTP ${res.status})`)
    }
    await refresh(token)
  }

  /**
   * Reconcile the tenant's trades[] via POST /api/tenant/trades.
   * Triggers the pricing_book + service_offerings + Vapi prompt update
   * server-side and reloads the dashboard. Returns the response body so
   * the caller can show e.g. "AI receptionist updated".
   */
  async function saveTrades(trades: string[]) {
    if (!accessToken && !(await getAuthToken())) throw new Error('not signed in')
    // Unified Save path: POST the full desired set to /reconcile, which
    // ACTIVATES newly-selected trades (atomic activate_trade_for_tenant —
    // seeds pricing_book + service offerings + tenants.trades[]) and
    // DEACTIVATES deselected ones. This is what makes each trade's job type
    // genuinely live, not just a label.
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch('/api/tenant/trades/reconcile', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trades }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(
        body?.message ?? body?.error ?? `Trade update failed (HTTP ${res.status})`,
      )
    }
    await refresh(token)
    return body as {
      ok: true
      trades: string[]
      activated: string[]
      deactivated: string[]
      warning?: string
      noop?: boolean
    }
  }

  /**
   * §10 — list the trades this tradie can turn on: loader-created trades
   * that are active, install/job-based, carry pricing defaults, and are
   * not already on the account. Read-only GET.
   */
  async function listAvailableTrades() {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch('/api/tenant/trades/available', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.error ?? `Could not load trades (HTTP ${res.status})`)
    }
    return body as {
      ok: true
      available: Array<{ name: string; displayName: string }>
      manageable: Array<{ name: string; displayName: string; owned: boolean }>
    }
  }

  /**
   * §10 — activate a new trade. The server runs the atomic activation
   * (append trades[], seed pricing_book from trade_pricing_defaults, seed
   * tenant_service_offerings) then refreshes the Vapi assistant. Reloads
   * the dashboard so the new trade's services appear.
   */
  async function activateTrade(trade: string) {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) throw new Error('not signed in')
    const res = await fetch('/api/tenant/trades/activate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trade }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(
        body?.message ?? body?.error ?? `Activation failed (HTTP ${res.status})`,
      )
    }
    await refresh(token)
    return body as { ok: true; trade: string; warning?: string }
  }

  async function signOut() {
    // Dual-auth: clear BOTH sessions so sign-out is complete regardless of
    // which provider the tradie logged in with.
    const supabase = getBrowserSupabase()
    await supabase.auth.signOut().catch(() => {})
    try {
      await clerkSignOut()
    } catch {
      /* ignore — Supabase sign-out already ran */
    }
    // Cached tab data is tenant-scoped — never let it leak into the next
    // account that signs in on this device (specs/dashboard-performance.md R4).
    clearTabCache()
    router.replace('/sign-in')
  }

  if (loadError) {
    return (
      <Shell businessName={null} onSignOut={signOut}>
        <div className="max-w-xl">
          <ErrorBanner>{loadError}</ErrorBanner>
          <button
            onClick={() => accessToken && refresh(accessToken)}
            className="rounded-ctl mt-4 inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider"
          >
            Try again
          </button>
        </div>
      </Shell>
    )
  }

  if (!data) {
    // Same banner app/dashboard/loading.tsx paints during the chunk
    // download, kept up through hydration → Clerk → /api/tenant/me so the
    // whole boot reads as one continuous loading screen (spec R2). Banner
    // ONLY — a Shell+skeleton beneath the opaque overlay is dead render
    // work, and refresh() is time-bounded (30s AbortSignal) so a hung
    // fetch lands on the error screen (Retry + sign-out) instead of
    // trapping the tradie behind an undismissable white screen.
    return <BootBanner />
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
      topbar={{
        navItems: buildNav(data.quotes.length, tenantTradeList(data.tenant)),
        setTab,
        quotes: data.quotes,
      }}
    >
      {/* App shell — flush-left full-height sidebar (its right border is the
          only divider) + a scrollable content column, matching the QuoteMax
          dashboard reference. The sidebar is hidden below lg, where the
          MobileTabBar takes over. The grid column width animates on collapse. */}
      <div
        className={`lg:grid lg:items-stretch motion-safe:transition-[grid-template-columns] motion-safe:duration-300 motion-safe:[transition-timing-function:cubic-bezier(0.22,1,0.36,1)] ${
          railCollapsed
            ? 'lg:grid-cols-[3.75rem_minmax(0,1fr)]'
            : 'lg:grid-cols-[15rem_minmax(0,1fr)]'
        }`}
      >
        <Sidebar
          tab={tab}
          setTab={setTab}
          quoteCount={data.quotes.length}
          isAdmin={isAdmin}
          trades={tenantTradeList(data.tenant)}
          collapsed={railCollapsed}
          onToggleCollapse={toggleRail}
        />
        <div className="min-w-0">
          <div className="mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8 py-5 sm:py-6 pb-20">
            {/* Mobile tab strip (< lg). Hidden on desktop — sidebar takes over. */}
            <MobileTabBar
              tab={tab}
              setTab={setTab}
              quoteCount={data.quotes.length}
              trades={tenantTradeList(data.tenant)}
            />
            {/* Still no key (spec R3): keying by tab forced a full tear-down
                + remount just to replay a fade. `.qm-tab-panel` gets the fade
                back for free — each tab is a DIFFERENT component, so React
                inserts fresh DOM on every switch and the CSS animation on
                `.qm-tab-panel > *` replays by itself. Tab data still survives
                revisits in lib/dashboard/tab-cache.
                Deliberately short (240ms, 6px): a tradie hits these tabs
                dozens of times a shift, so the swap is there to stop content
                flashing into place, not to be admired. */}
            <div className="qm-tab-panel mt-4 lg:mt-0">
            {/* Calendar renders its own image-spec header (with Sync / New
                booking actions), so the generic TabHeader is suppressed for it.
                Chats is a full-bleed two-pane workspace with its own rail
                header (specs/chats-tab-redesign.md) — no TabHeader either. */}
            {tab !== 'overview' && tab !== 'calendar' && tab !== 'chats' && !isHubTab(tab) && <TabHeader tab={tab} />}
            {tab === 'overview' && (
              <OverviewTab
                data={data}
                accessToken={accessToken}
                setTab={setTab}
                refreshSignal={returnRefreshSignal}
                onFollowUpColdChats={() => {
                  setChatFilter('cold')
                  setTab('chats')
                }}
              />
            )}
            {tab === 'account' && (
              <AccountTab
                data={data}
                onSave={patch}
                onSaveTrades={saveTrades}
                onListAvailableTrades={listAvailableTrades}
                onActivateTrade={activateTrade}
                onUploadLogo={(f) => uploadBrandImage('logo', f)}
                onUploadPhoto={(f) => uploadBrandImage('photo', f)}
              />
            )}
            {tab === 'payouts' && (
              <PayoutsTab
                data={data}
                accessToken={accessToken}
                onSynced={() => {
                  if (accessToken) void refresh(accessToken)
                }}
              />
            )}
            {tab === 'pricing' && (
              <PricingTab data={data} onSave={patch} accessToken={accessToken} sharedOnly />
            )}
            {tab === 'services' && (
              <ServicesTab
                data={data}
                onSave={patch}
                onCreateCustom={createCustomService}
                onUpdateCustom={updateCustomService}
                onDeleteCustom={deleteCustomService}
              />
            )}
            {tab === 'billing' && <BillingTab accessToken={accessToken} />}
            {tab === 'files' && <FilesTab accessToken={accessToken} />}
            {tab === 'historical-quotes' && <HistoricalQuotesTab accessToken={accessToken} />}
            {tab === 'catalogue' && <CatalogueTab accessToken={accessToken} />}
            {tab === 'estimating' && <EstimatingTab accessToken={accessToken} />}
            {tab === 'recipes' && <RecipesTab accessToken={accessToken} />}
            {tab === 'quotes' && (
              <QuotesTab
                data={data}
                accessToken={accessToken}
                // Deletion must land in the parent-owned DashboardData —
                // QuotesTab unmounts on tab switch, and Overview's KPIs +
                // recent-quotes preview read the same data.quotes. A local
                // set in the tab would resurrect deleted rows on remount.
                onQuoteDeleted={(id) =>
                  setData((prev) =>
                    prev
                      ? { ...prev, quotes: prev.quotes.filter((q) => q.id !== id) }
                      : prev,
                  )
                }
              />
            )}
            {tab === 'calendar' && (
              <CalendarTab accessToken={accessToken} onGoToQuotes={() => setTab('quotes')} />
            )}
            {tab === 'followups' && (
              <FollowupsTab
                accessToken={accessToken}
                onGoToCalendar={() => setTab('calendar')}
              />
            )}
            {tab === 'chats' && (
              /* Escape the content wrapper's gutters + bottom padding so the
                 two-pane conversations workspace runs full-bleed on the
                 canvas (no card containers — spec R1). Top padding is only
                 cancelled at lg where the chrome above is just the topnav. */
              <div className="-mx-4 -mb-20 sm:-mx-6 lg:-mx-8 lg:-mt-6">
                <ChatsTab
                  accessToken={accessToken}
                  tenantId={data.tenant.id}
                  isMultiTrade={
                    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 1
                  }
                  filter={chatFilter}
                  onFilterChange={setChatFilter}
                  onGoToQuotes={() => setTab('quotes')}
                />
              </div>
            )}
            {tab === 'roofing' && <RoofingHubTab accessToken={accessToken} />}
            {tab === 'signage' && <SignageHubTab accessToken={accessToken} />}
            {tab === 'painting' && <PaintingHubTab accessToken={accessToken} />}
            {tab === 'aircon' && (
              <div className="space-y-7">
                <Link
                  href="/dashboard/aircon"
                  className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
                >
                  <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
                    AC
                  </span>
                  <div className="flex-1">
                    <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
                      Air-conditioning recommender
                    </h3>
                    <p className="mt-4 text-base leading-relaxed text-text-sec">
                      Size a home and get an indicative ducted-vs-split recommendation with a price range. Opens the full tool.
                    </p>
                    <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
                      Open AC recommender <span aria-hidden="true">&rarr;</span>
                    </span>
                  </div>
                </Link>
              </div>
            )}
            {tab === 'commercial-painting' && <CommercialPaintingTab accessToken={accessToken} />}
            {tab === 'estimator' && <EstimatorBetaTab accessToken={accessToken} />}
            {tab === 'solar' && (
              <SolarTab
                accessToken={accessToken}
                tenantId={data.tenant.id}
                appUrl={process.env.NEXT_PUBLIC_APP_URL ?? null}
              />
            )}
            {tab === 'invites' && (
              <div className="space-y-7">
                <Link
                  href="/dashboard/invites"
                  className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
                >
                  <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
                    QR
                  </span>
                  <div className="flex-1">
                    <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
                      Marketing
                    </h3>
                    <p className="mt-4 text-base leading-relaxed text-text-sec">
                      QR codes turn printed flyers into AI-drafted quotes — generate, download, and track scans. Opens the full manager.
                    </p>
                    <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
                      Open marketing <span aria-hidden="true">&rarr;</span>
                    </span>
                  </div>
                </Link>
                <Link
                  href="/dashboard/crm"
                  className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
                >
                  <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
                    CRM
                  </span>
                  <div className="flex-1">
                    <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
                      CRM &amp; Email
                    </h3>
                    <p className="mt-4 text-base leading-relaxed text-text-sec">
                      Connect HubSpot or Zoho, import your contacts, and send a one-tap announcement that you&apos;re now on QuoteMax — with a QR code that turns a scan into an instant quote.
                    </p>
                    <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
                      Open CRM &amp; email <span aria-hidden="true">&rarr;</span>
                    </span>
                  </div>
                </Link>
                <Link
                  href="/dashboard/studio"
                  className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
                >
                  <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
                    STUDIO
                  </span>
                  <div className="flex-1">
                    <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
                      Brand Studio
                    </h3>
                    <p className="mt-4 text-base leading-relaxed text-text-sec">
                      Make on-brand social posts from the QuoteMax design system — edit the copy, live-preview each slide, and export a LinkedIn carousel PDF or a single PNG.
                    </p>
                    <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
                      Open studio <span aria-hidden="true">&rarr;</span>
                    </span>
                  </div>
                </Link>
              </div>
            )}
            {tab === 'flyer' && <FlyerDesignerTab accessToken={accessToken} />}
            {tab === 'videos' && <VideosTab accessToken={accessToken} />}
            {isHubTab(tab) && (
              // key={tab}: a DIFFERENT hub is a different workspace — remount
              // so section state can't bleed a section the next hub doesn't
              // have (same-hub section clicks no longer remount, spec R3).
              <TradeHub
                key={tab}
                trade={hubTrade(tab)}
                data={data}
                accessToken={accessToken}
                onSave={patch}
                onCreateCustom={createCustomService}
                onUpdateCustom={updateCustomService}
                onDeleteCustom={deleteCustomService}
                onQuoteDeleted={(id) =>
                  setData((prev) =>
                    prev
                      ? { ...prev, quotes: prev.quotes.filter((q) => q.id !== id) }
                      : prev,
                  )
                }
              />
            )}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  )
}

// ─── Shell + Status badge ─────────────────────────────────────────

/** Live context the authenticated topbar needs for the reference-design
 *  chrome — the ⌘K command palette and the notifications bell. Loading and
 *  error Shells omit it, so those states render the plain brand bar. */
type TopbarContext = {
  navItems: NavItem[]
  setTab: (t: Tab) => void
  quotes: Quote[]
}

function Shell({
  businessName,
  onSignOut,
  children,
  wide,
  ownerFirstName,
  tenantStatus,
  tenantSubtitle,
  topbar,
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
  /** Authenticated chrome — search palette + notifications. Optional so
   *  the loading/error Shells keep working unchanged. */
  topbar?: TopbarContext
}) {
  const showProfile = !!ownerFirstName
  const [paletteOpen, setPaletteOpen] = useState(false)
  const hasTopbar = !!topbar

  // ⌘K / Ctrl+K toggles the command palette (reference-design shortcut).
  useEffect(() => {
    if (!hasTopbar) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasTopbar])

  return (
    <main className="min-h-screen app-canvas text-text-pri flex flex-col">
      {/* Film grain — kills the banding that makes flat dark UIs read as
          cheap. Fixed + non-interactive, same treatment as the reference
          dashboard and the marketing canvas. */}
      <div aria-hidden="true" className="noise-overlay" />
      <nav className="border-b border-ink-line bg-ink-deep/90 backdrop-blur-md sticky top-0 z-30">
        {/* No `justify-between` here. That was what pushed the search field
            into the dead centre of the bar — a marketing-site pattern. In a
            tool the eye starts top-left and travels right, so search anchors
            beside the brand and the action group is pushed out with
            `ml-auto` instead. */}
        <div
          className={`flex items-center gap-2 sm:gap-3 px-4 sm:px-5 h-[60px] ${
            wide ? 'w-full' : 'mx-auto max-w-7xl'
          }`}
        >
          <Link href="/dashboard" className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
            <BrandMark className="h-9 w-auto sm:h-10" />
            {/* Reference lockup — mark + wordmark only. The tradie's
                business name lives in the profile chip (top-right), not
                here, matching the QuoteMax dashboard reference. */}
            <span className="hidden sm:inline font-extrabold uppercase tracking-tight text-text-pri shrink-0">
              QuoteMax
            </span>
          </Link>

          {/* Hairline between identity and tools. Only from lg, where the
              anchored search sits beside it — below that the bar is too tight
              to spend 17px on a divider. */}
          <span aria-hidden="true" className="hidden lg:block h-6 w-px bg-ink-line shrink-0" />

          {/* Search — a field-styled button (not a real input) that opens the
              ⌘K palette. Fixed width and anchored left: a search that stretches
              to fill the bar reads as the page's main job, which it isn't. */}
          {topbar && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden lg:flex w-[320px] shrink-0 items-center gap-2.5 h-9 px-3 rounded-lg bg-ink border border-ink-line text-left transition-colors cursor-pointer hover:border-text-dim"
              aria-label="Search quotes, customers, jobs"
              aria-haspopup="dialog"
            >
              <Search size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-text-dim" />
              <span className="flex-1 truncate text-[0.8rem] text-text-dim">
                Search quotes, customers, jobs
              </span>
              <kbd className="shrink-0 border border-ink-line rounded-[5px] px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold text-text-dim">
                ⌘K
              </kbd>
            </button>
          )}

          {/* Below lg the same trigger becomes a FLEXIBLE FIELD rather than a
              41px icon square. On a phone the old bar crammed five equal icon
              buttons in a row and clipped the avatar off the right edge; giving
              search the leftover width and dropping the rest to two controls is
              what unpicks that. */}
          {topbar && (
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search quotes, customers, jobs"
              aria-haspopup="dialog"
              className="lg:hidden flex min-w-0 flex-1 items-center gap-2 h-10 px-3 rounded-lg bg-ink border border-ink-line text-left transition-colors cursor-pointer hover:border-text-dim"
            >
              <Search size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-text-dim" />
              <span className="truncate text-[0.8rem] text-text-dim">Search</span>
            </button>
          )}

          <div className="ml-auto flex items-center gap-1 sm:gap-1.5 shrink-0">
            {/* New quote — the reference topbar's primary action. Quotes are
                drafted from customer SMS/voice, so (like the reference's own
                goQuotes) this opens the Quotes queue rather than a manual
                composer. Yellow fill, dark ink — never white on yellow. */}
            {/* The one rank-1 action in the chrome. Hidden below sm: on a
                phone it degraded to an unlabelled yellow square that read as
                a fifth icon, and the same action already sits in the page
                body and the mobile tab bar. A primary action with no label
                is not a primary action. */}
            {topbar && (
              <button
                type="button"
                onClick={() => topbar.setTab('quotes')}
                aria-label="Review queue"
                className="hidden sm:inline-flex h-9 items-center gap-2 rounded-ctl bg-accent px-4 text-[13px] font-bold text-accent-ink transition-colors cursor-pointer hover:bg-accent-press"
              >
                <FileText size={16} strokeWidth={2.25} aria-hidden="true" className="shrink-0" />
                <span>Review queue</span>
              </button>
            )}
            {/* Bell + theme are a matched utility PAIR, so they get their own
                tight group and a gap from the primary above. Previously they
                sat at the same spacing as everything else, which is why the
                right-hand end read as four unrelated controls. */}
            <div className="flex items-center gap-0.5 sm:ml-2">
              {topbar && (
                <NotificationsBell
                  quotes={topbar.quotes}
                  onOpenQuotes={() => topbar.setTab('quotes')}
                />
              )}
              <ThemeToggle />
            </div>
            {showProfile ? (
              <>
                <span
                  aria-hidden="true"
                  className="hidden sm:block h-6 w-px bg-ink-line mx-1"
                />
                <ProfileChip
                  firstName={ownerFirstName!}
                  businessName={businessName}
                  subtitle={tenantSubtitle ?? null}
                  status={tenantStatus ?? null}
                  onSignOut={onSignOut}
                  onAccount={topbar ? () => topbar.setTab('account') : undefined}
                />
              </>
            ) : (
              /* Loading / error shells have no profile chip — keep a plain
                 Sign out control so the tradie is never stranded. */
              <button
                type="button"
                onClick={onSignOut}
                aria-label="Sign out"
                className="inline-flex items-center gap-2 self-stretch rounded-ctl border border-ink-line px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wider text-text-sec transition-colors cursor-pointer hover:border-text-dim hover:bg-ink-card hover:text-text-pri"
              >
                <LogOut
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="shrink-0"
                />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            )}
          </div>
        </div>
      </nav>
      {topbar && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          navItems={topbar.navItems}
          setTab={topbar.setTab}
          quotes={topbar.quotes}
        />
      )}
      {wide ? (
        /* Dashboard app body — full-width, no centering. The children provide
           the flush-left sidebar + content column themselves. */
        <div className="flex-1 w-full min-w-0">{children}</div>
      ) : (
        /* Loading / error shells — a centred, narrow column. */
        <div className="flex-1 mx-auto w-full max-w-5xl px-4 sm:px-6 py-10">
          {children}
        </div>
      )}
    </main>
  )
}

/** Identity chip + account menu in the top-nav right cluster. A single
 *  chip — accent avatar square, owner name, business name, chevron — that
 *  opens a dropdown carrying the account-status readout, an Account jump,
 *  and Sign out. Mirrors the QuoteMax dashboard reference; Sign out lives
 *  in the menu, not as a bare nav button. Click-away + ESC close it and
 *  return focus to the trigger. */
function ProfileChip({
  firstName,
  businessName,
  subtitle,
  status,
  onSignOut,
  onAccount,
}: {
  firstName: string
  businessName: string | null
  subtitle: string | null
  status: 'onboarding' | 'active' | null
  onSignOut: () => void
  onAccount?: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const initial = (firstName.trim()[0] ?? '?').toUpperCase()
  const active = status === 'active'
  const subline = businessName || subtitle

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Account menu"
        className="flex h-11 md:h-9 items-center gap-2.5 overflow-hidden rounded-ctl border border-ink-line bg-ink-card/70 pr-2.5 transition-colors cursor-pointer hover:border-text-dim"
      >
        {/* Avatar — solid accent square, the same mark language as the
            QuoteMax logo so the identity reads as part of the system. */}
        <span
          aria-hidden="true"
          className="grid h-full w-11 md:w-9 shrink-0 place-items-center bg-accent font-mono text-base font-extrabold text-accent-ink"
        >
          {initial}
        </span>
        <span className="hidden sm:flex min-w-0 flex-col justify-center text-left leading-tight">
          <span className="truncate text-sm font-bold text-text-pri">
            {firstName}
          </span>
          {subline && (
            <span className="mt-0.5 truncate text-[0.55rem] uppercase tracking-[0.08em] text-text-dim">
              {subline}
            </span>
          )}
        </span>
        <ChevronDown
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className={`hidden sm:block shrink-0 text-text-dim transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+10px)] z-40 w-[min(260px,88vw)] overflow-hidden rounded-card edge-lit border border-ink-line bg-ink-card shadow-[0_16px_40px_-12px_rgba(11,9,7,0.55)]">
          <div className="border-b border-ink-line px-4 py-3">
            <div className="truncate text-sm font-extrabold uppercase tracking-[0.02em] text-text-pri">
              {firstName}
            </div>
            {businessName && (
              <div className="mt-0.5 truncate text-[0.58rem] uppercase tracking-[0.08em] text-text-dim">
                {businessName}
              </div>
            )}
            {(subtitle || status) && (
              <div className="mt-2 flex items-center gap-2">
                {status && (
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${
                      active ? 'bg-success-bright' : 'bg-warning-bright'
                    }`}
                  />
                )}
                <span className=" text-[0.58rem] uppercase tracking-[0.08em] text-text-sec">
                  {[subtitle, status ? (active ? 'Active' : 'Onboarding') : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            )}
          </div>
          {onAccount && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onAccount()
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[0.8rem] font-semibold text-text-sec transition-colors cursor-pointer hover:bg-ink-deep/50 hover:text-text-pri"
            >
              <User size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
              Account settings
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="flex w-full items-center gap-2.5 border-t border-ink-line px-4 py-2.5 text-left text-[0.8rem] font-semibold text-text-sec transition-colors cursor-pointer hover:bg-ink-deep/50 hover:text-text-pri"
          >
            <LogOut size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/** Notifications bell + dropdown panel — the reference topbar's activity
 *  feed. Sourced entirely from the quotes already loaded by /api/tenant/me:
 *  every quote still sitting in the review queue is a notification. A row
 *  (or the footer) jumps to the Quotes tab. No extra network round-trips. */
function NotificationsBell({
  quotes,
  onOpenQuotes,
}: {
  quotes: Quote[]
  onOpenQuotes: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  const pending = useMemo(
    () =>
      quotes
        .filter((q) => quoteMatchesFilter(q, 'review'))
        .slice()
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )
        .slice(0, 5),
    [quotes],
  )

  // Click-away via a document-level listener instead of a fixed overlay:
  // the sticky nav's backdrop-blur creates a containing block for fixed
  // descendants, which would mis-anchor an inset-0 scrim rendered here.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      // ESC closes and returns focus to the bell trigger (WCAG 2.4.3) so a
      // keyboard user who tabbed into the panel isn't dropped on <body>.
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          pending.length > 0
            ? `Notifications, ${pending.length} quotes to review`
            : 'Notifications'
        }
        aria-expanded={open}
        aria-haspopup="true"
        className="relative inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center rounded-lg border border-ink-line text-text-sec transition-colors cursor-pointer hover:border-text-dim hover:text-text-pri"
      >
        <Bell size={16} strokeWidth={1.75} aria-hidden="true" />
        {pending.length > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-ink-deep"
          />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+10px)] z-40 w-[min(350px,88vw)] overflow-hidden rounded-[14px] border border-ink-line bg-ink-card edge-lit shadow-[0_16px_40px_-12px_rgba(11,9,7,0.55)]">
          <div className="flex items-center justify-between border-b border-ink-line px-4 py-3">
            <span className=" text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-pri">
              Notifications
            </span>
            <span className=" text-[0.56rem] uppercase tracking-[0.08em] text-text-dim">
              {pending.length > 0 ? `${pending.length} to review` : 'All clear'}
            </span>
          </div>
          {pending.length === 0 ? (
            <p className="px-4 py-5 text-sm text-text-sec">
              All caught up. Nothing needs review.
            </p>
          ) : (
            pending.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onOpenQuotes()
                }}
                className="block w-full border-b border-ink-line px-4 py-3 text-left transition-colors cursor-pointer hover:bg-ink-deep/50"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-[0.82rem] font-semibold text-text-pri">
                    {q.customer_full_name || q.customer_first_name || 'Customer'}
                    {' · '}
                    {fmtJobType(q.job_type)}
                  </span>
                  {q.total_inc_gst != null && (
                    <span className="shrink-0 font-mono text-[0.7rem] font-bold tabular-nums text-text-sec">
                      {fmtAUD(toNum(q.total_inc_gst))}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[0.58rem] uppercase tracking-[0.08em] text-text-dim">
                  Quote drafted · {fmtRelative(q.created_at)}
                </span>
              </button>
            ))
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onOpenQuotes()
            }}
            className="block w-full px-4 py-2.5 text-left text-[0.62rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors cursor-pointer hover:bg-ink-deep/50"
          >
            View all quotes →
          </button>
        </div>
      )}
    </div>
  )
}

/** ⌘K command palette — the reference topbar's search, client-side only.
 *  Searches the already-loaded nav sections and quote queue; selecting a
 *  result switches tabs. Rendered through a portal because the sticky
 *  nav's backdrop-blur would otherwise clip the fixed overlay. */
function CommandPalette({
  open,
  onClose,
  navItems,
  setTab,
  quotes,
}: {
  open: boolean
  onClose: () => void
  navItems: NavItem[]
  setTab: (t: Tab) => void
  quotes: Quote[]
}) {
  const [query, setQuery] = useState('')

  // Fresh query each time the palette opens. Kept separate from the ESC
  // listener below so a parent re-render (new onClose identity) can't
  // wipe what the tradie is typing.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Dialog focus contract (WCAG 2.4.3): remember what was focused when the
  // palette opened (the search trigger) and return focus there on close, so
  // keyboard users don't get dumped at the top of the document.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    return () => prev?.focus?.()
  }, [open])

  if (!open || typeof document === 'undefined') return null

  const q = query.trim().toLowerCase()
  const navHits = navItems.filter(
    (i) => !q || i.label.toLowerCase().includes(q),
  )
  const showWizard = !q || 'pricing wizard'.includes(q)
  const quoteHits = quotes
    .filter((qt) => {
      if (!q) return true
      return [
        qt.customer_full_name,
        qt.customer_first_name,
        qt.job_type,
        qt.suburb,
        qt.status,
      ].some((v) => v && String(v).toLowerCase().replace(/_/g, ' ').includes(q))
    })
    .slice(0, 6)
  const empty = navHits.length === 0 && !showWizard && quoteHits.length === 0

  const go = (t: Tab) => {
    setTab(t)
    onClose()
  }

  // ⚠ DELIBERATELY NOT ANIMATED. Every other overlay in this app gets
  // .qm-overlay / .qm-panel; this one does not, and that is the design
  // decision rather than an omission.
  //
  // The palette's primary trigger is ⌘K — a shortcut a heavy user hits
  // dozens of times a day, often to type two characters and hit Enter. An
  // entrance animation on a keyboard action puts a delay between the
  // keystroke and the caret, which reads as the app being slow no matter how
  // short it is. Raycast, the archetype for this control, has no open/close
  // animation for exactly this reason. The click trigger inherits the same
  // treatment because one control cannot have two personalities.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-deep/60 px-4 pt-[11vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search quotes, customers, jobs"
    >
      <div
        className="flex w-[min(620px,92vw)] max-h-[64vh] flex-col overflow-hidden rounded-[14px] border border-ink-line bg-ink-card edge-lit shadow-[0_24px_60px_-12px_rgba(11,9,7,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="flex cursor-text items-center gap-3 border-b border-ink-line px-4 py-3.5 sm:px-5">
          <Search
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 text-text-dim"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search quotes, customers, jobs"
            className="rounded-ctl min-w-0 flex-1 bg-transparent text-base text-text-pri outline-none placeholder:text-text-dim"
            aria-label="Search quotes, customers, jobs"
          />
          <kbd className="shrink-0 rounded-[5px] border border-ink-line px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold text-text-dim">
            ESC
          </kbd>
        </label>
        {/* Result count for screen readers (WCAG 4.1.3) — the visible list
            updates silently as the tradie types; this announces how many
            matches the current query has. */}
        <p className="sr-only" role="status" aria-live="polite">
          {empty
            ? `No matches for ${query}`
            : `${navHits.length + (showWizard ? 1 : 0) + quoteHits.length} results`}
        </p>
        <div className="overflow-y-auto">
          {(navHits.length > 0 || showWizard) && (
            <div>
              <div className="px-4 sm:px-5 pt-3 pb-1.5 text-[0.56rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                Go to
              </div>
              {navHits.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.tab}
                    type="button"
                    onClick={() => go(item.tab)}
                    className="flex w-full items-center gap-3 px-4 sm:px-5 py-2.5 text-left transition-colors cursor-pointer hover:bg-ink-deep/50"
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="shrink-0 text-text-dim"
                    />
                    <span className="flex-1 truncate text-sm font-semibold text-text-pri">
                      {item.label}
                    </span>
                    {typeof item.count === 'number' && item.count > 0 && (
                      <span className="shrink-0 font-mono text-[0.7rem] font-bold tabular-nums text-text-sec">
                        {item.count}
                      </span>
                    )}
                  </button>
                )
              })}
              {showWizard && (
                <Link
                  href="/dashboard/pricing-wizard"
                  onClick={onClose}
                  className="flex w-full items-center gap-3 px-4 sm:px-5 py-2.5 text-left transition-colors hover:bg-ink-deep/50"
                >
                  <Sparkles
                    size={15}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    className="shrink-0 text-accent"
                  />
                  <span className="flex-1 truncate text-sm font-semibold text-accent">
                    Pricing wizard
                  </span>
                </Link>
              )}
            </div>
          )}
          {quoteHits.length > 0 && (
            <div
              className={
                navHits.length > 0 || showWizard
                  ? 'border-t border-ink-line'
                  : ''
              }
            >
              <div className="px-4 sm:px-5 pt-3 pb-1.5 text-[0.56rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                Quotes
              </div>
              {quoteHits.map((qt) => (
                <button
                  key={qt.id}
                  type="button"
                  onClick={() => go('quotes')}
                  className="flex w-full items-center justify-between gap-3 px-4 sm:px-5 py-2.5 text-left transition-colors cursor-pointer hover:bg-ink-deep/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-text-pri">
                      {qt.customer_full_name ||
                        qt.customer_first_name ||
                        'Customer'}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.58rem] uppercase tracking-[0.08em] text-text-dim">
                      {[
                        fmtJobType(qt.job_type),
                        qt.suburb,
                        (qt.status || 'draft').replace(/_/g, ' '),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {qt.total_inc_gst != null && (
                    <span className="shrink-0 font-mono text-[0.7rem] font-bold tabular-nums text-text-sec">
                      {fmtAUD(toNum(qt.total_inc_gst))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {empty && (
            <p className="px-5 py-6 text-sm text-text-sec">
              No matches for “{query}”. Try a customer name, job or page.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
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

/** Nav config for the per-trade hub tabs — label + icon per trade slug.
 *  Order here fixes the sidebar/mobile order of the Trades band. */
const HUB_NAV: { slug: TradeHubSlug; label: string; icon: NavIcon }[] = [
  { slug: 'electrical', label: 'Electrical', icon: Zap },
  { slug: 'plumbing', label: 'Plumbing', icon: Droplets },
  { slug: 'roofing', label: 'Roofing', icon: Home },
  { slug: 'signage', label: 'Signage', icon: Megaphone },
  { slug: 'painting', label: 'Painting', icon: Paintbrush },
  { slug: 'commercial_painting', label: 'Comm. paint', icon: Building2 },
  { slug: 'aircon', label: 'Aircon', icon: AirVent },
  { slug: 'solar', label: 'Solar', icon: Sun },
]

function buildNav(quoteCount: number, trades: ReadonlyArray<string> = []): NavItem[] {
  const items: NavItem[] = [
    { tab: 'overview', label: 'Overview', icon: LayoutDashboard },
    // Combined cross-trade quote list (every trade in one place). The per-trade
    // hubs (below) also show each trade's own quotes; this is the "everything"
    // view kept alongside them.
    { tab: 'quotes', label: 'Quotes', icon: FileText, count: quoteCount },
    { tab: 'chats', label: 'Chats', icon: MessageSquare },
    { tab: 'followups', label: 'Follow-ups', icon: PhoneCall },
    // Calendar — core tab (every tenant). Shows all bookings + self-serve requests.
    { tab: 'calendar', label: 'Calendar', icon: CalendarDays },
  ]
  // Trade hubs — one entry per enabled trade (tenants.trades[]). Each hub
  // consolidates that trade's tools, pricing, tier options, services,
  // brands, catalogue, recipes, estimating, and quotes in one tab. The old
  // per-trade tool tabs (roofing, signage, painting, commercial-painting,
  // aircon, estimator, solar) and the cross-trade pricing-engine tabs
  // (services, catalogue, estimating, recipes) now live INSIDE the hubs;
  // their Tab ids stay renderable for deep links but are no longer
  // emitted here, so they disappear from the sidebar and mobile bar.
  for (const h of HUB_NAV) {
    if (hubEnabled(h.slug, trades as string[])) {
      items.push({ tab: `hub-${h.slug}`, label: h.label, icon: h.icon })
    }
  }
  // Escape hatch for registry/loader trades without a hub (strategy-v9
  // trades like an admin-loaded 'carpentry'): keep the legacy cross-trade
  // pricing-engine tabs in the nav so those trades' services, catalogue,
  // estimating and recipes stay reachable. Tenants whose trades all have
  // hubs never see these — the hubs cover them.
  const hasOrphanTrade = trades.some(
    (t) =>
      typeof t === 'string' &&
      !(TRADE_HUB_SLUGS as readonly string[]).includes(t.toLowerCase()),
  )
  if (hasOrphanTrade) {
    items.push(
      { tab: 'services', label: 'Services', icon: Wrench },
      { tab: 'catalogue', label: 'Catalogue', icon: Package },
      { tab: 'estimating', label: 'Estimating', icon: Calculator },
      { tab: 'recipes', label: 'Recipes', icon: ClipboardList },
    )
  }
  // Marketing — invite codes + QR codes. Core (not a gated feature).
  items.push({ tab: 'invites', label: 'Marketing', icon: Megaphone })
  // Flyer Designer — marketing flyer editor. Core (all tenants).
  items.push({ tab: 'flyer', label: 'Flyer', icon: LayoutTemplate })
  // Trust videos — AI welcome + thank-you videos for the customer quote pages.
  items.push({ tab: 'videos', label: 'Videos', icon: Clapperboard })
  // Files — per-tenant document store (archived quotes/invoices + ask-your-docs).
  items.push({ tab: 'files', label: 'Files', icon: FolderOpen })
  // Historical quotes — import + analyse the tradie's own past pricing.
  items.push({ tab: 'historical-quotes', label: 'History', icon: History })
  items.push(
    { tab: 'account', label: 'Account', icon: User },
    { tab: 'payouts', label: 'Payouts', icon: Banknote },
    { tab: 'billing', label: 'Billing', icon: CreditCard },
    // General pricing — tenant-wide settings only (early-booking discount,
    // quote display, review policy, follow-up, calibration). Per-trade
    // rates/tiers moved into the trade hubs.
    { tab: 'pricing', label: 'General pricing', icon: DollarSign },
  )
  return items
}

// tenantHasRoofingTrade lives in @/lib/roofing/tenant — imported above
// so it stays unit-testable (vitest can't import this file directly
// because it's a React 'use client' module).

// Sidebar nav split into focused, scannable bands: the daily Workspace
// cockpit, one hub per enabled Trade (all of that trade's setup + tools
// + quotes in one tab), Marketing, Records, Account, and the tenant-wide
// General settings. The groups are ORDERED so that flattening them
// reproduces buildNav's emission order exactly — that keeps MobileTabBar
// (which renders the flat buildNav list) telling the same story with
// zero change to it. Hub rows are trade-gated in buildNav, so on a given
// tenant byTab.get() returns undefined for trades they don't have and
// the Sidebar drops the row — and collapses the whole group + its header
// when none resolve (see visibleGroups below). No tenant-specific
// filtering needed in this layout list.
// Sidebar bands mirror the QuoteMax dashboard reference: Daily, Trades,
// Price book, Business. All of a tenant's actual (gated) tabs still appear —
// only the grouping/labels match the reference. `pricing` and the pricing-
// engine tabs (services/catalogue/estimating/recipes, buildNav-gated to
// orphan-trade tenants) share the Price book band; Marketing, Records and
// Account items fold into Business. visibleGroups drops any band with no row.
const SIDEBAR_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: 'Daily', tabs: ['overview', 'quotes', 'chats', 'followups', 'calendar'] },
  { label: 'Trades', tabs: [...HUB_TABS] },
  { label: 'Price book', tabs: ['pricing', 'services', 'catalogue', 'estimating', 'recipes'] },
  {
    label: 'Business',
    tabs: ['invites', 'flyer', 'videos', 'files', 'historical-quotes', 'account', 'payouts', 'billing'],
  },
]

function Sidebar({
  tab,
  setTab,
  quoteCount,
  isAdmin,
  trades = [],
  collapsed = false,
  onToggleCollapse,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  quoteCount: number
  isAdmin: boolean
  trades?: ReadonlyArray<string>
  /** Icon-only rail (reference design). The state lives in DashboardPage
   *  so the sidebar/content grid can animate its columns in step. */
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  const items = buildNav(quoteCount, trades)
  const byTab = new Map(items.map((i) => [i.tab, i]))
  // Resolve each group's rows up front and drop groups that have no
  // visible row on this tenant (e.g. a fully trade-gated "Estimator
  // tools" group on a tenant with no trade tools). Filtering here means
  // a collapsed group emits neither its header nor a divider, so the
  // rail stays tight — no orphan eyebrow, no dangling hairline. Dividers
  // are then keyed off the VISIBLE index, not the static array index.
  const visibleGroups = SIDEBAR_GROUPS.map((g) => ({
    label: g.label,
    rows: g.tabs.map((t) => byTab.get(t)).filter(Boolean) as NavItem[],
  })).filter((g) => g.rows.length > 0)
  return (
    <aside className="hidden lg:block self-stretch border-r border-ink-line bg-ink-deep">
      <nav
        // Flush-left full-height rail (its right border is the divider). The
        // inner nav sticks just below the 60px topbar and scrolls internally
        // so a fully-loaded multi-trade rail never overflows the viewport.
        // Scrollbar hidden in Firefox + Chromium.
        className="sticky top-[61px] max-h-[calc(100vh-61px)] overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Dashboard sections"
      >
        {/* Workspace title + collapse toggle — mirrors the reference sidebar
            header (mono label left, panel button right). The rail folds to
            icon-only; the button warms its border + glyph to accent on hover. */}
        {onToggleCollapse && (
          <div
            className={`flex items-center gap-2 px-3 pt-3 pb-1 ${
              collapsed ? 'justify-center' : 'justify-between'
            }`}
          >
            {!collapsed && (
              <span className=" text-[10px] font-bold uppercase tracking-[0.08em] text-text-dim">
                Workspace
              </span>
            )}
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="grid h-8 w-8 place-items-center rounded-lg border border-ink-line text-text-sec transition-colors cursor-pointer hover:border-accent/50 hover:bg-ink-card hover:text-accent"
            >
              {collapsed ? (
                <PanelLeftOpen size={15} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={15} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
          </div>
        )}
        {visibleGroups.map((group, vi) => (
          <div key={group.label} className={vi > 0 ? 'mt-4' : 'mt-1'}>
            {/* Hairline between bands (rail direction 2d). The groups were
                separated by margin alone, so "Daily", "Trades" and "Price
                book" read as one long list and scanning the rail cost real
                effort. A 1px rule is the cheapest way to say "new band"
                without adding weight. Not before the first group, and not
                when collapsed to icons — there are no headings to divide. */}
            {vi > 0 && !collapsed && (
              <div aria-hidden="true" className="mx-3 mb-3 h-px bg-ink-line" />
            )}
            {!collapsed && (
              <div className="px-3 pb-1.5 pt-1">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-dim/80">
                  {group.label}
                </span>
              </div>
            )}
            <ul className={`flex flex-col gap-0.5 px-2 ${collapsed ? 'py-1' : 'pb-1'}`}>
              {group.rows.map((item) => {
                const active = item.tab === tab
                const Icon = item.icon
                return (
                  <li key={item.tab}>
                    <button
                      type="button"
                      onClick={() => setTab(item.tab)}
                      title={item.label}
                      aria-label={collapsed ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      style={
                        active
                          ? {
                              borderColor:
                                'color-mix(in srgb, var(--accent) 32%, var(--ink-line))',
                            }
                          : undefined
                      }
                      className={`relative w-full text-left flex items-center rounded-lg border text-sm transition-colors cursor-pointer ${
                        collapsed
                          ? 'justify-center px-0 py-2.5'
                          : 'justify-between gap-3 px-[11px] py-[9px]'
                      } ${
                        active
                          ? 'bg-ink-card font-bold text-text-pri'
                          : 'border-transparent font-medium text-text-sec hover:bg-ink-card/60 hover:text-text-pri'
                      }`}
                    >
                      {/* Left accent tick — the reference's active marker.
                          Always painted, revealed by scaleY from its centre
                          rather than swapped from transparent, so moving
                          between tabs reads as one marker growing into place
                          instead of two ticks blinking. transform-only. */}
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-[7px] bottom-[7px] w-[2px] origin-center bg-accent motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]"
                        style={{ transform: active ? 'scaleY(1)' : 'scaleY(0)' }}
                      />
                      <span
                        className={
                          collapsed
                            ? 'flex items-center'
                            : 'flex items-center gap-2.5 min-w-0'
                        }
                      >
                        <Icon
                          size={17}
                          strokeWidth={1.75}
                          aria-hidden="true"
                          className={`shrink-0 ${active ? 'text-accent' : 'text-text-dim'}`}
                        />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </span>
                      {/* Count chip — solid accent fill with dark ink, the
                          reference badge treatment (never white-on-yellow). */}
                      {!collapsed &&
                        typeof item.count === 'number' &&
                        item.count > 0 && (
                          <span className="rounded-[5px] bg-accent px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-accent-ink shrink-0">
                            {item.count}
                          </span>
                        )}
                    </button>
                  </li>
                )
              })}
              {/* Pricing Wizard — guided pricing setup, moved out of the
                  global top nav into this Pricing-engine band so it sits
                  with the other pricing tools instead of floating in the
                  nav. Route link (navigates away), not an in-page tab, so
                  it renders as an accent CTA rather than a setTab button. */}
              {group.rows.some((r) => r.tab === 'pricing') && (
                <li>
                  <Link
                    href="/dashboard/pricing-wizard"
                    title="Pricing wizard"
                    aria-label={collapsed ? 'Pricing wizard' : undefined}
                    className={`relative w-full text-left flex items-center rounded-lg border border-transparent text-sm font-medium text-accent transition-colors hover:bg-ink-card/60 ${
                      collapsed
                        ? 'justify-center px-0 py-2.5'
                        : 'gap-2.5 px-[11px] py-[9px]'
                    }`}
                  >
                    <Sparkles
                      size={17}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="shrink-0 text-accent"
                    />
                    {!collapsed && <span className="truncate">Pricing wizard</span>}
                  </Link>
                </li>
              )}
            </ul>
          </div>
        ))}
        {/* Admin-only nav island. Hidden for non-admin users.
            Points at /admin (the command-centre hub) rather than the
            specific /admin/loader page — from /admin the user can
            navigate to every admin destination (Bulk Loader, the three
            Quality Agents, etc.) via the tile grid. Single nav entry
            instead of one anchor per admin page. */}
        {isAdmin && (
          <div className="mt-3">
            {!collapsed && (
              <div className="px-3 pb-1.5 pt-1">
                <span className=" text-[9.5px] font-bold uppercase tracking-[0.08em] text-accent">
                  Admin
                </span>
              </div>
            )}
            <ul className={`flex flex-col gap-0.5 px-2 ${collapsed ? 'py-1' : 'pb-1'}`}>
              <li>
                <a
                  href="/admin"
                  title="Admin command centre"
                  aria-label={collapsed ? 'Admin command centre' : undefined}
                  className={`relative w-full text-left flex items-center rounded-lg border border-transparent text-sm font-medium text-text-sec transition-colors hover:bg-ink-card/60 hover:text-text-pri ${
                    collapsed
                      ? 'justify-center px-0 py-2.5'
                      : 'justify-between gap-3 px-[11px] py-[9px]'
                  }`}
                >
                  <span
                    className={
                      collapsed
                        ? 'flex items-center'
                        : 'flex items-center gap-2.5 min-w-0'
                    }
                  >
                    <Shield
                      size={17}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="shrink-0 text-text-dim"
                    />
                    {!collapsed && (
                      <span className="truncate">Admin command centre</span>
                    )}
                  </span>
                </a>
              </li>
            </ul>
          </div>
        )}
      </nav>
    </aside>
  )
}

function MobileTabBar({
  tab,
  setTab,
  quoteCount,
  trades = [],
}: {
  tab: Tab
  setTab: (t: Tab) => void
  quoteCount: number
  trades?: ReadonlyArray<string>
}) {
  const items = buildNav(quoteCount, trades)
  return (
    <nav
      // Horizontal-scroll bar keeps all six tabs on one line on
      // mobile (vs. wrapping to two cluttered rows). Scrollbar is
      // hidden in both Firefox and Chromium via arbitrary utilities;
      // the active tab is still tabbable + scrollable into view.
      // The strip scrolls, but with the scrollbar hidden there was nothing to
      // say so: at 375px it simply ended mid-word on "Fo…" (Follow-ups) and
      // read as clipped rather than scrollable. A right-edge mask fades the
      // last ~30px, which is the standard cue that content continues. It is a
      // paint-only effect, so it costs no layout and cannot itself overflow.
      // Sticky under the 60px topbar so switching tabs never needs a scroll up.
      className="lg:hidden sticky top-[60px] z-20 -mx-4 sm:mx-0 flex overflow-x-auto whitespace-nowrap border-b border-ink-line bg-ink-deep/95 backdrop-blur-md [mask-image:linear-gradient(to_right,#000_calc(100%-30px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            className={`relative shrink-0 inline-flex items-center gap-2 px-4 py-3 text-[0.7rem] uppercase tracking-[0.08em] font-bold cursor-pointer ${
 i === 0 ? 'pl-4 sm:pl-0' : ''
 } ${active ? 'text-accent' : 'text-text-dim hover:text-text-pri'}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{item.label}</span>
            {typeof item.count === 'number' && item.count > 0 && (
              <span className="ml-1 text-text-sec">({item.count})</span>
            )}
            {/* Active rule. Always painted and revealed by scaleX rather than
                toggled via `border-b-2`, so switching tabs draws one bar out
                from the centre instead of blinking two. transform-only, so it
                costs no layout — and it also removes the 1px vertical jiggle
                the old `border-b-2 … -mb-px` gave the whole strip on every
                switch. Sits at bottom-0, INSIDE the button: the parent nav is
                `overflow-x-auto`, which computes overflow-y to auto as well,
                so a bar hung at -1px would be clipped or spawn a scrollbar. */}
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-[2px] origin-center bg-accent motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{ transform: active ? 'scaleX(1)' : 'scaleX(0)' }}
            />
          </button>
        )
      })}
      {/* Pricing Wizard — moved here from the top nav. Sits at the end of
          the mobile strip, right after the pricing-engine tabs. Route
          link (navigates to the wizard page), not a setTab tab. */}
      <Link
        href="/dashboard/pricing-wizard"
        className="shrink-0 inline-flex items-center gap-2 px-4 py-3 text-[0.7rem] uppercase tracking-[0.08em] font-bold text-accent transition-colors hover:text-accent-press"
      >
        <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Pricing wizard</span>
      </Link>
    </nav>
  )
}

// ─── Tab page header ──────────────────────────────────────────────
//
// Every non-overview tab opens with this header so the dashboard reads
// as a designed product, not a stack of cards. One title + one-line
// description per tab; rendered centrally from DashboardPage so all
// nine tabs stay consistent. Overview keeps its own greeting header.

// Hub tabs render their own header (trade label + section nav) inside
// TradeHub, so they're excluded here alongside overview.
const TAB_META: Record<
  Exclude<Tab, 'overview' | HubTab>,
  { title: string; desc: string }
> = {
  aircon: {
    title: 'AC recommender',
    desc: 'Indicative ducted-vs-split air-conditioning sizing and price ranges from a few questions.',
  },
  billing: {
    title: 'Billing & plan',
    desc: 'Your QuoteMax subscription — start a plan, switch tiers, or manage your card. Starter Monthly includes a 14-day free trial; we never take a cut of your jobs.',
  },
  estimator: {
    title: 'Estimator (Beta)',
    desc: 'Upload an electrical plan PDF and get an AI quantity take-off you can correct and save. Counts only — verify before quoting.',
  },
  solar: {
    title: 'Solar',
    desc: 'Share your solar link, review the AI-drafted tiered estimates, and confirm & release each one to the customer.',
  },
  invites: {
    title: 'Marketing',
    desc: 'Invite codes gate who can onboard. QR codes turn printed flyers into AI-drafted quotes.',
  },
  flyer: {
    title: 'Flyer Designer',
    desc: 'Design a printable marketing flyer from a template — edit text, fonts, colours and images, drop in your QR code, then download a PNG or PDF.',
  },
  videos: {
    title: 'Videos',
    desc: 'AI-generated welcome and thank-you videos, personalised with your name, business and logo, shown to customers on your quote pages.',
  },
  files: {
    title: 'Files',
    desc: 'Your archived quotes and uploaded invoices — download any document, or ask a question grounded in your own pricing history.',
  },
  'historical-quotes': {
    title: 'Historical quotes',
    desc: 'Import your past quotes (CSV or PDF), see what you’ve charged before, and calibrate your pricing book to your own history.',
  },
  quotes: {
    title: 'Quotes',
    desc: 'Every quote your AI receptionist has drafted — review the numbers, send, and track what converts.',
  },
  followups: {
    title: 'Follow-ups',
    desc: 'Chase the quotes that haven’t landed yet. Log every call and text so nothing slips.',
  },
  chats: {
    title: 'Chats',
    desc: 'Customer conversations across SMS and voice — including the leads that never became a quote.',
  },
  calendar: {
    title: 'Calendar',
    desc: 'Every booking in one place — self-serve requests, reserved holds, and confirmed jobs. Confirm new requests as they come in.',
  },
  account: {
    title: 'Account',
    desc: 'Your business identity, trades, and licences — exactly as customers and the regulator see them.',
  },
  payouts: {
    title: 'Payouts',
    desc: 'Set up the secure account QuoteMax pays your completed-job money into.',
  },
  pricing: {
    title: 'General pricing',
    desc: 'Settings shared across all your trades — early-booking discount, quote layout, review policy, follow-ups, and invoice calibration. Per-trade rates live in each trade’s tab.',
  },
  services: {
    title: 'Services',
    desc: 'Decide which jobs your AI auto-quotes — and which always book a paid site visit instead.',
  },
  catalogue: {
    title: 'Catalogue',
    desc: 'The supplier materials and prices your estimator draws on when it builds a quote.',
  },
  estimating: {
    title: 'Estimating',
    desc: 'Run a job through the AI and see how it prices — before a real customer ever does.',
  },
  recipes: {
    title: 'Recipes',
    desc: 'Reusable job templates that bundle the materials and labour for a common job.',
  },
  roofing: {
    title: 'Roof tools',
    desc: 'Measure any address, apply your $/m² rate, get a three-tier price band ready to send.',
  },
  signage: {
    title: 'Signage compliance',
    desc: 'Request photos from your studios, AI-triage them against the F45 standards, and review the flagged ones.',
  },
  painting: {
    title: 'Paint tools',
    desc: 'Estimate paintable area from an address, get a Good / Better / Best range with a confidence band.',
  },
  'commercial-painting': {
    title: 'Commercial painting',
    desc: 'Upload a plan set, confirm the AI surface takeoff, and get a tender-ready price with labour, materials and access equipment.',
  },
}

function TabHeader({ tab }: { tab: Exclude<Tab, 'overview' | HubTab> }) {
  const meta = TAB_META[tab]
  return (
    /* One header, ~20 tabs — so this is the highest-leverage single edit in
       the pass. Three changes, all from direction 1b:
       · The "QuoteMax · Dashboard" breadcrumb is gone. It was identical on
         every tab, so it carried no information; the sidebar already marks
         where you are.
       · ALL-CAPS at clamp(1.5rem…2rem) is dropped to sentence case at
         clamp(1.25rem…1.6rem). Uppercase costs ~15% width and removes the
         ascender/descender shapes people read by — on "Historical quotes"
         at 32px that is a headline shouting a filing category.
       · mb-6 → mb-5 with tighter internal rhythm, so the header stops
         pushing the tab's actual content below the fold on a laptop. */
    <header className="mb-5">
      <h1 className="font-extrabold tracking-tight text-text-pri text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15]">
        {meta.title}
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-text-sec">
        {meta.desc}
      </p>
    </header>
  )
}

/** A labelled dropdown for the queue toolbars (status, trade, sort).
 *
 *  This used to hand-build its own chevron (appearance-none + an absolutely
 *  positioned lucide ChevronDown) because the OS-drawn arrow ignores the
 *  design tokens and renders differently per platform. That was right, and
 *  it is now done for EVERY select in the cockpit by one rule in globals.css
 *  (`.qm-dash select:not([multiple]):not([size])`) — so the icon here was
 *  deleted rather than duplicated; two chevrons would otherwise stack.
 *
 *  What is left is the pairing of a label with a control, which is the only
 *  part a component was ever needed for. `pr-9` stays as a belt-and-braces
 *  match for the CSS rule's `padding-right`.
 *
 *  `fill` sizes it to exactly half the row on a phone — `calc(50% - 0.25rem)`
 *  is half the width minus half the `gap-2` between the pair — so two selects
 *  sit side by side and a third wraps beneath at the same width instead of
 *  stretching across the whole screen. It deliberately does NOT `grow`: a lone
 *  select that fills the viewport reads as a text field, not a filter. */
function FilterSelect({
  label,
  value,
  onChange,
  fill = false,
  className = '',
  children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  fill?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <label
      className={`flex min-w-0 items-center gap-2 sm:basis-auto ${fill ? 'basis-[calc(50%-0.25rem)]' : ''} ${className}`}
    >
      <span className="shrink-0 text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
        {label}
      </span>
      <span className="relative min-w-0 flex-1 sm:flex-none">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-ctl h-9 w-full min-w-0 cursor-pointer appearance-none border border-ink-line bg-ink-card py-2 pl-3 pr-9 text-[13px] font-semibold text-text-pri transition-colors hover:border-text-dim focus:border-accent focus:outline-none sm:w-auto"
        >
          {children}
        </select>
      </span>
    </label>
  )
}

// ─── Overview tab ─────────────────────────────────────────────────

/** Status pill vocabulary for the Overview "Recent quotes" table — mirrors
 *  the reference's dot + hairline-border chip. Colours are raw tokens so the
 *  pill reads identically on both themes; the review state pulses. */
function overviewQuotePill(q: Quote): {
  label: string
  tone: Tone
  pulse: boolean
} {
  if (q.deposit_paid || (q.status ?? '').toLowerCase() === 'accepted')
    return { label: 'Accepted', tone: 'success', pulse: false }
  const s = (q.status ?? 'draft').toLowerCase()
  if (s === 'sent') return { label: 'Sent', tone: 'dim', pulse: false }
  if (q.needs_inspection || q.inspection_required)
    return { label: 'Site visit', tone: 'dim', pulse: false }
  return { label: 'Awaiting you', tone: 'warn', pulse: true }
}

// The Overview page is split into two top-level views: the money-first
// Overview (KPI strip + recent quotes + rail) and the Your-activity analytics.
type OverviewSection = 'overview' | 'activity'

const OVERVIEW_SECTIONS: { id: OverviewSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Your activity' },
]

/** Page-level segmented switch between the Overview and Your-activity views.
 *  A rounded, lit-edge plate in the dashboard's card language; the active
 *  segment takes the brand yellow fill (charcoal ink on top — theme-safe in
 *  both the dark and cream themes, since .bg-accent forces --accent-ink).
 *  WAI-ARIA tabs pattern: roving tabindex + arrow-key nav, panels wired via
 *  aria-controls / aria-labelledby. */
function SectionTabs({
  active,
  onChange,
}: {
  active: OverviewSection
  onChange: (s: OverviewSection) => void
}) {
  const idx = OVERVIEW_SECTIONS.findIndex((s) => s.id === active)

  // Sliding accent pill — glides between tabs instead of the fill snapping
  // from one to the next. Measured off each tab's own box so it tracks the
  // real (unequal) label widths, and re-measures on resize. The pill is
  // absolutely positioned, so its left:0 sits at the list's PADDING-box left;
  // we express the target as the offset from that same origin. Both boxes are
  // read via getBoundingClientRect (border-box coords) + clientLeft so the
  // alignment is exact across engines, where offsetLeft's border handling
  // differs. The pill is the only moving part; buttons just swap text colour
  // above it. Set once measured (never animates in from the origin).
  const listRef = useRef<HTMLDivElement | null>(null)
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current
      const btn = btnRefs.current[idx]
      if (!list || !btn) return
      const originLeft = list.getBoundingClientRect().left + list.clientLeft
      const r = btn.getBoundingClientRect()
      setPill({ left: r.left - originLeft, width: r.width })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [idx])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = (idx + dir + OVERVIEW_SECTIONS.length) % OVERVIEW_SECTIONS.length
    onChange(OVERVIEW_SECTIONS[next].id)
    document.getElementById(`section-tab-${OVERVIEW_SECTIONS[next].id}`)?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Dashboard section"
      onKeyDown={onKeyDown}
      className="relative inline-flex gap-1 rounded-ctl edge-lit border border-ink-line bg-ink-card p-1 motion-safe:animate-[fade-up_380ms_cubic-bezier(0.22,1,0.36,1)_both]"
    >
      {/* The one moving part: a single accent pill that glides under the active
          tab. transform + width only, so it stays GPU-composited. Reduced-
          motion drops the transition classes and it snaps instantly.
          260ms, not the 420ms this shipped with: this is a segmented control
          the tradie flicks between many times a session, and past ~300ms a
          control that size stops reading as responsive and starts reading as
          a wait. The label colours cross-fade on the same 260ms so the pill
          and the text land together. */}
      {pill && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 top-1 left-0 rounded-[6px] bg-accent will-change-transform motion-safe:transition-[transform,width] motion-safe:duration-[260ms] motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      )}
      {OVERVIEW_SECTIONS.map((s, i) => {
        const on = s.id === active
        return (
          <button
            key={s.id}
            ref={(el) => {
              btnRefs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`section-tab-${s.id}`}
            aria-selected={on}
            aria-controls={`section-panel-${s.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            className={[
              // z-10 keeps the label above the pill; the active label reads as
              // dark-on-yellow, the rest as dim text over the bare plate.
              'relative z-10 rounded-[6px] px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              on ? 'text-accent-ink' : 'text-text-dim hover:text-text-sec',
            ].join(' ')}
          >
            {s.label}
          </button>
        )
      })}
    </div>
  )
}

function OverviewTab({
  data,
  accessToken,
  setTab,
  refreshSignal = 0,
  onFollowUpColdChats,
}: {
  data: DashboardData
  accessToken: string | null
  setTab: (t: Tab) => void
  /** Bumped by the parent's throttled refresh-on-return so the lazy trade-
   *  jobs + chats fetches below re-pull alongside /api/tenant/me. */
  refreshSignal?: number
  // Opens the Chats tab filtered to cold (abandoned) conversations — wired to
  // the Activity view's "chats went cold" CTA.
  onFollowUpColdChats: () => void
}) {
  const router = useRouter()
  // Open a specific quote's in-dashboard workspace (/dashboard/quote/[token]) —
  // the review / PDF-edit page each Quotes-tab card links to. Falls back to the
  // Quotes list only if the quote somehow has no share token to route by.
  const openQuote = useCallback(
    (q: Quote) => {
      if (q.share_token) router.push(`/dashboard/quote/${q.share_token}`)
      else setTab('quotes')
    },
    [router, setTab],
  )
  // Reporting-period filter for the performance KPIs + recent-quotes list.
  // Resolved on the browser clock so "this week/month" tracks the tradie's
  // local calendar (OverviewAnalytics sends the same bounds to the server).
  const [period, setPeriod] = useState<Period>('all')
  const periodWindow = periodRange(period, new Date())
  // Root-only (R12): a chained job's 'final' and 'balance' rows are further
  // payments on a job already counted here, not new jobs. Leaving them in
  // would treble scopedCount, quotedValue and the conversion denominator.
  const scopedQuotes = (
    periodWindow
      ? data.quotes.filter((q) => inPeriod(q.created_at, periodWindow))
      : data.quotes
  ).filter(isChainRoot)
  const scopedCount = scopedQuotes.length

  const enabledServices = data.services.filter((s) => s.enabled).length
  const totalServices = data.services.length
  // "View all" navigates to the full Quotes tab, so it keeps the all-time total.
  const activeQuotes = data.quotes.length
  // In review is the LIVE backlog — deliberately NOT period-scoped, so an older
  // quote still awaiting send is never hidden by picking a narrow window.
  const draftQuotes = data.quotes.filter((q) =>
    ['drafted', 'awaiting_review', 'review'].includes(q.status),
  ).length

  // Pipeline numbers — the money/conversion view the tradie actually cares
  // about, scoped to the selected period. A quote counts as "accepted" if its
  // status is 'accepted' OR a deposit has landed (deposit_paid overrides status
  // in the QuoteCard badge ordering, same logic applied here).
  // R12 attribution — the acceptance a chained job earns belongs to its ROOT,
  // which is the row the pipeline counts. A paid 'final' child (paid_tier
  // 'deposit', or 'credit' when the $99 covered it) accepts the parent.
  // Scanned over ALL quotes, not the period-scoped roots: the child is created
  // after the parent and can easily fall outside the parent's window.
  const depositPaidRootIds = new Set(
    data.quotes
      .filter(
        (q) =>
          q.quote_kind === 'final' &&
          (q.paid_tier === 'deposit' || q.paid_tier === 'credit'),
      )
      .map((q) => q.parent_quote_id)
      .filter((id): id is string => !!id),
  )
  const acceptedQuotes = scopedQuotes.filter(
    (q) =>
      q.deposit_paid ||
      (q.status ?? '').toLowerCase() === 'accepted' ||
      depositPaidRootIds.has(q.id),
  )
  const quotedValue = scopedQuotes.reduce(
    (sum, q) => sum + (toNum(q.total_inc_gst) ?? 0),
    0,
  )
  const acceptedValue = acceptedQuotes.reduce(
    (sum, q) => sum + (toNum(q.total_inc_gst) ?? 0),
    0,
  )
  const conversionPct =
    scopedCount > 0
      ? Math.round((acceptedQuotes.length / scopedCount) * 100)
      : 0
  const avgQuoteValue = scopedCount > 0 ? quotedValue / scopedCount : 0

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

  // Measure-tool trade jobs (roofing / solar / painting / commercial
  // painting) live OUTSIDE the quotes table — fetched lazily like the chats
  // below and merged into the Recent-quotes feed + attention rail so work
  // done in the trade tabs shows up on Overview (spec
  // dashboard-overview-quotes-sync T2/T3). A failed fetch is surfaced as an
  // explicit error strip with a retry, never silently hidden (T5).
  const [tradeJobs, setTradeJobs] = useState<TradeJobSummary[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState(false)
  const [jobsReload, setJobsReload] = useState(0)
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    setJobsLoading(true)
    setJobsError(false)
    void (async () => {
      const token = (await getAuthToken()) ?? accessToken
      try {
        const r = await fetch('/api/tenant/trade-jobs', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { jobs?: TradeJobSummary[] }
        if (cancelled) return
        setTradeJobs(Array.isArray(j.jobs) ? j.jobs : [])
      } catch {
        if (!cancelled) setJobsError(true)
      } finally {
        if (!cancelled) setJobsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken, jobsReload, refreshSignal])

  // Recent activity preview — pipeline quotes + measure-tool jobs merged
  // newest-first, top 5, scoped to the selected reporting period.
  const scopedJobs = periodWindow
    ? tradeJobs.filter((j) => inPeriod(j.createdAt, periodWindow))
    : tradeJobs
  const recentFeed = mergeRecentActivity(scopedQuotes, scopedJobs)

  // Recent chats — fetched lazily on Overview mount so the Chats tab can
  // keep doing its own larger fetch independently. 5-row preview only;
  // clicking a row jumps to the Chats tab where the full list lives.
  const [latestChats, setLatestChats] = useState<ChatRow[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsError, setChatsError] = useState(false)
  const [chatsReload, setChatsReload] = useState(0)

  // Which of the two top-level views is showing: Overview | Your activity.
  const [section, setSection] = useState<OverviewSection>('overview')
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    setChatsLoading(true)
    setChatsError(false)
    void (async () => {
      // Mint a FRESH token immediately before the fetch — the `accessToken`
      // prop was captured once at parent mount and a Clerk session token
      // expires ~60s later, so reusing it here 401s on remount/dwell.
      const token = (await getAuthToken()) ?? accessToken
      try {
        const r = await fetch('/api/tenant/chats', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        // A non-OK response (expired token, transient 5xx) is an ERROR state
        // with a retry — presenting it as "No conversations yet" hid real
        // failures from tradies who DO have conversations.
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json().catch(() => ({ chats: [] }))
        if (cancelled) return
        const rows = (j?.chats ?? []) as ChatRow[]
        setLatestChats(rows.slice(0, 5))
      } catch {
        if (!cancelled) setChatsError(true)
      } finally {
        if (!cancelled) setChatsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken, chatsReload, refreshSignal])

  // KPI tone for the AI receptionist tile — green when fully live,
  // amber for stub/missing, so the tradie's eye lands on the right
  // thing when something needs attention.
  const aiTone: 'ok' | 'warn' = !assistantId || isStubVapi ? 'warn' : 'ok'
  const aiValue = !assistantId
    ? 'Not yet'
    : isStubVapi
      ? 'Stub'
      : 'Live'

  // 6-cell KPI strip — matches the QuoteMax dashboard reference exactly.
  // Colour: accent for money/coverage, warning for the review backlog, dim
  // for the still-zero conversion figures. Raw var(--accent) keeps the hero
  // numbers yellow in BOTH themes (the .text-accent token flips to charcoal
  // on the cream light theme, which the reference deliberately does not).
  const metrics: { k: string; v: string; sub: string; color: string }[] = [
    {
      k: 'Quoted',
      v: `$${formatMoney(Math.round(quotedValue))}`,
      sub: `${scopedCount} draft${scopedCount === 1 ? '' : 's'}`,
      color: 'var(--accent)',
    },
    {
      k: 'Converted',
      v: `$${formatMoney(Math.round(acceptedValue))}`,
      sub: acceptedQuotes.length > 0 ? `${acceptedQuotes.length} won` : 'None yet',
      color: 'var(--text-dim)',
    },
    {
      k: 'Conversion',
      v: `${conversionPct}%`,
      sub: `${acceptedQuotes.length} of ${scopedCount}`,
      color: 'var(--text-dim)',
    },
    {
      k: 'Avg quote',
      v: `$${formatMoney(Math.round(avgQuoteValue))}`,
      sub: 'Per draft',
      color: 'var(--accent)',
    },
    {
      k: 'In review',
      v: `${draftQuotes}`,
      sub: 'Awaiting send',
      color: 'var(--warning-bright)',
    },
    {
      k: 'Services',
      v: `${enabledServices}/${totalServices}`,
      sub: 'Auto-quote',
      color: 'var(--accent)',
    },
  ]

  // The single most-urgent item for the "Needs your attention" rail card:
  // first still-in-review quote (data.quotes is newest-first), falling back
  // to the newest draft measure-tool job (spec dashboard-overview-quotes-sync
  // T3) so trade-tab work also surfaces here.
  const attention = attentionCandidate(data.quotes, tradeJobs)
  const attnQuote = attention?.kind === 'quote' ? attention.quote : null
  const attnJob = attention?.kind === 'job' ? attention.job : null
  const attnJobView = attnJob ? jobRowView(attnJob) : null

  // Channel-readiness chips for the number card — colour carries the same
  // live/stub/pending signal the old status pill did.
  const channelChips: { label: string; live: boolean }[] = [
    { label: 'SMS', live: !!smsNumber && !isStubTwilio },
    {
      label: 'Voice',
      live: !!(tenant.twilio_voice_number || assistantId) && !isStubVapi,
    },
    { label: 'AI', live: !!assistantId && !isStubVapi },
  ]

  return (
    <div className="space-y-5 motion-safe:animate-[fade-in_180ms_ease-out_both]">
      {/* PAGE HEADER — greeting + the one-line state of the queue, plus the
          reference's period label and New quote action. */}
      <OverviewHeader
        firstName={tenant.owner_first_name ?? 'Tradie'}
        subtitle={
          draftQuotes === 0
            ? "You're all caught up. No quotes waiting on you."
            : draftQuotes === 1
              ? 'One quote needs your review. The rest are drafted and waiting.'
              : `${draftQuotes} quotes need your review. The rest are drafted and waiting.`
        }
        onNewQuote={() => setTab('quotes')}
        period={period}
        onPeriod={setPeriod}
      />

      {/* TOP-LEVEL VIEW SWITCH — Overview | Your activity. */}
      <SectionTabs active={section} onChange={setSection} />

      {section === 'overview' ? (
        <div
          role="tabpanel"
          id="section-panel-overview"
          aria-labelledby="section-tab-overview"
          className="space-y-5"
        >
      {/* KPI HERO + SECONDARY ROW  (Claude Design direction 1b)
          ────────────────────────────────────────────────────────────────
          Was six equal cells in a seamed strip. Six numbers at one weight
          is six numbers with no answer: nothing told the tradie how the
          business is actually going. 1b promotes ONE figure — money quoted
          — and folds the two that qualify it (converted, conversion rate)
          into its own sub-line, because they are facts ABOUT that number
          rather than peers of it. The remaining three drop to a quiet
          three-up: still present, no longer competing.

          metrics[0..2] are Quoted / Converted / Conversion; [3..5] are Avg
          quote / In review / Services. Guarded with optional chaining so a
          future edit to the array cannot blank the hero. */}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div
          className="qm-rise rounded-card edge-lit border border-ink-line bg-ink-card px-5 py-5 sm:px-7 sm:py-6"
          style={{ '--i': 0 } as CSSProperties}
        >
          <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-dim">
            {metrics[0]?.k} · {periodLabel(period)}
          </div>
          <div className="qm-hero-num mt-2.5 text-text-pri">{metrics[0]?.v}</div>
          <div className="mt-3.5 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[13px] text-text-sec">
            <span>
              <span className="font-mono font-bold tabular-nums text-text-pri">
                {metrics[0]?.sub.split(' ')[0]}
              </span>{' '}
              {metrics[0]?.sub.split(' ').slice(1).join(' ')}
            </span>
            <span>
              <span className="font-mono font-bold tabular-nums text-success-bright">
                {metrics[1]?.v}
              </span>{' '}
              converted
            </span>
            <span>
              <span className="font-mono font-bold tabular-nums text-text-pri">
                {metrics[2]?.v}
              </span>{' '}
              rate
            </span>
          </div>
        </div>

        {/* The three supporting figures. Seamed like the old strip so the
            cluster still reads as one instrument, just at a lower rank. */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-card edge-lit border border-ink-line bg-ink-line">
          {metrics.slice(3).map((m, i) => (
            <div
              key={m.k}
              className="qm-rise flex flex-col justify-center bg-ink-card px-3 py-4 sm:px-5"
              style={{ '--i': i + 1 } as CSSProperties}
            >
              <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
                {m.k}
              </div>
              <div
                className="mt-1.5 font-mono text-[clamp(1.05rem,1.35vw,1.5rem)] font-extrabold leading-none tabular-nums"
                style={{ color: m.color }}
              >
                {m.v}
              </div>
              <div className="mt-1.5 text-[0.6875rem] font-medium text-text-sec">
                {m.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* TWO-COLUMN GRID — recent quotes table (left) + the attention /
          number / chats rail (right), exactly as the reference lays it out. */}
      <div
        className="grid items-start gap-5 motion-safe:animate-[fade-up_380ms_cubic-bezier(0.22,1,0.36,1)_both] lg:grid-cols-[minmax(0,1.75fr)_minmax(300px,430px)]"
        style={{ animationDelay: '120ms' }}
      >
        {/* Recent quotes — numbered header + 5-column table */}
        <section className="min-w-0 rounded-card edge-lit overflow-hidden bg-ink-card border border-ink-line">
          <header className="flex items-center justify-between border-b border-ink-line px-5 py-3.5">
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[13px] font-bold text-accent">01</span>
              <h2 className=" text-xs font-bold uppercase tracking-[0.08em] text-text-pri">
                Recent quotes
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setTab('quotes')}
              className=" text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors cursor-pointer hover:text-accent-press"
            >
              View all {activeQuotes} →
            </button>
          </header>
          {jobsError && (
            <div className="flex items-center justify-between gap-3 border-b border-ink-line px-5 py-2.5">
              <span className=" text-[0.6875rem] uppercase tracking-[0.08em] text-warning-bright">
                Couldn&rsquo;t load saved trade jobs.
              </span>
              <button
                type="button"
                onClick={() => setJobsReload((n) => n + 1)}
                className=" text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors cursor-pointer hover:text-accent-press"
              >
                Retry
              </button>
            </div>
          )}
          {recentFeed.length === 0 ? (
            <div className="px-5 py-8 text-xs uppercase tracking-[0.08em] text-text-dim">
              {jobsLoading
                ? 'Loading…'
                : period === 'all'
                  ? 'No quotes drafted yet. Customer SMS or calls will land here.'
                  : `No quotes in ${periodLabel(period).toLowerCase()}.`}
            </div>
          ) : (
            <div>
              <div className="hidden grid-cols-[minmax(94px,1.4fr)_minmax(108px,1.7fr)_46px_76px_116px] gap-3 border-b border-ink-line px-5 py-2.5 sm:grid">
                <span className=" text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                  Customer
                </span>
                <span className=" text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                  Job
                </span>
                <span className=" text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                  Ch
                </span>
                <span className="text-right text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                  Value
                </span>
                <span className="text-right text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-text-dim">
                  Status
                </span>
              </div>
              {recentFeed.map((row) => {
                // Shared row shell so quote + job rows read as one table.
                // Mobile track count went 2 → 3 so the VALUE can come back.
                // Below sm the value cell was `hidden`, which meant a tradie
                // on a phone could not see what any quote was worth — the one
                // number the row exists to carry. Cells hidden with
                // `display:none` do not occupy a grid track, so on mobile the
                // three visible children (customer, value, status) land in
                // [1fr_auto_auto] exactly.
                const rowClass =
                  'grid w-full grid-cols-[1fr_auto_auto] items-center gap-2.5 border-b border-ink-line px-4 py-3 text-left transition-colors cursor-pointer last:border-b-0 hover:bg-ink-deep/40 sm:gap-3 sm:px-5 sm:grid-cols-[minmax(94px,1.4fr)_minmax(108px,1.7fr)_46px_76px_116px]'
                if (row.kind === 'job') {
                  // Measure-tool job row — links out to the job's customer
                  // page (/q/roof|solar|paint|commercial-paint) in a new tab.
                  const v = jobRowView(row.job)
                  const cells = (
                    <>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-text-pri">
                          {v.label}
                        </div>
                        <div className="mt-0.5 truncate text-[9px] uppercase tracking-[0.08em] text-text-dim">
                          Saved job
                        </div>
                      </div>
                      <span className="hidden min-w-0 truncate text-[12.5px] text-text-sec sm:block">
                        {v.tradeLabel}
                      </span>
                      <span className="hidden text-[9px] font-bold uppercase tracking-[0.08em] text-text-dim sm:block">
                        Tool
                      </span>
                      <span
                        className="text-right font-mono text-[13px] font-bold tabular-nums sm:text-sm"
                        style={{ color: v.value ? 'var(--text-pri)' : 'var(--text-dim)' }}
                      >
                        {v.value ?? '—'}
                      </span>
                      <span className="justify-self-end">
                        <StatusPill
                          label={v.pill.label}
                          tone={v.pill.tone}
                          dot
                          compact
                          pulse={v.pill.pulse}
                        />
                      </span>
                    </>
                  )
                  const key = `job-${row.job.trade}-${row.job.id}`
                  return v.href ? (
                    <a
                      key={key}
                      href={v.href}
                      target="_blank"
                      rel="noreferrer"
                      className={rowClass}
                    >
                      {cells}
                    </a>
                  ) : (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab('quotes')}
                      className={rowClass}
                    >
                      {cells}
                    </button>
                  )
                }
                const q = row.quote
                const pill = overviewQuotePill(q)
                const name =
                  q.customer_full_name || q.customer_first_name || 'Customer'
                const val =
                  q.total_inc_gst != null ? fmtAUD(toNum(q.total_inc_gst)) : '—'
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => openQuote(q)}
                    className={rowClass}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-text-pri">
                        {name}
                      </div>
                      {q.suburb && (
                        <div className="mt-0.5 truncate text-[9px] uppercase tracking-[0.08em] text-text-dim">
                          {q.suburb}
                        </div>
                      )}
                    </div>
                    <span className="hidden min-w-0 truncate text-[12.5px] text-text-sec sm:block">
                      {fmtJobType(q.job_type)}
                    </span>
                    <span className="hidden text-[9px] font-bold uppercase tracking-[0.08em] text-text-dim sm:block">
                      {q.channel === 'voice' ? 'Voice' : 'SMS'}
                    </span>
                    <span
                      className="text-right font-mono text-[13px] font-bold tabular-nums sm:text-sm"
                      style={{ color: val === '—' ? 'var(--text-dim)' : 'var(--text-pri)' }}
                    >
                      {val}
                    </span>
                    <span className="justify-self-end">
                      <StatusPill label={pill.label} tone={pill.tone} dot compact pulse={pill.pulse} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Right rail — attention · number · chats */}
        <div className="flex min-w-0 flex-col gap-[18px]">
          {/* Add your photo (mig 180) — every customer quote shows a "Your
              tradie" block; without a photo it falls back to a generic avatar
              on both the quote page and the PDF. Disappears once one is set. */}
          {!data.tenant.photo_url && (
            <section className="card-sweep relative rounded-card edge-lit overflow-hidden border border-warning-bright/40 bg-ink-card p-[18px]">
              <div className="flex items-center gap-2 text-[9.5px] font-bold uppercase tracking-[0.08em] text-warning-bright">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-warning-bright motion-safe:animate-[pulse-soft_2.4s_ease-in-out_infinite]"
                />
                Add your photo
              </div>
              <p className="mt-2 text-[12.5px] leading-normal text-text-dim">
                Your quotes show a generic avatar in the &ldquo;Your tradie&rdquo;
                section. Add a photo once and customers see your face on every
                quote page and PDF.
              </p>
              <button
                type="button"
                onClick={() => setTab('account')}
                className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-accent px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-accent-ink transition-colors cursor-pointer hover:bg-accent-press"
              >
                Add your photo →
              </button>
            </section>
          )}

          {/* Needs your attention — the top review quote (or an all-clear). */}
          {attnQuote ? (
            <section className="card-sweep relative rounded-card edge-lit overflow-hidden border border-warning-bright/40 bg-ink-card p-[18px]">
              <div className="flex items-center gap-2 text-[9.5px] font-bold uppercase tracking-[0.08em] text-warning-bright">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-warning-bright motion-safe:animate-[pulse-soft_2.4s_ease-in-out_infinite]"
                />
                Needs your attention
              </div>
              <div className="mt-3 flex items-center justify-between gap-2.5">
                <span className="truncate text-sm font-bold text-text-pri">
                  {attnQuote.customer_full_name ||
                    attnQuote.customer_first_name ||
                    'Customer'}
                  {attnQuote.suburb ? ` · ${attnQuote.suburb}` : ''}
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-text-dim">
                  {attnQuote.channel === 'voice' ? 'Voice' : 'SMS'} ·{' '}
                  {fmtRelative(attnQuote.created_at)}
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-normal text-text-dim">
                QuoteMax drafted this one. It needs a couple of details before
                you can send.
              </p>
              <button
                type="button"
                onClick={() => openQuote(attnQuote)}
                className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-accent px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-accent-ink transition-colors cursor-pointer hover:bg-accent-press"
              >
                Review quote →
              </button>
            </section>
          ) : attnJob ? (
            // Measure-tool fallback (spec T3): no pipeline quote needs review,
            // but a saved trade job is still in draft — surface it here so
            // trade-tab work gets the same attention treatment.
            <section className="card-sweep relative rounded-card edge-lit overflow-hidden border border-warning-bright/40 bg-ink-card p-[18px]">
              <div className="flex items-center gap-2 text-[9.5px] font-bold uppercase tracking-[0.08em] text-warning-bright">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-warning-bright motion-safe:animate-[pulse-soft_2.4s_ease-in-out_infinite]"
                />
                Needs your attention
              </div>
              <div className="mt-3 flex items-center justify-between gap-2.5">
                <span className="truncate text-sm font-bold text-text-pri">
                  {attnJobView!.label}
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-text-dim">
                  {attnJobView!.tradeLabel}
                  {attnJob.createdAt ? ` · ${fmtRelative(attnJob.createdAt)}` : ''}
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-normal text-text-dim">
                You measured this one in the{' '}
                {attnJobView!.tradeLabel.toLowerCase()} tool. It is still a
                draft — review and send it.
              </p>
              {attnJob.href ? (
                <a
                  href={attnJob.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-accent px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-accent-ink transition-colors cursor-pointer hover:bg-accent-press"
                >
                  Review job →
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => setTab('quotes')}
                  className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-ctl bg-accent px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-accent-ink transition-colors cursor-pointer hover:bg-accent-press"
                >
                  Review job →
                </button>
              )}
            </section>
          ) : (
            <section className="rounded-card edge-lit overflow-hidden border border-ink-line bg-ink-card p-[18px]">
              <div className="flex items-center gap-2 text-[9.5px] font-bold uppercase tracking-[0.08em] text-success-bright">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-success-bright"
                />
                All clear
              </div>
              <p className="mt-2 text-[12.5px] leading-normal text-text-dim">
                No quotes need your review right now. New ones land here the
                moment they are drafted.
              </p>
            </section>
          )}

          {/* Your QuoteMax number — number + copy + SMS / Voice / AI chips. */}
          <section className="rounded-card edge-lit overflow-hidden border border-ink-line bg-ink-card p-[18px]">
            <div className=" text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-dim">
              Your QuoteMax number
            </div>
            {smsNumber ? (
              <>
                <div className="mt-2.5 flex items-center justify-between gap-2.5">
                  <span className="break-all font-mono text-lg font-bold tracking-[-0.01em] text-text-pri">
                    {formatAuMobile(smsNumber)}
                  </span>
                  <CopyNumberButton value={smsNumber} />
                </div>
                <div className="mt-3.5 flex gap-2">
                  {channelChips.map((c) => (
                    <span key={c.label} className="flex flex-1 justify-center">
                      <StatusPill label={c.label} tone={c.live ? 'success' : 'warn'} dot compact />
                    </span>
                  ))}
                </div>
                {needsProvisioning && <RetryProvisionButton />}
              </>
            ) : (
              <>
                <p className="mt-2 text-[12.5px] leading-normal text-warning-bright">
                  Provisioning didn&rsquo;t finish on activate. Hit retry — your
                  account and pricing book are saved.
                </p>
                <RetryProvisionButton />
              </>
            )}
          </section>

          {/* Recent chats */}
          <section className="rounded-card edge-lit overflow-hidden border border-ink-line bg-ink-card">
            <header className="flex items-center justify-between border-b border-ink-line px-4 py-3">
              <h2 className=" text-[11px] font-bold uppercase tracking-[0.08em] text-text-pri">
                Recent chats
              </h2>
              <button
                type="button"
                onClick={() => setTab('chats')}
                className=" text-[10px] font-bold uppercase tracking-[0.08em] text-accent transition-colors cursor-pointer hover:text-accent-press"
              >
                Open →
              </button>
            </header>
            {(() => {
              // Error is an explicit state with a retry — a failed fetch must
              // never masquerade as "No conversations yet" (spec T5).
              const state = widgetState(chatsLoading, chatsError, latestChats.length)
              if (state === 'loading')
                return (
                  <div className="qm-loading px-4 py-8 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
                    Loading…
                  </div>
                )
              if (state === 'error')
                return (
                  <div className="flex items-center justify-between gap-3 px-4 py-8">
                    <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning-bright">
                      Couldn&rsquo;t load chats.
                    </span>
                    <button
                      type="button"
                      onClick={() => setChatsReload((n) => n + 1)}
                      className=" text-[0.65rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors cursor-pointer hover:text-accent-press"
                    >
                      Retry
                    </button>
                  </div>
                )
              if (state === 'empty')
                return (
                  <div className="px-4 py-8 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
                    No conversations yet.
                  </div>
                )
              return (
                <div>
                  {latestChats.slice(0, 3).map((c) => (
                    <LatestChatRow key={c.id} chat={c} onOpen={() => setTab('chats')} />
                  ))}
                </div>
              )
            })()}
          </section>
        </div>
      </div>
        </div>
      ) : (
        <div
          role="tabpanel"
          id="section-panel-activity"
          aria-labelledby="section-tab-activity"
        >
          {/* YOUR ACTIVITY — communication + conversion analytics not shown by
              the money-first Pipeline/KPI rows above. Lazy-fetches its own
              aggregate on first view. */}
          <OverviewAnalytics
            accessToken={accessToken}
            setTab={setTab}
            onFollowUpCold={onFollowUpColdChats}
            period={period}
          />
        </div>
      )}

    </div>
  )
}

/** Slim Overview page header — time-of-day greeting + today's date.
 *  Sits inside the content column so the sidebar still aligns flush
 *  with the QuoteMax-number hero below it. */
function OverviewHeader({
  firstName,
  subtitle,
  onNewQuote,
  period,
  onPeriod,
}: {
  firstName: string
  subtitle: string
  onNewQuote: () => void
  period: Period
  onPeriod: (p: Period) => void
}) {
  const hour = new Date().getHours()
  const greeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {/* The "QuoteMax · Overview" breadcrumb was removed with direction 1b:
            the sidebar already marks the active tab, so it restated known
            information in the one place a page has to earn attention. */}
        <h1 className="font-extrabold tracking-tight text-text-pri text-[clamp(1.35rem,2.2vw,1.75rem)] leading-[1.15]">
          {greeting}, {firstName}
        </h1>
        <p className="mt-1.5 max-w-xl text-sm text-text-sec">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Period filter — the reference's "This month" slot, now a live
            reporting-window control that scopes the KPIs, recent quotes and
            the Your-activity analytics below. */}
        <PeriodPicker period={period} onChange={onPeriod} />
        {/* Demoted from accent fill to rank-2. The action is unchanged and
            still here — but the accent fill is spent on the ONE thing that
            needs doing (the "needs your attention" card below), and on desktop
            this repeated the identical primary already in the topbar. */}
        <button
          type="button"
          onClick={onNewQuote}
          className="inline-flex items-center gap-2 rounded-ctl border border-ink-line bg-ink-card px-4 py-2.5 text-[13px] font-semibold text-text-pri transition-colors cursor-pointer hover:border-accent/50 hover:text-accent"
        >
          <FileText size={15} strokeWidth={2} aria-hidden="true" />
          Review queue
        </button>
      </div>
    </header>
  )
}

/** Reporting-period dropdown — the header's live time-window control. Follows
 *  the dashboard's own menu idiom (pointerdown + Escape to close, aria-expanded
 *  trigger, rounded lit-edge panel). Selecting a period scopes the Overview
 *  performance KPIs, the recent-quotes list, and the Your-activity analytics. */
function PeriodPicker({
  period,
  onChange,
}: {
  period: Period
  onChange: (p: Period) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Reporting period: ${periodLabel(period)}`}
        className="inline-flex items-center gap-2 rounded-ctl border border-ink-line px-3.5 py-2 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-sec transition-colors cursor-pointer hover:border-text-dim hover:text-text-pri"
      >
        <CalendarDays
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className="text-text-dim"
        />
        {periodLabel(period)}
        <ChevronDown
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          className={`text-text-dim transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-40 min-w-[168px] overflow-hidden rounded-card edge-lit border border-ink-line bg-ink-card py-1 shadow-[0_16px_40px_-12px_rgba(11,9,7,0.55)]"
        >
          {PERIODS.map((p) => {
            const active = p.key === period
            return (
              <button
                key={p.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(p.key)
                  setOpen(false)
                  btnRef.current?.focus()
                }}
                className={`flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[0.62rem] font-bold uppercase tracking-[0.08em] transition-colors ${
 active
 ? 'text-accent'
 : 'text-text-sec hover:bg-ink-deep/40 hover:text-text-pri'
 }`}
              >
                {p.label}
                {active && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Copy-to-clipboard control for the QuoteMax number. Silent success —
 *  the label flips to "Copied" for ~1.6s, no toast. */
function CopyNumberButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — no-op, the number is still visible */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line px-2.5 py-1.5 text-[0.58rem] font-bold uppercase tracking-[0.08em] text-text-sec transition-colors hover:border-accent/50 hover:text-text-pri cursor-pointer"
      aria-label={copied ? 'Number copied' : 'Copy number'}
    >
      {copied ? (
        <>
          <Check size={12} strokeWidth={2.5} aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <Copy size={12} strokeWidth={2} aria-hidden="true" />
          Copy
        </>
      )}
    </button>
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
  const valueTone = tone === 'ok' ? 'text-success-bright' : 'text-accent'
  return (
    <div className="bg-ink-card p-5">
      <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-2 font-mono font-extrabold leading-none text-[clamp(1.25rem,2.2vw,1.75rem)] tabular-nums ${valueTone}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[0.55rem] uppercase tracking-[0.08em] text-text-sec">
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
      const token = await getAuthToken()
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
        aria-busy={busy}
        className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
      >
        {busy ? 'Retrying…' : 'Retry provisioning'}
      </button>
      {err && (
        <p className="mt-2 text-xs text-warning-bright max-w-md">{err}</p>
      )}
    </div>
  )
}

function Pill({ tone, label }: { tone: 'ok' | 'warn' | 'dim'; label: string }) {
  return (
    <StatusPill
      label={label}
      tone={tone === 'ok' ? 'success' : tone === 'warn' ? 'warn' : 'dim'}
      dot
    />
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
    <div className="rounded-card bg-ink-card border border-ink-line p-5">
      <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
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
  delay = 0,
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'default' | 'warn' | 'ok'
  /** Entrance stagger in ms — the KPI row reveals tile by tile. */
  delay?: number
}) {
  const isNumber = typeof value === 'number'
  const animated = useCountUp(isNumber ? value : 0)
  const display = isNumber ? animated : value
  const valueTone =
    tone === 'warn'
      ? 'text-warning-bright'
      : tone === 'ok'
        ? 'text-success-bright'
        : 'text-accent'
  return (
    <div
      className="rounded-card bg-ink-card border border-ink-line p-5 md:p-6 motion-safe:animate-[fade-up_380ms_cubic-bezier(0.22,1,0.36,1)_both]"
      style={delay > 0 ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
        {label}
      </div>
      <div
        className={`mt-2 font-mono font-extrabold leading-none text-[clamp(1.75rem,3vw,2.5rem)] tabular-nums ${valueTone}`}
      >
        {display}
      </div>
      {hint && (
        <div className="mt-2 text-[0.6rem] uppercase tracking-[0.08em] text-text-sec">
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
  const tone: Tone = isPaid
    ? 'success'
    : isInspect
      ? 'warn'
      : status === 'accepted'
        ? 'success'
        : 'dim'
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
        <div className="mt-1 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
          {q.job_type ? formatJobType(q.job_type) : 'Unclassified'}
          {q.suburb ? ` · ${q.suburb}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm font-bold text-text-pri">
          {total !== null ? `$${formatMoney(total)}` : '—'}
        </div>
        <div className="mt-1 flex justify-end">
          <StatusPill label={badge} tone={tone} dot compact />
        </div>
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
        <div className="mt-1 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
          {chat.job_type ? formatJobType(chat.job_type) : 'Unclassified'}
          {chat.suburb ? ` · ${chat.suburb}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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

/** Migration 104 — opt-in toggle for the SMS electrical-plan estimator.
 *  When on, a customer texting this tenant's number about an electrical plan
 *  gets a PDF-upload link, an automatic AI take-off, and the results link
 *  (+ PDF report) back by SMS. The run also lands in Estimator history. */
function SmsEstimatorCard({
  tenant,
  onSave,
}: {
  tenant: Tenant
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [enabled, setEnabled] = useState<boolean>(tenant.sms_estimator_enabled ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function toggle() {
    const next = !enabled
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      await onSave({ tenant: { sms_estimator_enabled: next } })
      setEnabled(next)
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="SMS electrical estimation"
      subtitle="Customers text for a plan take-off — upload link out, counted results back."
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-xl text-sm leading-relaxed text-text-sec">
          <p>
            When on, a customer texting {tenant.twilio_sms_number ?? 'your QuoteMax number'} about an
            electrical plan receives a secure upload link. The take-off runs automatically and the customer
            gets a results link plus a downloadable PDF report — the run also appears in your Estimator
            history for review.
          </p>
          {error && <p className="mt-2 text-sm text-warning">{error}</p>}
          {savedAt && !error && <p className="mt-2 font-mono text-xs text-success-bright">✓ Saved</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled ? 'true' : 'false'}
          onClick={toggle}
          disabled={busy}
          aria-busy={busy}
          className={`rounded-ctl inline-flex items-center gap-2 border px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.08em] transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
 enabled
 ? 'border-accent bg-success-bright/10 text-success-bright'
 : 'border-ink-line text-text-dim hover:border-accent hover:text-accent'
 }`}
        >
          <span aria-hidden="true" className={`inline-block h-2 w-2 ${enabled ? 'bg-success-bright' : 'bg-text-dim'}`} />
          {busy ? 'Saving…' : enabled ? 'On' : 'Off'}
        </button>
      </div>
    </Card>
  )
}

// Brand-image card — the business logo (migration 141) and the tradie's own
// photo (migration 180). One component, two instances: both are "pick an image,
// POST it, the customer quote surfaces update". The upload + DB write happen in
// onUpload (→ /api/tenant/logo|photo); on success the parent re-fetches, so the
// preview here and every customer quote reflect it. Validates type/size
// client-side for a fast error before hitting the network.
const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'
const LOGO_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
const LOGO_MAX_BYTES = 2 * 1024 * 1024

function BrandImageCard({
  title,
  subtitle,
  noun,
  currentUrl,
  fit = 'contain',
  onUpload,
}: {
  title: string
  subtitle: string
  /** Lowercase noun for the button + error copy, e.g. "logo" / "photo". */
  noun: string
  currentUrl: string | null
  /** 'contain' suits a wordmark on white; 'cover' suits a headshot. */
  fit?: 'contain' | 'cover'
  onUpload: (file: File) => Promise<void>
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)

  async function handleFile(file: File | null) {
    if (!file) return
    setError(null)
    const mime = (file.type || '').split(';')[0].trim().toLowerCase()
    if (!LOGO_ALLOWED_MIME.includes(mime)) {
      setError(`${Noun} must be a PNG, JPG, WEBP, or SVG image.`)
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError(`${Noun} must be 2 MB or smaller.`)
      return
    }
    setUploading(true)
    try {
      await onUpload(file)
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? `${Noun} upload failed`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card title={title} subtitle={subtitle}>
      <div className="flex items-center gap-5">
        <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden border border-ink-line bg-white">
          {currentUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentUrl}
              alt={`Your ${noun}`}
              className={`h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'}`}
            />
          ) : (
            <span className=" text-[0.55rem] uppercase tracking-[0.08em] text-text-dim">
              No {noun}
            </span>
          )}
        </div>
        <div className="flex-1">
          <label className="rounded-ctl inline-flex cursor-pointer items-center gap-2 border border-ink-line bg-ink-deep px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent-soft">
            <input
              type="file"
              accept={LOGO_ACCEPT}
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            {uploading ? 'Uploading…' : currentUrl ? `Change ${noun}` : `Upload ${noun}`}
          </label>
          <p className="mt-2 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
            PNG, JPG, WEBP or SVG · max 2 MB
          </p>
          {error && (
            <div className="mt-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          {savedAt && !error ? (
            <div className="mt-3">
              <SaveHint savedAt={savedAt} />
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

// Default schedule availability card (migration 147). Lets the tradie set
// their recurring weekly working hours; customers then book a morning or
// afternoon slot on those days. Saves to tenants.default_availability via
// PATCH /api/tenant/me. Falls back to a state-derived default when the tenant
// has none yet (legacy rows).
function DefaultScheduleCard({
  tenant,
  onSave,
}: {
  tenant: Tenant
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const initial =
    parseAvailability(tenant.default_availability) ??
    defaultAvailabilityForState(tenant.state)
  const [value, setValue] = useState<WeeklyAvailability>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const valid = parseAvailability(value) !== null

  async function save() {
    if (!valid) {
      setError('Each working day needs a start time before its end time.')
      return
    }
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      await onSave({ tenant: { default_availability: value } })
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Booking availability"
      subtitle="The hours you work each week. Customers pick a morning or afternoon slot on these days."
    >
      <AvailabilityEditor value={value} onChange={setValue} disabled={busy} />
      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={busy || !valid}
          aria-busy={busy}
          className="rounded-ctl inline-flex items-center gap-2 border border-ink-line bg-ink-deep px-5 py-2.5 text-sm font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save availability'}
        </button>
        {error && <span className="text-sm text-warning">{error}</span>}
        {savedAt && !error ? <SaveHint savedAt={savedAt} /> : null}
      </div>
    </Card>
  )
}

function AccountTab({
  data,
  onSave,
  onSaveTrades,
  onListAvailableTrades,
  onActivateTrade,
  onUploadLogo,
  onUploadPhoto,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onSaveTrades: (trades: string[]) => Promise<{
    trades: string[]
    activated: string[]
    deactivated: string[]
    warning?: string
    noop?: boolean
  }>
  onListAvailableTrades: () => Promise<{
    ok: true
    available: Array<{ name: string; displayName: string }>
    manageable: Array<{ name: string; displayName: string; owned: boolean }>
  }>
  onActivateTrade: (
    trade: string,
  ) => Promise<{ ok: true; trade: string; warning?: string }>
  onUploadLogo: (file: File) => Promise<void>
  onUploadPhoto: (file: File) => Promise<void>
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
      <TradesCard
        onSaveTrades={onSaveTrades}
        onListManageableTrades={onListAvailableTrades}
      />

      <SmsEstimatorCard tenant={data.tenant} onSave={onSave} />

      <DefaultScheduleCard tenant={data.tenant} onSave={onSave} />

      <LicencesCard
        licences={data.licences ?? []}
        trades={
          Array.isArray(data.tenant.trades) && data.tenant.trades.length > 0
            ? (data.tenant.trades as string[])
            : data.tenant.trade
              ? [data.tenant.trade]
              : []
        }
        onSave={onSave}
        primaryState={data.tenant.state ?? null}
      />

      <BrandImageCard
        title="Business logo"
        subtitle="Shown on every customer quote — updating it changes the logo on all your quotes."
        noun="logo"
        currentUrl={data.tenant.logo_url}
        onUpload={onUploadLogo}
      />
      <BrandImageCard
        title="Your photo"
        subtitle='Shown in the "Your tradie" section of every customer quote — on the web page and the PDF. A clear headshot builds trust; without one customers see a generic avatar.'
        noun="photo"
        currentUrl={data.tenant.photo_url}
        fit="cover"
        onUpload={onUploadPhoto}
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
            aria-busy={submitting}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save account'}
          </button>
        </div>
      </form>
      </Card>

      <ChangePasswordCard />
    </div>
  )
}

// ─── Payouts tab — Stripe Connect (Express) onboarding ───────────
//
// Lets a tradie set up (or resume) the Stripe Connect account that
// QuoteMax pays completed-job money into. Live status comes straight
// from the tenant row's stripe_connect_* columns (migration 056),
// kept current by /api/stripe/connect-webhook. The action button
// POSTs /api/stripe/connect/start and redirects to Stripe-hosted
// onboarding.

// Map an error payload from the payout endpoints (connect/start,
// connect/refresh) to tradie-facing copy. We deliberately NEVER surface the
// raw Stripe developer `detail` (e.g. the Accounts v1 deprecation notice, or
// an internal "account_create_failed" reason) — a tradie should only ever see
// a plain-English next step. The raw payload stays in the Network response for
// us to inspect; the server keeps the real diagnostics.
function friendlyPayoutError(
  json: { error?: string; detail?: string } | null,
  httpStatus: number,
): string {
  switch (json?.error) {
    case 'provisioning_disabled':
      return 'Payout setup isn’t switched on yet — QuoteMax is finishing the rollout. Check back shortly.'
    case 'connect_not_enabled':
      return 'Payouts aren’t available just yet — QuoteMax is finishing the payments setup on our side. Please check back shortly.'
    case 'unauthorized':
      return 'Your session expired — refresh the page and sign in again.'
    case 'account_create_failed':
    case 'account_validate_failed':
    case 'account_persist_failed':
    case 'stale_account_heal_failed':
    case 'link_create_failed':
    case 'sync_failed':
    case 'sync_persist_failed':
      return 'We couldn’t reach Stripe to set up your payouts just now. Please try again in a moment — if it keeps happening, contact QuoteMax support.'
    default:
      return `Something went wrong setting up payouts (HTTP ${httpStatus}). Please try again shortly.`
  }
}

function PayoutsTab({
  data,
  accessToken,
  onSynced,
}: {
  data: DashboardData
  accessToken: string | null
  /** Re-pull /api/tenant/me so the status line re-derives after a sync. */
  onSynced?: () => void
}) {
  const t = data.tenant
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const hasAccount = !!t.stripe_connect_account_id
  const payoutsReady = !!t.stripe_connect_payouts_enabled
  const detailsSubmitted = !!t.stripe_connect_details_submitted

  // Pull the live account status from Stripe and mirror it onto the tenant
  // row, then re-pull the dashboard so the status line updates. This is the
  // fix for the onboarding loop: returning from Stripe's hosted form, the
  // `account.updated` webhook may never land (localhost / lag), leaving the
  // flags stale-false. `soft` (the on-return auto-sync) swallows errors so a
  // transient hiccup doesn't flash a scary banner; the manual button surfaces
  // them. Returns whether the tenant data was refreshed.
  const syncStatus = useCallback(
    async (soft: boolean): Promise<void> => {
      if (!accessToken) return
      setSyncing(true)
      if (!soft) setErr(null)
      try {
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/stripe/connect/refresh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        const json = await res.json().catch(() => null)
        if (json?.ok) {
          if (json.synced) onSynced?.()
        } else if (!soft) {
          setErr(friendlyPayoutError(json, res.status))
        }
      } catch (e) {
        if (!soft) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setSyncing(false)
      }
    },
    [accessToken, onSynced],
  )

  // On return from Stripe the flags are usually stale — reconcile once when
  // an account exists but payouts aren't yet marked ready. Fires a single
  // time per mount (the ref guard); once payoutsReady flips true the guard is
  // moot because the condition no longer holds.
  const autoSyncedRef = useRef(false)
  useEffect(() => {
    if (!accessToken || !hasAccount || payoutsReady || autoSyncedRef.current) return
    autoSyncedRef.current = true
    void syncStatus(true)
  }, [accessToken, hasAccount, payoutsReady, syncStatus])

  // One headline status, derived from the synced flags:
  //   not_started — no connected account yet
  //   incomplete  — account exists, tradie hasn't finished the form
  //   verifying   — form submitted, Stripe still checking identity/bank
  //   ready       — payouts_enabled: QuoteMax can pay this tradie
  const status: 'ready' | 'verifying' | 'incomplete' | 'not_started' =
    payoutsReady
      ? 'ready'
      : hasAccount && detailsSubmitted
        ? 'verifying'
        : hasAccount
          ? 'incomplete'
          : 'not_started'

  async function startOnboarding() {
    setErr(null)
    if (!accessToken) {
      setErr('Your session expired — refresh the page and sign in again.')
      return
    }
    setBusy(true)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/stripe/connect/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.ok && json.url) {
        // Hand off to Stripe's hosted onboarding.
        window.location.href = json.url as string
        return
      }
      setErr(friendlyPayoutError(json, res.status))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const statusUi = {
    ready: { label: 'Payouts active', tone: 'success' as Tone },
    verifying: { label: 'Verifying with Stripe', tone: 'warn' as Tone },
    incomplete: { label: 'Setup incomplete', tone: 'warn' as Tone },
    not_started: { label: 'Not set up', tone: 'dim' as Tone },
  }[status]

  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-5">
          {/* Live status line */}
          <div className="flex items-center gap-2.5">
            <StatusPill label={statusUi.label} tone={statusUi.tone} dot />
          </div>

          {status === 'ready' && (
            <p className="text-sm leading-relaxed text-text-sec">
              You’re all set. When a customer pays for a job, QuoteMax releases
              your share to your bank account once the job is marked complete.
            </p>
          )}
          {status === 'verifying' && (
            <p className="text-sm leading-relaxed text-text-sec">
              Stripe is verifying your identity and bank details. This usually
              clears within a few minutes — you don’t need to do anything. This
              page updates once it’s confirmed.
            </p>
          )}
          {status === 'incomplete' && (
            <p className="text-sm leading-relaxed text-text-sec">
              You’ve started payout setup but Stripe still needs a few more
              details before it can pay you. Pick up where you left off below.
            </p>
          )}
          {status === 'not_started' && (
            <p className="text-sm leading-relaxed text-text-sec">
              Set up your secure payout account so QuoteMax can pay you for
              completed jobs. Stripe handles your bank details and identity
              checks — it takes about 5 minutes.
            </p>
          )}

          {err && <ErrorBanner>{err}</ErrorBanner>}

          <div className="flex flex-wrap items-center gap-3">
            {status === 'ready' ? (
              <button
                type="button"
                onClick={startOnboarding}
                disabled={busy}
                aria-busy={busy}
                className="rounded-ctl inline-flex items-center gap-2 border border-ink-line text-text-sec hover:text-text-pri font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
              >
                {busy ? 'Opening Stripe…' : 'Update payout details'}
              </button>
            ) : (
              <button
                type="button"
                onClick={startOnboarding}
                disabled={busy}
                aria-busy={busy}
                className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
              >
                <Banknote size={16} strokeWidth={2} aria-hidden="true" />
                {busy
                  ? 'Opening Stripe…'
                  : status === 'not_started'
                    ? 'Set up payouts'
                    : 'Continue setup'}
              </button>
            )}
            {/* Finished the Stripe form but the tab still says incomplete?
                Re-pull the live status (covers a missed/late webhook). */}
            {hasAccount && !payoutsReady && (
              <button
                type="button"
                onClick={() => void syncStatus(false)}
                disabled={syncing}
                aria-busy={syncing}
                className="rounded-ctl inline-flex items-center gap-2 border border-ink-line text-text-sec hover:text-text-pri font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
              >
                {syncing ? 'Checking…' : 'Refresh status'}
              </button>
            )}
          </div>
        </div>
      </Card>

      {hasAccount && <PayoutJobsSection accessToken={accessToken} />}

      <Card title="How you get paid">
        <ul className="space-y-3.5 text-sm leading-relaxed text-text-sec">
          <li className="flex gap-3">
            <span className="font-mono text-accent shrink-0">1</span>
            <span>
              The customer pays their deposit and final balance through
              QuoteMax.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-accent shrink-0">2</span>
            <span>The money is held securely until you mark the job complete.</span>
          </li>
          <li className="flex gap-3">
            <span className="font-mono text-accent shrink-0">3</span>
            <span>
              QuoteMax releases your share straight to your bank — a 2%
              platform fee is kept, the rest is yours.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  )
}

// ─── Payouts tab — held money + release on job completion ────────
//
// Lists the tenant's Connect-routed paid jobs (GET /api/tenant/payouts):
// the deposit collected, QuoteMax's 2% fee, and the net held in their
// Stripe balance. "Mark complete" POSTs /api/quote/[id]/complete, which
// stamps completed_at and releases the payout to their bank.

type PayoutJob = {
  quote_id: string
  job_type: string | null
  paid_tier: string | null
  paid_at: string
  paid_amount_cents: number | null
  platform_fee_cents: number | null
  net_cents: number
  completed_at: string | null
  release_state: 'released' | 'in_flight' | 'awaiting'
  payout: {
    id: string
    amount_cents: number | null
    created_at: string | null
    status?: string | null
    arrival_date?: number | null
  } | null
}

// Live account details from /api/tenant/payouts (Stripe-sourced, best-effort).
type PayoutAccount = {
  has_account: boolean
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  onboarded_at: string | null
  bank: { bank_name: string | null; last4: string | null; currency: string | null } | null
  payout_schedule: string | null
  balance: { available_cents: number; pending_cents: number; currency: string } | null
  requirements_due: number
}

type PayoutSummary = {
  heldCents: number
  paidOutCents: number
  thisMonthCents: number
  feesCents: number
  jobsPaid: number
  jobsAwaiting: number
}

// Derive the headline figures from the jobs list. Client-side so "this month"
// respects the tradie's local timezone; the list is capped at 200 rows
// server-side, comfortably above real per-tradie payout volume.
function summarisePayouts(jobs: PayoutJob[]): PayoutSummary {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  let heldCents = 0
  let paidOutCents = 0
  let thisMonthCents = 0
  let feesCents = 0
  let jobsPaid = 0
  let jobsAwaiting = 0
  for (const j of jobs) {
    feesCents += j.platform_fee_cents ?? 0
    // A released payout that bounced (failed) or was canceled never reached
    // the bank — the funds returned to the Stripe balance — so it must not be
    // counted as "paid out". The red "Failed" row already surfaces it; we just
    // keep it out of the money totals rather than double-counting into held.
    const bounced = j.payout?.status === 'failed' || j.payout?.status === 'canceled'
    if (j.release_state === 'released' && !bounced) {
      const amt = j.payout?.amount_cents ?? j.net_cents
      paidOutCents += amt
      jobsPaid += 1
      const d = j.payout?.created_at ? new Date(j.payout.created_at) : null
      if (d && d.getFullYear() === y && d.getMonth() === m) thisMonthCents += amt
    } else if (j.release_state !== 'released') {
      heldCents += j.net_cents
      jobsAwaiting += 1
    }
  }
  return { heldCents, paidOutCents, thisMonthCents, feesCents, jobsPaid, jobsAwaiting }
}

// Live Stripe payout state → label + colour. Absent (Stripe unreachable) falls
// back to the plain release date in the list.
const PAYOUT_STATUS_UI: Record<string, { label: string; tone: Tone }> = {
  paid: { label: 'Paid', tone: 'success' },
  in_transit: { label: 'In transit', tone: 'warn' },
  pending: { label: 'Processing', tone: 'warn' },
  canceled: { label: 'Canceled', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
}

function fmtDayMonth(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  // Stripe arrival_date is unix seconds; DB timestamps are ISO strings.
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

function payoutScheduleLabel(schedule: string | null): string {
  if (!schedule || schedule === 'manual') return 'Released when you mark a job complete'
  if (schedule === 'daily') return 'Automatic daily payouts'
  if (schedule === 'weekly') return 'Automatic weekly payouts'
  if (schedule === 'monthly') return 'Automatic monthly payouts'
  return `Automatic ${schedule} payouts`
}

const PAYOUT_BLOCK_COPY: Record<string, string> = {
  payouts_not_ready:
    'Stripe hasn’t finished verifying your payout account yet — the release will work once verification clears.',
  release_in_progress:
    'A release for this job is already in progress — give it a moment and refresh.',
  account_mismatch:
    'This job was paid into a previous payout account. Contact QuoteMax support to release it.',
  not_connect_routed:
    'This job was paid before your payout account was live, so there’s no held money to release.',
  nothing_to_release: 'There’s nothing left to release for this job.',
}

function fmtAudCents(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString('en-AU', {
    style: 'currency',
    currency: 'AUD',
  })
}

// One chained job now produces up to three payout rows — the $99 site visit,
// the deposit and the balance — so the tier suffix is what tells them apart
// (spec post-visit-money-sequence R12). Without an explicit map the two child
// charges would read as the bare literals 'deposit' / 'balance', which is
// nearly right but inconsistent with "site visit"; spelling all three out
// keeps the list scannable.
const PAYOUT_TIER_LABEL: Record<string, string> = {
  inspection: 'site visit',
  deposit: 'deposit',
  balance: 'final payment',
}

function payoutJobLabel(j: PayoutJob): string {
  const job = (j.job_type ?? 'job').replace(/_/g, ' ')
  if (!j.paid_tier) return job
  return `${job} · ${PAYOUT_TIER_LABEL[j.paid_tier] ?? j.paid_tier}`
}

function PayoutJobsSection({ accessToken }: { accessToken: string | null }) {
  const [jobs, setJobs] = useState<PayoutJob[] | null>(null)
  const [account, setAccount] = useState<PayoutAccount | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const token = (await getAuthToken()) ?? accessToken
      if (!token) return
      const res = await fetch('/api/tenant/payouts', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.ok) {
        setJobs(json.jobs as PayoutJob[])
        setAccount((json.account as PayoutAccount) ?? null)
        setLoadErr(null)
      } else {
        setLoadErr(json?.error ?? `Couldn’t load payouts (HTTP ${res.status}).`)
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [accessToken])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function releaseJob(quoteId: string) {
    setActionMsg(null)
    setBusyId(quoteId)
    try {
      const token = (await getAuthToken()) ?? accessToken
      if (!token) return
      const res = await fetch(`/api/quote/${quoteId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => null)
      if (json?.ok && json.released) {
        setActionMsg(
          `Payout of ${fmtAudCents(json.payout?.amount_cents)} is on its way to your bank.`,
        )
      } else if (json?.ok && json.block) {
        setActionMsg(
          PAYOUT_BLOCK_COPY[json.block as string] ??
            'Job marked complete, but the payout couldn’t be released yet.',
        )
      } else if (json?.error === 'payout_failed' && json.code === 'balance_insufficient') {
        setActionMsg(
          'Job marked complete. Stripe is still settling this payment (usually 1–2 business days) — release it again once it clears.',
        )
      } else {
        setActionMsg(
          json?.detail || json?.error || `Couldn’t release the payout (HTTP ${res.status}).`,
        )
      }
      await refresh()
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const awaiting = (jobs ?? []).filter((j) => j.release_state !== 'released')
  const released = (jobs ?? []).filter((j) => j.release_state === 'released')
  const summary = summarisePayouts(jobs ?? [])
  // Skip the overview for a just-onboarded account with nothing to show yet
  // (no jobs, no bank/balance) — it would be an all-zero card.
  const showOverview =
    jobs !== null && (jobs.length > 0 || !!account?.bank || !!account?.balance)

  return (
    <>
      {showOverview && (
        <PayoutOverview
          account={account}
          summary={summary}
          truncated={(jobs?.length ?? 0) >= 200}
        />
      )}

      <Card title="Money held for you">
        {loadErr && <ErrorBanner>{loadErr}</ErrorBanner>}
        {actionMsg && (
          <p className="mb-4 text-sm leading-relaxed text-text-sec">{actionMsg}</p>
        )}
        {jobs === null && !loadErr ? (
          <p className="qm-loading text-sm text-text-dim">Loading…</p>
        ) : awaiting.length === 0 ? (
          <p className="text-sm leading-relaxed text-text-sec">
            No payments waiting on you. When a customer pays a deposit, it
            shows up here until you mark the job complete.
          </p>
        ) : (
          <ul className="divide-y divide-ink-line">
            {awaiting.map((j) => (
              <li
                key={j.quote_id}
                className="flex flex-wrap items-center justify-between gap-3 py-3.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold capitalize text-text-pri">
                    {payoutJobLabel(j)}
                  </p>
                  <p className="mt-0.5 text-xs text-text-dim">
                    Paid {new Date(j.paid_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                    {' · '}
                    {fmtAudCents(j.paid_amount_cents)} collected − {fmtAudCents(j.platform_fee_cents)} fee ={' '}
                    <span className="text-text-sec">{fmtAudCents(j.net_cents)} yours</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => releaseJob(j.quote_id)}
                  disabled={busyId !== null || j.release_state === 'in_flight'}
                  aria-busy={busyId !== null}
                  className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-4 py-2 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
                >
                  {busyId === j.quote_id
                    ? 'Releasing…'
                    : j.release_state === 'in_flight'
                      ? 'Release in progress'
                      : j.completed_at
                        ? 'Release payout'
                        : 'Mark complete & release'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {released.length > 0 && (
        <Card title="Paid out">
          <ul className="divide-y divide-ink-line">
            {released.map((j) => {
              const status = j.payout?.status ?? null
              const st = status ? PAYOUT_STATUS_UI[status] : null
              const inTransit = status === 'in_transit' || status === 'pending'
              const amountTone =
                status === 'failed' || status === 'canceled'
                  ? 'text-danger-bright'
                  : inTransit
                    ? 'text-text-pri'
                    : 'text-success-bright'
              return (
                <li
                  key={j.quote_id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold capitalize text-text-pri">
                      {payoutJobLabel(j)}
                    </p>
                    <p className="mt-0.5 text-xs text-text-dim">
                      {status === 'failed'
                        ? 'Payout failed — funds returned to your balance'
                        : status === 'canceled'
                          ? 'Payout canceled'
                          : inTransit && j.payout?.arrival_date
                            ? `Arriving ${fmtDayMonth(j.payout.arrival_date)}`
                            : `Released ${fmtDayMonth(j.payout?.created_at)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {st && <StatusPill label={st.label} tone={st.tone} dot compact />}
                    <span className={`font-mono text-sm font-bold tabular-nums ${amountTone}`}>
                      {fmtAudCents(j.payout?.amount_cents ?? j.net_cents)}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </>
  )
}

// ─── Payouts overview — headline figures + destination & balance ──
//
// Sits above the held/paid-out lists. The four figures are derived from the
// jobs list (summarisePayouts); the destination + Stripe balance come from
// the live account enrichment on /api/tenant/payouts and degrade gracefully
// to nothing when Stripe is unreachable.

function PayoutOverview({
  account,
  summary,
  truncated,
}: {
  account: PayoutAccount | null
  summary: PayoutSummary
  /** True when the job list hit the server cap, so the totals cover only the
   *  most recent jobs rather than the tradie's full history. */
  truncated?: boolean
}) {
  const bank = account?.bank ?? null
  const balance = account?.balance ?? null
  const showDestination = !!bank || !!balance || !!account?.payout_schedule
  const requirementsDue = account?.requirements_due ?? 0

  return (
    <Card title="Your payouts">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Figure
          label="Held for you"
          value={fmtAudCents(summary.heldCents)}
          sub={summary.jobsAwaiting === 1 ? '1 job awaiting' : `${summary.jobsAwaiting} jobs awaiting`}
          accent
        />
        <Figure
          label="Paid out"
          value={fmtAudCents(summary.paidOutCents)}
          sub={summary.jobsPaid === 1 ? '1 job released' : `${summary.jobsPaid} jobs released`}
        />
        <Figure label="This month" value={fmtAudCents(summary.thisMonthCents)} sub="released to bank" />
        <Figure label="Platform fees" value={fmtAudCents(summary.feesCents)} sub="2% per job" />
      </dl>

      {showDestination && (
        <div className="mt-6 flex flex-col gap-4 border-t border-ink-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Landmark size={16} strokeWidth={2} className="shrink-0 text-text-dim" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm text-text-pri">
                {bank
                  ? `${bank.bank_name ?? 'Bank account'}${bank.last4 ? ` ···· ${bank.last4}` : ''}`
                  : 'Bank account on file with Stripe'}
              </p>
              <p className="mt-0.5 text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
                {payoutScheduleLabel(account?.payout_schedule ?? null)}
              </p>
            </div>
          </div>

          {balance && (
            <div className="flex items-center gap-2.5 sm:justify-end">
              <Wallet size={16} strokeWidth={2} className="shrink-0 text-text-dim" aria-hidden="true" />
              <div className="sm:text-right">
                <p className="font-mono text-sm tabular-nums text-text-pri">
                  {fmtAudCents(balance.available_cents)} available
                </p>
                <p className="mt-0.5 text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
                  {fmtAudCents(balance.pending_cents)} still settling
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {requirementsDue > 0 && (
        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-warning-bright">
          <Shield size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Stripe still needs {requirementsDue} detail{requirementsDue === 1 ? '' : 's'} to keep
            your payouts flowing — use the payout setup button above to finish.
          </span>
        </p>
      )}

      {truncated && (
        <p className="mt-4 text-[0.7rem] text-text-dim">
          Totals cover your 200 most recent paid jobs.
        </p>
      )}
    </Card>
  )
}

function Figure({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div>
      <dt className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
        {label}
      </dt>
      <dd
        className={`mt-1.5 font-mono text-xl font-bold tabular-nums sm:text-2xl ${
          accent ? 'text-accent' : 'text-text-pri'
        }`}
      >
        {value}
      </dd>
      {sub && <dd className="mt-0.5 text-[0.7rem] text-text-dim">{sub}</dd>}
    </div>
  )
}

// ─── Licences card — one section per trade (Account tab) ─────────

function LicencesCard({
  licences,
  trades,
  onSave,
  primaryState,
}: {
  licences: LicenceRow[]
  /** R39 — the tenant's active trades. Used to back-fill a BLANK fieldset for
   *  a just-activated trade even if the /api/tenant/me licences payload hasn't
   *  caught up yet, so the new trade always has a fieldset to fill in. */
  trades: string[]
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
  // R39 — the ordered set of fieldsets to render: one per active trade, with a
  // blank row back-filled for any trade the licences payload doesn't carry yet
  // (lib/dashboard/licence-fieldsets.ts — pure + unit-tested). When `trades`
  // is empty (legacy) this is just `licences` verbatim. Dep signatures are
  // hoisted to plain consts so the memo deps stay simple expressions.
  const tradesSig = trades.join('|')
  const licencesSig = licences
    .map((l) => `${l.trade}:${l.licence_number}:${l.licence_expiry}:${l.licence_state}:${l.licence_type}`)
    .join('|')
  const fieldsets = useMemo(
    () => licenceFieldsetsForTrades(trades, licences, primaryState) as LicenceRow[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tradesSig, licencesSig, primaryState],
  )
  const initial: Record<string, LicenceForm> = useMemo(() => {
    const m: Record<string, LicenceForm> = {}
    for (const l of fieldsets) {
      m[l.trade] = {
        licence_type: l.licence_type ?? '',
        licence_number: l.licence_number ?? '',
        licence_state: l.licence_state ?? primaryState ?? '',
        licence_expiry: l.licence_expiry ?? '',
      }
    }
    return m
  }, [fieldsets, primaryState])

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

  if (fieldsets.length === 0) {
    return null
  }

  const isMulti = fieldsets.length > 1
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
        {fieldsets.map((l) => {
          const f = form[l.trade] ?? initial[l.trade]
          if (!f) return null
          return (
            <div key={l.trade} className="space-y-4">
              {isMulti && (
                <h3 className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold">
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
            aria-busy={submitting}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
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
  onSaveTrades,
  onListManageableTrades,
}: {
  onSaveTrades: (trades: string[]) => Promise<{
    trades: string[]
    activated: string[]
    deactivated: string[]
    warning?: string
    noop?: boolean
  }>
  onListManageableTrades: () => Promise<{
    manageable: Array<{ name: string; displayName: string; owned: boolean }>
  }>
}) {
  // Registry-driven: the card lists every activatable job-based trade
  // (electrical, plumbing, painting, solar, commercial painting, …) as a
  // toggle, pre-selected by what the tenant already owns. Save reconciles the
  // whole set through /api/tenant/trades/reconcile — activating new trades and
  // deactivating deselected ones. A confirm prompt fires before any removal.
  const [manageable, setManageable] = useState<
    Array<{ name: string; displayName: string; owned: boolean }> | null
  >(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [owned, setOwned] = useState<string[]>([])
  const [staged, setStaged] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<
    null | { trades: string[]; removedLabels: string[] }
  >(null)

  // Fetch the activatable-trades list once on mount. onListManageableTrades is
  // a fresh closure each render, so it is intentionally NOT a dependency.
  useEffect(() => {
    let cancelled = false
    onListManageableTrades()
      .then((r) => {
        if (cancelled) return
        setManageable(r.manageable)
        const own = r.manageable.filter((t) => t.owned).map((t) => t.name)
        setOwned(own)
        setStaged(own)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirty =
    staged.length !== owned.length ||
    staged.some((t) => !owned.includes(t)) ||
    owned.some((t) => !staged.includes(t))

  function labelFor(name: string): string {
    return manageable?.find((m) => m.name === name)?.displayName ?? name
  }

  function toggle(name: string) {
    setError(null)
    setSuccess(null)
    setStaged((cur) => {
      const has = cur.includes(name)
      const next = has ? cur.filter((x) => x !== name) : [...cur, name]
      // Enforce min 1 — refuse the toggle rather than going to empty.
      if (next.length === 0) return cur
      return next
    })
  }

  async function commit(trades: string[]) {
    setBusy(true)
    setError(null)
    setSuccess(null)
    setConfirmRemove(null)
    try {
      const res = await onSaveTrades(trades)
      const parts: string[] = []
      if (res.activated.length > 0)
        parts.push(`Activated ${res.activated.map(labelFor).join(', ')}`)
      if (res.deactivated.length > 0)
        parts.push(`Removed ${res.deactivated.map(labelFor).join(', ')}`)
      if (res.warning) parts.push(res.warning)
      setSuccess(parts.join(' · ') || 'Saved')
      setOwned(trades)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    // Anything being removed is destructive — confirm first.
    const removed = owned.filter((t) => !staged.includes(t))
    if (removed.length > 0) {
      setConfirmRemove({ trades: staged, removedLabels: removed.map(labelFor) })
      return
    }
    await commit(staged)
  }

  return (
    <Card
      title="Trades"
      subtitle="Turn on the trades you quote — painting, solar, commercial painting, electrical and more. Activating seeds that trade's pricing book + catalogue, unlocks its dashboard tools, and refreshes your AI receptionist."
    >
      {loadError && <ErrorBanner>{loadError}</ErrorBanner>}

      {!loadError && manageable === null && (
        <p className="qm-loading text-xs uppercase tracking-[0.08em] text-text-dim">
          Loading trades…
        </p>
      )}

      {manageable && manageable.length === 0 && (
        <p className="text-sm text-text-sec">No activatable trades are available yet.</p>
      )}

      {manageable && manageable.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2 max-w-md">
            {manageable.map((t) => {
              const selected = staged.includes(t.name)
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => toggle(t.name)}
                  disabled={busy}
                  aria-busy={busy}
                  className={`rounded-card px-4 py-3.5 text-sm font-semibold uppercase tracking-wider transition-colors border ${
                    selected
                      ? 'border-accent bg-accent text-white'
                      : 'border-ink-line bg-ink-deep text-text-sec hover:border-accent-soft hover:text-text-pri'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {t.displayName}
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
            <p className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
              Current: {owned.map(labelFor).join(' + ') || '—'}
            </p>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || busy}
              aria-busy={busy}
              className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Saving…' : 'Save trades'}
            </button>
          </div>
        </>
      )}

      {confirmRemove && (
        <ConfirmRemoveTrade
          removedLabels={confirmRemove.removedLabels}
          busy={busy}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => commit(confirmRemove.trades)}
        />
      )}
    </Card>
  )
}

function ConfirmRemoveTrade({
  removedLabels,
  busy,
  onCancel,
  onConfirm,
}: {
  removedLabels: string[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const list = removedLabels.join(' and ')
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="qm-overlay fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/80 backdrop-blur-sm px-4"
    >
      {/* Scrim fades, panel scales up from 0.96 — never from 0, because
          nothing in the real world appears out of a zero-size point. Origin
          stays centre: a modal is not anchored to a trigger. */}
      <div className="qm-panel rounded-card w-full max-w-md bg-ink-card border border-ink-line p-6 space-y-4">
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
            aria-busy={busy}
            className="text-sm font-semibold uppercase tracking-wider text-text-sec hover:text-text-pri px-4 py-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            {busy ? 'Removing…' : `Remove ${list}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Activate-a-new-trade card (Account tab, spec §10) ───────────
//
// Lists loader-created trades the tradie can switch on. Activating one
// runs the atomic server-side activation (pricing_book seeded from
// trade_pricing_defaults + service offerings + Vapi prompt refresh).
// Separate from <TradesCard> — that one is the v1 electrical/plumbing
// toggle; this one handles trades-as-data trades and never removes.

function ActivateTradeCard({
  onListAvailableTrades,
  onActivateTrade,
}: {
  onListAvailableTrades: () => Promise<{
    ok: true
    available: Array<{ name: string; displayName: string }>
  }>
  onActivateTrade: (
    trade: string,
  ) => Promise<{ ok: true; trade: string; warning?: string }>
}) {
  const [available, setAvailable] = useState<
    Array<{ name: string; displayName: string }> | null
  >(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyTrade, setBusyTrade] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Fetch the available-trades list once on mount. onListAvailableTrades
  // is a fresh closure each parent render, so it is intentionally NOT a
  // dependency — that would re-fetch on every dashboard re-render.
  useEffect(() => {
    let cancelled = false
    onListAvailableTrades()
      .then((r) => {
        if (!cancelled) setAvailable(r.available)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function activate(trade: { name: string; displayName: string }) {
    const ok = window.confirm(
      `Turn on ${trade.displayName}? This adds it to your account, seeds your pricing book and catalogue, and refreshes your AI receptionist. You can fine-tune which ${trade.displayName.toLowerCase()} services you offer afterwards.`,
    )
    if (!ok) return
    setBusyTrade(trade.name)
    setError(null)
    setSuccess(null)
    try {
      const res = await onActivateTrade(trade.name)
      setSuccess(
        res.warning
          ? `${trade.displayName} is on. ${res.warning}`
          : `${trade.displayName} is on — pricing book seeded and catalogue ready. Turn on the services you offer in the Services tab.`,
      )
      // Drop the just-activated trade from the list (the dashboard
      // refetch will also reconcile, but this keeps the UI immediate).
      setAvailable((cur) => (cur ?? []).filter((t) => t.name !== trade.name))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyTrade(null)
    }
  }

  return (
    <Card
      title="Add a specialist trade"
      subtitle="Switch on a trade QuoteMax now supports. Activating seeds your pricing book and catalogue automatically — nothing else to set up."
    >
      {loadError && <ErrorBanner>{loadError}</ErrorBanner>}

      {!loadError && available === null && (
        <p className="qm-loading text-xs uppercase tracking-[0.08em] text-text-dim">
          Loading available trades…
        </p>
      )}

      {!loadError && available !== null && available.length === 0 && (
        <p className="text-sm text-text-sec">
          No additional trades are available right now. New trades appear
          here as soon as QuoteMax adds them.
        </p>
      )}

      {available !== null && available.length > 0 && (
        <div className="space-y-2">
          {available.map((t) => (
            <div
              key={t.name}
              className="rounded-card flex items-center justify-between gap-4 border border-ink-line bg-ink-deep px-4 py-3"
            >
              <span className="text-sm font-semibold uppercase tracking-wider text-text-pri">
                {t.displayName}
              </span>
              <button
                type="button"
                onClick={() => activate(t)}
                disabled={busyTrade !== null}
                className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-5 py-2.5 text-xs uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busyTrade === t.name ? 'Activating…' : 'Activate'}
              </button>
            </div>
          ))}
        </div>
      )}

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
    </Card>
  )
}

// ─── Pricing tab ──────────────────────────────────────────────────

function PricingTab({
  data,
  onSave,
  accessToken,
  tradeFilter,
  sharedOnly,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  accessToken: string | null
  /** Render only this trade's rate card + tier options (trade-hub mode).
   *  Tenant-wide cards (early-bird, display, review, follow-up,
   *  calibration) are hidden — they live on the General pricing tab. */
  tradeFilter?: TradeHubSlug
  /** Render only the tenant-wide cards (General pricing tab mode).
   *  Per-trade rate cards are hidden — they live in the trade hubs —
   *  except books whose trade has no hub, which stay here so no rate
   *  card ever becomes unreachable. */
  sharedOnly?: boolean
}) {
  // Multi-trade tenants get one PricingBookCard per trade. Single-trade
  // tenants get exactly one card — same component, no special UI.
  const books = data.pricing_books?.length
    ? data.pricing_books
    : data.pricing
      ? [data.pricing as PricingBook]
      : []

  const tenantTrades = tenantTradeList(data.tenant)

  // A trade-less legacy book (the data.pricing fallback carries no trade
  // column) belongs to the tenant's only trade when there is exactly one,
  // so its hub still shows a rate card.
  const bookTrade = (book: PricingBook): string | null => {
    if (typeof book.trade === 'string' && book.trade) return book.trade.toLowerCase()
    if (tenantTrades.length === 1) return tenantTrades[0]?.toLowerCase() ?? null
    return null
  }
  // "Claimed" means a hub tab actually exists for this tenant — the slug
  // must be one THIS tenant has enabled, not merely a known hub slug.
  // A book whose trade lost its slug (e.g. a deactivation that removed the
  // trade but a transient failure left the book behind) falls back to the
  // General pricing tab instead of becoming unreachable.
  const claimedByHub = (book: PricingBook): boolean => {
    const t = bookTrade(book)
    return (
      t !== null &&
      (TRADE_HUB_SLUGS as readonly string[]).includes(t) &&
      hubEnabled(t as TradeHubSlug, tenantTrades)
    )
  }

  const visibleBooks = tradeFilter
    ? books.filter((b) => bookTrade(b) === tradeFilter)
    : sharedOnly
      ? books.filter((b) => !claimedByHub(b))
      : books

  if (books.length === 0) {
    return (
      <Card>
        <p className="text-sm text-text-sec">
          No pricing book yet — finish activation to generate one.
        </p>
      </Card>
    )
  }

  // Trades that price via a dedicated rate-card editor (roofing/painting by
  // $/m², signage/aircon via their tool panels) never expose the hourly-labour
  // PricingBookCard. Self-serve onboarding (buildPricingRows) and dashboard
  // trade-activation seed a pricing_book row per trade to hold the tier mode +
  // rate-card overlay, but its hourly_rate is INERT for these trades (the
  // roofing/painting estimators price off the rate card, never the $/hr column).
  // Surfacing it as an authoritative "$X/hr" book made new roofing accounts look
  // hourly-priced while seed accounts showed the per-m² Roof Rates card — the
  // reported divergence. The row is still passed to QuoteTierModeCard below,
  // which reads/writes the per-feature tier mode. (pure + unit-tested predicate)
  const showHourlyBook = showsHourlyPricingBook(tradeFilter)

  return (
    <div className="space-y-6">
      {showHourlyBook &&
        visibleBooks.map((book) => (
          <PricingBookCard
            key={book.trade ?? 'default'}
            book={book}
            isMultiTrade={books.length > 1}
            onSave={onSave}
          />
        ))}
      {tradeFilter && visibleBooks.length === 0 && !NO_BOOK_HUB_TRADES.includes(tradeFilter) && (
        <Card>
          <p className="text-sm text-text-sec">
            No hourly-rate pricing book for this trade yet. Tenant-wide
            settings live under General pricing.
          </p>
        </Card>
      )}
      {!sharedOnly && (
        /* Mig 142 — per-feature quote tier presentation mode (single price vs
           Good/Better/Best vs a forced tier). PER-FEATURE: each trade keeps its
           own mode, so in hub mode the card sees only this trade's book (the
           card returns null for non-tier-capable trades like aircon/signage). */
        <QuoteTierModeCard books={visibleBooks} onSave={onSave} />
      )}
      {(!tradeFilter || tradeFilter === 'roofing') && !sharedOnly && (
        /* v10 / Phase 1.5 — per-tenant Roof rates editor. Only rendered when
           'roofing' is in tenants.trades; otherwise the whole card is
           hidden. Writes to pricing_book.overlays.roofing_rate_card; read
           back by /api/roofing/measure before pricing. */
        tenantHasRoofingTrade(tenantTrades) && (
          <RoofRatesEditor accessToken={accessToken} />
        )
      )}
      {(!tradeFilter || tradeFilter === 'painting') && !sharedOnly && (
        /* Per-tenant Paint rates editor. Only rendered when 'painting' is in
           tenants.trades; otherwise hidden. Writes to
           pricing_book.overlays.painting_rate_card; read back by
           /api/painting/estimate before pricing. */
        tenantHasFeature(tenantTrades, 'painting') && (
          <PaintRatesEditor accessToken={accessToken} />
        )
      )}
      {(!tradeFilter || tradeFilter === 'solar') && !sharedOnly && (
        /* Per-tenant Solar rates editor. Writes
           pricing_book.overlays.solar_rate_card; read back by the solar
           estimate / redraft / select-building routes before pricing. */
        tenantHasFeature(tenantTrades, 'solar') && (
          <SolarRatesEditor accessToken={accessToken} />
        )
      )}
      {!tradeFilter && (
        <>
          {/* v8 — early-booking discount. One card per tenant (the offer is
              trade-agnostic, written to every pricing_book row). */}
          <EarlyBirdCard books={books} onSave={onSave} />
          {/* Phase A — customer-quote display preference (itemised vs summary).
              Trade-agnostic, written to every pricing_book row by /api/tenant/me. */}
          <QuoteDisplayCard books={books} onSave={onSave} />
          {/* Mig 078 — tradie review-before-send policy. Sits next to the
              display card because they're the two "how quotes leave the
              system" controls; tradies tend to set them together. */}
          <ReviewPolicyCard books={books} onSave={onSave} />
          {/* Mig 079 — customer 2-hour follow-up check-in. Same scope as the
              other "how quotes leave the system" controls, same UX. */}
          <Followup2hCard books={books} onSave={onSave} />
          {/* A5 — invoice-history calibration. Upload past invoices, see how
              our recipe lines up with what you actually charged, accept a
              suggested hourly-rate adjustment. */}
          <CalibrationCard accessToken={accessToken} />
        </>
      )}
    </div>
  )
}

/**
 * Migration 078 — tradie review-before-send policy.
 *
 * Three policies cover ~95% of real tradie needs:
 *   • auto_send (default) — quotes go straight to the customer
 *   • always_review       — every quote waits for tradie approval
 *   • review_over_threshold — quotes >= $threshold wait; smaller ones send
 *
 * Reads from row 0 (preference is identical across the tenant's trade
 * rows after the /api/tenant/me PATCH fan-out). Saves via PATCH
 * { review_policy, review_threshold_inc_gst }.
 *
 * Mirror of QuoteDisplayCard's shape — same card structure, same save
 * pattern, sibling control on the same Pricing tab.
 */
function ReviewPolicyCard({
  books,
  onSave,
}: {
  books: PricingBook[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  type Policy = 'auto_send' | 'always_review' | 'review_over_threshold'

  const currentPolicy = useMemo<Policy>(() => {
    const v = books[0]?.review_policy
    if (v === 'always_review' || v === 'review_over_threshold') return v
    return 'auto_send'
  }, [books])

  const currentThreshold = useMemo<string>(() => {
    const raw = books[0]?.review_threshold_inc_gst
    const n = typeof raw === 'string' ? parseFloat(raw) : raw
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return String(n)
    return '500' // sensible default — most tradies want $500-ish
  }, [books])

  const [policy, setPolicy] = useState<Policy>(currentPolicy)
  const [threshold, setThreshold] = useState<string>(currentThreshold)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = { review_policy: policy }
      // Only send the threshold when it's actually used. Avoids
      // overwriting a stored value with whatever's in the field when
      // the tradie picks auto_send or always_review.
      if (policy === 'review_over_threshold') {
        const n = parseFloat(threshold)
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('Enter a dollar threshold above $0.')
        }
        payload.review_threshold_inc_gst = n
      }
      await onSave(payload)
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (books.length === 0) return null

  const dirty =
    policy !== currentPolicy ||
    (policy === 'review_over_threshold' && threshold !== currentThreshold)

  return (
    <Card
      title="Review before send"
      subtitle="How quotes leave your QuoteMax number after the AI drafts them. Default is auto-send so the customer never waits on you."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Policy">
          <div className="mt-2 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="review_policy"
                value="auto_send"
                checked={policy === 'auto_send'}
                onChange={() => setPolicy('auto_send')}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm">
                <span className="font-semibold text-text-pri">Auto-send (default)</span>
                <span className="block text-xs text-text-dim mt-0.5">
                  Quotes go straight to the customer; you get a notify SMS after. Fastest — current behaviour.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="review_policy"
                value="always_review"
                checked={policy === 'always_review'}
                onChange={() => setPolicy('always_review')}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm">
                <span className="font-semibold text-text-pri">Always review first</span>
                <span className="block text-xs text-text-dim mt-0.5">
                  Hold every quote for your approval before the customer sees it. You get a one-tap "Send to customer" link.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="review_policy"
                value="review_over_threshold"
                checked={policy === 'review_over_threshold'}
                onChange={() => setPolicy('review_over_threshold')}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm flex-1">
                <span className="font-semibold text-text-pri">Review only if over $</span>
                <input
                  type="number"
                  min="1"
                  step="50"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  onFocus={() => setPolicy('review_over_threshold')}
                  disabled={policy !== 'review_over_threshold'}
                  className="ml-1 w-20 px-2 py-0.5 bg-ink-deep border border-ink-line text-text-pri text-sm font-mono disabled:opacity-50"
                  aria-label="Review threshold in dollars inc-GST"
                />
                <span className="block text-xs text-text-dim mt-0.5">
                  Small jobs auto-send; bigger jobs wait for you. Threshold is inc-GST.
                </span>
              </span>
            </label>
          </div>
        </Field>

        {error ? (
          <div className="bg-warning/10 border border-warning/40 px-3 py-2 text-xs text-warning">
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !dirty}
            aria-busy={submitting}
            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2 border border-accent text-accent hover:bg-accent/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save policy'}
          </button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-accent">
              ✓ Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

/**
 * Migration 079 — customer 2-hour follow-up check-in.
 *
 * When ON: any quote sent to a customer that hasn't been replied to
 * within 2 hours receives ONE automated friendly check-in SMS. Per-quote
 * keyed (a customer with 5 quotes gets 5 separate check-ins). Driven by
 * /api/cron/followup-2h (every 15 minutes).
 *
 * Reads from row 0 (the flag is fanned out identically across the
 * tenant's pricing_book rows by /api/tenant/me PATCH). Saves via
 * PATCH { followup_2h_enabled: boolean }. Default OFF so existing
 * tradies opt in deliberately.
 */
function Followup2hCard({
  books,
  onSave,
}: {
  books: PricingBook[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const current = useMemo<boolean>(() => {
    return Boolean(books[0]?.followup_2h_enabled)
  }, [books])

  const [enabled, setEnabled] = useState<boolean>(current)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await onSave({ followup_2h_enabled: enabled })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (books.length === 0) return null
  const dirty = enabled !== current

  return (
    <Card
      title="2-hour follow-up check-in"
      subtitle="Auto-send a friendly 'just checking in' SMS to customers who haven't replied within 2 hours of receiving their quote."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Auto check-in">
          <label className="inline-flex items-start gap-3 cursor-pointer mt-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-5 w-5 accent-accent"
            />
            <span className="text-sm">
              <span className="font-semibold text-text-pri">
                Send a 2-hour check-in SMS automatically
              </span>
              <span className="block text-xs text-text-dim mt-0.5">
                One nudge per quote, only if the customer hasn't replied.
                Won't fire for inspection-route quotes or quotes already booked/paid.
                If the same person has 5 quotes, they get 5 separate check-ins.
              </span>
            </span>
          </label>
        </Field>

        {error ? (
          <div className="bg-warning/10 border border-warning/40 px-3 py-2 text-xs text-warning">
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !dirty}
            aria-busy={submitting}
            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2 border border-accent text-accent hover:bg-accent/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-accent">
              ✓ Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

/**
 * Migration 142 — per-feature quote tier presentation mode.
 *
 * Controls HOW MANY price options the customer sees, per feature:
 *   • Single price (recommended option) — DEFAULT
 *   • Good / Better / Best — the full three-tier layout
 *   • Good only / Better only / Best only — force one tier
 *
 * Unlike the layout + review cards (fanned out to every pricing_book row),
 * this is PER-FEATURE (per-trade): a tradie can run three-tier painting and
 * single-price solar at once. Renders one selector per tier-capable feature
 * the tenant has. Saves via PATCH { quote_tier_mode_by_trade: { trade: mode } },
 * sending only the rows that actually changed.
 *
 * Orthogonal to the layout card (itemised vs summary): "how many options"
 * here, "how much detail per option" there. The two combine freely.
 */
const TIER_MODE_FEATURE_LABELS: Record<string, string> = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  roofing: 'Roofing',
  painting: 'Painting',
  commercial_painting: 'Commercial painting',
  solar: 'Solar',
}

const TIER_MODE_OPTIONS: { value: QuoteTierMode; label: string; hint: string }[] = [
  {
    value: 'single',
    label: 'Single price (recommended option)',
    hint: 'One price only — your recommended option. Cleanest read; no line-by-line tier comparison. (Default.)',
  },
  {
    value: 'good_better_best',
    label: 'Good / Better / Best',
    hint: 'Show all three options side by side so the customer picks their level.',
  },
  { value: 'good', label: 'Good only', hint: 'Show only your Good option, as a single price.' },
  { value: 'better', label: 'Better only', hint: 'Show only your Better option, as a single price.' },
  { value: 'best', label: 'Best only', hint: 'Show only your Best option, as a single price.' },
]

function QuoteTierModeCard({
  books,
  onSave,
}: {
  books: PricingBook[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  // Only tier-capable features get a selector (electrical/plumbing/roofing/
  // painting/commercial_painting/solar). Aircon + signage are excluded — they
  // don't produce a Good/Better/Best quote.
  const features = useMemo(
    () => books.filter((b) => b.trade && TIER_MODE_FEATURE_LABELS[b.trade as string]),
    [books],
  )

  const current = useMemo<Record<string, QuoteTierMode>>(() => {
    const m: Record<string, QuoteTierMode> = {}
    for (const b of features) m[b.trade as string] = asQuoteTierMode(b.quote_tier_mode)
    return m
  }, [features])

  const [modes, setModes] = useState<Record<string, QuoteTierMode>>(current)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const changed: Record<string, QuoteTierMode> = {}
      for (const b of features) {
        const trade = b.trade as string
        if (modes[trade] && modes[trade] !== current[trade]) changed[trade] = modes[trade]
      }
      if (Object.keys(changed).length > 0) {
        await onSave({ quote_tier_mode_by_trade: changed })
      }
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (features.length === 0) return null
  const dirty = features.some((b) => modes[b.trade as string] !== current[b.trade as string])
  const multi = features.length > 1

  return (
    <Card
      title="Quote pricing options"
      subtitle="How many price options the customer sees. Single price shows just your recommended option; Good / Better / Best shows all three. Set it per feature."
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {features.map((b) => {
          const trade = b.trade as string
          const sel = modes[trade] ?? 'single'
          return (
            <Field key={trade} label={multi ? TIER_MODE_FEATURE_LABELS[trade] : 'Pricing options'}>
              <div className="mt-2 space-y-3">
                {TIER_MODE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name={`quote_tier_mode_${trade}`}
                      value={opt.value}
                      checked={sel === opt.value}
                      onChange={() => setModes((m) => ({ ...m, [trade]: opt.value }))}
                      className="mt-1 h-4 w-4 accent-accent"
                    />
                    <span className="text-sm">
                      <span className="font-semibold text-text-pri">{opt.label}</span>
                      <span className="block text-xs text-text-dim mt-0.5">{opt.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          )
        })}

        {error ? (
          <div className="bg-warning/10 border border-warning/40 px-3 py-2 text-xs text-warning">
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !dirty}
            aria-busy={submitting}
            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2 border border-accent text-accent hover:bg-accent/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-accent">
              ✓ Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

/**
 * Phase A — tenant-level quote display preference.
 *
 * Tradies pick ONE preference (itemised line-item table OR rolled-up
 * summary paragraph) and it applies to every quote going out from then
 * on. Reads from row 0 (preference is identical across the tenant's
 * trade rows after the /api/tenant/me PATCH fan-out). Saves via
 * PATCH { quote_display: 'itemised' | 'summary' }.
 *
 * Phase B will add a per-quote override on the quote-detail page; this
 * card sets the DEFAULT every new quote inherits.
 */
function QuoteDisplayCard({
  books,
  onSave,
}: {
  books: PricingBook[]
  onSave: (payload: Record<string, unknown>) => Promise<void>
}) {
  const current = useMemo<'itemised' | 'summary'>(() => {
    const v = books[0]?.quote_display
    return v === 'summary' ? 'summary' : 'itemised'
  }, [books])

  const [mode, setMode] = useState<'itemised' | 'summary'>(current)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await onSave({ quote_display: mode })
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
      title="Customer quote layout"
      subtitle="How the customer sees your quote on the share link + in the SMS. Itemised shows every line; summary rolls it into a lump sum + scope blurb."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Layout">
          <div className="mt-2 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="quote_display"
                value="itemised"
                checked={mode === 'itemised'}
                onChange={() => setMode('itemised')}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm">
                <span className="font-semibold text-text-pri">Itemised</span>
                <span className="block text-xs text-text-dim mt-0.5">
                  Per-line breakdown — material, labour hours, sundries. Maximises perceived transparency. (Default.)
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="quote_display"
                value="summary"
                checked={mode === 'summary'}
                onChange={() => setMode('summary')}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <span className="text-sm">
                <span className="font-semibold text-text-pri">Summary</span>
                <span className="block text-xs text-text-dim mt-0.5">
                  Single scope paragraph + total. Clean lump-sum read; the customer still sees a rough hours/items hint.
                </span>
              </span>
            </label>
          </div>
        </Field>

        {error ? (
          <div className="bg-warning/10 border border-warning/40 px-3 py-2 text-xs text-warning">
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || mode === current}
            aria-busy={submitting}
            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2 border border-accent text-accent hover:bg-accent/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save layout'}
          </button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-accent">
              ✓ Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}

// A5 — Invoice-history calibration card.
//
// Lets a tradie upload past invoice images, sees the structured Gemini
// extraction, and reviews a calibration suggestion that backsolves a
// systematic gap between their historical pricing and our recipe-derived
// prediction. Accept buttons are hidden when trust='reject' so the UI
// can never push a suggestion outside the trust gates.
type CalibrationApiUpload = {
  id: string
  status: 'uploaded' | 'extracting' | 'extracted' | 'failed'
  mime_type: string | null
  error: string | null
  created_at: string
  updated_at: string
}
type CalibrationApiExtraction = {
  id: string
  upload_id: string
  scope_description: string | null
  total_inc_gst: number | string | null
  job_type_guess: string | null
  quantity: number | string | null
  customer_name: string | null
  customer_suburb: string | null
  invoice_date: string | null
  created_at: string
}
type CalibrationApiSuggestion = {
  id: string
  trade: string
  field: 'hourly_rate'
  current_value: number | string
  suggested_value: number | string
  delta: number | string
  delta_pct: number | string
  trust: 'high' | 'medium' | 'low' | 'reject'
  reject_reason: string | null
  reason: string
  invoices_used: number
  diff_pct_min: number | string | null
  diff_pct_max: number | string | null
  diff_pct_median: number | string | null
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  accepted_at: string | null
  rejected_at: string | null
  created_at: string
}
type CalibrationApiReport = {
  invoices_total: number
  invoices_matched: number
  invoices_skipped: number
  skip_breakdown: Record<string, number>
  suggestions: Array<{
    field: 'hourly_rate'
    current_value: number
    suggested_value: number
    delta: number
    delta_pct: number
    reason: string
    trust: 'high' | 'medium' | 'low' | 'reject'
    reject_reason?: string
    invoices_used: number
    diff_pct_min: number
    diff_pct_max: number
    diff_pct_median: number
  }>
}
type CalibrationApiResponse = {
  ok: boolean
  trades_active: string[]
  uploads: CalibrationApiUpload[]
  extractions: CalibrationApiExtraction[]
  suggestions: CalibrationApiSuggestion[]
  reports: Record<string, CalibrationApiReport>
}

function CalibrationCard({ accessToken }: { accessToken: string | null }) {
  const [report, setReport] = useState<CalibrationApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const { getToken, isSignedIn } = useAuth()

  // Clerk session tokens are short-lived (~60s). The dashboard captures ONE
  // token at mount and threads it down as `accessToken`; by the time a tradie
  // clicks into General pricing that token has usually expired, so the
  // calibration API 401s ("couldn't load calibration: unauthorized"). Mint a
  // FRESH token immediately before every request — getToken() refreshes under
  // the hood — falling back to the prop for legacy Supabase-session users.
  //
  // Held in a ref so freshToken() is a STABLE callback (empty deps): the load
  // effect below then fires exactly once, instead of re-running every time
  // Clerk hands back a new getToken identity.
  const authRef = useRef({ getToken, isSignedIn, accessToken })
  authRef.current = { getToken, isSignedIn, accessToken }
  const freshToken = useCallback(async (): Promise<string | null> => {
    const a = authRef.current
    if (a.isSignedIn) {
      const t = await a.getToken().catch(() => null)
      if (t) return t
    }
    return a.accessToken
  }, [])

  const load = useCallback(async () => {
    const token = await freshToken()
    if (!token) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/tenant/calibration', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as CalibrationApiResponse
      setReport(json)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [freshToken])

  useEffect(() => {
    void load()
  }, [load])

  async function onFile(file: File) {
    const token = await freshToken()
    if (!token) {
      setMsg('Not signed in — reload the page and try again.')
      return
    }
    if (!/^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(file.type)) {
      setMsg('Only JPG, PNG, WEBP, HEIC or PDF invoices are accepted.')
      return
    }
    // Guard the base64/JSON upload path against the platform request-body
    // limit (Vercel caps function request bodies at ~4.5 MB). Base64 inflates
    // bytes by ~33%, so cap the raw file at 3 MB → ~4 MB on the wire. Most
    // single-page invoice PDFs and photos sit well under this.
    const MAX_BYTES = 3 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setMsg('File too large (max 3 MB). Screenshot the invoice or export a smaller PDF.')
      return
    }
    setUploading(true)
    setMsg(null)
    try {
      // Read file → base64 (no data: prefix; strip the header). Identical for
      // PDF bytes and image bytes — Gemini reads the document natively.
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      const base64 = typeof btoa === 'function' ? btoa(bin) : ''
      const res = await fetch('/api/tenant/calibration/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image_base64: base64, mime_type: file.type }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        message?: string
      }
      if (!res.ok || !json.ok) {
        setMsg(json.message || json.error || `HTTP ${res.status}`)
      } else {
        setMsg(`Invoice extracted — refreshing…`)
        await load()
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function actOnSuggestion(trade: string, accept: boolean) {
    const token = await freshToken()
    if (!token) return
    setBusyAction(trade)
    setMsg(null)
    try {
      const res = await fetch('/api/tenant/calibration/accept', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trade, accept }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        action?: 'accepted' | 'rejected'
        error?: string
        message?: string
        new_hourly_rate?: number
      }
      if (!res.ok || !json.ok) {
        setMsg(json.message || json.error || `HTTP ${res.status}`)
      } else if (json.action === 'accepted') {
        setMsg(`Hourly rate updated to $${json.new_hourly_rate}. Reload to see across the page.`)
        await load()
      } else {
        setMsg('Suggestion noted as rejected.')
        await load()
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <Card title="Calibrate from invoices">
      <p className="text-xs text-text-dim leading-snug max-w-2xl mb-4">
        Upload past invoices. We&apos;ll compare what you historically charged
        to what our recipe predicts, and suggest hourly-rate adjustments
        when the gap is consistent. Suggestions are never applied
        automatically — you always click Accept.
      </p>

      <div className="rounded-card mb-4 border border-dashed border-ink-line bg-ink-card p-4">
        <label className="block">
          <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim block mb-2">
            Upload invoice (JPG / PNG / WEBP / HEIC / PDF)
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,.pdf"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
            className="text-sm text-text-pri file:mr-3 file:py-2 file:px-3 file:border file:border-accent/50 file:text-accent file:bg-transparent file:text-[0.65rem] file:uppercase file:tracking-[0.08em] file:font-bold file:cursor-pointer hover:file:bg-accent/10"
          />
        </label>
        {uploading && (
          <p className="mt-2 text-xs text-text-dim">Extracting via Gemini vision…</p>
        )}
        {msg && (
          <p className="mt-2 text-[0.65rem] uppercase tracking-[0.08em] text-accent">
            {msg}
          </p>
        )}
      </div>

      {loading && (
        <p className="qm-loading text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
          Loading calibration report…
        </p>
      )}
      {err && (
        <p className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning">
          Couldn&apos;t load calibration: {err}
        </p>
      )}
      {report && Object.keys(report.reports).length === 0 && (
        <p className="text-xs text-text-dim">
          No trades active — activate a trade on the Account tab first.
        </p>
      )}
      {report && (
        <div className="space-y-4">
          {Object.entries(report.reports).map(([trade, r]) => {
            const tradeLabel = trade.charAt(0).toUpperCase() + trade.slice(1)
            const s = r.suggestions[0]
            return (
              <div key={trade} className="rounded-card border border-ink-line bg-ink-card">
                <div className="px-4 py-3 border-b border-ink-line flex items-baseline justify-between flex-wrap gap-2">
                  <h4 className="font-semibold text-text-pri">{tradeLabel}</h4>
                  <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                    {r.invoices_matched} matched · {r.invoices_skipped} skipped · {r.invoices_total} total
                  </span>
                </div>
                <div className="p-4 text-sm">
                  {!s && (
                    <p className="text-text-dim text-xs">
                      No calibration suggestion yet. Upload more invoices for this trade.
                    </p>
                  )}
                  {s && (
                    <>
                      <p className="text-text-pri text-sm">{s.reason}</p>
                      <div className="mt-3 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
                        Range: {s.diff_pct_min.toFixed(1)}% to {s.diff_pct_max.toFixed(1)}% (median {s.diff_pct_median.toFixed(1)}%) · invoices_used={s.invoices_used} · trust={s.trust}
                      </div>
                      {s.trust === 'reject' ? (
                        <p className="mt-3 text-[0.65rem] uppercase tracking-[0.08em] text-warning">
                          Rejected by trust gate: {s.reject_reason}
                        </p>
                      ) : (
                        <div className="mt-4 flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            disabled={busyAction === trade}
                            onClick={() => void actOnSuggestion(trade, true)}
                            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            {busyAction === trade ? 'Applying…' : `Accept · raise hourly to $${s.suggested_value}`}
                          </button>
                          <button
                            type="button"
                            disabled={busyAction === trade}
                            onClick={() => void actOnSuggestion(trade, false)}
                            className=" text-[0.7rem] uppercase tracking-[0.08em] px-3 py-2 border border-ink-line text-text-dim hover:text-text-pri hover:border-text-dim transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {report.uploads.length > 0 && (
            <details className="rounded-card border border-ink-line bg-ink-card">
              <summary className="px-4 py-3 cursor-pointer text-[0.65rem] uppercase tracking-[0.08em] text-text-dim hover:text-text-pri">
                ▸ Uploaded invoices ({report.uploads.length})
              </summary>
              <ul className="divide-y divide-ink-line">
                {report.uploads.map((u) => (
                  <li key={u.id} className="px-4 py-2 flex items-center justify-between text-xs">
                    <span className="font-mono text-[0.65rem] text-text-pri">
                      {u.id.slice(0, 8)}…
                    </span>
                    <span
                      className={` text-[0.6rem] uppercase tracking-[0.08em] ${
 u.status === 'extracted'
 ? 'text-accent'
 : u.status === 'failed'
 ? 'text-warning'
 : 'text-text-dim'
 }`}
                    >
                      {u.status}
                      {u.error ? ` · ${u.error.slice(0, 60)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
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
            aria-busy={submitting}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
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

  // UI hint only — real floor is enforced in lib/estimate/min-labour.ts.
  const hourlyNum = parseFloat(form.hourly_rate)
  const minHoursNum = parseFloat(form.min_labour_hours)
  const showDerivedMinLabour =
    Number.isFinite(hourlyNum) && hourlyNum > 0 &&
    Number.isFinite(minHoursNum) && minHoursNum > 0
  const minLabourDollars = showDerivedMinLabour ? Math.round(hourlyNum * minHoursNum) : null
  const hourlyRateRounded = showDerivedMinLabour ? Math.round(hourlyNum) : null

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
          <Field label="Min labour hours" hint="hrs per job">
            <input
              type="number"
              step="0.5"
              min="0"
              max="8"
              value={form.min_labour_hours}
              onChange={(e) => setForm({ ...form, min_labour_hours: e.target.value })}
              className={INPUT}
            />
            {minLabourDollars != null && (
              <div className="mt-1.5 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
                ≈ ${minLabourDollars} min labour at ${hourlyRateRounded}/hr
              </div>
            )}
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
          className="text-sm uppercase tracking-[0.08em] text-text-sec hover:text-text-pri"
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
            <Field label="Callout minimum" hint="$AUD ex GST">
              <input
                type="number"
                step="0.01"
                min="0"
                aria-label="Callout minimum"
                value={form.call_out_minimum}
                onChange={(e) => setForm({ ...form, call_out_minimum: e.target.value })}
                className={INPUT}
              />
              <div className="mt-1.5 text-xs text-text-dim leading-snug">
                {book.trade === 'electrical'
                  ? 'Used only for fault-finding callouts. To set a minimum job size, raise Min labour hours.'
                  : 'Added as a separate line on jobs under $800. To set a minimum job size, raise Min labour hours.'}
              </div>
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
            aria-busy={submitting}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-50"
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
  tradeFilter,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onCreateCustom: (payload: Record<string, unknown>) => Promise<unknown>
  onUpdateCustom: (id: string, payload: Record<string, unknown>) => Promise<unknown>
  onDeleteCustom: (id: string) => Promise<void>
  /** Trade-hub mode: scope the service list, counts, brand preferences,
   *  and the custom-service form to one trade. Unset = all trades
   *  (legacy cross-trade view, kept for deep links). */
  tradeFilter?: TradeHubSlug
}) {
  // R36 — optimistic per-row override map (assembly_id → flipped value). Keyed
  // per row so two overlapping toggles never share state. See lib/dashboard/
  // service-toggle.ts for the pure reconcile logic this wires to.
  const [pending, setPending] = useState<PendingMap>({})
  // R36 — per-ROW in-flight set, not a single global flag. The old global
  // `busy` dropped a second click while ANY save was in flight, so a quick
  // toggle of a DIFFERENT row was silently swallowed. We now only guard the
  // SAME row from a double-fire; unrelated rows toggle concurrently.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // When non-null → the inline create/edit form is visible. `null` =
  // hidden; `{}` = empty (creating); `{id, ...row}` = editing.
  const [formState, setFormState] = useState<EditingService | null>(null)
  // Expansion state per assembly_id. We keep a Set rather than a Map<bool>
  // so a row's row is either present (expanded) or absent (collapsed) — no
  // stale `false` entries to clean up.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Free-text search across the (often long) service list so a tradie
  // can jump to a job by name instead of scrolling every trade group.
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  // Reset to the first page whenever a search narrows the list.
  useEffect(() => {
    setPage(0)
  }, [query])

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
  // Any row currently saving — used only to gate the legacy "Save all"
  // fallback button. Individual rows guard themselves via busyIds so
  // unrelated rows stay independently toggleable.
  const busy = busyIds.size > 0

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // R36 — persist EVERY toggle immediately as a PER-SERVICE DELTA (never the
  // whole services dict). Sending `{ service_delta: { assembly_id, enabled } }`
  // means the route upserts ONLY this row, so two overlapping toggles (two
  // quick clicks, or two open tabs) can't clobber each other: settling row A
  // never touches row B's in-flight optimistic value. The pure flip/payload/
  // reconcile logic lives in lib/dashboard/service-toggle.ts so it's unit-
  // tested in isolation (overlapping-toggle case included).
  async function toggle(assemblyId: string) {
    if (busyIds.has(assemblyId)) return // ignore double-fire of the SAME row only
    const svc = data.services.find((s) => s.assembly_id === assemblyId)
    if (!svc) return
    const nextVal = nextEnabledFor(pending, svc)
    // Optimistic flip — preserves every OTHER row's pending entry.
    setPending((p) => applyOptimistic(p, assemblyId, nextVal))
    setError(null)
    markBusy(assemblyId, true)
    try {
      // The route accepts a single-entry service_delta and routes shared vs
      // custom via is_custom — one code path, one targeted upsert.
      await onSave(buildServiceTogglePayload(svc, nextVal)) // PATCH → re-fetch
      // Success: drop ONLY this row's optimistic entry. onSave re-fetched the
      // authoritative data, so the switch now reflects the saved state; other
      // rows' pending entries are left intact.
      setPending((p) => reconcilePending(p, assemblyId))
      setSavedAt(Date.now())
    } catch (e: any) {
      // Failure: revert ONLY this row (drop its pending entry → reverts to the
      // last server value). Concurrent rows are untouched.
      setPending((p) => reconcilePending(p, assemblyId))
      setError(e?.message ?? 'Save failed')
    } finally {
      markBusy(assemblyId, false)
    }
  }

  // Legacy fallback — flush any rows still pending (e.g. a failed write the
  // tradie wants to retry) as one batched delta array. Each entry still names
  // exactly one row, so the anti-clobber guarantee holds for the batch too.
  async function saveAll() {
    const entries = Object.entries(pending).map(([id, enabled]) => {
      const svc = data.services.find((s) => s.assembly_id === id)
      return { assembly_id: id, enabled, is_custom: !!svc?.is_custom }
    })
    if (entries.length === 0) return // nothing pending — don't send {}
    setError(null)
    entries.forEach((e) => markBusy(e.assembly_id, true))
    try {
      await onSave({ service_delta: entries })
      setPending({})
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setBusyIds(new Set())
    }
  }

  // Trade-hub mode: scope the list (and every count) to one trade before
  // search + pagination so page counts and "N of M on" stay truthful.
  const visibleServices = tradeFilter
    ? data.services.filter((s) => (s.trade ?? '').toLowerCase() === tradeFilter)
    : data.services

  const enabledCount = visibleServices.filter((s) => {
    const live = pending[s.assembly_id] !== undefined ? pending[s.assembly_id] : s.enabled
    return live
  }).length
  const totalCount = visibleServices.length

  // Multi-trade tenants see services grouped by trade so the dashboard
  // makes it obvious which catalogue half each row belongs to. Single-
  // trade tenants — and trade-hub mode — get the original flat list
  // (no group header; the hub's own header already names the trade).
  const tenantTrades = tradeFilter
    ? [tradeFilter]
    : Array.isArray(data.tenant.trades) && data.tenant.trades.length > 0
      ? data.tenant.trades
      : data.tenant.trade
        ? [data.tenant.trade]
        : []
  const showGrouped = tenantTrades.length > 1
  const q = query.trim().toLowerCase()
  const searchedServices = q
    ? visibleServices.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q),
      )
    : visibleServices
  // Paginate at 10 — the grouping below runs on the page slice so a
  // long catalogue never grows the page past one screen of rows.
  const SVC_PAGE_SIZE = 10
  const svcPageCount = Math.max(
    1,
    Math.ceil(searchedServices.length / SVC_PAGE_SIZE),
  )
  const svcPage = Math.min(page, svcPageCount - 1)
  const pagedServices = searchedServices.slice(
    svcPage * SVC_PAGE_SIZE,
    svcPage * SVC_PAGE_SIZE + SVC_PAGE_SIZE,
  )
  const groupedServices: Array<{ trade: string; rows: typeof data.services }> = showGrouped
    ? tenantTrades.map((t) => ({
        trade: t,
        rows: pagedServices.filter((s) => s.trade === t),
      }))
    : [{ trade: tenantTrades[0] ?? '', rows: pagedServices }]

  return (
    <div className="space-y-6">
      {/* v7 Phase 1 banner — Jon's "everything is pre-populated, toggle on/off"
         framing made explicit. Informational, not dismissible; hidden when
         the (possibly trade-scoped) list is empty so it can't claim a
         catalogue is loaded when nothing is. */}
      {visibleServices.length > 0 && (
      <div className="rounded-ctl border border-accent/30 bg-ink-card/60 px-4 py-3">
        <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent mb-1">
          Catalogue · pre-populated
        </div>
        <div className="text-sm text-text-sec">
          Every standard service for <span className="font-mono">{tenantTrades.join(' + ') || '—'}</span>{' '}
          is loaded for you, with the easy-5 pre-ticked. Untick anything you don&rsquo;t do —
          customers can still book it as a $99 inspection, your AI just won&rsquo;t auto-draft a price.
        </div>
      </div>
      )}

      <Card
        title="Auto-quote services"
        subtitle={`Tick the work your AI can auto-quote. Unticked services still get inspections — they just won't auto-draft a price. ${enabledCount} of ${totalCount} enabled.`}
      >
        {/* Top-of-card actions — add a custom service. The form below
            handles both create and edit; opening it from here defaults
            to create-mode (no existing row pre-filled). */}
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
            {visibleServices.filter((s) => s.is_custom).length} custom service
            {visibleServices.filter((s) => s.is_custom).length === 1 ? '' : 's'} ·{' '}
            {visibleServices.filter((s) => !s.is_custom).length} catalogue
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
            className="rounded-ctl inline-flex items-center gap-2 border border-accent/60 text-accent hover:bg-accent/10 font-bold uppercase tracking-[0.08em] text-[0.7rem] px-3.5 py-2 transition-colors"
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

        {/* Search — filters across every trade group so a long
            catalogue is one keystroke from the row you want. */}
        {visibleServices.length > 0 && (
          <div className="relative mb-4 sm:max-w-xs">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search services by name…"
              aria-label="Search services"
              className="rounded-ctl w-full bg-ink-deep border border-ink-line pl-10 pr-3 py-2.5 text-sm text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors"
            />
          </div>
        )}

        <div className="space-y-2">
          {visibleServices.length === 0 ? (
            <div className="bg-warning/15 border border-warning-bright/50 px-4 py-3">
              <p className="text-sm text-warning-bright">
                No services found in the catalogue for{' '}
                <span className="font-mono">{tenantTrades.join(', ') || '—'}</span>.
                {tradeFilter ? (
                  <> This trade has no shared catalogue yet — its pricing lives in the trade&rsquo;s tool settings.</>
                ) : (
                  <> This usually means the seed data hasn&rsquo;t loaded — check the
                  Supabase <span className="font-mono">shared_assemblies</span> table.</>
                )}
              </p>
            </div>
          ) : searchedServices.length === 0 ? (
            <p className="py-2 text-sm text-text-dim">
              No services match “{query.trim()}”.
            </p>
          ) : (
            groupedServices
              .filter((g) => g.rows.length > 0)
              .map(({ trade: groupTrade, rows }) => (
              <div key={groupTrade || 'all'} className="space-y-2">
                {showGrouped && (
                  <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pt-3 pb-1">
                    {tradeLabel(groupTrade as 'electrical' | 'plumbing')}
                  </div>
                )}
                {rows.map((svc) => {
              const live =
                pending[svc.assembly_id] !== undefined
                  ? pending[svc.assembly_id]
                  : svc.enabled
              // R40 — cross-table name-collision view-model. Drives the
              // disambiguation badge so a disabled shared service and a
              // same-named custom service read differently.
              const cv = collisionView({
                assembly_id: svc.assembly_id,
                name: svc.name,
                trade: svc.trade,
                is_custom: svc.is_custom,
                name_collision: svc.name_collision ?? false,
              })
              const rowBusy = busyIds.has(svc.assembly_id)
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
                  className={`rounded-card border transition-colors ${
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
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className={`shrink-0 transition-transform duration-200 ${
                            isOpen ? 'rotate-90 text-accent' : 'text-text-dim'
                          }`}
                        >
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                        <span
                          className={`font-semibold text-sm ${
                            live ? 'text-text-pri' : 'text-text-sec'
                          }`}
                        >
                          {svc.name}
                        </span>
                        {/* R40 — name-collision disambiguation. When a custom
                            service and a shared service share a name in the same
                            trade, BOTH rows carry a source tag so the list is
                            never ambiguous. Custom rows get an accent tag,
                            catalogue rows a neutral one. */}
                        {cv.collides && cv.tag && (
                          <span
                            className={` text-[0.55rem] uppercase tracking-[0.08em] px-2 py-0.5 border shrink-0 ${
 cv.source === 'custom'
 ? 'border-accent/50 text-accent'
 : 'border-ink-line text-text-dim'
 }`}
                            title={cv.hint ?? undefined}
                          >
                            {cv.tag}
                          </span>
                        )}
                        {isPending && (
                          <span
                            className=" text-[0.55rem] uppercase tracking-[0.08em] text-accent shrink-0"
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
                      <div className="ml-5 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
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
                            className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-0.5 border border-ink-line text-text-dim"
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
                      aria-busy={rowBusy}
                      aria-label={`${svc.name} — ${live ? 'enabled, click to turn off' : 'disabled, click to turn on'}`}
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(svc.assembly_id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          toggle(svc.assembly_id)
                        }
                      }}
                      className="shrink-0 inline-flex items-center gap-2.5 cursor-pointer group select-none"
                    >
                      <span
                        className={`rounded-card relative inline-block h-5 w-10 border transition-colors ${
                          live
                            ? 'border-accent bg-accent/20'
                            : 'border-ink-line bg-ink group-hover:border-text-dim'
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
                        className={` text-[0.65rem] uppercase tracking-[0.08em] font-bold transition-colors w-7 ${
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
                    <div className="border-t border-ink-line/70 px-4 py-4 ml-5 mr-4 bg-ink/30 space-y-4 text-xs">
                      {svc.description && (
                        <div>
                          <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim mb-1">
                            What&rsquo;s included
                          </div>
                          <p className="text-sm text-text-sec leading-relaxed">
                            {svc.description}
                          </p>
                        </div>
                      )}

                      {svc.default_exclusions && (
                        <div>
                          <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-warning mb-1">
                            Excludes
                          </div>
                          <p className="text-sm text-text-sec leading-relaxed">
                            {svc.default_exclusions}
                          </p>
                        </div>
                      )}

                      {(price !== null || labourCost !== null) && (
                        <div>
                          <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim mb-2">
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
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border border-ink-line text-text-dim">
                          {svc.trade}
                        </span>
                        {svc.default_unit && (
                          <span className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border border-ink-line text-text-dim">
                            per {svc.default_unit}
                          </span>
                        )}
                        {svc.is_custom && (
                          <span className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border border-ink-line text-text-dim">
                            custom
                          </span>
                        )}
                        <StatusPill
                          label={
                            !live
                              ? 'Off — not offered'
                              : svc.always_inspection
                                ? 'Always routes to paid inspection'
                                : 'AI will auto-quote'
                          }
                          tone={!live ? 'dim' : svc.always_inspection ? 'warn' : 'success'}
                          dot
                          compact
                        />
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
                            className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line text-text-sec hover:border-accent/60 hover:text-accent font-bold uppercase tracking-[0.08em] text-[0.65rem] px-3 py-1.5 transition-colors"
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
                            className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line text-text-dim hover:border-warning/60 hover:text-warning font-bold uppercase tracking-[0.08em] text-[0.65rem] px-3 py-1.5 transition-colors"
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

        <Pagination
          page={svcPage}
          pageCount={svcPageCount}
          onPage={setPage}
        />

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
            aria-busy={busy}
            className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
      <PreferredBrandsCard data={data} onSave={onSave} tradeFilter={tradeFilter} />

      {/* Inspection-only educational footer. The lists exist for the two
          labour trades only, so in hub mode it renders solely on the
          electrical/plumbing hubs, keyed by the hub's trade rather than
          the tenant's primary trade. */}
      {(!tradeFilter || tradeFilter === 'electrical' || tradeFilter === 'plumbing') && (
        <Card title="Always require a site visit" subtitle="These jobs route to a $99 paid inspection regardless of toggles above. Your AI tells the customer up front.">
          <ul className="grid sm:grid-cols-2 gap-2 text-sm">
            {((tradeFilter ?? data.tenant.trade) === 'plumbing'
              ? PLUMBING_INSPECTION_ONLY
              : ELECTRICAL_INSPECTION_ONLY
            ).map((item) => (
              <li
                key={item}
                className="rounded-card flex items-baseline gap-3 text-text-sec border border-ink-line bg-ink-card px-3.5 py-2.5"
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
      )}
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
  tradeFilter,
}: {
  data: DashboardData
  onSave: (payload: Record<string, unknown>) => Promise<void>
  /** Trade-hub mode: show only this trade's brand categories (no trade
   *  group headers — the hub header already names the trade). */
  tradeFilter?: TradeHubSlug
}) {
  const initial = data.material_preferences ?? {}
  const [pending, setPending] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Group by trade so multi-trade tenants see two sections.
  const tenantTrades = tradeFilter
    ? [tradeFilter]
    : Array.isArray(data.tenant.trades) && data.tenant.trades.length > 0
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

  const totalCategories = grouped.reduce((sum, g) => sum + g.rows.length, 0)
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
  // Count only categories that are actually visible (in hub mode `grouped`
  // holds one trade), otherwise another trade's preferences inflate the
  // "N of M set" subtitle — N could even exceed M.
  const visibleCategoryKeys = new Set(grouped.flatMap((g) => g.rows.map((r) => r.category)))
  const setCount = Object.entries({ ...initial, ...pending }).filter(
    ([cat, v]) => visibleCategoryKeys.has(cat) && !!v,
  ).length

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
                <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pt-1 pb-1">
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
                      className={`rounded-card flex flex-col gap-2 px-4 py-3 border transition-colors ${
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
                        className="rounded-ctl bg-ink border border-ink-line text-text-pri text-sm px-3 py-2 focus:outline-none focus:border-accent"
                      >
                        <option value="" className="bg-white text-black">
                          Any (use catalogue default)
                        </option>
                        {row.brands.map((brand) => (
                          <option key={brand} value={brand} className="bg-white text-black">
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
          aria-busy={busy}
          className="rounded-ctl inline-flex items-center gap-2 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
        <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold">
          {isEditing ? 'Edit custom service' : 'New custom service'}
        </div>
        {canChangeTrade ? (
          <select
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            aria-label="Trade for this service"
            className="rounded-ctl bg-ink border border-ink-line text-text-pri text-xs uppercase tracking-[0.08em] px-2.5 py-1.5 focus:outline-none focus:border-accent"
          >
            {tenantTrades.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
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
          className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
      </FormField>

      <FormField label="Description" hint="What's included. Shown to customers on quotes.">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Mount, terminate, test on existing circuit"
          className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent resize-y"
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
          className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
            className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
            className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
            className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent"
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
          className="rounded-ctl w-full bg-ink border border-ink-line text-text-pri px-3 py-2 text-sm focus:outline-none focus:border-accent resize-y"
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
          className="border border-ink-line text-text-sec hover:text-text-pri font-bold uppercase tracking-[0.08em] text-[0.7rem] px-4 py-2 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
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
      <span className="mb-1.5 block text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-sec">
        {label}
        {required && <span className="ml-1 text-accent">*</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[0.7rem] leading-snug text-text-dim">
          {hint}
        </span>
      )}
    </label>
  )
}

const ELECTRICAL_INSPECTION_ONLY = [
  'Switchboard upgrade or repair',
  'Fault finding',
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

type QuoteFilter = 'all' | 'review' | 'sent' | 'paid' | 'inspect'

function quoteMatchesFilter(q: Quote, f: QuoteFilter): boolean {
  if (f === 'all') return true
  if (f === 'paid') return !!q.deposit_paid
  if (f === 'inspect') return !!(q.needs_inspection || q.inspection_required)
  const s = (q.status ?? 'draft').toLowerCase()
  if (f === 'sent') return s === 'sent'
  // A 'balance' row is an invoice minted by "Request final payment", not a
  // quote awaiting the tradie's review. It sits at status 'draft' until its
  // SMS is delivered, so without this a failed send would surface it in the
  // review queue with a "Confirm & Send" CTA that the send route refuses
  // (balance_not_sendable) — an actionable-looking dead end.
  if (asQuoteKind(q.quote_kind) === 'balance') return false
  return ['drafted', 'awaiting_review', 'review', 'draft'].includes(s)
}

// Map a quote's badge tone to the shared StatusPill vocabulary — ONE
// source of truth so the collapsed left-rail, the summary pill, and the
// expanded badge set can never drift apart.
type QuoteBadgeTone = 'paid' | 'inspect' | 'draft' | 'sent' | 'accepted'
// The chip container is now neutral for every status (see StatusPill) — this
// tone map only drives the small dot's hue, the single surviving colour cue:
// progress/money-in states (paid / accepted / sent) read a quiet green, the
// actionable "awaiting your review" reads amber (its dot pulses), and
// inspection/site-visit stays grey. No more multi-hue outline pills.
const QUOTE_BADGE_TONE: Record<QuoteBadgeTone, Tone> = {
  paid: 'success',
  accepted: 'success',
  inspect: 'dim',
  sent: 'success',
  draft: 'warn',
}

// The "Saved jobs" strip (roofing/solar/painting/commercial jobs living
// outside the quotes table) was extracted + redesigned into
// ./_components/SavedJobsSection — grouped by trade, sortable, deletable.

// Sort options for the main quotes list. 'newest' matches the API's
// created_at-descending order, so it's the default.
type QuoteSort = 'newest' | 'oldest' | 'value_desc' | 'value_asc'

const QUOTE_SORTS: { key: QuoteSort; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'value_desc', label: 'Highest value' },
  { key: 'value_asc', label: 'Lowest value' },
]

// Sorting the merged queue (quotes + measure-tool jobs) lives in
// lib/dashboard/quote-queue.ts (compareQueueEntries) so it unit-tests
// without React. The old standalone "Saved jobs" section is gone: measure-
// tool jobs are first-class rows in the queue itself.

function QuotesTab({
  data,
  accessToken,
  onQuoteDeleted,
  tradeFilter,
}: {
  data: DashboardData
  accessToken: string | null
  onQuoteDeleted: (id: string) => void
  /** Trade-hub mode: show only this trade's quotes (quote.trade is joined
   *  from the intake). The money band, filters, and counts all scope with
   *  it. Unset = every quote (the Workspace → Quotes pipeline view). */
  tradeFilter?: TradeHubSlug
}) {
  const isMultiTrade =
    !tradeFilter &&
    Array.isArray(data.tenant.trades) && data.tenant.trades.length > 1

  const [filter, setFilter] = useState<QuoteFilter>('all')
  const [sort, setSort] = useState<QuoteSort>('newest')
  // Extra filters (workspace + hub). Trade chips isolate one trade's quotes;
  // date range picks by when the quote was drafted; search is free-text
  // across customer / suburb / job / trade / scope / share code / status.
  const [tradeSel, setTradeSel] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Master–detail selection: which quote the right pane shows, and — on < lg,
  // where the two panes stack — whether the detail is open over the queue.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const all = tradeFilter
    ? data.quotes.filter((q) => (q.trade ?? '').toLowerCase() === tradeFilter)
    : data.quotes

  // Measure-tool jobs (roofing / solar / painting / commercial paint /
  // aircon) merge INTO the queue as first-class rows — one list, one set of
  // counts, so work done in a trade tool can never look "lost" next to the
  // pipeline quotes (pilot feedback: "they're not appearing here in the
  // quote queue"). Mode: the cross-trade Workspace view takes every trade,
  // a matching trade hub scopes to its own, and hubs with no measure-tool
  // table (electrical, plumbing, …) skip the fetch entirely.
  const jobsMode = savedJobsMode(tradeFilter)
  // R4 (specs/dashboard-performance.md): hydrate from the last visit's jobs
  // so a tab revisit paints instantly — the effect below then skips the
  // network entirely while the entry is inside the 15s window. The key is
  // tenant-scoped: tab data must never survive an account switch.
  const jobsCacheKey = tabCacheKey('trade-jobs', data.tenant.id)
  const [jobs, setJobs] = useState<QueueJob[] | null>(
    () => readTabCache<QueueJob[]>(jobsCacheKey)?.data ?? null,
  )
  // A failed fetch must never silently read as "no saved jobs" — surface an
  // explicit strip with a Retry instead (same contract as the Overview
  // widgets).
  const [jobsError, setJobsError] = useState(false)
  const [jobsTick, setJobsTick] = useState(0)
  const jobsFetchedRef = useRef<number | null>(null)
  useEffect(() => {
    if (!accessToken || jobsMode === null) return
    let cancelled = false
    // Fresh cache entry → already rendered via the state initializer; a
    // stale entry stays painted while the fetch below revalidates it.
    const cached = readTabCache<QueueJob[]>(jobsCacheKey)
    if (cached && isFresh(cached, Date.now())) {
      jobsFetchedRef.current = cached.fetchedAt
      return
    }
    void (async () => {
      try {
        // Mint a FRESH token per request — the Clerk session token captured
        // at mount expires ~60s later, so reusing the prop 401s.
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/tenant/trade-jobs', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { jobs?: QueueJob[] }
        if (cancelled) return
        const list = Array.isArray(json.jobs) ? json.jobs : []
        // ONE clock for the cache window and the focus-return throttle, and
        // only a SUCCESS advances it — a failed refresh must not swallow
        // the next 15s of retries.
        const fetchedAt = Date.now()
        writeTabCache(jobsCacheKey, list, fetchedAt)
        jobsFetchedRef.current = fetchedAt
        setJobs(list)
        setJobsError(false)
      } catch {
        if (!cancelled) {
          setJobsError(true)
          jobsFetchedRef.current = null
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken, jobsMode, jobsTick, jobsCacheKey])

  // Refresh-on-return for the job rows: the conditional tab render covers
  // tab switches (served from tab-cache inside 15s); this covers window
  // focus / visibility on an already-mounted Quotes surface, throttled to
  // the same 15s as /api/tenant/me.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return
      if (!shouldRefresh(jobsFetchedRef.current, Date.now())) return
      setJobsTick((n) => n + 1)
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [])

  // Queue-scoped jobs: every trade on the Workspace view, one trade in a hub.
  const queueJobs =
    jobsMode === null
      ? []
      : jobsMode === 'all'
        ? (jobs ?? [])
        : (jobs ?? []).filter((j) => j.trade === jobsMode)

  const FILTERS: { key: QuoteFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'review', label: 'In review' },
    { key: 'sent', label: 'Sent' },
    { key: 'paid', label: 'Deposit paid' },
    { key: 'inspect', label: 'Inspection' },
  ]
  // Trade chips only make sense on the cross-trade Workspace view — a hub is
  // already one trade. Derived from the quotes present so empty trades don't
  // show a dead chip.
  const tradeOptions = queueTradeOptions(tradeOptionsFromQuotes(all), queueJobs)
  const showTradeChips = !tradeFilter && tradeOptions.length > 1
  const searchTerms = parseSearchTerms(search)
  const filtersActive =
    filter !== 'all' ||
    tradeSel !== 'all' ||
    !!dateFrom ||
    !!dateTo ||
    searchTerms.length > 0

  function clearFilters() {
    setFilter('all')
    setTradeSel('all')
    setSearch('')
    setDateFrom('')
    setDateTo('')
  }

  // ONE merged queue: pipeline quotes + measure-tool jobs, filtered by the
  // same status / trade / date / search controls, sorted together (unpriced
  // jobs sink on the value sorts exactly like inspection-routed quotes).
  const filtered: QueueEntry<Quote>[] = [
    ...all
      .filter((q) => quoteMatchesFilter(q, filter))
      .filter((q) => quoteMatchesTrade(q, tradeSel))
      .filter((q) => quoteInDateRange(q, dateFrom, dateTo))
      .filter((q) => quoteMatchesSearch(q, searchTerms))
      .map((q) => ({
        kind: 'quote' as const,
        key: q.id,
        at: q.created_at ?? null,
        value: toNum(q.total_inc_gst),
        quote: q,
      })),
    ...queueJobs
      .filter((j) => jobMatchesFilter(j, filter))
      .filter((j) => tradeSel === 'all' || jobTradeSlug(j) === tradeSel)
      .filter((j) => dateInRange(j.createdAt, dateFrom, dateTo))
      .filter((j) => jobMatchesSearch(j, searchTerms))
      .map((j) => ({
        kind: 'job' as const,
        key: jobQueueKey(j),
        at: j.createdAt,
        value: null,
        job: j,
      })),
  ].sort((a, b) => compareQueueEntries(a, b, sort))
  const total = filtered.length
  const sortLabel = QUOTE_SORTS.find((s) => s.key === sort)?.label ?? 'Newest first'
  // The detail pane always shows a row: the one the tradie picked, else the
  // first in the (filtered, sorted) queue — so it's never blank on load or
  // after a filter change drops the previously-selected row.
  const selected = filtered.find((e) => e.key === selectedId) ?? filtered[0] ?? null

  return (
    <div className="space-y-4">

      {/* ONE toolbar: Search │ Status · Trade · Sort │ From–To · Clear.
          ────────────────────────────────────────────────────────────────
          This was two full-bleed rows and they read as clutter for three
          separate reasons, all of them layout rather than content:

          1. Sort carried `sm:ml-auto`, which on a hub (Status + Sort only)
             opened a ~900px void down the middle of the row. A filter
             marooned at the far edge looks unrelated to the filters it
             belongs with — and you have to cross the whole screen to reach
             it. It now sits with its siblings and the row packs left.
          2. Search was `flex-1` with no ceiling, so it stretched to ~1100px
             — a search field a dozen times wider than anything anyone types
             into it, which made every control beside it look like an
             afterthought. Capped at 20rem: wide enough for a suburb and a
             name, narrow enough to be a control rather than a banner.
          3. Two rows of chrome stacked before a single quote was visible.

          One row now, split by a single hairline into "find it" (search) and
          "narrow it" (the three selects) — a rule instead of another border
          or box, so the grouping costs no extra weight. Every control is
          h-9: they were 37/34/34px, which read as a ragged edge the moment
          they shared one line.

          The date range deliberately has NO leading hairline. It is last, so
          it is the group that wraps when the row runs out of room — the
          Workspace view (Trade present) at 1440, or any narrow laptop — and
          a divider that wraps with it lands orphaned against the left edge
          of line two. The line break already separates the group; the "From"
          label already names it. Wrapping happens at a group seam either
          way, because the two dates share a wrapper that cannot split. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full min-w-0 sm:w-auto sm:min-w-[12rem] sm:max-w-xs sm:flex-1">
          <span className="sr-only">Search quotes</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, suburb, job, code…"
            className="rounded-ctl h-9 w-full border border-ink-line bg-ink-card px-3 py-2 font-mono text-xs text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none"
          />
        </label>

        <div aria-hidden="true" className="hidden h-6 w-px shrink-0 bg-ink-line sm:block" />

        <FilterSelect
          label="Status"
          value={filter}
          onChange={(v) => setFilter(v as QuoteFilter)}
          fill
        >
          {FILTERS.map((f) => {
            const count =
              all.filter((q) => quoteMatchesFilter(q, f.key)).length +
              queueJobs.filter((j) => jobMatchesFilter(j, f.key)).length
            return (
              <option key={f.key} value={f.key} className="bg-ink-deep">
                {f.label} ({count})
              </option>
            )
          })}
        </FilterSelect>

        {/* Trade only appears on the cross-trade Workspace view — a hub is
            already scoped to one trade — and only when the tenant actually
            has quotes in more than one. */}
        {showTradeChips && (
          <FilterSelect label="Trade" value={tradeSel} onChange={setTradeSel} fill>
            {['all', ...tradeOptions].map((t) => {
              const count =
                t === 'all'
                  ? all.length + queueJobs.length
                  : all.filter((q) => (q.trade ?? '').toLowerCase() === t).length +
                    queueJobs.filter((j) => jobTradeSlug(j) === t).length
              return (
                <option key={t} value={t} className="bg-ink-deep">
                  {t === 'all' ? 'All trades' : quoteTradeLabel(t)} ({count})
                </option>
              )
            })}
          </FilterSelect>
        )}

        <FilterSelect
          label="Sort"
          value={sort}
          onChange={(v) => setSort(v as QuoteSort)}
          fill
        >
          {QUOTE_SORTS.map((s) => (
            <option key={s.key} value={s.key} className="bg-ink-deep">
              {s.label}
            </option>
          ))}
        </FilterSelect>

        {/* Search matches customer / suburb / job / trade / scope / share
            code / status; the date range picks quotes by when they were
            drafted (inclusive, calendar date).

            The two dates share a wrapper so the RANGE never splits across
            lines — the one pairing that must never break. `min-w-0` on both
            halves stops a native date input (stubborn intrinsic width) from
            pushing the row wider than the screen. */}
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim sm:flex-none">
            From
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-ctl h-9 w-full min-w-0 border border-ink-line bg-ink-card px-2.5 py-2 font-mono text-xs text-text-pri focus:border-accent focus:outline-none sm:w-auto"
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim sm:flex-none">
            To
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-ctl h-9 w-full min-w-0 border border-ink-line bg-ink-card px-2.5 py-2 font-mono text-xs text-text-pri focus:border-accent focus:outline-none sm:w-auto"
            />
          </label>
        </div>
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-ctl inline-flex h-9 items-center gap-2 border border-ink-line bg-ink-card px-3 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-dim transition-colors cursor-pointer hover:border-accent hover:text-accent"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Measure-tool fetch failure — say so; silently hiding job rows is
          exactly the "quotes disappear from the queue" bug this merge fixes.
          Shown even when cached rows are painted below: a failed revalidate
          means the queue may be stale, and the tradie gets the Retry. */}
      {jobsError && jobsMode !== null && (
        <div
          role="alert"
          className="rounded-ctl flex flex-wrap items-center justify-between gap-2 border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-text-pri"
        >
          <span>
            Couldn&rsquo;t load your measure-tool estimates — the queue may be
            incomplete.
          </span>
          <button
            type="button"
            onClick={() => setJobsTick((n) => n + 1)}
            className="rounded-ctl inline-flex items-center border border-ink-line px-3 py-1.5 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-pri transition-colors cursor-pointer hover:border-accent hover:text-accent"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Master–detail: quote queue (left) + selected quote (right).
          Mirrors the QuoteMax dashboard reference — a scrollable queue beside a
          scrollable detail pane. On < lg the two stack: the queue shows first,
          tapping a row opens the detail with a back button. ───────────────── */}
      {total === 0 ? (
        <Card>
          <div className="space-y-3">
            <p className="text-sm text-text-dim">
              {all.length + queueJobs.length === 0
                ? tradeFilter
                  ? `No ${quoteTradeLabel(tradeFilter)} quotes yet — pipeline quotes and measure-tool estimates land here as soon as they're drafted.`
                  : 'No quotes yet. Customer quotes drafted from your QuoteMax number and estimates saved from the measure tools both land here.'
                : 'No quotes match these filters.'}
            </p>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-ctl inline-flex items-center gap-2 border border-ink-line bg-ink-card px-3 py-2 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-dim transition-colors cursor-pointer hover:border-accent hover:text-accent"
              >
                Clear filters
              </button>
            )}
          </div>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-card edge-lit border border-ink-line bg-ink-deep lg:grid lg:h-[calc(100dvh-18rem)] lg:min-h-[520px] lg:grid-cols-[minmax(360px,470px)_minmax(0,1fr)]">
          {/* Queue */}
          <div
            className={`min-h-0 flex-col lg:flex lg:border-r lg:border-ink-line ${
              mobileDetailOpen ? 'hidden' : 'flex'
            }`}
          >
            <div className="sticky top-0 z-[5] flex items-center justify-between gap-3 border-b border-ink-line bg-ink-deep px-[18px] py-[15px]">
              <span className=" text-[11px] font-semibold uppercase tracking-[0.08em] text-text-sec">
                Quote queue · {total}
              </span>
              <span className=" text-[10px] uppercase tracking-[0.08em] text-text-dim">
                {sortLabel}
              </span>
            </div>
            <div className="min-h-0 overflow-y-auto lg:flex-1">
              {filtered.map((e) =>
                e.kind === 'quote' ? (
                  <QuoteQueueRow
                    key={e.key}
                    q={e.quote}
                    isMultiTrade={isMultiTrade}
                    selected={selected?.key === e.key}
                    onSelect={() => {
                      setSelectedId(e.key)
                      setMobileDetailOpen(true)
                    }}
                  />
                ) : (
                  <JobQueueRow
                    key={e.key}
                    job={e.job}
                    isMultiTrade={isMultiTrade}
                    selected={selected?.key === e.key}
                    onSelect={() => {
                      setSelectedId(e.key)
                      setMobileDetailOpen(true)
                    }}
                  />
                ),
              )}
            </div>
          </div>

          {/* Detail */}
          <div
            className={`min-h-0 flex-col bg-ink-deep lg:flex ${
              mobileDetailOpen ? 'flex' : 'hidden'
            }`}
          >
            <button
              type="button"
              onClick={() => setMobileDetailOpen(false)}
              className="flex items-center gap-2 border-b border-ink-line px-4 py-3 text-left text-[0.65rem] font-bold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent lg:hidden"
            >
              ← Back to queue
            </button>
            {selected &&
              (selected.kind === 'quote' ? (
                <QuoteDetail
                  key={selected.key}
                  q={selected.quote}
                  isMultiTrade={isMultiTrade}
                  accessToken={accessToken}
                  onDeleted={onQuoteDeleted}
                  allQuotes={data.quotes}
                />
              ) : (
                <JobQueueDetail
                  key={selected.key}
                  job={selected.job}
                  accessToken={accessToken}
                  onDeleted={(j) => {
                    const next = (jobs ?? []).filter(
                      (x) => !(x.trade === j.trade && x.id === j.id),
                    )
                    // Keep the cache in step so the deleted job can't
                    // resurrect from a fresh entry on the next revisit.
                    writeTabCache(jobsCacheKey, next, Date.now())
                    setJobs(next)
                    setSelectedId(null)
                    setMobileDetailOpen(false)
                  }}
                />
              ))}
          </div>
        </div>
      )}

    </div>
  )
}

/**
 * Two-step delete for a drafted quote. First click arms the confirm state;
 * confirming calls DELETE /api/quote/[id] (owner-checked, refuses paid
 * quotes server-side) and reports success upward so QuotesTab drops the
 * card without re-fetching the dashboard payload.
 */
function DeleteQuoteButton({
  quoteId,
  accessToken,
  onDeleted,
}: {
  quoteId: string
  accessToken: string | null
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function doDelete() {
    setBusy(true)
    setErr(null)
    try {
      // Mint a FRESH dual-auth token immediately before the DELETE. The
      // `accessToken` prop was captured at mount; a Clerk default session
      // token expires ~60s later, and this click fires long after mount.
      // getAuthToken() returns a current Clerk (or legacy Supabase) token;
      // fall back to the captured prop if it can't resolve one.
      const token = (await getAuthToken()) ?? accessToken
      if (!token) {
        setErr('Could not delete — try again shortly.')
        setBusy(false)
        return
      }
      const res = await fetch(`/api/quote/${quoteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      // 404 = the row is already gone (deleted in another tab) — treat as
      // success so the card can't become an undeletable phantom.
      if (res.ok || res.status === 404) {
        onDeleted(quoteId)
        return
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      setErr(
        res.status === 409 || json.error === 'quote_already_paid'
          ? "Deposit paid — this quote can't be deleted."
          : 'Could not delete — try again shortly.',
      )
      setBusy(false)
      setConfirming(false)
    } catch {
      setErr('Could not delete — try again shortly.')
      setBusy(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <span className="flex w-full items-stretch gap-2 sm:w-auto">
        <button
          type="button"
          onClick={() => void doDelete()}
          disabled={busy}
          aria-busy={busy}
          className="rounded-ctl inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 border border-danger/60 bg-danger/10 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-danger transition-colors hover:bg-danger/20 disabled:opacity-50 sm:flex-none"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {busy ? 'Deleting…' : 'Yes, delete'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          aria-busy={busy}
          className="rounded-ctl inline-flex min-h-[44px] flex-1 items-center justify-center border border-ink-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent disabled:opacity-50 sm:flex-none"
        >
          Cancel
        </button>
      </span>
    )
  }
  return (
    <span className="flex w-full items-stretch gap-2 sm:w-auto sm:items-center">
      {err && (
        <span
          role="alert"
          className="self-center text-[0.62rem] uppercase tracking-[0.08em] text-danger"
        >
          {err}
        </span>
      )}
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label="Delete quote"
        className="rounded-ctl inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 border border-ink-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-dim transition-colors hover:border-danger hover:text-danger sm:flex-none"
      >
        <Trash2 size={13} />
        Delete
      </button>
    </span>
  )
}

// ── Shared quote helpers for the master–detail Quotes view ─────────────

// Status badges for a quote, most-actionable first (deposit paid → inspection
// → status). Plain-language labels, not raw DB slugs. Shared by the queue row
// and the detail header.
function quoteBadges(q: Quote): { label: string; tone: QuoteBadgeTone }[] {
  const isInspection = !!(q.needs_inspection || q.inspection_required)
  const out: { label: string; tone: QuoteBadgeTone }[] = []
  // R12 — say which link of the chain this row is. Without it a job's three
  // rows are indistinguishable in the list.
  const kind = asQuoteKind(q.quote_kind)
  if (kind === 'final') out.push({ label: 'Final quote', tone: 'sent' })
  if (kind === 'balance') out.push({ label: 'Balance', tone: 'sent' })
  if (q.deposit_paid) {
    // "Deposit paid" is wrong on a paid BALANCE row — that money is the final
    // payment, and the job is settled, not just secured.
    out.push(
      kind === 'balance'
        ? { label: 'Paid in full', tone: 'paid' }
        : { label: 'Deposit paid', tone: 'paid' },
    )
  }
  if (isInspection) out.push({ label: 'Inspection required', tone: 'inspect' })
  if (!q.deposit_paid) {
    const raw = (q.status ?? 'draft').toLowerCase()
    const tone: QuoteBadgeTone =
      raw === 'accepted' ? 'accepted' : raw === 'sent' ? 'sent' : 'draft'
    const label =
      raw === 'accepted'
        ? 'Accepted'
        : raw === 'sent'
          ? 'Sent to customer'
          : 'Awaiting your review'
    out.push({ label, tone })
  }
  return out
}

// Compact relative time for a queue row ("4 MIN AGO", "YESTERDAY"), absolute
// past a week.
function relTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'JUST NOW'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} MIN AGO`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} HR AGO`
  const d = Math.floor(h / 24)
  if (d === 1) return 'YESTERDAY'
  if (d < 7) return `${d} DAYS AGO`
  return formatDate(iso).toUpperCase()
}

// Line items denormalised into a tier's good/better/best jsonb. The dashboard
// TierJson type narrows to subtotal, but /api/tenant/me returns the full jsonb,
// so read line_items defensively (same shape lib/quote/report-html.ts renders).
type DetailLineItem = {
  description: string
  quantity: number
  unit: string
  unit_price_ex_gst: number
}
function tierLineItems(tier: TierJson): DetailLineItem[] {
  const raw = (tier as { line_items?: unknown } | null)?.line_items
  if (!Array.isArray(raw)) return []
  return raw
    .map((li) => {
      const o = (li ?? {}) as Record<string, unknown>
      return {
        description: typeof o.description === 'string' ? o.description : '',
        quantity: toNum(o.quantity as string | number | null) ?? 1,
        unit: typeof o.unit === 'string' ? o.unit : '',
        unit_price_ex_gst: toNum(o.unit_price_ex_gst as string | number | null) ?? 0,
      }
    })
    .filter((li) => li.description)
}

/**
 * One row in the left "quote queue" of the master–detail Quotes view. Compact:
 * customer + channel, job, suburb·time·(trade), value, status pill, and a 2px
 * status bar down the left edge. Selecting it drives the right detail pane.
 */
function QuoteQueueRow({
  q,
  isMultiTrade,
  selected,
  onSelect,
}: {
  q: Quote
  isMultiTrade: boolean
  selected: boolean
  onSelect: () => void
}) {
  const badge = quoteBadges(q)[0]
  const tone: Tone = badge ? QUOTE_BADGE_TONE[badge.tone] : 'default'
  const value = toNum(q.total_inc_gst)
  const customerLabel = q.customer_full_name || q.customer_first_name || '—'
  const trade = q.trade
  const meta = [
    q.suburb,
    relTime(q.created_at),
    isMultiTrade && trade ? quoteTradeLabel(trade.toLowerCase()) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex w-full items-center justify-between gap-3 border-b border-ink-line px-[18px] py-3.5 text-left transition-colors cursor-pointer ${
        selected ? 'bg-ink' : 'hover:bg-ink/55'
      }`}
    >
      {/* Reference: the 2px left bar marks the SELECTED row; triage colour
          lives in the status pill alone. */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[2px] ${selected ? 'bg-accent' : 'bg-transparent'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-text-pri">{customerLabel}</span>
          {q.channel && <ChannelBadge channel={q.channel} />}
        </div>
        <div className="mt-1 truncate text-[13px] text-text-sec">
          {formatJobType(q.job_type)}
        </div>
        {meta && (
          <div className="mt-1.5 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
            {meta}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[9px]">
        <span
          className={`font-mono text-sm font-bold tabular-nums ${
            value !== null ? 'text-text-pri' : 'text-text-dim'
          }`}
        >
          {value !== null ? `$${formatMoney(value)}` : '—'}
        </span>
        {badge && (
          <StatusPill label={badge.label} tone={tone} compact dot pulse={tone === 'warn'} />
        )}
      </div>
    </button>
  )
}

// Status badge for a measure-tool job row — same restrained vocabulary as
// quoteBadges so both row kinds read as one queue. A draft job is work
// awaiting the tradie, exactly like an unsent pipeline quote.
function jobBadge(status: QueueJob['status']): { label: string; tone: QuoteBadgeTone } {
  if (status === 'confirmed') return { label: 'Confirmed', tone: 'accepted' }
  if (status === 'inspection') return { label: 'Inspection required', tone: 'inspect' }
  return { label: 'Awaiting your review', tone: 'draft' }
}

/**
 * One measure-tool job row in the merged quote queue. Mirrors QuoteQueueRow's
 * layout: the address stands in for the customer, the headline figure
 * (area / $ / recommendation) for the job line, and the meta row names the
 * measure tool so a tradie can tell the row kinds apart at a glance.
 */
function JobQueueRow({
  job,
  isMultiTrade,
  selected,
  onSelect,
}: {
  job: QueueJob
  isMultiTrade: boolean
  selected: boolean
  onSelect: () => void
}) {
  const badge = jobBadge(job.status)
  const tone: Tone = QUOTE_BADGE_TONE[badge.tone]
  const tradeLabel = quoteTradeLabel(jobTradeSlug(job))
  const meta = [
    relTime(job.createdAt),
    isMultiTrade ? tradeLabel : null,
    'Measure tool',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex w-full items-center justify-between gap-3 border-b border-ink-line px-[18px] py-3.5 text-left transition-colors cursor-pointer ${
        selected ? 'bg-ink' : 'hover:bg-ink/55'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[2px] ${selected ? 'bg-accent' : 'bg-transparent'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-text-pri">
            {job.address ?? 'No address'}
          </span>
        </div>
        <div className="mt-1 truncate text-[13px] text-text-sec">
          {job.headline ?? `${tradeLabel} estimate`}
        </div>
        {meta && (
          <div className="mt-1.5 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
            {meta}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[9px]">
        <StatusPill label={badge.label} tone={tone} compact dot pulse={tone === 'warn'} />
      </div>
    </button>
  )
}

/**
 * Right-pane detail for a measure-tool job row — the job's key facts plus the
 * actions the old standalone saved-jobs card offered: open the tradie
 * review/edit page, open the customer page, delete (two-step confirm against
 * the tenant-scoped DELETE /api/tenant/trade-jobs; jobs linked to a paid
 * quote are refused server-side with a 409).
 */
function JobQueueDetail({
  job,
  accessToken,
  onDeleted,
}: {
  job: QueueJob
  accessToken: string | null
  onDeleted: (job: QueueJob) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const badge = jobBadge(job.status)
  const tradeLabel = quoteTradeLabel(jobTradeSlug(job))

  async function doDelete() {
    if (!accessToken) return
    setBusy(true)
    setErr(null)
    try {
      // Fresh dual-auth token — the prop was minted at mount and a Clerk
      // session token expires ~60s later.
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/trade-jobs', {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ trade: job.trade, id: job.id }),
      })
      // 404 = already gone (deleted in another tab) — treat as success so a
      // stale row can't become permanently undeletable.
      if (!res.ok && res.status !== 404) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        setErr(
          res.status === 409 || json.error === 'job_already_paid'
            ? "That job took a deposit — it can't be deleted."
            : 'Could not delete that job — try again shortly.',
        )
        return
      }
      onDeleted(job)
    } catch {
      setErr('Could not delete that job — try again shortly.')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col motion-safe:animate-[fade-up_200ms_ease-out_both]">
      {/* ── Scrollable detail body (mirrors QuoteDetail) ───────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-ink-line px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <div className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-accent">
              {tradeLabel} · Measure-tool estimate
              {job.createdAt ? ` · ${formatDate(job.createdAt)}` : ''}
            </div>
            <h2 className="mt-1.5 font-extrabold uppercase leading-none tracking-tight text-text-pri text-[clamp(1.25rem,2.2vw,1.6rem)]">
              {job.address ?? 'No address'}
            </h2>
            {job.href && (
              <a
                href={job.href}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex text-[0.62rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors hover:text-accent-press"
              >
                Customer page →
              </a>
            )}
          </div>
          <StatusPill label={badge.label} tone={QUOTE_BADGE_TONE[badge.tone]} dot />
        </div>

        {/* Estimate headline — same visual weight as a tier-card price */}
        {job.headline && (
          <div className="border-b border-ink-line px-5 py-5 sm:px-6">
            <div className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
              Estimate
            </div>
            <div className="mt-[9px] font-mono text-xl font-bold tabular-nums text-text-pri">
              {job.headline}
            </div>
          </div>
        )}

        {/* Details */}
        <div className="border-b border-ink-line px-5 py-5 sm:px-6">
          <div className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
            Details
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-sec">
            Saved from the {tradeLabel.toLowerCase()} measure tool — it sits in
            this queue alongside your pipeline quotes.
          </p>
        </div>
      </div>

      {/* ── Pinned action bar (mirrors QuoteDetail) ────────────────── */}
      <div className="sticky bottom-0 z-[5] border-t border-ink-line bg-ink-deep px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {job.tradieHref && (
            <Link
              href={job.tradieHref}
              target="_blank"
              rel="noreferrer"
              className="rounded-ctl inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 whitespace-nowrap bg-accent px-5 py-[13px] text-[13px] font-semibold uppercase tracking-[0.06em] text-accent-ink transition-colors hover:bg-accent-press"
            >
              {jobTradieCtaLabel(job)} →
            </Link>
          )}
          {job.href && (
            <Link
              href={job.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-[18px] py-[13px] text-[13px] font-semibold uppercase tracking-[0.06em] text-text-pri transition-colors hover:border-accent hover:text-accent"
            >
              View customer page →
            </Link>
          )}
          {err && (
            <span
              role="alert"
              className="self-center text-[0.62rem] uppercase tracking-[0.08em] text-danger"
            >
              {err}
            </span>
          )}
          {confirming ? (
            <span className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => void doDelete()}
                disabled={busy}
                aria-busy={busy}
                className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-danger/60 bg-danger/10 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : null}
                {busy ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                aria-busy={busy}
                className="rounded-ctl inline-flex min-h-[44px] items-center justify-center border border-ink-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirming(true)
                setErr(null)
              }}
              aria-label="Delete job"
              className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-dim transition-colors hover:border-danger hover:text-danger"
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Right-hand detail pane of the master–detail Quotes view (was the expanded
 * QuoteCard body). Reference layout: header, tier options, line items, details,
 * activity, transcript, and a pinned action bar carrying every existing action
 * (customer page, copy deposit link, view PDF · edit, download PDF, delete).
 */
function QuoteDetail({
  q,
  isMultiTrade,
  accessToken,
  onDeleted,
  allQuotes,
}: {
  q: Quote
  isMultiTrade: boolean
  accessToken: string | null
  onDeleted: (id: string) => void
  /** Every quote already loaded for this tenant — used to resolve the
   *  post-site-visit chain (spec R12). No extra fetch: the rows are in memory. */
  allQuotes?: Quote[]
}) {
  const url = q.share_token ? `/q/${q.share_token}` : null

  // ── The post-site-visit chain (spec R12) ─────────────────────────
  // A job can now span three rows — the $99 site visit, the final quote, and
  // the balance — and until this they were three unrelated cards with no way
  // to tell they were one job, or to get from one to the next.
  const chain = useMemo(() => {
    const rows = allQuotes ?? []
    const kind = asQuoteKind(q.quote_kind)
    if (kind !== 'initial') {
      const parent = rows.find((r) => r.id === q.parent_quote_id) ?? null
      return { parent, child: null as Quote | null, kind }
    }
    // On the root, point forward to the final quote issued against it.
    const child =
      rows.find((r) => r.parent_quote_id === q.id && asQuoteKind(r.quote_kind) === 'final') ?? null
    return { parent: null as Quote | null, child, kind }
  }, [allQuotes, q.id, q.parent_quote_id, q.quote_kind])

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
  const trade = q.trade as 'electrical' | 'plumbing' | 'roofing' | null
  // Trade-aware rendering (spec R4–R8): non-generic trades get their own tier
  // framing + a trade label instead of the bare electrical Good/Better/Best.
  const tradeFormat = resolveTradeFormat(trade)
  const tierLabels = tierLabelsForTrade(trade)
  const isBespokeTrade = !tradeFormat.usesGenericCard
  const isInspection = !!(q.needs_inspection || q.inspection_required)
  const hasTierLadder =
    goodTotal !== null || betterTotal !== null || bestTotal !== null

  const badges = quoteBadges(q)
  const primaryBadge = badges[0]
  const primaryTone: Tone = primaryBadge ? QUOTE_BADGE_TONE[primaryBadge.tone] : 'default'
  // "Confirm & Send" / "Send to Customer" action (specs/quote-confirm-send.md
  // task 2) — sending a held quote IS the tradie's confirmation, so the same
  // panel serves the "Awaiting your review" badge and the resend case. Hidden
  // once the customer has committed, same convention as the Delete button.
  const sendCta = confirmSendCta(q.status, q.deposit_paid)
  const sectionLabel =
    ' text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim'

  // Tier whose line-item breakdown the pane previews — starts on the tradie-
  // selected ("recommended") tier, else the first tier that has a price.
  const tierTotals: Record<'good' | 'better' | 'best', number | null> = {
    good: goodTotal,
    better: betterTotal,
    best: bestTotal,
  }
  const pricedTiers = (['good', 'better', 'best'] as const).filter(
    (t) => tierTotals[t] !== null,
  )
  const [activeTier, setActiveTier] = useState<'good' | 'better' | 'best'>(
    (selectedTier && tierTotals[selectedTier] !== null ? selectedTier : pricedTiers[0]) ?? 'better',
  )
  const activeLineItems = tierLineItems(q[activeTier])

  // Synthesised activity — only events the quote's own fields imply.
  const st = (q.status ?? '').toLowerCase()
  const activity: { label: string; sub: string }[] = [
    { label: 'Drafted by QuoteMax', sub: `${formatDate(q.created_at)} · ${formatTime(q.created_at)}` },
  ]
  if (q.deposit_paid || ['sent', 'accepted', 'paid'].includes(st))
    activity.push({ label: 'Sent to customer', sub: '' })
  if (q.deposit_paid) activity.push({ label: 'Deposit paid', sub: '' })
  else if (['accepted', 'paid'].includes(st)) activity.push({ label: 'Accepted', sub: '' })

  return (
    <div className="flex min-h-0 flex-1 flex-col motion-safe:animate-[fade-up_200ms_ease-out_both]">
      {/* ── Scrollable detail body ─────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-ink-line px-5 py-5 sm:px-6">
          <div className="min-w-0">
            <div className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-accent">
              Drafted · {formatDate(q.created_at)}
              {q.channel ? ` · ${q.channel === 'voice' ? 'Voice' : 'SMS'}` : ''}
            </div>
            <h2 className="mt-1.5 font-extrabold uppercase leading-none tracking-tight text-text-pri text-[clamp(1.25rem,2.2vw,1.6rem)]">
              {customerLabel}
            </h2>
            <p className="mt-1.5 text-sm text-text-sec">
              {formatJobType(q.job_type)}
              {q.suburb ? ` · ${q.suburb}` : ''}
              {isMultiTrade && trade ? ` · ${tradeLabel(trade)}` : ''}
            </p>
            {/* R12 — one job, up to three rows. Say which link this is and
                give the tradie a way to walk the chain. */}
            {chain.parent?.share_token && (
              <a
                href={`/dashboard/quote/${chain.parent.share_token}`}
                className="mt-2 flex text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
              >
                ←{' '}
                {chain.kind === 'balance'
                  ? 'Balance for this final quote'
                  : 'Follow-up to the $99 site visit'}
              </a>
            )}
            {chain.child?.share_token && (
              <a
                href={`/dashboard/quote/${chain.child.share_token}`}
                className="mt-2 flex text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
              >
                Final quote issued →
              </a>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex text-[0.62rem] font-bold uppercase tracking-[0.08em] text-accent transition-colors hover:text-accent-press"
              >
                Customer page →
              </a>
            )}
          </div>
          {primaryBadge && (
            <StatusPill
              label={primaryBadge.label}
              tone={primaryTone}
              dot
              pulse={primaryTone === 'warn'}
            />
          )}
        </div>

        {/* Options drafted from your pricing book — tap a tier to preview it */}
        {hasTierLadder && (
          <div className="border-b border-ink-line px-5 py-5 sm:px-6">
            <div className={sectionLabel}>
              {isBespokeTrade
                ? `${tradeFormat.label} options`
                : 'Options drafted from your pricing book'}
            </div>
            <div className="mt-3.5 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
              {pricedTiers.map((t) => {
                const isSel = t === selectedTier
                const isActive = t === activeTier
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActiveTier(t)}
                    aria-pressed={isActive}
                    className={`relative rounded-card edge-lit overflow-hidden border bg-ink-card p-4 pb-[18px] text-left transition-colors cursor-pointer ${
                      isActive ? 'border-accent' : 'border-ink-line hover:border-accent/55'
                    }`}
                  >
                    {isSel && (
                      <span className="absolute left-0 top-[-1px] bg-accent px-[9px] py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-accent-ink">
                        Recommended
                      </span>
                    )}
                    <div className={`${isSel ? 'mt-3.5' : ''} text-[11px] font-semibold uppercase tracking-[0.08em] text-accent`}>
                      {tierLabels[t]}
                    </div>
                    <div className="mt-[9px] font-mono text-xl font-bold tabular-nums text-text-pri">
                      ${formatMoney(tierTotals[t] as number)}
                    </div>
                    {q[t]?.timeframe && (
                      <div className="mt-[3px] text-xs text-text-dim">{q[t]?.timeframe}</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Line items for the previewed tier — else the scope of works */}
        {activeLineItems.length > 0 && tierTotals[activeTier] !== null ? (
          <div className="border-b border-ink-line px-5 py-5 sm:px-6">
            <div className={sectionLabel}>{tierLabels[activeTier]} — line items</div>
            <div className="mt-3 border border-ink-line">
              {activeLineItems.map((li, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3.5 border-b border-ink-line px-[15px] py-[11px] last:border-b-0"
                >
                  <span className="text-[13px] text-text-sec">{li.description}</span>
                  <span className="font-mono text-[11px] text-text-dim">
                    {li.quantity} × ${formatMoney(li.unit_price_ex_gst)}
                    {li.unit ? ` /${li.unit}` : ''}
                  </span>
                  <span className="min-w-[64px] text-right font-mono text-[13px] tabular-nums text-text-pri">
                    ${formatMoney(+(li.quantity * li.unit_price_ex_gst * gstRatio).toFixed(2))}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between bg-ink px-[15px] py-3">
                <span className=" text-[11px] font-semibold uppercase tracking-[0.08em] text-text-dim">
                  Total inc GST
                </span>
                <span className="font-mono text-base font-bold tabular-nums text-accent">
                  ${formatMoney(tierTotals[activeTier] as number)}
                </span>
              </div>
            </div>
          </div>
        ) : q.scope_of_works ? (
          <div className="border-b border-ink-line px-5 py-5 sm:px-6">
            <div className={sectionLabel}>Scope of works</div>
            <p className="mt-2 text-sm leading-relaxed text-text-sec">{q.scope_of_works}</p>
          </div>
        ) : null}

        {/* Details: metadata grid + historical hint + timeframe + layout */}
        <div className="border-b border-ink-line px-5 py-5 sm:px-6">
          <div className={sectionLabel}>Details</div>
          <div className="mt-3 grid grid-cols-2 gap-px border border-ink-line bg-ink-line sm:grid-cols-4">
            <MetaCell label="Work" value={formatJobType(q.job_type)} />
            <MetaCell
              label="Service"
              value={trade ? tradeLabel(trade) : '—'}
              highlight={isMultiTrade}
            />
            <MetaCell label="Drafted" value={formatDate(q.created_at)} sub={formatTime(q.created_at)} />
            <MetaCell
              label="Routing"
              value={q.routing_decision ? formatJobType(q.routing_decision) : '—'}
            />
          </div>
          <HistoricalHint jobType={q.job_type} trade={trade} accessToken={accessToken} />
          {q.estimated_timeframe && (
            <div className="mt-3">
              <div className={sectionLabel}>Estimated timeframe</div>
              <p className="mt-1 text-sm text-text-sec">{q.estimated_timeframe}</p>
            </div>
          )}
          <div className="mt-4">
            <QuoteDisplayModeToggle
              quoteId={q.id}
              initial={q.display_mode}
              accessToken={accessToken}
            />
          </div>
        </div>

        {/* Activity */}
        <div className="border-b border-ink-line px-5 py-5 sm:px-6">
          <div className={sectionLabel}>Activity</div>
          <div className="mt-3.5 flex flex-col">
            {activity.map((ev, i) => {
              const last = i === activity.length - 1
              return (
                <div key={i} className="flex gap-3">
                  <div className="flex w-[11px] shrink-0 flex-col items-center">
                    <span
                      aria-hidden="true"
                      className="mt-[3px] h-[9px] w-[9px] shrink-0 rounded-full border-2 border-ink-deep bg-accent"
                    />
                    {!last && (
                      <span aria-hidden="true" className="min-h-[16px] w-px flex-1 bg-ink-line" />
                    )}
                  </div>
                  <div className="min-w-0 pb-4">
                    <div className="text-[0.82rem] font-semibold text-text-pri">{ev.label}</div>
                    {ev.sub && (
                      <div className="mt-0.5 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                        {ev.sub}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* How QuoteMax intook the job */}
        {q.messages && q.messages.length > 0 && (
          <div className="border-b border-ink-line px-5 py-5 sm:px-6">
            <div className={sectionLabel}>How QuoteMax intook the job</div>
            <div className="mt-3">
              <Transcript messages={q.messages} channel={q.channel} />
            </div>
          </div>
        )}
      </div>

      {/* ── Pinned action bar — every existing action preserved ─────── */}
      <div className="sticky bottom-0 z-[5] border-t border-ink-line bg-ink-deep px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {sendCta.show && (
            <SendQuotePanel
              quoteId={q.id}
              customerPhone={q.customer_phone}
              customerEmail={q.customer_email}
              paid={false}
              label={sendCta.label}
              dropUp
              // R9 — a child row is SMS-only. The send route 409s the email
              // channel anyway; this stops offering a button that dead-ends.
              smsOnly={asQuoteKind(q.quote_kind) !== 'initial'}
            />
          )}
          {url && (
            <Link
              href={url}
              target="_blank"
              // Demoted from accent fill to rank-2. This sat beside "Send to
              // customer" as a SECOND yellow primary, and two primaries side
              // by side is the same as none — the eye has nowhere to land.
              // Sending is the decision; viewing the page is a look. Same
              // link, same behaviour, one rank down.
              className="rounded-ctl inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 whitespace-nowrap border border-ink-line bg-ink-card px-5 py-[13px] text-[13px] font-semibold text-text-pri transition-colors hover:border-accent/50 hover:text-accent"
            >
              View customer page →
            </Link>
          )}
          {/* Measurement Results (/m/[measure_token]) for a roofing quote
              promoted from a saved measurement. Promotion drops the job from
              /api/tenant/trade-jobs so it doesn't double-render, which used
              to strip this link entirely — a sold roofing job had no way back
              to its measured structures. Null for non-roofing quotes. */}
          {q.measure_href && (
            <Link
              href={q.measure_href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-[18px] py-[13px] text-[13px] font-semibold uppercase tracking-[0.06em] text-text-pri transition-colors hover:border-accent hover:text-accent"
            >
              Measurement results →
            </Link>
          )}
          {/* Copy the /r/{token}/{tier} deposit short-link (never charges from
              the dashboard). Hidden for inspection-routed quotes. */}
          {url && !isInspection && q.share_token && (
            <CopyDepositLink token={q.share_token} tier={q.selected_tier} />
          )}
          {/* In-dashboard PDF viewer/editor. Hidden for inspection quotes. */}
          {url && !isInspection && q.share_token && (
            <Link
              href={`/dashboard/quote/${q.share_token}`}
              className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-[18px] py-[13px] text-[13px] font-semibold uppercase tracking-[0.06em] text-text-pri transition-colors hover:border-accent hover:text-accent"
            >
              View PDF · Edit
            </Link>
          )}
          {/* Download the full quote PDF. Inspection quotes 404 that route. */}
          {url && !isInspection && (
            <a
              href={`/api/q/${q.share_token}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-[18px] py-[13px] text-[13px] font-semibold uppercase tracking-[0.06em] text-text-pri transition-colors hover:border-accent hover:text-accent"
            >
              Download PDF ↓
            </a>
          )}
          {/* Delete — hidden once a deposit lands or the quote is accepted;
              the API independently refuses paid quotes with a 409. */}
          {!q.deposit_paid &&
            !['accepted', 'paid'].includes((q.status ?? '').toLowerCase()) && (
              <DeleteQuoteButton quoteId={q.id} accessToken={accessToken} onDeleted={onDeleted} />
            )}
        </div>
      </div>
    </div>
  )
}

/**
 * Deposit-link share button (spec R7). Copies the customer's per-tier deposit
 * short-link (`/r/{token}/{tier}`) to the clipboard so the tradie can send it.
 * It deliberately does NOT open Stripe from the dashboard — the live Pay
 * Deposit button is on the customer page. Falls back silently if the clipboard
 * API is unavailable (e.g. insecure context).
 */
function CopyDepositLink({ token, tier }: { token: string; tier: string | null }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    const t = tier === 'good' || tier === 'better' || tier === 'best' ? tier : 'better'
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    try {
      await navigator.clipboard.writeText(`${origin}/r/${token}/${t}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded-ctl inline-flex min-h-[44px] items-center justify-center gap-2 border border-ink-line px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent"
    >
      {copied ? 'Copied ✓' : 'Copy deposit link'}
    </button>
  )
}

/**
 * Phase B — per-quote display-mode override toggle.
 *
 * Rendered inside the expanded QuoteCard body. Three states the tradie
 * can pick:
 *   • Inherit (null) — use the tenant-level pricing_book.quote_display
 *     (Phase A default). Reads naturally to most tradies — "I set my
 *     default once; this quote follows it."
 *   • Itemised — force the per-line breakdown for THIS quote.
 *   • Summary — force the rolled-up summary for THIS quote.
 *
 * Saves via PATCH /api/quote/[id]/display-mode (lightweight; no Stripe
 * regen, no grounding revalidation). The customer page reads the value
 * on next refresh — no notify SMS goes out (this is a presentation
 * change, not a price change).
 */
function QuoteDisplayModeToggle({
  quoteId,
  initial,
  accessToken,
}: {
  quoteId: string
  initial: 'itemised' | 'summary' | null
  accessToken: string | null
}) {
  type Mode = 'itemised' | 'summary' | null
  const [value, setValue] = useState<Mode>(initial)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function save(next: Mode) {
    if (next === value) return
    setError(null)
    setSubmitting(true)
    const previous = value
    setValue(next) // optimistic
    try {
      // Mint a FRESH token immediately before the fetch — the accessToken
      // prop is captured once at dashboard mount and a Clerk session token
      // expires ~60s later, so reusing it on a later toggle click 401s.
      const token = (await getAuthToken()) ?? accessToken
      if (!token) {
        setValue(previous)
        setError('Not signed in')
        return
      }
      const res = await fetch(`/api/quote/${encodeURIComponent(quoteId)}/display-mode`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_mode: next }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        display_mode?: Mode
        error?: string
      }
      if (!res.ok || !json.ok) {
        setValue(previous) // rollback on failure
        setError(json.error || `HTTP ${res.status}`)
      } else {
        setValue((json.display_mode as Mode) ?? null)
        setSavedAt(Date.now())
      }
    } catch (e: any) {
      setValue(previous)
      setError(e?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  const Btn = ({
    label,
    mode,
    title,
  }: {
    label: string
    mode: Mode
    title: string
  }) => {
    const selected = value === mode
    return (
      <button
        type="button"
        title={title}
        disabled={submitting}
        aria-busy={submitting}
        onClick={() => void save(mode)}
        className={` text-[0.6rem] uppercase tracking-[0.08em] font-bold px-2.5 py-1.5 border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
 selected
 ? 'border-accent bg-accent/15 text-accent'
 : 'border-ink-line text-text-dim hover:border-accent/40 hover:text-text-pri'
 }`}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
        Layout for this quote:
      </span>
      <div className="flex flex-wrap items-center gap-1">
        <Btn label="Inherit default" mode={null} title="Use the tenant-level layout preference (Pricing → Customer quote layout)." />
        <Btn label="Itemised" mode="itemised" title="Force the per-line breakdown for this quote only." />
        <Btn label="Summary" mode="summary" title="Force the rolled-up summary for this quote only." />
      </div>
      {submitting && (
        <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
          Saving…
        </span>
      )}
      {!submitting && savedAt && Date.now() - savedAt < 3000 && (
        <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent">
          ✓ Saved
        </span>
      )}
      {error && (
        <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-warning">
          {error}
        </span>
      )}
    </div>
  )
}

/** Small neutral pill rendered in card headers to make the channel of origin
 *  unambiguous: an SMS thread vs. a voice-call transcript look similar in the
 *  expanded view, so the badge prevents the tradie from misreading one for the
 *  other. The label alone carries the signal — no colour (the old emerald/
 *  violet fills sat outside the Maintain palette). */
function ChannelBadge({ channel }: { channel: 'sms' | 'voice' }) {
  // Neutral mono chip — the label carries the meaning. The old emerald/violet
  // fills sat outside the Maintain palette and were the loudest source of the
  // "colourful filler" look.
  return (
    <span className="rounded-ctl inline-flex items-center border border-ink-line px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-[0.08em] text-text-dim">
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
      <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim font-bold mb-2 flex items-center justify-between">
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
                <div className="mt-1 text-[0.55rem] uppercase tracking-[0.08em] text-text-dim">
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
  // 'quote' = a drafted quote to chase; 'lead' = a customer who texted in
  // but never got a quote (sourced from sms_conversations). Leads have no
  // quote_id — Call/Text/Messages work off the conversation instead, and
  // the quote-only actions (Open quote / Log touch / History) are hidden.
  kind: 'quote' | 'lead'
  quote_id: string | null
  conversation_id: string | null
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

/** Stable per-row key that works for both quotes and no-quote leads —
 *  used for React keys and all the row-level open/busy state maps. */
function followupRowId(f: FollowupItem): string {
  return f.kind === 'lead'
    ? `lead:${f.conversation_id ?? ''}`
    : (f.quote_id ?? '')
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
  // Phase 2b — product attributes. Holds keys this form does not own
  // (e.g. `amperage` from a GPO backfill), so it is merged server-side.
  properties: Record<string, unknown> | null
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
    // Mint a fresh token per request — the captured accessToken prop is
    // stale for Clerk users (~60s default session-token lifetime), and
    // this runs on later file-pick / commit actions. Fall back to the prop.
    const token = (await getAuthToken()) ?? accessToken
    const res = await fetch('/api/supplier-catalogue/import', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
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
    <div className="rounded-card border border-ink-line bg-ink-deep">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold text-text-pri hover:text-accent transition-colors cursor-pointer"
        >
          {open ? '▲' : '▼'} Upload products via CSV
        </button>
        <a
          href="/docs/supplier-catalogue-template.csv"
          download
          className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-accent transition-colors"
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
            <label className="rounded-ctl inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors cursor-pointer">
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
            <div className="rounded-ctl border border-warning-bright/40 bg-ink-card px-3 py-2 text-sm text-text-sec">
              {err}
            </div>
          )}
          {msg && (
            <div className="rounded-ctl border border-accent/40 bg-ink-card px-3 py-2 text-sm text-accent">
              {msg}
            </div>
          )}

          {report && (
            <div className="space-y-3">
              {/* Dry-run summary. */}
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.65rem] uppercase tracking-[0.08em]">
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
                <div className="rounded-card bg-ink-card border border-ink-line max-h-44 overflow-y-auto">
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
                  className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? 'Importing…' : `Confirm import (${report.summary.toInsert} new)`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={reset}
                  className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim hover:text-text-pri transition-colors cursor-pointer disabled:opacity-40"
                >
                  Cancel
                </button>
                {report.summary.toInsert === 0 && (
                  <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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

// A4 — Catalogue COVERAGE panel rendered inside CatalogueTab, above the
// "Product catalogue" card. Fetches /api/tenant/catalogue/coverage and
// renders per-trade rollups: "Plumbing — 1 of 8 categories covered, 24
// shared rows missing", with a "Show gaps" expander per trade that lists
// every missing category and a "Browse supplier catalogue" button that
// jumps the user to the browse tab (no auto-filtering yet — they pick
// the category chip themselves once on the browse tab).
type CoverageReportClient = {
  ok: boolean
  trades_active: string[]
  by_trade: Array<{
    trade: string
    total_shared_categories: number
    covered_categories: number
    uncovered_categories: number
    missing_rows_total: number
    coverage_pct: number
    categories: Array<{
      category: string
      shared_count: number
      tenant_count: number
      missing_count: number
      covered: boolean
    }>
  }>
}

function CoveragePanel({
  accessToken,
  onJumpToBrowse,
  lockTrade,
}: {
  accessToken: string | null
  onJumpToBrowse: () => void
  /** Trade-hub mode: report coverage for this trade only. */
  lockTrade?: string
}) {
  const [report, setReport] = useState<CoverageReportClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // Which trade rows are expanded (showing the per-category gap list).
  // Start collapsed so the panel reads as a tight summary.
  const [openTrades, setOpenTrades] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!accessToken) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      setLoading(true)
      setErr(null)
      try {
        // Dual-auth: mint a fresh token immediately before the fetch. Clerk's
        // default session token expires ~60s after capture, and this panel
        // loads when its tab opens (well after mount), so the captured prop
        // can be stale -> 401. Fall back to the prop for legacy Supabase.
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/tenant/catalogue/gaps', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(b.error || `HTTP ${res.status}`)
        }
        const json = (await res.json()) as CoverageReportClient
        if (!cancelled) setReport(json)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken])

  function toggleTrade(trade: string) {
    setOpenTrades((prev) => {
      const next = new Set(prev)
      if (next.has(trade)) next.delete(trade)
      else next.add(trade)
      return next
    })
  }

  if (loading) {
    return (
      <div className="qm-loading rounded-card mb-6 border border-ink-line bg-ink-card p-4 text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
        Loading coverage…
      </div>
    )
  }
  if (err) {
    return (
      <div className="mb-6 border border-warning/50 bg-ink-card p-4">
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-1">
          Couldn&apos;t load coverage
        </div>
        <p className="text-xs text-text-sec">{err}</p>
      </div>
    )
  }
  const visibleTradeReports = (report?.by_trade ?? []).filter(
    (t) => !lockTrade || t.trade === lockTrade,
  )
  if (!report || visibleTradeReports.length === 0) return null

  return (
    <div className="rounded-card mb-6 border border-ink-line bg-ink-card">
      <div className="px-4 py-3 border-b border-ink-line flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-extrabold">
          Coverage
        </h3>
        <p className="text-[0.65rem] text-text-dim uppercase tracking-[0.08em]">
          Shared catalogue rows you have vs you don&apos;t
        </p>
      </div>
      <div className="divide-y divide-ink-line">
        {visibleTradeReports.map((t) => {
          const isOpen = openTrades.has(t.trade)
          const tradeLabel = t.trade.charAt(0).toUpperCase() + t.trade.slice(1)
          // Categories sorted: uncovered first (most actionable), then covered with missing rows, then fully stocked
          const sortedCats = [...t.categories]
            .filter((c) => c.shared_count > 0)
            .sort((a, b) => {
              if (a.covered !== b.covered) return a.covered ? 1 : -1
              if (a.missing_count !== b.missing_count)
                return b.missing_count - a.missing_count
              return a.category.localeCompare(b.category)
            })
          return (
            <div key={t.trade}>
              <button
                type="button"
                onClick={() => toggleTrade(t.trade)}
                className="w-full flex items-center justify-between gap-4 px-4 py-3 hover:bg-ink-deep transition-colors cursor-pointer text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-text-dim font-mono text-[0.65rem]">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="font-semibold text-text-pri text-sm">{tradeLabel}</span>
                  <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
                    {t.covered_categories} of {t.total_shared_categories} categories
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {t.missing_rows_total > 0 && (
                    <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-warning">
                      {t.missing_rows_total} shared row{t.missing_rows_total === 1 ? '' : 's'} missing
                    </span>
                  )}
                  <span
                    className={`font-mono text-sm font-extrabold tabular-nums ${
                      t.coverage_pct >= 80
                        ? 'text-accent'
                        : t.coverage_pct >= 40
                          ? 'text-text-pri'
                          : 'text-warning'
                    }`}
                  >
                    {t.coverage_pct}%
                  </span>
                </div>
              </button>
              {isOpen && (
                <div className="bg-ink-deep border-t border-ink-line">
                  {sortedCats.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-text-dim">
                      No shared catalogue categories for {tradeLabel.toLowerCase()} yet.
                    </p>
                  ) : (
                    <>
                      <ul className="divide-y divide-ink-line">
                        {sortedCats.map((c) => (
                          <li
                            key={c.category}
                            className="px-4 py-2 flex items-center justify-between gap-4"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  c.covered ? 'bg-accent' : 'bg-warning/70'
                                }`}
                                aria-label={c.covered ? 'covered' : 'not covered'}
                              />
                              <span className=" text-[0.7rem] text-text-pri uppercase tracking-[0.06em]">
                                {c.category}
                              </span>
                            </div>
                            <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim shrink-0">
                              {c.tenant_count} of {c.shared_count}
                              {c.missing_count > 0 && (
                                <span className="ml-2 text-warning">
                                  · {c.missing_count} missing
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="px-4 py-3 border-t border-ink-line">
                        <button
                          type="button"
                          onClick={onJumpToBrowse}
                          className=" text-[0.65rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/50 text-accent hover:bg-accent/10 transition-colors cursor-pointer"
                        >
                          + Browse supplier catalogue
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
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
  lockTrade,
}: {
  accessToken: string | null
  onAdded: () => void
  /** Trade-hub mode: only this trade's supplier SKUs are browsable, so a
   *  bulk-add can never land rows in a trade the hub doesn't show. */
  lockTrade?: string
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
  // Free-text keyword search, ANDed with the trade/category/brand chips.
  // Matches across name / brand / range / category / supplier / description
  // so a tradie can type "clipsal downlight" and narrow the list fast.
  const [search, setSearch] = useState('')
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
      // Dual-auth: mint a FRESH token per fetch — the Clerk session token in
      // the accessToken prop expires ~60s after mount, so reusing it here 401s.
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/supplier-catalogue', {
        headers: { Authorization: `Bearer ${token}` },
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
      // Dual-auth: this POST is interaction-driven (fires when the tradie
      // clicks Add, often >60s after mount), so the captured Clerk token is
      // stale — mint a fresh one per request.
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/catalogue/bulk-add', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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

  // lockTrade (hub mode) narrows BEFORE anything else — the trade chips
  // then collapse to the single locked trade automatically.
  const rows = (supplierRows ?? []).filter((r) => !lockTrade || r.trade === lockTrade)
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
  // Lower-cased search terms — split on whitespace so a multi-word query
  // ("hunter fan") matches when every term appears somewhere in the row.
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = rows
    .filter((r) => tradeFilter === 'all' || r.trade === tradeFilter)
    .filter((r) => categoryFilter === 'all' || r.category === categoryFilter)
    .filter((r) => brandFilter === 'all' || r.brand === brandFilter)
    .filter((r) => {
      if (searchTerms.length === 0) return true
      const haystack = [
        r.name,
        r.brand,
        r.range_series,
        r.category,
        r.supplier_label,
        r.description,
        r.trade,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchTerms.every((t) => haystack.includes(t))
    })

  if (loading) {
    return (
      <div className="qm-loading text-[0.7rem] uppercase tracking-[0.08em] text-text-dim py-10">
        Loading supplier catalogue…
      </div>
    )
  }
  if (err) {
    return (
      <div className="rounded-card mt-4 border border-warning-bright/40 bg-ink-card p-6">
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-2">
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
        <div className="rounded-card bg-ink-card/40 border border-dashed border-ink-line p-6">
          <p className="text-sm text-text-sec">
            The supplier catalogue is empty for your trade(s). Upload a CSV above to
            populate it, or ask QuoteMax to add a brand.
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
      <div className="flex flex-wrap items-center gap-2 text-[0.65rem] uppercase tracking-[0.08em]">
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

      {/* Action bar — match count, keyword search, and the add-selected
         button. The search box narrows `filtered` live and ANDs with the
         trade/category/brand chips above. */}
      <div className="rounded-card flex flex-wrap items-center justify-between gap-3 border border-ink-line bg-ink-deep px-4 py-3">
        <div className="text-xs text-text-sec">
          {filtered.length} matching · <span className="text-text-pri font-semibold">{selected.size} selected</span>
        </div>

        {/* Keyword search. */}
        <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-xs">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            inputMode="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search materials…"
            aria-label="Search supplier catalogue"
            className="rounded-ctl w-full bg-ink-card border border-ink-line pl-8 pr-8 py-1.5 text-sm text-text-pri placeholder:text-text-dim/70 focus:border-accent/60 focus:outline-none transition-colors"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-accent transition-colors cursor-pointer text-sm leading-none"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          {addMsg && (
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent">
              {addMsg}
            </span>
          )}
          <button
            type="button"
            disabled={selected.size === 0 || adding}
            onClick={() => void addSelected()}
            className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {adding ? 'Adding…' : `+ Add ${selected.size || ''} to my catalogue`}
          </button>
        </div>
      </div>

      {/* Empty state — search / filters matched nothing. */}
      {filtered.length === 0 && (
        <div className="rounded-card border border-dashed border-ink-line bg-ink-card/40 px-4 py-6 text-sm text-text-sec">
          No materials match{' '}
          {searchTerms.length > 0 ? (
            <>&ldquo;<span className="text-text-pri">{search.trim()}</span>&rdquo;</>
          ) : (
            'these filters'
          )}
          .{' '}
          {(searchTerms.length > 0 ||
            tradeFilter !== 'all' ||
            categoryFilter !== 'all' ||
            brandFilter !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setSearch('')
                setTradeFilter('all')
                setCategoryFilter('all')
                setBrandFilter('all')
              }}
              className="text-accent hover:underline cursor-pointer"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Rows. */}
      <div className="space-y-1">
        {filtered.map((r) => {
          const stocked = alreadyStocked.has(r.id)
          const isSelected = selected.has(r.id)
          const isExpanded = expanded.has(r.id)
          return (
            <div
              key={r.id}
              className={`rounded-card border transition-colors ${
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
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] text-text-dim border border-ink-line px-1.5 py-0.5">
                          {r.tier_hint}
                        </span>
                      )}
                      {stocked && (
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] text-accent border border-accent/40 px-1.5 py-0.5">
                          ✓ in your catalogue
                        </span>
                      )}
                    </div>
                    <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim mt-1">
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
                  className="shrink-0 mt-0.5 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim hover:text-accent transition-colors cursor-pointer px-2 py-1"
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
                    <div className="rounded-card w-28 h-28 sm:w-32 sm:h-32 border border-ink-line bg-ink-card/40 flex items-center justify-center overflow-hidden">
                      {r.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.image_url}
                          alt={r.name}
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] text-text-dim text-center px-2">
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
                      <div className=" text-[0.55rem] uppercase tracking-[0.08em] text-text-dim mb-1">
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
                    <div className=" text-[0.55rem] uppercase tracking-[0.08em] text-accent mb-1">
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
      <div className=" text-[0.55rem] uppercase tracking-[0.08em] text-text-dim mb-0.5">
        {label}
      </div>
      <div
        className={`${mono ? 'font-mono text-xs' : 'text-sm'} text-text-pri leading-snug truncate`}
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

function TierLadderPanel({
  accessToken,
  lockTrade,
}: {
  accessToken: string | null
  /** Trade-hub mode: only categories stocked with this trade's products. */
  lockTrade?: string
}) {
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
      // Dual-auth: mint a fresh token per fetch — a Clerk session token
      // captured at mount (accessToken prop) expires ~60s later → 401.
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/tier-ladder', {
        headers: { Authorization: `Bearer ${token}` },
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
      // Dual-auth: fresh token per save — the captured accessToken prop is a
      // ~60s Clerk session token that will 401 after it expires.
      const token = (await getAuthToken()) ?? accessToken
      if (!catalogueId) {
        // Empty selection = delete the slot.
        const res = await fetch(
          `/api/tenant/tier-ladder?category=${encodeURIComponent(category)}&tier=${tier}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        )
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(b.error || `HTTP ${res.status}`)
        }
      } else {
        const res = await fetch('/api/tenant/tier-ladder', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
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
      <div className="qm-loading mt-4 text-[0.7rem] uppercase tracking-[0.08em] text-text-dim py-6">
        Loading tier ladder…
      </div>
    )
  }
  if (err) {
    return (
      <div className="rounded-card mt-4 border border-warning-bright/40 bg-ink-card p-6">
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-2">
          Couldn&apos;t load tier ladder
        </div>
        <p className="text-sm text-text-sec">{err}</p>
      </div>
    )
  }

  // Categories with at least one catalogue product. If the tenant has
  // no stocked products, nothing to pick from — point them at Stock-the-
  // essentials / Browse instead of showing empty dropdowns.
  // LadderRow has no trade column; a category belongs to the locked trade
  // when its catalogue products do (electrical/plumbing category sets are
  // disjoint, so any-match is unambiguous).
  const categoriesWithProducts = Object.keys(catalogueByCategory)
    .filter(
      (c) => !lockTrade || (catalogueByCategory[c] ?? []).some((r) => r.trade === lockTrade),
    )
    .sort()
  if (categoriesWithProducts.length === 0) {
    return (
      <div className="rounded-card mt-4 bg-ink-card/40 border border-dashed border-ink-line p-6">
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
      <div className="rounded-ctl border border-accent/30 bg-ink-card/40 px-4 py-3">
        <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent mb-1">
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
              <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-text-pri font-bold mb-3">
                {cat} <span className="text-text-dim font-normal">({products.length} stocked)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {TIERS.map((tier) => {
                  const key = `${cat}::${tier}`
                  const current = slotsByKey.get(key)?.catalogue_id ?? ''
                  return (
                    <label key={tier} className="flex flex-col gap-1">
                      <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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

function CatalogueTab({
  accessToken,
  tradeFilter,
}: {
  accessToken: string | null
  /** Trade-hub mode: show only this trade's catalogue rows. Unset = all
   *  trades (legacy cross-trade view, kept for deep links). */
  tradeFilter?: TradeHubSlug
}) {
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
    // Phase 2b — string-encoded like is_preferred, because `set` takes a string.
    smart: '',
    dimmable: '',
    integrated_driver: '',
    unit: 'each',
  }
  const [form, setForm] = useState({ ...blankForm })
  // null = not editing (form is in "add" mode). A row id = editing that
  // row (form is prefilled, submit PATCHes instead of POSTs).
  const [editingId, setEditingId] = useState<string | null>(null)
  // 'all' or a Category value — narrows the visible list to one category.
  // Filter chips below the header drive this; persisted only in memory.
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  // Free-text search across name / brand / range / supplier so a big
  // catalogue is one keystroke from the product you want.
  const [search, setSearch] = useState('')
  // Pagination — 10 products per page; resets when the filters change.
  const [catPage, setCatPage] = useState(0)
  useEffect(() => {
    setCatPage(0)
  }, [search, categoryFilter])

  const load = useCallback(async () => {
    const token = (await getAuthToken()) ?? accessToken
    if (!token) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tenant/catalogue', {
        headers: { Authorization: `Bearer ${token}` },
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token) return
    setBusyId(row.id)
    const next = !row.active
    setRows((p) => (p ? p.map((r) => (r.id === row.id ? { ...r, active: next } : r)) : p))
    try {
      const res = await fetch(`/api/tenant/catalogue/${row.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token || essentialsBusy) return
    setEssentialsBusy(true)
    setEssentialsMsg(null)
    try {
      const res = await fetch('/api/tenant/catalogue/stock-essentials', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token) return
    if (!window.confirm(`Delete "${row.name}" from your catalogue?`)) return
    setBusyId(row.id)
    try {
      const res = await fetch(`/api/tenant/catalogue/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token) return
    setSaving(true)
    setFormErr(null)
    try {
      const res = await fetch('/api/tenant/catalogue', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
          properties: {
            smart: form.smart === 'yes',
            dimmable: form.dimmable === 'yes',
            integrated_driver: form.integrated_driver === 'yes',
          },
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
      // Phase 2b — prefill from the stored jsonb, else editing a tagged product
      // would silently clear its attributes on save.
      smart: row.properties?.smart === true ? 'yes' : '',
      dimmable: row.properties?.dimmable === true ? 'yes' : '',
      integrated_driver: row.properties?.integrated_driver === true ? 'yes' : '',
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token || !editingId) return
    setSaving(true)
    setFormErr(null)
    try {
      const optMoney = (v: string) => {
        const t = v.trim()
        return t === '' ? null : t
      }
      const res = await fetch(`/api/tenant/catalogue/${editingId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
          properties: {
            smart: form.smart === 'yes',
            dimmable: form.dimmable === 'yes',
            integrated_driver: form.integrated_driver === 'yes',
          },
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
    const token = (await getAuthToken()) ?? accessToken
    if (!token) return
    setUploading(true)
    setFormErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/tenant/catalogue/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
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
      <Card>
        <p className="qm-loading text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
          Loading catalogue…
        </p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-2">
          Couldn&apos;t load catalogue
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </Card>
    )
  }

  // Trade-hub mode: scope everything (rows, chips, counts, grouping) to
  // one trade before any category filtering runs.
  const list = tradeFilter
    ? (rows ?? []).filter((r) => (r.trade ?? '').toLowerCase() === tradeFilter)
    : (rows ?? [])

  // Per-category counts off the unfiltered list so the chip labels stay
  // stable as the user clicks between filters (otherwise "All (12)" would
  // flicker to "All (3)" when narrowed).
  const counts = new Map<string, number>()
  for (const r of list) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)

  const catSearch = search.trim().toLowerCase()
  const filtered = list.filter((r) => {
    if (categoryFilter !== 'all' && r.category !== categoryFilter) return false
    if (catSearch) {
      const hay = `${r.name} ${r.brand ?? ''} ${r.range_series ?? ''} ${
        r.supplier ?? ''
      }`.toLowerCase()
      if (!hay.includes(catSearch)) return false
    }
    return true
  })
  // Paginate at 10 — the (trade, category) grouping below runs on the
  // page slice, so the visible page is always at most 10 products.
  const CAT_PAGE_SIZE = 10
  const catPageCount = Math.max(1, Math.ceil(filtered.length / CAT_PAGE_SIZE))
  const catSafePage = Math.min(catPage, catPageCount - 1)
  const pagedFiltered = filtered.slice(
    catSafePage * CAT_PAGE_SIZE,
    catSafePage * CAT_PAGE_SIZE + CAT_PAGE_SIZE,
  )

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
  // Phase 2 R2 — the select now saves material vocabulary (ceiling_fan,
  // safety_switch, …), which CATEGORIES does not contain. Without this fallback
  // those rows would group under their raw value instead of a label. Both lists
  // are consulted rather than swapped: legacy rows still hold CATEGORIES values.
  const categoryLabel = (v: string) =>
    CATEGORIES.find((c) => c.value === v)?.label ??
    materialCategoriesFor(undefined).find((c) => c.value === v)?.label ??
    v

  const groupMap = new Map<
    string,
    { trade: string; category: string; items: CatalogueRow[] }
  >()
  for (const r of pagedFiltered) {
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

  // Hub mode for a trade the tenant-catalogue API doesn't support
  // (MaterialCatalogueSchema's TRADE_ENUM is electrical|plumbing): the
  // full catalogue UI would be a dead end — a permanently empty scoped
  // list, an add form that can only misfile or 400, and supplier
  // browse/ladder panels spanning other trades. Point at the tool
  // settings instead.
  if (tradeFilter && tradeFilter !== 'electrical' && tradeFilter !== 'plumbing') {
    return (
      <Card title="Product catalogue">
        <p className="text-sm text-text-sec">
          No product catalogue for this trade yet — the supplier catalogue
          covers electrical and plumbing. This trade&rsquo;s materials are
          priced through its tool settings and rate cards.
        </p>
      </Card>
    )
  }

  return (
    <>
      <CoveragePanel
        accessToken={accessToken}
        onJumpToBrowse={() => setViewMode('browse')}
        lockTrade={tradeFilter}
      />
    <Card title="Product catalogue">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-xs text-text-dim leading-snug max-w-2xl">
          Your real branded products and prices. The AI quotes these ahead of generic items and
          maps brand + range to a tier (e.g. Clipsal Iconic → Better, Clipsal 2000 → Good).
          Off rows are never offered. {list.length} product{list.length === 1 ? '' : 's'}.
        </p>
        {viewMode === 'mine' && (
          <button
            type="button"
            onClick={() => {
              if (showForm) {
                closeForm()
              } else {
                // Hub mode: a new product always belongs to the hub's
                // trade, otherwise it would vanish from the scoped list.
                setForm({ ...blankForm, trade: tradeFilter ?? form.trade })
                setEditingId(null)
                setShowForm(true)
                setFormErr(null)
              }
            }}
            className="shrink-0 text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/50 text-accent hover:bg-accent/10 transition-colors cursor-pointer"
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
          className={` text-[0.65rem] uppercase tracking-[0.08em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
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
          className={` text-[0.65rem] uppercase tracking-[0.08em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
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
          className={` text-[0.65rem] uppercase tracking-[0.08em] px-3 py-2 border-b-2 -mb-px transition-colors cursor-pointer ${
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
          lockTrade={tradeFilter}
          onAdded={() => {
            // After a successful bulk-add, refresh the tenant's own catalogue
            // so the "+ N" count + the My catalogue view reflect the new rows.
            void load()
          }}
        />
      )}

      {viewMode === 'ladder' && (
        <TierLadderPanel accessToken={accessToken} lockTrade={tradeFilter} />
      )}

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
              <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent mb-1">
                {list.length === 0 ? 'Get started in one click' : 'Quick start'}
              </div>
              <div className="text-sm text-text-sec">
                {list.length === 0
                  ? "Your catalogue is empty. Stock the essentials for your trade and the AI can auto-quote your wedge from the next call."
                  : 'Stock common products in one click — covers the most-quoted categories with one good-tier SKU each. Already-stocked items are skipped.'}
              </div>
              {essentialsMsg && (
                <div className="mt-1 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                  {essentialsMsg}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void stockEssentials()}
              disabled={essentialsBusy}
              className="shrink-0 text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
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
          className="rounded-card mt-5 border border-ink-line bg-ink-deep p-4 grid gap-3 sm:grid-cols-2"
        >
          {editingId && (
            <div className="sm:col-span-2 text-[0.65rem] uppercase tracking-[0.08em] text-accent">
              Editing “{form.name || 'product'}” — change anything and save
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Trade</span>
            <select
              value={form.trade}
              onChange={(e) => set('trade', e.target.value)}
              // Hub mode: the trade is fixed by the hub — a different
              // pick would file the product where this view can't show it.
              disabled={!!tradeFilter}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri disabled:opacity-60"
            >
              {tradeFilter ? (
                <option value={tradeFilter}>{tradeFilter}</option>
              ) : (
                <>
                  <option value="electrical">electrical</option>
                  <option value="plumbing">plumbing</option>
                </>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Category</span>
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            >
              <option value="">— choose a category —</option>
              {/* Phase 2 R2 — the real shared_materials vocabulary, scoped to
                  this product's trade. Was CATEGORIES (the grounding list), which
                  offered `fan`, `rcbo` and `sundry` — none of which any material
                  row uses. Both selects had to change together: they currently
                  agree on `fan`, so three of this tenant's fans price correctly
                  by accident. Fixing only Recipes would break them. */}
              {materialCategoriesFor(form.trade).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-[0.65rem] text-text-dim leading-snug">
              What this product actually is. The AI matches it to the same category on your
              Recipes, so a job that needs this part prices from your product and your price.
            </span>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Product name</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Clipsal Iconic GPO"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Brand</span>
            <input
              value={form.brand}
              onChange={(e) => set('brand', e.target.value)}
              placeholder="Clipsal"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Range / series</span>
            <input
              value={form.range_series}
              onChange={(e) => set('range_series', e.target.value)}
              placeholder="Iconic / 2000"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Supplier</span>
            <input
              value={form.supplier}
              onChange={(e) => set('supplier', e.target.value)}
              placeholder="Reece / Bunnings"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Unit</span>
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Price ex-GST</span>
            <input
              value={form.unit_price_ex_gst}
              onChange={(e) => set('unit_price_ex_gst', e.target.value)}
              inputMode="decimal"
              placeholder="42"
              className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              What this product is
            </span>
            <label className="flex items-center gap-2 text-sm text-text-sec">
              <input
                type="checkbox"
                checked={form.smart === 'yes'}
                onChange={(e) => set('smart', e.target.checked ? 'yes' : '')}
              />
              Smart / app-controlled
            </label>
            <label className="flex items-center gap-2 text-sm text-text-sec">
              <input
                type="checkbox"
                checked={form.dimmable === 'yes'}
                onChange={(e) => set('dimmable', e.target.checked ? 'yes' : '')}
              />
              Dimmable
            </label>
            <label className="flex items-center gap-2 text-sm text-text-sec">
              <input
                type="checkbox"
                checked={form.integrated_driver === 'yes'}
                onChange={(e) => set('integrated_driver', e.target.checked ? 'yes' : '')}
              />
              Driver built in (no separate driver needed)
            </label>
            <span className="text-[0.65rem] text-text-dim leading-snug">
              The AI uses these to pick the right product and to work out which other parts the
              job needs.
            </span>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              Product photo (optional)
            </span>
            <div className="flex flex-wrap items-start gap-3">
              {form.image_path && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={form.image_path}
                  alt="Product photo preview"
                  className="rounded-card h-16 w-16 object-cover border border-ink-line bg-ink-deep shrink-0"
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
                  <label className=" text-[0.6rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-ink-line text-text-sec hover:border-accent/50 hover:text-text-pri transition-colors cursor-pointer">
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
                      className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-warning transition-colors cursor-pointer"
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Tier (optional)</span>
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
              aria-busy={saving}
              className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
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
        <div className="relative mt-5 sm:max-w-xs">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by product, brand, range or supplier…"
            aria-label="Search catalogue"
            className="rounded-ctl w-full bg-ink-deep border border-ink-line pl-10 pr-3 py-2.5 text-sm text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors"
          />
        </div>
      )}

      {list.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim mr-1">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={` text-[0.65rem] uppercase tracking-[0.08em] px-2.5 py-1 border transition-colors cursor-pointer ${
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
              className={` text-[0.65rem] uppercase tracking-[0.08em] px-2.5 py-1 border transition-colors cursor-pointer ${
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
          {catSearch ? (
            <>
              No products match “{search.trim()}”
              {categoryFilter !== 'all' && (
                <> in {categoryLabel(categoryFilter)}</>
              )}
              .{' '}
            </>
          ) : (
            <>
              No products in{' '}
              <span className="text-text-pri">
                {categoryLabel(categoryFilter)}
              </span>
              .{' '}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setCategoryFilter('all')
              setSearch('')
            }}
            className=" text-[0.65rem] uppercase tracking-[0.08em] text-accent hover:underline cursor-pointer"
          >
            {catSearch ? 'Clear search' : 'Show all'}
          </button>
        </p>
      ) : (
        <div className="mt-6 space-y-5">
          {groups.map((g) => (
            <div key={`${g.trade}·${g.category}`}>
              <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pb-1 flex items-baseline gap-2">
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
                    className={`rounded-card border px-4 py-3 flex items-start justify-between gap-4 ${
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
                        <div className="mt-1 text-[0.65rem] uppercase tracking-[0.08em] text-text-dim flex flex-wrap items-center gap-x-3 gap-y-1">
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
                          className={`rounded-card relative inline-block h-5 w-10 border transition-colors ${
                            r.active
                              ? 'border-accent bg-accent/20'
                              : 'border-ink-line bg-ink group-hover:border-text-dim'
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
                        aria-busy={busyId === r.id}
                        className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-accent transition-colors cursor-pointer disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r)}
                        disabled={busyId === r.id}
                        aria-busy={busyId === r.id}
                        className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
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
      <Pagination
        page={catSafePage}
        pageCount={catPageCount}
        onPage={setCatPage}
      />
        </>
      )}
    </Card>
    </>
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
// Phase 3 — the step checklist per job (migration 184). Scope-of-works only:
// no price and no hours, so these never reach the estimator. Labour stays on
// shared_assemblies.default_labour_hours.
type TaskLineRow = {
  id: string
  assembly_id: string
  trade: string
  title: string
  notes: string | null
  required: boolean
  sort: number
}
type BaselineTask = {
  title: string
  notes: string | null
  required: boolean
  sort: number
}

function RecipesTab({
  accessToken,
  tradeFilter,
}: {
  accessToken: string | null
  /** Trade-hub mode: only this trade's job recipes appear in the picker.
   *  Unset = all trades (legacy cross-trade view, kept for deep links). */
  tradeFilter?: TradeHubSlug
}) {
  const [assemblies, setAssemblies] = useState<AsmOpt[]>([])
  const [lines, setLines] = useState<BomLineRow[] | null>(null)
  const [baselines, setBaselines] = useState<Record<string, BaselineLine[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string>('')
  // Narrows the job picker — typing filters the dropdown options so a
  // long job list isn't a scroll-hunt.
  const [jobQuery, setJobQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [forking, setForking] = useState(false)
  const [forkErr, setForkErr] = useState<string | null>(null)
  // R38 — catalogue gaps reported by the most recent fork, mapped to a
  // per-line lookup (lib/dashboard/fork-gaps.ts). Drives the per-line
  // "add a product" callout + the post-fork summary banner. Cleared when
  // the selected job changes so a stale gap report can't bleed across jobs.
  const [forkGaps, setForkGaps] = useState<ForkGapDisplay | null>(null)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [draftQty, setDraftQty] = useState<Record<string, string>>({})
  // Categories this tradie has a priced, active Catalogue product for —
  // used to badge each recipe line so a Catalogue↔Recipe mismatch is
  // visible instead of silently costing them their real product + price.
  const [catalogueCatsByTrade, setCatalogueCatsByTrade] = useState<Record<string, string[]>>({})
  const blank = { material_category: '', quantity: '1', required: true, description: '' }
  const [form, setForm] = useState({ ...blank })
  // Phase 3 — the step checklist, on its own endpoint and its own error
  // channel so a tasks outage never blanks the parts list.
  const [tasks, setTasks] = useState<TaskLineRow[] | null>(null)
  const [taskBaselines, setTaskBaselines] = useState<Record<string, BaselineTask[]>>({})
  const [taskErr, setTaskErr] = useState<string | null>(null)
  const [taskBusyId, setTaskBusyId] = useState<string | null>(null)
  const [taskSaving, setTaskSaving] = useState(false)
  const [taskForking, setTaskForking] = useState(false)
  const [taskFormErr, setTaskFormErr] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState<Record<string, string>>({})
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({})
  const blankTask = { title: '', notes: '', required: true }
  const [taskForm, setTaskForm] = useState({ ...blankTask })

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/bom', {
        headers: { Authorization: `Bearer ${token}` },
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
        catalogue_categories_by_trade?: Record<string, string[]>
      }
      setAssemblies(json.assemblies)
      setLines(json.lines)
      setBaselines(json.baselines ?? {})
      setCatalogueCatsByTrade(json.catalogue_categories_by_trade ?? {})
      setSelectedId((cur) => {
        // Trade-hub mode: default (and heal) the selection within this
        // trade's recipes only, so an electrical hub never lands on a
        // plumbing job.
        const pool = tradeFilter
          ? json.assemblies.filter((a) => (a.trade ?? '').toLowerCase() === tradeFilter)
          : json.assemblies
        if (cur && pool.some((a) => a.id === cur)) return cur
        return pool[0]?.id ?? ''
      })

      // Phase 3 — steps come from their own endpoint. Its own try/catch:
      // migration 184 lands separately from this code, and a missing table
      // must not take the parts list down with it.
      try {
        const tres = await fetch('/api/tenant/tasks', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!tres.ok) {
          const tb = (await tres.json().catch(() => ({}))) as { error?: string }
          throw new Error(tb.error || `HTTP ${tres.status}`)
        }
        const tjson = (await tres.json()) as {
          lines?: TaskLineRow[]
          baselines?: Record<string, BaselineTask[]>
        }
        setTasks(tjson.lines ?? [])
        setTaskBaselines(tjson.baselines ?? {})
        setTaskErr(null)
      } catch (e) {
        setTasks([])
        setTaskErr(e instanceof Error ? e.message : String(e))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  // R38 — a gap report belongs to ONE job's fork. Drop it when the tradie
  // switches jobs so a previous job's gaps never paint the current list.
  useEffect(() => {
    setForkGaps(null)
  }, [selectedId])

  const selectedAsm = assemblies.find((a) => a.id === selectedId) ?? null
  const catalogueCats = selectedAsm
    ? catalogueCatsByTrade[(selectedAsm.trade ?? '').toLowerCase()] ?? []
    : []
  // Trade-hub mode: scope the picker to one trade before the name search.
  const tradeAssemblies = tradeFilter
    ? assemblies.filter((a) => (a.trade ?? '').toLowerCase() === tradeFilter)
    : assemblies
  const jobPickerList = jobQuery.trim()
    ? tradeAssemblies.filter((a) =>
        a.name.toLowerCase().includes(jobQuery.trim().toLowerCase()),
      )
    : tradeAssemblies
  const jobLines = (lines ?? [])
    .filter((l) => l.assembly_id === selectedId)
    .sort((a, b) => a.sort - b.sort)
  const jobBaseline = (baselines[selectedId] ?? [])
    .slice()
    .sort((a, b) => a.sort - b.sort)
  const jobTasks = (tasks ?? [])
    .filter((t) => t.assembly_id === selectedId)
    .sort((a, b) => a.sort - b.sort)
  const jobTaskBaseline = (taskBaselines[selectedId] ?? [])
    .slice()
    .sort((a, b) => a.sort - b.sort)

  async function forkBaseline() {
    if (!accessToken || !selectedAsm) return
    if (jobLines.length > 0) return // safety: never fork over an existing recipe
    setForking(true)
    setForkErr(null)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/bom/fork', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assembly_id: selectedAsm.id }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        message?: string
        category_gaps?: Array<{ material_category: string; line: number }>
        has_category_gaps?: boolean
        gap_detection_failed?: boolean
      }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      // R38 — capture which forked lines have no matching catalogue product so
      // the per-line callout + summary banner can point at them. mapForkGaps is
      // pure + unit-tested (defensive against missing/failed gap detection).
      setForkGaps(mapForkGaps(json))
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/bom', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(`/api/tenant/bom/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(`/api/tenant/bom/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
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

  // ─── Phase 3 · step checklist ────────────────────────────────────
  // Mirrors the four BOM handlers above. Errors land in taskErr/taskFormErr,
  // never the tab-wide `error`, so a step failure leaves the parts list up.

  async function forkTaskBaseline() {
    if (!accessToken || !selectedAsm) return
    if (jobTasks.length > 0) return // safety: never fork over an existing checklist
    setTaskForking(true)
    setTaskErr(null)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/tasks/fork', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assembly_id: selectedAsm.id }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setTaskErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTaskForking(false)
    }
  }

  async function addTask() {
    if (!accessToken || !selectedAsm) return
    setTaskSaving(true)
    setTaskFormErr(null)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assembly_id: selectedAsm.id,
          trade: selectedAsm.trade,
          title: taskForm.title.trim(),
          notes: taskForm.notes.trim() || undefined,
          required: taskForm.required,
          sort: jobTasks.length + 1,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        message?: string
        line?: TaskLineRow
      }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      setTaskForm({ ...blankTask })
      await load()
    } catch (e) {
      setTaskFormErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTaskSaving(false)
    }
  }

  async function patchTask(id: string, fields: Record<string, unknown>) {
    if (!accessToken) return
    setTaskBusyId(id)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(`/api/tenant/tasks/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        message?: string
        line?: TaskLineRow
      }
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
      if (json.line) {
        setTasks((p) => (p ? p.map((t) => (t.id === id ? json.line! : t)) : p))
      }
    } catch (e) {
      setTaskErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTaskBusyId(null)
    }
  }

  async function deleteTask(id: string) {
    if (!accessToken) return
    if (!window.confirm('Remove this step from the checklist?')) return
    setTaskBusyId(id)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(`/api/tenant/tasks/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      setTasks((p) => (p ? p.filter((t) => t.id !== id) : p))
    } catch (e) {
      setTaskErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTaskBusyId(null)
    }
  }

  // Renumber from 1 rather than swapping two `sort` values: a fork copies the
  // baseline's sorts verbatim, so duplicates are possible and swapping equal
  // numbers is a silent no-op. Iterates a snapshot, so mid-loop state updates
  // can't reshuffle the target order.
  // ponytail: N sequential PATCHes, fine for a checklist. Add a bulk-reorder
  // endpoint if a job ever carries dozens of steps.
  async function moveTask(id: string, dir: -1 | 1) {
    const i = jobTasks.findIndex((t) => t.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= jobTasks.length) return
    const next = jobTasks.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    for (const [k, t] of next.entries()) {
      if (t.sort !== k + 1) await patchTask(t.id, { sort: k + 1 })
    }
  }

  if (loading) {
    return (
      <Card>
        <p className="qm-loading text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
          Loading recipes…
        </p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-2">
          Couldn&apos;t load recipes
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </Card>
    )
  }

  return (
    <Card title="Recipes — your parts list per job">
      <p className="text-xs text-text-dim leading-snug max-w-2xl">
        Define the parts a job always needs so the same job is quoted the same way every time.
        These are{' '}
        <strong className="font-semibold text-text-sec">yours</strong> — editing them never
        affects other tradies. For a job with no recipe here, you can start from our baseline and
        edit it.
      </p>

      <div className="mt-5 flex max-w-md flex-col gap-1.5">
        <span className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-sec">
          Job
        </span>
        <div className="relative">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={jobQuery}
            onChange={(e) => setJobQuery(e.target.value)}
            placeholder="Search jobs…"
            aria-label="Search jobs"
            className="rounded-ctl w-full bg-ink-deep border border-ink-line pl-10 pr-3 py-2 text-sm text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors"
          />
        </div>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          aria-label="Select a job to edit its recipe"
          className="rounded-ctl bg-ink-deep border border-ink-line px-3.5 py-2.5 text-sm text-text-pri focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors"
        >
          {tradeAssemblies.length === 0 && <option value="">No jobs available</option>}
          {tradeAssemblies.length > 0 && jobPickerList.length === 0 && (
            <option value="">No jobs match “{jobQuery.trim()}”</option>
          )}
          {jobPickerList.map((a) => (
            <option key={a.id} value={a.id}>
              {tradeFilter ? a.name : `${a.name} (${a.trade})`}
            </option>
          ))}
        </select>
        {jobQuery.trim() && tradeAssemblies.length > 0 && (
          <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
            {jobPickerList.length} of {tradeAssemblies.length} jobs
          </span>
        )}
      </div>

      {selectedAsm && (
        <div className="mt-6">
          <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pb-2">
            {selectedAsm.name} — recipe
          </div>

          {/* ── Phase 3 · the step checklist for this job ──
              Second panel in the SAME card, reusing selectedAsm, the job
              picker and the trade filter (spec R6 forbids a new tab).
              Sits between the header and the parts list, per spec R6. The
              R38 gap banner stays directly above the parts list it refers to
              ("look for the marker below"), so its reference still holds.
              Steps carry no price and no hours — nothing here is read by
              the estimator. */}
          <div data-testid="steps-panel" className="mt-4 border-b border-ink-line pb-6">
            <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pb-2">
              {selectedAsm.name} — steps
            </div>
            <p className="text-xs text-text-dim leading-snug max-w-2xl">
              The steps this job always involves, in order. They describe the work — they
              don&apos;t change the price or the hours.
            </p>

            {taskErr && (
              <p className="mt-3 text-xs text-warning">
                Couldn&apos;t load or save steps: {taskErr}
              </p>
            )}

            {jobTasks.length === 0 ? (
              jobTaskBaseline.length > 0 ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-text-sec">
                    No saved steps for this job yet — here&apos;s the standard checklist.
                    Hit <strong>Customise these steps</strong> to make it yours and start editing.
                  </p>
                  <div className="space-y-2">
                    {jobTaskBaseline.map((b, i) => (
                      <div
                        key={`${b.title}|${i}`}
                        className="rounded-card border border-ink-line bg-ink-deep px-4 py-3 flex items-start justify-between gap-4 flex-wrap opacity-90"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-text-pri font-medium">
                            {i + 1}. {b.title}
                          </div>
                          {b.notes && (
                            <div className="text-xs text-text-dim mt-0.5">{b.notes}</div>
                          )}
                          <div className="mt-1.5">
                            <span className="inline-block px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]">
                              shared baseline
                            </span>
                          </div>
                        </div>
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border border-ink-line text-text-dim shrink-0">
                          {b.required ? 'required' : 'optional'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap pt-1">
                    <button
                      type="button"
                      onClick={() => void forkTaskBaseline()}
                      disabled={taskForking}
                      className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
                    >
                      {taskForking ? 'Copying steps…' : 'Customise these steps'}
                    </button>
                    <span className="text-[0.65rem] text-text-dim leading-snug">
                      Copies these {jobTaskBaseline.length} step
                      {jobTaskBaseline.length === 1 ? '' : 's'} into your checklist so you can
                      reword, reorder, or add your own.
                    </span>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-sec">
                  No steps yet for this job, and no standard checklist either. Add the steps it
                  always involves below.
                </p>
              )
            ) : (
              <div className="mt-4 space-y-2">
                {jobTasks.map((t, idx) => {
                  const tv = draftTitle[t.id] ?? t.title
                  const nv = draftNotes[t.id] ?? (t.notes ?? '')
                  return (
                    <div
                      key={t.id}
                      className="rounded-card border border-ink-line bg-ink-deep px-4 py-3 flex items-start justify-between gap-4 flex-wrap"
                    >
                      <div className="min-w-0 flex-1 flex items-start gap-3">
                        <span className="font-mono text-[0.7rem] text-text-dim pt-2 shrink-0">
                          {idx + 1}.
                        </span>
                        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                          <input
                            value={tv}
                            aria-label={`Step ${idx + 1} title`}
                            onChange={(e) =>
                              setDraftTitle((d) => ({ ...d, [t.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const v = tv.trim()
                              // Empty is a delete, not a rename — the schema
                              // rejects it. Snap back rather than 400.
                              if (!v) {
                                setDraftTitle((d) => ({ ...d, [t.id]: t.title }))
                                return
                              }
                              if (v !== t.title) void patchTask(t.id, { title: v })
                            }}
                            className="w-full bg-ink-card border border-ink-line px-2.5 py-1.5 text-sm text-text-pri focus:border-accent focus:outline-none"
                          />
                          <input
                            value={nv}
                            aria-label={`Step ${idx + 1} note`}
                            placeholder="Note (optional)"
                            onChange={(e) =>
                              setDraftNotes((d) => ({ ...d, [t.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const v = nv.trim()
                              if (v !== (t.notes ?? '')) void patchTask(t.id, { notes: v })
                            }}
                            className="w-full bg-ink-card border border-ink-line px-2.5 py-1.5 text-xs text-text-sec placeholder:text-text-dim focus:border-accent focus:outline-none"
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => void moveTask(t.id, -1)}
                            disabled={idx === 0 || taskBusyId !== null}
                            aria-label={`Move step ${idx + 1} up`}
                            className="font-mono text-[0.7rem] leading-none px-1.5 py-1 text-text-dim hover:text-accent transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => void moveTask(t.id, 1)}
                            disabled={idx === jobTasks.length - 1 || taskBusyId !== null}
                            aria-label={`Move step ${idx + 1} down`}
                            className="font-mono text-[0.7rem] leading-none px-1.5 py-1 text-text-dim hover:text-accent transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                          >
                            ▼
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => patchTask(t.id, { required: !t.required })}
                          disabled={taskBusyId === t.id}
                          className={` text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border transition-colors cursor-pointer disabled:opacity-50 ${
 t.required
 ? 'border-accent/40 text-accent'
 : 'border-ink-line text-text-dim'
 }`}
                        >
                          {t.required ? 'required' : 'optional'}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteTask(t.id)}
                          disabled={taskBusyId === t.id}
                          className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
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
                void addTask()
              }}
              className="rounded-card mt-4 border border-ink-line bg-ink-deep p-4 grid gap-3 sm:grid-cols-2"
            >
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                  Step
                </span>
                <input
                  value={taskForm.title}
                  onChange={(e) => setTaskForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Isolate the circuit at the switchboard"
                  className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                  Note (optional)
                </span>
                <input
                  value={taskForm.notes}
                  onChange={(e) => setTaskForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. test and tag before touching anything"
                  className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-text-sec">
                <input
                  type="checkbox"
                  checked={taskForm.required}
                  onChange={(e) => setTaskForm((f) => ({ ...f, required: e.target.checked }))}
                />
                Required step (always done)
              </label>
              {taskFormErr && <p className="sm:col-span-2 text-xs text-warning">{taskFormErr}</p>}
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={taskSaving || !taskForm.title.trim()}
                  className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
                >
                  {taskSaving ? 'Adding…' : '+ Add step to this job'}
                </button>
              </div>
            </form>
          </div>

          {/* The parts half keeps its own label now that the steps panel sits
              above it — otherwise these rows read as unlabelled under the
              card-level "— recipe" heading. */}
          <div className="mt-6 text-[0.7rem] uppercase tracking-[0.08em] text-accent font-bold pb-2">
            {selectedAsm.name} — parts
          </div>

          {/* R38 — post-fork catalogue-gap summary. Shown right after a fork so
              the tradie knows up front how many copied lines fall back to a
              generic price (or that we couldn't verify coverage). The per-line
              callouts below pinpoint each one. */}
          {forkGaps && (forkGaps.count > 0 || forkGaps.detectionFailed) && (
            <div className="mb-3 border border-warning/50 bg-warning/5 px-4 py-3">
              <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-warning mb-1">
                {forkGaps.detectionFailed
                  ? 'Catalogue check skipped'
                  : `${forkGaps.count} line${forkGaps.count === 1 ? '' : 's'} need a catalogue product`}
              </div>
              <p className="text-xs text-text-sec leading-snug">
                {forkGaps.detectionFailed
                  ? "We couldn't check your catalogue for this recipe — some lines may fall back to a generic price."
                  : 'These copied lines have no matching product in your catalogue, so the AI will use a generic price until you add one in the Catalogue tab. Look for the “add a product for this line” marker below.'}
              </p>
            </div>
          )}

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
                      className="rounded-card border border-ink-line bg-ink-deep px-4 py-3 flex items-center justify-between gap-4 flex-wrap opacity-90"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-text-pri font-medium">
                          {b.material_category}
                        </div>
                        {b.description && (
                          <div className="text-xs text-text-dim mt-0.5">{b.description}</div>
                        )}
                        <div className="mt-1.5">
                          <span className="inline-block px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]">
                            shared baseline
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-text-dim">
                        <span className=" text-[0.6rem] uppercase tracking-[0.08em]">
                          qty {Number(b.quantity)}
                        </span>
                        <span className=" text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border border-ink-line">
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
                    className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
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
              {jobLines.map((l, idx) => {
                const qv = draftQty[l.id] ?? String(Number(l.quantity))
                // R37 — single shared badge resolver so Catalogue/Estimating/
                // Recipes can never disagree on "priced vs generic".
                const badge = resolveCatalogueBadge(l.material_category, catalogueCats)
                // R38 — overlay the just-forked catalogue gap. The fork route
                // reports gaps by 1-based line (sort) position; jobLines is
                // already sorted by `sort`, so idx+1 matches. We also accept a
                // category match (defensive against a reorder between fork and
                // render).
                const forkGapHere =
                  !!forkGaps &&
                  (forkGaps.gapLines.has(idx + 1) ||
                    forkGaps.gapCategories.has(
                      l.material_category.trim().toLowerCase(),
                    ))
                const priced = badge === 'catalogue'
                return (
                  <div
                    key={l.id}
                    className="rounded-card border border-ink-line bg-ink-deep px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-text-pri font-medium">{l.material_category}</div>
                      {l.description && (
                        <div className="text-xs text-text-dim mt-0.5">{l.description}</div>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {priced ? (
                          <span className="inline-block px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]">
                            {badgeLabel('catalogue', 'long')}
                          </span>
                        ) : (
                          <span
                            className="inline-block px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]"
                            title="No active Catalogue product in this category. The AI will fall back to a generic price (or inspection). Add a Catalogue product with this exact category to use your real product + price."
                          >
                            {badgeLabel('generic', 'long')}
                          </span>
                        )}
                        {/* R38 — fresh-fork gap callout. Distinct from the
                            steady-state badge so a tradie who just forked the
                            baseline sees exactly which copied lines have no
                            matching catalogue product yet. */}
                        {forkGapHere && (
                          <span
                            className="inline-block px-1.5 py-0.5 border border-warning/60 bg-warning/10 text-warning text-[0.55rem] uppercase tracking-[0.08em]"
                            title="This line was copied from the baseline but you have no catalogue product in its category — add one so the AI uses your real product + price instead of a generic one."
                          >
                            ⚠ add a product for this line
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
                        aria-busy={busyId === l.id}
                        className={` text-[0.55rem] uppercase tracking-[0.08em] px-2 py-1 border transition-colors cursor-pointer disabled:opacity-50 ${
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
                        aria-busy={busyId === l.id}
                        className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
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
            className="rounded-card mt-4 border border-ink-line bg-ink-deep p-4 grid gap-3 sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1">
              <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Material category</span>
              <select
                value={form.material_category}
                onChange={(e) => setForm((f) => ({ ...f, material_category: e.target.value }))}
                className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
              >
                <option value="">— choose a category —</option>
                {/* Phase 2 R2 — scoped to the selected JOB's trade, so an
                    electrical recipe never offers a plumbing part. */}
                {materialCategoriesFor(selectedAsm.trade).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {/* Phase 2 R7 — the old copy said "pick the same category you use
                  in Catalogue", which is the instruction that created the
                  problem: it told tradies to copy a value from a list that was
                  itself wrong. Both lists now come from the same source, so the
                  advice is no longer needed. */}
              <span className="text-[0.65rem] text-text-dim leading-snug">
                What part the job needs. Add a product in this category under Catalogue and the
                AI uses your product and your price; otherwise it falls back to a generic price.
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Quantity</span>
              <input
                value={form.quantity}
                inputMode="decimal"
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">Description (optional)</span>
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
                aria-busy={saving}
                className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 bg-accent text-white hover:bg-accent-press transition-colors cursor-pointer disabled:opacity-60"
              >
                {saving ? 'Adding…' : '+ Add part to this recipe'}
              </button>
            </div>
          </form>
        </div>
      )}
    </Card>
  )
}

// ─── WP3 · "How each job is estimated" (effective values + overrides) ──
// Per shared assembly that has a structured bill of materials, shows
// the BOM + the EFFECTIVE labour-hours & markup actually used to quote,
// with a badge saying whether each value came from the global default or
// this tradie's own override. NOT read-only: each row exposes an inline
// "Edit overrides" action that PATCHes tenant_assembly_overrides and a
// "Reset to default" that DELETEs the override. Mirrors CatalogueTab's
// fetch/auth pattern; the override writes go to /api/tenant/estimation/[id].
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
    <span className="px-1.5 py-0.5 border border-accent/40 text-accent text-[0.55rem] uppercase tracking-[0.08em]">
      your override
    </span>
  ) : (
    <span className="px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]">
      global default
    </span>
  )
}

function EstimatingTab({
  accessToken,
  tradeFilter,
}: {
  accessToken: string | null
  /** Trade-hub mode: show only this trade's estimation jobs. Unset = all
   *  trades (legacy cross-trade view, kept for deep links). */
  tradeFilter?: TradeHubSlug
}) {
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/estimation', {
        headers: { Authorization: `Bearer ${token}` },
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(
        `/api/tenant/estimation/${encodeURIComponent(j.assembly_id)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(
        `/api/tenant/estimation/${encodeURIComponent(j.assembly_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
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

  // Trade-hub mode: scope the job list to one trade. Derived above the
  // loading/error returns so the pagination hook runs on every render.
  const list = tradeFilter
    ? (jobs ?? []).filter((j) => (j.trade ?? '').toLowerCase() === tradeFilter)
    : (jobs ?? [])
  const {
    page: estPage,
    setPage: setEstPage,
    totalPages: estTotalPages,
    pageItems: estRows,
    startIndex: estStart,
    endIndex: estEnd,
    total: estTotal,
  } = usePagination(list, {
    urlKey: tradeFilter ? `${tradeFilter}_est_page` : 'est_page',
  })

  if (loading) {
    return (
      <Card>
        <p className="qm-loading text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
          Loading estimation breakdown…
        </p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-warning mb-2">
          Couldn&apos;t load estimation breakdown
        </div>
        <p className="text-sm text-text-sec">{error}</p>
      </Card>
    )
  }

  return (
    <Card title="How each job is estimated">
      <p className="text-xs text-text-dim leading-snug max-w-2xl">
        For every job, this shows the exact parts the AI quotes —{' '}
        <strong className="font-semibold text-text-sec">your own recipe</strong>{' '}
        when you&apos;ve set one, otherwise the standard baseline — plus the{' '}
        <strong className="font-semibold text-text-sec">effective</strong> labour &amp; markup it
        uses and whether each value is the global default or your override. Each part shows whether
        your catalogue prices it or it falls back to a generic price.{' '}
        <strong className="font-semibold text-text-sec">Editable:</strong> use{' '}
        <span className="font-mono text-text-sec">Edit overrides</span> on any row to set your own
        labour hours or markup, or <span className="font-mono text-text-sec">Reset to default</span>{' '}
        to clear it.
      </p>

      {list.length === 0 ? (
        <p className="mt-6 text-sm text-text-sec">
          No jobs have a structured bill of materials yet. Once the validated job/BOM list is
          loaded, every standard job will show its fixed parts and pricing here.
        </p>
      ) : (
        <>
        <div className="mt-6 space-y-3">
          {estRows.map((j) => (
            <div key={j.assembly_id} className="rounded-card border border-ink-line bg-ink-deep p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-semibold text-sm text-text-pri">{j.name}</div>
                <div className="flex items-center gap-2">
                  {j.recipe_source === 'tenant' ? (
                    <span className="px-1.5 py-0.5 border border-accent/40 text-accent text-[0.55rem] uppercase tracking-[0.08em]">
                      your recipe
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.55rem] uppercase tracking-[0.08em]">
                      standard recipe
                    </span>
                  )}
                  <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim/80">
                    {j.trade}
                    {!j.enabled && ' · disabled for you'}
                  </span>
                </div>
              </div>

              <div className="mt-3">
                <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim mb-1">
                  Bill of materials
                </div>
                <ul className="text-sm text-text-sec space-y-1">
                  {j.bom.map((b, i) => {
                    // R37 — shared resolver: this BOM badge agrees with the
                    // Recipes + Catalogue tabs for the same category.
                    const priced =
                      resolveCatalogueBadge(b.material_category, catalogueCats) === 'catalogue'
                    return (
                      <li key={i} className="flex items-center gap-2 flex-wrap">
                        <span>
                          • {b.quantity} × {b.material_category}
                          {b.description ? ` ${b.description}` : ''}
                          {b.required ? '' : ' (optional)'}
                        </span>
                        {priced ? (
                          <span className="px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.5rem] uppercase tracking-[0.08em]">
                            {badgeLabel('catalogue', 'short')}
                          </span>
                        ) : (
                          <span
                            className="px-1.5 py-0.5 border border-ink-line text-text-dim text-[0.5rem] uppercase tracking-[0.08em]"
                            title="No active Catalogue product in this category — the AI uses a generic price. Add a Catalogue product with this exact category to use your real product + price."
                          >
                            {badgeLabel('generic', 'short')}
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
                    className=" text-[0.6rem] uppercase tracking-[0.08em] text-accent hover:text-accent/80 transition-colors cursor-pointer"
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
                    aria-busy={savingId === j.assembly_id}
                    className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim hover:text-warning transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                )}
              </div>

              {editingId === j.assembly_id && (
                <div className="mt-3 border border-accent/40 bg-accent/5 p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
                      <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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
                      <div className="mt-2 text-[0.6rem] uppercase tracking-[0.08em] text-warning">
                        ⚠ This is a big shift from the global default — double-check before saving.
                      </div>
                    )
                  })()}
                  {saveErr && (
                    <div className="mt-2 text-[0.6rem] uppercase tracking-[0.08em] text-warning">
                      {saveErr}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={savingId === j.assembly_id}
                      aria-busy={savingId === j.assembly_id}
                      onClick={() => void saveEdit(j)}
                      className=" text-[0.7rem] uppercase tracking-[0.08em] font-bold px-3 py-2 border border-accent/60 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      {savingId === j.assembly_id ? 'Saving…' : 'Save overrides'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className=" text-[0.7rem] uppercase tracking-[0.08em] text-text-dim hover:text-text-pri transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <PaginationControls
          page={estPage}
          totalPages={estTotalPages}
          onPageChange={setEstPage}
          startIndex={estStart}
          endIndex={estEnd}
          total={estTotal}
          unit="jobs"
        />
        </>
      )}
    </Card>
  )
}

function FollowupsTab({
  accessToken,
  onGoToCalendar,
}: {
  accessToken: string | null
  onGoToCalendar: () => void
}) {
  const followupOperations = useFollowupBrowserOperations('followup-queue')
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
  // Category filter + free-text search to tame a long follow-up stack.
  const [category, setCategory] = useState<string>(ALL_CATEGORY)
  const [query, setQuery] = useState('')
  // Paid deposits with no visit time yet (e.g. a paid $99 inspection). These
  // correctly leave the chase queue the moment they're paid, so a paid
  // inspection can look like it "vanished" from the follow-up workflow. We
  // surface a breadcrumb to the Calendar tab (its "Paid · needs a time"
  // block) so the tradie can find it.
  const [bookedCount, setBookedCount] = useState(0)

  const load = useCallback(async () => {
    if (!accessToken) {
      setError('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // minAgeHours=0 → surface recent quotes too, not just 24h+ stale
      // ones, so the tab is "up to date". includeActioned=1 → contacted
      // leads come back too (CRM style), so "Mark contacted" moves a row
      // to the Contacted section instead of vanishing it. Split by
      // followed_up_at below.
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(
        '/api/tenant/followups?includeActioned=1&minAgeHours=0',
        {
        headers: { Authorization: `Bearer ${token}` },
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

  // Best-effort: how many paid quotes are waiting on a time (they live in the
  // Calendar tab's "Paid · needs a time" block). Drives the breadcrumb below.
  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    ;(async () => {
      try {
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/tenant/calendar', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) return
        const json = (await res.json()) as { toSchedule?: unknown[] }
        if (!cancelled) {
          setBookedCount(Array.isArray(json.toSchedule) ? json.toSchedule.length : 0)
        }
      } catch {
        /* non-fatal — the breadcrumb just won't show */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken])

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
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch('/api/tenant/followups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
    const rowId = followupRowId(item)
    setCallBusy(rowId)
    clearRowMsg(rowId)
    try {
      if (!item.customer.phone) throw new Error('Refresh this customer and review their phone number before calling.')
      const operation = await followupOperations.submit('call', {
        ...(item.kind === 'lead' ? { conversationId: item.conversation_id! } : { quoteId: item.quote_id! }),
        expectedRecipient: item.customer.phone,
      })
      setRowMsg(rowId, operation.accepted ? 'ok' : 'err', operation.message)
      if (operation.history === 'complete' && item.kind === 'quote') bumpHistory(rowId)
    } catch (e) {
      setRowMsg(
        rowId,
        'err',
        e instanceof Error ? e.message : 'Network error starting the call.',
      )
    } finally {
      setCallBusy(null)
    }
  }

  async function checkCallStatus(item: FollowupItem) {
    const rowId = followupRowId(item)
    setCallBusy(rowId)
    try {
      const operation = await followupOperations.recover('call', item.kind === 'lead'
        ? { conversationId: item.conversation_id! } : { quoteId: item.quote_id! })
      setRowMsg(rowId, operation?.accepted ? 'ok' : 'err', operation?.message ?? 'No saved call request on this browser.')
      if (operation?.history === 'complete' && item.kind === 'quote') bumpHistory(rowId)
    } catch (error) { setRowMsg(rowId, 'err', error instanceof Error ? error.message : 'Status unavailable.') }
    finally { setCallBusy(null) }
  }

  // Filter state is derived with hooks, so it MUST be computed before the
  // loading/error early returns below — every render has to run the same
  // hooks in the same order (Rules of Hooks).
  const list = rows ?? []
  // Category options come from the full queue; the selected category
  // self-heals to "All" if a reload drops it, so the <select> and the
  // filter can never disagree.
  const categoryOptions = useMemo(() => followupCategoryOptions(list), [list])
  const effectiveCategory = categoryOptions.some((o) => o.value === category)
    ? category
    : ALL_CATEGORY
  const filtered = useMemo(
    () => filterFollowups(list, { category: effectiveCategory, query }),
    [list, effectiveCategory, query],
  )
  // CRM split (active queue first, contacted-but-still-unpaid after) is
  // derived up here — above the loading/error early returns — because the
  // pagination hook below is a hook and must run on every render.
  const toChase = filtered.filter((f) => !f.followed_up_at)
  const done = filtered.filter((f) => !!f.followed_up_at)
  const ordered = [...toChase, ...done]
  const {
    page,
    setPage,
    totalPages,
    pageItems: pageRows,
    startIndex,
    endIndex,
    total,
  } = usePagination(ordered, {
    urlKey: 'fu_page',
    resetKey: `${effectiveCategory}::${query}`,
  })

  if (loading) {
    return (
      <Card>
        <p className="qm-loading text-sm text-text-dim">Loading the follow-up queue…</p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <p className="text-sm text-warning-bright">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-ctl mt-4 inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri text-[0.7rem] uppercase tracking-[0.08em] font-bold px-5 py-3 min-h-[44px] transition-colors cursor-pointer"
        >
          Retry
        </button>
      </Card>
    )
  }

  const filtersActive = effectiveCategory !== ALL_CATEGORY || query.trim() !== ''
  const clearFilters = () => {
    setCategory(ALL_CATEGORY)
    setQuery('')
  }
  // toChase / done / ordered are derived above (before the early returns).
  // Server returns both active + contacted (includeActioned=1); we group by
  // followed_up_at and render one ordered, paginated list with a section
  // divider so a contacted lead is parked, not lost. Grouping runs on the
  // FILTERED set so the counts + section headers track what's actually shown.
  const thresholdNote =
    minAgeHours && minAgeHours > 0
      ? `Quotes sent over ${
          minAgeHours >= 48
            ? `${Math.round(minAgeHours / 24)} days`
            : `${minAgeHours}h`
        } ago with no payment, plus SMS leads with no quote.`
      : 'Quotes not yet paid, plus SMS leads with no quote.'

  // Breadcrumb to the Calendar tab for paid-but-unscheduled quotes — so a
  // paid inspection that has left this queue doesn't look lost.
  const bookedBanner =
    bookedCount > 0 ? (
      <button
        type="button"
        onClick={onGoToCalendar}
        className="rounded-ctl mb-4 flex w-full items-center justify-between gap-3 border border-teal-glow/40 bg-teal-glow/10 px-4 py-3 text-left transition-colors hover:border-teal-glow cursor-pointer"
      >
        <span className="text-sm text-text-sec">
          <span className="font-semibold text-text-pri">
            {bookedCount} paid {bookedCount === 1 ? 'deposit' : 'deposits'}
          </span>{' '}
          waiting on a visit time — a quote leaves this list once it&apos;s paid.
        </span>
        <span className="whitespace-nowrap text-[0.62rem] uppercase tracking-[0.08em] text-teal-glow">
          Calendar →
        </span>
      </button>
    ) : null

  if (list.length === 0) {
    return (
      <Card subtitle={`${thresholdNote} Nothing to chase right now.`}>
        {bookedBanner}
        <p className="text-sm text-text-dim">
          No follow-ups. Every quote is already paid or accepted — or you
          have contacted everyone. New quotes and SMS leads (people who
          texted in but never got a quote) appear here as soon as they
          come in.
        </p>
      </Card>
    )
  }

  return (
    <>
    <Card
      subtitle={`${toChase.length} to chase${
        done.length ? ` · ${done.length} contacted` : ''
      } · ${thresholdNote} Oldest first.`}
    >
      {bookedBanner}
      {/* Filter + search — keep the long queue navigable */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, suburb, phone or follow-up code…"
            aria-label="Search follow-ups"
            className="rounded-ctl w-full bg-ink-deep border border-ink-line pl-10 pr-3 py-2 text-sm text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors"
          />
        </div>
        <select
          value={effectiveCategory}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by job category"
          className="rounded-ctl bg-ink-deep border border-ink-line px-3.5 py-2.5 text-sm text-text-pri focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft transition-colors sm:w-56"
        >
          {categoryOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} ({o.count})
            </option>
          ))}
        </select>
      </div>
      {filtersActive && (
        <p className="mb-3 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
          Showing {ordered.length} of {list.length}
          <button
            type="button"
            onClick={clearFilters}
            className="ml-2 text-accent hover:text-accent-press cursor-pointer"
          >
            Clear
          </button>
        </p>
      )}
      {ordered.length === 0 ? (
        <p className="text-sm text-text-dim">
          No follow-ups match{' '}
          {query.trim() ? `“${query.trim()}”` : 'this filter'}.{' '}
          <button
            type="button"
            onClick={clearFilters}
            className="font-semibold text-accent hover:text-accent-press cursor-pointer"
          >
            Clear filters
          </button>
        </p>
      ) : (
        <>
      {toChase.length === 0 && done.length > 0 && (
        <p className="mb-3 text-sm text-text-dim">
          Nothing left to chase — everyone&apos;s been contacted. Reopen
          any below if they still need a nudge.
        </p>
      )}
      <div className="space-y-3">
        {pageRows.map((f, _idx) => {
          const rowId = followupRowId(f)
          const isLead = f.kind === 'lead'
          const name = f.customer.full_name || 'Unknown customer'
          const hasPhone =
            !!f.customer.phone &&
            f.customer.phone.replace(/\D/g, '').length >= 6
          const act = actionState[rowId]
          const calling = callBusy === rowId
          const isDone = !!f.followed_up_at
          const opened = f.followup_reason.startsWith('Opened')
          const showChaseHeader = !isDone && _idx === 0
          const showContactedHeader =
            isDone && (_idx === 0 || !pageRows[_idx - 1].followed_up_at)
          return [
            showChaseHeader ? (
              <p
                key={`${rowId}-h`}
                className=" text-[0.62rem] uppercase tracking-[0.08em] text-text-dim"
              >
                To chase ({toChase.length})
              </p>
            ) : null,
            showContactedHeader ? (
              <p
                key={`${rowId}-h`}
                className="mt-6 border-t border-ink-line pt-4 text-[0.62rem] uppercase tracking-[0.08em] text-text-dim"
              >
                Contacted ({done.length}) · still no payment
              </p>
            ) : null,
            (
            <div
              key={rowId}
              className={`rounded-card border border-ink-line bg-ink p-4 ${
                isDone ? 'opacity-70' : ''
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-text-pri truncate">
                      {name}
                    </span>
                    <StatusPill
                      label={f.followup_reason}
                      tone={isDone ? 'success' : opened ? 'warn' : 'dim'}
                      dot
                      compact
                    />
                    {isLead && (
                      <span className=" text-[0.6rem] uppercase tracking-[0.08em] font-bold px-2 py-0.5 border border-ink-line text-text-dim">
                        SMS lead
                      </span>
                    )}
                    {f.needs_inspection && (
                      <span className=" text-[0.6rem] uppercase tracking-[0.08em] font-bold px-2 py-0.5 border border-ink-line text-text-dim">
                        Inspection
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-sec">
                    {fmtJobType(f.job_type)}
                    {f.customer.suburb ? ` · ${f.customer.suburb}` : ''}
                    {f.kind === 'quote' ? (
                      <>
                        {' · '}
                        {fmtAUD(f.total_inc_gst)} inc GST
                        {f.selected_tier ? ` · ${f.selected_tier} tier` : ''}
                      </>
                    ) : (
                      ' · SMS enquiry, no quote yet'
                    )}
                  </p>
                  <p className="mt-1 text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
                    Last activity {fmtAgeHours(f.age_hours)}
                  </p>
                </div>
                <div className="flex flex-col items-stretch gap-2 shrink-0">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!hasPhone || calling}
                      onClick={() => void startCall(f)}
                      className="rounded-ctl inline-flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-press text-white text-[0.62rem] uppercase tracking-[0.08em] font-bold px-3 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {calling ? 'Working…' : 'Call'}
                    </button>
                    <button
                      type="button"
                      disabled={!hasPhone}
                      onClick={() => {
                        clearRowMsg(rowId)
                        setComposeFor(f)
                      }}
                      className="rounded-ctl inline-flex items-center justify-center gap-1.5 border border-accent/60 text-accent hover:bg-accent/10 text-[0.62rem] uppercase tracking-[0.08em] font-bold px-3 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Text
                    </button>
                  </div>
                  <button type="button" disabled={calling} onClick={() => void checkCallStatus(f)}
                    className="text-xs text-text-sec min-h-[40px] underline disabled:opacity-50">
                    Check call status
                  </button>
                  {!hasPhone && (
                    <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-warning-bright">
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
                      className={`text-center text-[0.6rem] uppercase tracking-[0.08em] leading-relaxed ${
 act.kind === 'ok'
 ? 'text-success-bright'
 : 'text-warning-bright'
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
                    className=" text-[0.62rem] uppercase tracking-[0.08em] font-bold text-accent hover:text-accent-press"
                  >
                    Open quote ↗
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setThreadOpen((s) => ({
                      ...s,
                      [rowId]: !s[rowId],
                    }))
                  }
                  className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer"
                >
                  {threadOpen[rowId] ? 'Hide messages ▾' : 'Messages ▸'}
                </button>
                {!isLead && (
                  <button
                    type="button"
                    onClick={() =>
                      setHistoryOpen((s) => ({
                        ...s,
                        [rowId]: !s[rowId],
                      }))
                    }
                    className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer"
                  >
                    {historyOpen[rowId] ? 'Hide history ▾' : 'History ▸'}
                  </button>
                )}
                {isDone && f.quote_id && (
                  <button
                    type="button"
                    disabled={busyId === rowId}
                    aria-busy={busyId === rowId}
                    onClick={() => void reopen(f.quote_id as string)}
                    className="rounded-ctl inline-flex items-center gap-2 border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {busyId === rowId ? 'Saving…' : 'Reopen ↩'}
                  </button>
                )}
                {!isLead && (
                  <button
                    type="button"
                    onClick={() =>
                      setLogFor((s) => ({
                        ...s,
                        [rowId]: !s[rowId],
                      }))
                    }
                    className={`rounded-ctl ml-auto inline-flex items-center gap-2 text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer ${
 logFor[rowId]
 ? 'border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri'
 : 'border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20'
 }`}
                  >
                    {logFor[rowId]
                      ? '× Cancel'
                      : isDone
                        ? '+ Log another'
                        : '+ Log touch'}
                  </button>
                )}
              </div>
              {!isLead && logFor[rowId] && f.quote_id && (
                <FollowupLogForm
                  quoteId={f.quote_id}
                  accessToken={accessToken}
                  preserveChase={isDone}
                  onCancel={() =>
                    setLogFor((s) => ({ ...s, [rowId]: false }))
                  }
                  onLogged={() => {
                    void load()
                    setLogFor((s) => ({ ...s, [rowId]: false }))
                    setHistoryOpen((s) => ({ ...s, [rowId]: true }))
                    setHistoryRefresh((s) => ({
                      ...s,
                      [rowId]: (s[rowId] ?? 0) + 1,
                    }))
                  }}
                />
              )}
              {!isLead && historyOpen[rowId] && f.quote_id && (
                <div className="mt-3 border-t border-ink-line pt-3">
                  <FollowupHistory
                    quoteId={f.quote_id}
                    accessToken={accessToken}
                    refreshKey={historyRefresh[rowId] ?? 0}
                  />
                </div>
              )}
              {threadOpen[rowId] && (
                <div className="mt-3 border-t border-ink-line pt-3">
                  <FollowupThread
                    quoteId={f.kind === 'quote' ? f.quote_id : null}
                    conversationId={
                      f.kind === 'lead' ? f.conversation_id : null
                    }
                    accessToken={accessToken}
                  />
                </div>
              )}
            </div>
          ),
          ]
        })}
      </div>
      <PaginationControls
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        startIndex={startIndex}
        endIndex={endIndex}
        total={total}
        unit="follow-ups"
      />
        </>
      )}
    </Card>
      {composeFor && (
        <FollowupTextModal
          item={composeFor}
          accessToken={accessToken}
          onClose={() => setComposeFor(null)}
          onSent={(sentItem) => {
            const id = followupRowId(sentItem)
            setComposeFor(null)
            setRowMsg(
              id,
              'ok',
              'Message request accepted; history saved.',
            )
            if (sentItem.kind === 'quote') bumpHistory(id)
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
  preserveChase,
  onCancel,
  onLogged,
}: {
  quoteId: string
  accessToken: string | null
  preserveChase: boolean
  onCancel: () => void
  onLogged: () => void
}) {
  const operations = useFollowupBrowserOperations(`note:${quoteId}`)
  const [outcome, setOutcome] = useState<string>('spoke')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void operations.recover('note', { quoteId }).then(operation => {
      if (current && operation) setErr(operation.message)
    }).catch(error => { if (current) setErr(error instanceof Error ? error.message : 'Status unavailable.') })
    return () => { current = false }
  }, [operations, quoteId])

  async function save() {
    if (!accessToken || saving) return
    setSaving(true)
    setErr(null)
    try {
      const operation = await operations.submit('note', { quoteId, kind: 'note', outcome,
        note: note.trim() || undefined, preserveChase })
      if (operation.status !== 'complete' || !operation.eventId) throw new Error(operation.message)
      onLogged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 border-t border-ink-line pt-3">
      <p className=" text-[0.62rem] uppercase tracking-[0.08em] text-text-dim mb-2">
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
              disabled={saving}
              onChange={() => setOutcome(o.value)}
              className="accent-accent"
            />
            <span className="text-sm">{o.label}</span>
          </label>
        ))}
      </div>
      <label className="mt-3 flex flex-col gap-1">
        <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
          Note (optional, up to 500 chars)
        </span>
        <textarea
          value={note}
          disabled={saving}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          placeholder="e.g. Wants to decide by Friday — call back after 3pm"
          rows={2}
          className="bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri resize-none"
        />
      </label>
      {err && <p className="mt-2 text-xs text-warning-bright">{err}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving}
          aria-busy={saving}
          onClick={() => void save()}
          className="bg-accent hover:bg-accent-press text-white text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-60"
        >
          {saving ? 'Working…' : 'Save touch'}
        </button>
        <button type="button" disabled={saving} className="text-xs text-text-sec min-h-[40px] underline disabled:opacity-50"
          onClick={() => {
            setSaving(true)
            void operations.recover('note', { quoteId }).then(operation => setErr(operation?.message ?? 'No saved touch request on this browser.'))
              .catch(error => setErr(error instanceof Error ? error.message : 'Status unavailable.')).finally(() => setSaving(false))
          }}>Check status</button>
        <button
          type="button"
          onClick={() => { if (!note.trim() || window.confirm('Discard this unsaved touch note?')) onCancel() }}
          disabled={saving}
          aria-busy={saving}
          className="rounded-card border border-ink-line bg-ink-card hover:bg-ink-deep text-text-sec hover:text-text-pri text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2 min-h-[40px] transition-colors cursor-pointer disabled:opacity-60"
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
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch(
          `/api/tenant/followups/events?quoteId=${encodeURIComponent(quoteId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
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
      <p className="qm-loading text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
        Loading history…
      </p>
    )
  }
  if (err) {
    return <p className="text-xs text-warning-bright">{err}</p>
  }
  if (!events || events.length === 0) {
    return (
      <p className=" text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
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
              className={` text-[0.6rem] uppercase tracking-[0.08em] font-bold px-1.5 py-0.5 border ${
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
            <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim ml-auto">
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
  onSent: (item: FollowupItem, channel: 'sms' | 'whatsapp') => void
}) {
  const operations = useFollowupBrowserOperations(`text:${followupRowId(item)}`)
  const firstName = item.customer.first_name || ''
  const jobLabel = fmtJobType(item.job_type)
  const defaultMsg =
    `Hi ${firstName || 'there'}, just following up on your ${jobLabel} ${item.kind === 'lead' ? 'enquiry' : 'quote'}. Happy to answer any questions ` +
    `or lock in a time — just reply to this message.`
  const [text, setText] = useState(defaultMsg)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const trimmed = text.trim()
  const segments = trimmed.length === 0 ? 0 : Math.ceil(trimmed.length / 153)

  useEffect(() => {
    let current = true
    const target = item.kind === 'lead' ? { conversationId: item.conversation_id! } : { quoteId: item.quote_id! }
    void operations.recover('text', target).then(operation => {
      if (current && operation) setErr(operation.message)
    }).catch(error => { if (current) setErr(error instanceof Error ? error.message : 'Status unavailable.') })
    return () => { current = false }
  }, [operations, item.kind, item.quote_id, item.conversation_id])

  async function send() {
    if (!trimmed || sending) return
    setSending(true)
    setErr(null)
    try {
      if (!item.customer.phone) throw new Error('Refresh this customer and review their phone number before sending.')
      const operation = await operations.submit('text', {
        ...(item.kind === 'lead' ? { conversationId: item.conversation_id! } : { quoteId: item.quote_id! }),
        text: trimmed, expectedRecipient: item.customer.phone,
      })
      if (!operation.accepted || operation.history !== 'complete') { setErr(operation.message); return }
      onSent(item, 'sms')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error sending the text.')
    } finally {
      setSending(false)
    }
  }

  // Rendered into <body> via a portal (below) so the overlay is a direct
  // child of <body> and truly viewport-fixed + centred. This is what
  // escapes the dashboard tab wrapper's persistent `transform` (the
  // fade-up `both` fill-mode leaves translateY(0) on it), which would
  // otherwise make `position: fixed` anchor to that tall wrapper — the
  // modal would land mid-list and the backdrop cover only the scroll
  // area. The modal only ever mounts on a click, so document exists.
  if (typeof document === 'undefined') return null

  // Layout is a capped flex column: the header and the composer stay
  // pinned while the conversation history is the only scrolling region,
  // so the FULL text thread is reachable and the modal never overflows.
  const overlay = (
    <div
      className="qm-overlay fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      onClick={() => { if (!sending && (text === defaultMsg || window.confirm('Discard this unsent message?'))) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="qm-panel rounded-card flex max-h-[92dvh] w-full flex-col bg-ink border border-ink-line sm:max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — pinned */}
        <div className="flex shrink-0 items-start justify-between gap-3 p-5 pb-3 sm:p-6 sm:pb-3">
          <div>
            <h3 className="font-extrabold uppercase tracking-tight text-text-pri">
              Text {item.customer.full_name || 'customer'}
            </h3>
            <p className="mt-1 text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
              From your QuoteMax number · {item.customer.phone ?? 'no number'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (text === defaultMsg || window.confirm('Discard this unsent message?')) onClose() }}
            disabled={sending}
            className="text-text-dim hover:text-text-pri font-mono text-sm cursor-pointer"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Conversation history — the ONLY scrolling region. Grows with
            the thread and only scrolls once the modal hits its cap, so a
            short thread stays compact and a long one is fully browsable. */}
        <div className="min-h-0 overflow-y-auto px-5 sm:px-6">
          {err && (
            <div className="mb-3 border border-warning-bright/50 bg-warning/15 text-warning-bright text-sm px-3 py-2">
              {err}
            </div>
          )}
          <div className="rounded-card border border-ink-line bg-ink-deep p-3">
            <p className="mb-2 text-[0.58rem] uppercase tracking-[0.08em] text-text-dim">
              Conversation
            </p>
            <FollowupThread
              quoteId={item.kind === 'quote' ? item.quote_id : null}
              conversationId={
                item.kind === 'lead' ? item.conversation_id : null
              }
              accessToken={accessToken}
              fill
            />
          </div>
        </div>

        {/* Composer — pinned */}
        <div className="shrink-0 border-t border-ink-line p-5 pt-3 sm:p-6 sm:pt-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={640}
            disabled={sending}
            aria-label="Follow-up message to the customer"
            placeholder="Type your follow-up message…"
            className="rounded-ctl w-full bg-ink-deep border border-ink-line text-text-pri text-sm p-3 outline-none focus:border-accent/60 disabled:opacity-60"
          />
          <p className="mt-1.5 text-[0.58rem] uppercase tracking-[0.08em] text-text-dim">
            {trimmed.length}/640 chars · ~{segments} SMS{' '}
            {segments === 1 ? 'segment' : 'segments'}
          </p>

          <div className="mt-4 flex flex-wrap gap-2 justify-end">
            <button type="button" disabled={sending} className="text-xs text-text-sec min-h-[44px] underline disabled:opacity-50"
              onClick={() => {
                setSending(true)
                const target = item.kind === 'lead' ? { conversationId: item.conversation_id! } : { quoteId: item.quote_id! }
                void operations.recover('text', target).then(operation => setErr(operation?.message ?? 'No saved message request on this browser.'))
                  .catch(error => setErr(error instanceof Error ? error.message : 'Status unavailable.')).finally(() => setSending(false))
              }}>Check status</button>
            <button
              type="button"
              onClick={() => { if (text === defaultMsg || window.confirm('Discard this unsent message?')) onClose() }}
              disabled={sending}
              aria-busy={sending}
              className="rounded-card border border-ink-line bg-ink-card hover:bg-ink-deep text-text-pri text-[0.62rem] uppercase tracking-[0.08em] font-bold px-4 py-2.5 min-h-[44px] transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || trimmed.length === 0}
              aria-busy={sending}
              className="bg-accent hover:bg-accent-press text-white text-[0.62rem] uppercase tracking-[0.08em] font-bold px-5 py-2.5 min-h-[44px] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Working…' : 'Send text'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
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
  quoteId = null,
  conversationId = null,
  accessToken,
  compact = false,
  fill = false,
}: {
  // A quote follow-up passes quoteId; a no-quote SMS lead passes
  // conversationId. Exactly one is set; the messages endpoint resolves
  // the phone server-side from whichever it receives.
  quoteId?: string | null
  conversationId?: string | null
  accessToken: string | null
  compact?: boolean
  /** Grow to fit the full thread and let an ancestor own the scroll
   *  (used inside the compose modal, whose body is the scroll region).
   *  When false, the thread caps its own height and scrolls internally. */
  fill?: boolean
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
        const qs = conversationId
          ? `conversationId=${encodeURIComponent(conversationId)}`
          : `quoteId=${encodeURIComponent(quoteId ?? '')}`
        // Mint a FRESH dual-auth token per fetch — Clerk's default session
        // token expires ~60s after mint, so the prop captured at mount goes
        // stale on reload (quote/conversation switch). Fall back to the prop.
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch(
          `/api/tenant/followups/messages?${qs}`,
          {
            headers: { Authorization: `Bearer ${token}` },
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
  }, [quoteId, conversationId, accessToken])

  if (state.phase === 'loading') {
    return <p className="qm-loading text-xs text-text-dim">Loading messages…</p>
  }
  if (state.phase === 'error') {
    return <p className="text-xs text-warning-bright">{state.msg}</p>
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
        <p className="mb-2 text-[0.6rem] uppercase tracking-[0.08em] text-success-bright">
          Customer replied — awaiting your response
        </p>
      )}
      <div
        className={`space-y-2 pr-1 ${
          fill ? '' : `overflow-y-auto ${compact ? 'max-h-44' : 'max-h-72'}`
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
                  className={`mt-1 text-[0.55rem] uppercase tracking-[0.08em] ${
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

/** A "cold" chat mirrors the Overview analytics `coldChats` definition
 *  (lib/dashboard/tradie-analytics.ts): a real customer SMS conversation
 *  (not a tradie-registration thread) that was abandoned mid-dialog. Voice
 *  calls have no abandoned state, so they never count as cold. */
function isColdChat(c: ChatRow): boolean {
  return (
    c.channel === 'sms' &&
    c.conversation_type !== 'tradie_registration' &&
    (c.status ?? '').toLowerCase() === 'abandoned'
  )
}

function ChatsTab({
  accessToken,
  tenantId,
  isMultiTrade,
  filter,
  onFilterChange,
  onGoToQuotes,
}: {
  accessToken: string | null
  tenantId: string
  isMultiTrade: boolean
  filter: 'all' | 'cold'
  onFilterChange: (f: 'all' | 'cold') => void
  onGoToQuotes: () => void
}) {
  // R4 (specs/dashboard-performance.md): hydrate from the cached
  // conversations so a tab revisit paints instantly — any cache entry (even
  // stale) means no "Loading…" flash; the effect below revalidates silently.
  // Tenant-scoped key: tab data must never survive an account switch.
  const chatsCacheKey = tabCacheKey('chats', tenantId)
  const [chats, setChats] = useState<ChatRow[] | null>(
    () => readTabCache<ChatRow[]>(chatsCacheKey)?.data ?? null,
  )
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [chatsTick, setChatsTick] = useState(0)
  const chatsFetchedRef = useRef<number | null>(null)
  // Both derived — no stored `fetching` flag to drift out of step: loading
  // exactly while there is nothing to show and nothing has failed.
  const error = accessToken ? fetchError : 'Not signed in'
  const loading = !!accessToken && chats === null && !fetchError

  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    // Fresh cache entry → already rendered via the state initializer; a
    // stale entry stays painted while the fetch below revalidates it.
    const cached = readTabCache<ChatRow[]>(chatsCacheKey)
    if (cached && isFresh(cached, Date.now())) {
      chatsFetchedRef.current = cached.fetchedAt
      return
    }
    ;(async () => {
      try {
        // Mint a FRESH dual-auth token immediately before the fetch. The
        // `accessToken` prop is captured at mount and, for Clerk users,
        // the session token expires ~60s later -> reusing it 401s. Fall
        // back to the prop only if getAuthToken() yields nothing.
        const token = (await getAuthToken()) ?? accessToken
        const res = await fetch('/api/tenant/chats', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        const json = (await res.json()) as { chats: ChatRow[] }
        if (!cancelled) {
          const list = json.chats ?? []
          // ONE clock for the cache window and the focus-return throttle;
          // only a success advances it.
          const fetchedAt = Date.now()
          writeTabCache(chatsCacheKey, list, fetchedAt)
          chatsFetchedRef.current = fetchedAt
          setChats(list)
          setFetchError(null)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : String(err))
          // Let the next focus-return retry immediately instead of being
          // swallowed by the 15s throttle.
          chatsFetchedRef.current = null
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessToken, chatsTick, chatsCacheKey])

  // Refresh-on-return, same contract as the Quotes queue: an already-open
  // Chats tab revalidates on window focus / visibility, throttled to the
  // shared 15s window — a list left up overnight can't stay silently stale.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return
      if (!shouldRefresh(chatsFetchedRef.current, Date.now())) return
      setChatsTick((n) => n + 1)
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [])

  // Bare-canvas states — the two-pane workspace has no card containers,
  // so its loading / error / empty states sit directly on the page too.
  if (loading) {
    return (
      <p className="qm-loading border-t border-ink-line p-6 text-xs uppercase tracking-[0.08em] text-text-dim">
        Loading conversations…
      </p>
    )
  }
  // A failed fetch with NOTHING painted is a full error state; a failed
  // background revalidate over a cached list becomes the strip below, so
  // the tradie keeps the data and gets an honest Retry.
  if (error && !chats) {
    return (
      <div className="border-t border-ink-line p-6">
        <ErrorBanner>{error}</ErrorBanner>
      </div>
    )
  }
  if (!chats || chats.length === 0) {
    return (
      <p className="border-t border-ink-line p-6 text-sm text-text-dim">
        No conversations yet. Customers who text your QuoteMax number
        will appear here.
      </p>
    )
  }

  return (
    <>
      {error && (
        <div
          role="alert"
          className="rounded-ctl mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 border border-danger/50 bg-danger/10 px-4 py-2.5 text-xs text-text-pri md:mx-5"
        >
          <span>
            Couldn&rsquo;t refresh conversations — showing the last loaded
            list.
          </span>
          <button
            type="button"
            onClick={() => setChatsTick((n) => n + 1)}
            className="rounded-ctl inline-flex items-center border border-ink-line px-3 py-1.5 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-text-pri transition-colors cursor-pointer hover:border-accent hover:text-accent"
          >
            Retry
          </button>
        </div>
      )}
    <ChatsSplitView
      chats={chats}
      onMutated={() => staleTabCache(chatsCacheKey)}
      isMultiTrade={isMultiTrade}
      filter={filter}
      onFilterChange={onFilterChange}
      onGoToQuotes={onGoToQuotes}
      accessToken={accessToken}
    />
    </>
  )
}

/** Two-pane conversations workspace (specs/chats-tab-redesign.md): a
 *  scrollable rail of conversations (left) + the selected live thread with
 *  an SMS composer (right), sitting directly on the canvas — no cards.
 *  Below md a single pane shows: the rail first, then the thread once a
 *  row is tapped, with a back control in the thread header. */
function ChatsSplitView({
  chats,
  onMutated,
  isMultiTrade,
  filter,
  onFilterChange,
  onGoToQuotes,
  accessToken,
}: {
  chats: ChatRow[]
  /** Called after a mutation the cached conversations list can't see
   *  (e.g. a reply sent) — marks the tab cache stale so the next Chats
   *  mount revalidates instead of serving the pre-send transcript. */
  onMutated: () => void
  isMultiTrade: boolean
  filter: 'all' | 'cold'
  onFilterChange: (f: 'all' | 'cold') => void
  onGoToQuotes: () => void
  accessToken: string | null
}) {
  const coldCount = chats.filter(isColdChat).length
  const shown = filter === 'cold' ? chats.filter(isColdChat) : chats

  // null = nothing tapped yet: desktop falls back to the first row, mobile
  // stays on the rail. A selection the cold filter hides degrades the same
  // way, so flipping filters can never strand the thread pane.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    (selectedId ? shown.find((c) => c.id === selectedId) : undefined) ??
    shown[0] ??
    null
  const mobileThreadOpen =
    selectedId !== null && shown.some((c) => c.id === selectedId)

  // Session-sent replies per conversation — appended client-side as "You"
  // bubbles so a send never needs a refetch. Keyed by conversation id and
  // held here (not in the thread) so they survive switching threads.
  const [sentByConvo, setSentByConvo] = useState<Record<string, ConvoMessage[]>>({})
  // Composer drafts per conversation, so switching threads keeps a
  // half-typed reply (the thread component remounts per chat).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Send in-flight / error, ALSO keyed by conversation id and held here —
  // ChatThread remounts on every selection change, so thread-local send
  // state would reset mid-flight and let a second Send fire a duplicate
  // customer SMS after switching away and back.
  const [sendingByConvo, setSendingByConvo] = useState<Record<string, boolean>>({})
  const [sendErrorByConvo, setSendErrorByConvo] = useState<Record<string, string | null>>({})

  // Fill the viewport below whatever chrome sits above (sticky topnav, and
  // the mobile tab strip below lg) so both panes scroll independently.
  // Measured rather than hard-coded — the chrome height varies per
  // breakpoint. Falls back to topnav-only (61px: the h-[60px] bar + 1px
  // border, the same offset the sidebar pins to) before first measure.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [chromeTop, setChromeTop] = useState(61)
  useEffect(() => {
    const measure = () => {
      const el = rootRef.current
      if (!el) return
      setChromeTop(Math.max(61, Math.round(el.getBoundingClientRect().top)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return (
    <div
      ref={rootRef}
      style={{ '--chats-h': `calc(100dvh - ${chromeTop}px)` } as CSSProperties}
      className="border-t border-ink-line md:grid md:h-[var(--chats-h)] md:min-h-0 md:grid-cols-[minmax(290px,390px)_minmax(0,1fr)] md:overflow-hidden"
    >
      {/* ── Conversation rail ─────────────────────────────────────── */}
      <div
        className={`${mobileThreadOpen ? 'hidden md:block' : ''} md:min-h-0 md:overflow-y-auto md:border-r md:border-ink-line`}
      >
        <div className="sticky top-[61px] z-[5] flex items-center justify-between gap-3 border-b border-ink-line bg-ink-deep px-[18px] py-[15px] md:top-0">
          <span className=" text-[11px] font-semibold uppercase tracking-[0.08em] text-text-sec">
            Conversations · {shown.length}
          </span>
          {/* All / Went-cold filter — lives in the reference's "All
              channels" slot so the Overview cold-chats CTA deep-link
              keeps working. */}
          <div className="flex shrink-0 items-center gap-3">
            <RailFilterButton
              active={filter === 'all'}
              onClick={() => onFilterChange('all')}
              label="All"
              count={chats.length}
            />
            <RailFilterButton
              active={filter === 'cold'}
              onClick={() => onFilterChange('cold')}
              label="Went cold"
              count={coldCount}
            />
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="px-[18px] py-6 text-sm text-text-dim">
            {filter === 'cold'
              ? 'No cold chats right now — every conversation either converted or is still live.'
              : 'No conversations yet.'}
          </p>
        ) : (
          shown.map((c) => (
            <ChatRailRow
              key={c.id}
              chat={c}
              // Explicit tap → active everywhere. The desktop first-row
              // fallback is only VISUALLY current (the thread pane shows
              // it), so it gets md-scoped styling and no aria-current —
              // on mobile no thread is open, marking a row current would
              // be a lie to screen readers.
              active={mobileThreadOpen && selectedId === c.id}
              fallbackActive={!mobileThreadOpen && selected?.id === c.id}
              isMultiTrade={isMultiTrade}
              onSelect={() => setSelectedId(c.id)}
            />
          ))
        )}
      </div>

      {/* ── Thread pane ───────────────────────────────────────────── */}
      <div
        className={`${mobileThreadOpen ? 'flex' : 'hidden md:flex'} min-h-[var(--chats-h)] flex-col bg-ink-deep md:min-h-0 md:overflow-y-auto`}
      >
        {selected ? (
          <ChatThread
            key={selected.id}
            chat={selected}
            sent={sentByConvo[selected.id] ?? []}
            draft={drafts[selected.id] ?? ''}
            onDraft={(v) =>
              setDrafts((prev) => ({ ...prev, [selected.id]: v }))
            }
            onSent={(m) => {
              setSentByConvo((prev) => ({
                ...prev,
                [selected.id]: [...(prev[selected.id] ?? []), m],
              }))
              // The cached list now lags this thread — stale-mark it so the
              // next Chats mount revalidates instead of resurrecting the
              // pre-send transcript for up to 15s.
              onMutated()
            }}
            sending={sendingByConvo[selected.id] ?? false}
            sendError={sendErrorByConvo[selected.id] ?? null}
            onSendingChange={(v) =>
              setSendingByConvo((prev) => ({ ...prev, [selected.id]: v }))
            }
            onSendError={(v) =>
              setSendErrorByConvo((prev) => ({ ...prev, [selected.id]: v }))
            }
            accessToken={accessToken}
            isMultiTrade={isMultiTrade}
            onGoToQuotes={onGoToQuotes}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <p className="p-6 text-[10px] uppercase tracking-[0.08em] text-text-dim">
            Select a conversation
          </p>
        )}
      </div>
    </div>
  )
}

/** Mono label-style filter toggle in the rail header — the reference's
 *  "All channels" idiom, made interactive. Hit area is expanded to ≥44px
 *  with an invisible pseudo-element so the dense header stays dense. */
function RailFilterButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative cursor-pointer text-[10px] font-bold uppercase tracking-[0.08em] transition-colors after:absolute after:-inset-x-1.5 after:-inset-y-[15px] focus-visible:outline-2 focus-visible:outline-accent ${
 active ? 'text-accent' : 'text-text-dim hover:text-text-pri'
 }`}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  )
}

/** One conversation in the rail. Active row gets the 2px accent left bar +
 *  sunken background per the reference rowStyle/avatarStyle. */
function ChatRailRow({
  chat,
  active,
  fallbackActive,
  isMultiTrade,
  onSelect,
}: {
  chat: ChatRow
  /** Explicitly selected (tapped) — styled current at every breakpoint
   *  and announced via aria-current. */
  active: boolean
  /** Desktop-only first-row fallback: the thread pane shows this row
   *  without a tap. Styled current from md up only (below md no thread
   *  is visible) and never announced as current. */
  fallbackActive: boolean
  isMultiTrade: boolean
  onSelect: () => void
}) {
  const who = chat.first_name || chat.from_number || 'Unknown caller'
  const initial = (who.replace(/[^a-zA-Z0-9]/g, '')[0] ?? '#').toUpperCase()
  const last = chat.messages[chat.messages.length - 1]
  // Reference prefixes outbound previews with the sender, so a rail scan
  // shows who spoke last.
  const preview = last
    ? `${last.direction === 'outbound' ? 'QuoteMax: ' : ''}${last.body}`
    : '—'
  const trade = chat.job_type ? deriveTradeFromJobType(chat.job_type) : null
  const meta = [
    chat.job_type ? formatJobType(chat.job_type) : 'Unclassified',
    isMultiTrade && trade ? trade : null,
    chat.suburb,
    chat.channel === 'voice' ? 'Voice' : 'SMS',
    chat.conversation_type === 'tradie_registration' ? 'Tradie signup' : null,
    chat.intake_id ? 'Quote drafted' : null,
    isColdChat(chat) ? 'Went cold' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`block w-full cursor-pointer border-b border-l-2 border-b-ink-line px-4 py-[15px] text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        active
          ? 'border-l-accent bg-ink'
          : fallbackActive
            ? 'border-l-transparent bg-transparent hover:bg-ink/55 md:border-l-accent md:bg-ink'
            : 'border-l-transparent hover:bg-ink/55'
      }`}
    >
      <div className="flex items-center gap-[11px]">
        <span
          aria-hidden="true"
          className={`inline-grid h-[34px] w-[34px] shrink-0 place-items-center border font-mono text-[13px] font-bold ${
            active
              ? 'border-transparent bg-accent text-accent-ink'
              : fallbackActive
                ? 'border-ink-line bg-ink text-text-pri md:border-transparent md:bg-accent md:text-accent-ink'
                : 'border-ink-line bg-ink text-text-pri'
          }`}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-bold text-text-pri">
              {who}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] text-text-dim">
              {relTime(chat.last_message_at ?? chat.created_at)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[9px] uppercase tracking-[0.08em] text-text-dim">
            {meta}
          </div>
        </div>
      </div>
      <div className="mt-2 truncate text-[12.5px] text-text-dim">
        {preview}
      </div>
    </button>
  )
}

/** Status chip in the thread header — the reference "Online" badge mapped
 *  to honest conversation states. */
function threadStatusChip(chat: ChatRow): {
  label: string
  tone: Tone
  pulse: boolean
} {
  const s = (chat.status ?? '').toLowerCase()
  if (s === 'open') return { label: 'Live', tone: 'success', pulse: true }
  if (s === 'structuring') return { label: 'Drafting', tone: 'warn', pulse: true }
  if (s === 'done') return { label: 'Completed', tone: 'success', pulse: false }
  if (s === 'abandoned') return { label: 'Went cold', tone: 'warn', pulse: false }
  return { label: chat.status ?? 'Unknown', tone: 'dim', pulse: false }
}

/** The live thread: sticky meta header, message bubbles (customer left,
 *  QuoteMax/You right per the reference), and the SMS composer. Remounts
 *  per conversation (keyed at the call site); all send state lives in the
 *  parent keyed by conversation id, so an in-flight send survives thread
 *  switches and can never double-fire. */
function ChatThread({
  chat,
  sent,
  draft,
  onDraft,
  onSent,
  sending,
  sendError,
  onSendingChange,
  onSendError,
  accessToken,
  isMultiTrade,
  onGoToQuotes,
  onBack,
}: {
  chat: ChatRow
  sent: ConvoMessage[]
  draft: string
  onDraft: (v: string) => void
  onSent: (m: ConvoMessage) => void
  sending: boolean
  sendError: string | null
  onSendingChange: (v: boolean) => void
  onSendError: (v: string | null) => void
  accessToken: string | null
  isMultiTrade: boolean
  onGoToQuotes: () => void
  onBack: () => void
}) {
  const messages = sent.length ? [...chat.messages, ...sent] : chat.messages
  const inboundCount = messages.filter((m) => m.direction === 'inbound').length
  const status = threadStatusChip(chat)
  const who = chat.first_name || chat.from_number || 'Unknown caller'
  const trade = chat.job_type ? deriveTradeFromJobType(chat.job_type) : null
  const headerMeta = [
    chat.channel === 'voice' ? 'Voice intake' : 'SMS intake',
    // When a name exists the number is no longer the row/header title, so
    // carry it here — the tradie must always be able to see the number.
    chat.first_name && chat.from_number ? chat.from_number : null,
    isMultiTrade && trade ? trade : null,
    `${inboundCount} in`,
    `${messages.length - inboundCount} out`,
    chat.channel === 'sms' && chat.turn_count
      ? `${chat.turn_count} turn${chat.turn_count === 1 ? '' : 's'}`
      : null,
    chat.channel === 'voice' && chat.duration_seconds
      ? `${Math.floor(chat.duration_seconds / 60)}:${String(chat.duration_seconds % 60).padStart(2, '0')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const canReply = chat.channel === 'sms' && Boolean(chat.from_number)

  async function submitReply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    onSendingChange(true)
    onSendError(null)
    try {
      const token = (await getAuthToken()) ?? accessToken
      const res = await fetch(`/api/tenant/chats/${chat.id}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ body: text }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      onSent(json.message as ConvoMessage)
      onDraft('')
    } catch (err: unknown) {
      onSendError(err instanceof Error ? err.message : String(err))
    } finally {
      onSendingChange(false)
    }
  }

  return (
    <>
      <div className="sticky top-[61px] z-[5] flex items-center justify-between gap-3 border-b border-ink-line bg-ink-deep px-4 py-[11px] md:top-0 md:px-5 md:py-[15px]">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="-ml-2 mr-1 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center text-text-dim transition-colors hover:text-text-pri focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent md:hidden"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span className="truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-dim">
            {who} · {headerMeta}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {chat.intake_id && (
            /* Reference labels this "Draft quote →" — the honest live
               action once a quote exists is opening it. */
            <button
              type="button"
              onClick={onGoToQuotes}
              className="relative inline-flex cursor-pointer items-center gap-[7px] border border-ink-line bg-transparent px-3 py-[7px] text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-pri transition-colors after:absolute after:-inset-x-1 after:-inset-y-[11px] hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open quote →
            </button>
          )}
          <StatusPill label={status.label} tone={status.tone} dot compact pulse={status.pulse} />
        </div>
      </div>

      <div className="grid w-full max-w-[880px] gap-3 px-5 py-[26px] md:px-[30px]">
        {messages.length === 0 ? (
          <p className=" text-[10px] uppercase tracking-[0.08em] text-text-dim">
            No messages recorded on this conversation.
          </p>
        ) : (
          messages.map((m, i) => {
            const inbound = m.direction === 'inbound'
            // Anything past the fetched history was sent from this composer
            // in-session → label it "You" instead of "QuoteMax".
            const mine = i >= chat.messages.length
            return (
              <div
                key={i}
                className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}
              >
                <div
                  title={`${formatDate(m.created_at)} ${formatTime(m.created_at)}`}
                  className={`max-w-[86%] whitespace-pre-wrap break-words px-[13px] py-2.5 text-sm leading-[1.45] ${
                    inbound
                      ? 'border border-ink-line bg-ink-deep text-text-sec'
                      : 'border border-accent/35 bg-accent/10 text-text-pri'
                  }`}
                >
                  {!inbound && (
                    <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.08em] text-accent">
                      {mine ? 'You' : 'QuoteMax'}
                    </span>
                  )}
                  {m.body}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="sticky bottom-0 mt-auto border-t border-ink-line bg-ink-deep px-4 py-3.5 md:px-6">
        {canReply ? (
          <>
            <form className="flex items-center gap-2.5" onSubmit={submitReply}>
              <input
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                placeholder="Reply by SMS"
                aria-label="Reply by SMS"
                disabled={sending}
                className="h-11 min-w-0 flex-1 border border-ink-line bg-ink px-3.5 text-sm text-text-pri outline-none transition-colors placeholder:text-text-dim focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                aria-busy={sending}
                className="inline-flex h-11 cursor-pointer items-center gap-2 bg-accent px-[18px] text-xs font-bold uppercase tracking-[0.06em] text-accent-ink transition-colors hover:bg-accent-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
            {sendError && (
              <p className="mt-2 text-[10px] uppercase tracking-[0.08em] text-danger-bright">
                Send failed — {sendError}
              </p>
            )}
          </>
        ) : (
          <p className=" text-[10px] uppercase tracking-[0.08em] text-text-dim">
            Voice call — no SMS thread
          </p>
        )}
      </div>
    </>
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
      <div className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
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

/** Render a snake_case job_type as title case ("blocked_drain" → "Blocked drain"). */
function formatJobType(j: string | null): string {
  if (!j) return '—'
  return j.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

// ─── Shared UI primitives ─────────────────────────────────────────

// ── Numbered pagination — 10 per page, used by the long list tabs ──
function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number
  pageCount: number
  onPage: (p: number) => void
}) {
  if (pageCount <= 1) return null
  const btn =
    'inline-flex items-center gap-1.5 border border-ink-line bg-ink-card px-3.5 py-2 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-text-sec transition-colors hover:border-accent/50 hover:text-text-pri disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer'
  return (
    <div className="mt-5 flex items-center justify-center gap-3 border-t border-ink-line pt-5">
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={page <= 0}
        className={btn}
        aria-label="Previous page"
      >
        ← Prev
      </button>
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim tabular-nums">
        Page {page + 1} of {pageCount}
      </span>
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={page >= pageCount - 1}
        className={btn}
        aria-label="Next page"
      >
        Next →
      </button>
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  /** Optional — when the page-level TabHeader already names the section,
   *  a top-level Card omits the title to avoid repeating it. */
  title?: string
  subtitle?: string
  children: ReactNode
}) {
  const hasHeader = !!title || !!subtitle
  return (
    <div className="rounded-card bg-ink-card border border-ink-line">
      {hasHeader && (
        <div className="border-b border-ink-line bg-ink-deep/35 px-4 sm:px-6 py-4 sm:py-5">
          {title && (
            <div className="flex items-center gap-2.5">
              {/* Accent tick — a small, functional brand marker that
                  gives every card header a finished, deliberate edge. */}
              <span
                aria-hidden="true"
                className="h-4 w-1 shrink-0 bg-accent"
              />
              <h2 className="font-extrabold uppercase text-base tracking-[-0.01em] text-text-pri">
                {title}
              </h2>
            </div>
          )}
          {subtitle && (
            <p
              className={`text-text-sec text-sm${
                title ? ' mt-2 pl-3.5' : ''
              }`}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}
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
    <span className=" text-[0.65rem] uppercase tracking-[0.08em] text-success-bright">
      ✓ Saved
    </span>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────

function tradeLabel(t: 'electrical' | 'plumbing' | 'roofing'): string {
  if (t === 'electrical') return 'Electrical'
  if (t === 'plumbing')   return 'Plumbing'
  return 'Roofing'
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
  if (isHubTab(t)) {
    return HUB_NAV.find((h) => h.slug === hubTrade(t))?.label ?? hubTrade(t)
  }
  switch (t) {
    case 'aircon':
      return 'AC'
    case 'invites':
      return 'Marketing'
    case 'files':
      return 'Files'
    case 'historical-quotes':
      return 'History'
    case 'overview':
      return 'Overview'
    case 'account':
      return 'Account'
    case 'payouts':
      return 'Payouts'
    case 'billing':
      return 'Billing'
    case 'pricing':
      return 'Pricing'
    case 'services':
      return 'Services'
    case 'quotes':
      return 'Quotes'
    case 'chats':
      return 'Chats'
    case 'calendar':
      return 'Calendar'
    case 'followups':
      return 'Follow-ups'
    case 'catalogue':
      return 'Catalogue'
    case 'estimating':
      return 'Estimating'
    case 'recipes':
      return 'Recipes'
    case 'roofing':
      return 'Roof'
    case 'signage':
      return 'Signage'
    case 'painting':
      return 'Paint'
    case 'commercial-painting':
      return 'Comm. paint'
    case 'estimator':
      return 'Estimator'
    case 'solar':
      return 'Solar'
    case 'flyer':
      return 'Flyer'
    case 'videos':
      return 'Videos'
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

// ─── Signage compliance hub tab ────────────────────────────────────
// The HQ signage-compliance product. The heavy surfaces live at their
// own routes (/dashboard/signage + /dashboard/signage/queue) so they get
// full-screen real estate; this tab is the launch pad.
type SgRequest = {
  id: string
  studio_name: string
  token: string
  link: string
  state: string
  overall: string | null
  assessment_id: string | null
}
type SgSweep = { id: string; name: string; created_at: string; status: string; requests: SgRequest[] }
type SgRollup = {
  studios: number
  assessed: number
  pass: number
  fix_needed: number
  needs_review: number
  awaiting: number
}

function SignageHubTab({ accessToken }: { accessToken: string | null }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sweeps, setSweeps] = useState<SgSweep[]>([])
  const [rollup, setRollup] = useState<SgRollup | null>(null)

  const load = useCallback(async () => {
    // Mint a FRESH token per request — the Clerk session token captured at
    // mount (the accessToken prop) expires ~60s later, so reusing it 401s
    // ("unauthorized"). getAuthToken() returns a current Clerk token (or the
    // legacy Supabase one); fall back to the prop.
    const token = (await getAuthToken()) ?? accessToken
    if (!token) {
      setErr('Not signed in')
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const headers = { Authorization: `Bearer ${token}` }
      const [sRes, qRes] = await Promise.all([
        fetch('/api/signage/sweeps', { headers, cache: 'no-store' }),
        fetch('/api/signage/queue?status=all', { headers, cache: 'no-store' }),
      ])
      const sJson = (await sRes.json().catch(() => ({}))) as {
        ok?: boolean
        sweeps?: SgSweep[]
        error?: string
      }
      if (!sRes.ok || !sJson.ok) {
        throw new Error(
          sJson.error === 'unauthorized'
            ? 'No franchisor org is linked to this account yet — seed one with scripts/seed-signage-demo.mjs.'
            : sJson.error || `HTTP ${sRes.status}`,
        )
      }
      setSweeps(sJson.sweeps ?? [])
      const qJson = (await qRes.json().catch(() => ({}))) as { ok?: boolean; rollup?: SgRollup }
      if (qJson?.ok && qJson.rollup) setRollup(qJson.rollup)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void load()
  }, [load])

  // Flatten every sweep's requests into one recent-first history list — the
  // signage analogue of the roofing tab's "Saved roofing jobs". Sweeps come
  // back newest-first from the API, so this preserves recency.
  const recent: Array<SgRequest & { sweep_name: string }> = []
  for (const sw of sweeps) for (const r of sw.requests) recent.push({ ...r, sweep_name: sw.name })
  const recentTop = recent.slice(0, 15)

  return (
    <div className="space-y-7">
      <div>
        <h2 className="font-extrabold uppercase tracking-[-0.025em] text-[clamp(1.5rem,2.6vw,2.25rem)] leading-[1.1] text-text-pri">
          Signage compliance
        </h2>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-text-sec">
          Request photos from your studios, let the AI pre-check them against the F45 brand
          standards, and review the flagged ones. The AI triages — HQ decides.
        </p>
      </div>

      {rollup && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <SgStat label="Studios" value={rollup.studios} />
          <SgStat label="Assessed" value={rollup.assessed} />
          <SgStat label="Compliant" value={rollup.pass} tone="good" />
          <SgStat label="To fix" value={rollup.fix_needed} tone="warn" />
          <SgStat label="Needs review" value={rollup.needs_review} tone="accent" />
          <SgStat label="Awaiting" value={rollup.awaiting} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Link
          href="/dashboard/signage"
          className="rounded-card group flex flex-col gap-5 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-7"
        >
          <span className="font-mono text-4xl font-bold leading-none text-accent sm:text-5xl">01</span>
          <div className="flex-1">
            <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
              Compliance sweep
            </div>
            <h3 className="mt-2 font-extrabold uppercase tracking-[-0.02em] text-xl text-text-pri sm:text-2xl">
              Run a sweep
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-text-sec">
              Pick a region + the photos to request; each studio gets a tokenised upload link
              and the AI scores their signage as they respond.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-transform group-hover:translate-x-1">
              Open sweeps <span aria-hidden="true">&rarr;</span>
            </div>
          </div>
        </Link>

        <Link
          href="/dashboard/signage/queue"
          className="rounded-card group flex flex-col gap-5 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-7"
        >
          <span className="font-mono text-4xl font-bold leading-none text-accent sm:text-5xl">02</span>
          <div className="flex-1">
            <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
              Human review
            </div>
            <h3 className="mt-2 font-extrabold uppercase tracking-[-0.02em] text-xl text-text-pri sm:text-2xl">
              Review queue
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-text-sec">
              The AI flags non-compliant + can&rsquo;t-determine items; you approve, request
              changes, or escalate. A green report is a pre-check, never automatic HQ approval.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-transform group-hover:translate-x-1">
              Open queue <span aria-hidden="true">&rarr;</span>
            </div>
          </div>
        </Link>
      </div>

      {/* Recent requests — the signage analogue of "Saved roofing jobs".
          Every sweep + request auto-persists, so this history is always
          live; click through to review an assessed studio. */}
      <div className="rounded-card border border-ink-line bg-ink-card p-7 sm:p-9">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-accent">
            Recent requests{recent.length ? ` · ${recent.length}` : ''}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
          >
            Refresh
          </button>
        </div>

        {loading && <p className="qm-loading mt-4 text-base text-text-dim">Loading recent requests…</p>}
        {err && !loading && <p className="mt-4 text-base text-warning">{err}</p>}
        {!loading && !err && recentTop.length === 0 && (
          <p className="mt-4 text-base text-text-sec">
            No requests yet. Run a sweep to send your studios their upload links — each one shows
            up here as it responds.
          </p>
        )}

        {recentTop.length > 0 && (
          <div className="mt-4 grid gap-2">
            {recentTop.map((r) => (
              <div
                key={r.id}
                className="rounded-card flex flex-wrap items-center justify-between gap-3 border border-ink-line bg-ink-deep px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <SgChip state={r.state} overall={r.overall} />
                  <div>
                    <div className="font-mono text-sm text-text-pri">{r.studio_name}</div>
                    <div className=" text-[0.66rem] uppercase tracking-[0.08em] text-text-dim">
                      {r.sweep_name}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={r.link}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-ctl inline-flex items-center gap-1.5 border border-ink-line px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-sec transition-colors hover:border-accent hover:text-accent"
                  >
                    Open <span aria-hidden="true">&#8599;</span>
                  </a>
                  {r.assessment_id && (
                    <Link
                      href={`/dashboard/signage/queue?a=${r.assessment_id}`}
                      className="bg-accent px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-white transition-colors hover:bg-accent-press"
                    >
                      Review
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SgStat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'accent' }) {
  const colour =
    tone === 'good' ? 'text-teal-glow' : tone === 'warn' ? 'text-warning' : tone === 'accent' ? 'text-accent' : 'text-text-pri'
  return (
    <div className="rounded-card border border-ink-line bg-ink-card p-4">
      <div className=" text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-text-dim">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
    </div>
  )
}

function SgChip({ state, overall }: { state: string; overall: string | null }) {
  const { label, tone }: { label: string; tone: Tone } =
    overall === 'pass'
      ? { label: 'Compliant', tone: 'success' }
      : overall === 'fix_needed'
        ? { label: 'To fix', tone: 'warn' }
        : overall === 'needs_review'
          ? { label: 'Needs review', tone: 'warn' }
          : state === 'submitted'
            ? { label: 'Scoring…', tone: 'dim' }
            : { label: 'Awaiting', tone: 'dim' }
  return <StatusPill label={label} tone={tone} dot compact />
}

// ─── Painting hub tab (Phase 1 scaffold) ───────────────────────────
// Not trade-gated yet (no tenant has 'painting' in trades[]). The hub is
// intentionally minimal — the estimate tool lives at /dashboard/painting,
// a separate route with full-screen real estate and its own two tabs
// ("realestate.com.au" + "Other tools"). Future: recent estimates,
// floor-plan upload, save-as-quote.

type SavedPaintJob = {
  id: string
  address: string | null
  postcode: string | null
  state: string | null
  customer_name: string | null
  source: string | null
  scopes: string[] | null
  floor_area_m2: number | null
  total_area_m2: number | null
  confidence: string | null
  better_inc_gst: number | null
  routing: string | null
  public_token: string | null
  estimate_token: string | null
  created_at: string
}

function PaintingHubTab({ accessToken }: { accessToken: string | null }) {
  const [jobs, setJobs] = useState<SavedPaintJob[] | null>(null)
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const {
    page: jobPage,
    setPage: setJobPage,
    totalPages: jobTotalPages,
    pageItems: jobRows,
    startIndex: jobStart,
    endIndex: jobEnd,
    total: jobTotal,
  } = usePagination(jobs ?? [], { urlKey: 'paint_page' })

  const loadJobs = useCallback(async () => {
    // Mint a FRESH token per request — the Clerk session token captured at
    // mount (the accessToken prop) expires ~60s later, so reusing it 401s
    // ("Couldn't load saved jobs: unauthorized"). getAuthToken() returns a
    // current Clerk token (or the legacy Supabase one); fall back to the prop.
    const token = (await getAuthToken()) ?? accessToken
    if (!token) {
      setJobsError('Not signed in')
      setLoadingJobs(false)
      return
    }
    setLoadingJobs(true)
    setJobsError(null)
    try {
      const res = await fetch('/api/painting/save', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        jobs?: SavedPaintJob[]
        error?: string
      }
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setJobs(json.jobs ?? [])
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingJobs(false)
    }
  }, [accessToken])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (cancelled) return
      await loadJobs()
    })()
    return () => {
      cancelled = true
    }
  }, [loadJobs])
  return (
    <div className="space-y-7">
      {/* No inner heading — the tab shell already renders the "Paint tools"
          header from TAB_COPY, and doubling it read as a rendering bug. */}
      <Link
        href="/dashboard/painting"
        className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
      >
        <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
          01
        </span>
        <div className="flex-1">
          <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
            Address estimate
          </div>
          <h3 className="mt-2 font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
            Estimate a paint job
          </h3>
          <p className="mt-4 text-base leading-relaxed text-text-sec">
            Address → property lookup → paintable wall / ceiling / trim /
            exterior m² with a confidence band → tiered price range. One tab
            for realestate.com.au, one for the footprint / floor-plan stack.
          </p>
          <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
            Open paint estimate <span aria-hidden="true">&rarr;</span>
          </span>
        </div>
      </Link>

      {/* Saved paint jobs — history of every "Save job", scoped to this tenant. */}
      <div className="rounded-card border border-ink-line bg-ink-card p-7 sm:p-9">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-accent">
            Saved paint jobs{jobs ? ` · ${jobs.length}` : ''}
          </div>
          <button
            type="button"
            onClick={() => void loadJobs()}
            className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
          >
            Refresh
          </button>
        </div>

        {loadingJobs && <p className="qm-loading mt-4 text-base text-text-dim">Loading saved jobs…</p>}
        {jobsError && !loadingJobs && (
          <p className="mt-4 text-base text-warning">Couldn&apos;t load saved jobs: {jobsError}</p>
        )}
        {!loadingJobs && !jobsError && jobs && jobs.length === 0 && (
          <p className="mt-4 text-base text-text-dim">
            No saved jobs yet. Run an estimate and hit{' '}
            <span className="text-text-pri">Save job</span> — it&apos;ll show up here.
          </p>
        )}
        {!loadingJobs && !jobsError && jobs && jobs.length > 0 && (
          <>
          <ul className="mt-5 space-y-3">
            {jobRows.map((j) => {
              const inspection = j.routing === 'inspection_required'
              const scopes = Array.isArray(j.scopes) ? j.scopes : []
              return (
                <li key={j.id} className="rounded-card border border-ink-line bg-ink-deep p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-text-pri">
                        {j.address ?? 'Unknown address'}
                      </div>
                      <div className="mt-1 font-mono text-xs text-text-dim">
                        {inspection ? 'Inspection' : fmtAUD(j.better_inc_gst)}
                        {scopes.length ? ` · ${scopes.join(', ')}` : ''}
                        {j.total_area_m2 ? ` · ${Math.round(j.total_area_m2)} m²` : ''}
                        {j.confidence ? ` · ${j.confidence} conf` : ''}
                        {` · ${formatDate(j.created_at)}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-3">
                      <Pill tone={inspection ? 'warn' : 'ok'} label={inspection ? 'Inspection' : 'Quote'} />
                      {/* Same three CTAs the quotes queue offers, so the hub's
                          list never strands a job behind a status pill.
                          hover:text-text-pri, not hover:text-accent — the
                          light-theme accent shim covers only the static
                          .text-accent class, so a hover:text-accent label
                          would flash yellow-on-cream (~1.6:1). */}
                      {j.estimate_token && (
                        <Link
                          href={`/p/${j.estimate_token}`}
                          className="py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-pri"
                        >
                          Estimate results →
                        </Link>
                      )}
                      {j.public_token && (
                        <Link
                          href={`/q/paint/${j.public_token}`}
                          target="_blank"
                          className="py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-pri"
                        >
                          Customer page →
                        </Link>
                      )}
                      {j.public_token && !inspection && (
                        <a
                          href={`/api/q/paint/${j.public_token}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
                        >
                          PDF ↓
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <PaginationControls
            page={jobPage}
            totalPages={jobTotalPages}
            onPageChange={setJobPage}
            startIndex={jobStart}
            endIndex={jobEnd}
            total={jobTotal}
            unit="jobs"
          />
          </>
        )}
      </div>
    </div>
  )
}

// ─── Roofing hub tab (v10) ─────────────────────────────────────────
// Only rendered when tenant.trades includes 'roofing'. The hub itself
// is intentionally minimal — the heavy lifting lives at
// /dashboard/roofing/measure, kept as a separate route so it gets its
// own URL + full-screen real estate. Future hub additions: recent
// measurement history, coverage indicator, "Generate quote from
// measurement" CTAs.

type SavedRoofJob = {
  id: string
  address: string | null
  postcode: string | null
  state: string | null
  customer_name: string | null
  structure_count: number | null
  combined_area_m2: number | null
  combined_better_inc_gst: number | null
  routing: string | null
  public_token: string | null
  measure_token: string | null
  created_at: string
}

function RoofingHubTab({ accessToken }: { accessToken: string | null }) {
  const [jobs, setJobs] = useState<SavedRoofJob[] | null>(null)
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const {
    page: jobPage,
    setPage: setJobPage,
    totalPages: jobTotalPages,
    pageItems: jobRows,
    startIndex: jobStart,
    endIndex: jobEnd,
    total: jobTotal,
  } = usePagination(jobs ?? [], { urlKey: 'roof_page' })

  const loadJobs = useCallback(async () => {
    // Mint a FRESH token per request — the Clerk session token captured at
    // mount (the accessToken prop) expires ~60s later, so reusing it 401s
    // ("Couldn't load saved jobs: unauthorized"). getAuthToken() returns a
    // current Clerk token (or the legacy Supabase one); fall back to the prop.
    const token = (await getAuthToken()) ?? accessToken
    if (!token) {
      setJobsError('Not signed in')
      setLoadingJobs(false)
      return
    }
    setLoadingJobs(true)
    setJobsError(null)
    try {
      const res = await fetch('/api/roofing/save', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        jobs?: SavedRoofJob[]
        error?: string
      }
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setJobs(json.jobs ?? [])
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingJobs(false)
    }
  }, [accessToken])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (cancelled) return
      await loadJobs()
    })()
    return () => {
      cancelled = true
    }
  }, [loadJobs])

  return (
    <div className="space-y-7">
      {/* No inner heading — the tab shell already renders the "Roof tools"
          header from TAB_COPY, and doubling it read as a rendering bug. */}
      <Link
        href="/dashboard/roofing/measure"
        className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
      >
        <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
          01
        </span>
        <div className="flex-1">
          <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
            Address measurement
          </div>
          <h3 className="mt-2 font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
            Measure a roof
          </h3>
          <p className="mt-4 text-base leading-relaxed text-text-sec">
            Address → Geoscape lookup → sloped m², roof form, hip / valley
            count, storeys. Apply your $/m² rate and stack multi-storey +
            asbestos loadings. Returns Good / Better / Best price tiers
            ready to turn into a customer quote.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-transform group-hover:translate-x-1">
            Open measurement tool <span aria-hidden="true">&rarr;</span>
          </div>
        </div>
      </Link>

      {/* Saved roofing jobs — history of every "Save job" from the
          measure tool, scoped to this tenant. Click View to open the
          customer quote page (/q/roof/[token]). */}
      <div className="rounded-card border border-ink-line bg-ink-card p-7 sm:p-9">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-accent">
            Saved roofing jobs{jobs ? ` · ${jobs.length}` : ''}
          </div>
          <button
            type="button"
            onClick={() => void loadJobs()}
            className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
          >
            Refresh
          </button>
        </div>

        {loadingJobs && (
          <p className="qm-loading mt-4 text-base text-text-dim">Loading saved jobs…</p>
        )}
        {jobsError && !loadingJobs && (
          <p className="mt-4 text-base text-warning">Couldn&apos;t load saved jobs: {jobsError}</p>
        )}
        {!loadingJobs && !jobsError && jobs && jobs.length === 0 && (
          <p className="mt-4 text-base text-text-dim">
            No saved jobs yet. Measure a roof above and hit{' '}
            <span className="text-text-pri">Save job</span> — it&apos;ll show up here.
          </p>
        )}
        {!loadingJobs && !jobsError && jobs && jobs.length > 0 && (
          <>
          <ul className="mt-5 space-y-3">
            {jobRows.map((j) => {
              const inspection = j.routing === 'inspection_required'
              const structures = j.structure_count ?? 1
              return (
                <li key={j.id} className="rounded-card border border-ink-line bg-ink-deep p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-text-pri">
                        {j.address ?? 'Unknown address'}
                      </div>
                      <div className="mt-1 font-mono text-xs text-text-dim">
                        {inspection ? 'Inspection' : fmtAUD(j.combined_better_inc_gst)}
                        {` · ${structures} structure${structures === 1 ? '' : 's'}`}
                        {j.combined_area_m2 ? ` · ${Math.round(j.combined_area_m2)} m²` : ''}
                        {` · ${formatDate(j.created_at)}`}
                      </div>
                    </div>
                    <Pill tone={inspection ? 'warn' : 'ok'} label={inspection ? 'Inspection' : 'Quote'} />
                  </div>

                  {/* Saved quote, tradie-facing measurement review, and private
                      synthetic topology-evidence preview. */}
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-card border border-ink-line bg-ink-card p-4">
                      <div className=" text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-accent">
                        Saved roofing job
                      </div>
                      <p className="mt-1 text-xs text-text-dim">
                        Customer quote page{inspection ? '' : ' + PDF'}
                      </p>
                      <div className="mt-3 flex items-center gap-4">
                        {j.public_token && (
                          <a
                            // ?full=1 — the tradie's View opens the RICH
                            // measurement page (satellite + structures +
                            // layout map, live selection pricing) even after
                            // promotion; without it the promoted redirect
                            // landed on the generic quote whose geocoded hero
                            // often showed the wrong building.
                            href={`/q/roof/${j.public_token}?full=1`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className=" text-xs font-semibold uppercase tracking-[0.08em] text-accent hover:underline"
                          >
                            View &rarr;
                          </a>
                        )}
                        {j.public_token && !inspection && (
                          <a
                            href={`/api/q/roof/${j.public_token}/pdf`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
                          >
                            PDF ↓
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="rounded-card border border-ink-line bg-ink-card p-4">
                      <div className=" text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-teal-glow">
                        Measurement results
                      </div>
                      <p className="mt-1 text-xs text-text-dim">
                        {`${structures} structure${structures === 1 ? '' : 's'}`}
                        {j.combined_area_m2 ? ` · ${Math.round(j.combined_area_m2)} m²` : ''}
                        {!inspection ? ` · ${fmtAUD(j.combined_better_inc_gst)}` : ''}
                      </p>
                      <div className="mt-3 flex items-center gap-4">
                        {j.measure_token ? (
                          <a
                            href={`/m/${j.measure_token}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className=" text-xs font-semibold uppercase tracking-[0.08em] text-accent hover:underline"
                          >
                            Open &rarr;
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-text-dim">Re-measure to enable</span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-card border border-ink-line bg-ink-card p-4">
                      <div className=" text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-accent">
                        Topology evidence
                      </div>
                      <p className="mt-1 text-xs text-text-dim">
                        Private candidate overlay · ridges, hips, valleys and eaves
                      </p>
                      <div className="mt-3 flex items-center gap-4">
                        <Link
                          href={`/dashboard/roofing/measurements/${j.id}/topology`}
                          className=" text-xs font-semibold uppercase tracking-[0.08em] text-accent hover:underline"
                        >
                          Open evidence &rarr;
                        </Link>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <PaginationControls
            page={jobPage}
            totalPages={jobTotalPages}
            onPageChange={setJobPage}
            startIndex={jobStart}
            endIndex={jobEnd}
            total={jobTotal}
            unit="jobs"
          />
          </>
        )}
      </div>

      <div className="rounded-card border border-ink-line bg-ink-card p-7 sm:p-9">
        <div className=" text-[0.78rem] font-semibold uppercase tracking-[0.08em] text-accent">
          What's live in Phase 1
        </div>
        <ul className="mt-4 space-y-2 text-base leading-relaxed text-text-sec">
          <li className="flex items-baseline gap-3">
            <span className="text-accent">·</span>
            <span>Geoscape Buildings precomputed footprint + roof form lookup</span>
          </li>
          <li className="flex items-baseline gap-3">
            <span className="text-accent">·</span>
            <span>Customer-declared pitch (shallow / standard / steep)</span>
          </li>
          <li className="flex items-baseline gap-3">
            <span className="text-accent">·</span>
            <span>Deterministic $/m² × area × loadings — no Opus on the money path</span>
          </li>
          <li className="flex items-baseline gap-3">
            <span className="text-accent">·</span>
            <span>Auto-routes to inspection on cement-sheet / pre-1990 / complex form / 3+ storeys</span>
          </li>
        </ul>
        <p className="mt-5 text-sm text-text-dim">
          Phase 2 — open Australian LiDAR (ELVIS + PDAL + Open3D) replaces
          Geoscape behind the same interface for true 3D area + accurate
          hip / valley counts. See <code className="font-mono">docs/strategy.md</code> v10.
        </p>
      </div>
    </div>
  )
}

// ─── Trade hub ────────────────────────────────────────────────────
//
// One tab per enabled trade, consolidating everything that used to be
// spread across the cross-trade Pricing / Services / Catalogue /
// Estimating / Recipes tabs plus the per-trade tool tabs (roofing,
// signage, painting, commercial-painting, aircon, estimator, solar).
// Every section reuses the existing tab component with tradeFilter set,
// so behaviour and save paths are identical — only the scope changes.
// Section state is local: switching hubs remounts via the explicit
// key={tab} on the <TradeHub> element in DashboardPage, so each hub
// opens on its default section.

type HubSection =
  | 'tools'
  | 'pricing'
  | 'services'
  | 'catalogue'
  | 'recipes'
  | 'estimating'
  | 'quotes'

const HUB_SECTION_LABELS: Record<HubSection, string> = {
  tools: 'Tools',
  pricing: 'Pricing',
  services: 'Services & brands',
  catalogue: 'Catalogue',
  recipes: 'Recipes',
  estimating: 'Estimating',
  quotes: 'Quotes',
}

const HUB_SECTION_ICONS: Record<HubSection, NavIcon> = {
  tools: Wrench,
  pricing: DollarSign,
  services: ClipboardList,
  catalogue: Package,
  recipes: LayoutTemplate,
  estimating: Calculator,
  quotes: FileText,
}

/** Trades that ship an interactive tool panel (the old tool tabs). */
const HUB_TOOL_TRADES: readonly TradeHubSlug[] = [
  'electrical',
  'plumbing',
  'roofing',
  'signage',
  'painting',
  'commercial_painting',
  'aircon',
  'solar',
]

/** Tools-tab entry into the tradie-typed job quoter (/dashboard/job/[trade]).
 *  Electrical and plumbing had no portal quoting surface — both trades were
 *  reachable only through the SMS receptionist. */
function JobQuoterCard({ trade }: { trade: 'electrical' | 'plumbing' }) {
  return (
    <Link
      href={`/dashboard/job/${trade}`}
      className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
    >
      <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
        {trade === 'electrical' ? 'EL' : 'PL'}
      </span>
      <div className="flex-1">
        <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
          Quote {trade === 'electrical' ? 'an' : 'a'} {trade} job
        </h3>
        <p className="mt-4 text-base leading-relaxed text-text-sec">
          Pick the job type &mdash; downlights, smoke alarms, blocked drain and the rest &mdash; fill
          in the details, and get a drafted quote. Nothing reaches the customer until you send it.
        </p>
        <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
          Open job quoter <span aria-hidden="true">&rarr;</span>
        </span>
      </div>
    </Link>
  )
}

function TradeHub({
  trade,
  data,
  accessToken,
  onSave,
  onCreateCustom,
  onUpdateCustom,
  onDeleteCustom,
  onQuoteDeleted,
}: {
  trade: TradeHubSlug
  data: DashboardData
  accessToken: string | null
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onCreateCustom: (payload: Record<string, unknown>) => Promise<unknown>
  onUpdateCustom: (id: string, payload: Record<string, unknown>) => Promise<unknown>
  onDeleteCustom: (id: string) => Promise<void>
  onQuoteDeleted: (id: string) => void
}) {
  const label = HUB_NAV.find((h) => h.slug === trade)?.label ?? trade
  const hasTools = HUB_TOOL_TRADES.includes(trade)
  // Quotes-first: clicking a trade lands the tradie on that trade's quotes
  // (the daily job), with pricing / tools / setup as secondary chips.
  const sections: HubSection[] = [
    'quotes',
    ...(hasTools ? (['tools'] as HubSection[]) : []),
    'pricing',
    'services',
    'catalogue',
    'recipes',
    'estimating',
  ]
  const [section, setSection] = useState<HubSection>('quotes')
  const quoteCount = data.quotes.filter(
    (q) => (q.trade ?? '').toLowerCase() === trade,
  ).length

  return (
    <section
      className="-mx-4 -mb-20 min-h-[calc(100dvh-4rem)] sm:-mx-6 lg:-mx-8 lg:-mt-6"
      aria-labelledby={`trade-hub-title-${trade}`}
    >
      <header className="border-b border-ink-line bg-ink-deep px-4 pt-6 sm:px-6 sm:pt-7 lg:px-8 lg:pt-8 xl:px-10">
        {/* Same treatment the shared TabHeader got — the trade hubs render
            their own header, so they were missed by that pass and ended up
            the only surfaces still opening with a breadcrumb and a 48px
            ALL-CAPS title. "QuoteMax · Dashboard · Trades" was identical on
            every hub and the sidebar already marks the active trade. */}
        <h1
          id={`trade-hub-title-${trade}`}
          className="font-extrabold leading-[1.15] tracking-tight text-text-pri text-[clamp(1.35rem,2.6vw,1.85rem)]"
        >
          {label}
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-text-sec">
          Everything for your {label.toLowerCase()} work in one place — quotes,{' '}
          {hasTools ? 'tools, ' : ''}pricing, services, brands, catalogue, recipes
          and estimating.
        </p>
        <dl className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2 border-y border-ink-line py-3">
          <div className="flex items-baseline gap-2">
            <dt className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim">
              Sections
            </dt>
            <dd className="font-mono text-sm font-bold tabular-nums text-text-pri">
              {String(sections.length).padStart(2, '0')}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-dim">
              Quotes
            </dt>
            <dd className="font-mono text-sm font-bold tabular-nums text-text-pri">
              {String(quoteCount).padStart(2, '0')}
            </dd>
          </div>
        </dl>

        {/* Section filters stay as aria-pressed buttons instead of a tablist:
            the existing interaction uses normal document tab order rather
            than roving arrow-key focus. */}
        {/* Seven sections in a 2-column grid meant FOUR rows of buttons on a
            phone before any content appeared. Below sm this is now one
            horizontal line that scrolls, with the same right-edge fade the
            dashboard tab strip and the status chips use — so every scrolling
            rail in the product behaves identically. The negative margin lets
            it bleed to the viewport edge, so the fade lands at the screen
            boundary rather than inside the gutter. From sm up it wraps as
            before, where there is room for it. */}
        <nav
          className="-mx-4 flex gap-2 overflow-x-auto px-4 py-4 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none]"
          aria-label={`${label} sections`}
        >
          {sections.map((s) => {
            const active = s === section
            const Icon = HUB_SECTION_ICONS[s]
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                aria-controls={`trade-hub-panel-${trade}`}
                onClick={() => setSection(s)}
                // `rounded-ctl` + `shrink-0 whitespace-nowrap`.
                //
                // These buttons were SQUARE while every other surface in the
                // cockpit rounds — DESIGN.md is explicit that the dashboard
                // uses 14px cards / 9px controls and says "do not square any
                // surface", so the section nav was the piece breaking the
                // system, not the filter chips beneath it. Rounding it is what
                // makes the two read as one family.
                //
                // They stay one RANK heavier than the filters on purpose:
                // 44px, an icon, and a solid accent fill when active, against
                // the filters' 34px, no icon, 10% tint. Navigation changes
                // which surface you are on; a filter narrows the list already
                // in front of you. Matching them exactly would flatten that.
                className={`inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-start gap-2 whitespace-nowrap rounded-ctl border px-3.5 py-2.5 text-left text-xs font-bold uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-offset-2 focus-visible:ring-offset-ink-deep sm:justify-center sm:px-4 ${
 active
 ? 'border-accent bg-accent text-accent-ink'
 : 'border-ink-line bg-transparent text-text-sec hover:border-text-dim hover:bg-ink-card hover:text-text-pri'
 }`}
              >
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="shrink-0"
                />
                <span>{HUB_SECTION_LABELS[s]}</span>
                {s === 'quotes' && quoteCount > 0 && (
                  <span
                    // Rounded to match its parent button and the count chips
                    // in the sidebar rail — it was the last square element in
                    // the cockpit. Stays mono: it is a number.
                    className={`rounded-[5px] border px-1.5 py-0.5 font-mono text-[0.65rem] tabular-nums ${
                      active
                        ? 'border-accent-ink/35 text-accent-ink'
                        : 'border-ink-line text-text-pri'
                    }`}
                  >
                    {quoteCount}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </header>

      {/* No key and no per-switch fade (spec R3) — keying by section
          remounted the whole hub body on every chip click just to replay
          the fade; sections still swap via the conditional renders below. */}
      <div
        id={`trade-hub-panel-${trade}`}
        role="region"
        aria-label={`${label} ${HUB_SECTION_LABELS[section]}`}
        className="px-4 py-6 sm:px-6 sm:py-7 lg:px-8 lg:py-8 xl:px-10"
      >
        {section === 'tools' && trade === 'electrical' && (
          <div className="space-y-7">
            <JobQuoterCard trade="electrical" />
            <EstimatorBetaTab accessToken={accessToken} />
          </div>
        )}
        {section === 'tools' && trade === 'plumbing' && (
          <div className="space-y-7">
            <JobQuoterCard trade="plumbing" />
          </div>
        )}
        {section === 'tools' && trade === 'roofing' && (
          <RoofingHubTab accessToken={accessToken} />
        )}
        {section === 'tools' && trade === 'signage' && (
          <SignageHubTab accessToken={accessToken} />
        )}
        {section === 'tools' && trade === 'painting' && (
          <PaintingHubTab accessToken={accessToken} />
        )}
        {section === 'tools' && trade === 'commercial_painting' && (
          <CommercialPaintingTab accessToken={accessToken} />
        )}
        {section === 'tools' && trade === 'solar' && (
          <SolarTab
            accessToken={accessToken}
            tenantId={data.tenant.id}
            appUrl={process.env.NEXT_PUBLIC_APP_URL ?? null}
          />
        )}
        {section === 'tools' && trade === 'aircon' && (
          <div className="space-y-7">
            <Link
              href="/dashboard/aircon"
              className="rounded-card group flex flex-col gap-6 border border-ink-line bg-ink-card p-7 transition-colors hover:border-accent sm:flex-row sm:items-start sm:gap-8 sm:p-9"
            >
              <span className="font-mono text-5xl font-bold leading-none text-accent sm:text-6xl">
                AC
              </span>
              <div className="flex-1">
                <h3 className="font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri sm:text-[1.75rem]">
                  Air-conditioning recommender
                </h3>
                <p className="mt-4 text-base leading-relaxed text-text-sec">
                  Size a home and get an indicative ducted-vs-split recommendation with a price range. Opens the full tool.
                </p>
                <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-accent transition-colors group-hover:text-accent-press">
                  Open AC recommender <span aria-hidden="true">&rarr;</span>
                </span>
              </div>
            </Link>
          </div>
        )}

        {section === 'pricing' && (
          <div className="space-y-6">
            <PricingTab
              data={data}
              onSave={onSave}
              accessToken={accessToken}
              tradeFilter={trade}
            />
            {/* Guided setup entry — the wizard opens scoped to this trade
                (?trade=) so its rate card, services and brand steps only
                touch this hub's trade. */}
            <Link
              href={`/dashboard/pricing-wizard?trade=${trade}`}
              className="rounded-card group flex items-center gap-3 border border-ink-line bg-ink-card px-5 py-4 transition-colors hover:border-accent"
            >
              <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-accent" />
              <span className="flex-1 text-sm text-text-sec">
                <span className=" text-[0.7rem] font-bold uppercase tracking-[0.08em] text-accent">
                  Pricing wizard
                </span>
                <span className="block mt-0.5">
                  Guided setup for your {label.toLowerCase()} rates, services and preferred brands.
                </span>
              </span>
              <span aria-hidden="true" className="text-accent">&rarr;</span>
            </Link>
          </div>
        )}

        {section === 'services' && (
          <ServicesTab
            data={data}
            onSave={onSave}
            onCreateCustom={onCreateCustom}
            onUpdateCustom={onUpdateCustom}
            onDeleteCustom={onDeleteCustom}
            tradeFilter={trade}
          />
        )}

        {section === 'catalogue' && (
          <CatalogueTab accessToken={accessToken} tradeFilter={trade} />
        )}

        {section === 'recipes' && (
          <RecipesTab accessToken={accessToken} tradeFilter={trade} />
        )}

        {section === 'estimating' && (
          <EstimatingTab accessToken={accessToken} tradeFilter={trade} />
        )}

        {section === 'quotes' && (
          <QuotesTab
            data={data}
            accessToken={accessToken}
            onQuoteDeleted={onQuoteDeleted}
            tradeFilter={trade}
          />
        )}
      </div>
    </section>
  )
}
