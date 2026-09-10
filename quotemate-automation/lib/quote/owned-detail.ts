import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTE_EDIT_FIELDS, quoteEditRevision, validOwnedQuoteBook } from './edit-authority'
import { getReportAdapter, tradeGroundingMode } from './report-adapters/registry'
import { isSiteVisitFirstTrade } from './mint-tier'
import { MIN_STRIPE_CHARGE_CENTS } from './money'
import { connectDestinationForTenant, type TenantConnectState } from '@/lib/stripe/connect'
import { quoteDeletionPermission } from './delete-authority'
import { loadQuotePricingVersion, versionedQuoteGst, QuotePricingVersionError, type QuotePricingVersion } from './pricing-version'
import { readQuoteDraftReadiness } from './job-quote-operation'
import { quoteCustomerReleaseRevision } from './customer-release'
import { quoteChainMoney, storedDepositPercent } from './chain-money'
import { buildDefaultReportDoc } from './report-doc/seed'
import { validateReportDocWrite } from './report-doc/validate-write'
import { resolveOwnedQuoteCustomerContact } from './delivery-recipient'
import { readQuoteCreditSettlement } from './credit-settlement'

type Row = Record<string, unknown>
export type OwnedQuoteTenant = TenantConnectState & { id: string }
type Permission = { allowed: boolean; reason: string | null }
type Eligibility = Permission & { existing_quote_id: string | null }
type ChildPage = { limit: number; cursor: { parent: string; created_at: string; id: string } | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const VIEW_FIELDS = [
  'id', 'tenant_id', 'intake_id', 'created_at', 'sent_at', 'customer_released_at', 'status', 'paid_at', 'paid_tier',
  'quote_kind', 'parent_quote_id', 'share_token', 'selected_tier', 'total_inc_gst',
  'good', 'better', 'best', 'scope_of_works', 'scope_short', 'assumptions', 'risk_flags',
  'estimated_timeframe', 'needs_inspection', 'inspection_reason', 'inspection_cause',
  'estimate_number', 'routing_decision', 'display_mode', 'report_doc', 'report_style',
  'gst_note', 'deposit_pct', 'applied_discount_pct',
] as const
const DETAIL_FIELDS = [...new Set([...VIEW_FIELDS, ...QUOTE_EDIT_FIELDS])].join(',')
const LINK_FIELDS = 'id,tenant_id,intake_id,parent_quote_id,quote_kind,created_at,status,paid_at,paid_tier,sent_at,total_inc_gst,deposit_pct,share_token'

export class OwnedQuoteReadError extends Error {
  constructor(public readonly code: 'invalid_cursor' | 'invalid_limit' | 'quote_unavailable', public readonly status: number) {
    super(code)
    this.name = 'OwnedQuoteReadError'
  }
}

export function isOwnedQuoteId(value: string): boolean { return UUID.test(value) }

export function ownedQuoteChildPage(url: URL, quoteId: string): ChildPage {
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) {
    throw new OwnedQuoteReadError('invalid_limit', 400)
  }
  const rawCursor = url.searchParams.get('cursor')
  let cursor: ChildPage['cursor'] = null
  if (rawCursor !== null) {
    try {
      if (rawCursor.length > 1024 || !/^[\w-]+$/.test(rawCursor)) throw new Error()
      const value: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'))
      const row = record(value)
      if (!row || row.parent !== quoteId || typeof row.id !== 'string' || !UUID.test(row.id) ||
          typeof row.created_at !== 'string' || !INSTANT.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) throw new Error()
      // Preserve database microseconds. Rounding the cursor to milliseconds skips tied rows.
      cursor = { parent: quoteId, id: row.id, created_at: row.created_at }
    } catch {
      throw new OwnedQuoteReadError('invalid_cursor', 400)
    }
  }
  return { limit: rawLimit === null ? 20 : Number(rawLimit), cursor }
}

