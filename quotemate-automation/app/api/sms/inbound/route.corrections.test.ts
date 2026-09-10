import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Actual POST, correction helper, human-task persistence and durable outbox.
// The database/query surface and model/carrier are offline fixtures, not SQL proof.
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
    solarReferences: [] as Row[], failSolarProfile: '', tasks: [] as Row[], work: [] as Row[],
    taskFailure: '', extraTrades: [] as string[], workId: 'inbound-work-1', receiptId: 'SM-customer-links', sequence: 1,
    failCorrectionContext: false }
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
      if (table === 'sms_human_tasks') {
        let task = state.tasks.find(row => Object.entries(filters).every(([key, value]) => row[key] === value))
        if (action === 'upsert') {
          if (state.taskFailure === 'save') return { data: null, error: { message: 'task save unavailable' } }
          task = state.tasks.find(row => row.request_key === payload.request_key && row.tenant_id === payload.tenant_id)
          if (!task) { task = { ...clone(payload), id: `task-${state.tasks.length + 1}`, status: 'open' }; state.tasks.push(task) }
          if (state.taskFailure === 'lost-response') { state.taskFailure = ''; throw new Error('Task committed but response lost') }
        }
        if (action === 'update' && task) {
          if (payload.resource_id && state.taskFailure === 'association') return { data: null, error: { message: 'association unavailable' } }
          Object.assign(task, clone(payload))
          if (payload.resource_id && state.taskFailure === 'association-lost') { state.taskFailure = ''; throw new Error('Association committed but response lost') }
        }
        return { data: clone(single ? task ?? null : state.tasks), error: null }
      }
      if (table === 'sms_work_jobs') return { data: clone(state.work), error: null }
      if (table === 'tenants') return { data: { id: 'tenant-1', owner_mobile: '+61422222222', twilio_sms_number: '+61488888888' }, error: null }
      if (action !== 'read') {
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
          if (state.failCorrectionContext && Object.hasOwn((payload.conversation_state as Row | undefined) ?? {}, 'pending_job_correction')) return { data: null, error: { message: 'correction context unavailable' } }
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
  currentSmsWork: () => ({ jobId: h.state.workId, ownerToken: 'owner-1', turnId: 'turn-1', sequence: h.state.sequence, job: { checkpoint: h.state.checkpoints } }),
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
  tenantByDestinationSms: async () => h.state.registration ? null : ({ id: 'tenant-1', business_name: 'Test tradie', status: 'active', trade: h.state.trade, trades: [h.state.trade, ...h.state.extraTrades] }),
  isTransactableTenantStatus: () => true,
}))
vi.mock('@/lib/customers/lookup', () => ({ findOrCreateCustomer: async () => null, formatCustomerContext: () => '', writeCustomerCorrections: async () => {} }))
vi.mock('@/lib/sms/quote-actions', async original => {
  const actual = await original<typeof import('@/lib/sms/quote-actions')>()
  return { ...actual, guardGeneratedQuoteLinks: (text: string) => text }
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
vi.mock('@/lib/sms/photo-request-trigger', async (original) => ({ ...await original<object>(), shouldSendPhotoRequest: () => ({ fire: h.state.photo }) }))
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
  await withSmsDeliveryContext({ workId: h.state.workId, workOwner: 'owner-1', turnId: 'turn-1', tenantId: 'tenant-1', conversationId: 'conversation-1' }, async () => {
  const response = await POST(new Request('https://offline-engine.invalid/api/sms/inbound', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+61411111111', To: '+61488888888', MessageSid: h.state.receiptId, Body: body }),
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
  h.state.tasks = []; h.state.work = []; h.state.taskFailure = ''; h.state.extraTrades = []
  h.state.workId = 'inbound-work-1'; h.state.receiptId = 'SM-customer-links'; h.state.sequence = 1; h.state.failCorrectionContext = false
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

function heldFixture(trade: string, family = 'generic', stage = 'awaiting_review') {
  h.state.trade = trade
  const reference = { family, resource_id: `${family}-saved-id`, token: `${family}_saved_token_1234`, label: '12 Smith Street, Sydney NSW 2000', stage }
  h.state.solarReferences = [reference]
  h.state.conversation.status = 'done'
  h.state.conversation.quote_stage = stage
  h.state.conversation.conversation_state = { slots: { first_name: 'Sam' }, sources: {},
    quote_reference: { family, id: reference.resource_id }, quote_candidates: null }
  if (family === 'generic') h.state.conversation.quote_id = reference.resource_id
  if (family === 'roof' || family === 'paint') h.state.conversation[`${trade}_state`] = {
    last_step: 'closed', workflow_stage: 'awaiting_review', pending_quote_token: reference.token,
    slots: { address: reference.label, address_confirmed: true, scopes: ['walls'], material: 'colorbond_corrugated' } }
  h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
  return h.clone(h.state.conversation)
}
function assertCorrection(text: string, resource?: string) {
  expect(h.state.tasks).toHaveLength(1)
  expect(h.state.tasks[0]).toMatchObject({ tenant_id: 'tenant-1', customer_phone: '+61411111111', conversation_id: 'conversation-1', status: 'notified' })
  expect(h.state.tasks[0].reason).toContain(text)
  if (resource) expect(h.state.tasks[0].resource_id).toBe(resource)
  const customer = h.state.outboxes.filter(item => (item.payload as Record<string, unknown>).to === '+61411111111')
  expect(customer).toHaveLength(1)
  expect(customer[0]).toMatchObject({ status: 'accepted' })
  expect((customer[0].payload as Record<string, unknown>).text).toMatch(/change.*saved.*review/i)
  expect((customer[0].payload as Record<string, unknown>).text).not.toMatch(/on (?:its|the) way|shortly|updated your quote/i)
  expect(h.enqueue).not.toHaveBeenCalled()
  expect(h.dialog).not.toHaveBeenCalled()
  expect(h.measure).not.toHaveBeenCalled()
  expect(h.specialist).not.toHaveBeenCalled()
}
function nextReceipt() {
  h.state.sequence += 1
  h.state.workId = `inbound-work-${h.state.sequence}`
  h.state.receiptId = `SM-correction-${h.state.sequence}`
  h.state.checkpoints = {}
}
async function ambiguousCorrection() {
  heldFixture('electrical')
  h.state.conversation.quote_id = null
  h.state.conversation.intake_id = 'pending-intake'
  h.state.conversation.conversation_state = { slots: {}, sources: {} }
  h.state.solarReferences.push({ family: 'generic', resource_id: 'other-saved-id', token: 'other_saved_token_1234', label: '90 Old Road', stage: 'ready' })
  const text = 'Actually change the scope to include more power points.'
  await attempt(text)
  return text
}
describe('actual inbound saved-job corrections', () => {
  it.each(['intake-linked', 'checkpoint-before-linkback'])('tracks a generic correction after %s without replacing consumed inputs', async phase => {
    h.state.conversation.status = 'structuring'
    if (phase === 'intake-linked') h.state.conversation.intake_id = 'intake-1'
    else { h.state.conversation.status = 'open'; h.state.work = [{ id: 'intake-work-1', checkpoint: { structured_intake: { scope: { count: 2 } } } }] }
    h.send.mockImplementation(input => dispatchDurably(input, h.carrier))
    const work = h.clone(h.state.work)
    const text = 'Actually make it 4 power points and change the address to 22 New Road, Sydney NSW 2000.'
    await attempt(text)
    assertCorrection(text)
    expect(h.state.work).toEqual(work)
    expect(h.state.conversation.quote_id).toBeNull()
    expect(h.state.tasks[0].resource_id).toBeNull()
  })
  it.each([
    ['electrical', 'generic', 'Actually make it 4 power points instead of 2.'],
    ['plumbing', 'generic', 'Please change the scope to include two taps instead of one.'],
    ['painting', 'paint', 'Actually include ceilings too.'],
    ['painting', 'paint', 'Please change the painting scope to walls and ceilings.'],
    ['roofing', 'roof', 'Actually change the address to 22 New Road, Sydney NSW 2000.'],
  ])('records the %s held correction %s: %s', async (trade, family, text) => {
    const before = heldFixture(trade, family)
    await attempt(text)
    assertCorrection(text, `${family}-saved-id`)
    if (family === 'generic') expect(h.state.conversation.quote_id).toBe(before.quote_id)
    else expect(h.state.conversation[`${trade}_state`]).toEqual(before[`${trade}_state`])
  })
  it('retains a cross-trade roof correction on its owned saved roof', async () => {
    const before = heldFixture('roofing', 'roof'); h.state.extraTrades = ['electrical']
    const text = 'Actually change the address to 22 New Road, Sydney NSW 2000.'
    await attempt(text); assertCorrection(text, 'roof-saved-id')
    expect(h.state.conversation.roofing_state).toEqual(before.roofing_state)
  })
  it.each(['Actually change the installation address to 22 New Road, Sydney NSW 2000.', 'Please change to premium panels instead.'])('records a held solar job change: %s', async text => {
    const { solar } = await savedSolarFixture()
    await attempt(text); assertCorrection(text, 'saved-solar-id')
    expect((h.state.conversation.conversation_state as Record<string, unknown>).solar).toEqual(solar)
    expect(h.solarTurn).not.toHaveBeenCalled()
  })
  it.each(['awaiting_review', 'ready'])('handles both resend and correction for a %s quote with the original release status', async stage => {
    const before = heldFixture('electrical', 'generic', stage)
    const text = 'Send the quote link again, and actually make it 4 power points instead of 2.'
    await attempt(text); assertCorrection(text, 'generic-saved-id')
    const body = String((h.state.outboxes.at(-1)!.payload as Record<string, unknown>).text)
    expect(h.state.conversation.quote_id).toBe(before.quote_id)
    if (stage === 'ready') expect(body).toContain('https://quotemax.com.au/q/generic_saved_token_1234')
    else { expect(body).toMatch(/not been released/i); expect(body).not.toContain('/q/') }
  })
  it.each(['save', 'lost-response', 'unlock'])('recovers a correction after %s with one task and one accepted customer intent', async failure => {
    heldFixture('painting', 'paint')
    h.state.taskFailure = failure === 'unlock' ? '' : failure
    h.state.failUnlock = failure === 'unlock'
    const text = 'Actually include ceilings too.'
    await expect(attempt(text)).rejects.toThrow(/task|unlock/i)
    expect(h.state.outboxes).toHaveLength(failure === 'unlock' ? 2 : 0)
    h.state.taskFailure = ''; h.state.failUnlock = false
    await attempt(text); await attempt(text)
    assertCorrection(text, 'paint-saved-id')
    expect(h.state.outboxes).toHaveLength(2)
    expect(h.carrier).toHaveBeenCalledTimes(2)
  })
  it('records ambiguous context without choosing a latest quote by phone', async () => {
    heldFixture('electrical')
    h.state.conversation.quote_id = null
    h.state.conversation.intake_id = 'pending-intake'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    h.state.solarReferences.push({ family: 'generic', resource_id: 'other-saved-id', token: 'other_saved_token_1234', label: '90 Old Road', stage: 'ready' })
    const text = 'Actually change the scope to include more power points.'
    await attempt(text); assertCorrection(text)
    expect(h.state.tasks[0].resource_id).toBeNull()
    expect(String((h.state.outboxes.at(-1)!.payload as Record<string, unknown>).text)).toMatch(/which job/i)
  })
  it('does not associate a new consumed intake with the only historical quote', async () => {
    heldFixture('electrical')
    h.state.conversation.quote_id = null; h.state.conversation.intake_id = 'new-intake'
    h.state.conversation.conversation_state = { slots: {}, sources: {} }
    await attempt('Actually make it 4 power points.')
    expect(h.state.tasks[0].resource_id).toBeNull()
    expect(h.state.tasks[0].conversation_id).toBe('conversation-1')
  })
  it('keeps the current job when its requested replacement address matches another saved job', async () => {
    heldFixture('electrical')
    h.state.solarReferences.push({ family: 'generic', resource_id: 'other-saved-id', token: 'other_saved_token_1234', label: '90 Old Road', stage: 'ready' })
    await attempt('Please change the address to 90 Old Road.')
    expect(h.state.tasks[0].resource_id).toBe('generic-saved-id')
  })
  it('records a correction on a fresh idle conversation against its only owned saved quote', async () => {
    heldFixture('electrical')
    h.state.conversation = { ...h.state.conversation, status: 'open', turn_count: 0, quote_id: null, quote_stage: null,
      conversation_state: { slots: {}, sources: {} } }
    await attempt('The address is 12 Jones Street NSW2000')
    expect(h.state.tasks[0].resource_id).toBe('generic-saved-id')
  })
  it('keeps a current gather independent of a historical saved quote', async () => {
    heldFixture('electrical')
    h.state.conversation = { ...h.state.conversation, status: 'open', quote_id: null, quote_stage: null,
      conversation_state: { slots: { job_type: 'power_points', count: 2 }, sources: {} } }
    h.extract.mockResolvedValue({ updates: { count: 4 } })
    await attempt('Actually make it 4 power points.')
    expect(h.state.tasks).toHaveLength(0)
    expect((h.state.conversation.conversation_state as Record<string, unknown>).slots).toMatchObject({ count: 4 })
    expect(h.dialog).toHaveBeenCalled()
  })
  it.each([['solar', 'solar'], ['aircon', 'air conditioning'], ['commercial-paint', 'commercial painting'], ['plan', 'plan estimation']])('labels a multi-trade %s correction with its actual tool', async (family, trade) => {
    heldFixture('electrical', family); h.state.extraTrades = ['solar', 'painting']
    await attempt('Please change the address to 22 New Road, Sydney NSW 2000.')
    expect(h.state.tasks[0].trade).toBe(trade)
    expect(String((h.state.outboxes[0].payload as Record<string, unknown>).text).startsWith(`${trade} customer request`)).toBe(true)
  })
  it('uses the active plumbing worker for a generic draft owned by a multi-trade tenant', async () => {
    heldFixture('electrical'); h.state.extraTrades = ['plumbing']; vi.stubEnv('SMS_WORKER_SERVICE', 'plumbing')
    await attempt('Please add two taps to the scope.')
    expect(h.state.tasks[0].trade).toBe('plumbing')
  })
  it.each(['tenant_id', 'from_number', 'to_number'])('refuses a correction when conversation %s ownership is inconsistent', async field => {
    heldFixture('electrical'); h.state.conversation[field] = 'different-owner'
    await expect(attempt('Actually make it 4 power points.')).rejects.toThrow(/ownership/i)
    expect(h.state.tasks).toHaveLength(0); expect(h.state.outboxes).toHaveLength(0)
  })
  it.each(['The address is 12 Jones Street NSW2000', 'The postcode is3000', 'It is three phase'])('tracks a direct saved-job field replacement: %s', async text => {
    heldFixture('electrical'); await attempt(text); assertCorrection(text, 'generic-saved-id')
  })
  it('attaches a later numbered selection to the same task and preserves context through a status request', async () => {
    const text = await ambiguousCorrection()
    const pending = h.clone((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction)
    nextReceipt(); await attempt('Where is my quote?')
    expect((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction).toEqual(pending)
    nextReceipt(); await attempt('2'); await attempt('2')
    expect(h.state.tasks).toHaveLength(1)
    expect(h.state.tasks[0]).toMatchObject({ resource_id: 'other-saved-id', status: 'notified' })
    expect(h.state.tasks[0].reason).toContain(text)
    expect(h.state.tasks[0].reason).toContain('Customer job clarification (verbatim):\n2')
    expect((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction).toBeNull()
    const association = h.state.outboxes.filter(item => String(item.delivery_key).includes(':job-selection:'))
    expect(association).toHaveLength(1)
    expect(String((association[0].payload as Record<string, unknown>).text)).toContain(text)
    expect(String((association[0].payload as Record<string, unknown>).text)).toContain('90 Old Road')
  })
  it.each(['association', 'association-lost', 'context', 'customer-outbox', 'unlock'])('recovers job selection after %s without a second task or notification', async failure => {
    const text = await ambiguousCorrection(); nextReceipt()
    h.state.taskFailure = failure.startsWith('association') ? failure : ''
    h.state.failCorrectionContext = failure === 'context'; h.state.failUnlock = failure === 'unlock'
    let failCustomer = failure === 'customer-outbox'
    h.send.mockImplementation(input => failCustomer && input.to === '+61411111111'
      ? Promise.resolve({ ok: false, smsAttempt: { reason: 'Outbox unavailable' } }) : dispatchDurably(input, h.carrier))
    await expect(attempt('2')).rejects.toThrow(/selection|association|context|queued|unlock/i)
    if (failure === 'customer-outbox') {
      expect((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction).toBeNull()
      // Also exercise a replay without the older conversation snapshot: the
      // saved correction checkpoint alone must recover the bare numeric reply.
      delete h.state.checkpoints.conversation_snapshot
    }
    h.state.taskFailure = ''; h.state.failCorrectionContext = false; h.state.failUnlock = false; failCustomer = false
    await attempt('2'); await attempt('2')
    expect(h.state.tasks).toHaveLength(1)
    expect(h.state.tasks[0]).toMatchObject({ resource_id: 'other-saved-id', status: 'notified' })
    expect(h.state.tasks[0].reason).toContain(text)
    expect(h.state.outboxes.filter(item => String(item.delivery_key).includes(':job-selection:'))).toHaveLength(1)
    expect(h.state.outboxes.filter(item => (item.payload as Record<string, unknown>).to === '+61411111111')).toHaveLength(2)
    expect(h.carrier).toHaveBeenCalledTimes(4)
  })
  it('does not reopen a task the owner resolves during selection notification', async () => {
    await ambiguousCorrection(); nextReceipt()
    h.carrier.mockImplementation(async input => {
      if (String(input.deliveryKey).includes(':job-selection:')) h.state.tasks[0].status = 'resolved'
      return { ok: true, channel: 'sms', sid: 'SM-selected', status: 'queued' }
    })
    await attempt('2')
    expect(h.state.tasks[0]).toMatchObject({ status: 'resolved', resource_id: 'other-saved-id' })
  })
  it('preserves pending job clarification through a name-only profile update', async () => {
    await ambiguousCorrection()
    const pending = h.clone((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction)
    h.state.conversation.quote_id = 'generic-saved-id'
    nextReceipt(); h.extract.mockResolvedValue({ updates: { first_name: 'Alex' } })
    await attempt('Correction: my first name is Alex, not Sam.')
    expect((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction).toEqual(pending)
    expect(h.state.tasks).toHaveLength(1)
  })
  it.each(['9', 'removed'])('retains the original task/context for an invalid or no-longer-owned selection: %s', async selection => {
    await ambiguousCorrection(); nextReceipt()
    if (selection === 'removed') h.state.solarReferences.pop()
    await attempt(selection === 'removed' ? '2' : selection)
    expect(h.state.tasks).toHaveLength(1)
    expect(h.state.tasks[0].resource_id).toBeNull()
    expect((h.state.conversation.conversation_state as Record<string, unknown>).pending_job_correction).toBeTruthy()
    expect(h.state.outboxes.filter(item => String(item.delivery_key).includes(':job-selection:'))).toHaveLength(0)
  })
  it('replays an accepted mixed held reply unchanged when the owner releases between attempts', async () => {
    heldFixture('electrical'); h.state.failUnlock = true
    const text = 'Send the quote link again, and actually make it 4 power points.'
    await expect(attempt(text)).rejects.toThrow(/unlock/i)
    const original = h.clone(h.state.outboxes)
    h.state.solarReferences[0].stage = 'ready'; h.state.failUnlock = false
    await attempt(text)
    expect(h.state.outboxes).toEqual(original)
    expect(h.carrier).toHaveBeenCalledTimes(2)
    nextReceipt(); await attempt('Send the quote link again.')
    expect(String((h.state.outboxes.at(-1)!.payload as Record<string, unknown>).text)).toContain('https://quotemax.com.au/q/generic_saved_token_1234')
  })
  it.each(['Correction: my first name is Alex, not Sam.', 'How much would it cost to add ceilings?', 'Please start a new quote for four downlights.'])('does not turn profile/question/new-job control text into a correction task: %s', async text => {
    heldFixture('electrical'); await attempt(text)
    expect(h.state.tasks).toHaveLength(0)
    expect(h.dialog).toHaveBeenCalled()
  })
})


