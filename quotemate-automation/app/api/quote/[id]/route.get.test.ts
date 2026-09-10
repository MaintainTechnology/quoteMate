import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), auth: vi.fn(), expire: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: mocks.auth }))
vi.mock('@/lib/stripe/checkout', () => ({ expireCheckoutSession: mocks.expire }))
import { GET } from './route'

const ROOT = '00000000-0000-4000-8000-000000000001'
const FINAL = '00000000-0000-4000-8000-000000000002'
const BALANCE = '00000000-0000-4000-8000-000000000003'
const INTAKE = '00000000-0000-4000-8000-000000000010'
const TENANT = { id: 'aaaaaaaa-0000-4000-8000-000000000001', stripe_connect_account_id: 'acct_fixture',
  stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
type Row = Record<string, unknown>
type Query = { table: string; filters: Array<[string, string, unknown]>; selected: string; limit?: number; or?: string }
let rows: Row[]
let intake: Row | null
let customer: Row | null
let sms: Row | null
let call: Row | null
let book: Row | null
let pricingVersion: Row | null
let creditSettlement: Row | null
let operations: Row[]
let worker: Row | null
let failTable: string | null
let failPaidProbe: boolean
let queries: Query[]

function fixture(id: string, extra: Row = {}): Row {
  return { id, tenant_id: TENANT.id, intake_id: INTAKE, created_at: '2026-09-08T00:00:00.000001+00:00',
    quote_kind: 'initial', parent_quote_id: null, paid_at: null, paid_tier: null, sent_at: null,
    status: 'draft', needs_inspection: false, selected_tier: 'good', total_inc_gst: 1100,
    good: { subtotal_ex_gst: 1000, line_items: [{ description: 'LED downlight', quantity: 2,
      unit_price_ex_gst: 500, total_ex_gst: 1000, source: 'owned', supplied_by: 'customer', safety_note: 'Isolate first' }] },
    better: null, best: null, deposit_pct: 50, report_doc: null, report_style: null,
    stripe_links: { good: 'private-stripe-url' }, risk_flags: ['fixture risk'], share_token: `token-${id}`,
    estimate_number: 'EV-123', inspection_cause: 'grounding_failed', ...extra }
}

function query(table: string) {
  const q: Query = { table, filters: [], selected: '' }
  queries.push(q)
  const isPaidProbe = () => q.filters.some(([op, column]) => op === 'not' && column === 'paid_at')
  function result(single: boolean) {
    if (table === failTable || (failPaidProbe && isPaidProbe())) return { data: null, error: { message: 'private database details' } }
    let data = table === 'quotes' ? rows : table === 'intakes' ? intake ? [intake] : []
      : table === 'customers' ? customer ? [customer] : [] : table === 'sms_conversations' ? sms ? [sms] : []
        : table === 'calls' ? call ? [call] : [] : table === 'pricing_book' ? book ? [book] : []
          : table === 'quote_pricing_versions' ? pricingVersion ? [pricingVersion] : []
            : table === 'quote_credit_settlements' ? creditSettlement ? [creditSettlement] : []
            : table === 'job_quote_operations' ? operations : table === 'sms_work_jobs' ? worker ? [worker] : [] : []
    data = data.filter(row => q.filters.every(([op, column, value]) => op === 'not'
      ? row[column] != null : op === 'is' ? (row[column] ?? null) === value : row[column] === value))
    data = [...data].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || String(b.id).localeCompare(String(a.id)))
    if (q.or && table === 'quotes') {
      const [, date, id] = q.or.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.[^,]+,id\.lt\.([^)]+)\)$/) ?? []
      data = data.filter(row => String(row.created_at) < date! || (String(row.created_at) === date && String(row.id) < id!))
    }
    if (q.limit) data = data.slice(0, q.limit)
    // Simulate the projection: future private columns are not implicitly available.
    data = q.selected === '*' ? data : data.map(row => Object.fromEntries(q.selected.split(',').map(key => [key.trim(), row[key.trim()] ?? null])))
    return { data: single ? data[0] ?? null : data, error: null }
  }
  const builder = {
    select: (columns: string) => { q.selected = columns; return builder },
    eq: (column: string, value: unknown) => { q.filters.push(['eq', column, value]); return builder },
    is: (column: string, value: unknown) => { q.filters.push(['is', column, value]); return builder },
    not: (column: string, _operator: string, value: unknown) => { q.filters.push(['not', column, value]); return builder },
    order: () => builder,
    limit: (value: number) => { q.limit = value; return builder },
    or: (value: string) => { q.or = value; return builder },
    maybeSingle: async () => result(true),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result(false)).then(resolve),
  }
  return builder
}
function get(id = ROOT, search = '') {
  return GET(new Request(`https://example.test/api/quote/${id}${search}`), { params: Promise.resolve({ id }) })
}
function paidChain() {
  rows = [fixture(ROOT, { paid_at: '2026-09-01T00:00:00Z', paid_tier: 'inspection' }),
    fixture(FINAL, { quote_kind: 'final', parent_quote_id: ROOT, sent_at: '2026-09-02T00:00:00Z',
      paid_at: '2026-09-03T00:00:00Z', paid_tier: 'deposit' })]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('FULL_QUOTE_DOC', 'true')
  rows = [fixture(ROOT)]
  intake = { id: INTAKE, tenant_id: TENANT.id, trade: 'electrical', job_type: 'ev_charger', suburb: 'Bondi',
    caller: { name: 'Sam', phone: '+61400000000', email: 'sam@example.test', private: 'do-not-return' },
    scope: { remembered_address: '1 Example St', private: 'do-not-return' }, customer_id: null, call_id: null }
  customer = null; sms = null; call = null
  book = { id: 'book-a', tenant_id: TENANT.id, trade: 'electrical', gst_registered: true, hourly_rate: 100, default_markup_pct: 20 }
  pricingVersion = null; creditSettlement = null; operations = []; worker = null
  failTable = null; failPaidProbe = false; queries = []
  mocks.from.mockImplementation(query)
  mocks.rpc.mockResolvedValue({ data: { allowed: false, reason: 'quote_has_public_link' }, error: null })
  mocks.auth.mockResolvedValue({ identity: { userId: 'user-a', provider: 'clerk' }, tenant: TENANT })
})

