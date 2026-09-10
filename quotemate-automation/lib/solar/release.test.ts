import { describe, it, expect, vi, beforeEach } from 'vitest'

// The release side-effects pull in PDF/SMS/CRM modules. Stub them so the
// auto-release DECISION (stamp + released flag) is testable without I/O.
vi.mock('@/lib/quote/pdf', () => ({
  ensureSolarQuotePdf: vi.fn().mockResolvedValue(null),
  solarQuotePdfUrl: vi.fn().mockReturnValue('https://app/pdf'),
  signQuotePdfUrl: vi.fn(),
}))
vi.mock('@/lib/sms/send-quote-pdf', () => ({
  dispatchQuoteWithPdf: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/pylon/client', () => ({
  pylonLeadPushEnabled: vi.fn().mockReturnValue(false),
  pushPylonOpportunity: vi.fn(),
}))
vi.mock('@/lib/solar/opensolar-leadpush', () => ({
  pushSolarLeadToOpenSolar: vi.fn().mockResolvedValue(undefined),
}))

import {
  solarAutoReleaseEnabled,
  autoReleaseSolarEstimate,
  confirmEligibility,
} from './release'

describe('solarAutoReleaseEnabled', () => {
  it('requires human approval when unset', () => {
    expect(solarAutoReleaseEnabled({})).toBe(false)
  })
  it('is OFF when explicitly disabled', () => {
    expect(solarAutoReleaseEnabled({ SOLAR_AUTO_RELEASE: 'false' })).toBe(false)
    expect(solarAutoReleaseEnabled({ SOLAR_AUTO_RELEASE: '0' })).toBe(false)
  })
  it('cannot be bypassed by an environment value', () => {
    expect(solarAutoReleaseEnabled({ SOLAR_AUTO_RELEASE: 'true' })).toBe(false)
    expect(solarAutoReleaseEnabled({ SOLAR_AUTO_RELEASE: '1' })).toBe(false)
  })
})

describe('confirmEligibility (re-exported via release)', () => {
  it('blocks flagged, stamps clean, idempotent when confirmed', () => {
    expect(confirmEligibility({ guardrailFlags: ['x'], alreadyConfirmedAt: null }).ok).toBe(false)
    expect(confirmEligibility({ guardrailFlags: [], alreadyConfirmedAt: null })).toEqual({
      ok: true,
      stamp: true,
    })
    expect(confirmEligibility({ guardrailFlags: [], alreadyConfirmedAt: 'ts' })).toEqual({
      ok: true,
      stamp: false,
    })
  })
})

// Minimal chainable Supabase stub: only the calls autoReleaseSolarEstimate
// makes (a solar_estimates select + a confirmed_at update). intake_id:null
// short-circuits the customer SMS so no further tables are touched.
function makeSupabase(
  row: Record<string, unknown> | null,
  opts: { updateError?: { message: string } | null } = {},
) {
  const updateCalls: Array<{ vals: Record<string, unknown> }> = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
      }),
      update: (vals: Record<string, unknown>) => ({
        eq: async () => {
          updateCalls.push({ vals })
          return { error: opts.updateError ?? null }
        },
      }),
    }),
    updateCalls,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any
}

const cleanRow = {
  id: 'row-1',
  tenant_id: 'tenant-1',
  public_token: 'tok_clean',
  intake_id: null, // short-circuits sendCustomerSolarQuote
  routing: null,
  address: '1 Test St',
  state: 'NSW',
  postcode: '2000',
  confirmed_at: null,
  guardrail_flags: [],
}

describe('autoReleaseSolarEstimate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not auto-release even a clean estimate', async () => {
    const supabase = makeSupabase(cleanRow)
    const r = await autoReleaseSolarEstimate(supabase, { token: 'tok_clean' })
    expect(r.released).toBe(false)
    expect(supabase.updateCalls).toHaveLength(0)
  })

  it('does NOT release a flagged estimate (no stamp, no send)', async () => {
    const supabase = makeSupabase({ ...cleanRow, guardrail_flags: ['better: out of band'] })
    const r = await autoReleaseSolarEstimate(supabase, { token: 'tok_flagged' })
    expect(r.released).toBe(false)
    expect(supabase.updateCalls).toHaveLength(0)
  })

  it('is idempotent — an already-confirmed estimate is not re-released', async () => {
    const supabase = makeSupabase({ ...cleanRow, confirmed_at: '2026-06-16T00:00:00Z' })
    const r = await autoReleaseSolarEstimate(supabase, { token: 'tok_done' })
    expect(r.released).toBe(false)
    expect(supabase.updateCalls).toHaveLength(0)
  })

  it('returns released:false (never throws) when the row is missing', async () => {
    const supabase = makeSupabase(null)
    const r = await autoReleaseSolarEstimate(supabase, { token: 'nope' })
    expect(r.released).toBe(false)
  })

  it('returns released:false when the confirmed_at stamp fails', async () => {
    const supabase = makeSupabase(cleanRow, { updateError: { message: 'db down' } })
    const r = await autoReleaseSolarEstimate(supabase, { token: 'tok_clean' })
    expect(r.released).toBe(false)
  })
})
