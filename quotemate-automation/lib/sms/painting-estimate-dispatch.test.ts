// Spec painting-auto-send R2/R3 — the SMS/voice origin texts the customer the
// FULL QUOTE (not the holding message), and a send that fails is never
// reported as a success: the release is rolled back (inside the shared
// autoSendPaintingQuote helper) and the tradie is told the customer got
// nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaintingSlots } from './painting-intake'

const h = vi.hoisted(() => ({ runAndSavePaintingQuote: vi.fn(), handoff: vi.fn() }))
vi.mock('@/lib/painting/quote-dispatch', () => ({ runAndSavePaintingQuote: h.runAndSavePaintingQuote }))
vi.mock('./human-handoff', () => ({ persistHumanHandoff: h.handoff }))
import { estimateAndDispatchPainting } from './painting-estimate-dispatch'
const query = { select: () => query, eq: () => query, single: async () => ({ data: { id: 'paint-row' }, error: null }) }
const supabase = { from: () => query } as unknown as SupabaseClient

const slots: PaintingSlots = {
  address: '5 Smith St',
  postcode: '2000',
  state: 'NSW',
  scopes: ['walls'],
  coats: 2,
  condition: 'sound',
  ceiling_height: 'standard',
  storeys: 1,
  colour_change: false,
}

const pricedDisp = {
  ok: true as const,
  token: 'pub-1',
  estimateToken: 'est-1',
  inspection: false,
  estimate: {
    price: { routing: { decision: 'auto_quote', reason: '' }, tiers: [{ tier: 'better', inc_gst: 12000 }] },
  },
}

function run(sendReply: (text: string, mediaUrl?: string) => Promise<{ ok: boolean }>) {
  return estimateAndDispatchPainting({
    supabase,
    tenantId: 'tenant-1',
    customerPhone: '+61400000000',
    firstName: 'Sam',
    baseUrl: 'https://x.test',
    slots,
    sendReply,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.runAndSavePaintingQuote.mockResolvedValue(pricedDisp)
  h.handoff.mockResolvedValue({ id: 'review-task', notified: true })
})
describe('painting saved draft workflow', () => {
  it('persists an owner task and sends an honest review status without quote or price', async () => {
    const send = vi.fn(async (_text: string) => ({ ok: true }))
    const result = await run(send)
    expect(result).toMatchObject({ ok: true, state: { workflow_stage: 'awaiting_review' } })
    expect(h.handoff.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    expect(send.mock.calls[0][0]).toMatch(/saved.*awaiting review/)
    expect(send.mock.calls[0][0]).not.toMatch(/https?:|\$|shortly|on its way/)
  })
  it('does not claim completion when the status send fails', async () => {
    expect(await run(async () => ({ ok: false }))).toMatchObject({ ok: false })
  })
  it('does not announce a handoff if the task cannot be persisted', async () => {
    h.handoff.mockRejectedValue(new Error('task database unavailable'))
    const send = vi.fn(async () => ({ ok: true }))
    expect(await run(send)).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
  })
  it('reports inspection only as a pending assessment, without unsupported bookings', async () => {
    h.runAndSavePaintingQuote.mockResolvedValue({ ...pricedDisp, inspection: true })
    const send = vi.fn(async (_text: string) => ({ ok: true }))
    expect(await run(send)).toMatchObject({ ok: true, inspection: true })
    expect(send.mock.calls[0][0]).toMatch(/on-site assessment/)
    expect(send.mock.calls[0][0]).not.toMatch(/booked|https?:|\$/)
  })
})