function record(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function knownKind(row: Row): 'initial' | 'final' | 'balance' | null {
  return row.quote_kind == null || row.quote_kind === 'initial' ? 'initial'
    : row.quote_kind === 'final' || row.quote_kind === 'balance' ? row.quote_kind : null
}
function owned(row: Row | null, tenantId: string): Row | null {
  return row?.tenant_id === tenantId ? row : null
}
async function read<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  const result = await query
  if (result.error) throw new OwnedQuoteReadError('quote_unavailable', 503)
  return result.data
}
function permission(reason: string | null): Permission { return { allowed: reason === null, reason } }
function link(row: Row | null) {
  if (!row) return null
  return Object.fromEntries(LINK_FIELDS.split(',').filter(key => key !== 'tenant_id' && key !== 'intake_id')
    .map(key => [key, row[key] ?? null]))
}

/** A direct, tenant-scoped reader; it never relies on the truncated dashboard collection. */
export async function loadOwnedQuoteDetail(db: SupabaseClient, tenant: OwnedQuoteTenant, quoteId: string, page: ChildPage) {
  const quote = owned(await read<Row>(db.from('quotes').select(DETAIL_FIELDS)
    .eq('id', quoteId).eq('tenant_id', tenant.id).maybeSingle()), tenant.id)
  if (!quote || quote.id !== quoteId) return null
  const kind = knownKind(quote)
  const intakeId = text(quote.intake_id)
  const intake = intakeId ? owned(await read<Row>(db.from('intakes')
    .select('id,tenant_id,trade,job_type,suburb,caller,scope,customer_id,call_id,inspection_required')
    .eq('id', intakeId).eq('tenant_id', tenant.id).maybeSingle()), tenant.id) : null
  const trade = text(intake?.trade)
  const caller = record(intake?.caller)
  const scope = record(intake?.scope)
  const customerId = text(intake?.customer_id)
  const callId = text(intake?.call_id)
  let savedVersion: QuotePricingVersion | null = null
  let pricingReason: string | null = null
  try {
    if (quote.pricing_book_version_id != null) {
      if (!trade) throw new QuotePricingVersionError('quote_pricing_review_required')
      savedVersion = await loadQuotePricingVersion(db, quote, trade)
    }
  } catch (error) {
    pricingReason = error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable'
  }

  const [customerResult, contact, smsResult, bookResult] = await Promise.all([
    customerId ? read<Row>(db.from('customers').select('id,tenant_id,full_name,first_name,phone_number,email')
      .eq('id', customerId).eq('tenant_id', tenant.id).maybeSingle()) : null,
    intake ? resolveOwnedQuoteCustomerContact(db, tenant.id, intake).catch(() => {
      throw new OwnedQuoteReadError('quote_unavailable', 503)
    }) : { phone: null, email: null },
    // Origin metadata is separate from the shared destination proof.
    intake ? read<Row>(db.from('sms_conversations').select('id,tenant_id')
      .eq('intake_id', intake.id).eq('tenant_id', tenant.id).order('created_at', { ascending: false })
      .order('id', { ascending: false }).limit(1).maybeSingle()) : null,
    trade && quote.pricing_book_version_id == null ? read<Row>(db.from('pricing_book').select('id,tenant_id,trade,gst_registered,hourly_rate,default_markup_pct')
      .eq('tenant_id', tenant.id).eq('trade', trade).maybeSingle()) : null,
  ])
  const customer = owned(customerResult, tenant.id)
  const sms = owned(smsResult, tenant.id)
  const book = savedVersion?.snapshot ?? owned(bookResult, tenant.id)
  const customerName = text(caller?.name) ?? text(customer?.full_name) ?? text(customer?.first_name)

  async function ancestor(id: unknown): Promise<Row | null> {
    const value = text(id)
    if (!value || !UUID.test(value)) return null
    const row = owned(await read<Row>(db.from('quotes').select(LINK_FIELDS)
      .eq('id', value).eq('tenant_id', tenant.id).maybeSingle()), tenant.id)
    return row && row.id === value && row.intake_id === intakeId ? row : null
  }
  const parent = kind === 'final' || kind === 'balance' ? await ancestor(quote.parent_quote_id) : null
  const validParent = parent && ((kind === 'final' && knownKind(parent) === 'initial') ||
    (kind === 'balance' && knownKind(parent) === 'final')) ? parent : null
  const candidateRoot = kind === 'initial' ? quote : kind === 'final' ? validParent
    : validParent ? await ancestor(validParent.parent_quote_id) : null
  const root = candidateRoot && knownKind(candidateRoot) === 'initial' ? candidateRoot : null

  let childQuery = db.from('quotes').select(LINK_FIELDS)
    .eq('parent_quote_id', quoteId).eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(page.limit + 1)
  if (page.cursor) childQuery = childQuery.or(
    `created_at.lt.${page.cursor.created_at},and(created_at.eq.${page.cursor.created_at},id.lt.${page.cursor.id})`,
  )
  const childRows = await read<Row[]>(childQuery) ?? []
  if (childRows.some(row => row.tenant_id !== tenant.id || row.parent_quote_id !== quoteId || row.intake_id !== quote.intake_id)) {
    throw new OwnedQuoteReadError('quote_unavailable', 503)
  }
  const children = childRows.slice(0, page.limit)
  const lastChild = children.at(-1)
  const nextCursor = childRows.length > page.limit && lastChild
    ? Buffer.from(JSON.stringify({ parent: quoteId, created_at: lastChild.created_at, id: lastChild.id })).toString('base64url') : null

  // Probe settlement independently of the displayed page: pagination must never hide a prior charge.
  const childKind = kind === 'initial' ? 'final' : kind === 'final' ? 'balance' : null
  const probe = (paid: boolean) => {
    let query = db.from('quotes').select(LINK_FIELDS).eq('parent_quote_id', quoteId)
      .eq('tenant_id', tenant.id).eq('quote_kind', childKind)
    query = paid ? query.not('paid_at', 'is', null) : query.is('paid_at', null)
    return read<Row[]>(query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1))
  }
  const [paidRows, unpaidRows] = childKind ? await Promise.all([probe(true), probe(false)]) : [null, null]
  const checkedProbe = (rows: Row[] | null) => {
    const row = rows?.[0] ?? null
    if (row && (row.tenant_id !== tenant.id || row.parent_quote_id !== quoteId || row.intake_id !== quote.intake_id)) {
      throw new OwnedQuoteReadError('quote_unavailable', 503)
    }
    return row
  }
  const paidChild = checkedProbe(paidRows)
  const unpaidChild = checkedProbe(unpaidRows)

  const { available: moneyAvailable, balanceBase, money } = quoteChainMoney(quote, kind, validParent, root, trade)

  const connected = !!connectDestinationForTenant(tenant)
  const ownedBook = !!trade && validOwnedQuoteBook(book, tenant.id, trade)
  const gstRegistered = pricingReason ? null : versionedQuoteGst(quote, savedVersion)
  const readiness = await readQuoteDraftReadiness(db, {
    id: quoteId, tenant_id: tenant.id, intake_id: intakeId, quote_kind: quote.quote_kind,
  })
  const processing = { ready: readiness.ready, reason: readiness.ready ? null : readiness.code }
  let reportEditorDoc = validateReportDocWrite(quote.report_doc)
  if (quote.report_doc == null && (quote.scope_of_works == null || typeof quote.scope_of_works === 'string') &&
      (quote.assumptions == null || (Array.isArray(quote.assumptions) && quote.assumptions.every(value => typeof value === 'string')))) {
    reportEditorDoc = validateReportDocWrite(buildDefaultReportDoc({
      title: text(intake?.job_type)?.replaceAll('_', ' ').trim(),
      scopeOfWorks: quote.scope_of_works as string | null,
      assumptions: quote.assumptions as string[] | null,
    }))
  }
  const adapter = getReportAdapter(trade)
  const catalogue = kind === 'initial' && tradeGroundingMode(trade) === 'catalogue'
  const invalidDeposit = kind === 'initial' && !isSiteVisitFirstTrade(trade) && storedDepositPercent(quote.deposit_pct) === null
  const validRates = book && typeof book.hourly_rate === 'number' && Number.isFinite(book.hourly_rate) && book.hourly_rate > 0 &&
    typeof book.default_markup_pct === 'number' && Number.isFinite(book.default_markup_pct) && book.default_markup_pct >= 0 && book.default_markup_pct <= 100
  const editReason = processing.reason ?? (!kind ? 'unknown_quote_kind' : quote.paid_at ? 'quote_already_paid'
    : quote.needs_inspection ? 'cannot_edit_inspection_quote' : !adapter.capabilities.manualEdit ? 'trade_editor_unavailable'
      : pricingReason ?? (!ownedBook || gstRegistered === null || invalidDeposit ? 'quote_pricing_review_required'
        : catalogue && !validRates ? 'pricing_book_misconfigured' : null))
  const documentReason = processing.reason ?? (!kind ? 'unknown_quote_kind' : quote.paid_at ? 'quote_already_paid'
    : quote.needs_inspection ? 'cannot_edit_inspection_quote'
      : process.env.FULL_QUOTE_DOC !== 'true' ? 'document_editor_disabled'
        : !reportEditorDoc ? 'quote_document_review_required' : null)
  const issueReason = processing.reason ?? (kind !== 'initial' ? 'not_initial' : !quote.paid_at || quote.paid_tier !== 'inspection'
    ? 'site_visit_not_paid' : !isSiteVisitFirstTrade(trade) ? 'not_site_visit_first'
      : !connected ? 'connect_required' : paidChild ? 'final_already_paid'
        : unpaidChild ? 'existing_final_quote' : !ownedBook ? 'quote_pricing_review_required' : null)
  const balanceReason = processing.reason ?? (kind !== 'final' ? 'not_final_quote' : !quote.sent_at ? 'final_not_sent'
    : !quote.paid_at || !['deposit', 'credit'].includes(String(quote.paid_tier)) ? 'deposit_not_paid'
      : !connected ? 'connect_required' : !moneyAvailable ? 'quote_pricing_review_required'
        : balanceBase === null || balanceBase < MIN_STRIPE_CHARGE_CENTS ? 'nothing_to_charge'
          : paidChild ? 'balance_already_paid' : null)
  const eligible = (reason: string | null, applicable: boolean): Eligibility => ({
    ...permission(reason), existing_quote_id: applicable ? text(paidChild?.id) ?? text(unpaidChild?.id) : null,
  })
  const deletion = await quoteDeletionPermission(db, tenant.id, quoteId)
  const creditSettlement = kind === 'final' ? await readQuoteCreditSettlement(db, quoteId, tenant.id).catch(() => {
    throw new OwnedQuoteReadError('quote_unavailable', 503)
  }) : null
  return {
    ok: true as const,
    quote: {
      ...Object.fromEntries(VIEW_FIELDS.map(key => [key, quote[key] ?? null])),
      customer_full_name: customerName, customer_first_name: customerName?.split(/\s+/)[0] ?? null,
      customer_phone: contact.phone,
      customer_email: contact.email, suburb: text(intake?.suburb),
      trade, job_type: text(intake?.job_type), inspection_required: intake?.inspection_required === true,
      channel: callId ? 'voice' : sms ? 'sms' : null, deposit_paid: !!quote.paid_at,
    },
    edit_revision: quoteEditRevision(quote), customer_release_revision: quoteCustomerReleaseRevision(quote),
    gst_registered: gstRegistered, processing, report_editor_doc: reportEditorDoc, credit_settlement: creditSettlement,
    intake: intake ? { id: intake.id, trade, job_type: text(intake.job_type),
      inspection_required: intake.inspection_required === true, remembered_address: text(scope?.remembered_address) } : null,
    chain: { parent: link(validParent), root: link(root), children: children.map(link), next_cursor: nextCursor },
    money,
    capabilities: { price_edit: permission(editReason), document_edit: permission(documentReason),
      force_grounding: permission(editReason ?? (!catalogue ? 'not_catalogue_grounding' : null)), delete: deletion },
    eligibility: { issue_final: eligible(issueReason, kind === 'initial'), request_balance: eligible(balanceReason, kind === 'final') },
  }
}
