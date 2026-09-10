import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Execute the actual POST and deferred customer dispatch with different origins.
// Database, model and transport are offline fixtures; URL/template helpers are real.
const h = vi.hoisted(() => {
  process.env.SMS_RECEPTIONIST_ENABLED = '1'
  process.env.WP9_PRODUCT_OPTIONS = '1'
  process.env.SMS_DEBOUNCE_MS = '0'
  type Row = Record<string, unknown>
  const state = { conversation: {} as Row, messages: [] as Row[], materials: [] as Row[],
    checkpoints: {} as Row, callbacks: [] as Array<() => Promise<unknown>>, photo: false, registration: false, reused: false,
    trade: 'electrical', paintLeads: [] as Row[], roofLeads: [] as Row[], failPaintSave: false, failPaintRead: false, losePaintSaveResponse: false,
    failStateTrade: '', stateFailureMode: '', outboxes: [] as Row[], llm: false, loseCheckpointResponse: '',
    roofMeasurements: [] as Row[], failRoofLead: '', failUnlock: false, failPhotoEnqueue: false,
    solarReferences: [] as Row[], failSolarProfile: '', realDialogGuards: false,
    writes: [] as Array<{ table: string; action: string; filters?: Row; profile?: unknown }> }
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  const client = { from(table: string) {
    let action = 'read', payload: Row = {}, single = false
    const filters: Row = {}
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'order', 'limit', 'or', 'not', 'in', 'gte', 'neq']) query[method] = () => query
    query.eq = (key: string, value: unknown) => { filters[key] = value; return query }
    query.is = query.eq
    for (const method of ['insert', 'update', 'upsert']) query[method] = (row: Row) => { action = method; payload = row; return query }
    async function result() {
      if (action !== 'read') {
        state.writes.push({ table, action, ...(table === 'sms_conversations' && payload.conversation_state
          ? { filters: clone(filters), profile: clone(payload.conversation_state) } : {}) })
        if (table === 'roofing_measurements') {
          if (state.failRoofLead === 'save') return { data: null, error: { message: 'lead write unavailable' } }
          if (!state.roofMeasurements.some(row => row.tenant_id === payload.tenant_id && row.source_request_key === payload.source_request_key)) {
            state.roofMeasurements.push({ ...clone(payload), id: 'roof-lead-1' })
          }
          if (state.failRoofLead === 'lost-response') {
            state.failRoofLead = ''
            throw new Error('Unmeasured lead committed but response lost')
          }
        }
        if (table === 'painting_lead_requests' || table === 'trade_lead_requests') {
          if (table === 'painting_lead_requests' && state.failPaintSave) return { data: null, error: { message: 'database unavailable' } }
          const rows = table === 'painting_lead_requests' ? state.paintLeads : state.roofLeads
          if (!rows.some(row => row.token === payload.token)) rows.push(clone(payload))
          if (table === 'painting_lead_requests' && state.losePaintSaveResponse) {
            state.losePaintSaveResponse = false
            throw new Error('Painting form insert committed but response lost')
          }
        }
        if (table === 'sms_conversations') {
          if (state.failUnlock && Object.hasOwn(payload, 'last_processed_work_sequence')) throw new Error('Process lost before conversation unlock')
          const solarProfile = (payload.conversation_state as Row | undefined)?.slots &&
            ((payload.conversation_state as Row).slots as Row).first_name === 'Alex'
          if (solarProfile && state.failSolarProfile === 'returned') return { data: null, error: { message: 'Solar name write unavailable' } }
          if (solarProfile && state.failSolarProfile === 'missing-row') return { data: null, error: null }
          const failing = state.failStateTrade && Object.hasOwn(payload, `${state.failStateTrade}_state`)
          if (failing && state.stateFailureMode === 'returned') return { data: null, error: { message: 'state write unavailable' } }
          if (failing && state.stateFailureMode === 'missing-row') return { data: null, error: null }
          if (failing && state.stateFailureMode === 'thrown') throw new Error('state connection interrupted')
          state.conversation = { ...state.conversation, ...payload }
          if (solarProfile && state.failSolarProfile === 'lost-response') throw new Error('Solar name committed but response lost')
          if (failing && state.stateFailureMode === 'lost-response') throw new Error('state committed but response lost')
        }
        if (table === 'sms_messages' && action === 'insert') state.messages.push({ ...payload, id: 'message-1', created_at: new Date().toISOString() })
        return { data: { id: 'conversation-1' }, error: null }
      }
      if (table === 'sms_conversations') {
        if (filters.conversation_type === 'tradie_registration' && !state.reused) return { data: null, error: null }
        return { data: clone(state.conversation), error: null }
      }
      if (table === 'sms_messages') return { data: single ? clone(state.messages.find(row => row.twilio_message_sid === filters.twilio_message_sid) ?? null) : clone(state.messages), error: null }
      if (table === 'tenant_material_catalogue') return { data: clone(state.materials), error: null }
      if (table === 'roofing_measurements') {
        if (state.failRoofLead === 'readback' && state.roofMeasurements.length) return { data: null, error: { message: 'lead readback unavailable' } }
        const rows = state.roofMeasurements.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
        return { data: clone(single ? rows[0] ?? null : rows), error: null }
      }
      if (table === 'painting_lead_requests' || table === 'trade_lead_requests') {
        if (table === 'painting_lead_requests' && state.failPaintRead) return { data: null, error: { message: 'readback unavailable' } }
        const rows = (table === 'painting_lead_requests' ? state.paintLeads : state.roofLeads)
          .filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
        return { data: clone(single ? rows[0] ?? null : rows), error: null }
      }
      return { data: single ? null : [], error: null }
    }
    query.single = query.maybeSingle = () => { single = true; return query }
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => result().then(resolve, reject)
    return query
  }, async rpc(name: string, args: Row) {
    if (name === 'sms_customer_quote_references') return { data: clone(state.solarReferences), error: null }
    if (name === 'sms_outbox_enqueue') {
      if (state.failPhotoEnqueue && String(args.p_key).endsWith(':photo-request')) return { data: null, error: { code: '08006', message: 'Photo intent unavailable' } }
      let row = state.outboxes.find(item => item.delivery_key === args.p_key)
      if (row && row.payload_hash !== args.p_hash) throw new Error('Changed outbox payload on replay')
      if (!row) {
        row = { id: `outbox-${state.outboxes.length + 1}`, delivery_key: args.p_key, payload_hash: args.p_hash,
          payload: clone(args.p_payload), status: 'pending', result: null, provider_sid: null }
        state.outboxes.push(row)
      }
      return { data: clone(row), error: null }
    }
    const row = state.outboxes.find(item => item.id === args.p_id)
    if (!row) throw new Error(`Unknown fixture outbox: ${name}`)
    if (name === 'sms_outbox_claim') {
      if (row.status !== 'pending') return { data: null, error: null }
      row.status = 'sending'; row.attempt_token = args.p_attempt
      return { data: clone(row), error: null }
    }
    if (name === 'sms_outbox_finish') {
      row.status = args.p_status; row.result = clone(args.p_result); row.provider_sid = args.p_sid
      const payload = row.payload as Row
      state.messages.push({ id: `message-${row.id}`, conversation_id: payload.conversationId, direction: 'outbound',
        body: payload.text, outbox_id: row.id, twilio_message_sid: args.p_sid, delivery_status: args.p_status })
      return { data: clone(row), error: null }
    }
    throw new Error(`Unexpected fixture RPC: ${name}`)
  } }
  return { state, client, clone, dialog: vi.fn(), send: vi.fn(), signupSend: vi.fn(), enqueue: vi.fn(), carrier: vi.fn(), specialist: vi.fn(), screen: vi.fn(), measure: vi.fn(), extract: vi.fn(), solarTurn: vi.fn() }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/sms/durable-work', () => ({
  currentSmsWork: () => ({ jobId: 'inbound-work-1', ownerToken: 'owner-1', turnId: 'turn-1', sequence: 1, job: { checkpoint: h.state.checkpoints } }),
  withFencedSmsClient: (client: unknown) => client, assertSmsWorkOwnership: async () => {}, attributeSmsWorkTenant: async () => {}, smsWorkFetch: vi.fn(),
  durableAfter: (callback: () => Promise<unknown>) => h.state.callbacks.push(callback),
  smsWorkCheckpoint: async (key: string, operation: () => Promise<unknown>) => {
    if (!Object.hasOwn(h.state.checkpoints, key)) h.state.checkpoints[key] = h.clone(await operation())
    if (h.state.loseCheckpointResponse === key) {
      h.state.loseCheckpointResponse = ''
      throw new Error('Checkpoint committed but response lost')
    }
    return h.clone(h.state.checkpoints[key])
  },
  enqueueSmsWork: h.enqueue,
  internalWorkPayload: (path: string, body: unknown) => ({ url: `https://offline-engine.invalid${path}`, body: JSON.stringify(body) }),
}))
vi.mock('@/lib/tenant/lookup', () => ({
  isProvisionedAgentNumber: async () => null,
  tenantByDestinationSms: async () => h.state.registration ? null : ({ id: 'tenant-1', business_name: 'Test tradie', status: 'active', trade: h.state.trade, trades: [h.state.trade] }),
  isTransactableTenantStatus: () => true,
}))
vi.mock('@/lib/customers/lookup', () => ({ findOrCreateCustomer: async () => null, formatCustomerContext: () => '', writeCustomerCorrections: async () => {} }))
vi.mock('@/lib/sms/quote-actions', async original => {
  const actual = await original<typeof import('@/lib/sms/quote-actions')>()
  return { ...actual, handleExistingQuoteAction: async (args: Parameters<typeof actual.handleExistingQuoteAction>[0]) =>
    h.state.trade === 'solar' || h.state.realDialogGuards ? actual.handleExistingQuoteAction(args) : { handled: false },
    guardGeneratedQuoteLinks: (text: string) => h.state.realDialogGuards ? actual.guardGeneratedQuoteLinks(text) : text }
})
vi.mock('@/lib/sms/dialog', () => ({ decideNextTurn: h.dialog }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.send }))
vi.mock('@/lib/sms/twilio', () => ({ sendSms: h.signupSend }))
vi.mock('@/lib/sms/intent', () => ({ classifyIntent: async () => ({ intent: 'tradie_registration' }) }))
vi.mock('@/lib/onboard/invitation-codes', () => ({ checkInvitationCode: async () => ({ ok: true }) }))
vi.mock('@/lib/onboard/intent-tokens', () => ({ createOrGetActiveIntent: async () => ({ token: 'saved-signup-token', reused: h.state.reused }) }))
vi.mock('@/lib/log/trace', () => ({ recordTrace: async () => {} }))
vi.mock('@/lib/sms/extract-slots', async (original) => ({ ...await original<object>(), extractSlots: h.extract }))
vi.mock('@/lib/sms/quote-readiness', async (original) => ({ ...await original<object>(), evaluateQuoteReadiness: () => ({ ready: true, missing: [] }) }))
vi.mock('@/lib/sms/gpo-guard', () => ({ buildGpoInspectionOverride: () => null }))
vi.mock('@/lib/sms/photo-request-trigger', async (original) => {
  const actual = await original<typeof import('@/lib/sms/photo-request-trigger')>()
  return { ...actual, shouldSendPhotoRequest: (args: Parameters<typeof actual.shouldSendPhotoRequest>[0]) =>
    h.state.realDialogGuards ? actual.shouldSendPhotoRequest(args) : { fire: h.state.photo } }
})
vi.mock('@/lib/quote/pdf', () => ({ ensureRoofQuotePdf: vi.fn(), roofQuotePdfUrl: vi.fn(), signQuotePdfUrl: vi.fn() }))
vi.mock('@/lib/sms/roofing-measure-dispatch', () => ({ measureAndDispatchRoofing: h.measure, ROOFING_APP_BASE_URL: 'https://offline-engine.invalid' }))
vi.mock('@/lib/sms/llm-receptionist', async (original) => ({ ...await original<object>(),
  llmReceptionistEnabled: () => h.state.llm, paintingTurnViaLlm: h.specialist, roofingTurnViaLlm: h.specialist }))
