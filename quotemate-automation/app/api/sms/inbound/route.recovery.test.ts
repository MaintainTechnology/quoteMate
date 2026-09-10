import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => {
  process.env.SMS_RECEPTIONIST_ENABLED = '1'
  process.env.PUBLIC_WEB_ORIGIN = 'https://quotemax.com.au'
  process.env.SMS_DEBOUNCE_MS = '0'
  type Row = Record<string, unknown>
  const state = { conversation: {} as Row, messages: [] as Row[], checkpoints: {} as Row,
    callbacks: [] as Array<() => Promise<unknown>>, crashAfterStructuring: false }
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  const intents = new Map<string, Row>()
  const client = { rpc: vi.fn(() => { throw new Error('Conversation creation must not repeat after snapshot') }), from(table: string) {
    let action = 'read', payload: Row = {}, single = false
    const filters: Row = {}
    const query: Record<string, unknown> = {}
    for (const method of ['select','order','limit','or','not','in','gte','neq']) query[method] = () => query
    query.eq = (key: string, value: unknown) => { filters[key] = value; return query }
    query.is = query.eq
    for (const method of ['insert','update','upsert']) query[method] = (row: Row) => { action = method; payload = row; return query }
    async function result() {
      if (action !== 'read') {
        if (table === 'sms_conversations') {
          state.conversation = { ...state.conversation, ...payload }
          if (state.crashAfterStructuring && payload.status === 'structuring') {
            state.crashAfterStructuring = false
            throw new Error('process lost after committed structuring write')
          }
        }
        if (table === 'sms_messages' && action === 'insert') {
          if (state.messages.some(row => row.twilio_message_sid === payload.twilio_message_sid)) return { data: null, error: { code: '23505' } }
          state.messages.push({ ...payload, id: 'message-1', created_at: new Date().toISOString() })
        }
        return { data: { id: 'conversation-1' }, error: null }
      }
      if (table === 'sms_conversations') return { data: clone(state.conversation), error: null }
      if (table === 'sms_messages') return { data: single ? clone(state.messages.find(row => row.twilio_message_sid === filters.twilio_message_sid) ?? null) : clone(state.messages), error: null }
      if (table === 'quotes') return { data: null, error: null }
      return { data: single ? null : [], error: null }
    }
    query.single = query.maybeSingle = () => { single = true; return query }
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => result().then(resolve, reject)
    return query
  } }
  return { state, client, clone, intents, dialog: vi.fn(), send: vi.fn(),
    enqueue: vi.fn(async (input: Row) => { intents.set(String(input.key), input); return { id: 'intake-work-1' } }),
  }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/sms/durable-work', () => ({
  currentSmsWork: () => ({ jobId: 'inbound-work-1', ownerToken: 'owner-1', turnId: 'turn-1', sequence: 1,
    job: { checkpoint: h.state.checkpoints } }),
  withFencedSmsClient: (client: unknown) => client, assertSmsWorkOwnership: async () => {}, attributeSmsWorkTenant: async () => {}, smsWorkFetch: vi.fn(),
  durableAfter: (callback: () => Promise<unknown>) => h.state.callbacks.push(callback),
  smsWorkCheckpoint: async (key: string, operation: () => Promise<unknown>) => {
    if (!Object.hasOwn(h.state.checkpoints, key)) h.state.checkpoints[key] = h.clone(await operation())
    return h.clone(h.state.checkpoints[key])
  },
  enqueueSmsWork: h.enqueue,
  internalWorkPayload: (path: string, body: unknown) => ({ url: `https://quotemax.com.au${path}`, body: JSON.stringify(body) }),
}))
vi.mock('@/lib/tenant/lookup', () => ({
  isProvisionedAgentNumber: async () => null,
  tenantByDestinationSms: async () => ({ id: 'tenant-1', business_name: 'Test tradie', status: 'active', trade: 'electrical', trades: ['electrical'] }),
  isTransactableTenantStatus: () => true,
}))
vi.mock('@/lib/customers/lookup', () => ({ findOrCreateCustomer: async () => null, formatCustomerContext: () => '', writeCustomerCorrections: async () => {} }))
vi.mock('@/lib/sms/quote-actions', () => ({ handleExistingQuoteAction: async () => ({ handled: false }), guardGeneratedQuoteLinks: (text: string) => text }))
vi.mock('@/lib/sms/dialog', () => ({ decideNextTurn: h.dialog }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.send }))
vi.mock('@/lib/log/trace', () => ({ recordTrace: async () => {} }))
vi.mock('@/lib/sms/extract-slots', async (original) => ({ ...await original<object>(), extractSlots: async () => ({ updates: {} }) }))
vi.mock('@/lib/sms/quote-readiness', async (original) => ({ ...await original<object>(), evaluateQuoteReadiness: () => ({ ready: true, missing: [] }) }))
vi.mock('@/lib/sms/gpo-guard', () => ({ buildGpoInspectionOverride: () => null }))
vi.mock('@/lib/sms/photo-request-trigger', async (original) => ({ ...await original<object>(), shouldSendPhotoRequest: () => ({ fire: false }) }))
vi.mock('@/lib/quote/pdf', () => ({ ensureRoofQuotePdf: vi.fn(), roofQuotePdfUrl: vi.fn(), signQuotePdfUrl: vi.fn() }))
vi.mock('@/lib/sms/roofing-measure-dispatch', () => ({ measureAndDispatchRoofing: vi.fn(), ROOFING_APP_BASE_URL: 'https://quotemax.com.au' }))
vi.mock('@/lib/sms/painting-estimate-dispatch', () => ({ estimateAndDispatchPainting: vi.fn() }))
vi.mock('@/lib/sms/solar-receptionist', () => ({ handleSolarSmsTurn: vi.fn() }))
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: vi.fn() }))
vi.mock('@/lib/roofing/roof-after', () => ({ generateRoofAfterImage: vi.fn() }))
import { POST } from './route'

