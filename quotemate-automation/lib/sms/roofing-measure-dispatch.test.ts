import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadTenantRoofingPricingContext: vi.fn(),
  measureAndPriceRoofs: vi.fn(),
  sendSms: vi.fn(),
  toRoofingRequest: vi.fn(),
  handoff: vi.fn(),
}))

vi.mock('./roofing-intake', () => ({
  toRoofingRequest: mocks.toRoofingRequest,
}))
vi.mock('./human-handoff', () => ({ persistHumanHandoff: mocks.handoff }))
vi.mock('./twilio', () => ({ sendSms: mocks.sendSms }))
vi.mock('@/lib/roofing/measure', () => ({ measureAndPriceRoofs: mocks.measureAndPriceRoofs }))
vi.mock('@/lib/roofing/pricing-authority', () => ({
  loadTenantRoofingPricingContext: mocks.loadTenantRoofingPricingContext,
}))

import { measureAndDispatchRoofing } from './roofing-measure-dispatch'


function client(options: { existing?: unknown; saveError?: unknown; missing?: boolean; throws?: boolean } = {}) {
  const saved = { id: 'roof-row', public_token: 'roof_saved_token_1234', quote: { structures: [], combined: { tiers: [] } } }
  const inserted: unknown[] = []
  return { inserted, from: () => {
    let write = false
    const query = {
      select: () => query, eq: () => query,
      insert: (row: unknown) => { write = true; inserted.push(row); return query },
      maybeSingle: async () => ({ data: options.existing ?? null, error: null }),
      single: async () => {
        if (options.throws) throw new Error('transport')
        return { data: write && !options.saveError && !options.missing ? saved : null, error: options.saveError ?? null }
      },
    }
    return query
  } }
}

const sendReply = vi.fn()
const baseArgs = {
  supabase: client() as never,
  tenantId: 'tenant-1',
  tenantTrade: 'roofing',
  conversationId: 'conversation-1',
  customerPhone: '0400000000',
  firstName: 'Pat',
  baseUrl: 'https://example.test',
  slots: {} as never,
  isInspection: false,
  sendReply,
}

beforeEach(() => {
  vi.clearAllMocks()
  sendReply.mockResolvedValue({ ok: true })
  mocks.handoff.mockResolvedValue({ id: 'task-1', notified: true })
  mocks.loadTenantRoofingPricingContext.mockResolvedValue({ rateCard: {}, authority: { source: 'tenant_pricing_book' } })
  mocks.measureAndPriceRoofs.mockResolvedValue({ ok: true, provider: 'mock', quote: { structures: [], combined: { area_m2: 100, tiers: [] }, routing: { decision: 'tradie_review' } } })
  mocks.toRoofingRequest.mockReturnValue({
    address: { address: '1 Test Street', postcode: '4000', state: 'QLD' },
    inputs: {
      material: 'colorbond_corrugated',
      pitch: 'standard',
      intent: 'full_reroof',
    },
  })
})

describe('roofing message dispatch pricing safety', () => {
  it('does not measure, persist or send for a tenant-less caller', async () => {
    await expect(
      measureAndDispatchRoofing({ ...baseArgs, tenantId: null }),
    ).resolves.toEqual({ ok: false, reason: 'tenant pricing setup required' })
    expect(mocks.loadTenantRoofingPricingContext).not.toHaveBeenCalled()
    expect(mocks.measureAndPriceRoofs).not.toHaveBeenCalled()
    expect(sendReply).not.toHaveBeenCalled()
    expect(mocks.sendSms).not.toHaveBeenCalled()
  })

  it('does not measure, persist or send when the complete tenant card is absent', async () => {
    mocks.loadTenantRoofingPricingContext.mockResolvedValue(null)
    await expect(measureAndDispatchRoofing(baseArgs)).resolves.toEqual({
      ok: false,
      reason: 'tenant roofing pricing setup required',
    })
    expect(mocks.measureAndPriceRoofs).not.toHaveBeenCalled()
    expect(sendReply).not.toHaveBeenCalled()
    expect(mocks.sendSms).not.toHaveBeenCalled()
  })
})


describe('roofing persisted result and recovery', () => {
  it('retries a failed customer status against the same held row without repricing or creating an unmeasured lead', async () => {
    type Row = Record<string, unknown>
    const rows: Row[] = []
    const db = { from(table: string) {
      expect(table).toBe('roofing_measurements')
      const filters: Row = {}
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters[key] = value; return query },
        insert: (row: Row) => { rows.push({ ...row, id: 'priced-roof-1' }); return query },
        single: async () => ({ data: rows.at(-1), error: null }),
        maybeSingle: async () => ({ data: rows.find(row => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }),
      }
      return query
    } }
    sendReply.mockResolvedValueOnce({ ok: false, outboxId: 'saved-status-intent' }).mockResolvedValueOnce({ ok: true, outboxId: 'saved-status-intent' })
    const args = { ...baseArgs, supabase: db as never, requestKey: 'durable-priced-request' }
    const failed = await measureAndDispatchRoofing(args)
    expect(failed).toMatchObject({ ok: false, savedToken: rows[0].public_token })
    const saved = JSON.parse(JSON.stringify(rows))
    const recovered = await measureAndDispatchRoofing(args)
    expect(recovered).toMatchObject({ ok: true, token: rows[0].public_token, state: { workflow_stage: 'awaiting_review' } })
    expect(rows).toEqual(saved)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tenant_id: 'tenant-1', source_request_key: 'durable-priced-request', released_at: null })
    expect(rows[0].quote).not.toBeNull()
    expect(mocks.measureAndPriceRoofs).toHaveBeenCalledOnce()
    expect(mocks.loadTenantRoofingPricingContext).toHaveBeenCalledOnce()
    expect(sendReply.mock.calls[1][0]).toBe(sendReply.mock.calls[0][0])
  })
  it.each([{ saveError: { message: 'DB down' } }, { missing: true }, { throws: true }])('never sends a link, MMS or status success after failed save %o', async (failure) => {
    const result = await measureAndDispatchRoofing({ ...baseArgs, supabase: client(failure) as never })
    expect(result.ok).toBe(false)
    expect(sendReply).not.toHaveBeenCalled()
    expect(mocks.sendSms).not.toHaveBeenCalled()
    expect(mocks.handoff).not.toHaveBeenCalled()
  })
  it('holds saved prices and creates the owner review task before customer status', async () => {
    const result = await measureAndDispatchRoofing({ ...baseArgs, supabase: client() as never })
    expect(result).toMatchObject({ ok: true, token: 'roof_saved_token_1234', state: { workflow_stage: 'awaiting_review' } })
    expect(mocks.handoff.mock.invocationCallOrder[0]).toBeLessThan(sendReply.mock.invocationCallOrder[0])
    expect(sendReply.mock.calls[0][0]).not.toMatch(/https?:|\$|on its way|sent/)
  })
  it('reuses the saved token after restart without measuring again', async () => {
    const existing = { id: 'roof-row', public_token: 'same_saved_token', quote: { structures: [] } }
    const result = await measureAndDispatchRoofing({ ...baseArgs, supabase: client({ existing }) as never })
    expect(result).toMatchObject({ ok: true, token: 'same_saved_token' })
    expect(mocks.measureAndPriceRoofs).not.toHaveBeenCalled()
  })
  it('does not claim success when the status send failed; saved token remains recoverable', async () => {
    sendReply.mockResolvedValue({ ok: false })
    const result = await measureAndDispatchRoofing({ ...baseArgs, supabase: client() as never })
    expect(result).toMatchObject({ ok: false, savedToken: 'roof_saved_token_1234' })
  })
})