vi.mock('@/lib/sms/verify-address', async (original) => ({ ...await original<object>(), screenConfirmAddress: h.screen }))
vi.mock('@/lib/sms/painting-estimate-dispatch', () => ({ estimateAndDispatchPainting: vi.fn() }))
vi.mock('@/lib/sms/solar-receptionist', () => ({ handleSolarSmsTurn: h.solarTurn }))
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: vi.fn() }))
vi.mock('@/lib/roofing/roof-after', () => ({ generateRoofAfterImage: vi.fn() }))
import { POST } from './route'
import { dispatchDurably } from '@/lib/sms/durable-outbox'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'

async function attempt(body = 'Yes, those details are correct.') {
  h.state.callbacks = []
  await withSmsDeliveryContext({ workId: 'inbound-work-1', workOwner: 'owner-1', turnId: 'turn-1', tenantId: 'tenant-1', conversationId: 'conversation-1' }, async () => {
  const response = await POST(new Request('https://offline-engine.invalid/api/sms/inbound', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+61411111111', To: '+61488888888', MessageSid: 'SM-customer-links', Body: body }),
  }))
  expect(response.status).toBe(200)
  for (const callback of h.state.callbacks) await callback()
  })
}
async function savedSolarFixture() {
  h.state.trade = 'solar'; vi.stubEnv('SMS_WORKER_SERVICE', 'solar')
  const { handleSolarSmsTurn } = await vi.importActual<typeof import('@/lib/sms/solar-receptionist')>('@/lib/sms/solar-receptionist')
  h.solarTurn.mockImplementation(handleSolarSmsTurn)
  const reference = { family: 'solar', id: 'saved-solar-id', token: 'saved-solar-token-123', label: '12 Smith Street', stage: 'awaiting_review' }
  const solar = { reference, step: 'awaiting_review', address: { address: '12 Smith Street', state: 'NSW', postcode: '2000' }, confirmed: true, phase: 'single', panelType: 'standard_panels' }
  h.state.conversation = { ...h.state.conversation, status: 'done', quote_stage: 'awaiting_review',
    conversation_state: { slots: { first_name: 'Sam' }, sources: {}, solar, quote_reference: reference, quote_candidates: null } }
  h.state.solarReferences = [{ family: 'solar', resource_id: reference.id, token: reference.token, label: reference.label, stage: reference.stage }]
  h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
  return { reference, solar }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('APP_URL', 'https://offline-engine.invalid')
  vi.stubEnv('ENGINE_BASE_URL', 'https://offline-engine.invalid')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://quotemax.com.au')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://offline-database.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture')
  h.state.messages = []; h.state.materials = []; h.state.checkpoints = {}; h.state.callbacks = []
  h.state.photo = false; h.state.registration = false; h.state.reused = false
  h.state.trade = 'electrical'; h.state.paintLeads = []; h.state.roofLeads = []; h.state.failPaintSave = false; h.state.failPaintRead = false; h.state.losePaintSaveResponse = false
  h.state.failStateTrade = ''; h.state.stateFailureMode = ''; h.state.outboxes = []; h.state.llm = false; h.state.loseCheckpointResponse = ''
  h.state.roofMeasurements = []; h.state.failRoofLead = ''; h.state.failUnlock = false; h.state.failPhotoEnqueue = false
  h.state.solarReferences = []; h.state.failSolarProfile = ''
  h.state.realDialogGuards = false; h.state.writes = []
  h.state.conversation = { id: 'conversation-1', tenant_id: 'tenant-1', from_number: '+61411111111', to_number: '+61488888888',
    status: 'open', turn_count: 2, intake_id: null, quote_id: null, assumptions_made: [], last_message_at: new Date().toISOString(),
    photo_request_token: 'saved-photo-token',
    conversation_state: { slots: { first_name: 'Sam', suburb: 'Sydney', job_type: 'power_points', count: 2 }, sources: {} } }
  h.dialog.mockResolvedValue({ action: 'finish', job_type_guess: 'power_points', ready_for_intake: true,
    reply_to_send: 'Thanks, your details are ready for review.', assumptions_made: [], request_photo_link: false, offer_product_choice: false })
  h.send.mockResolvedValue({ ok: true, outboxId: 'reply-intent', channel: 'sms', sid: 'SM-reply' })
  h.signupSend.mockResolvedValue({ ok: true, sid: 'SM-signup' })
  h.enqueue.mockResolvedValue({ id: 'intake-work-1' })
  h.extract.mockReset().mockResolvedValue({ updates: {} })
  h.solarTurn.mockReset()
  h.carrier.mockResolvedValue({ ok: true, channel: 'sms', sid: 'SM-accepted-form', status: 'queued' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

function savedRoofPaintProfileFixture(trade: 'roofing' | 'painting') {
  h.state.trade = trade; vi.stubEnv('SMS_WORKER_SERVICE', trade)
  h.state.realDialogGuards = true
  const family = trade === 'roofing' ? 'roof' : 'paint'
  const reference = { family, id: `saved-${family}-id`, token: `saved-${family}-token-123`, label: '12 Smith Street', stage: 'awaiting_review' }
  const specialist = { slots: { address: '12 Smith Street', address_confirmed: true, material: 'saved material', scope: 'saved scope' },
    last_step: 'closed', workflow_stage: 'awaiting_review', pending_quote_token: reference.token, pending_structure_count: 2 }
  const pending = { receiptId: 'earlier-correction', text: 'Please correct the job', candidates: [reference] }
  h.state.conversation = { ...h.state.conversation, status: 'done', quote_stage: null, [`${trade}_state`]: specialist,
    conversation_state: { slots: { first_name: 'Sam' }, sources: {}, quote_reference: reference, quote_candidates: null, pending_job_correction: pending } }
  h.state.solarReferences = [{ family, resource_id: reference.id, token: reference.token, label: reference.label, stage: reference.stage }]
  h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
  return { reference, specialist, pending }
}

describe('saved roofing name correction preserves the consumed draft', () => {
  const trade = 'roofing'
  it('updates only the customer name and retains one accepted reply on replay', async () => {
    const saved = savedRoofPaintProfileFixture(trade)
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex', address: 'Unrequested different address', job_type: 'power_points' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.conversation).toMatchObject({ status: 'done', quote_stage: null, conversation_state: {
      slots: { first_name: 'Alex' }, sources: { first_name: 'customer_corrected' }, quote_reference: saved.reference,
      quote_candidates: null, pending_job_correction: saved.pending } })
    expect((h.state.conversation.conversation_state as Record<string, unknown>).slots).not.toHaveProperty('address')
    expect((h.state.conversation.conversation_state as Record<string, unknown>).slots).not.toHaveProperty('job_type')
    expect(h.extract).toHaveBeenCalledOnce(); expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.writes.filter(row => (row.profile as { slots?: { first_name?: string } } | undefined)?.slots?.first_name === 'Alex'))
      .toEqual([expect.objectContaining({ filters: { id: 'conversation-1', tenant_id: 'tenant-1' } })])
    expect(h.state.roofLeads).toEqual([]); expect(h.state.paintLeads).toEqual([]); expect(h.state.roofMeasurements).toEqual([])
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled(); expect(h.specialist).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled()
    expect(h.state.writes.filter(row => ['sms_human_tasks', 'intakes', 'quotes', 'painting_measurements', 'roofing_measurements'].includes(row.table))).toEqual([])
    expect(h.state.outboxes).toHaveLength(1)
    const text = (h.state.outboxes[0].payload as Record<string, unknown>).text
    expect(text).toMatch(/Alex.*name.*unchanged/i); expect(text).not.toMatch(/https?:|\$|sent|on its way/i)
    const accepted = h.clone(h.state.outboxes)
    h.extract.mockResolvedValue({ updates: { first_name: 'Wrong replay name' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.outboxes).toEqual(accepted); expect(h.extract).toHaveBeenCalledOnce(); expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
  })
  it.each(['returned', 'missing-row', 'lost-response', 'checkpoint', 'unlock'])('recovers %s failure without selecting a new name or sending again', async failure => {
    const saved = savedRoofPaintProfileFixture(trade)
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex' } })
    h.state.failSolarProfile = ['returned', 'missing-row', 'lost-response'].includes(failure) ? failure : ''
    h.state.loseCheckpointResponse = failure === 'checkpoint' ? 'saved_specialist_profile' : ''
    h.state.failUnlock = failure === 'unlock'
    await expect(attempt('Correction: my first name is Alex, not Sam.')).rejects.toThrow(/name|checkpoint|unlock/i)
    if (['returned', 'missing-row', 'lost-response'].includes(failure)) {
      expect(h.state.writes.filter(row => (row.profile as { slots?: { first_name?: string } } | undefined)?.slots?.first_name === 'Alex'))
        .toEqual([expect.objectContaining({ filters: { id: 'conversation-1', tenant_id: 'tenant-1' } })])
    }
    expect(h.state.outboxes).toHaveLength(failure === 'unlock' ? 1 : 0)
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    h.state.failSolarProfile = ''; h.state.failUnlock = false
    h.extract.mockResolvedValue({ updates: { first_name: 'Wrong replay name' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.conversation).toMatchObject({ status: 'done', conversation_state: {
      slots: { first_name: 'Alex' }, quote_reference: saved.reference, pending_job_correction: saved.pending } })
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.extract).toHaveBeenCalledOnce(); expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes).toHaveLength(1); expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.state.roofLeads).toEqual([]); expect(h.state.paintLeads).toEqual([])
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled()
  })
  it('asks for an unrecognized name without restarting the intake form', async () => {
    const saved = savedRoofPaintProfileFixture(trade)
    h.extract.mockResolvedValue({ updates: {} })
    await attempt('Please update my first name.')
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.conversation.conversation_state).toMatchObject({ slots: { first_name: 'Sam' }, quote_reference: saved.reference })
    expect(h.state.roofLeads).toEqual([]); expect(h.state.paintLeads).toEqual([])
    expect(h.state.outboxes).toHaveLength(1)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/reply.*my first name is/i)
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled()
    // This is a separate inbound work item, not a retry of the unanswered one.
    const durableWork = await import('@/lib/sms/durable-work')
    h.state.checkpoints = {}; h.state.callbacks = []
    vi.spyOn(durableWork, 'currentSmsWork').mockReturnValue({ jobId: 'profile-answer-work-2', ownerToken: 'owner-2',
      turnId: 'profile-answer-turn-2', sequence: 2, job: { checkpoint: h.state.checkpoints } } as ReturnType<typeof durableWork.currentSmsWork>)
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex' } })
    await withSmsDeliveryContext({ workId: 'profile-answer-work-2', workOwner: 'owner-2', turnId: 'profile-answer-turn-2', tenantId: 'tenant-1', conversationId: 'conversation-1' }, async () => {
      const response = await POST(new Request('https://offline-engine.invalid/api/sms/inbound', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: '+61411111111', To: '+61488888888', MessageSid: 'SM-profile-answer-2', Body: 'My first name is Alex.' }),
      }))
      expect(response.status).toBe(200)
      for (const callback of h.state.callbacks) await callback()
    })
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.conversation.conversation_state).toMatchObject({ slots: { first_name: 'Alex' }, quote_reference: saved.reference })
    expect(h.state.outboxes).toHaveLength(2); expect(h.carrier).toHaveBeenCalledTimes(2); expect(h.extract).toHaveBeenCalledTimes(2)
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(2)
    expect(h.state.roofLeads).toEqual([])
  })
  it.each(['How much again?', 'Could you send the quote link again?'])('retains authoritative saved action precedence for %s', async text => {
    const saved = savedRoofPaintProfileFixture(trade)
    await attempt(text)
    expect(h.extract).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.outboxes).toHaveLength(1); expect(h.carrier).toHaveBeenCalledOnce()
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/awaiting.*review/i)
  })
  it.each([
    'My name is Alex. Please start a new roof quote for another property at 22 New Road, Sydney NSW 2000.',
    'Can you quote another re-roof?',
    'Can you quote a re-roof at 22 New Road, Sydney NSW 2000?',
    'Ok can you price 652 London Rd Chandler QLD 4155',
    'I need another roofing estimate',
  ])('keeps a genuine new-job request on the existing fresh intake path: %s', async text => {
    savedRoofPaintProfileFixture(trade)
    await attempt(text)
    expect(h.extract).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled()
    expect(trade === 'roofing' ? h.state.roofLeads : h.state.paintLeads).toHaveLength(1)
    expect(h.state.conversation[`${trade}_state`]).toMatchObject({ last_step: 'offer_form', pending_quote_token: null })
    expect(h.state.outboxes).toHaveLength(1)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/quote-request|paint-request/)
  })
  it('keeps a cold normal enquiry on the existing intake path', async () => {
    savedRoofPaintProfileFixture(trade)
    h.state.conversation = { ...h.state.conversation, status: 'open', [`${trade}_state`]: null,
      conversation_state: { slots: {}, sources: {} } }
    await attempt(trade === 'roofing' ? 'Please quote a Colorbond re-roof at 12 Smith Street.' : 'Please quote painting the house at 12 Smith Street.')
    expect(h.extract).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled()
    expect(trade === 'roofing' ? h.state.roofLeads : h.state.paintLeads).toHaveLength(1)
    expect(h.state.outboxes).toHaveLength(1)
  })
  it.each(['Thanks', 'What happens next?', 'What happens next with my roof?'])('keeps ordinary saved-result follow-up out of intake: %s', async text => {
    const saved = savedRoofPaintProfileFixture(trade)
    await attempt(text)
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.conversation.conversation_state).toMatchObject({ quote_reference: saved.reference, pending_job_correction: saved.pending })
    expect(h.state.roofLeads).toEqual([]); expect(h.state.roofMeasurements).toEqual([])
    expect(h.extract).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.specialist).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled()
    expect(h.state.outboxes).toHaveLength(1); expect(h.carrier).toHaveBeenCalledOnce()
    const reply = (h.state.outboxes[0].payload as Record<string, unknown>).text
    expect(reply).toMatch(/saved roofing draft is unchanged/i)
    expect(reply).not.toMatch(/awaiting|sent|on its way|https?:|\$/i)
  })
  it('does not claim current review status from an outdated local state after owner release', async () => {
    const saved = savedRoofPaintProfileFixture(trade)
    h.state.solarReferences[0].stage = 'ready'
    await attempt('What happens next with my roof?')
    expect(h.state.conversation[`${trade}_state`]).toEqual(saved.specialist)
    expect(h.state.outboxes).toHaveLength(1)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).not.toMatch(/awaiting|not.*ready|before.*review/i)
    expect(h.state.roofLeads).toEqual([]); expect(h.enqueue).not.toHaveBeenCalled()
  })
})