describe('owned quote GET action boundary', () => {
  it.each(['settled', 'not_required', 'pending', 'review_required'])('returns only safe owned final credit settlement %s metadata without accounting writes', async status => {
    paidChain()
    creditSettlement = { quote_id: FINAL, tenant_id: TENANT.id, outbox_id: BALANCE, status,
      reason: 'fixture_settlement_reason', private_snapshot: { private: 'do-not-return' } }
    const response = await get(FINAL)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.credit_settlement).toEqual({ quote_id: FINAL, outbox_id: BALANCE, status, reason: 'fixture_settlement_reason' })
    expect(JSON.stringify(body)).not.toContain('do-not-return')
    expect(queries.find(query => query.table === 'quote_credit_settlements')?.filters).toEqual([
      ['eq', 'quote_id', FINAL], ['eq', 'tenant_id', TENANT.id],
    ])
    expect(mocks.rpc).not.toHaveBeenCalledWith('settle_final_quote_credit', expect.anything())
  })
  it('keeps missing credit evidence null and never queries it for an initial quote', async () => {
    expect((await (await get()).json()).credit_settlement).toBeNull()
    expect(queries.some(query => query.table === 'quote_credit_settlements')).toBe(false)
    paidChain()
    expect((await (await get(FINAL)).json()).credit_settlement).toBeNull()
  })
  it.each(['read failure', 'malformed receipt'])('fails closed on %s in final credit evidence', async failure => {
    paidChain()
    if (failure === 'read failure') failTable = 'quote_credit_settlements'
    else creditSettlement = { quote_id: FINAL, tenant_id: TENANT.id, status: 'invented', reason: 'private-error' }
    const response = await get(FINAL)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'quote_unavailable' })
  })
  it('preserves explicit customer release independently of provider acceptance for resend identity', async () => {
    rows[0].customer_released_at = '2026-09-09T01:02:03Z'
    rows[0].sent_at = null
    rows[0].status = 'awaiting_tradie_approval'
    const response = await get()
    expect(response.status).toBe(200)
    expect((await response.json()).quote).toMatchObject({
      customer_released_at: rows[0].customer_released_at,
      sent_at: null, status: 'awaiting_tradie_approval',
    })
  })

  it('returns direct editable projection, stable revision and only scoped safe contact fields', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, edit_revision: quoteEditRevision(rows[0]), gst_registered: true,
      customer_release_revision: quoteCustomerReleaseRevision(rows[0]),
      quote: { id: ROOT, estimate_number: 'EV-123', customer_full_name: 'Sam', customer_phone: '+61400000000',
        good: { line_items: [expect.objectContaining({ source: 'owned', supplied_by: 'customer', safety_note: 'Isolate first' })] } },
      intake: { remembered_address: '1 Example St' }, capabilities: { price_edit: { allowed: true }, document_edit: { allowed: true } } })
    expect(JSON.stringify(body)).not.toContain('private-stripe-url')
    expect(JSON.stringify(body)).not.toContain('do-not-return')
    for (const q of queries) {
      if (q.table === 'sms_work_jobs') expect(q.filters).toContainEqual(['eq', 'work_key', `estimate:initial:${INTAKE}`])
      else expect(q.filters).toContainEqual(['eq', 'tenant_id', TENANT.id])
    }
    expect(mocks.expire).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated before reads and hides missing/foreign/unscoped quotes', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(queries).toHaveLength(0)
    mocks.auth.mockResolvedValue({ identity: { role: 'admin' }, tenant: null })
    expect((await get()).status).toBe(404)
    for (const owner of [null, 'tenant-b']) {
      mocks.auth.mockResolvedValue({ tenant: TENANT })
      rows = [fixture(ROOT, { tenant_id: owner })]
      expect((await get()).status).toBe(404)
    }
    expect((await get('not-an-id')).status).toBe(404)
  })

  it('normalizes a valid uppercase UUID before its exact owned read', async () => {
    const id = 'abcdefab-0000-4000-8000-000000000001'
    rows = [fixture(id)]
    const response = await get(id.toUpperCase())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ quote: { id } })
    expect(queries[0].filters).toContainEqual(['eq', 'id', id])
  })

  it.each(['quotes', 'intakes', 'pricing_book', 'sms_conversations'])('maps %s failure to 503 without leaking details', async table => {
    failTable = table
    if (table === 'sms_conversations') intake = { ...intake, caller: {} }
    const response = await get()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'quote_unavailable' })
  })

  it('never follows a foreign intake/contact/ancestor relationship', async () => {
    intake = { ...intake, tenant_id: 'tenant-b' }
    const response = await get()
    expect(await response.json()).toMatchObject({ quote: { trade: null, customer_phone: null }, intake: null,
      capabilities: { price_edit: { allowed: false } } })
    expect(queries.some(q => q.table === 'customers' || q.table === 'calls')).toBe(false)
  })

  it('uses scoped SMS then call/customer contact fallbacks without raw transcript payloads', async () => {
    intake = { ...intake, caller: {}, customer_id: 'customer-a', call_id: 'call-a' }
    sms = { id: 'sms-a', tenant_id: TENANT.id, intake_id: INTAKE, from_number: '+61400000001' }
    call = { id: 'call-a', tenant_id: TENANT.id, caller_number: '+61400000002' }
    customer = { id: 'customer-a', tenant_id: TENANT.id, full_name: 'Stored Sam', phone_number: '+61400000003', email: 'stored@example.test' }
    const body = await (await get()).json()
    expect(body.quote).toMatchObject({ customer_phone: '+61400000001', customer_email: 'stored@example.test', customer_full_name: 'Stored Sam', channel: 'voice' })
  })

  it('shares strict sender contact validation instead of hiding malformed caller data behind a fallback', async () => {
    intake = { ...intake, caller: { phone: 411222333 } }
    sms = { id: 'sms-a', tenant_id: TENANT.id, intake_id: INTAKE, from_number: '+61400000001' }
    expect((await get()).status).toBe(503)
    expect(queries.some(q => q.table === 'sms_conversations' && q.selected.includes('from_number'))).toBe(false)
  })

  it('keeps unknown tax and quote kinds viewable but non-editable, without default GST', async () => {
    rows = [fixture(ROOT, { total_inc_gst: 0 })]
    expect(await (await get()).json()).toMatchObject({ gst_registered: null, capabilities: { price_edit: { allowed: false, reason: 'quote_pricing_review_required' } } })
    rows = [fixture(ROOT, { quote_kind: 'future-kind' })]
    expect(await (await get()).json()).toMatchObject({ capabilities: { price_edit: { allowed: false }, document_edit: { allowed: false }, force_grounding: { allowed: false } } })
  })

  it.each([{ paid_at: '2026-09-01' }, { needs_inspection: true }])('keeps stored paid/inspection guard %j', async patch => {
    rows = [fixture(ROOT, patch)]
    expect(await (await get()).json()).toMatchObject({ capabilities: { price_edit: { allowed: false }, document_edit: { allowed: false }, force_grounding: { allowed: false } } })
  })

  it('gates document rendering flag separately from valid price edits', async () => {
    vi.stubEnv('FULL_QUOTE_DOC', 'false')
    expect(await (await get()).json()).toMatchObject({ capabilities: { document_edit: { allowed: false, reason: 'document_editor_disabled' }, price_edit: { allowed: true } } })
  })

  it('seeds the document editor with the existing web title, scope and assumptions without storing or exposing owner risks', async () => {
    rows[0].scope_of_works = 'Install the chosen charger'
    rows[0].assumptions = ['Customer supplies the charger']
    const body = await (await get()).json()
    expect(body.quote.report_doc).toBeNull()
    expect(body.report_editor_doc).toEqual({ version:1,blocks:[
      {type:'title',content:[{text:'ev charger'}]},
      {type:'heading',content:[{text:'Scope of works'}]},
      {type:'paragraph',content:[{text:'Install the chosen charger'}]},
      {type:'pricing'},
      {type:'heading',content:[{text:'Assumptions'}]},
      {type:'bulletList',items:[[{text:'Customer supplies the charger'}]]},
    ] })
    expect(JSON.stringify(body.report_editor_doc)).not.toContain('fixture risk')
    expect(rows[0].report_doc).toBeNull()
  })

  it('returns a valid stored report with its marks and order intact', async () => {
    rows[0].report_doc = {version:1,blocks:[{type:'paragraph',content:[{text:'Existing',marks:['highlight','bold']}]},{type:'pricing'}]}
    const body = await (await get()).json()
    expect(body.report_editor_doc).toEqual(rows[0].report_doc)
    expect(body.capabilities.document_edit.allowed).toBe(true)
  })

  it.each(['invalid-document','over-limit-document','invalid-assumptions','over-limit-seed'])('retains %s in its original projection and disables unsafe document editing', async scenario => {
    if (scenario === 'invalid-document') rows[0].report_doc = {version:1,blocks:[{type:'owner-only',private:'keep'}]}
    if (scenario === 'over-limit-document') rows[0].report_doc = {version:1,blocks:[{type:'pricing'},{type:'paragraph',content:[{text:'a'.repeat(5001)}]}]}
    if (scenario === 'invalid-assumptions') rows[0].assumptions = [1]
    if (scenario === 'over-limit-seed') rows[0].scope_of_works = 'a'.repeat(5001)
    const body = await (await get()).json()
    expect(body.report_editor_doc).toBeNull()
    expect(body.quote.report_doc).toEqual(rows[0].report_doc)
    expect(body.capabilities.document_edit).toEqual({allowed:false,reason:'quote_document_review_required'})
  })

  it('uses the immutable historical book after current rates/tax change or the live book disappears', async () => {
    pricingVersion = { id: 'version-a', tenant_id: TENANT.id, trade: 'electrical', pricing_book_id: book!.id,
      snapshot: { ...book }, content_hash: 'a'.repeat(64) }
    rows[0].pricing_book_version_id = 'version-a'
    book = { ...book, gst_registered: false, hourly_rate: 0 }
    let body = await (await get()).json()
    expect(body).toMatchObject({ gst_registered: true, capabilities: { price_edit: { allowed: true } } })
    expect(queries.some(q => q.table === 'pricing_book')).toBe(false)
    book = null
    body = await (await get()).json()
    expect(body).toMatchObject({ gst_registered: true, edit_revision: quoteEditRevision(rows[0]), capabilities: { price_edit: { allowed: true } } })
  })

  it.each(['missing', 'foreign', 'read-error'])('keeps an unreadable %s pricing version viewable without guessing tax', async state => {
    rows[0].pricing_book_version_id = 'version-a'
    if (state === 'foreign') pricingVersion = { id: 'version-a', tenant_id: 'other', trade: 'electrical', pricing_book_id: book!.id,
      snapshot: { ...book }, content_hash: 'a'.repeat(64) }
    if (state === 'read-error') failTable = 'quote_pricing_versions'
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ gst_registered: null,
      capabilities: { price_edit: { allowed: false }, force_grounding: { allowed: false } } })
  })

  it('requires the stored valid initial deposit percentage when the actual financial writer does', async () => {
    intake!.trade = 'solar'; book!.trade = 'solar'; rows[0].deposit_pct = null
    expect(await (await get()).json()).toMatchObject({ capabilities: { price_edit: { allowed: false, reason: 'quote_pricing_review_required' } } })
  })

  it('returns only server-confirmed delete capability and safely disables it on unreadable migration state', async () => {
    expect(await (await get()).json()).toMatchObject({ capabilities: { delete: { allowed: false, reason: 'quote_has_public_link' } } })
    mocks.rpc.mockResolvedValue({ data: { allowed: true, reason: null }, error: null })
    expect(await (await get()).json()).toMatchObject({ capabilities: { delete: { allowed: true, reason: null } } })
    expect(mocks.rpc).toHaveBeenCalledWith('quote_deletion_permission', { p_tenant_id: TENANT.id, p_quote_id: ROOT })
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'private' } })
    expect(await (await get()).json()).toMatchObject({ capabilities: { delete: { allowed: false, reason: 'quote_delete_unavailable' } } })
  })

  it.each(['running-worker', 'unknown-operation', 'history-error'])('fences mutations while leaving %s quote readable', async state => {
    if (state === 'running-worker') worker = { work_key: `estimate:initial:${INTAKE}`, kind: 'estimate', status: 'running' }
    if (state === 'unknown-operation') operations = [{ tenant_id: TENANT.id, operation_id: FINAL, request_hash: 'a'.repeat(64),
      intake_id: INTAKE, quote_id: null, status: 'unknown', pinned: false, pin_requested: false, created_at: '2026-09-01T00:00:00Z' }]
    if (state === 'history-error') failTable = 'job_quote_operations'
    const body = await (await get()).json()
    expect(body).toMatchObject({ quote: { id: ROOT }, processing: { ready: false },
      capabilities: { price_edit: { allowed: false }, document_edit: { allowed: false }, force_grounding: { allowed: false } },
      eligibility: { issue_final: { allowed: false }, request_balance: { allowed: false } } })
    expect(body.processing.reason).toBe(state === 'running-worker' ? 'quote_draft_processing' : 'quote_draft_unconfirmed')
  })

  it('accepts an exact completed worker for initial and chain-child owner capabilities', async () => {
    paidChain()
    worker = { work_key: `estimate:initial:${INTAKE}`, kind: 'estimate', status: 'completed',
      result: { status: 200, body: JSON.stringify({ ok: true, quoteId: ROOT }) } }
    expect(await (await get(FINAL)).json()).toMatchObject({ processing: { ready: true, reason: null },
      eligibility: { request_balance: { allowed: true } } })
    worker.result = { status: 200, body: JSON.stringify({ ok: true, quoteId: BALANCE }) }
    expect(await (await get(FINAL)).json()).toMatchObject({ processing: { ready: false },
      eligibility: { request_balance: { allowed: false, reason: 'quote_draft_unconfirmed' } } })
  })
})

