import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const deferred: Array<() => Promise<unknown>> = []
  const enqueue = vi.fn(async () => true)
  const state = {
    call: { id: 'call-1', transcript: 'Jeph needs an outdoor powerpoint in Bondi', tenant_id: 'tenant-1' } as Record<string, unknown> | null,
    conversation: null as Record<string, unknown> | null,
    intakeInsert: { data: { id: 'intake-1' }, error: null as { message: string } | null },
  }
  const resultBuilder = (table: string) => {
    const builder = {
      select() { return this }, eq() { return this }, order() { return this }, or() { return this },
      update() { return this }, insert() { return this }, upsert() { return this },
      async maybeSingle() { return table === 'intakes' ? { data: null, error: null } : this.single() },
      async single() {
        if (table === 'calls') return { data: state.call, error: null }
        if (table === 'sms_conversations') return { data: state.conversation, error: null }
        if (table === 'intakes') return state.intakeInsert
        return { data: null, error: null }
      },
      then(resolve: (value: unknown) => unknown) {
        if (table === 'sms_messages') return Promise.resolve({ data: [{ direction: 'inbound', body: 'Need a powerpoint', created_at: new Date().toISOString() }], error: null }).then(resolve)
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return builder
  }
  const supabase = { from: (table: string) => resultBuilder(table) }
  return { deferred, enqueue, state, supabase }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.supabase }))
// This suite isolates the existing push hook INSIDE a claimed worker. Durable
// receipt/claim/restart/after-drain are exercised against Postgres separately.
vi.mock('@/lib/sms/durable-work', () => ({
  currentSmsWork: () => ({ jobId: 'work-1', ownerToken: 'owner-1', turnId: 'turn-1' }),
  withFencedSmsClient: (db: unknown) => db,
  smsWorkFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  attributeSmsWorkTenant: async () => undefined,
  assertSmsWorkOwnership: async () => undefined,
  smsWorkCheckpoint: (_key: string, operation: () => Promise<unknown>) => operation(),
  durableAfter: (callback: () => Promise<unknown>) => h.deferred.push(callback),
  enqueueEstimateWork: vi.fn(async () => ({ id: 'estimate-job-1' })),
  enqueueSmsWork: vi.fn(), internalWorkPayload: vi.fn(), runSmsWorkNow: vi.fn(),
}))
vi.mock('@/lib/push/events', () => ({ enqueuePushEvent: h.enqueue }))
vi.mock('@/lib/agents/cron', () => ({ isCronAuthorised: () => true }))
vi.mock('@/lib/intake/structure', () => ({ structureIntake: vi.fn(async () => ({
  trade: 'electrical', job_type: 'powerpoint', address: null, suburb: 'Bondi',
  scope: { description: 'Install another outdoor powerpoint' }, access: {}, property: {}, risks: [],
  inspection_required: false, caller: { name: 'Jeph' }, timing: {}, confidence: 'HIGH', confidence_reason: 'clear',
})) }))
vi.mock('@/lib/intake/schema', () => ({ deriveTradeFromJobType: () => 'electrical' }))
vi.mock('@/lib/intake/embed', () => ({ embedIntake: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/intake/quality', () => ({ evaluateIntakeQuality: () => 'usable', missingRequiredFields: () => [] }))
vi.mock('@/lib/intake/job-type-reconcile', () => ({ reconcileJobType: () => ({ agreement: 'agree' }) }))
vi.mock('@/lib/util/retry', () => ({ withRetry: (fn: () => Promise<unknown>) => fn() }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ step: vi.fn(), ok: vi.fn(), err: vi.fn(), done: vi.fn() }) }))
vi.mock('@/lib/customers/lookup', () => ({ findOrCreateCustomer: vi.fn(async () => null), updateCustomerFromIntake: vi.fn(async () => undefined) }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: vi.fn(async () => ({ ok: true, channel: 'sms', sid: 'SM1' })) }))
vi.mock('@/lib/sms/outbound-from', () => ({ resolveOutboundFromNumber: () => '+61411111111' }))
vi.mock('@/lib/sms/templates', () => ({
  buildIncompleteCallSms: () => '', buildIntakeRecoverySms: () => '', buildPhotoRequestSms: () => '', buildQuoteFailureSms: () => '',
}))
vi.mock('@/lib/sms/product-options', () => ({ describeChosenProductDirective: () => null, chosenProductFromChoice: () => null }))

import { POST } from './route'

function voiceRequest(): Request {
  return new Request('https://example.test/api/intake/structure', {
    method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ callId: 'call-1' }),
  })
}

function smsRequest(): Request {
  return new Request('https://example.test/api/intake/structure', {
    method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'conversation-1', sourceChannel: 'sms' }),
  })
}

describe('POST /api/intake/structure new-lead hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.deferred.length = 0
    h.state.call = { id: 'call-1', transcript: 'Jeph needs an outdoor powerpoint in Bondi', tenant_id: 'tenant-1' }
    h.state.conversation = null
    h.state.intakeInsert = { data: { id: 'intake-1' }, error: null }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
  })

  it('calls the real handler hook after persistence with exact voice deep link', async () => {
    const response = await POST(voiceRequest())
    expect(response.status).toBe(200)
    expect(h.deferred).toHaveLength(2)
    await h.deferred[0]!()
    expect(h.enqueue).toHaveBeenCalledWith(h.supabase, {
      eventKey: 'new-lead:voice:call-1', tenantId: 'tenant-1', title: 'New lead',
      body: 'Jeph in Bondi just asked for a quote.', url: '/chats?chatId=call-1',
    })
  })

  it('does not schedule a push for a tenantless persisted intake', async () => {
    h.state.call = { id: 'call-1', transcript: 'Jeph needs an outdoor powerpoint in Bondi', tenant_id: null }
    const response = await POST(voiceRequest())
    expect(response.status).toBe(200)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.deferred).toHaveLength(1)
  })

  it('does not schedule a second push for a pre-marked dialog lead', async () => {
    h.state.conversation = {
      id: 'conversation-1', tenant_id: 'tenant-1', from_number: null, lead_push_sent_at: new Date().toISOString(),
      assumptions_made: [], conversation_state: { slots: { job_type: 'powerpoint' } }, photo_urls: [], photo_paths: [],
    }
    const response = await POST(smsRequest())
    expect(response.status).toBe(200)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.deferred).toHaveLength(1)
  })

  it('does not schedule a push when the intake insert fails', async () => {
    h.state.intakeInsert = { data: null as never, error: { message: 'write failed' } }
    const response = await POST(voiceRequest())
    expect(response.status).toBe(500)
    expect(h.deferred).toHaveLength(0)
    expect(h.enqueue).not.toHaveBeenCalled()
  })
})