describe('existing saved painting flow remains a separate regression control', () => {
  it('lets a shared tenant start painting while retaining its earlier saved roofing state', async () => {
    const saved = savedRoofPaintProfileFixture('roofing')
    const lookup = await import('@/lib/tenant/lookup')
    const tenant = await lookup.tenantByDestinationSms(null!, '+61488888888')
    vi.spyOn(lookup, 'tenantByDestinationSms').mockResolvedValue({ ...tenant!, trades: ['roofing', 'painting'] as unknown as NonNullable<typeof tenant>['trades'] })
    await attempt('Please quote painting the house.')
    expect(h.state.conversation.roofing_state).toEqual(saved.specialist)
    expect(h.state.paintLeads).toHaveLength(1); expect(h.state.roofLeads).toEqual([])
    expect(h.state.conversation.painting_state).toMatchObject({ last_step: 'offer_form', pending_quote_token: null })
    expect(h.state.outboxes).toHaveLength(1)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/paint-request/)
    expect(h.extract).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled()
  })
  it('retains the saved painting state when general extraction updates the customer name', async () => {
    const saved = savedRoofPaintProfileFixture('painting')
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex' } })
    h.dialog.mockResolvedValue({ action: 'end_conversation', job_type_guess: 'unknown', ready_for_intake: false,
      reply_to_send: 'Thanks Alex, your name is updated.', assumptions_made: [], request_photo_link: false, offer_product_choice: false })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.conversation.painting_state).toEqual(saved.specialist)
    expect(h.state.conversation.conversation_state).toMatchObject({ slots: { first_name: 'Alex' }, quote_reference: saved.reference })
    expect(h.extract).toHaveBeenCalledOnce(); expect(h.dialog).toHaveBeenCalledOnce()
    expect(h.state.paintLeads).toEqual([]); expect(h.enqueue).not.toHaveBeenCalled(); expect(h.measure).not.toHaveBeenCalled()
  })
  it.each(['How much again?', 'Could you send the quote link again?'])('retains authoritative saved action precedence for %s', async text => {
    const saved = savedRoofPaintProfileFixture('painting')
    await attempt(text)
    expect(h.state.conversation.painting_state).toEqual(saved.specialist)
    expect(h.extract).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.state.outboxes).toHaveLength(1)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/awaiting.*review/i)
  })
})

