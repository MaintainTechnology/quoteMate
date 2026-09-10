// GET /api/tenant/payouts — the Payouts tab's data source.

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown }
  const results: Result[] = []
  const getUser = vi.fn()

  function from() {
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'not', 'order', 'limit', 'maybeSingle']) {
      builder[op] = () => builder
    }
    builder.then = (
      resolve: (r: Result) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const r = results.shift() ?? { data: null, error: null }
      return Promise.resolve(r).then(resolve, reject)
    }
    return builder
  }

  return { results, getUser, client: { auth: { getUser }, from } }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))

import { GET, toPayoutJob } from './route'

beforeEach(() => {
  // These cases exercise DB-only shaping; host credentials must never enable
  // optional Stripe enrichment in an otherwise isolated route fixture.
  vi.stubEnv('STRIPE_SECRET_KEY', '')
  h.results.length = 0
  h.getUser.mockReset()
})

afterEach(() => vi.unstubAllEnvs())

function req(withAuth = true) {
  return new Request('http://localhost/api/tenant/payouts', {
    headers: withAuth ? { authorization: 'Bearer token-1' } : {},
  })
}

const paidRow = {
  id: 'quote-1',
  paid_tier: 'better',
  paid_at: '2026-07-01T00:00:00Z',
  paid_amount_cents: 33000,
  platform_fee_cents: 660,
  completed_at: null,
  stripe_payout_id: null,
  payout_amount_cents: null,
  payout_created_at: null,
  intakes: { job_type: 'downlights' },
}

describe('toPayoutJob', () => {
  it('maps an unreleased job as awaiting, with the net computed', () => {
    expect(toPayoutJob(paidRow)).toMatchObject({
      quote_id: 'quote-1',
      job_type: 'downlights',
      net_cents: 32340,
      release_state: 'awaiting',
      payout: null,
    })
  })
  it('marks the in-flight claim sentinel distinctly', () => {
    expect(toPayoutJob({ ...paidRow, stripe_payout_id: 'pending' }).release_state).toBe('in_flight')
  })
  it('maps a released job with its payout leg', () => {
    expect(
      toPayoutJob({
        ...paidRow,
        completed_at: '2026-07-02T00:00:00Z',
        stripe_payout_id: 'po_1',
        payout_amount_cents: 32340,
        payout_created_at: '2026-07-02T00:00:01Z',
      }),
    ).toMatchObject({
      release_state: 'released',
      payout: { id: 'po_1', amount_cents: 32340, created_at: '2026-07-02T00:00:01Z' },
    })
  })
})

describe('GET /api/tenant/payouts', () => {
  it('401 without a bearer token', async () => {
    const res = await GET(req(false))
    expect(res.status).toBe(401)
  })

  it('returns account readiness + shaped jobs', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    h.results.push(
      {
        data: {
          id: 'tenant-1',
          stripe_connect_account_id: 'acct_1',
          stripe_connect_charges_enabled: true,
          stripe_connect_payouts_enabled: true,
          stripe_connect_details_submitted: true,
          stripe_connect_onboarded_at: '2026-06-30T00:00:00Z',
        },
        error: null,
      },
      { data: [paidRow], error: null },
    )
    const res = await GET(req())
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.account).toMatchObject({ has_account: true, payouts_enabled: true })
    expect(json.jobs).toHaveLength(1)
    expect(json.jobs[0]).toMatchObject({ quote_id: 'quote-1', net_cents: 32340, release_state: 'awaiting' })
  })

  it('404 when the user has no tenant', async () => {
    h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    h.results.push({ data: null, error: null })
    const res = await GET(req())
    expect(res.status).toBe(404)
  })
})
