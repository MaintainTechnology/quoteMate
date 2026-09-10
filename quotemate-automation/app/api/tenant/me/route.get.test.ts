// GET /api/tenant/me — the dashboard's single data payload.
//
// Locks the quotes-query contract from specs/dashboard-overview-quotes-sync.md
// A1: tenant-scoped, newest-first, and up to 100 rows. The old 20-row cap
// starved multi-trade tenants — a tenant with 110 quotes saw whole trades
// render empty on the dashboard because their newest 20 quotes happened to
// belong to other trades.
//
// supabase-js is mocked with the same chainable-builder recorder as
// app/api/tenant/calendar/route.test.ts; the dual-auth tenant resolver is
// mocked directly so no Clerk/Supabase auth runs. Kept separate from
// ./route.test.ts, whose PATCH-shaped table stubs don't support GET's chains.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown }
  type Op = { op: string; args: unknown[] }
  const results: Result[] = []
  // Table-keyed results take precedence over the ordered queue — the GET
  // fires a dozen queries whose order is an implementation detail; tests
  // that only care about one table's rows key them here instead.
  const resultsByTable: Record<string, Result[]> = {}
  const queries: { table: string; ops: Op[] }[] = []

  function from(table: string) {
    const record = { table, ops: [] as Op[] }
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'not', 'is', 'in', 'or', 'order', 'limit', 'maybeSingle']) {
      builder[op] = (...args: unknown[]) => {
        record.ops.push({ op, args })
        return builder
      }
    }
    builder.then = (
      resolve: (r: Result) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      queries.push(record)
      const r = resultsByTable[record.table]?.shift() ?? results.shift() ?? { data: null, error: null }
      return Promise.resolve(r).then(resolve, reject)
    }
    return builder
  }

  return { results, resultsByTable, queries, client: { from } }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))

vi.mock('@/lib/tenant/from-request', () => ({
  resolveTenantRequest: vi.fn(async () => ({
    identity: { provider: 'clerk', userId: 'user-1', email: 'sparky@example.com' },
    tenant: {
      id: 'tenant-1',
      trade: 'electrical',
      trades: ['electrical'],
      licence_type: null,
      licence_number: null,
      licence_expiry: null,
      state: null,
    },
  })),
}))

import { GET } from './route'

beforeEach(() => {
  h.results.length = 0
  h.queries.length = 0
  for (const k of Object.keys(h.resultsByTable)) delete h.resultsByTable[k]
})

function req() {
  return new Request('http://localhost/api/tenant/me', {
    headers: { authorization: 'Bearer token-1' },
  })
}