const request = () => new Request('https://quotemax.com.au/api/sms/inbound', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ From: '+61411111111', To: '+61488888888', MessageSid: 'SM-customer-finish', Body: 'Yes, those details are correct.' }),
})
async function attempt() {
  h.state.callbacks = []
  const response = await POST(request())
  if (!response.ok) throw new Error(`route ${response.status}: ${await response.text()}`)
  for (const callback of h.state.callbacks) await callback()
}
beforeEach(() => {
  vi.clearAllMocks(); h.intents.clear(); h.state.messages = []; h.state.checkpoints = {}; h.state.crashAfterStructuring = false
  h.state.conversation = { id: 'conversation-1', tenant_id: 'tenant-1', from_number: '+61411111111', to_number: '+61488888888',
    status: 'open', turn_count: 2, intake_id: null, quote_id: null, assumptions_made: [], last_message_at: new Date().toISOString(),
    conversation_state: { slots: { first_name: 'Sam', suburb: 'Sydney', job_type: 'power_points', count: 2 }, sources: {} } }
  h.dialog.mockResolvedValue({ action: 'finish', job_type_guess: 'power_points', ready_for_intake: true,
    reply_to_send: 'Thanks, your details are ready for review.', assumptions_made: [], request_photo_link: false, offer_product_choice: false })
  h.send.mockResolvedValue({ ok: true, outboxId: 'reply-intent', channel: 'sms', sid: 'SM-reply' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
describe('actual inbound replay after its own processing-status write', () => {
  it('replays the gathering decision and persists the missing intake handoff', async () => {
    h.state.crashAfterStructuring = true
    await expect(attempt()).rejects.toThrow('process lost after committed structuring write')
    expect(h.state.conversation.status).toBe('structuring')
    expect(h.state.conversation.intake_id).toBeNull()
    expect(h.intents.size).toBe(0)
    await attempt()
    expect(h.intents.size).toBe(1)
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intake', tenantId: 'tenant-1' }))
    expect(h.dialog).toHaveBeenCalledOnce()
    expect(h.dialog).toHaveBeenCalledWith(expect.objectContaining({ quoteInProgress: false }))
    expect(h.state.conversation.turn_count).toBe(3)
  })
  it('also recovers an older work item that only saved conversation_snapshot', async () => {
    h.state.checkpoints.conversation_snapshot = h.clone(h.state.conversation)
    h.state.conversation.status = 'structuring'
    await attempt()
    expect(h.intents.size).toBe(1)
    expect(h.dialog).toHaveBeenCalledWith(expect.objectContaining({ quoteInProgress: false }))
  })
  it('reuses a new conversation snapshot without creating another conversation on replay', async () => {
    h.state.checkpoints.conversation_lookup = { prior: null, ageMs: Number.MAX_SAFE_INTEGER }
    h.state.checkpoints.conversation_snapshot = h.clone(h.state.conversation)
    h.state.conversation.status = 'structuring'
    await attempt()
    expect(h.intents.size).toBe(1)
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'intake', key: 'intake:sms:conversation-1:SM-customer-finish',
      payload: expect.objectContaining({ body: JSON.stringify({ conversationId: 'conversation-1', sourceChannel: 'sms' }) }),
    }))
    expect(h.dialog).toHaveBeenCalledWith(expect.objectContaining({ quoteInProgress: false }))
    expect(h.state.conversation.turn_count).toBe(3)
    expect(h.client.rpc).not.toHaveBeenCalled()
  })
})