describe('owned chain relationships and money evidence', () => {
  it('loads final/root independently of me list and calculates server amounts once', async () => {
    paidChain()
    rows[1] = { ...rows[1], paid_at: null, paid_tier: null }
    const body = await (await get(FINAL)).json()
    expect(body.chain).toMatchObject({ parent: { id: ROOT }, root: { id: ROOT }, children: [] })
    expect(body.money).toMatchObject({ job_total_inc_gst_cents: 110000, inspection_credit_cents: 9900,
      deposit_base_cents: 45100, balance_base_cents: 55000, current_payment_base_cents: 45100,
      platform_fee_cents: 902, customer_charge_cents: 46002 })
    expect(body.eligibility.request_balance).toMatchObject({ allowed: false, reason: 'deposit_not_paid' })
  })

  it('uses a balance row stored total without deducting credit or deposit twice', async () => {
    paidChain()
    rows.push(fixture(BALANCE, { quote_kind: 'balance', parent_quote_id: FINAL, total_inc_gst: 550 }))
    const body = await (await get(BALANCE)).json()
    expect(body.chain).toMatchObject({ parent: { id: FINAL }, root: { id: ROOT } })
    expect(body.money).toMatchObject({ balance_base_cents: 55000, current_payment_base_cents: 55000, platform_fee_cents: 1100, customer_charge_cents: 56100 })
  })

  it.each(['wrong-parent-tenant', 'unpaid-root', 'missing-rate', 'inconsistent-balance', 'unsent-final', 'unpaid-final', 'wrong-paid-tier'])('returns unavailable money for %s', async scenario => {
    paidChain()
    rows.push(fixture(BALANCE, { quote_kind: 'balance', parent_quote_id: FINAL, total_inc_gst: 550 }))
    if (scenario === 'wrong-parent-tenant') rows[1].tenant_id = 'tenant-b'
    if (scenario === 'unpaid-root') rows[0].paid_at = null
    if (scenario === 'missing-rate') rows[1].deposit_pct = null
    if (scenario === 'inconsistent-balance') rows[2].total_inc_gst = 650
    if (scenario === 'unsent-final') rows[1].sent_at = null
    if (scenario === 'unpaid-final') rows[1].paid_at = null
    if (scenario === 'wrong-paid-tier') rows[1].paid_tier = 'good'
    expect(await (await get(BALANCE)).json()).toMatchObject({ money: { job_total_inc_gst_cents: null, current_payment_base_cents: null, customer_charge_cents: null } })
  })

  it('keeps sub-minimum credit-covered balances non-chargeable and exact negative remainder visible', async () => {
    paidChain()
    rows[1].total_inc_gst = 50
    rows[1].paid_tier = 'credit'
    const body = await (await get(FINAL)).json()
    expect(body.money).toMatchObject({ deposit_base_cents: 0, balance_base_cents: -4900, current_payment_base_cents: null })
    expect(body.eligibility.request_balance).toMatchObject({ allowed: false, reason: 'nothing_to_charge' })
  })

  it('allows only eligible root/final actions and recovers existing child identities', async () => {
    paidChain()
    let body = await (await get(ROOT)).json()
    expect(body.eligibility.issue_final).toMatchObject({ allowed: false, reason: 'final_already_paid', existing_quote_id: FINAL })
    expect(body.eligibility.request_balance.existing_quote_id).toBeNull()
    body = await (await get(FINAL)).json()
    expect(body.eligibility.request_balance).toMatchObject({ allowed: true, existing_quote_id: null })
    rows.push(fixture(BALANCE, { quote_kind: 'balance', parent_quote_id: FINAL, paid_at: '2026-09-08T01:00:00Z' }))
    body = await (await get(FINAL)).json()
    expect(body.eligibility.request_balance).toMatchObject({ allowed: false, reason: 'balance_already_paid', existing_quote_id: BALANCE })
    expect(body.eligibility.issue_final.existing_quote_id).toBeNull()
  })

  it('fails closed when the paid-child probe errors, even if the visible children loaded', async () => {
    paidChain(); failPaidProbe = true
    expect((await get(FINAL)).status).toBe(503)
  })

  it('paginates equal timestamps without hiding older paid children from eligibility', async () => {
    paidChain()
    rows[1].paid_at = null
    const later = '00000000-0000-4000-8000-000000000004'
    rows.push(fixture(later, { quote_kind: 'final', parent_quote_id: ROOT, paid_at: '2026-09-08T01:00:00Z' }))
    const first = await (await get(ROOT, '?limit=1')).json()
    expect(first.chain.children.map((row: Row) => row.id)).toEqual([later])
    expect(first.chain.next_cursor).toEqual(expect.any(String))
    const second = await (await get(ROOT, `?limit=1&cursor=${first.chain.next_cursor}`)).json()
    expect(second.chain.children.map((row: Row) => row.id)).toEqual([FINAL])
    expect(second.chain.next_cursor).toBeNull()
    expect(second.eligibility.issue_final).toMatchObject({ reason: 'final_already_paid', existing_quote_id: later })
    expect(queries.find(q => q.table === 'quotes' && q.or)?.or).toContain('000001+00:00')
  })

  it.each(['?cursor=bad', '?limit=0', '?limit=101', '?limit=2.5'])('rejects malformed paging %s before quote reads', async search => {
    expect((await get(ROOT, search)).status).toBe(400)
    expect(queries).toHaveLength(0)
  })
})