describe('GET /api/tenant/me — quote customer contact', () => {
  const intakeRow = {
    id: 'i1',
    suburb: null,
    job_type: null,
    trade: null,
    customer_id: null,
    inspection_required: null,
    call_id: null,
  }

  it('surfaces the caller email (trimmed) as customer_email on each quote', async () => {
    h.resultsByTable.quotes = [
      { data: [{ id: 'q1', intake_id: 'i1', paid_at: null }], error: null },
    ]
    h.resultsByTable.intakes = [
      {
        data: [
          {
            ...intakeRow,
            caller: { name: 'Jon Smith', phone: '+61411111111', email: ' jon@example.com ' },
          },
        ],
        error: null,
      },
    ]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      quotes: { customer_email: string | null; customer_phone: string | null }[]
    }
    expect(body.quotes).toHaveLength(1)
    expect(body.quotes[0].customer_email).toBe('jon@example.com')
    expect(body.quotes[0].customer_phone).toBe('+61411111111')
  })

  it('customer_email is null when the caller has no email on file', async () => {
    h.resultsByTable.quotes = [
      { data: [{ id: 'q1', intake_id: 'i1', paid_at: null }], error: null },
    ]
    h.resultsByTable.intakes = [
      { data: [{ ...intakeRow, caller: { name: 'Jon', email: '' } }], error: null },
    ]
    const res = await GET(req())
    const body = (await res.json()) as { quotes: { customer_email: string | null }[] }
    expect(body.quotes[0].customer_email).toBeNull()
  })

  // The dashboard send panel disables its send buttons on a null contact, so
  // the payload must resolve through the same 4-source chain the viewer uses
  // (lib/quote/send-customer resolveCustomerContact) — intake.caller alone
  // reproduced the 2026-05-28 "no phone resolvable" prod miss.
  it('falls back to sms_conversations.from_number when the caller has no phone', async () => {
    h.resultsByTable.quotes = [
      { data: [{ id: 'q1', intake_id: 'i1', paid_at: null }], error: null },
    ]
    h.resultsByTable.intakes = [
      { data: [{ ...intakeRow, caller: { name: 'Jon' } }], error: null },
    ]
    h.resultsByTable.sms_conversations = [
      { data: [{ id: 'c1', intake_id: 'i1', from_number: '+61477777777' }], error: null },
    ]
    const res = await GET(req())
    const body = (await res.json()) as { quotes: { customer_phone: string | null }[] }
    expect(body.quotes[0].customer_phone).toBe('+61477777777')
  })

  it('falls back to calls.caller_number for voice-sourced quotes', async () => {
    h.resultsByTable.quotes = [
      { data: [{ id: 'q1', intake_id: 'i1', paid_at: null }], error: null },
    ]
    h.resultsByTable.intakes = [
      { data: [{ ...intakeRow, caller: { name: 'Jon' }, call_id: 'call1' }], error: null },
    ]
    h.resultsByTable.calls = [
      {
        data: [{ id: 'call1', transcript: null, ended_at: null, caller_number: '+61455555555' }],
        error: null,
      },
    ]
    const res = await GET(req())
    const body = (await res.json()) as { quotes: { customer_phone: string | null }[] }
    expect(body.quotes[0].customer_phone).toBe('+61455555555')
  })

  it('falls back to the linked customers row for phone and email last', async () => {
    h.resultsByTable.quotes = [
      { data: [{ id: 'q1', intake_id: 'i1', paid_at: null }], error: null },
    ]
    h.resultsByTable.intakes = [
      { data: [{ ...intakeRow, caller: { name: 'Jon' }, customer_id: 'cust1' }], error: null },
    ]
    h.resultsByTable.customers = [
      {
        // Real schema (migration 008): the column is phone_number, not
        // phone. The old mock mirrored the buggy select that PostgREST
        // 400'd on in prod (US-007, 2026-07-23 audit).
        data: [{ id: 'cust1', phone_number: '+61466666666', email: 'row@example.com' }],
        error: null,
      },
    ]
    const res = await GET(req())
    const body = (await res.json()) as {
      quotes: { customer_phone: string | null; customer_email: string | null }[]
    }
    expect(body.quotes[0].customer_phone).toBe('+61466666666')
    expect(body.quotes[0].customer_email).toBe('row@example.com')
  })
})

describe('GET /api/tenant/me — quotes query', () => {
  it.each(['site_conditions', 'model_declared', 'grounding_failed', null])(
    'selects and returns delivery, chain and inspection metadata without inferred causes (%s)', async (inspectionCause) => {
      const quote = {
        id: 'q-final', intake_id: null, sent_at: '2026-09-08T02:00:00Z',
        inspection_cause: inspectionCause, estimate_number: 'EV-000123',
        quote_kind: 'final', parent_quote_id: 'q-initial', paid_tier: 'good',
        paid_at: '2026-09-08T03:00:00Z',
      }
      h.resultsByTable.quotes = [{ data: [quote], error: null }]
      const response = await GET(req())
      expect(response.status).toBe(200)
      expect((await response.json()).quotes[0]).toMatchObject(quote)
      const query = h.queries.find((entry) => entry.table === 'quotes')!
      const fields = String(query.ops.find((op) => op.op === 'select')!.args[0]).split(',').map((field) => field.trim())
      expect(fields).toEqual(expect.arrayContaining([
        'sent_at', 'inspection_cause', 'estimate_number', 'quote_kind', 'parent_quote_id', 'paid_tier', 'paid_at',
      ]))
      expect(query.ops).toContainEqual({ op: 'eq', args: ['tenant_id', 'tenant-1'] })
    },
  )

  it('fetches up to 100 quotes, tenant-scoped, newest-first', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)

    const quotesQuery = h.queries.find((q) => q.table === 'quotes')
    expect(quotesQuery).toBeDefined()
    const ops = quotesQuery!.ops
    expect(ops).toContainEqual({ op: 'eq', args: ['tenant_id', 'tenant-1'] })
    expect(ops).toContainEqual({
      op: 'order',
      args: ['created_at', { ascending: false }],
    })
    expect(ops).toContainEqual({ op: 'limit', args: [100] })
  })
})