describe('actual inbound customer links use the configured website', () => {
  it('asks an actionable question when a gather-turn link promise has no downstream quote work', async () => {
    h.state.realDialogGuards = true
    h.dialog.mockResolvedValue({ action: 'ask', job_type_guess: 'power_points', ready_for_intake: false,
      reply_to_send: 'Sending the link now.', assumptions_made: [], request_photo_link: false, offer_product_choice: false })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await attempt('The power points are for the bedroom.')
    expect(h.dialog).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes).toHaveLength(1)
    expect(h.state.conversation).toMatchObject({ status: 'open', intake_id: null, quote_id: null })
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.state.writes.filter(row => ['sms_human_tasks', 'intakes', 'quotes'].includes(row.table))).toEqual([])
    expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: {
      text: 'I have not sent a link in this reply. What would you like help with next?',
      conversationId: 'conversation-1', tenantId: 'tenant-1', workId: 'inbound-work-1',
    } })
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toEqual([
      expect.objectContaining({ body: 'I have not sent a link in this reply. What would you like help with next?', delivery_status: 'accepted' }),
    ])
  })
  it('keeps a meaningful gather question after removing an unbacked link promise', async () => {
    h.state.realDialogGuards = true
    h.dialog.mockResolvedValue({ action: 'ask', job_type_guess: 'power_points', ready_for_intake: false,
      reply_to_send: 'Sending the link now. Which room needs the power points?', assumptions_made: [], request_photo_link: false, offer_product_choice: false })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await attempt('The power points are for the bedroom.')
    expect(h.state.outboxes).toHaveLength(1)
    expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: { text: 'Which room needs the power points?' } })
    expect(h.enqueue).not.toHaveBeenCalled()
  })
  it('handles a genuine resend with no saved quote before calling the dialog', async () => {
    h.state.realDialogGuards = true
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await attempt('Can you send the quote link again?')
    expect(h.dialog).not.toHaveBeenCalled()
    expect(h.state.outboxes).toHaveLength(1)
    expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: {
      text: 'I cannot find a saved quote linked to this number yet. What is the job address or the type of work? I can check the request without creating another quote.',
    } })
    expect(h.enqueue).not.toHaveBeenCalled()
  })
  it.each(['returned', 'missing-row', 'lost-response', 'checkpoint', 'unlock'])('recovers a saved solar name correction after %s failure with one chosen name and reply', async failure => {
    const saved = await savedSolarFixture()
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex' } })
    h.state.failSolarProfile = ['returned', 'missing-row', 'lost-response'].includes(failure) ? failure : ''
    h.state.loseCheckpointResponse = failure === 'checkpoint' ? 'solar_saved_profile' : ''
    h.state.failUnlock = failure === 'unlock'
    await expect(attempt('Correction: my first name is Alex, not Sam.')).rejects.toThrow(/solar|checkpoint|unlock/i)
    expect(h.state.outboxes).toHaveLength(failure === 'unlock' ? 1 : 0)
    expect(h.carrier).toHaveBeenCalledTimes(failure === 'unlock' ? 1 : 0)
    if (['returned', 'missing-row', 'checkpoint'].includes(failure)) expect(h.state.conversation.conversation_state).toMatchObject({ slots: { first_name: 'Sam' } })
    h.state.failSolarProfile = ''; h.state.failUnlock = false
    h.extract.mockResolvedValue({ updates: { first_name: 'Wrong replay name' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.conversation).toMatchObject({ status: 'done', quote_stage: 'awaiting_review', conversation_state: {
      slots: { first_name: 'Alex' }, solar: saved.solar, quote_reference: saved.reference } })
    expect(h.extract).toHaveBeenCalledOnce(); expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes).toHaveLength(1); expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.solarTurn).not.toHaveBeenCalled()
  })
  it.each(['How much again?', 'Could you send the quote link again?'])('keeps saved solar server action first for %s', async message => {
    const saved = await savedSolarFixture()
    await attempt(message)
    expect(h.extract).not.toHaveBeenCalled(); expect(h.solarTurn).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.state.conversation.conversation_state).toMatchObject({ solar: saved.solar, quote_reference: saved.reference })
    expect(h.state.outboxes).toHaveLength(1); expect(h.carrier).toHaveBeenCalledOnce()
    const text = (h.state.outboxes[0].payload as Record<string, unknown>).text
    expect(text).toMatch(/awaiting.*review/i); expect(text).not.toMatch(/https?:|\$/)
  })
  it('keeps an explicit fresh solar enquiry in the real deterministic intake without name extraction', async () => {
    await savedSolarFixture()
    h.state.conversation = { ...h.state.conversation, status: 'open', quote_stage: null, conversation_state: { slots: {}, sources: {} } }
    await attempt('I need a new solar quote at 12 Smith Street, Sydney NSW 2000.')
    expect(h.solarTurn).toHaveBeenCalledOnce(); expect(h.extract).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.state.conversation).toMatchObject({ status: 'open', quote_stage: 'confirm_address', conversation_state: {
      solar: { step: 'confirm_address', address: { state: 'NSW', postcode: '2000' } } } })
    expect(h.state.outboxes).toHaveLength(1); expect(h.carrier).toHaveBeenCalledOnce()
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/confirm.*solar installation address/i)
  })
  it('persists a saved solar customer name correction without altering the draft or replaying its reply', async () => {
    h.state.trade = 'solar'; vi.stubEnv('SMS_WORKER_SERVICE', 'solar')
    const { handleSolarSmsTurn } = await vi.importActual<typeof import('@/lib/sms/solar-receptionist')>('@/lib/sms/solar-receptionist')
    h.solarTurn.mockImplementation(handleSolarSmsTurn)
    const reference = { family: 'solar', id: 'saved-solar-id', token: 'saved-solar-token-123', label: '12 Smith Street', stage: 'awaiting_review' }
    const solar = { reference, step: 'awaiting_review', address: { address: '12 Smith Street', state: 'NSW', postcode: '2000' }, confirmed: true, phase: 'single', panelType: 'standard_panels' }
    h.state.conversation = { ...h.state.conversation, status: 'done', quote_stage: 'awaiting_review',
      conversation_state: { slots: { first_name: 'Sam' }, sources: {}, solar, quote_reference: reference, quote_candidates: null } }
    h.extract.mockResolvedValue({ updates: { first_name: 'Alex', address: 'Unrequested different address' } })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.extract).toHaveBeenCalledOnce()
    expect(h.extract).toHaveBeenCalledWith(expect.objectContaining({ customerMessage: 'Correction: my first name is Alex, not Sam.', tenantTrades: ['solar'] }))
    expect(h.state.conversation).toMatchObject({ status: 'done', quote_stage: 'awaiting_review', conversation_state: {
      slots: { first_name: 'Alex' }, sources: { first_name: 'customer_corrected' }, solar, quote_reference: reference, quote_candidates: null } })
    expect((h.state.conversation.conversation_state as Record<string, unknown>).slots).not.toHaveProperty('address')
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.dialog).not.toHaveBeenCalled(); expect(h.solarTurn).not.toHaveBeenCalled()
    expect(h.state.outboxes).toHaveLength(1); expect(h.carrier).toHaveBeenCalledOnce()
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).toMatch(/Alex.*name.*unchanged/i)
    expect((h.state.outboxes[0].payload as Record<string, unknown>).text).not.toMatch(/https?:|\$|sent|on its way/i)
    const accepted = h.clone(h.state.outboxes)
    h.extract.mockResolvedValue({ updates: { first_name: 'Wrong replay name' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect(h.state.outboxes).toEqual(accepted); expect(h.carrier).toHaveBeenCalledOnce(); expect(h.extract).toHaveBeenCalledOnce()
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.state.conversation.conversation_state).toMatchObject({ slots: { first_name: 'Alex' }, solar, quote_reference: reference })
  })
  it('reuses the first accepted photo message after loss before unlock despite a different random template', async () => {
    h.state.photo = true; h.state.failUnlock = true
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    await expect(attempt()).rejects.toThrow('Process lost before conversation unlock')
    const first = h.clone(h.state.outboxes)
    expect(first).toHaveLength(2)
    expect(h.carrier).toHaveBeenCalledTimes(2)
    const photo = first.find(row => String((row.payload as Record<string, unknown>).text).includes('/upload/'))!
    expect((photo.payload as Record<string, unknown>).text).toContain('/upload/saved-photo-token')
    h.state.failUnlock = false; random.mockReturnValue(0.99)
    await attempt()
    expect(h.state.outboxes.map(row => (row.payload as Record<string, unknown>).text)).toEqual(first.map(row => (row.payload as Record<string, unknown>).text))
    expect(h.state.outboxes).toEqual(first)
    expect(h.carrier).toHaveBeenCalledTimes(2)
    expect(h.state.messages.filter(row => row.direction === 'outbound' && String(row.body).includes('/upload/'))).toHaveLength(1)
  })
  it('retries a committed photo message checkpoint before sending or completing the turn', async () => {
    h.state.photo = true; h.state.loseCheckpointResponse = 'photo_request_message'
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    await expect(attempt()).rejects.toThrow('Checkpoint committed but response lost')
    expect(h.carrier).not.toHaveBeenCalled(); expect(h.state.outboxes).toEqual([])
    random.mockReturnValue(0.99)
    await attempt()
    expect(h.state.outboxes).toHaveLength(2); expect(h.carrier).toHaveBeenCalledTimes(2)
    const photo = h.state.outboxes.find(row => String((row.payload as Record<string, unknown>).text).includes('/upload/'))!
    expect(photo.delivery_key).toBe('inbound-work-1:photo-request')
    expect((photo.payload as Record<string, unknown>).text).toBe(h.state.checkpoints.photo_request_message)
    expect((photo.payload as Record<string, unknown>).text).toMatch(/^Hey Sam/)
  })
  it('retries a resolved photo enqueue failure without a durable intent', async () => {
    h.state.photo = true; h.state.failPhotoEnqueue = true
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    await expect(attempt()).rejects.toThrow('Photo request has no durable intent')
    expect(h.carrier).not.toHaveBeenCalled(); expect(h.state.outboxes).toEqual([])
    h.state.failPhotoEnqueue = false; random.mockReturnValue(0.99)
    await attempt()
    expect(h.state.outboxes).toHaveLength(2); expect(h.carrier).toHaveBeenCalledTimes(2)
    const photo = h.state.outboxes.find(row => row.delivery_key === 'inbound-work-1:photo-request')!
    expect((photo.payload as Record<string, unknown>).text).toBe(h.state.checkpoints.photo_request_message)
  })
  it('recovers a saved priced roofing draft status without entering the unmeasured fallback', async () => {
    h.state.trade = 'roofing'; h.state.llm = true
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.conversation.roofing_state = { last_step: 'pitch', slots: {} }
    const slots = { address: '12 Smith Street, Sydney NSW 2000', postcode: '2000', state: 'NSW',
      material: 'colorbond_corrugated', pitch: 'standard', intent: 'full_reroof', address_confirmed: true }
    h.specialist.mockResolvedValue({ source: 'llm', tool: 'measure_and_price_roof', carry: {}, decision: { action: 'measure', slots } })
    h.measure.mockImplementationOnce(async () => {
      h.state.roofMeasurements.push({ id: 'priced-roof-1', tenant_id: 'tenant-1', source_request_key: 'saved-priced-request',
        public_token: 'priced-roof-token', customer_phone: '+61411111111', quote: { structures: [] }, released_at: null })
      return { ok: false, savedToken: 'priced-roof-token', reason: 'roofing saved; customer status send failed' }
    }).mockImplementationOnce(async args => {
      await args.sendReply('Your roofing draft is saved and awaiting the roofer’s review.')
      return { ok: true, token: 'priced-roof-token', state: { slots, last_step: 'closed', workflow_stage: 'awaiting_review', pending_quote_token: 'priced-roof-token' } }
    })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await expect(attempt('It is a standard pitch.')).rejects.toThrow('Saved roofing draft status requires recovery')
    expect(h.carrier).not.toHaveBeenCalled()
    expect(h.state.roofMeasurements).toHaveLength(1)
    const saved = h.clone(h.state.roofMeasurements)
    await attempt('It is a standard pitch.')
    expect(h.state.roofMeasurements).toEqual(saved)
    expect(h.state.roofMeasurements.every(row => row.quote !== null)).toBe(true)
    expect(h.state.conversation.roofing_state).toMatchObject({ workflow_stage: 'awaiting_review', pending_quote_token: 'priced-roof-token' })
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['save', 'readback', 'lost-response', 'checkpoint', 'state'])('recovers an unmeasured roofing lead after %s failure without another saved lead', async failure => {
    h.state.trade = 'roofing'; h.state.llm = true
    h.state.failRoofLead = ['save', 'readback', 'lost-response'].includes(failure) ? failure : ''
    h.state.loseCheckpointResponse = failure === 'checkpoint' ? 'roofing_unmeasured_lead' : ''
    h.state.failStateTrade = failure === 'state' ? 'roofing' : ''; h.state.stateFailureMode = 'returned'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.conversation.roofing_state = { last_step: 'pitch', slots: {} }
    h.specialist.mockResolvedValue({ source: 'llm', tool: 'measure_and_price_roof', carry: {}, decision: { action: 'measure', slots: {
      address: '12 Smith Street, Sydney NSW 2000', postcode: '2000', state: 'NSW', material: 'metal_corrugated', pitch: 'standard', intent: 're_roof', address_confirmed: true,
    } } })
    h.measure.mockResolvedValue({ ok: false, reason: 'measurement provider unavailable' })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await expect(attempt('It is a standard pitch.')).rejects.toThrow(/lead|checkpoint|state/i)
    expect(h.measure).toHaveBeenCalledOnce()
    expect(h.state.roofMeasurements).toHaveLength(failure === 'save' ? 0 : 1)
    const savedBefore = h.clone(h.state.roofMeasurements)
    const acceptedBefore = h.clone(h.state.outboxes)
    expect(h.carrier).toHaveBeenCalledTimes(failure === 'state' ? 1 : 0)
    expect(h.state.conversation.roofing_state).not.toHaveProperty('pending_lead_measure_token')
    expect(h.dialog).not.toHaveBeenCalled()
    h.state.failRoofLead = ''; h.state.failStateTrade = ''
    await attempt('It is a standard pitch.')
    expect(h.measure).toHaveBeenCalledTimes(failure === 'save' ? 2 : 1)
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.state.roofMeasurements).toHaveLength(1)
    const saved = h.state.roofMeasurements[0]
    expect(saved).toMatchObject({ tenant_id: 'tenant-1', customer_phone: '+61411111111', source_request_key: 'roofing-unmeasured:inbound-work-1',
      routing: 'inspection_required', quote: null, released_at: null })
    if (failure !== 'save') expect(h.state.roofMeasurements).toEqual(savedBefore)
    expect(h.state.conversation.roofing_state).toMatchObject({ last_step: 'await_booking', pending_lead_measure_token: saved.measure_token, pending_quote_token: null })
    expect(h.state.outboxes).toHaveLength(1)
    if (failure === 'state') expect(h.state.outboxes).toEqual(acceptedBefore)
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['painting', 'roofing'])('recovers a committed %s decision checkpoint before any send or state projection', async trade => {
    h.state.trade = trade; h.state.llm = true; h.state.loseCheckpointResponse = `${trade}_turn`
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.conversation[`${trade}_state`] = { last_step: 'address', slots: {} }
    h.specialist.mockResolvedValueOnce({ source: 'llm', carry: {},
      decision: { action: 'ask', slots: { addr_confirm_misses: 2 }, step: 'address', reply: 'What is the street address?' } })
      .mockResolvedValue({ source: 'llm', carry: {}, decision: { action: 'ask', slots: {}, step: 'address', reply: 'Changed question.' } })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await expect(attempt('I cannot find the address.')).rejects.toThrow('Checkpoint committed but response lost')
    expect(h.carrier).not.toHaveBeenCalled()
    expect(h.state.conversation[`${trade}_state`]).toEqual({ last_step: 'address', slots: {} })
    await attempt('I cannot find the address.')
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: { text: 'What is the street address?' } })
    expect(h.state.conversation[`${trade}_state`]).toMatchObject({ slots: { addr_confirm_misses: 2 } })
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['painting', 'roofing'])('reuses the saved %s address screen and ask when its state write fails', async trade => {
    h.state.trade = trade; h.state.llm = true; h.state.failStateTrade = trade; h.state.stateFailureMode = 'returned'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.conversation[`${trade}_state`] = { last_step: 'address', slots: {} }
    h.specialist.mockResolvedValueOnce({ source: 'llm', tool: 'verify_address', carry: {},
      decision: { action: 'ask', slots: { address: '12 Smith Street, Sydney NSW 2000' }, step: 'confirm_address', reply: 'Is this the right address?' } })
      .mockResolvedValue({ source: 'llm', carry: {}, decision: { action: 'ask', slots: {}, step: 'address', reply: 'Changed model question.' } })
    h.screen.mockResolvedValueOnce({ slots: { address: '12 Smith Street, Sydney NSW 2000', addr_verify_misses: 2 }, step: 'address', reply: 'Could you check the street address?' })
      .mockResolvedValue({ slots: {}, step: 'address', reply: 'Changed provider question.' })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await expect(attempt('12 Smith Street, Sydney NSW 2000')).rejects.toThrow(/state/i)
    expect(h.carrier).not.toHaveBeenCalled()
    h.state.failStateTrade = ''
    await attempt('12 Smith Street, Sydney NSW 2000')
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.screen).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: { text: 'Could you check the street address?' } })
    expect(h.state.conversation[`${trade}_state`]).toMatchObject({ last_step: 'address', slots: { addr_verify_misses: 2 } })
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['painting', 'roofing'].flatMap(trade => ['returned', 'thrown', 'missing-row', 'lost-response'].map(mode => ({ trade, mode }))))(
    'recovers a $trade form state failure ($mode) with one saved token and one accepted outbox', async ({ trade, mode }) => {
      h.state.trade = trade; h.state.failStateTrade = trade; h.state.stateFailureMode = mode
      h.state.conversation.conversation_state = { slots: {}, sources: {} }
      h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
      const opener = trade === 'painting' ? 'Please quote repainting interior walls.' : 'Please quote a replacement roof.'
      await expect(attempt(opener)).rejects.toThrow(/state|connection/i)
      const rows = trade === 'painting' ? h.state.paintLeads : h.state.roofLeads
      expect(rows).toHaveLength(1)
      const token = rows[0].token
      // Painting sends before projecting state; roofing projects before sending.
      expect(h.carrier).toHaveBeenCalledTimes(trade === 'painting' ? 1 : 0)
      expect(h.dialog).not.toHaveBeenCalled()
      const acceptedBeforeRetry = h.clone(h.state.outboxes)
      h.state.failStateTrade = ''
      await attempt(opener)
      expect(rows).toHaveLength(1)
      expect(h.state.conversation[`${trade}_state`]).toMatchObject({ last_step: 'offer_form', pending_form_token: token })
      expect(h.state.outboxes).toHaveLength(1)
      expect(h.state.outboxes[0]).toMatchObject({ status: 'accepted', payload: { workId: 'inbound-work-1' } })
      if (trade === 'painting') expect(h.state.outboxes).toEqual(acceptedBeforeRetry)
      expect(h.carrier).toHaveBeenCalledOnce()
      expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
      expect(h.dialog).not.toHaveBeenCalled()
    },
  )
  it.each(['painting', 'roofing'])('replays a saved %s model decision after an accepted reply and failed state projection', async trade => {
    h.state.trade = trade; h.state.llm = true; h.state.failStateTrade = trade; h.state.stateFailureMode = 'returned'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.conversation[`${trade}_state`] = { last_step: 'address', slots: {} }
    h.specialist.mockResolvedValueOnce({ source: 'llm', tool: 'route_to_inspection', carry: { booking_reask: 1 },
      decision: { action: 'inspection', slots: { address: '12 Smith Street, Sydney NSW 2000', addr_confirm_rejects: 2 }, reason: 'The surface needs an on-site check.' } })
      .mockResolvedValue({ source: 'llm', carry: {}, decision: { action: 'ask', slots: {}, step: 'address', reply: 'A different reply must not be selected on retry.' } })
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    await expect(attempt('The condition looks poor.')).rejects.toThrow(/state/i)
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    const accepted = h.clone(h.state.outboxes)
    h.state.failStateTrade = ''
    await attempt('The condition looks poor.')
    expect(h.specialist).toHaveBeenCalledOnce()
    expect(h.carrier).toHaveBeenCalledOnce()
    expect(h.state.outboxes).toEqual(accepted)
    expect(h.state.conversation[`${trade}_state`]).toMatchObject({ last_step: 'await_booking', slots: { addr_confirm_rejects: 2 } })
    expect(h.state.messages.filter(row => row.direction === 'outbound')).toHaveLength(1)
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['painting', 'roofing'])('uses the saved %s form token on the website at the real specialist opener', async (trade) => {
    h.state.trade = trade
    h.state.conversation.conversation_state = { slots: { first_name: 'Sam' }, sources: {} }
    await attempt(trade === 'painting' ? 'Please quote repainting interior walls.' : 'Please quote a replacement roof.')
    const rows = trade === 'painting' ? h.state.paintLeads : h.state.roofLeads
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tenant_id: 'tenant-1', conversation_id: 'conversation-1', customer_phone: '+61411111111' })
    const path = trade === 'painting' ? 'paint-request' : 'quote-request'
    const texts = h.send.mock.calls.map(([input]) => input.text as string)
    expect(texts.filter(text => text.includes(`/${path}/`))).toEqual([expect.stringContaining(`https://quotemax.com.au/${path}/${rows[0].token}`)])
    expect(texts.join('\n')).not.toContain('offline-engine.invalid')
    expect(h.dialog).not.toHaveBeenCalled()
  })
  it.each(['save', 'readback'])('does not send a painting form or advance form state when its %s fails', async (stage) => {
    h.state.trade = 'painting'; h.state.failPaintSave = stage === 'save'; h.state.failPaintRead = stage === 'readback'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    await expect(attempt('Please quote repainting interior walls.')).rejects.toThrow(stage === 'save' ? 'Painting form could not be saved' : 'Saved painting form could not be confirmed')
    expect(h.state.paintLeads).toHaveLength(stage === 'save' ? 0 : 1)
    expect(h.state.conversation.painting_state).toBeUndefined()
    expect(h.send).not.toHaveBeenCalled()
    h.state.failPaintSave = false; h.state.failPaintRead = false
    await attempt('Please quote repainting interior walls.')
    expect(h.state.paintLeads).toHaveLength(1)
    expect(h.send).toHaveBeenCalledOnce()
  })
  it('reuses one owned painting form after its committed insert response was lost', async () => {
    h.state.trade = 'painting'; h.state.losePaintSaveResponse = true
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    await expect(attempt('Please quote repainting interior walls.')).rejects.toThrow('Painting form insert committed but response lost')
    const token = h.state.paintLeads[0].token
    expect(h.send).not.toHaveBeenCalled()
    await attempt('Please quote repainting interior walls.')
    expect(h.state.paintLeads).toHaveLength(1)
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.send.mock.calls[0][0].text).toContain(`https://quotemax.com.au/paint-request/${token}`)
    expect(h.state.conversation.painting_state).toMatchObject({ pending_form_token: token })
  })
  it('dispatches the saved photo token on the website while intake stays on the engine', async () => {
    h.state.photo = true
    await attempt()
    const texts = h.send.mock.calls.map(([input]) => input.text as string)
    expect(texts.filter(text => text.includes('/upload/'))).toEqual([expect.stringContaining('https://quotemax.com.au/upload/saved-photo-token')])
    expect(texts.join('\n')).not.toContain('offline-engine.invalid')
    expect(h.state.conversation.photo_request_sent_at).toEqual(expect.any(String))
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ url: 'https://offline-engine.invalid/api/intake/structure' }) }))
  })
  it('dispatches the persisted product-choice token on the website and holds estimation', async () => {
    h.state.materials = [{ id: 'catalogue-1', tenant_id: 'tenant-1', category: 'gpo', name: 'Clipsal Iconic double GPO', unit_price_ex_gst: 25, active: true, trade: 'electrical' }]
    await attempt()
    const choice = h.state.conversation.product_choice as { token: string, status: string }
    expect(choice.status).toBe('pending')
    const texts = h.send.mock.calls.map(([input]) => input.text as string)
    expect(texts.filter(text => text.includes('/q/choose/'))).toEqual([expect.stringContaining(`https://quotemax.com.au/q/choose/${choice.token}`)])
    expect(texts.join('\n')).not.toContain('offline-engine.invalid')
    expect(h.enqueue).not.toHaveBeenCalled()
  })
  it.each([false, true])('dispatches the saved signup token on the website (reused=%s)', async (reused) => {
    h.state.registration = true; h.state.reused = reused
    h.state.conversation.conversation_type = 'tradie_registration'
    await attempt('JOIN TEST-CODE')
    expect(h.signupSend).toHaveBeenCalledOnce()
    const text = h.signupSend.mock.calls[0][0].text as string
    expect(text).toContain('https://quotemax.com.au/signup?intent=saved-signup-token&code=TEST-CODE')
    expect(text).not.toContain('offline-engine.invalid')
    expect(h.state.messages.find(row => row.direction === 'outbound')?.body).toBe(text)
    expect(h.dialog).not.toHaveBeenCalled()
  })
})
